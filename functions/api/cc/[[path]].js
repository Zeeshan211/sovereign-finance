/*  Sovereign Finance  /api/cc/[[path]]  v0.3.1  Canonical CC Liability Semantics  */
/*
* Handles:
*   GET /api/cc
*   GET /api/cc/{id}/payoff-plan
*
* Contract:
*   - Read-only.
*   - No ledger mutation.
*   - No schema mutation.
*   - Computes Credit Card statement cycle, due date, due pressure, and minimum-payment fields.
*
* Canonical CC semantics:
*   - Credit Card account balance is liability-style.
*   - cc_spend on the CC account makes balance more negative.
*   - cc_payment / transfer into the CC account makes balance less negative.
*   - outstanding = max(0, -balance).
*   - credit_balance = max(0, balance).
*
* This aligns /api/cc with:
*   - /api/balances v0.5.3
*   - /api/accounts balance model
*
* Known operator rule:
*   - Statement / billing day: 12th monthly unless account.statement_day overrides.
*   - Interest-free period: 55 days unless account.interest_free_days overrides.
*
* Minimum payment:
*   - If account.minimum_payment_amount or account.min_payment_amount exists, use it as exact/account-configured.
*   - Otherwise expose an estimated 5% of outstanding and mark source as estimated_outstanding_5pct.
*/

import { json } from '../_lib.js';

const VERSION = 'v0.3.1';

const DEFAULT_STATEMENT_DAY = 12;
const DEFAULT_INTEREST_FREE_DAYS = 55;
const DEFAULT_MIN_PAYMENT_PCT = 0.05;

const UTILIZATION_WATCH_PCT = 40;
const UTILIZATION_UNSAFE_PCT = 75;
const DUE_WATCH_DAYS = 7;
const DUE_UNSAFE_DAYS = 3;

const TYPE_PLUS = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

export async function onRequest(context) {
  const { request, params } = context;
  const path = params.path;
  const segments = !path
    ? []
    : (Array.isArray(path) ? path : [path]);
  const method = request.method;

  try {
    if (segments.length === 0 && method === 'GET') {
      return await listCCAccounts(context);
    }

    if (segments.length === 2 && segments[1] === 'payoff-plan' && method === 'GET') {
      return await getPayoffPlan(context, segments[0]);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Not found'
    }, 404);
  } catch (err) {
    console.error('[cc api]', err);

    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function listCCAccounts(context) {
  const db = context.env.DB;

  const r = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE kind = 'cc'
       AND (deleted_at IS NULL OR deleted_at = '')
       AND (archived_at IS NULL OR archived_at = '')
       AND (status IS NULL OR status = '' OR status = 'active')
     ORDER BY display_order, name`
  ).all();

  const accounts = r.results || [];
  const enriched = await Promise.all(accounts.map(async account => {
    const balanceResult = await computeCCBalance(db, account);

    return enrichCC(account, balanceResult);
  }));

  const totalOutstanding = enriched.reduce((sum, account) => {
    return sum + (Number(account.outstanding) || 0);
  }, 0);

  const totalLimit = enriched.reduce((sum, account) => {
    return sum + (Number(account.credit_limit) || 0);
  }, 0);

  return json({
    ok: true,
    version: VERSION,
    count: enriched.length,
    total_outstanding: round2(totalOutstanding),
    total_credit_limit: round2(totalLimit),
    utilization_pct: totalLimit > 0
      ? round1((totalOutstanding / totalLimit) * 100)
      : null,
    accounts: enriched,
    defaults: {
      statement_day: DEFAULT_STATEMENT_DAY,
      interest_free_days: DEFAULT_INTEREST_FREE_DAYS,
      minimum_payment_pct_if_missing: DEFAULT_MIN_PAYMENT_PCT
    },
    semantics: {
      balance_model: 'liability',
      cc_spend: 'decreases_cc_balance',
      cc_payment_to_cc: 'increases_cc_balance',
      outstanding_formula: 'max(0, -balance)',
      aligned_with: ['/api/balances v0.5.3', '/api/accounts balance model']
    }
  });
}

async function getPayoffPlan(context, accountId) {
  const db = context.env.DB;

  const account = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?
       AND kind = 'cc'
       AND (deleted_at IS NULL OR deleted_at = '')
       AND (archived_at IS NULL OR archived_at = '')
       AND (status IS NULL OR status = '' OR status = 'active')`
  ).bind(accountId).first();

  if (!account) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Credit Card account not found'
    }, 404);
  }

  const balanceResult = await computeCCBalance(db, account);
  const enriched = enrichCC(account, balanceResult);
  const outstanding = Number(enriched.outstanding) || 0;
  const minPayment = Number(enriched.minimum_payment_amount) || 0;
  const limit = Number(enriched.credit_limit) || 0;
  const scenarios = computePayoffScenarios(outstanding, minPayment);

  return json({
    ok: true,
    version: VERSION,
    account: enriched,
    outstanding,
    cc_outstanding: outstanding,
    balance: enriched.balance,
    credit_balance: enriched.credit_balance,
    min_payment: minPayment,
    minimum_payment_amount: minPayment,
    minimum_payment_source: enriched.minimum_payment_source,
    minimum_payment_is_estimate: enriched.minimum_payment_is_estimate,
    credit_limit: limit,
    available_credit: limit > 0
      ? Math.max(0, limit - outstanding)
      : null,
    utilization_pct: limit > 0
      ? round1((outstanding / limit) * 100)
      : null,
    due: enriched.due,
    scenarios,
    semantics: {
      balance_model: 'liability',
      outstanding_formula: 'max(0, -balance)'
    }
  });
}

