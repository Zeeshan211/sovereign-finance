/*  Sovereign Finance  /api/forecast  v0.1.0  Live Salary + Cash Forecast  */
/*
 * Contract:
 * - GET /api/forecast
 * - Read-only.
 * - No ledger mutation.
 * - No schema mutation.
 * - No audit writes.
 * - Live-computes forecast from current D1 data.
 * - Uses payslip/config as salary source data, not stale forecast output.
 * - Baseline excludes MBO, kitty cash, overtime, Eid overtime, and unconfirmed variables.
 * - WFH allowance is USD 30 converted using live USD→PKR when available.
 */

import { json } from './_lib.js';

const VERSION = 'v0.1.0';

const DEFAULT_SALARY_ID = 'salary_primary';
const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD';
const DEFAULT_LOW_LIQUID_UNSAFE = 5000;
const DEFAULT_LOW_LIQUID_WATCH = 10000;

const TYPE_PLUS = new Set(['income', 'salary', 'borrow', 'debt_in', 'opening']);
const TYPE_MINUS = new Set(['expense', 'repay', 'cc_spend', 'atm', 'debt_out']);

export async function onRequest(context) {
  const db = context.env.DB;
  const now = new Date();

  try {
    const [
      configRes,
      payslipRes,
      componentsRes,
      accountsRes,
      transactionsRes,
      billsRes,
      debtsRes,
      reconciliationRes
    ] = await Promise.all([
      readFirst(db, `SELECT * FROM salary_forecast_config WHERE id = ?`, [DEFAULT_SALARY_ID]),
      readFirst(db, `SELECT * FROM salary_payslips WHERE id = 'payslip_2026_04'`, []),
      readAll(db, `SELECT * FROM salary_payslip_components WHERE payslip_id = 'payslip_2026_04'`, []),
      readAll(db, `SELECT * FROM accounts`, []),
      readAll(db, `SELECT * FROM transactions`, []),
      readAll(db, `SELECT * FROM bills`, []),
      readAll(db, `SELECT * FROM debts`, []),
      readAll(db, `SELECT * FROM reconciliation ORDER BY declared_at DESC`, [])
    ]);

    const config = configRes.row || {};
    const payslip = payslipRes.row || {};
    const components = componentsRes.rows || [];
    const accounts = activeAccounts(accountsRes.rows || []);
    const transactions = activeTransactions(transactionsRes.rows || []);
    const bills = visibleBills(billsRes.rows || []);
    const debts = activeDebts(debtsRes.rows || []);
    const reconciliation = reconciliationRes.rows || [];

    const fx = await fetchUsdPkr(config.fx_source_url || DEFAULT_FX_URL);

    const salary = computeSalaryForecast(config, payslip, components, fx, now);
    const balances = computeAccountBalances(accounts, transactions);
    const position = computeCurrentPosition(accounts, balances);
    const truth = computeReconciliationTruth(accounts, balances, reconciliation, transactions);

    const obligations = computeObligationsBeforeSalary({
      bills,
      debts,
      salaryDate: salary.next_salary_date,
      now
    });

    const baseline = computeBaselineForecast({
      salary,
      position,
      obligations
    });

    const confidence = computeForecastConfidence(truth);

    return json({
      ok: true,
      version: VERSION,
      computed_at: now.toISOString(),
      salary,
      current_position: position,
      obligations_before_salary: obligations,
      baseline_forecast: baseline,
      scenarios: {
        confirmed_variable: {
          amount: round2(salary.confirmed_variable_pkr),
          projected_cash_after_salary: round2(baseline.projected_cash_after_salary + salary.confirmed_variable_pkr),
          note: 'Only manually confirmed variable income belongs here.'
        },
        speculative_variable: {
          amount: round2(salary.speculative_variable_pkr),
          projected_cash_after_salary: round2(baseline.projected_cash_after_salary + salary.speculative_variable_pkr),
          note: 'Scenario only. Excluded from baseline safety math.'
        },
        mbo_possible: {
          status: salary.mbo_forecast_status || 'excluded_from_baseline',
          note: 'MBO depends on KPI achievement and payout timing after quarter end. It is not baseline cash safety.'
        }
      },
      tax: {
        annual_taxable_income: number(payslip.annual_taxable_income),
        annual_tax_liability: number(payslip.annual_tax_liability),
        income_tax_paid_ytd: number(payslip.income_tax_paid_ytd),
        remaining_tax_payable: number(payslip.remaining_tax_payable),
        tax_rate_percent: number(payslip.tax_rate_percent)
      },
      forecast_confidence: confidence,
      health: {
        salary_config: configRes.ok,
        payslip: payslipRes.ok,
        components: componentsRes.ok,
        accounts: accountsRes.ok,
        transactions: transactionsRes.ok,
        bills: billsRes.ok,
        debts: debtsRes.ok,
        reconciliation: reconciliationRes.ok,
        fx: fx.ok
      }
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

async function readAll(db, sql, binds) {
  try {
    const stmt = db.prepare(sql);
    const res = binds && binds.length ? await stmt.bind(...binds).all() : await stmt.all();
    return { ok: true, rows: res.results || [], error: null };
  } catch (err) {
    return { ok: false, rows: [], error: err.message || String(err) };
  }
}

async function readFirst(db, sql, binds) {
  try {
    const stmt = db.prepare(sql);
    const row = binds && binds.length ? await stmt.bind(...binds).first() : await stmt.first();
    return { ok: true, row: row || null, error: null };
  } catch (err) {
    return { ok: false, row: null, error: err.message || String(err) };
  }
}

async function fetchUsdPkr(url) {
  try {
    const res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: false } });
    if (!res.ok) throw new Error('FX HTTP ' + res.status);

    const data = await res.json();
    const rate = data && data.rates ? Number(data.rates.PKR) : null;

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('PKR rate missing');
    }

    return {
      ok: true,
      source_name: 'ExchangeRate-API open endpoint',
      source_url: url,
      usd_pkr: rate,
      fetched_at: new Date().toISOString(),
      provider_time_last_update_utc: data.time_last_update_utc || null,
      provider_time_next_update_utc: data.time_next_update_utc || null,
      status: 'live'
    };
  } catch (err) {
    return {
      ok: false,
      source_name: 'ExchangeRate-API open endpoint',
      source_url: url,
      usd_pkr: null,
      fetched_at: new Date().toISOString(),
      status: 'unavailable',
      error: err.message || String(err)
    };
  }
}

