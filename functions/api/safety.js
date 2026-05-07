/*  Sovereign Finance  /api/safety  v0.1.2  Debt Schedule Safety wiring  */
/*
 * Purpose:
 * - Answer: Am I safe, why or why not, what changed, and what action protects me now?
 *
 * Contract:
 * - GET /api/safety
 * - Read-only.
 * - No schema mutation.
 * - No ledger mutation.
 * - No audit writes.
 * - No fake values.
 * - Missing optional tables become warnings, not crashes.
 *
 * v0.1.1:
 * - Credit Card safety uses statement day, 55-day interest-free period,
 *   payment due date, due status, and minimum-payment fields.
 *
 * v0.1.2:
 * - Debt safety uses due_date / due_day / installment_amount / frequency / last_paid_date.
 * - Distinguishes debts I owe from receivables owed to me.
 */

import { json } from './_lib.js';

const VERSION = 'v0.1.2';

const LOW_LIQUID_UNSAFE = 5000;
const LOW_LIQUID_WATCH = 10000;

const BILL_DUE_WATCH_DAYS = 3;
const DEBT_DUE_WATCH_DAYS = 3;

const DEFAULT_CC_STATEMENT_DAY = 12;
const DEFAULT_CC_INTEREST_FREE_DAYS = 55;
const DEFAULT_CC_MIN_PAYMENT_PCT = 0.05;
const CC_DUE_WATCH_DAYS = 7;
const CC_DUE_UNSAFE_DAYS = 3;
const CC_UTIL_WATCH = 40;
const CC_UTIL_UNSAFE = 75;

const ATM_REVERSAL_WINDOW_DAYS = 10;
const RECON_DRIFT_THRESHOLD = 1;

const TYPE_PLUS = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

export async function onRequest(context) {
  const db = context.env.DB;
  const now = new Date();

  try {
    const [accountsRes, txnsRes, billsRes, debtsRes, reconRes, nanoRes] = await Promise.all([
      readTable(db, 'accounts'),
      readTable(db, 'transactions'),
      readTable(db, 'bills'),
      readTable(db, 'debts'),
      readTable(db, 'reconciliation'),
      readTable(db, 'nano_loans')
    ]);

    const accounts = activeAccounts(accountsRes.rows);
    const transactions = activeTransactions(txnsRes.rows);
    const bills = visibleBills(billsRes.rows);
    const debts = activeDebts(debtsRes.rows);
    const reconciliation = reconRes.rows || [];
    const nanoLoans = nanoRes.rows || [];

    const accountBalances = computeAccountBalances(accounts, transactions);
    const balanceSummary = computeBalanceSummary(accounts, accountBalances, debts);

    const reasons = [];
    const actions = [];
    const health = [];

    collectReadHealth(health, {
      accounts: accountsRes,
      transactions: txnsRes,
      bills: billsRes,
      debts: debtsRes,
      reconciliation: reconRes,
      nano_loans: nanoRes
    });

    evaluateLiquidity(reasons, actions, balanceSummary);
    evaluateBills(reasons, actions, bills, now);
    evaluateDebts(reasons, actions, debts, now);
    evaluateCreditCards(reasons, actions, accounts, accountBalances, now);
    evaluateReconciliation(reasons, actions, reconciliation, accountBalances);
    evaluateATM(reasons, actions, transactions, now);
    evaluateNanoLoans(reasons, actions, nanoLoans);
    evaluateMissingTruth(reasons, actions, accounts, bills, debts);

    const uniqueReasons = dedupeReasons(reasons);
    const uniqueActions = dedupeActions(actions);
    const score = computeScore(uniqueReasons);
    const status = computeStatus(score, uniqueReasons);
    const nextRiskDate = computeNextRiskDate(uniqueReasons);
    const headline = buildHeadline(status, uniqueReasons, balanceSummary);

    return json({
      ok: true,
      version: VERSION,
      status,
      score,
      headline,
      reasons: uniqueReasons,
      actions: uniqueActions,
      next_risk_date: nextRiskDate,
      computed_at: now.toISOString(),
      summary: {
        total_liquid: round2(balanceSummary.total_liquid),
        net_worth: round2(balanceSummary.net_worth),
        true_burden: round2(balanceSummary.true_burden),
        cc_outstanding: round2(balanceSummary.cc_outstanding),
        total_owed: round2(balanceSummary.total_owed),
        active_bill_count: bills.length,
        active_debt_count: debts.length,
        active_account_count: accounts.length
      },
      thresholds: {
        low_liquid_watch: LOW_LIQUID_WATCH,
        low_liquid_unsafe: LOW_LIQUID_UNSAFE,
        bill_due_watch_days: BILL_DUE_WATCH_DAYS,
        debt_due_watch_days: DEBT_DUE_WATCH_DAYS,
        cc_statement_day_default: DEFAULT_CC_STATEMENT_DAY,
        cc_interest_free_days_default: DEFAULT_CC_INTEREST_FREE_DAYS,
        cc_due_watch_days: CC_DUE_WATCH_DAYS,
        cc_due_unsafe_days: CC_DUE_UNSAFE_DAYS,
        cc_utilization_watch_pct: CC_UTIL_WATCH,
        cc_utilization_unsafe_pct: CC_UTIL_UNSAFE,
        cc_minimum_payment_estimate_pct: DEFAULT_CC_MIN_PAYMENT_PCT,
        reconciliation_drift_threshold: RECON_DRIFT_THRESHOLD,
        atm_reversal_window_days: ATM_REVERSAL_WINDOW_DAYS
      },
      health
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err),
      computed_at: now.toISOString()
    }, 500);
  }
}