async function computeCCBalance(db, account) {
  const r = await db.prepare(
    `SELECT id, type, amount, account_id, transfer_to_account_id,
            fee_amount, pra_amount, notes, reversed_by, reversed_at
     FROM transactions
     WHERE (account_id = ? OR transfer_to_account_id = ?)
     ORDER BY date ASC, created_at ASC`
  ).bind(account.id, account.id).all();

  const rows = r.results || [];
  const activeRows = rows.filter(txn => !isReversalRow(txn));

  let balance = Number(account.opening_balance) || 0;
  const debug = {
    rows_seen: rows.length,
    active_rows_seen: activeRows.length,
    hidden_reversal_count: rows.length - activeRows.length,
    cc_spend_sum: 0,
    cc_payment_to_card_sum: 0,
    cc_payment_from_card_sum: 0,
    transfer_to_card_sum: 0,
    transfer_from_card_sum: 0,
    other_plus_sum: 0,
    other_minus_sum: 0,
    fee_sum: 0,
    pra_sum: 0
  };

  activeRows.forEach(txn => {
    const amount = Number(txn.amount) || 0;
    const fee = Number(txn.fee_amount) || 0;
    const pra = Number(txn.pra_amount) || 0;
    const type = String(txn.type || '').toLowerCase();
    const isSource = txn.account_id === account.id;
    const isTarget = txn.transfer_to_account_id === account.id;

    if ((type === 'transfer' || type === 'cc_payment') && txn.transfer_to_account_id) {
      if (isSource) {
        balance -= amount;

        if (type === 'cc_payment') {
          debug.cc_payment_from_card_sum += amount;
        } else {
          debug.transfer_from_card_sum += amount;
        }

        if (fee) {
          balance -= fee;
          debug.fee_sum += fee;
        }

        if (pra) {
          balance -= pra;
          debug.pra_sum += pra;
        }
      }

      if (isTarget) {
        balance += amount;

        if (type === 'cc_payment') {
          debug.cc_payment_to_card_sum += amount;
        } else {
          debug.transfer_to_card_sum += amount;
        }
      }

      return;
    }

    if (!isSource) return;

    if (TYPE_PLUS.has(type)) {
      balance += amount;
      debug.other_plus_sum += amount;
      return;
    }

    if (TYPE_MINUS.has(type)) {
      balance -= amount;

      if (type === 'cc_spend') {
        debug.cc_spend_sum += amount;
      } else {
        debug.other_minus_sum += amount;
      }

      if (fee) {
        balance -= fee;
        debug.fee_sum += fee;
      }

      if (pra) {
        balance -= pra;
        debug.pra_sum += pra;
      }
    }
  });

  return {
    balance: round2(balance),
    debug
  };
}