function computeSalaryForecast(config, payslip, components, fx, now) {
  const guaranteedBase = number(config.guaranteed_base_salary || config.base_salary);
  const wfhUsd = number(config.wfh_usd_amount || 30);
  const liveFxRate = fx.ok ? number(fx.usd_pkr) : null;
  const storedFxRate = numberOrNull(config.salary_day_fx_rate);
  const fxRateUsed = liveFxRate || storedFxRate;

  const expectedWfhPkr = fxRateUsed ? round2(wfhUsd * fxRateUsed) : null;
  const baseline = round2(guaranteedBase + (expectedWfhPkr || 0));
  const nextSalaryDate = normalizeDate(config.next_salary_date) || nextDayOfMonth(number(config.salary_day || 1), now);

  const baselineComponents = components
    .filter(row => text(row.forecast_class) === 'baseline_component')
    .map(row => ({
      name: row.component_name,
      amount: number(row.amount),
      ytd_amount: number(row.ytd_amount)
    }));

  const variableComponents = components
    .filter(row => String(row.forecast_class || '').includes('variable'))
    .map(row => ({
      name: row.component_name,
      amount: number(row.amount),
      ytd_amount: number(row.ytd_amount),
      forecast_class: row.forecast_class
    }));

  return {
    next_salary_date: nextSalaryDate,
    days_until_salary: daysUntil(now, nextSalaryDate),
    last_salary_received_date: normalizeDate(config.last_salary_received_date),
    salary_day: number(config.salary_day || 1),

    guaranteed_base_salary: round2(guaranteedBase),
    wfh_usd_amount: round2(wfhUsd),
    salary_day_fx_rate: fxRateUsed,
    fx_rate_source: fx.source_name,
    fx_source_url: fx.source_url,
    fx_fetched_at: fx.fetched_at,
    fx_status: fx.status,
    fx_error: fx.error || null,

    expected_wfh_pkr: expectedWfhPkr,
    baseline_forecast_pkr: baseline,
    baseline_wfh_pending: !expectedWfhPkr,

    confirmed_variable_pkr: number(config.confirmed_variable_pkr),
    speculative_variable_pkr: number(config.speculative_variable_pkr),
    mbo_forecast_status: config.mbo_forecast_status || 'excluded_from_baseline',
    forecast_policy: config.forecast_policy || null,

    active_payslip_id: config.active_payslip_id || payslip.id || null,
    payslip_month: payslip.payslip_month || null,
    actual_last_net_salary: number(payslip.actual_net_salary),
    actual_last_gross_salary: number(payslip.actual_gross_salary),
    projected_next_net_salary_from_payslip: number(payslip.projected_next_net_salary),
    projected_following_net_salary_from_payslip: number(payslip.projected_following_net_salary),

    baseline_components: baselineComponents,
    variable_components_last_payslip: variableComponents
  };
}