async function readTable(db, table) {
  try {
    const res = await db.prepare(`SELECT * FROM ${table}`).all();
    return {
      ok: true,
      table,
      rows: res.results || [],
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      table,
      rows: [],
      error: err.message || String(err)
    };
  }
}

function collectReadHealth(health, reads) {
  for (const key of Object.keys(reads)) {
    const item = reads[key];
    health.push({
      table: key,
      ok: item.ok,
      row_count: item.rows.length,
      error: item.error || null
    });
  }
}

function activeAccounts(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    const deleted = text(row.deleted_at);
    const archived = text(row.archived_at);
    return !deleted && !archived && (!status || status === 'active');
  });
}

function activeTransactions(rows) {
  return (rows || []).filter(row => !isReversalRow(row));
}

function visibleBills(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    const deleted = text(row.deleted_at);
    return !deleted && status !== 'deleted' && status !== 'archived';
  });
}

function activeDebts(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !status || status === 'active';
  });
}

function isReversalRow(row) {
  if (!row) return false;
  if (row.reversed_by || row.reversed_at) return true;
  const notes = text(row.notes).toUpperCase();
  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function computeAccountBalances(accounts, transactions) {
  const balances = {};
  const meta = {};

  for (const account of accounts) {
    balances[account.id] = number(account.opening_balance);
    meta[account.id] = account;
  }

  for (const txn of transactions) {
    const amount = number(txn.amount);
    const fee = number(txn.fee_amount);
    const pra = number(txn.pra_amount);
    const accountId = txn.account_id;
    const toAccountId = txn.transfer_to_account_id;
    const type = text(txn.type).toLowerCase();

    if (type === 'transfer' || type === 'cc_payment') {
      if (accountId && balances[accountId] != null) {
        balances[accountId] -= amount;
        balances[accountId] -= fee;
        balances[accountId] -= pra;
      }
      if (toAccountId && balances[toAccountId] != null) {
        balances[toAccountId] += amount;
      }
      continue;
    }

    if (!accountId || balances[accountId] == null) continue;

    if (TYPE_PLUS.has(type)) {
      balances[accountId] += amount;
    } else if (TYPE_MINUS.has(type)) {
      balances[accountId] -= amount;
      balances[accountId] -= fee;
      balances[accountId] -= pra;
    }
  }

  const output = {};
  for (const id of Object.keys(balances)) {
    output[id] = {
      account: meta[id],
      balance: round2(balances[id])
    };
  }

  return output;
}

function computeBalanceSummary(accounts, accountBalances, debts) {
  let totalLiquid = 0;
  let ccOutstanding = 0;

  for (const account of accounts) {
    const id = account.id;
    const bal = accountBalances[id] ? number(accountBalances[id].balance) : 0;
    const kind = text(account.kind || account.type).toLowerCase();
    const isCC = isCreditCardKind(kind);

    if (isCC) {
      ccOutstanding += Math.max(0, Math.abs(bal));
    } else if (kind !== 'liability') {
      totalLiquid += bal;
    }
  }

  let totalOwed = 0;
  for (const debt of debts) {
    const kind = normalizeDebtKind(debt.kind);
    if (kind !== 'owed') {
      totalOwed += remainingDebtAmount(debt);
    }
  }

  const netWorth = totalLiquid - ccOutstanding;
  const trueBurden = netWorth - totalOwed;

  return {
    total_liquid: round2(totalLiquid),
    cc_outstanding: round2(ccOutstanding),
    total_owed: round2(totalOwed),
    net_worth: round2(netWorth),
    true_burden: round2(trueBurden)
  };
}

function evaluateLiquidity(reasons, actions, summary) {
  const liquid = number(summary.total_liquid);

  if (liquid < LOW_LIQUID_UNSAFE) {
    pushReason(reasons, {
      code: 'LOW_LIQUID',
      severity: 'unsafe',
      title: 'Liquid cash is below unsafe threshold',
      detail: `Available liquid is ${money(liquid)}, below ${money(LOW_LIQUID_UNSAFE)}.`,
      evidence: { total_liquid: round2(liquid), threshold: LOW_LIQUID_UNSAFE }
    });
    pushAction(actions, {
      reason_code: 'LOW_LIQUID',
      label: 'Review cash position before any new spending',
      module: 'accounts',
      href: '/accounts.html',
      priority: 1
    });
    return;
  }

  if (liquid < LOW_LIQUID_WATCH) {
    pushReason(reasons, {
      code: 'LOW_LIQUID',
      severity: 'watch',
      title: 'Liquid cash is thin',
      detail: `Available liquid is ${money(liquid)}, below watch threshold ${money(LOW_LIQUID_WATCH)}.`,
      evidence: { total_liquid: round2(liquid), threshold: LOW_LIQUID_WATCH }
    });
    pushAction(actions, {
      reason_code: 'LOW_LIQUID',
      label: 'Check upcoming bills before spending',
      module: 'accounts',
      href: '/accounts.html',
      priority: 2
    });
  }
}

function evaluateBills(reasons, actions, bills, now) {
  for (const bill of bills) {
    const amount = number(bill.amount);
    const due = billDueDate(bill, now);
    if (!due) continue;

    const days = daysBetween(startOfDay(now), due);
    const paidThisCycle = billPaidThisCycle(bill, due);

    if (paidThisCycle) continue;

    if (days < 0) {
      pushReason(reasons, {
        code: 'BILL_OVERDUE',
        severity: 'unsafe',
        title: `${safeName(bill.name, 'Bill')} is overdue`,
        detail: `${safeName(bill.name, 'Bill')} is overdue by ${Math.abs(days)} day(s).`,
        next_risk_date: dateOnly(due),
        evidence: {
          bill_id: bill.id || null,
          bill_name: bill.name || null,
          amount: round2(amount),
          due_date: dateOnly(due),
          days_overdue: Math.abs(days)
        }
      });
      pushAction(actions, {
        reason_code: 'BILL_OVERDUE',
        label: `Pay or update ${safeName(bill.name, 'bill')}`,
        module: 'bills',
        href: '/bills.html',
        priority: 1
      });
      continue;
    }

    if (days <= BILL_DUE_WATCH_DAYS) {
      pushReason(reasons, {
        code: 'BILL_DUE_SOON',
        severity: 'watch',
        title: `${safeName(bill.name, 'Bill')} is due soon`,
        detail: `${safeName(bill.name, 'Bill')} is due in ${days} day(s).`,
        next_risk_date: dateOnly(due),
        evidence: {
          bill_id: bill.id || null,
          bill_name: bill.name || null,
          amount: round2(amount),
          due_date: dateOnly(due),
          days_until_due: days
        }
      });
      pushAction(actions, {
        reason_code: 'BILL_DUE_SOON',
        label: `Prepare payment for ${safeName(bill.name, 'bill')}`,
        module: 'bills',
        href: '/bills.html',
        priority: 2
      });
    }
  }
}

function evaluateDebts(reasons, actions, debts, now) {
  for (const debt of debts) {
    const remaining = remainingDebtAmount(debt);
    if (remaining <= 0) continue;

    const kind = normalizeDebtKind(debt.kind);
    const schedule = computeDebtSchedule(debt, now);

    if (schedule.schedule_missing) {
      pushReason(reasons, {
        code: 'DEBT_SCHEDULE_MISSING',
        severity: 'watch',
        title: `${safeName(debt.name, 'Debt')} has no due schedule`,
        detail: `${safeName(debt.name, 'Debt')} needs due_date or due_day for safety forecasting.`,
        evidence: {
          debt_id: debt.id || null,
          debt_name: debt.name || null,
          kind,
          remaining_amount: round2(remaining),
          missing_fields: ['due_date', 'due_day']
        }
      });
      pushAction(actions, {
        reason_code: 'DEBT_SCHEDULE_MISSING',
        label: `Add due schedule for ${safeName(debt.name, 'debt')}`,
        module: 'debts',
        href: '/debts.html',
        priority: 2
      });
      continue;
    }

    const dueLabel = kind === 'owed' ? 'receivable' : 'debt';
    const titleName = safeName(debt.name, kind === 'owed' ? 'Receivable' : 'Debt');
    const evidence = {
      debt_id: debt.id || null,
      debt_name: debt.name || null,
      kind,
      remaining_amount: round2(remaining),
      installment_amount: nullableRound2(debt.installment_amount),
      due_date: normalizeDate(debt.due_date),
      due_day: normalizeDueDay(debt.due_day),
      next_due_date: schedule.next_due_date,
      days_until_due: schedule.days_until_due,
      days_overdue: schedule.days_overdue,
      due_status: schedule.due_status,
      frequency: text(debt.frequency || 'monthly'),
      last_paid_date: normalizeDate(debt.last_paid_date)
    };

    if (schedule.due_status === 'overdue') {
      pushReason(reasons, {
        code: kind === 'owed' ? 'RECEIVABLE_OVERDUE' : 'DEBT_OVERDUE',
        severity: kind === 'owed' ? 'watch' : 'unsafe',
        title: `${titleName} ${dueLabel} is overdue`,
        detail: `${titleName} is overdue by ${schedule.days_overdue} day(s). Remaining ${money(remaining)}.`,
        next_risk_date: schedule.next_due_date,
        evidence
      });
      pushAction(actions, {
        reason_code: kind === 'owed' ? 'RECEIVABLE_OVERDUE' : 'DEBT_OVERDUE',
        label: kind === 'owed'
          ? `Follow up on ${safeName(debt.name, 'receivable')}`
          : `Review overdue payment for ${safeName(debt.name, 'debt')}`,
        module: 'debts',
        href: '/debts.html',
        priority: kind === 'owed' ? 2 : 1
      });
      continue;
    }

    if (schedule.due_status === 'due_today') {
      pushReason(reasons, {
        code: kind === 'owed' ? 'RECEIVABLE_DUE_TODAY' : 'DEBT_DUE_TODAY',
        severity: kind === 'owed' ? 'watch' : 'unsafe',
        title: `${titleName} ${dueLabel} is due today`,
        detail: `${titleName} is due today. Remaining ${money(remaining)}.`,
        next_risk_date: schedule.next_due_date,
        evidence
      });
      pushAction(actions, {
        reason_code: kind === 'owed' ? 'RECEIVABLE_DUE_TODAY' : 'DEBT_DUE_TODAY',
        label: kind === 'owed'
          ? `Check expected receipt from ${safeName(debt.name, 'receivable')}`
          : `Prepare payment for ${safeName(debt.name, 'debt')}`,
        module: 'debts',
        href: '/debts.html',
        priority: kind === 'owed' ? 2 : 1
      });
      continue;
    }

    if (schedule.due_status === 'due_soon') {
      pushReason(reasons, {
        code: kind === 'owed' ? 'RECEIVABLE_DUE_SOON' : 'DEBT_DUE_SOON',
        severity: 'watch',
        title: `${titleName} ${dueLabel} is due soon`,
        detail: `${titleName} is due in ${schedule.days_until_due} day(s). Remaining ${money(remaining)}.`,
        next_risk_date: schedule.next_due_date,
        evidence
      });
      pushAction(actions, {
        reason_code: kind === 'owed' ? 'RECEIVABLE_DUE_SOON' : 'DEBT_DUE_SOON',
        label: kind === 'owed'
          ? `Track expected receipt from ${safeName(debt.name, 'receivable')}`
          : `Plan payment for ${safeName(debt.name, 'debt')}`,
        module: 'debts',
        href: '/debts.html',
        priority: 2
      });
    }
  }
}

function computeDebtSchedule(debt, now) {
  const remaining = remainingDebtAmount(debt);
  if (remaining <= 0) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'paid_off',
      schedule_missing: false
    };
  }

  let due = null;
  const dueDate = normalizeDate(debt.due_date);
  const dueDay = normalizeDueDay(debt.due_day);

  if (dueDate) {
    due = parseDate(dueDate);
  } else if (dueDay != null) {
    due = nextDueFromDay(dueDay, normalizeDate(debt.last_paid_date), now);
  }

  if (!due) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'no_schedule',
      schedule_missing: true
    };
  }

  const today = startOfDay(now);
  const days = daysBetween(today, due);

  if (days < 0) {
    return {
      next_due_date: dateOnly(due),
      days_until_due: 0,
      days_overdue: Math.abs(days),
      due_status: 'overdue',
      schedule_missing: false
    };
  }

  if (days === 0) {
    return {
      next_due_date: dateOnly(due),
      days_until_due: 0,
      days_overdue: 0,
      due_status: 'due_today',
      schedule_missing: false
    };
  }

  if (days <= DEBT_DUE_WATCH_DAYS) {
    return {
      next_due_date: dateOnly(due),
      days_until_due: days,
      days_overdue: 0,
      due_status: 'due_soon',
      schedule_missing: false
    };
  }

  return {
    next_due_date: dateOnly(due),
    days_until_due: days,
    days_overdue: 0,
    due_status: 'scheduled',
    schedule_missing: false
  };
}