function enrichCC(account, balanceResult) {
  const balance = Number(balanceResult.balance) || 0;
  const limit = Number(account.credit_limit) || 0;
  const outstanding = Math.max(0, -balance);
  const creditBalance = Math.max(0, balance);
  const availableCredit = limit > 0
    ? Math.max(0, limit - outstanding)
    : null;
  const utilizationPct = limit > 0
    ? round1((outstanding / limit) * 100)
    : null;
  const due = computeDueEngine(account, outstanding, utilizationPct);

  return {
    ...account,
    version: VERSION,
    balance: round2(balance),
    balance_model: 'liability',
    outstanding: round2(outstanding),
    cc_outstanding: round2(outstanding),
    credit_balance: round2(creditBalance),
    credit_limit: limit,
    available_credit: availableCredit,
    utilization_pct: utilizationPct,
    utilization_status: utilizationStatus(utilizationPct),
    statement_day: due.statement_day,
    interest_free_days: due.interest_free_days,
    latest_statement_date: due.latest_statement_date,
    next_statement_date: due.next_statement_date,
    payment_due_date: due.payment_due_date,
    days_until_payment_due: due.days_until_payment_due,
    days_to_payment_due: due.days_until_payment_due,
    days_until_statement: due.days_until_statement,
    days_to_statement: due.days_until_statement,
    minimum_payment_amount: due.minimum_payment_amount,
    minimum_payment_source: due.minimum_payment_source,
    minimum_payment_is_estimate: due.minimum_payment_is_estimate,
    minimum_payment_formula: due.minimum_payment_formula,
    due_status: due.due_status,
    due_headline: due.due_headline,
    due,
    debug: balanceResult.debug
  };
}

function computeDueEngine(account, outstanding, utilizationPct) {
  const now = new Date();
  const statementDay = validDay(account.statement_day) || DEFAULT_STATEMENT_DAY;
  const interestFreeDays = positiveInt(account.interest_free_days) || DEFAULT_INTEREST_FREE_DAYS;
  const latestStatement = latestDayOfMonth(statementDay, now);
  const nextStatement = nextDayOfMonth(statementDay, now);
  const paymentDueDate = addDays(latestStatement, interestFreeDays);
  const daysUntilDue = daysBetween(startOfDay(now), paymentDueDate);
  const daysUntilStatement = daysBetween(startOfDay(now), nextStatement);
  const minPayment = computeMinimumPayment(account, outstanding);

  return {
    statement_day: statementDay,
    interest_free_days: interestFreeDays,
    latest_statement_date: dateOnly(latestStatement),
    next_statement_date: dateOnly(nextStatement),
    payment_due_date: dateOnly(paymentDueDate),
    days_until_payment_due: daysUntilDue,
    days_until_statement: daysUntilStatement,
    minimum_payment_amount: minPayment.amount,
    minimum_payment_source: minPayment.source,
    minimum_payment_is_estimate: minPayment.is_estimate,
    minimum_payment_formula: minPayment.formula,
    due_status: dueStatus(daysUntilDue, outstanding),
    due_headline: dueHeadline(daysUntilDue, outstanding, utilizationPct, minPayment)
  };
}

function computeMinimumPayment(account, outstanding) {
  const exact = firstPositive([
    account.minimum_payment_amount,
    account.min_payment_amount
  ]);

  if (exact != null) {
    return {
      amount: round2(exact),
      source: 'account_configured',
      is_estimate: false,
      formula: 'account.minimum_payment_amount or account.min_payment_amount'
    };
  }

  if (outstanding <= 0) {
    return {
      amount: 0,
      source: 'none_no_outstanding',
      is_estimate: false,
      formula: '0 because outstanding is 0'
    };
  }

  return {
    amount: round2(outstanding * DEFAULT_MIN_PAYMENT_PCT),
    source: 'estimated_outstanding_5pct',
    is_estimate: true,
    formula: 'outstanding * 0.05 because no official minimum payment is configured'
  };
}

function dueStatus(daysUntilDue, outstanding) {
  if (outstanding <= 0) return 'clear';
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue <= DUE_UNSAFE_DAYS) return 'due_urgent';
  if (daysUntilDue <= DUE_WATCH_DAYS) return 'due_soon';

  return 'scheduled';
}

