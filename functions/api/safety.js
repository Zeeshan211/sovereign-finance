/* Sovereign Finance /api/safety v0.2.0
 * Layer 5A - Safety Engine v2
 *
 * Purpose:
 * - Answer: Am I safe, why, next risk date, what happens if no action, and top action.
 *
 * Contract:
 * - GET /api/safety
 * - Read-only.
 * - No schema mutation.
 * - No ledger mutation.
 * - No audit writes.
 * - No fake values.
 *
 * Safety truth:
 * - Uses conservative forecast baseline only.
 * - Manual MBO/overtime/referral/bonus/kitty/other variables are scenario-only.
 * - Safety status never depends on manual variable income.
 */

import { json } from './_lib.js';

const VERSION = 'v0.2.0';

const LOW_LIQUID_UNSAFE = 5000;
const LOW_LIQUID_WATCH = 10000;
const OBLIGATION_PRESSURE_UNSAFE = 0.75;
const OBLIGATION_PRESSURE_WATCH = 0.5;
const CC_PRESSURE_UNSAFE = 0.75;
const CC_PRESSURE_WATCH = 0.4;
const BILL_DUE_WATCH_DAYS = 3;
const DEBT_DUE_WATCH_DAYS = 3;
const RECON_DRIFT_THRESHOLD = 1;

const TYPE_PLUS = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