function evaluateCreditCards(reasons, actions, accounts, accountBalances, now) {
  const ccAccounts = accounts.filter(account => {
    const kind = text(account.kind || account.type).toLowerCase();
    return isCreditCardKind(kind);
  });

  for (const account of ccAccounts) {
    const bal = accountBalances[account.id] ? number(accountBalances[account.id].balance) : number(account.opening_balance);
    const outstanding = Math.max(0, Math.abs(bal));
    if (outstanding <= 0) continue;

    const limit = number(account.credit_limit);
    const utilization = limit > 0 ? round1((outstanding / limit) * 100) : null;
    const due = computeCreditCardDue(account, outstanding, utilization, now);

    if (utilization != null && utilization >= CC_UTIL_UNSAFE) {
      pushReason(reasons, {
        code: 'CC_HIGH_UTILIZATION',
        severity: 'unsafe',
        title: `${safeName(account.name, 'Credit Card')} utilization is high`,
        detail: `${safeName(account.name, 'Credit Card')} utilization is ${utilization}%.`,
        evidence: {
          account_id: account.id,
          account_name: account.name || null,
          outstanding: round2(outstanding),
          credit_limit: round2(limit),
          utilization_pct: utilization,
          utilization_status: 'high'
        }
      });
      pushAction(actions, {
        reason_code: 'CC_HIGH_UTILIZATION',
        label: 'Reduce Credit Card outstanding',
        module: 'credit-card',
        href: '/cc.html',
        priority: 1
      });
    } else if (utilization != null && utilization >= CC_UTIL_WATCH) {
      pushReason(reasons, {
        code: 'CC_HIGH_UTILIZATION',
        severity: 'watch',
        title: `${safeName(account.name, 'Credit Card')} utilization needs attention`,
        detail: `${safeName(account.name, 'Credit Card')} utilization is ${utilization}%.`,
        evidence: {
          account_id: account.id,
          account_name: account.name || null,
          outstanding: round2(outstanding),
          credit_limit: round2(limit),
          utilization_pct: utilization,
          utilization_status: 'watch'
        }
      });
      pushAction(actions, {
        reason_code: 'CC_HIGH_UTILIZATION',
        label: 'Review Credit Card payoff plan',
        module: 'credit-card',
        href: '/cc.html',
        priority: 2
      });
    }

    if (due.due_status === 'overdue' || due.due_status === 'due_urgent') {
      pushReason(reasons, {
        code: 'CC_DUE_SOON',
        severity: 'unsafe',
        title: `${safeName(account.name, 'Credit Card')} payment is due now`,
        detail: due.due_headline,
        next_risk_date: due.payment_due_date,
        evidence: {
          account_id: account.id,
          account_name: account.name || null,
          outstanding: round2(outstanding),
          statement_day: due.statement_day,
          interest_free_days: due.interest_free_days,
          latest_statement_date: due.latest_statement_date,
          next_statement_date: due.next_statement_date,
          payment_due_date: due.payment_due_date,
          days_until_payment_due: due.days_until_payment_due,
          minimum_payment_amount: due.minimum_payment_amount,
          minimum_payment_source: due.minimum_payment_source,
          minimum_payment_is_estimate: due.minimum_payment_is_estimate,
          minimum_payment_formula: due.minimum_payment_formula,
          due_status: due.due_status,
          due_headline: due.due_headline
        }
      });
      pushAction(actions, {
        reason_code: 'CC_DUE_SOON',
        label: 'Prepare Credit Card payment',
        module: 'credit-card',
        href: '/cc.html',
        priority: 1
      });
    } else if (due.due_status === 'due_soon') {
      pushReason(reasons, {
        code: 'CC_DUE_SOON',
        severity: 'watch',
        title: `${safeName(account.name, 'Credit Card')} due date is approaching`,
        detail: due.due_headline,
        next_risk_date: due.payment_due_date,
        evidence: {
          account_id: account.id,
          account_name: account.name || null,
          outstanding: round2(outstanding),
          statement_day: due.statement_day,
          interest_free_days: due.interest_free_days,
          latest_statement_date: due.latest_statement_date,
          next_statement_date: due.next_statement_date,
          payment_due_date: due.payment_due_date,
          days_until_payment_due: due.days_until_payment_due,
          minimum_payment_amount: due.minimum_payment_amount,
          minimum_payment_source: due.minimum_payment_source,
          minimum_payment_is_estimate: due.minimum_payment_is_estimate,
          minimum_payment_formula: due.minimum_payment_formula,
          due_status: due.due_status,
          due_headline: due.due_headline
        }
      });
      pushAction(actions, {
        reason_code: 'CC_DUE_SOON',
        label: 'Check Credit Card payment requirement',
        module: 'credit-card',
        href: '/cc.html',
        priority: 2
      });
    }
  }
}

