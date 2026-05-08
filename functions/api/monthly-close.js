/* Sovereign Finance /api/monthly-close v0.1.0
 * Layer 7A - Monthly Close API
 *
 * Purpose:
 * - Read-only month-end audit/report brain.
 * - Summarizes current-month income, outflow, bills, debts, CC, forecast, safety, reconciliation, and audit readiness.
 *
 * Contract:
 * - GET /api/monthly-close
 * - Optional query: ?month=YYYY-MM
 * - No schema mutation.
 * - No ledger mutation.
 * - No audit writes.
 */

import { json } from './_lib.js';

const VERSION = 'v0.1.0';

const INCOME_TYPES = new Set(['income', 'salary', 'borrow', 'debt_in', 'opening']);
const OUTFLOW_TYPES = new Set(['expense', 'repay', 'cc_spend', 'atm', 'debt_out']);
const TRANSFER_TYPES = new Set(['transfer', 'cc_payment']);
const UNSAFE_THRESHOLD = 5000;
const WATCH_THRESHOLD = 10000;
const RECON_DRIFT_THRESHOLD = 1;

export async function onRequest(context) {
  const db = context.env.DB;
  const now = new Date();
  const url = new URL(context.request.url);
  const month = normalizeMonth(url.searchParams.get('month')) || now.toISOString().slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEndExclusive = nextMonthStart(month);

  try {
    const [
      forecastRes,
      safetyRes,
      insightsRes,
      accountsRes,
      txnsRes,
      billsRes,
      debtsRes,
      reconRes
    ] = await Promise.all([
      readInternalJson(context, '/api/forecast'),
      readInternalJson(context, '/api/safety'),
      readInternalJson(context, '/api/insights'),
      safeAll(db, `SELECT * FROM accounts`),
      safeAll(db, `SELECT * FROM transactions WHERE date >= ? AND date < ? ORDER BY date ASC, created_at ASC, id ASC`, [monthStart, monthEndExclusive]),
      safeAll(db, `SELECT * FROM bills`),
      safeAll(db, `SELECT * FROM debts`),
      safeAll(db, `SELECT * FROM reconciliation ORDER BY declared_at DESC`)
    ]);

    const accounts = activeAccounts(accountsRes.rows);
    const transactions = activeTransactions(txnsRes.rows);
    const bills = visibleBills(billsRes.rows);
    const debts = activeDebts(debtsRes.rows);
    const reconciliation = reconRes.rows || [];
    const forecast = forecastRes.data || null;
    const safety = safetyRes.data || null;
    const insights = insightsRes.data || null;

    const balances = computeAccountBalances(accounts, transactions);
    const currentPosition = computeCurrentPosition(accounts, balances, forecast);
    const income = computeIncome(transactions);
    const outflow = computeOutflow(transactions);
    const billSummary = computeBills(bills, month);
    const debtSummary = computeDebts(debts, transactions);
    const creditCard = computeCreditCard(currentPosition, forecast);
    const forecastSummary = computeForecast(forecast);
    const safetySummary = computeSafety(safety);
    const reconciliationSummary = computeReconciliation(accounts, balances, reconciliation, transactions);
    const auditReadiness = computeAuditReadiness({
      forecastRes,
      safetyRes,
      insightsRes,
      accountsRes,
      txnsRes,
      billsRes,
      debtsRes,
      reconRes,
      forecastSummary,
      safetySummary,
      reconciliationSummary,
      billSummary,
      debtSummary
    });

    return json({
      ok: true,
      version: VERSION,
      computed_at: now.toISOString(),
      month,
      range: {
        start: monthStart,
        end_exclusive: monthEndExclusive
      },

      summary: {
        opening_position: null,
        current_liquid: currentPosition.total_liquid,
        cc_outstanding: currentPosition.cc_outstanding,
        net_cash_after_cc: currentPosition.net_cash_after_cc,
        month_income: income.total,
        month_outflow: outflow.total,
        net_movement: round2(income.total - outflow.total),
        safety_status: safetySummary.status,
        forecast_runway_status: forecastSummary.runway_status,
        audit_readiness_status: auditReadiness.status
      },

      income,
      outflow,
      bills: billSummary,
      debts: debtSummary,
      credit_card: creditCard,
      forecast: forecastSummary,
      safety: safetySummary,
      reconciliation: reconciliationSummary,
      insights: {
        ok: insightsRes.ok,
        version: insights && insights.version ? insights.version : null,
        top_insight: insights && insights.top_insight ? insights.top_insight : null,
        insight_count: insights && Array.isArray(insights.insights) ? insights.insights.length : 0,
        error: insightsRes.error || null
      },

      audit_readiness: auditReadiness,

      health: {
        forecast: healthRow(forecastRes),
        safety: healthRow(safetyRes),
        insights: healthRow(insightsRes),
        accounts: healthRow(accountsRes),
        transactions: healthRow(txnsRes),
        bills: healthRow(billsRes),
        debts: healthRow(debtsRes),
        reconciliation: healthRow(reconRes)
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      computed_at: now.toISOString(),
      error: err.message || String(err)
    }, 500);
  }
}

async function readInternalJson(context, pathname) {
  try {
    const url = new URL(context.request.url);
    url.pathname = pathname;
    url.search = '';

    const headers = new Headers();
    const cookie = context.request.headers.get('cookie');
    const cfAccessJwt = context.request.headers.get('cf-access-jwt-assertion');

    if (cookie) headers.set('cookie', cookie);
    if (cfAccessJwt) headers.set('cf-access-jwt-assertion', cfAccessJwt);

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers,
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      return {
        ok: false,
        rows: [],
        data: null,
        error: data && data.error ? data.error : `${pathname} HTTP ${res.status}`
      };
    }

    return { ok: true, rows: [data], data, error: null };
  } catch (err) {
    return { ok: false, rows: [], data: null, error: err.message || String(err) };
  }
}

