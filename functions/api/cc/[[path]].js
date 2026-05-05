/* ─── /api/cc/[[path]] · v0.2.0 · TRACE-AUDIT computeBalance FIX ─── */
/*
 * Changes vs v0.1.0 (per TRACE audit finding 12):
 *   - computeBalance SQL was using non-existent type values 'transfer_in' and 'transfer_out'
 *   - D1 reality: single type='transfer' row with account_id (source) + transfer_to_account_id (dest)
 *   - Was IGNORING every CC paydown via transfer (most CC payments)
 *   - Was IGNORING cc_spend (charges), repay, borrow types entirely
 *   - Now matches /api/balances v0.4.2 canonical math (liability-aware)
 *
 * Schema (per SCHEMA.md):
 *   transactions: id, date, type, amount, account_id, transfer_to_account_id, category_id, reversed_at
 *   accounts: id, type, kind, credit_limit, min_payment_amount, statement_day, payment_due_day, opening_balance
 *
 * CC liability balance for account 'cc' computed in JS (matches balances.js logic):
 *   Start: opening_balance (typically 0)
 *   cc_spend on cc           → +amt (debt grows)
 *   cc_payment FROM cc       → -amt (paid off via outbound, rare)
 *   transfer source on cc    → +amt (cash advance from CC, liability grows)
 *   transfer dest on cc      → -amt (CC paydown — the common case)
 *   borrow on cc             → +amt (untypical for CC but handled)
 *   repay on cc              → -amt (untypical for CC but handled)
 *   income/expense not used on liability
 */

import { json } from '../_lib.js';

