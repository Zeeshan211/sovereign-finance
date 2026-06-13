/*
 * GET /api/credit-cards/insights
 * Returns active CC-specific insights for the authenticated user.
 *
 * Rule IDs follow contract A23 naming: cc.<rule>
 * Fields match A23 insights table schema:
 *   rule_id, rule_category, priority, card_id, title, message,
 *   action_label, action_url, related_entity_type, related_entity_id
 *
 * Priority values: low | medium | high | critical
 * All rules are computed on-the-fly (no persistent storage required).
 */

import { json } from '../_lib.js';

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
  }

  try {
    const db   = requireDb(env);
    const userId = requireUserId(context);

    const now      = new Date();
    const today    = now.toISOString().slice(0, 10);
    const ago30    = new Date(now - 30  * 86400000).toISOString().slice(0, 10);
    const ago45    = new Date(now - 45  * 86400000).toISOString().slice(0, 10);
    const ago90    = new Date(now - 90  * 86400000).toISOString().slice(0, 10);
    const in60     = new Date(+now + 60 * 86400000).toISOString().slice(0, 10);

    // ── Fetch all active cards ──────────────────────────────────────────────
    const cardsRes = await db.prepare(`
      SELECT cc.*,
             a.balance AS account_balance,
             a.name    AS account_name
      FROM   credit_cards cc
      JOIN   accounts     a  ON a.id = cc.account_id
      WHERE  cc.user_id = ?
        AND  (cc.status IS NULL OR cc.status NOT IN ('closed','deleted'))
    `).bind(userId).all();

    const cards = cardsRes.results || [];
    if (cards.length === 0) return json({ ok: true, insights: [] });

    const accountIds = cards.map(c => c.account_id).filter(Boolean);
    const ph = accountIds.map(() => '?').join(',');

    // ── Fetch recent transactions (90 days) ─────────────────────────────────
    const txRes = await db.prepare(`
      SELECT t.account_id, t.type, t.cc_subtype, t.amount_paisa, t.amount,
             t.date, t.notes, t.category_id
      FROM   transactions t
      WHERE  t.account_id IN (${ph})
        AND  t.user_id = ?
        AND  t.date >= ?
        AND  (t.reversed_by IS NULL OR t.reversed_by = '')
        AND  (t.reversed_at IS NULL OR t.reversed_at = '')
      ORDER  BY t.date DESC
    `).bind(...accountIds, userId, ago90).all();

    const txns = txRes.results || [];

    // ── Helper maps ─────────────────────────────────────────────────────────
    const cardByAccountId = {};
    const cardById        = {};
    for (const c of cards) {
      cardByAccountId[c.account_id] = c;
      cardById[c.id]                = c;
    }

    const txnsByAccount = {};
    for (const t of txns) {
      if (!txnsByAccount[t.account_id]) txnsByAccount[t.account_id] = [];
      txnsByAccount[t.account_id].push(t);
    }

    // For each card, compute outstanding_paisa from account.balance
    // CC accounts are liabilities: balance stored as negative (debt owed)
    function outstandingPaisa(card) {
      const bal = Number(card.account_balance || 0);
      return Math.max(0, Math.round(-bal * 100));
    }

    // Days until due date from today
    function dueDays(card) {
      const offset  = card.payment_due_offset_days || 21;
      const day     = card.statement_cycle_day || 12;
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), day);
      const stmtDate  = thisMonth <= now
        ? thisMonth
        : new Date(now.getFullYear(), now.getMonth() - 1, day);
      const dueDate = new Date(stmtDate);
      dueDate.setDate(dueDate.getDate() + offset);
      return Math.round((dueDate - now) / 86400000);
    }

    // Days until statement cycle closes
    function daysToClose(card) {
      const day = card.statement_cycle_day || 12;
      const d   = now.getDate();
      let diff  = day - d;
      if (diff < 0) diff += 31;
      return diff;
    }

    const insights = [];

    // ── Rule 1: cc.high_utilization ─────────────────────────────────────────
    for (const card of cards) {
      const limitPaisa = card.credit_limit_paisa;
      if (!limitPaisa || limitPaisa <= 0) continue;
      const outstanding = outstandingPaisa(card);
      const utilPct     = (outstanding / limitPaisa) * 100;
      if (utilPct >= 70) {
        insights.push({
          rule_id:              'cc.high_utilization',
          rule_category:        'cc',
          priority:             utilPct >= 90 ? 'critical' : 'high',
          card_id:              card.id,
          title:                `High utilization on ${card.card_name || card.id}`,
          message:              `Card is at ${utilPct.toFixed(0)}% utilization (${(outstanding / 100).toFixed(0)} PKR of ${(limitPaisa / 100).toFixed(0)} PKR limit). Consider paying down balance.`,
          action_label:         'Pay Now',
          action_url:           `/credit-card`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 2: cc.cash_advance_taken ───────────────────────────────────────
    for (const card of cards) {
      const cardTxns = txnsByAccount[card.account_id] || [];
      const cashAdv  = cardTxns.find(t =>
        t.date >= ago30 &&
        (t.cc_subtype === 'cash_advance' ||
         String(t.notes || '').toUpperCase().includes('CC_CASH_ADV'))
      );
      if (cashAdv) {
        insights.push({
          rule_id:              'cc.cash_advance_taken',
          rule_category:        'cc',
          priority:             'high',
          card_id:              card.id,
          title:                `Cash advance on ${card.card_name || card.id}`,
          message:              `A cash advance was taken in the last 30 days. Cash advances accrue interest immediately at ${card.cash_advance_apr || 42}% APR. Pay this off first.`,
          action_label:         'View Card',
          action_url:           `/credit-card/${card.id}`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 3: cc.late_payment_pattern ─────────────────────────────────────
    for (const card of cards) {
      const cardTxns = txnsByAccount[card.account_id] || [];
      const lateFees = cardTxns.filter(t =>
        t.type === 'cc_fee' &&
        String(t.notes || '').toLowerCase().includes('late')
      );
      if (lateFees.length >= 2) {
        insights.push({
          rule_id:              'cc.late_payment_pattern',
          rule_category:        'cc',
          priority:             'critical',
          card_id:              card.id,
          title:                `Repeated late fees on ${card.card_name || card.id}`,
          message:              `${lateFees.length} late payment fees in the last 90 days. Set up auto-pay to avoid further fees.`,
          action_label:         'Configure Auto-Pay',
          action_url:           `/credit-card/${card.id}`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 4: cc.annual_fee_at_risk ───────────────────────────────────────
    for (const card of cards) {
      if (!card.annual_fee_paisa || card.annual_fee_paisa <= 0) continue;
      if (!card.issued_date) continue;
      const issued      = new Date(card.issued_date);
      const thisYear    = now.getFullYear();
      const anniversary = new Date(thisYear, issued.getMonth(), issued.getDate());
      if (anniversary < now) anniversary.setFullYear(thisYear + 1);
      const daysToAnniv = Math.round((anniversary - now) / 86400000);
      if (daysToAnniv <= 30) {
        insights.push({
          rule_id:              'cc.annual_fee_at_risk',
          rule_category:        'cc',
          priority:             'medium',
          card_id:              card.id,
          title:                `Annual fee due on ${card.card_name || card.id}`,
          message:              `Annual fee of PKR ${(card.annual_fee_paisa / 100).toFixed(0)} is due in ${daysToAnniv} days. Check if you've met the waiver threshold.`,
          action_label:         'View Card',
          action_url:           `/credit-card/${card.id}`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 5: cc.rewards_expiring ─────────────────────────────────────────
    for (const card of cards) {
      if (!card.rewards_program) continue;
      const cardTxns   = txnsByAccount[card.account_id] || [];
      const lastTxn    = cardTxns.find(t => t.type === 'cc_spend');
      if (!lastTxn || lastTxn.date < ago45) {
        insights.push({
          rule_id:              'cc.rewards_expiring',
          rule_category:        'cc',
          priority:             'medium',
          card_id:              card.id,
          title:                `Inactive rewards card — ${card.card_name || card.id}`,
          message:              `No purchases in the last 45 days on ${card.rewards_program}. Check if your rewards points are expiring.`,
          action_label:         'View Card',
          action_url:           `/credit-card/${card.id}`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 6: cc.wrong_card_for_category ──────────────────────────────────
    if (cards.length >= 2) {
      const rewardCards = cards
        .filter(c => c.rewards_base_rate_pct > 0 || c.rewards_points_per_pkr > 0)
        .sort((a, b) => (b.rewards_base_rate_pct || 0) - (a.rewards_base_rate_pct || 0));

      if (rewardCards.length >= 2) {
        const bestCard  = rewardCards[0];
        const bestRate  = bestCard.rewards_base_rate_pct || 0;
        const bestAcct  = bestCard.account_id;
        const bestTxns  = (txnsByAccount[bestAcct] || []).filter(t => t.type === 'cc_spend').length;

        let heaviestSpend = null;
        let heaviestCount = 0;
        for (const card of cards) {
          if (card.id === bestCard.id) continue;
          const n = (txnsByAccount[card.account_id] || []).filter(t => t.type === 'cc_spend').length;
          if (n > heaviestCount) { heaviestCount = n; heaviestSpend = card; }
        }

        if (heaviestSpend && heaviestCount > bestTxns + 3) {
          insights.push({
            rule_id:              'cc.wrong_card_for_category',
            rule_category:        'cc',
            priority:             'low',
            card_id:              bestCard.id,
            title:                `More spending on lower-reward card`,
            message:              `Most of your recent purchases (${heaviestCount}) are on ${heaviestSpend.card_name || heaviestSpend.id}, but ${bestCard.card_name || bestCard.id} offers ${bestRate}% rewards. Consider shifting daily spend.`,
            action_label:         'View Best Card',
            action_url:           `/credit-card/${bestCard.id}`,
            related_entity_type:  'credit_card',
            related_entity_id:    bestCard.id,
          });
        }
      }
    }

    // ── Rule 7: cc.statement_close_warning ──────────────────────────────────
    for (const card of cards) {
      const dtc         = daysToClose(card);
      const outstanding = outstandingPaisa(card);
      if (dtc <= 2 && dtc >= 0 && outstanding > 10000) {
        insights.push({
          rule_id:              'cc.statement_close_warning',
          rule_category:        'cc',
          priority:             'high',
          card_id:              card.id,
          title:                `Statement closes in ${dtc === 0 ? 'today' : `${dtc} day${dtc > 1 ? 's' : ''}`} — ${card.card_name || card.id}`,
          message:              `Current balance is PKR ${(outstanding / 100).toFixed(0)}. Avoid large purchases before the statement closes to reduce minimum due.`,
          action_label:         'View Card',
          action_url:           `/credit-card/${card.id}`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 8: cc.foreign_txn_better_card ──────────────────────────────────
    for (const card of cards) {
      const cardTxns = txnsByAccount[card.account_id] || [];
      const hasIntl  = cardTxns.some(t =>
        t.date >= ago30 && (t.cc_subtype === 'intl' || t.type === 'cc_intl_spend')
      );
      if (!hasIntl) continue;
      const myMarkup = card.forex_markup_pct || 3.5;
      if (myMarkup <= 2.0) continue;
      const betterCard = cards.find(c =>
        c.id !== card.id && (c.forex_markup_pct || 3.5) < myMarkup
      );
      if (betterCard) {
        insights.push({
          rule_id:              'cc.foreign_txn_better_card',
          rule_category:        'cc',
          priority:             'medium',
          card_id:              card.id,
          title:                `Foreign transactions on high-markup card`,
          message:              `${card.card_name || card.id} charges ${myMarkup}% forex markup. ${betterCard.card_name || betterCard.id} charges only ${betterCard.forex_markup_pct || 3.5}%. Use that for international purchases.`,
          action_label:         'View Better Card',
          action_url:           `/credit-card/${betterCard.id}`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 9: cc.interest_vs_rewards ──────────────────────────────────────
    for (const card of cards) {
      const cardTxns      = txnsByAccount[card.account_id] || [];
      const interestTxns  = cardTxns.filter(t => t.type === 'cc_interest');
      if (interestTxns.length === 0) continue;
      const totalInterest = interestTxns.reduce((s, t) =>
        s + (t.amount_paisa || Math.round((t.amount || 0) * 100)), 0);
      const spendTxns     = cardTxns.filter(t => t.type === 'cc_spend');
      const totalSpend    = spendTxns.reduce((s, t) =>
        s + (t.amount_paisa || Math.round((t.amount || 0) * 100)), 0);
      const rewardsRate   = (card.rewards_base_rate_pct || 0) / 100;
      const estimatedRewards = Math.round(totalSpend * rewardsRate);
      if (totalInterest > estimatedRewards + 100) {
        insights.push({
          rule_id:              'cc.interest_vs_rewards',
          rule_category:        'cc',
          priority:             'high',
          card_id:              card.id,
          title:                `Interest charges exceed rewards — ${card.card_name || card.id}`,
          message:              `You paid PKR ${(totalInterest / 100).toFixed(0)} in interest vs. ~PKR ${(estimatedRewards / 100).toFixed(0)} in rewards over 90 days. Paying in full each month would save you money.`,
          action_label:         'Pay Balance',
          action_url:           `/credit-card`,
          related_entity_type:  'credit_card',
          related_entity_id:    card.id,
        });
      }
    }

    // ── Rule 10: cc.statement_balance_unpaid ────────────────────────────────
    for (const card of cards) {
      const outstanding = outstandingPaisa(card);
      if (outstanding <= 0) continue;
      const days = dueDays(card);
      if (days === null || days > 7) continue;
      insights.push({
        rule_id:              'cc.statement_balance_unpaid',
        rule_category:        'cc',
        priority:             days <= 1 ? 'critical' : days <= 3 ? 'high' : 'medium',
        card_id:              card.id,
        title:                `Payment due ${days <= 0 ? 'now (overdue)' : `in ${days} day${days > 1 ? 's' : ''}`} — ${card.card_name || card.id}`,
        message:              `Outstanding balance of PKR ${(outstanding / 100).toFixed(0)} is ${days <= 0 ? 'overdue' : `due in ${days} days`}. Pay now to avoid late fees.`,
        action_label:         'Pay Now',
        action_url:           `/credit-card`,
        related_entity_type:  'credit_card',
        related_entity_id:    card.id,
      });
    }

    return json({ ok: true, count: insights.length, insights });

  } catch (e) {
    if (e.status === 401) {
      return json({ ok: false, error: 'Session required', code: 'UNAUTHORIZED' }, 401);
    }
    return json({ ok: false, error: e.message || String(e), code: 'INTERNAL_ERROR' }, 500);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB not found');
  return env.DB;
}

function requireUserId(context) {
  const userId = context.data?.user_id;
  if (!userId) {
    const e = new Error('Session required');
    e.status = 401;
    throw e;
  }
  return userId;
}