function computeCreditCardDue(account, outstanding, utilizationPct, now) {
  const statementDay = validDay(account.statement_day) || DEFAULT_CC_STATEMENT_DAY;
  const interestFreeDays = positiveInt(account.interest_free_days) || DEFAULT_CC_INTEREST_FREE_DAYS;

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
    due_status: creditCardDueStatus(daysUntilDue, outstanding),
    due_headline: creditCardDueHeadline(daysUntilDue, outstanding, utilizationPct, minPayment)
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
    amount: round2(outstanding * DEFAULT_CC_MIN_PAYMENT_PCT),
    source: 'estimated_outstanding_5pct',
    is_estimate: true,
    formula: 'outstanding * 0.05 because no official minimum payment is configured'
  };
}

function creditCardDueStatus(daysUntilDue, outstanding) {
  if (outstanding <= 0) return 'clear';
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue <= CC_DUE_UNSAFE_DAYS) return 'due_urgent';
  if (daysUntilDue <= CC_DUE_WATCH_DAYS) return 'due_soon';
  return 'scheduled';
}

function creditCardDueHeadline(daysUntilDue, outstanding, utilizationPct, minPayment) {
  if (outstanding <= 0) {
    return 'Credit Card has no outstanding balance.';
  }

  const minText = minPayment.is_estimate
    ? `Estimated minimum payment is ${money(minPayment.amount)}.`
    : `Minimum payment is ${money(minPayment.amount)}.`;

  if (daysUntilDue < 0) {
    return `Credit Card payment is overdue by ${Math.abs(daysUntilDue)} day(s). ${minText}`;
  }

  if (daysUntilDue <= CC_DUE_UNSAFE_DAYS) {
    return `Credit Card payment is due in ${daysUntilDue} day(s). ${minText}`;
  }

  if (daysUntilDue <= CC_DUE_WATCH_DAYS) {
    return `Credit Card due date is approaching in ${daysUntilDue} day(s). ${minText}`;
  }

  if (utilizationPct != null && utilizationPct >= CC_UTIL_UNSAFE) {
    return `Credit Card utilization is high at ${utilizationPct}%. ${minText}`;
  }

  if (utilizationPct != null && utilizationPct >= CC_UTIL_WATCH) {
    return `Credit Card utilization needs attention at ${utilizationPct}%. ${minText}`;
  }

  return `Credit Card payment is scheduled in ${daysUntilDue} day(s). ${minText}`;
}