async function safeAll(db, sql, binds = []) {
  try {
    const stmt = db.prepare(sql);
    const res = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    return { ok: true, rows: res.results || [], error: null };
  } catch (err) {
    return { ok: false, rows: [], error: err.message || String(err) };
  }
}

function computeIncome(transactions) {
  const rows = transactions.filter(row => INCOME_TYPES.has(text(row.type).toLowerCase()));
  const byType = groupByType(rows);

  return {
    total: round2(sumAmounts(rows)),
    count: rows.length,
    by_type: byType,
    rows: rows.map(minTxn)
  };
}

function computeOutflow(transactions) {
  const rows = transactions.filter(row => OUTFLOW_TYPES.has(text(row.type).toLowerCase()));
  const transfers = transactions.filter(row => TRANSFER_TYPES.has(text(row.type).toLowerCase()));

  return {
    total: round2(sumAmounts(rows)),
    count: rows.length,
    by_type: groupByType(rows),
    transfer_movement_total: round2(sumAmounts(transfers)),
    transfer_movement_count: transfers.length,
    rows: rows.map(minTxn)
  };
}

function computeBills(bills, month) {
  const due = [];
  const paid = [];
  const missingRequiredData = [];

  for (const bill of bills) {
    const dueDate = billDueDateForMonth(bill, month);
    const amount = number(bill.amount);

    if (!dueDate) {
      missingRequiredData.push({
        id: bill.id || null,
        name: bill.name || null,
        missing: 'due_date_or_due_day'
      });
      continue;
    }

    const paidThisMonth = billPaidThisMonth(bill, month);

    const row = {
      id: bill.id || null,
      name: bill.name || 'Bill',
      amount: round2(amount),
      due_date: dueDate,
      paid_this_month: paidThisMonth,
      default_account_id: bill.default_account_id || null
    };

    due.push(row);
    if (paidThisMonth) paid.push(row);

    if (!bill.default_account_id) {
      missingRequiredData.push({
        id: bill.id || null,
        name: bill.name || null,
        missing: 'default_account_id'
      });
    }
  }

  return {
    due_count: due.length,
    paid_count: paid.length,
    unpaid_count: Math.max(0, due.length - paid.length),
    due_total: round2(sumField(due, 'amount')),
    paid_total: round2(sumField(paid, 'amount')),
    completion_rate: due.length ? round4(paid.length / due.length) : 1,
    due,
    paid,
    missing_required_data: missingRequiredData
  };
}

