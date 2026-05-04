/* ─── Sovereign Finance · CC Payoff Planner API · v0.1.0 ───
 * Sub-1D-CC-PLAN Ship 1.
 *
 * Pure computation endpoint. No D1 writes. No audit. No snapshot. (Read-only.)
 *
 * Routes:
 *   GET /api/cc/payoff-plan                → returns plans for ALL CC accounts
 *   GET /api/cc/payoff-plan/{account_id}   → returns plan for one CC account
 *
 * Payment scenarios computed per CC:
 *   - min_payment        → 5% of outstanding OR Rs 1000 floor (or account.min_payment_amount if set)
 *   - to_30_pct_target   → balance bringing utilization down to 30% (credit-score sweet spot)
 *   - to_avoid_interest  → full outstanding (assumes current balance ≈ statement balance)
 *   - to_zero            → same as to_avoid_interest, framed differently
 *
 * Each scenario returns: { amount, label, helps_with, achievable_with_balances:[{account,balance,gap}] }
 *
 * Banking-grade compliance: this endpoint NEVER mutates. Use existing /api/transactions/reverse
 * or /api/transactions to actually execute a payment.
 */

import { json } from '../_lib.js';

async function computeBalance(db, accountId, openingBalance) {
  const r = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount
                           WHEN type = 'transfer_in' THEN amount
                           ELSE 0 END), 0) AS credits,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount
                           WHEN type = 'transfer_out' THEN amount
                           ELSE 0 END), 0) AS debits
       FROM transactions
       WHERE account_id = ?
         AND (reversed_by IS NULL OR reversed_by = '')`
    )
    .bind(accountId)
    .first();
  return Number(openingBalance || 0) + Number(r?.credits || 0) - Number(r?.debits || 0);
}

async function getPayingAccounts(db) {
  // Asset accounts that could fund a CC payment, sorted by balance desc
  const rs = await db
    .prepare(`SELECT id, name, opening_balance, kind FROM accounts WHERE kind != 'cc' AND (status = 'active' OR status IS NULL)`)
    .all();
  const accs = await Promise.all((rs.results || []).map(async a => {
    const balance = await computeBalance(db, a.id, a.opening_balance);
    return { id: a.id, name: a.name, kind: a.kind, balance };
  }));
  return accs.filter(a => a.balance > 0).sort((x, y) => y.balance - x.balance);
}

function computeDaysToDue(payment_due_day) {
  if (!payment_due_day) return null;
  const today = new Date();
  const todayDay = today.getUTCDate();
  const dueDay = Number(payment_due_day);
  let days = dueDay - todayDay;
  if (days < 0) {
    const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    days = (daysInMonth - todayDay) + dueDay;
  }
  return days;
}

function buildPlan(cc, payingAccounts) {
  const balance = Number(cc.balance || 0);
  const outstanding = Math.abs(Math.min(0, balance));
  const limit = Number(cc.credit_limit || 0);
  const declared_min = Number(cc.min_payment_amount || 0);

  const scenarios = [];

  // 1. MINIMUM (avoid late fee)
  const min_floor = 1000;
  const min_pct = 0.05;
  const computed_min = Math.max(min_floor, Math.ceil(outstanding * min_pct));
  const min_amount = declared_min > 0 ? declared_min : computed_min;
  scenarios.push({
    id: 'min',
    label: 'Minimum payment',
    amount: Math.min(min_amount, outstanding),
    helps_with: declared_min > 0
      ? 'Avoids late fee · per declared min_payment_amount'
      : 'Avoids late fee · estimated as max(5% of outstanding, Rs 1000)',
    is_estimated: declared_min === 0,
  });

  // 2. TO 30% UTILIZATION (credit-score target)
  if (limit > 0) {
    const target_30_balance = limit * 0.30;
    const to_30 = outstanding - target_30_balance;
    if (to_30 > 0) {
      scenarios.push({
        id: 'to_30_pct',
        label: 'Drop to 30% utilization',
        amount: Math.ceil(to_30),
        helps_with: 'Optimal for credit score · drops utilization from ' +
                    Math.round((outstanding / limit) * 100) + '% to 30%',
      });
    }
  }

  // 3. TO ZERO (interest-free if before statement)
  scenarios.push({
    id: 'to_zero',
    label: 'Pay in full',
    amount: outstanding,
    helps_with: 'No interest charged if paid before statement closes · 100% utilization clear',
  });

  // Annotate each scenario with which paying account(s) could fund it
  for (const s of scenarios) {
    const ranked = payingAccounts.map(a => ({
      account_id: a.id,
      account_name: a.name,
      balance: a.balance,
      can_cover: a.balance >= s.amount,
      gap: a.balance >= s.amount ? 0 : s.amount - a.balance,
    }));
    s.achievable_with_balances = ranked;
    s.fundable = ranked.some(r => r.can_cover);
  }

  return {
    cc_id: cc.id,
    cc_name: cc.name,
    outstanding,
    credit_limit: limit,
    available_credit: limit > 0 ? Math.max(0, limit - outstanding) : null,
    utilization_pct: limit > 0 ? Math.round((outstanding / limit) * 100) : null,
    days_to_payment_due: computeDaysToDue(cc.payment_due_day),
    statement_day: cc.statement_day || null,
    payment_due_day: cc.payment_due_day || null,
    scenarios,
    paying_accounts_summary: {
      count: payingAccounts.length,
      total_available: payingAccounts.reduce((s, a) => s + a.balance, 0),
      richest_account: payingAccounts[0] || null,
    },
  };
}

async function loadCCAccount(db, accountId) {
  const acc = await db.prepare(`SELECT * FROM accounts WHERE id = ? AND kind = 'cc'`).bind(accountId).first();
  if (!acc) return null;
  const balance = await computeBalance(db, acc.id, acc.opening_balance);
  return { ...acc, balance };
}

async function loadAllCCAccounts(db) {
  const rs = await db.prepare(`SELECT * FROM accounts WHERE kind = 'cc' AND (status = 'active' OR status IS NULL)`).all();
  return Promise.all((rs.results || []).map(async a => {
    const balance = await computeBalance(db, a.id, a.opening_balance);
    return { ...a, balance };
  }));
}

/* ─── Cloudflare Pages Function entry ─── */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;
  const db = env.DB;

  if (method !== 'GET') return json({ ok: false, error: 'Method not allowed (read-only endpoint)' }, 405);

  try {
    if (segments.length === 1 && segments[0] === 'payoff-plan') {
      const ccs = await loadAllCCAccounts(db);
      if (ccs.length === 0) return json({ ok: true, plans: [], count: 0, note: 'No CC accounts found' });
      const payingAccounts = await getPayingAccounts(db);
      const plans = ccs.map(cc => buildPlan(cc, payingAccounts));
      return json({ ok: true, plans, count: plans.length });
    }

    if (segments.length === 2 && segments[0] === 'payoff-plan') {
      const ccId = segments[1];
      const cc = await loadCCAccount(db, ccId);
      if (!cc) return json({ ok: false, error: `CC account '${ccId}' not found` }, 404);
      const payingAccounts = await getPayingAccounts(db);
      return json({ ok: true, plan: buildPlan(cc, payingAccounts) });
    }

    return json({ ok: false, error: 'Not found. Available: GET /api/cc/payoff-plan, GET /api/cc/payoff-plan/{cc_id}' }, 404);
  } catch (e) {
    console.error('[cc api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
