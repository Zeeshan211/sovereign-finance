/*
 * CC Cron Runner — Sovereign Finance
 *
 * DEPLOYMENT NOTE:
 *   Cloudflare Pages Functions do NOT support cron triggers.
 *   This file implements the cron logic as an HTTP endpoint for manual / external scheduling.
 *   To enable true cron scheduling, deploy this as a separate Cloudflare Worker and add:
 *     [triggers]
 *     crons = ["0 2 * * *", "0 3 * * *", "30 2 * * *", "0 9 * * *",
 *              "0 4 1 * *", "0 6 * * *", "0 10 * * *", "0 4 * * 0",
 *              "0 9 * * 5", "0 1 * * *", "0 5 * * *"]
 *   to a separate wrangler.toml pointing at this file as the Worker entry point.
 *
 * HTTP usage (manual trigger):
 *   GET  /api/scheduled/cron?job=<job_name>   — run one job
 *   GET  /api/scheduled/cron?job=all          — run all jobs
 *
 * Job names (from contract A27):
 *   interest_accrual, statement_generation, emi_installment_billing,
 *   due_date_alerts, autopay_pre_flight, annual_fee_check,
 *   autopay_execute, subscription_detection, rewards_expiry_alert,
 *   cleanup_expired_dry_runs, cleanup_expired_notifications
 *
 * Idempotency:
 *   Each run checks the cron_executions table (contract A27 schema) with
 *   UNIQUE index on (job_name, run_date, entity_id) before executing.
 */

import { json, uuid } from '../api/_lib.js';

// ── HTTP handler (manual trigger) ────────────────────────────────────────────

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  const db = requireDb(env);
  const url = new URL(request.url);
  const jobParam = url.searchParams.get('job') || 'all';

  const results = await runJobs(db, jobParam);
  return json({ ok: true, triggered_at: new Date().toISOString(), results });
}

// ── Scheduled Worker export (for future Worker deployment) ───────────────────

export default {
  async scheduled(event, env) {
    const db = requireDb(env);
    await runJobs(db, 'all');
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const jobParam = url.searchParams.get('job') || 'all';
    const db = requireDb(env);
    const results = await runJobs(db, jobParam);
    return json({ ok: true, triggered_at: new Date().toISOString(), results });
  },
};

// ── Job dispatcher ────────────────────────────────────────────────────────────

const ALL_JOBS = [
  'interest_accrual',
  'statement_generation',
  'emi_installment_billing',
  'due_date_alerts',
  'autopay_pre_flight',
  'annual_fee_check',
  'autopay_execute',
  'subscription_detection',
  'rewards_expiry_alert',
  'cleanup_expired_dry_runs',
  'cleanup_expired_notifications',
];

async function runJobs(db, jobParam) {
  const jobs = jobParam === 'all' ? ALL_JOBS : [jobParam];
  const results = {};

  for (const jobName of jobs) {
    if (!ALL_JOBS.includes(jobName)) {
      results[jobName] = { skipped: true, reason: 'unknown_job' };
      continue;
    }
    try {
      const result = await runJob(db, jobName);
      results[jobName] = result;
    } catch (e) {
      results[jobName] = { ok: false, error: e.message || String(e) };
    }
  }

  return results;
}

// ── Individual job runners ────────────────────────────────────────────────────