function computeDebts(debts, transactions) {
  const payable = debts
    .filter(row => normalizeDebtKind(row.kind) !== 'owed')
    .map(row => ({
      id: row.id || null,
      name: row.name || 'Debt',
      remaining_amount: round2(remainingDebtAmount(row)),
      installment_amount: nullableRound2(row.installment_amount),
      due_date: normalizeDate(row.due_date) || null,
      due_day: row.due_day || null,
      status: row.status || 'active'
    }))
    .filter(row => row.remaining_amount > 0);

  const receivable = debts
    .filter(row => normalizeDebtKind(row.kind) === 'owed')
    .map(row => ({
      id: row.id || null,
      name: row.name || 'Receivable',
      remaining_amount: round2(remainingDebtAmount(row)),
      installment_amount: nullableRound2(row.installment_amount),
      due_date: normalizeDate(row.due_date) || null,
      due_day: row.due_day || null,
      status: row.status || 'active'
    }))
    .filter(row => row.remaining_amount > 0);

  const debtPaymentRows = transactions.filter(row => {
    const type = text(row.type).toLowerCase();
    return type === 'repay' || type === 'debt_out';
  });

  const missingRequiredData = payable
    .filter(row => !row.due_date && !row.due_day)
    .map(row => ({
      id: row.id,
      name: row.name,
      missing: 'due_date_or_due_day'
    }));

  return {
    payable_count: payable.length,
    receivable_count: receivable.length,
    total_payable_remaining: round2(sumField(payable, 'remaining_amount')),
    total_receivable_remaining: round2(sumField(receivable, 'remaining_amount')),
    debt_paid_this_month: round2(sumAmounts(debtPaymentRows)),
    debt_payment_count_this_month: debtPaymentRows.length,
    payable,
    receivable,
    missing_required_data: missingRequiredData
  };
}

function computeCreditCard(currentPosition, forecast) {
  const salary = forecast && forecast.salary ? forecast.salary : {};
  const conservativeSalary = number(salary.baseline_net_without_manual_variables_pkr);
  const outstanding = number(currentPosition.cc_outstanding);

  return {
    outstanding: round2(outstanding),
    conservative_net_salary: round2(conservativeSalary),
    pressure_ratio: conservativeSalary > 0 ? round4(outstanding / conservativeSalary) : null,
    status: outstanding <= 0
      ? 'clear'
      : conservativeSalary > 0 && outstanding / conservativeSalary >= 0.75
        ? 'high_pressure'
        : conservativeSalary > 0 && outstanding / conservativeSalary >= 0.4
          ? 'watch'
          : 'manageable'
  };
}

function computeForecast(forecast) {
  if (!forecast) {
    return {
      ok: false,
      version: null,
      runway_status: 'unknown',
      unsafe_days_count: null,
      watch_days_count: null,
      lowest_projected_balance: null,
      first_unsafe_date: null,
      blocker: 'forecast_unavailable'
    };
  }

  const projectionRows = Array.isArray(forecast.daily_cash_projection_30d)
    ? forecast.daily_cash_projection_30d
    : [];

  const unsafeDays = projectionRows.filter(row => number(row.closing_balance) < UNSAFE_THRESHOLD);
  const watchDays = projectionRows.filter(row => {
    const close = number(row.closing_balance);
    return close >= UNSAFE_THRESHOLD && close < WATCH_THRESHOLD;
  });

  const summary = forecast.cash_projection_summary || {};

  return {
    ok: true,
    version: forecast.version || null,
    runway_status: summary.runway_status || null,
    unsafe_days_count: unsafeDays.length,
    watch_days_count: watchDays.length,
    lowest_projected_balance: nullableRound2(summary.lowest_projected_balance),
    lowest_projected_balance_date: summary.lowest_projected_balance_date || null,
    first_unsafe_date: summary.first_unsafe_date || null,
    first_watch_date: summary.first_watch_date || null,
    cash_after_salary_and_obligations: nullableRound2(summary.cash_after_salary_and_obligations),
    manual_variables_separated: summary.manual_variables_separated !== false,
    projection_days: projectionRows.length
  };
}

function computeSafety(safety) {
  if (!safety) {
    return {
      ok: false,
      version: null,
      status: 'unknown',
      blocker: 'safety_unavailable'
    };
  }

  return {
    ok: true,
    version: safety.version || null,
    status: safety.safety_status || safety.status || null,
    top_action: safety.top_action || null,
    next_risk_date: safety.next_risk_date || null,
    what_happens_if_no_action: safety.what_happens_if_no_action || null,
    driver_count: Array.isArray(safety.drivers) ? safety.drivers.length : 0,
    confidence: safety.confidence || null,
    manual_variables_used_for_safety: !!safety.manual_variables_used_for_safety
  };
}