function dueHeadline(daysUntilDue, outstanding, utilizationPct, minPayment) {
  if (outstanding <= 0) {
    return 'Credit Card has no outstanding balance.';
  }

  const minText = minPayment.is_estimate
    ? `Estimated minimum payment is Rs ${formatNumber(minPayment.amount)}.`
    : `Minimum payment is Rs ${formatNumber(minPayment.amount)}.`;

  if (daysUntilDue < 0) {
    return `Credit Card payment is overdue by ${Math.abs(daysUntilDue)} day(s). ${minText}`;
  }

  if (daysUntilDue <= DUE_UNSAFE_DAYS) {
    return `Credit Card payment is due in ${daysUntilDue} day(s). ${minText}`;
  }

  if (daysUntilDue <= DUE_WATCH_DAYS) {
    return `Credit Card due date is approaching in ${daysUntilDue} day(s). ${minText}`;
  }

  if (utilizationPct != null && utilizationPct >= UTILIZATION_UNSAFE_PCT) {
    return `Credit Card utilization is high at ${utilizationPct}%. ${minText}`;
  }

  if (utilizationPct != null && utilizationPct >= UTILIZATION_WATCH_PCT) {
    return `Credit Card utilization needs attention at ${utilizationPct}%. ${minText}`;
  }

  return `Credit Card payment is scheduled in ${daysUntilDue} day(s). ${minText}`;
}

function utilizationStatus(utilizationPct) {
  if (utilizationPct == null) return 'unknown';
  if (utilizationPct >= UTILIZATION_UNSAFE_PCT) return 'high';
  if (utilizationPct >= UTILIZATION_WATCH_PCT) return 'watch';

  return 'controlled';
}

function isReversalRow(txn) {
  if (!txn) return false;
  if (txn.reversed_by || txn.reversed_at) return true;

  const notes = String(txn.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function latestDayOfMonth(day, now) {
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), day);

  if (candidate > today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() - 1, day);
  }

  return candidate;
}

function nextDayOfMonth(day, now) {
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), day);

  if (candidate <= today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  }

  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, maxDay);

  return new Date(Date.UTC(year, monthIndex, safeDay));
}

function addDays(date, days) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);

  return out;
}

function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();

  return Math.round(ms / 86400000);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function validDay(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 31) return null;

  return Math.floor(n);
}

function positiveInt(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) return null;

  return Math.floor(n);
}

function firstPositive(values) {
  for (const value of values) {
    const n = Number(value);

    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function formatNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-PK');
}

function computePayoffScenarios(outstanding, minPay) {
  if (outstanding <= 0) {
    return {
      paid_off: true,
      message: 'Already paid off. No scenarios needed.'
    };
  }

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
  if (monthlyPayment <= 0) {
    return {
      payment: 0,
      months: null,
      total_paid: null,
      total_interest: null,
      message: 'No payment amount available.'
    };
  }

  if (monthlyPayment <= principal * monthlyRate) {
    return {
      payment: Math.round(monthlyPayment),
      months: null,
      total_paid: null,
      total_interest: null,
      message: 'Payment too low. Debt grows forever at this rate.'
    };
  }

  let balance = principal;
  let totalPaid = 0;
  let months = 0;

  while (balance > 0 && months < 600) {
    const interest = balance * monthlyRate;
    balance = balance + interest - monthlyPayment;

    if (balance < 0) {
      totalPaid += monthlyPayment + balance;
      balance = 0;
    } else {
      totalPaid += monthlyPayment;
    }

    months++;
  }

  if (months >= 600) {
    return {
      payment: Math.round(monthlyPayment),
      months: null,
      message: 'Over 50 years. Payment too low.'
    };
  }

  return {
    payment: Math.round(monthlyPayment),
    months,
    total_paid: Math.round(totalPaid),
    total_interest: Math.round(totalPaid - principal)
  };
}

function paymentForMonths(principal, months, monthlyRate) {
  if (principal <= 0) {
    return {
      months,
      payment: 0,
      total_paid: 0,
      total_interest: 0
    };
  }

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