async function runJob(db, jobName) {
  const today    = new Date().toISOString().slice(0, 10);
  const runId    = `${jobName}_${today}`;
  const startedAt = new Date().toISOString();

  // Check idempotency — skip if already completed today
  const existing = await db.prepare(
    `SELECT id, status FROM cron_executions WHERE job_name = ? AND run_date = ? AND entity_id = ?`
  ).bind(jobName, today, 'global').first();

  if (existing?.status === 'completed') {
    return { skipped: true, reason: 'already_completed_today' };
  }

  // Log execution start
  const execId = 'cron_' + uuid();
  await db.prepare(`
    INSERT OR REPLACE INTO cron_executions
      (id, job_name, run_date, entity_type, entity_id, status, started_at,
       items_processed, items_skipped, items_failed)
    VALUES (?, ?, ?, 'global', 'global', 'started', ?, 0, 0, 0)
  `).bind(execId, jobName, today, startedAt).run();

  let processed = 0;
  let skipped   = 0;
  let failed    = 0;

  try {
    switch (jobName) {
      case 'interest_accrual':
        ({ processed, skipped, failed } = await jobInterestAccrual(db, today));
        break;
      case 'statement_generation':
        ({ processed, skipped, failed } = await jobStatementGeneration(db, today));
        break;
      case 'emi_installment_billing':
        ({ processed, skipped, failed } = await jobEmiInstallmentBilling(db, today));
        break;
      case 'due_date_alerts':
        ({ processed, skipped, failed } = await jobDueDateAlerts(db, today));
        break;
      case 'autopay_pre_flight':
        ({ processed, skipped, failed } = await jobAutopayPreFlight(db, today));
        break;
      case 'annual_fee_check':
        ({ processed, skipped, failed } = await jobAnnualFeeCheck(db, today));
        break;
      case 'autopay_execute':
        ({ processed, skipped, failed } = await jobAutopayExecute(db, today));
        break;
      case 'subscription_detection':
        ({ processed, skipped, failed } = await jobSubscriptionDetection(db, today));
        break;
      case 'rewards_expiry_alert':
        ({ processed, skipped, failed } = await jobRewardsExpiryAlert(db, today));
        break;
      case 'cleanup_expired_dry_runs':
        ({ processed, skipped, failed } = await jobCleanupDryRuns(db, today));
        break;
      case 'cleanup_expired_notifications':
        ({ processed, skipped, failed } = await jobCleanupNotifications(db, today));
        break;
    }
  } catch (e) {
    await db.prepare(`
      UPDATE cron_executions
         SET status = 'failed', completed_at = ?, error_message = ?,
             items_processed = ?, items_skipped = ?, items_failed = ?
       WHERE id = ?
    `).bind(new Date().toISOString(), e.message || String(e), processed, skipped, failed + 1, execId).run();
    throw e;
  }

  const completedAt = new Date().toISOString();
  await db.prepare(`
    UPDATE cron_executions
       SET status = 'completed', completed_at = ?,
           items_processed = ?, items_skipped = ?, items_failed = ?
     WHERE id = ?
  `).bind(completedAt, processed, skipped, failed, execId).run();

  return { ok: true, processed, skipped, failed, completed_at: completedAt };
}

// ── Job: interest_accrual (daily 02:00 PKT) ──────────────────────────────────
// Accrue daily interest on cards with outstanding balance past grace period.