function computeReconciliation(accounts, balances, rows, transactions) {
  const latest = latestReconByAccount(rows);
  const latestTxn = latestTxnDateByAccount(accounts, transactions);
  const accountRows = [];

  let matched = 0;
  let stale = 0;
  let drifted = 0;
  let undeclared = 0;

  for (const account of accounts) {
    const declaration = latest[account.id] || null;
    const appBalance = balances[account.id] || 0;
    const declared = declaration ? number(declaration.declared_balance) : null;
    const drift = declaration ? round2(declared - appBalance) : null;
    const latestTransactionDate = latestTxn[account.id] || null;
    const declaredDate = declaration ? normalizeDate(declaration.declared_at) : null;

    let status = 'matched';

    if (!declaration) {
      undeclared++;
      status = 'undeclared';
    } else if (latestTransactionDate && declaredDate && latestTransactionDate > declaredDate) {
      stale++;
      status = 'stale';
    } else if (Math.abs(number(drift)) >= RECON_DRIFT_THRESHOLD) {
      drifted++;
      status = 'drifted';
    } else {
      matched++;
    }

    accountRows.push({
      account_id: account.id,
      account_name: account.name || account.id,
      status,
      app_balance: round2(appBalance),
      declared_balance: declaration ? round2(declared) : null,
      drift,
      declared_at: declaration ? declaration.declared_at || null : null,
      latest_transaction_date: latestTransactionDate
    });
  }

  const confidence = drifted > 0
    ? 'low'
    : undeclared > 0
      ? 'medium_low'
      : stale > 0
        ? 'medium'
        : 'high';

  return {
    confidence,
    matched_count: matched,
    stale_count: stale,
    drifted_count: drifted,
    undeclared_count: undeclared,
    accounts: accountRows
  };
}

function computeAuditReadiness(input) {
  const blockers = [];
  const warnings = [];

  if (!input.forecastRes.ok) blockers.push('forecast_api_unavailable');
  if (!input.safetyRes.ok) blockers.push('safety_api_unavailable');
  if (!input.insightsRes.ok) warnings.push('insights_api_unavailable');
  if (!input.accountsRes.ok) blockers.push('accounts_read_failed');
  if (!input.txnsRes.ok) blockers.push('transactions_read_failed');
  if (!input.billsRes.ok) blockers.push('bills_read_failed');
  if (!input.debtsRes.ok) blockers.push('debts_read_failed');
  if (!input.reconRes.ok) blockers.push('reconciliation_read_failed');

  if (input.forecastSummary.first_unsafe_date) blockers.push('forecast_has_unsafe_date');
  if (input.forecastSummary.unsafe_days_count > 0) blockers.push('forecast_has_unsafe_days');
  if (input.safetySummary.status === 'critical') blockers.push('safety_status_critical');
  if (input.safetySummary.status === 'unsafe') blockers.push('safety_status_unsafe');
  if (input.safetySummary.manual_variables_used_for_safety) blockers.push('manual_variables_used_for_safety');

  if (input.reconciliationSummary.drifted_count > 0) blockers.push('reconciliation_drift');
  if (input.reconciliationSummary.undeclared_count > 0) warnings.push('undeclared_accounts');
  if (input.reconciliationSummary.stale_count > 0) warnings.push('stale_account_declarations');

  if (input.billSummary.missing_required_data.length) warnings.push('bills_missing_required_data');
  if (input.debtSummary.missing_required_data.length) warnings.push('debts_missing_required_data');

  return {
    status: blockers.length ? 'not_ready' : 'ready',
    blockers,
    warnings,
    audit_scope_ready: {
      api_routes: blockers.filter(x => x.includes('_api_') || x.includes('_read_')).length === 0,
      formulas: true,
      reconciliation: input.reconciliationSummary.drifted_count === 0,
      safety: !['critical', 'unsafe'].includes(input.safetySummary.status),
      manual_variable_separation: !input.safetySummary.manual_variables_used_for_safety,
      required_data: input.billSummary.missing_required_data.length === 0 && input.debtSummary.missing_required_data.length === 0
    }
  };
}

/* Shared helpers */

function activeAccounts(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !text(row.deleted_at) && !text(row.archived_at) && (!status || status === 'active');
  });
}

function activeTransactions(rows) {
  return (rows || []).filter(row => !isReversalRelated(row));
}

function visibleBills(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !text(row.deleted_at) && status !== 'deleted' && status !== 'archived';
  });
}

function activeDebts(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !status || status === 'active';
  });
}

function computeAccountBalances(accounts, transactions) {
  const balances = {};
  const ids = new Set();

  for (const account of accounts) {
    balances[account.id] = number(account.opening_balance);
    ids.add(account.id);
  }

  for (const txn of transactions) {
    const type = text(txn.type).toLowerCase();
    const amount = number(txn.amount);
    const fee = number(txn.fee_amount);
    const pra = number(txn.pra_amount);
    const origin = text(txn.account_id);
    const target = text(txn.transfer_to_account_id);

    if (type === 'transfer' || type === 'cc_payment') {
      if (origin && ids.has(origin)) balances[origin] -= amount + fee + pra;
      if (target && ids.has(target)) balances[target] += amount;
      continue;
    }

    if (!origin || !ids.has(origin)) continue;

    if (INCOME_TYPES.has(type)) balances[origin] += amount;
    else if (OUTFLOW_TYPES.has(type)) balances[origin] -= amount + fee + pra;
  }

  const out = {};
  for (const id of Object.keys(balances)) out[id] = round2(balances[id]);
  return out;
}