function evaluateReconciliation(reasons, actions, rows, accountBalances) {
  const latest = latestReconByAccount(rows);

  for (const accountId of Object.keys(latest)) {
    const row = latest[accountId];
    if (!accountBalances[accountId]) continue;

    const declared = number(row.declared_balance);
    const live = number(accountBalances[accountId].balance);
    const drift = round2(declared - live);

    if (Math.abs(drift) >= RECON_DRIFT_THRESHOLD) {
      pushReason(reasons, {
        code: 'RECONCILIATION_DRIFT',
        severity: 'unsafe',
        title: `${safeName(row.account_id, 'Account')} balance drift detected`,
        detail: `Declared balance differs from app balance by ${money(drift)}.`,
        evidence: {
          account_id: accountId,
          declared_balance: round2(declared),
          app_balance: round2(live),
          drift_amount: drift,
          declared_at: row.declared_at || null
        }
      });
      pushAction(actions, {
        reason_code: 'RECONCILIATION_DRIFT',
        label: 'Open reconciliation and resolve balance drift',
        module: 'reconciliation',
        href: '/reconciliation.html',
        priority: 1
      });
    }
  }
}

function evaluateATM(reasons, actions, transactions, now) {
  const pending = transactions.filter(txn => {
    const type = text(txn.type).toLowerCase();
    const notes = text(txn.notes);
    const reversed = notes.includes('[ATM_FEE_REVERSED');
    return !reversed && (
      (type === 'atm' && notes.includes('[ATM_FEE_PENDING]')) ||
      (notes.includes('PENDING reversal') && notes.includes('ATM'))
    );
  });

  if (!pending.length) return;

  const total = pending.reduce((sum, txn) => sum + number(txn.amount), 0);
  const overdue = pending.filter(txn => {
    const dt = parseDate(txn.date);
    if (!dt) return false;
    return daysBetween(dt, startOfDay(now)) > ATM_REVERSAL_WINDOW_DAYS;
  });

  pushReason(reasons, {
    code: 'ATM_FEE_PENDING',
    severity: overdue.length ? 'unsafe' : 'watch',
    title: overdue.length ? 'ATM fee reversal is overdue' : 'ATM fee reversal is pending',
    detail: `${pending.length} ATM fee(s) pending, total ${money(total)}.`,
    evidence: {
      pending_count: pending.length,
      overdue_count: overdue.length,
      total_pending_pkr: round2(total)
    }
  });
  pushAction(actions, {
    reason_code: 'ATM_FEE_PENDING',
    label: 'Review ATM pending fee reversals',
    module: 'atm',
    href: '/atm.html',
    priority: overdue.length ? 1 : 2
  });
}