async function jobInterestAccrual(db, today) {
  const cards = await db.prepare(`
    SELECT cc.*, a.balance AS account_balance
    FROM   credit_cards cc
    JOIN   accounts a ON a.id = cc.account_id
    WHERE  (cc.status IS NULL OR cc.status = 'active')
  `).all();

  let processed = 0, skipped = 0;

  for (const card of (cards.results || [])) {
    const outstandingRs = Math.abs(Number(card.account_balance || 0));
    if (outstandingRs < 1) { skipped++; continue; }

    const apr    = card.purchase_apr || 42.0;
    const daily  = apr / 365 / 100;
    const accrual = Math.round(outstandingRs * daily * 100); // paisa

    if (accrual < 100) { skipped++; continue; } // < PKR 1 — skip

    // Idempotency: one accrual per card per day
    const accrualId = `interest_${card.id}_${today}`;
    const dupCheck = await db.prepare(
      `SELECT id FROM card_interest_accruals WHERE id = ?`
    ).bind(accrualId).first();
    if (dupCheck) { skipped++; continue; }

    const txnId = 'cctx_' + uuid();
    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO card_interest_accruals
          (id, card_id, user_id, amount_paisa, accrual_date,
           period_start, period_end, applied_apr_pct, transaction_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(accrualId, card.id, card.user_id, accrual, today,
              today, today, apr, txnId, new Date().toISOString()),

      db.prepare(`
        INSERT OR IGNORE INTO transactions
          (id, date, type, amount, amount_paisa, account_id,
           notes, source_module, source_action, cc_subtype, created_by_user_id, household_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(txnId, today, 'cc_interest', accrual / 100, accrual,
              card.account_id,
              `[CC_INTEREST] Daily accrual ${apr}% APR card_id=${card.id}`,
              'cron', 'interest_accrual', 'interest', card.user_id,
              card.household_id || null, new Date().toISOString()),
    ]);
    processed++;
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: statement_generation (daily 03:00 PKT) ──────────────────────────────
// Create a card_statements row on a card's statement_cycle_day.

async function jobStatementGeneration(db, today) {
  const dayOfMonth = new Date(today).getDate();
  const cards = await db.prepare(`
    SELECT * FROM credit_cards
    WHERE statement_cycle_day = ?
      AND (status IS NULL OR status = 'active')
  `).bind(dayOfMonth).all();

  let processed = 0, skipped = 0;

  for (const card of (cards.results || [])) {
    const stmtId = `stmt_${card.id}_${today}`;
    const dupCheck = await db.prepare(
      `SELECT id FROM card_statements WHERE id = ?`
    ).bind(stmtId).first();
    if (dupCheck) { skipped++; continue; }

    const prevMonth = new Date(today);
    prevMonth.setMonth(prevMonth.getMonth() - 1);
    const periodStart = `${prevMonth.toISOString().slice(0, 7)}-${String(dayOfMonth).padStart(2, '0')}`;

    await db.prepare(`
      INSERT OR IGNORE INTO card_statements
        (id, card_id, user_id, statement_date, statement_start, statement_end,
         parsing_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(stmtId, card.id, card.user_id, today,
            periodStart, today,
            'cron_generated', new Date().toISOString(), new Date().toISOString()).run();

    processed++;
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: emi_installment_billing (daily 02:30 PKT) ───────────────────────────
// Bill EMI installments that are due today.

async function jobEmiInstallmentBilling(db, today) {
  const plans = await db.prepare(`
    SELECT ip.*, cc.account_id, cc.user_id
    FROM   installment_plans ip
    JOIN   credit_cards cc ON cc.id = ip.card_id
    WHERE  ip.status = 'active'
      AND  ip.next_installment_date <= ?
  `).bind(today).all();

  let processed = 0, skipped = 0;

  for (const plan of (plans.results || [])) {
    const billId = `emi_bill_${plan.id}_${today}`;
    const dup = await db.prepare(`SELECT id FROM transactions WHERE id = ?`).bind(billId).first();
    if (dup) { skipped++; continue; }

    const installmentPaisa = plan.installment_amount_paisa || Math.ceil(plan.total_amount_paisa / plan.installment_count);
    const nextDate = addMonths(today, 1);
    const remaining = (plan.remaining_installments || 1) - 1;
    const newStatus = remaining <= 0 ? 'completed' : 'active';

    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO transactions
          (id, date, type, amount, amount_paisa, account_id,
           notes, source_module, source_action, cc_subtype, created_by_user_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(billId, today, 'cc_spend', installmentPaisa / 100, installmentPaisa,
              plan.account_id,
              `[EMI_BILL] plan_id=${plan.id} installment_plan billing`,
              'cron', 'emi_installment_billing', 'emi_installment', plan.user_id,
              new Date().toISOString()),

      db.prepare(`
        UPDATE installment_plans
           SET remaining_installments = ?,
               next_installment_date  = ?,
               status                 = ?,
               updated_at             = ?
         WHERE id = ?
      `).bind(remaining, nextDate, newStatus, new Date().toISOString(), plan.id),
    ]);
    processed++;
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: due_date_alerts (daily 09:00 PKT) ───────────────────────────────────
// Emit notifications for payments due in 3 days, 1 day, or today.

async function jobDueDateAlerts(db, today) {
  const cards = await db.prepare(`
    SELECT cc.*, a.balance AS account_balance
    FROM   credit_cards cc
    JOIN   accounts a ON a.id = cc.account_id
    WHERE  (cc.status IS NULL OR cc.status = 'active')
  `).all();

  let processed = 0;
  const now = new Date(today);

  for (const card of (cards.results || [])) {
    const outstandingRs = Math.abs(Number(card.account_balance || 0));
    if (outstandingRs < 1) continue;

    const offset   = card.payment_due_offset_days || 21;
    const cycleDay = card.statement_cycle_day || 12;

    const thisMonth = new Date(now.getFullYear(), now.getMonth(), cycleDay);
    const stmtDate  = thisMonth <= now
      ? thisMonth
      : new Date(now.getFullYear(), now.getMonth() - 1, cycleDay);
    const dueDate = new Date(stmtDate);
    dueDate.setDate(dueDate.getDate() + offset);
    const days = Math.round((dueDate - now) / 86400000);

    if (![3, 1, 0].includes(days)) continue;

    const notifId = `due_alert_${card.id}_${today}_${days}d`;
    const dup = await db.prepare(
      `SELECT id FROM notification_log WHERE id = ?`
    ).bind(notifId).first();
    if (dup) continue;

    const title = days === 0
      ? `Payment due today — ${card.card_name || card.id}`
      : `Payment due in ${days} day${days > 1 ? 's' : ''} — ${card.card_name || card.id}`;
    const body = `PKR ${outstandingRs.toFixed(0)} is due ${days === 0 ? 'today' : `in ${days} days`}. Pay now to avoid late fees.`;

    await db.prepare(`
      INSERT OR IGNORE INTO notification_log
        (id, user_id, card_id, notification_type, title, body, data, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(notifId, card.user_id, card.id, 'due_date_alert',
            title, body, JSON.stringify({ days_until_due: days }),
            'unread', new Date().toISOString()).run();

    processed++;
  }

  return { processed, skipped: 0, failed: 0 };
}

// ── Job: autopay_pre_flight (daily 06:00 PKT) ────────────────────────────────
// Check that auto-pay source accounts have sufficient balance before execution.

async function jobAutopayPreFlight(db, today) {
  const cards = await db.prepare(`
    SELECT cc.*, a.balance AS account_balance
    FROM   credit_cards cc
    JOIN   accounts a ON a.id = cc.account_id
    WHERE  cc.auto_pay_enabled = 1
      AND  cc.auto_pay_account_id IS NOT NULL
      AND  (cc.status IS NULL OR cc.status = 'active')
  `).all();

  let processed = 0;

  for (const card of (cards.results || [])) {
    const sourceAcct = await db.prepare(
      `SELECT id, balance FROM accounts WHERE id = ?`
    ).bind(card.auto_pay_account_id).first();
    if (!sourceAcct) continue;

    const outstandingRs = Math.abs(Number(card.account_balance || 0));
    const sourceBalance = Number(sourceAcct.balance || 0);

    if (sourceBalance < outstandingRs * 0.9) {
      const notifId = `autopay_preflight_${card.id}_${today}`;
      const dup = await db.prepare(`SELECT id FROM notification_log WHERE id = ?`).bind(notifId).first();
      if (dup) continue;

      await db.prepare(`
        INSERT OR IGNORE INTO notification_log
          (id, user_id, card_id, notification_type, title, body, data, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(notifId, card.user_id, card.id, 'autopay_insufficient_funds',
              `Auto-pay may fail — ${card.card_name || card.id}`,
              `Source account balance (PKR ${sourceBalance.toFixed(0)}) may be insufficient for payment of PKR ${outstandingRs.toFixed(0)}.`,
              JSON.stringify({ card_id: card.id, source_account_id: card.auto_pay_account_id }),
              'unread', new Date().toISOString()).run();
      processed++;
    }
  }

  return { processed, skipped: 0, failed: 0 };
}

// ── Job: annual_fee_check (monthly, 1st at 04:00 PKT) ────────────────────────
// Notify user when annual fee anniversary is within 30 days.

async function jobAnnualFeeCheck(db, today) {
  const cards = await db.prepare(`
    SELECT * FROM credit_cards
    WHERE  annual_fee_paisa > 0
      AND  issued_date IS NOT NULL
      AND  (status IS NULL OR status = 'active')
  `).all();

  let processed = 0, skipped = 0;
  const now = new Date(today);

  for (const card of (cards.results || [])) {
    const issued = new Date(card.issued_date);
    const thisYear = now.getFullYear();
    const anniversary = new Date(thisYear, issued.getMonth(), issued.getDate());
    if (anniversary < now) anniversary.setFullYear(thisYear + 1);
    const daysToAnniv = Math.round((anniversary - now) / 86400000);

    if (daysToAnniv > 30) { skipped++; continue; }

    const notifId = `annual_fee_${card.id}_${today}`;
    const dup = await db.prepare(`SELECT id FROM notification_log WHERE id = ?`).bind(notifId).first();
    if (dup) { skipped++; continue; }

    await db.prepare(`
      INSERT OR IGNORE INTO notification_log
        (id, user_id, card_id, notification_type, title, body, data, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(notifId, card.user_id, card.id, 'annual_fee_due',
            `Annual fee due in ${daysToAnniv} days — ${card.card_name || card.id}`,
            `Annual fee of PKR ${(card.annual_fee_paisa / 100).toFixed(0)} is due on ${anniversary.toISOString().slice(0, 10)}. Check if you've met the waiver threshold.`,
            JSON.stringify({ annual_fee_paisa: card.annual_fee_paisa, days_until_due: daysToAnniv }),
            'unread', new Date().toISOString()).run();
    processed++;
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: autopay_execute (daily 10:00 PKT) ───────────────────────────────────
// Execute auto-pay for cards that have it enabled and have a balance due.

async function jobAutopayExecute(db, today) {
  const cards = await db.prepare(`
    SELECT cc.*, a.balance AS account_balance
    FROM   credit_cards cc
    JOIN   accounts a ON a.id = cc.account_id
    WHERE  cc.auto_pay_enabled = 1
      AND  cc.auto_pay_account_id IS NOT NULL
      AND  (cc.status IS NULL OR cc.status = 'active')
  `).all();

  let processed = 0, skipped = 0;

  for (const card of (cards.results || [])) {
    const outstanding = Math.round(Math.abs(Number(card.account_balance || 0)) * 100);
    if (outstanding <= 0) { skipped++; continue; }

    const execId = `autopay_exec_${card.id}_${today}`;
    const dup = await db.prepare(`SELECT id FROM transactions WHERE id = ?`).bind(execId).first();
    if (dup) { skipped++; continue; }

    let payAmount = outstanding;
    if (card.auto_pay_amount_type === 'minimum') {
      const minPct  = card.min_payment_pct || 5;
      const minFloor = card.min_payment_floor_paisa || 50000;
      payAmount = Math.max(Math.round(outstanding * minPct / 100), minFloor);
    } else if (card.auto_pay_amount_type === 'fixed') {
      payAmount = card.auto_pay_fixed_amount_paisa || outstanding;
    }

    const sourceAcct = await db.prepare(
      `SELECT id, balance FROM accounts WHERE id = ?`
    ).bind(card.auto_pay_account_id).first();

    if (!sourceAcct || Number(sourceAcct.balance || 0) * 100 < payAmount * 0.9) {
      // Insufficient funds — try backup account
      if (card.auto_pay_fallback_to_minimum && card.auto_pay_backup_account_id) {
        const backup = await db.prepare(
          `SELECT id, balance FROM accounts WHERE id = ?`
        ).bind(card.auto_pay_backup_account_id).first();
        if (!backup || Number(backup.balance || 0) * 100 < payAmount * 0.9) {
          skipped++;
          continue;
        }
      } else if (card.auto_pay_fallback_to_minimum) {
        const minFloor = card.min_payment_floor_paisa || 50000;
        payAmount = Math.min(payAmount, minFloor);
      } else {
        skipped++;
        continue;
      }
    }

    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO transactions
          (id, date, type, amount, amount_paisa, account_id,
           notes, source_module, source_action, created_by_user_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).bind(execId, today, 'cc_payment', payAmount / 100, payAmount,
              card.account_id,
              `[AUTOPAY] Auto-payment card_id=${card.id} from_account=${card.auto_pay_account_id}`,
              'cron', 'autopay_execute', card.user_id, new Date().toISOString()),

      db.prepare(`
        INSERT OR IGNORE INTO notification_log
          (id, user_id, card_id, notification_type, title, body, data, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(`notif_${execId}`, card.user_id, card.id, 'autopay_executed',
              `Auto-pay processed — ${card.card_name || card.id}`,
              `PKR ${(payAmount / 100).toFixed(0)} auto-paid from linked account.`,
              JSON.stringify({ amount_paisa: payAmount, card_id: card.id }),
              'unread', new Date().toISOString()),
    ]);
    processed++;
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: subscription_detection (weekly Sunday 04:00 PKT) ────────────────────
// Scan for new recurring charge patterns across all active cards.

async function jobSubscriptionDetection(db, today) {
  const cards = await db.prepare(`
    SELECT id, account_id, user_id FROM credit_cards
    WHERE  (status IS NULL OR status = 'active')
  `).all();

  let processed = 0, skipped = 0;
  const ago90 = new Date(+new Date(today) - 90 * 86400000).toISOString().slice(0, 10);

  for (const card of (cards.results || [])) {
    const txns = await db.prepare(`
      SELECT id, date, amount_paisa, amount, notes, merchant
      FROM   transactions
      WHERE  account_id = ? AND date >= ? AND type = 'cc_spend'
        AND  (reversed_by IS NULL OR reversed_by = '')
        AND  (reversed_at IS NULL OR reversed_at = '')
      ORDER  BY date ASC
    `).bind(card.account_id, ago90).all();

    const rows = txns.results || [];
    const merchantMap = {};

    for (const txn of rows) {
      const key = extractMerchant(txn.notes || txn.merchant || '');
      if (!key) continue;
      const paisa = txn.amount_paisa || Math.round((txn.amount || 0) * 100);
      if (!merchantMap[key]) merchantMap[key] = [];
      merchantMap[key].push({ date: txn.date, paisa });
    }

    for (const [merchant, charges] of Object.entries(merchantMap)) {
      if (charges.length < 2) continue;

      const dates     = charges.map(c => new Date(c.date).getTime()).sort((a, b) => a - b);
      const intervals = [];
      for (let i = 1; i < dates.length; i++) {
        intervals.push((dates[i] - dates[i - 1]) / 86400000);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

      let frequency = null;
      if (avgInterval >= 25 && avgInterval <= 35)  frequency = 'monthly';
      else if (avgInterval >= 6 && avgInterval <= 8) frequency = 'weekly';
      else if (avgInterval >= 340 && avgInterval <= 390) frequency = 'annual';

      if (!frequency) { skipped++; continue; }

      const avgPaisa = Math.round(charges.reduce((s, c) => s + c.paisa, 0) / charges.length);
      const subId    = `sub_${card.id}_${merchant.slice(0, 20).replace(/\s/g, '_')}_${frequency}`;

      const dup = await db.prepare(
        `SELECT id FROM card_subscriptions WHERE id = ?`
      ).bind(subId).first().catch(() => null);

      if (dup) { skipped++; continue; }

      await db.prepare(`
        INSERT OR IGNORE INTO card_subscriptions
          (id, card_id, user_id, merchant, frequency, avg_amount_paisa,
           last_charge_date, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(subId, card.id, card.user_id, merchant, frequency, avgPaisa,
              charges[charges.length - 1].date, 'active',
              new Date().toISOString(), new Date().toISOString())
        .run().catch(() => { /* table may not exist yet */ });

      processed++;
    }
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: rewards_expiry_alert (weekly Friday 09:00 PKT) ──────────────────────
// Notify when a rewards card has had no activity for 45+ days.

async function jobRewardsExpiryAlert(db, today) {
  const ago45 = new Date(+new Date(today) - 45 * 86400000).toISOString().slice(0, 10);

  const cards = await db.prepare(`
    SELECT * FROM credit_cards
    WHERE  rewards_program IS NOT NULL
      AND  (status IS NULL OR status = 'active')
  `).all();

  let processed = 0, skipped = 0;

  for (const card of (cards.results || [])) {
    const lastTxn = await db.prepare(`
      SELECT date FROM transactions
      WHERE  account_id = ? AND type = 'cc_spend'
        AND  (reversed_by IS NULL OR reversed_by = '')
      ORDER  BY date DESC LIMIT 1
    `).bind(card.account_id).first();

    if (lastTxn && lastTxn.date >= ago45) { skipped++; continue; }

    const notifId = `rewards_expiry_${card.id}_${today}`;
    const dup = await db.prepare(`SELECT id FROM notification_log WHERE id = ?`).bind(notifId).first();
    if (dup) { skipped++; continue; }

    await db.prepare(`
      INSERT OR IGNORE INTO notification_log
        (id, user_id, card_id, notification_type, title, body, data, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(notifId, card.user_id, card.id, 'rewards_expiry_warning',
            `Rewards may expire — ${card.card_name || card.id}`,
            `No purchases in 45+ days on ${card.rewards_program}. Check if your points are expiring soon.`,
            JSON.stringify({ rewards_program: card.rewards_program }),
            'unread', new Date().toISOString()).run();
    processed++;
  }

  return { processed, skipped, failed: 0 };
}

// ── Job: cleanup_expired_dry_runs (daily 01:00 PKT) ──────────────────────────
// Clear stale rows from transaction_dry_runs table (if it exists).

async function jobCleanupDryRuns(db, today) {
  const cutoff = new Date(+new Date() - 10 * 60 * 1000).toISOString(); // 10 min ago
  try {
    const result = await db.prepare(
      `DELETE FROM transaction_dry_runs WHERE created_at < ?`
    ).bind(cutoff).run();
    return { processed: result.changes || 0, skipped: 0, failed: 0 };
  } catch (_) {
    // Table may not exist — non-fatal
    return { processed: 0, skipped: 1, failed: 0 };
  }
}

// ── Job: cleanup_expired_notifications (daily 05:00 PKT) ─────────────────────
// Archive read notifications older than 30 days.

async function jobCleanupNotifications(db, today) {
  const ago30 = new Date(+new Date(today) - 30 * 86400000).toISOString().slice(0, 10);
  const result = await db.prepare(
    `DELETE FROM notification_log WHERE status = 'read' AND created_at < ?`
  ).bind(ago30).run();
  return { processed: result.changes || 0, skipped: 0, failed: 0 };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB not found');
  return env.DB;
}

function extractMerchant(notes) {
  return notes.replace(/\[CC_SPEND\]\s*card_id=[^\s|]+\s*[|]?\s*/i, '').trim().slice(0, 40) || null;
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