function computeCurrentPosition(accounts, balances, forecast) {
  if (forecast && forecast.current_position) {
    return {
      total_liquid: round2(forecast.current_position.total_liquid),
      cc_outstanding: round2(forecast.current_position.cc_outstanding),
      net_cash_after_cc: round2(forecast.current_position.net_cash_after_cc)
    };
  }

  let totalLiquid = 0;
  let ccOutstanding = 0;

  for (const account of accounts) {
    const bal = balances[account.id] || 0;
    const kind = text(account.kind || account.type).toLowerCase();

    if (isCreditCardKind(kind)) ccOutstanding += Math.max(0, Math.abs(bal));
    else if (kind !== 'liability') totalLiquid += bal;
  }

  return {
    total_liquid: round2(totalLiquid),
    cc_outstanding: round2(ccOutstanding),
    net_cash_after_cc: round2(totalLiquid - ccOutstanding)
  };
}

function latestReconByAccount(rows) {
  const sorted = (rows || []).slice().sort((a, b) => text(b.declared_at).localeCompare(text(a.declared_at)));
  const out = {};

  for (const row of sorted) {
    const id = text(row.account_id);
    if (id && !out[id]) out[id] = row;
  }

  return out;
}

function latestTxnDateByAccount(accounts, transactions) {
  const ids = new Set(accounts.map(a => a.id));
  const out = {};

  for (const account of accounts) out[account.id] = null;

  for (const txn of transactions) {
    const date = normalizeDate(txn.date);
    if (!date) continue;

    const origin = text(txn.account_id);
    const target = text(txn.transfer_to_account_id);

    if (origin && ids.has(origin) && (!out[origin] || date > out[origin])) out[origin] = date;
    if (target && ids.has(target) && (!out[target] || date > out[target])) out[target] = date;
  }

  return out;
}

function billDueDateForMonth(bill, month) {
  if (bill.due_date && normalizeDate(bill.due_date).slice(0, 7) === month) return normalizeDate(bill.due_date);

  const day = normalizeDueDay(bill.due_day);
  if (day == null) return null;

  const [year, monthNum] = month.split('-').map(Number);
  const max = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const safeDay = Math.min(day, max);

  return `${month}-${String(safeDay).padStart(2, '0')}`;
}

function billPaidThisMonth(bill, month) {
  const last = normalizeDate(bill.last_paid_date);
  return !!last && last.slice(0, 7) === month;
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

function isReversalRelated(txn) {
  if (!txn) return false;
  if (text(txn.reversed_by)) return true;
  if (text(txn.reversed_at)) return true;

  const notes = text(txn.notes).toUpperCase();
  return notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY ');
}

function groupByType(rows) {
  const map = {};

  for (const row of rows) {
    const type = text(row.type || 'unknown').toLowerCase() || 'unknown';
    if (!map[type]) map[type] = { type, total: 0, count: 0 };
    map[type].total += number(row.amount);
    map[type].count++;
  }

  return Object.values(map)
    .map(row => ({ ...row, total: round2(row.total) }))
    .sort((a, b) => b.total - a.total);
}

function minTxn(row) {
  return {
    id: row.id || null,
    date: normalizeDate(row.date),
    type: row.type || null,
    amount: round2(row.amount),
    account_id: row.account_id || null,
    category_id: row.category_id || null
  };
}

function healthRow(res) {
  return {
    ok: !!res.ok,
    row_count: res.rows ? res.rows.length : 0,
    version: res.data && res.data.version ? res.data.version : null,
    error: res.error || null
  };
}

function sumAmounts(rows) {
  return (rows || []).reduce((sum, row) => sum + number(row.amount), 0);
}

function sumField(rows, field) {
  return (rows || []).reduce((sum, row) => sum + number(row[field]), 0);
}

function normalizeMonth(value) {
  const raw = text(value);
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return null;
}

function nextMonthStart(month) {
  const [year, monthNum] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, monthNum, 1));
  return d.toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return '';
  return raw.slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const day = Number(value);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return Math.floor(day);
}

function nullableRound2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round2(n) : null;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(number(value) * 10000) / 10000;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}