function computeCurrentPosition(accounts, balances) {
  let totalLiquid = 0;
  let ccOutstanding = 0;
  let assetCount = 0;
  let liabilityCount = 0;

  for (const account of accounts) {
    const bal = balances[account.id] || 0;
    const kind = text(account.kind || account.type).toLowerCase();

    if (isCreditCardKind(kind)) {
      ccOutstanding += Math.max(0, Math.abs(bal));
      liabilityCount++;
    } else if (kind !== 'liability') {
      totalLiquid += bal;
      assetCount++;
    }
  }

  return {
    total_liquid: round2(totalLiquid),
    cc_outstanding: round2(ccOutstanding),
    net_cash_after_cc: round2(totalLiquid - ccOutstanding),
    active_asset_accounts: assetCount,
    active_liability_accounts: liabilityCount
  };
}

function computeObligationsBeforeSalary({ bills, debts, salaryDate, now }) {
  const salaryDay = parseDate(salaryDate);
  const billsDue = [];
  const debtsDue = [];
  const receivablesDue = [];

  for (const bill of bills) {
    const due = billDueDate(bill, now);
    if (!due || !isOnOrBefore(due, salaryDay)) continue;
    if (isPaidThisMonth(bill)) continue;

    billsDue.push({
      id: bill.id,
      name: bill.name,
      amount: round2(number(bill.amount)),
      due_date: dateOnly(due),
      days_until_due: daysUntil(now, dateOnly(due)),
      default_account_id: bill.default_account_id || null
    });
  }

  for (const debt of debts) {
    const remaining = remainingDebtAmount(debt);
    if (remaining <= 0) continue;

    const due = debtDueDate(debt, now);
    if (!due || !isOnOrBefore(due, salaryDay)) continue;

    const row = {
      id: debt.id,
      name: debt.name,
      kind: normalizeDebtKind(debt.kind),
      remaining_amount: round2(remaining),
      installment_amount: nullableRound2(debt.installment_amount),
      due_date: dateOnly(due),
      days_until_due: daysUntil(now, dateOnly(due))
    };

    if (row.kind === 'owed') {
      receivablesDue.push(row);
    } else {
      debtsDue.push(row);
    }
  }

  const billTotal = billsDue.reduce((sum, row) => sum + number(row.amount), 0);
  const debtTotal = debtsDue.reduce((sum, row) => sum + number(row.installment_amount || row.remaining_amount), 0);
  const receivableTotal = receivablesDue.reduce((sum, row) => sum + number(row.installment_amount || row.remaining_amount), 0);

  return {
    salary_cutoff_date: salaryDate,
    bills_due: billsDue,
    debts_due: debtsDue,
    receivables_due: receivablesDue,
    total_bills_due_before_salary: round2(billTotal),
    total_debts_due_before_salary: round2(debtTotal),
    total_receivables_expected_before_salary: round2(receivableTotal),
    total_committed_before_salary: round2(billTotal + debtTotal),
    net_expected_before_salary: round2(receivableTotal - billTotal - debtTotal)
  };
}