function evaluateNanoLoans(reasons, actions, loans) {
  const active = (loans || []).filter(loan => text(loan.status || 'active').toLowerCase() === 'active');
  if (!active.length) return;

  const remaining = active.reduce((sum, loan) => {
    return sum + Math.max(0, number(loan.total_owed) - number(loan.repaid_amount));
  }, 0);

  if (remaining <= 0) return;

  pushReason(reasons, {
    code: 'NANO_EXPOSURE_ACTIVE',
    severity: 'watch',
    title: 'Nano Loan exposure is active',
    detail: `${active.length} active Nano Loan(s), remaining ${money(remaining)}.`,
    evidence: {
      active_count: active.length,
      remaining_amount: round2(remaining)
    }
  });
  pushAction(actions, {
    reason_code: 'NANO_EXPOSURE_ACTIVE',
    label: 'Review Nano Loans before new borrowing',
    module: 'nano-loans',
    href: '/nano-loans.html',
    priority: 2
  });
}

function evaluateMissingTruth(reasons, actions, accounts, bills, debts) {
  const activeBillsWithoutAccount = bills.filter(bill => !text(bill.default_account_id));
  if (activeBillsWithoutAccount.length) {
    pushReason(reasons, {
      code: 'MISSING_REQUIRED_DATA',
      severity: 'watch',
      title: 'Some bills have no default payment account',
      detail: `${activeBillsWithoutAccount.length} bill(s) need default_account_id for accurate payment planning.`,
      evidence: {
        count: activeBillsWithoutAccount.length,
        missing_field: 'default_account_id'
      }
    });
    pushAction(actions, {
      reason_code: 'MISSING_REQUIRED_DATA',
      label: 'Set default payment accounts for bills',
      module: 'bills',
      href: '/bills.html',
      priority: 2
    });
  }

  const unscheduledActiveDebts = debts.filter(debt => {
    const remaining = remainingDebtAmount(debt);
    if (remaining <= 0) return false;
    return computeDebtSchedule(debt, new Date()).schedule_missing;
  });

  if (unscheduledActiveDebts.length) {
    pushReason(reasons, {
      code: 'DEBT_SCHEDULE_MISSING',
      severity: 'watch',
      title: 'Some debts still have no due schedule',
      detail: `${unscheduledActiveDebts.length} active debt(s) need due_date or due_day for safety forecasting.`,
      evidence: {
        count: unscheduledActiveDebts.length,
        missing_field: 'due_date_or_due_day',
        debt_ids: unscheduledActiveDebts.map(debt => debt.id).filter(Boolean)
      }
    });
    pushAction(actions, {
      reason_code: 'DEBT_SCHEDULE_MISSING',
      label: 'Add remaining debt due schedules',
      module: 'debts',
      href: '/debts.html',
      priority: 2
    });
  }
}