export async function onRequest(context) {
  const { request, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;

  try {
    if (segments.length === 0 && method === 'GET') {
      return await listCCAccounts(context);
    }

    if (segments.length === 2 && segments[1] === 'payoff-plan' && method === 'GET') {
      return await getPayoffPlan(context, segments[0]);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (err) {
    console.error('[cc api]', err);
    return json({ ok: false, error: err.message || String(err) }, 500);
  }
}

async function listCCAccounts(context) {
  const db = context.env.DB;
  const r = await db.prepare(
    "SELECT * FROM accounts WHERE kind = 'cc' AND (deleted_at IS NULL OR deleted_at = '') ORDER BY display_order, name"
  ).all();
  const accounts = r.results || [];

  const enriched = await Promise.all(accounts.map(async a => {
    const balance = await computeCCBalance(db, a);
    return enrichCC(a, balance);
  }));

  return json({ ok: true, accounts: enriched });
}

async function getPayoffPlan(context, accountId) {
  const db = context.env.DB;
  const acct = await db.prepare(
    "SELECT * FROM accounts WHERE id = ? AND kind = 'cc' AND (deleted_at IS NULL OR deleted_at = '')"
  ).bind(accountId).first();

  if (!acct) return json({ ok: false, error: 'CC account not found' }, 404);

  const balance = await computeCCBalance(db, acct);
  const enriched = enrichCC(acct, balance);

  // Payoff scenarios
  const outstanding = Math.abs(balance);
  const minPay = acct.min_payment_amount || (acct.credit_limit ? acct.credit_limit * 0.05 : 0);
  const limit = acct.credit_limit || 0;

  const scenarios = computePayoffScenarios(outstanding, minPay);

  return json({
    ok: true,
    account: enriched,
    outstanding,
    min_payment: minPay,
    credit_limit: limit,
    available_credit: limit > 0 ? Math.max(0, limit - outstanding) : null,
    utilization_pct: limit > 0 ? Math.round((outstanding / limit) * 1000) / 10 : null,
    scenarios
  });
}

async function computeCCBalance(db, acct) {
  // Match /api/balances v0.4.2 liability-aware math
  // Pull all txns where this CC is involved (as account_id OR transfer_to_account_id)
  const r = await db.prepare(
    `SELECT type, amount, account_id, transfer_to_account_id
     FROM transactions
     WHERE (account_id = ? OR transfer_to_account_id = ?)
       AND (reversed_at IS NULL OR reversed_at = '')`
  ).bind(acct.id, acct.id).all();

  let balance = acct.opening_balance || 0;
  (r.results || []).forEach(t => {
    const amt = t.amount || 0;
    if (t.type === 'cc_spend') {
      if (t.account_id === acct.id) balance += amt;
    } else if (t.type === 'cc_payment') {
      if (t.account_id === acct.id) balance -= amt;
    } else if (t.type === 'borrow') {
      if (t.account_id === acct.id) balance += amt;
    } else if (t.type === 'repay') {
      if (t.account_id === acct.id) balance -= amt;
    } else if (t.type === 'transfer') {
      // Liability-aware
      if (t.account_id === acct.id) {
        balance += amt; // Cash advance: liability grows
      }
      if (t.transfer_to_account_id === acct.id) {
        balance -= amt; // CC paydown: liability shrinks
      }
    }
    // income/expense not applicable to liability accounts
  });

  return Math.round(balance * 100) / 100;
}

function enrichCC(acct, balance) {
  const limit = acct.credit_limit || 0;
  const outstanding = Math.abs(balance);
  return {
    ...acct,
    balance,
    outstanding,
    available_credit: limit > 0 ? Math.max(0, limit - outstanding) : null,
    utilization_pct: limit > 0 ? Math.round((outstanding / limit) * 1000) / 10 : null,
    days_to_payment_due: computeDaysToDue(acct.payment_due_day),
    days_to_statement: computeDaysToDue(acct.statement_day)
  };
}

function computeDaysToDue(day) {
  if (!day) return null;
  const today = new Date();
  const todayDay = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  let diff = day - todayDay;
  if (diff < 0) diff += daysInMonth;
  return diff;
}

function computePayoffScenarios(outstanding, minPay) {
  if (outstanding <= 0) {
    return {
      paid_off: true,
      message: 'Already paid off — no scenarios needed'
    };
  }

  // Assume 28% APR (Pakistan typical CC rate)
  const monthlyRate = 0.28 / 12;

  return {
    minimum_only: scenario(outstanding, minPay, monthlyRate),
    pay_double_min: scenario(outstanding, minPay * 2, monthlyRate),
    pay_5pct: scenario(outstanding, outstanding * 0.05, monthlyRate),
    pay_10pct: scenario(outstanding, outstanding * 0.10, monthlyRate),
    pay_in_6_months: paymentForMonths(outstanding, 6, monthlyRate),
    pay_in_12_months: paymentForMonths(outstanding, 12, monthlyRate),
    pay_in_24_months: paymentForMonths(outstanding, 24, monthlyRate)
  };
}

function scenario(principal, monthlyPayment, monthlyRate) {
  if (monthlyPayment <= principal * monthlyRate) {
    return {
      payment: Math.round(monthlyPayment),
      months: null,
      total_paid: null,
      total_interest: null,
      message: 'Payment too low — debt grows forever at this rate'
    };
  }
  let bal = principal;
  let totalPaid = 0;
  let months = 0;
  while (bal > 0 && months < 600) {
    const interest = bal * monthlyRate;
    bal = bal + interest - monthlyPayment;
    if (bal < 0) bal = 0;
    totalPaid += monthlyPayment;
    months++;
  }
  if (months >= 600) {
    return { payment: Math.round(monthlyPayment), months: null, message: 'Over 50 years — payment too low' };
  }
  return {
    payment: Math.round(monthlyPayment),
    months,
    total_paid: Math.round(totalPaid),
    total_interest: Math.round(totalPaid - principal)
  };
}

function paymentForMonths(principal, months, monthlyRate) {
  // PMT formula: P = principal * r / (1 - (1+r)^-n)
  const r = monthlyRate;
  const payment = principal * r / (1 - Math.pow(1 + r, -months));
  const totalPaid = payment * months;
  return {
    months,
    payment: Math.round(payment),
    total_paid: Math.round(totalPaid),
    total_interest: Math.round(totalPaid - principal)
  };
}