export async function onRequest(context) {
  const db = context.env.DB;
  const now = new Date();

  try {
    const [forecastRes, accountsRes, txnsRes, billsRes, debtsRes, reconRes] = await Promise.all([
      readForecast(context),
      readTable(db, 'accounts'),
      readTable(db, 'transactions'),
      readTable(db, 'bills'),
      readTable(db, 'debts'),
      readTable(db, 'reconciliation')
    ]);

    const accounts = activeAccounts(accountsRes.rows);
    const transactions = activeTransactions(txnsRes.rows);
    const bills = visibleBills(billsRes.rows);
    const debts = activeDebts(debtsRes.rows);
    const reconciliation = reconRes.rows || [];

    const balances = computeAccountBalances(accounts, transactions);
    const position = computeCurrentPosition(accounts, balances);
    const reconciliationTruth = computeReconciliationTruth(accounts, balances, reconciliation, transactions);
    const forecast = forecastRes.data || null;

    const drivers = [];
    const actions = [];

    evaluateForecastSafety(drivers, actions, forecast, now);
    evaluateCurrentLiquidity(drivers, actions, position);
    evaluateObligationPressure(drivers, actions, forecast);
    evaluateCreditCardPressure(drivers, actions, forecast, position);
    evaluateReconciliationTruth(drivers, actions, reconciliationTruth);
    evaluateBills(drivers, actions, bills, now);
    evaluateDebts(drivers, actions, debts, now);
    evaluateMissingData(drivers, actions, bills, debts);

    const uniqueDrivers = dedupeDrivers(drivers);
    const uniqueActions = dedupeActions(actions);
    const safetyStatus = computeSafetyStatus(uniqueDrivers);
    const topAction = computeTopAction(safetyStatus, uniqueDrivers, uniqueActions);
    const nextRiskDate = computeNextRiskDate(uniqueDrivers);
    const noAction = computeNoActionOutcome(safetyStatus, uniqueDrivers, forecast);
    const confidence = computeConfidence(forecastRes, reconciliationTruth, accountsRes, txnsRes, billsRes, debtsRes, reconRes);

    return json({
      ok: true,
      version: VERSION,
      computed_at: now.toISOString(),

      safety_status: safetyStatus,
      status: safetyStatus,
      headline: buildHeadline(safetyStatus, uniqueDrivers, position),
      top_action: topAction,
      next_risk_date: nextRiskDate,
      what_happens_if_no_action: noAction,

      manual_variables_used_for_safety: false,
      safety_baseline: {
        mode: 'conservative',
        includes_base_salary: true,
        includes_wfh_live_fx: true,
        excludes_manual_variables: true,
        note: 'Safety uses conservative salary baseline. Manual variables remain scenario-only.'
      },

      drivers: uniqueDrivers,
      reasons: uniqueDrivers,
      actions: uniqueActions,

      forecast_source: {
        ok: forecastRes.ok,
        version: forecast && forecast.version ? forecast.version : null,
        error: forecastRes.error || null,
        cash_projection_summary_present: !!(forecast && forecast.cash_projection_summary),
        daily_projection_present: !!(forecast && Array.isArray(forecast.daily_cash_projection_30d)),
        salary_present: !!(forecast && forecast.salary)
      },

      confidence,

      summary: {
        total_liquid: round2(position.total_liquid),
        cc_outstanding: round2(position.cc_outstanding),
        net_cash_after_cc: round2(position.net_cash_after_cc),
        forecast_lowest_projected_balance: forecast && forecast.cash_projection_summary
          ? nullableRound2(forecast.cash_projection_summary.lowest_projected_balance)
          : null,
        forecast_first_unsafe_date: forecast && forecast.cash_projection_summary
          ? forecast.cash_projection_summary.first_unsafe_date || null
          : null,
        conservative_net_salary: forecast && forecast.salary
          ? nullableRound2(forecast.salary.baseline_net_without_manual_variables_pkr)
          : null,
        manual_variable_total: forecast && forecast.salary
          ? nullableRound2(forecast.salary.manual_variable_total_pkr)
          : null,
        active_bill_count: bills.length,
        active_debt_count: debts.length,
        active_account_count: accounts.length
      },

      thresholds: {
        low_liquid_unsafe: LOW_LIQUID_UNSAFE,
        low_liquid_watch: LOW_LIQUID_WATCH,
        obligation_pressure_unsafe: OBLIGATION_PRESSURE_UNSAFE,
        obligation_pressure_watch: OBLIGATION_PRESSURE_WATCH,
        cc_pressure_unsafe: CC_PRESSURE_UNSAFE,
        cc_pressure_watch: CC_PRESSURE_WATCH,
        bill_due_watch_days: BILL_DUE_WATCH_DAYS,
        debt_due_watch_days: DEBT_DUE_WATCH_DAYS,
        reconciliation_drift_threshold: RECON_DRIFT_THRESHOLD
      },

      health: [
        healthRow('forecast', forecastRes),
        healthRow('accounts', accountsRes),
        healthRow('transactions', txnsRes),
        healthRow('bills', billsRes),
        healthRow('debts', debtsRes),
        healthRow('reconciliation', reconRes)
      ]
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

async function readForecast(context) {
  try {
    const url = new URL(context.request.url);
    url.pathname = '/api/forecast';
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
        table: 'forecast',
        rows: [],
        data: null,
        error: data && data.error ? data.error : `forecast HTTP ${res.status}`
      };
    }

    return {
      ok: true,
      table: 'forecast',
      rows: [data],
      data,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      table: 'forecast',
      rows: [],
      data: null,
      error: err.message || String(err)
    };
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

function evaluateForecastSafety(drivers, actions, forecast, now) {
  if (!forecast || !forecast.cash_projection_summary) {
    pushDriver(drivers, {
      code: 'FORECAST_UNAVAILABLE',
      severity: 'watch',
      title: 'Forecast source is unavailable',
      detail: 'Safety could not read /api/forecast, so 30-day safety is incomplete.',
      source: 'forecast',
      confidence: 'low',
      evidence: {}
    });
    pushAction(actions, {
      reason_code: 'FORECAST_UNAVAILABLE',
      label: 'Verify /api/forecast before trusting safety status',
      module: 'forecast',
      href: '/forecast.html',
      priority: 1
    });
    return;
  }

  const summary = forecast.cash_projection_summary;
  const projectionLow = number(summary.lowest_projected_balance);
  const firstUnsafe = summary.first_unsafe_date || null;
  const firstWatch = summary.first_watch_date || null;
  const salaryDate = forecast.salary ? forecast.salary.next_salary_date : null;
  const cashAfterSalary = nullableNumber(summary.cash_after_salary_and_obligations);

  if (projectionLow < 0) {
    pushDriver(drivers, {
      code: 'PROJECTION_NEGATIVE',
      severity: 'critical',
      title: '30-day projection goes negative',
      detail: `Projected cash falls to ${money(projectionLow)} on ${summary.lowest_projected_balance_date || 'unknown date'}.`,
      next_risk_date: summary.lowest_projected_balance_date || firstUnsafe,
      source: 'forecast',
      confidence: 'high',
      evidence: {
        lowest_projected_balance: round2(projectionLow),
        lowest_projected_balance_date: summary.lowest_projected_balance_date || null,
        salary_date: salaryDate
      }
    });
    pushAction(actions, {
      reason_code: 'PROJECTION_NEGATIVE',
      label: 'Reduce or delay obligations before the lowest-balance date',
      module: 'forecast',
      href: '/forecast.html',
      priority: 1
    });
    return;
  }

  if (firstUnsafe) {
    const beforeSalary = salaryDate ? firstUnsafe <= salaryDate : true;
    pushDriver(drivers, {
      code: 'PROJECTION_UNSAFE',
      severity: beforeSalary ? 'critical' : 'unsafe',
      title: beforeSalary ? 'Cash becomes unsafe before salary' : 'Cash becomes unsafe in the 30-day window',
      detail: `Projected cash falls below ${money(LOW_LIQUID_UNSAFE)} on ${firstUnsafe}.`,
      next_risk_date: firstUnsafe,
      source: 'forecast',
      confidence: 'high',
      evidence: {
        first_unsafe_date: firstUnsafe,
        salary_date: salaryDate,
        lowest_projected_balance: round2(projectionLow),
        lowest_projected_balance_date: summary.lowest_projected_balance_date || null
      }
    });
    pushAction(actions, {
      reason_code: 'PROJECTION_UNSAFE',
      label: 'Open Forecast and fix the first unsafe date',
      module: 'forecast',
      href: '/forecast.html',
      priority: 1
    });
    return;
  }

  if (cashAfterSalary != null && cashAfterSalary < 0) {
    pushDriver(drivers, {
      code: 'NEGATIVE_AFTER_SALARY',
      severity: 'unsafe',
      title: 'Cash after salary and obligations is negative',
      detail: `Cash after salary and known obligations is ${money(cashAfterSalary)}.`,
      next_risk_date: salaryDate,
      source: 'forecast',
      confidence: 'high',
      evidence: {
        cash_after_salary_and_obligations: round2(cashAfterSalary),
        salary_date: salaryDate
      }
    });
    pushAction(actions, {
      reason_code: 'NEGATIVE_AFTER_SALARY',
      label: 'Review obligations that consume salary',
      module: 'forecast',
      href: '/forecast.html',
      priority: 1
    });
  }

  if (firstWatch || projectionLow < LOW_LIQUID_WATCH) {
    pushDriver(drivers, {
      code: 'PROJECTION_WATCH',
      severity: 'watch',
      title: '30-day projection enters watch range',
      detail: `Lowest projected balance is ${money(projectionLow)}.`,
      next_risk_date: firstWatch || summary.lowest_projected_balance_date || null,
      source: 'forecast',
      confidence: 'high',
      evidence: {
        first_watch_date: firstWatch,
        lowest_projected_balance: round2(projectionLow),
        lowest_projected_balance_date: summary.lowest_projected_balance_date || null
      }
    });
    pushAction(actions, {
      reason_code: 'PROJECTION_WATCH',
      label: 'Keep spending tight until salary and obligations clear',
      module: 'forecast',
      href: '/forecast.html',
      priority: 2
    });
  }
}

function evaluateCurrentLiquidity(drivers, actions, position) {
  const liquid = number(position.total_liquid);

  if (liquid < LOW_LIQUID_UNSAFE) {
    pushDriver(drivers, {
      code: 'LOW_LIQUID',
      severity: 'unsafe',
      title: 'Liquid cash is below unsafe threshold',
      detail: `Current liquid cash is ${money(liquid)}, below ${money(LOW_LIQUID_UNSAFE)}.`,
      source: 'accounts',
      confidence: 'high',
      evidence: { total_liquid: round2(liquid), threshold: LOW_LIQUID_UNSAFE }
    });
    pushAction(actions, {
      reason_code: 'LOW_LIQUID',
      label: 'Review cash before any new spending',
      module: 'accounts',
      href: '/accounts.html',
      priority: 1
    });
    return;
  }

  if (liquid < LOW_LIQUID_WATCH) {
    pushDriver(drivers, {
      code: 'LOW_LIQUID',
      severity: 'watch',
      title: 'Liquid cash is thin',
      detail: `Current liquid cash is ${money(liquid)}, below watch threshold ${money(LOW_LIQUID_WATCH)}.`,
      source: 'accounts',
      confidence: 'high',
      evidence: { total_liquid: round2(liquid), threshold: LOW_LIQUID_WATCH }
    });
    pushAction(actions, {
      reason_code: 'LOW_LIQUID',
      label: 'Check upcoming obligations before spending',
      module: 'forecast',
      href: '/forecast.html',
      priority: 2
    });
  }
}

function evaluateObligationPressure(drivers, actions, forecast) {
  if (!forecast || !forecast.salary || !forecast.obligations_before_salary) return;

  const conservativeSalary = number(forecast.salary.baseline_net_without_manual_variables_pkr);
  const committed = number(forecast.obligations_before_salary.total_committed_before_salary);
  if (conservativeSalary <= 0) return;

  const pressure = round4(committed / conservativeSalary);

  if (pressure >= OBLIGATION_PRESSURE_UNSAFE) {
    pushDriver(drivers, {
      code: 'HIGH_OBLIGATION_PRESSURE',
      severity: 'unsafe',
      title: 'Known obligations consume most of conservative salary',
      detail: `Committed obligations before salary equal ${percent(pressure)} of conservative salary.`,
      source: 'forecast',
      confidence: 'high',
      evidence: {
        committed_before_salary: round2(committed),
        conservative_salary: round2(conservativeSalary),
        obligation_pressure_ratio: pressure
      }
    });
    pushAction(actions, {
      reason_code: 'HIGH_OBLIGATION_PRESSURE',
      label: 'Reduce or reschedule obligations before salary',
      module: 'forecast',
      href: '/forecast.html',
      priority: 1
    });
    return;
  }

  if (pressure >= OBLIGATION_PRESSURE_WATCH) {
    pushDriver(drivers, {
      code: 'OBLIGATION_PRESSURE_WATCH',
      severity: 'watch',
      title: 'Obligation pressure is elevated',
      detail: `Committed obligations before salary equal ${percent(pressure)} of conservative salary.`,
      source: 'forecast',
      confidence: 'high',
      evidence: {
        committed_before_salary: round2(committed),
        conservative_salary: round2(conservativeSalary),
        obligation_pressure_ratio: pressure
      }
    });
    pushAction(actions, {
      reason_code: 'OBLIGATION_PRESSURE_WATCH',
      label: 'Review bills and debts due before salary',
      module: 'forecast',
      href: '/forecast.html',
      priority: 2
    });
  }
}

function evaluateCreditCardPressure(drivers, actions, forecast, position) {
  const conservativeSalary = forecast && forecast.salary
    ? number(forecast.salary.baseline_net_without_manual_variables_pkr)
    : 0;

  const ccOutstanding = number(position.cc_outstanding);
  if (ccOutstanding <= 0 || conservativeSalary <= 0) return;

  const pressure = round4(ccOutstanding / conservativeSalary);

  if (pressure >= CC_PRESSURE_UNSAFE) {
    pushDriver(drivers, {
      code: 'CC_PRESSURE_HIGH',
      severity: 'unsafe',
      title: 'Credit Card pressure is high',
      detail: `Credit Card outstanding equals ${percent(pressure)} of conservative salary.`,
      source: 'credit_card',
      confidence: 'high',
      evidence: {
        cc_outstanding: round2(ccOutstanding),
        conservative_salary: round2(conservativeSalary),
        cc_pressure_ratio: pressure
      }
    });
    pushAction(actions, {
      reason_code: 'CC_PRESSURE_HIGH',
      label: 'Open Credit Card planner and reduce outstanding',
      module: 'credit-card',
      href: '/cc.html',
      priority: 1
    });
    return;
  }

  if (pressure >= CC_PRESSURE_WATCH) {
    pushDriver(drivers, {
      code: 'CC_PRESSURE_WATCH',
      severity: 'watch',
      title: 'Credit Card pressure needs attention',
      detail: `Credit Card outstanding equals ${percent(pressure)} of conservative salary.`,
      source: 'credit_card',
      confidence: 'high',
      evidence: {
        cc_outstanding: round2(ccOutstanding),
        conservative_salary: round2(conservativeSalary),
        cc_pressure_ratio: pressure
      }
    });
    pushAction(actions, {
      reason_code: 'CC_PRESSURE_WATCH',
      label: 'Review Credit Card payoff plan',
      module: 'credit-card',
      href: '/cc.html',
      priority: 2
    });
  }
}

function evaluateReconciliationTruth(drivers, actions, truth) {
  if (truth.drifted_count > 0) {
    pushDriver(drivers, {
      code: 'RECONCILIATION_DRIFT',
      severity: 'unsafe',
      title: 'Reconciliation drift weakens safety confidence',
      detail: `${truth.drifted_count} account(s) are drifted.`,
      source: 'reconciliation',
      confidence: 'high',
      evidence: truth
    });
    pushAction(actions, {
      reason_code: 'RECONCILIATION_DRIFT',
      label: 'Open Reconciliation and resolve drift',
      module: 'reconciliation',
      href: '/reconciliation.html',
      priority: 1
    });
    return;
  }

  if (truth.undeclared_count > 0) {
    pushDriver(drivers, {
      code: 'RECONCILIATION_UNDECLARED',
      severity: 'watch',
      title: 'Some accounts are undeclared',
      detail: `${truth.undeclared_count} account(s) have no declared real-world balance.`,
      source: 'reconciliation',
      confidence: 'medium',
      evidence: truth
    });
    pushAction(actions, {
      reason_code: 'RECONCILIATION_UNDECLARED',
      label: 'Declare missing real-world balances',
      module: 'reconciliation',
      href: '/reconciliation.html',
      priority: 2
    });
    return;
  }

  if (truth.stale_count > 0) {
    pushDriver(drivers, {
      code: 'RECONCILIATION_STALE',
      severity: 'watch',
      title: 'Some declarations are stale',
      detail: `${truth.stale_count} account declaration(s) are stale after newer transactions.`,
      source: 'reconciliation',
      confidence: 'medium',
      evidence: truth
    });
    pushAction(actions, {
      reason_code: 'RECONCILIATION_STALE',
      label: 'Refresh stale account declarations',
      module: 'reconciliation',
      href: '/reconciliation.html',
      priority: 2
    });
  }
}

function evaluateBills(drivers, actions, bills, now) {
  for (const bill of bills) {
    const due = billDueDate(bill, now);
    if (!due) continue;
    if (billPaidThisCycle(bill, due)) continue;

    const days = daysBetween(startOfDay(now), due);
    const amount = number(bill.amount);

    if (days < 0) {
      pushDriver(drivers, {
        code: 'BILL_OVERDUE',
        severity: 'unsafe',
        title: `${safeName(bill.name, 'Bill')} is overdue`,
        detail: `${safeName(bill.name, 'Bill')} is overdue by ${Math.abs(days)} day(s).`,
        next_risk_date: dateOnly(due),
        source: 'bills',
        confidence: 'high',
        evidence: {
          bill_id: bill.id || null,
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
      pushDriver(drivers, {
        code: 'BILL_DUE_SOON',
        severity: 'watch',
        title: `${safeName(bill.name, 'Bill')} is due soon`,
        detail: `${safeName(bill.name, 'Bill')} is due in ${days} day(s).`,
        next_risk_date: dateOnly(due),
        source: 'bills',
        confidence: 'high',
        evidence: {
          bill_id: bill.id || null,
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

function evaluateDebts(drivers, actions, debts, now) {
  for (const debt of debts) {
    const remaining = remainingDebtAmount(debt);
    if (remaining <= 0) continue;

    const kind = normalizeDebtKind(debt.kind);
    if (kind === 'owed') continue;

    const due = debtDueDate(debt, now);
    if (!due) continue;

    const days = daysBetween(startOfDay(now), due);
    const amount = number(debt.installment_amount || remaining);

    if (days < 0) {
      pushDriver(drivers, {
        code: 'DEBT_OVERDUE',
        severity: 'unsafe',
        title: `${safeName(debt.name, 'Debt')} is overdue`,
        detail: `${safeName(debt.name, 'Debt')} is overdue by ${Math.abs(days)} day(s).`,
        next_risk_date: dateOnly(due),
        source: 'debts',
        confidence: 'high',
        evidence: {
          debt_id: debt.id || null,
          amount: round2(amount),
          remaining_amount: round2(remaining),
          due_date: dateOnly(due),
          days_overdue: Math.abs(days)
        }
      });
      pushAction(actions, {
        reason_code: 'DEBT_OVERDUE',
        label: `Review overdue payment for ${safeName(debt.name, 'debt')}`,
        module: 'debts',
        href: '/debts.html',
        priority: 1
      });
      continue;
    }

    if (days <= DEBT_DUE_WATCH_DAYS) {
      pushDriver(drivers, {
        code: 'DEBT_DUE_SOON',
        severity: 'watch',
        title: `${safeName(debt.name, 'Debt')} is due soon`,
        detail: `${safeName(debt.name, 'Debt')} is due in ${days} day(s).`,
        next_risk_date: dateOnly(due),
        source: 'debts',
        confidence: 'high',
        evidence: {
          debt_id: debt.id || null,
          amount: round2(amount),
          remaining_amount: round2(remaining),
          due_date: dateOnly(due),
          days_until_due: days
        }
      });
      pushAction(actions, {
        reason_code: 'DEBT_DUE_SOON',
        label: `Plan payment for ${safeName(debt.name, 'debt')}`,
        module: 'debts',
        href: '/debts.html',
        priority: 2
      });
    }
  }
}

function evaluateMissingData(drivers, actions, bills, debts) {
  const billsWithoutAccount = bills.filter(bill => !text(bill.default_account_id));
  if (billsWithoutAccount.length) {
    pushDriver(drivers, {
      code: 'MISSING_BILL_PAYMENT_ACCOUNT',
      severity: 'watch',
      title: 'Some bills have no payment account',
      detail: `${billsWithoutAccount.length} bill(s) need a default payment account for stronger forecast logic.`,
      source: 'bills',
      confidence: 'medium',
      evidence: {
        count: billsWithoutAccount.length,
        missing_field: 'default_account_id'
      }
    });
    pushAction(actions, {
      reason_code: 'MISSING_BILL_PAYMENT_ACCOUNT',
      label: 'Set payment accounts for bills',
      module: 'bills',
      href: '/bills.html',
      priority: 2
    });
  }

  const unscheduledDebts = debts.filter(debt => {
    if (remainingDebtAmount(debt) <= 0) return false;
    if (normalizeDebtKind(debt.kind) === 'owed') return false;
    return !debtDueDate(debt, new Date());
  });

  if (unscheduledDebts.length) {
    pushDriver(drivers, {
      code: 'DEBT_SCHEDULE_MISSING',
      severity: 'watch',
      title: 'Some debts have no due schedule',
      detail: `${unscheduledDebts.length} active payable debt(s) need due_date or due_day.`,
      source: 'debts',
      confidence: 'medium',
      evidence: {
        count: unscheduledDebts.length,
        missing_field: 'due_date_or_due_day'
      }
    });
    pushAction(actions, {
      reason_code: 'DEBT_SCHEDULE_MISSING',
      label: 'Add due schedules for active debts',
      module: 'debts',
      href: '/debts.html',
      priority: 2
    });
  }
}

function computeSafetyStatus(drivers) {
  if (drivers.some(driver => driver.severity === 'critical')) return 'critical';
  if (drivers.some(driver => driver.severity === 'unsafe')) return 'unsafe';
  if (drivers.some(driver => driver.severity === 'watch')) return 'watch';
  return 'safe';
}

function computeTopAction(status, drivers, actions) {
  if (!actions.length) {
    if (status === 'safe') return 'No immediate action required. Keep the forecast and reconciliation current.';
    return 'Open Forecast and review the top safety driver.';
  }

  const first = actions.slice().sort((a, b) => (a.priority || 9) - (b.priority || 9))[0];
  return first.label;
}

function computeNextRiskDate(drivers) {
  const dates = drivers
    .map(driver => driver.next_risk_date)
    .filter(Boolean)
    .sort();

  return dates.length ? dates[0] : null;
}

function computeNoActionOutcome(status, drivers, forecast) {
  const first = drivers[0] || null;

  if (status === 'critical') {
    return first
      ? `If no action is taken, ${first.title.toLowerCase()} remains the immediate risk.`
      : 'If no action is taken, the critical cash risk remains unresolved.';
  }

  if (status === 'unsafe') {
    return first
      ? `If no action is taken, ${first.title.toLowerCase()} can affect cash safety before the next stable point.`
      : 'If no action is taken, the unsafe condition remains active.';
  }

  if (status === 'watch') {
    return first
      ? `If no action is taken, ${first.title.toLowerCase()} may become unsafe if cash movement worsens.`
      : 'If no action is taken, watch items should still be reviewed before they become urgent.';
  }

  const summary = forecast && forecast.cash_projection_summary ? forecast.cash_projection_summary : null;
  if (summary && summary.lowest_projected_balance != null) {
    return `If no action is taken, the conservative 30-day projection still stays above the watch threshold. Lowest projected balance is ${money(summary.lowest_projected_balance)}.`;
  }

  return 'If no action is taken, no immediate safety break is detected from available data.';
}

function buildHeadline(status, drivers, position) {
  if (status === 'safe') {
    return `Safe right now. Liquid cash is ${money(position.total_liquid)} and no urgent 30-day risk was detected.`;
  }

  const first = drivers[0];
  if (!first) return 'Safety status computed.';

  if (status === 'critical') return `Critical: ${first.title}.`;
  if (status === 'unsafe') return `Unsafe: ${first.title}.`;
  return `Watch: ${first.title}.`;
}

function computeConfidence(forecastRes, truth, accountsRes, txnsRes, billsRes, debtsRes, reconRes) {
  const blockers = [];

  if (!forecastRes.ok) blockers.push('forecast_unavailable');
  if (!accountsRes.ok) blockers.push('accounts_unavailable');
  if (!txnsRes.ok) blockers.push('transactions_unavailable');
  if (!billsRes.ok) blockers.push('bills_unavailable');
  if (!debtsRes.ok) blockers.push('debts_unavailable');
  if (!reconRes.ok) blockers.push('reconciliation_unavailable');
  if (truth.drifted_count > 0) blockers.push('reconciliation_drift');
  if (truth.undeclared_count > 0) blockers.push('undeclared_accounts');
  if (truth.stale_count > 0) blockers.push('stale_declarations');

  let level = 'high';
  if (blockers.includes('forecast_unavailable') || blockers.includes('accounts_unavailable') || blockers.includes('transactions_unavailable') || blockers.includes('reconciliation_drift')) {
    level = 'low';
  } else if (blockers.length) {
    level = 'medium';
  }

  return {
    level,
    blockers,
    reconciliation: truth,
    reason: blockers.length
      ? `Confidence reduced by: ${blockers.join(', ')}.`
      : 'Forecast, ledger reads, and reconciliation checks are available.'
  };
}

function healthRow(name, res) {
  return {
    source: name,
    ok: !!res.ok,
    row_count: res.rows ? res.rows.length : 0,
    error: res.error || null
  };
}

function activeAccounts(rows) {
  return (rows || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !text(row.deleted_at) && !text(row.archived_at) && (!status || status === 'active');
  });
}

function activeTransactions(rows) {
  return (rows || []).filter(row => !isReversalRow(row));
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

function isReversalRow(row) {
  if (!row) return false;
  if (row.reversed_by || row.reversed_at) return true;

  const notes = text(row.notes).toUpperCase();
  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function computeAccountBalances(accounts, transactions) {
  const balances = {};
  const ids = new Set();

  for (const account of accounts) {
    balances[account.id] = number(account.opening_balance);
    ids.add(account.id);
  }

  for (const txn of transactions) {
    const amount = number(txn.amount);
    const fee = number(txn.fee_amount);
    const pra = number(txn.pra_amount);
    const accountId = text(txn.account_id);
    const toAccountId = text(txn.transfer_to_account_id);
    const type = text(txn.type).toLowerCase();

    if (type === 'transfer' || type === 'cc_payment') {
      if (accountId && ids.has(accountId)) balances[accountId] -= amount + fee + pra;
      if (toAccountId && ids.has(toAccountId)) balances[toAccountId] += amount;
      continue;
    }

    if (!accountId || !ids.has(accountId)) continue;

    if (TYPE_PLUS.has(type)) balances[accountId] += amount;
    else if (TYPE_MINUS.has(type)) balances[accountId] -= amount + fee + pra;
  }

  const out = {};
  for (const id of Object.keys(balances)) out[id] = round2(balances[id]);
  return out;
}

function computeCurrentPosition(accounts, balances) {
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

function computeReconciliationTruth(accounts, balances, rows, transactions) {
  const latest = latestReconByAccount(rows);
  const latestTxn = latestTxnDateByAccount(accounts, transactions);

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

    if (!declaration) undeclared++;
    else if (latestTransactionDate && declaredDate && latestTransactionDate > declaredDate) stale++;
    else if (Math.abs(number(drift)) >= RECON_DRIFT_THRESHOLD) drifted++;
    else matched++;
  }

  return {
    matched_count: matched,
    stale_count: stale,
    drifted_count: drifted,
    undeclared_count: undeclared
  };
}

function latestReconByAccount(rows) {
  const sorted = (rows || []).slice().sort((a, b) => text(b.declared_at).localeCompare(text(a.declared_at)));
  const out = {};

  for (const row of sorted) {
    const accountId = text(row.account_id);
    if (accountId && !out[accountId]) out[accountId] = row;
  }

  return out;
}

function latestTxnDateByAccount(accounts, transactions) {
  const ids = new Set(accounts.map(account => account.id));
  const out = {};

  for (const account of accounts) out[account.id] = null;

  for (const txn of transactions) {
    const date = normalizeDate(txn.date);
    if (!date) continue;

    const accountId = text(txn.account_id);
    const toAccountId = text(txn.transfer_to_account_id);

    if (accountId && ids.has(accountId) && (!out[accountId] || date > out[accountId])) out[accountId] = date;
    if (toAccountId && ids.has(toAccountId) && (!out[toAccountId] || date > out[toAccountId])) out[toAccountId] = date;
  }

  return out;
}

function billDueDate(bill, now) {
  if (bill.due_date) return parseDate(bill.due_date);

  const day = normalizeDueDay(bill.due_day);
  if (day == null) return null;

  return nextDayOfMonth(day, now);
}

function debtDueDate(debt, now) {
  if (debt.due_date) return parseDate(debt.due_date);

  const day = normalizeDueDay(debt.due_day);
  if (day == null) return null;

  return nextDayOfMonth(day, now);
}

function billPaidThisCycle(bill, dueDate) {
  const lastPaid = parseDate(bill.last_paid_date);
  if (!lastPaid) return false;

  return (
    lastPaid.getUTCFullYear() === dueDate.getUTCFullYear() &&
    lastPaid.getUTCMonth() === dueDate.getUTCMonth()
  );
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

function pushDriver(drivers, driver) {
  drivers.push({
    code: driver.code,
    severity: driver.severity || 'watch',
    title: driver.title,
    detail: driver.detail,
    source: driver.source || 'computed',
    confidence: driver.confidence || 'medium',
    evidence: driver.evidence || {},
    next_risk_date: driver.next_risk_date || null
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

function dedupeDrivers(drivers) {
  const seen = new Set();
  const out = [];

  for (const driver of drivers) {
    const key = [
      driver.code,
      driver.severity,
      driver.title,
      driver.next_risk_date || ''
    ].join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(driver);
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

function severityRank(severity) {
  if (severity === 'critical') return 0;
  if (severity === 'unsafe') return 1;
  if (severity === 'watch') return 2;
  return 3;
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

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableRound2(value) {
  const n = nullableNumber(value);
  return n == null ? null : round2(n);
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

function percent(value) {
  return `${Math.round(number(value) * 1000) / 10}%`;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function safeName(value, fallback) {
  return text(value) || fallback;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function money(value) {
  const n = number(value);
  const sign = n < 0 ? '-' : '';
  return sign + 'Rs ' + Math.abs(round2(n)).toLocaleString('en-PK', {
    maximumFractionDigits: 2
  });
}