function latestReconByAccount(rows) {
  const sorted = (rows || []).slice().sort((a, b) => {
    return text(b.declared_at).localeCompare(text(a.declared_at));
  });

  const out = {};
  for (const row of sorted) {
    const accountId = text(row.account_id);
    if (!accountId) continue;
    if (!out[accountId]) out[accountId] = row;
  }
  return out;
}

function billDueDate(bill, now) {
  if (bill.due_date) return parseDate(bill.due_date);
  return dayOfMonthDate(bill.due_day, now);
}

function dayOfMonthDate(dayRaw, now) {
  const day = Number(dayRaw);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = startOfDay(now);
  let due = safeUtcDate(y, m, day);

  if (due < today) {
    due = safeUtcDate(y, m + 1, day);
  }

  return due;
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

function nextDueFromDay(day, lastPaidDate, now) {
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), day);

  if (lastPaidDate && lastPaidDate.slice(0, 7) === today.toISOString().slice(0, 7)) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  } else if (candidate < today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  }

  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, max);
  return new Date(Date.UTC(year, monthIndex, safeDay));
}

function addDays(date, days) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function billPaidThisCycle(bill, dueDate) {
  const lastPaid = parseDate(bill.last_paid_date);
  if (!lastPaid) return false;

  return (
    lastPaid.getUTCFullYear() === dueDate.getUTCFullYear() &&
    lastPaid.getUTCMonth() === dueDate.getUTCMonth()
  );
}