function computeBaselineForecast({ salary, position, obligations }) {
  const beforeSalary = round2(position.total_liquid + obligations.net_expected_before_salary);
  const afterSalary = round2(beforeSalary + salary.baseline_forecast_pkr);
  const freeAfterObligations = round2(salary.baseline_forecast_pkr - obligations.total_committed_before_salary);

  let firstUnsafeDate = null;
  let topAction = null;

  if (beforeSalary < DEFAULT_LOW_LIQUID_UNSAFE) {
    firstUnsafeDate = new Date().toISOString().slice(0, 10);
    topAction = 'Liquid cash falls below unsafe threshold before salary. Review bills/debts due before salary.';
  } else if (beforeSalary < DEFAULT_LOW_LIQUID_WATCH) {
    topAction = 'Liquid cash is thin before salary. Avoid non-essential spending.';
  }

  return {
    projected_cash_before_salary: beforeSalary,
    projected_cash_after_salary: afterSalary,
    free_salary_after_obligations: freeAfterObligations,
    salary_already_committed: round2(obligations.total_committed_before_salary),
    first_unsafe_date: firstUnsafeDate,
    top_action: topAction,
    runway_status: beforeSalary < DEFAULT_LOW_LIQUID_UNSAFE
      ? 'unsafe_before_salary'
      : beforeSalary < DEFAULT_LOW_LIQUID_WATCH
        ? 'watch_before_salary'
        : 'safe_until_salary'
  };
}

function computeReconciliationTruth(accounts, balances, rows, transactions) {
  const latest = latestReconByAccount(rows);
  const latestTxn = latestTxnDateByAccount(accounts, transactions);
  const out = [];
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

    let status = 'undeclared';
    if (!declaration) {
      undeclared++;
    } else if (latestTransactionDate && declaredDate && latestTransactionDate > declaredDate) {
      status = 'stale';
      stale++;
    } else if (Math.abs(number(drift)) >= 1) {
      status = 'drifted';
      drifted++;
    } else {
      status = 'matched';
      matched++;
    }

    out.push({
      account_id: account.id,
      account_name: account.name || account.id,
      app_balance: round2(appBalance),
      declared_balance: declaration ? round2(declared) : null,
      drift_amount: drift,
      latest_transaction_date: latestTransactionDate,
      declared_at: declaration ? declaration.declared_at : null,
      truth_status: status
    });
  }

  return {
    matched_count: matched,
    stale_count: stale,
    drifted_count: drifted,
    undeclared_count: undeclared,
    accounts: out
  };
}

function computeForecastConfidence(truth) {
  if (truth.drifted_count > 0) {
    return {
      level: 'low',
      reason: 'One or more accounts are drifted. Forecast starting balance may be wrong.'
    };
  }

  if (truth.undeclared_count > 0) {
    return {
      level: 'medium_low',
      reason: 'Some accounts are undeclared. Forecast is usable but not fully reconciled.'
    };
  }

  if (truth.stale_count > 0) {
    return {
      level: 'medium',
      reason: 'Some declarations are stale because transactions happened after declaration.'
    };
  }

  return {
    level: 'high',
    reason: 'All declared accounts are matched at the current cutoff.'
  };
}

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

    if (TYPE_PLUS.has(type)) {
      balances[origin] += amount;
    } else if (TYPE_MINUS.has(type)) {
      balances[origin] -= amount + fee + pra;
    }
  }

  const out = {};
  for (const id of Object.keys(balances)) out[id] = round2(balances[id]);
  return out;
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

function billDueDate(bill, now) {
  if (bill.due_date) return parseDate(bill.due_date);
  const day = number(bill.due_day);
  if (!day || day < 1 || day > 31) return null;
  return nextDayOfMonth(day, now);
}

function debtDueDate(debt, now) {
  if (debt.due_date) return parseDate(debt.due_date);
  const day = number(debt.due_day);
  if (!day || day < 1 || day > 31) return null;
  return nextDayOfMonth(day, now);
}

function isPaidThisMonth(bill) {
  const last = normalizeDate(bill.last_paid_date);
  if (!last) return false;
  return last.slice(0, 7) === new Date().toISOString().slice(0, 7);
}

function nextDayOfMonth(day, now) {
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), day);
  if (candidate < today) candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, max)));
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
  if (notes.includes('[REVERSAL OF ')) return true;
  if (notes.includes('[REVERSED BY ')) return true;
  return false;
}

function isOnOrBefore(date, cutoff) {
  if (!date || !cutoff) return false;
  return startOfDay(date).getTime() <= startOfDay(cutoff).getTime();
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

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysUntil(now, dateText) {
  const d = parseDate(dateText);
  if (!d) return null;
  return Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400000);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableRound2(value) {
  const n = numberOrNull(value);
  return n == null ? null : round2(n);
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}