function pushReason(reasons, reason) {
  reasons.push({
    code: reason.code,
    severity: reason.severity || 'watch',
    title: reason.title,
    detail: reason.detail,
    evidence: reason.evidence || {},
    next_risk_date: reason.next_risk_date || null
  });
}

function pushAction(actions, action) {
  actions.push({
    reason_code: action.reason_code,
    label: action.label,
    module: action.module,
    href: action.href,
    priority: action.priority || 3
  });
}

function dedupeReasons(reasons) {
  const seen = new Set();
  const out = [];

  for (const reason of reasons) {
    const key = [
      reason.code,
      reason.severity,
      reason.title,
      reason.next_risk_date || ''
    ].join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }

  return out.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function dedupeActions(actions) {
  const seen = new Set();
  const out = [];

  for (const action of actions) {
    const key = [action.reason_code, action.module, action.label].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }

  return out.sort((a, b) => (a.priority || 9) - (b.priority || 9));
}

function computeScore(reasons) {
  let score = 100;

  for (const reason of reasons) {
    if (reason.severity === 'unsafe') score -= 25;
    else if (reason.severity === 'watch') score -= 10;
    else score -= 5;
  }

  return Math.max(0, Math.min(100, score));
}

function computeStatus(score, reasons) {
  if (reasons.some(reason => reason.severity === 'unsafe')) return 'unsafe';
  if (score < 80 || reasons.some(reason => reason.severity === 'watch')) return 'watch';
  return 'safe';
}

function computeNextRiskDate(reasons) {
  const dates = reasons
    .map(reason => reason.next_risk_date)
    .filter(Boolean)
    .sort();

  return dates.length ? dates[0] : null;
}

function buildHeadline(status, reasons, summary) {
  if (status === 'safe') {
    return `Safe right now. Liquid cash is ${money(summary.total_liquid)} and no urgent risk was detected.`;
  }

  const firstUnsafe = reasons.find(reason => reason.severity === 'unsafe');
  if (firstUnsafe) {
    return `Unsafe: ${firstUnsafe.title}.`;
  }

  const firstWatch = reasons.find(reason => reason.severity === 'watch');
  if (firstWatch) {
    return `Watch: ${firstWatch.title}.`;
  }

  return 'Safety status computed.';
}

function severityRank(severity) {
  if (severity === 'unsafe') return 1;
  if (severity === 'watch') return 2;
  return 3;
}

function remainingDebtAmount(debt) {
  return Math.max(0, number(debt.original_amount) - number(debt.paid_amount));
}

function normalizeDebtKind(kind) {
  const val = text(kind).toLowerCase();
  if (['owed', 'owed_me', 'receivable', 'to_me'].includes(val)) return 'owed';
  return 'owe';
}

function isCreditCardKind(kind) {
  return kind === 'cc' || kind === 'credit' || kind === 'credit_card';
}

function parseDate(value) {
  const raw = normalizeDate(value);
  if (!raw) return null;
  const d = new Date(raw + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeDate(value) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;
  const day = Number(value);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return Math.floor(day);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.round(ms / 86400000);
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

function nullableRound2(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round2(n);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function round1(value) {
  return Math.round(number(value) * 10) / 10;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function safeName(value, fallback) {
  return text(value) || fallback;
}

function money(value) {
  const n = number(value);
  const sign = n < 0 ? '-' : '';
  return sign + 'Rs ' + Math.abs(round2(n)).toLocaleString('en-PK', {
    maximumFractionDigits: 2
  });
}
