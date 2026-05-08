/* Sovereign Finance /api/forecast v0.2.1
 * Live salary + 30-day cash forecast with manual variable income and PK salaried tax formula.
 *
 * GET  /api/forecast
 * POST /api/forecast
 *
 * POST is metadata-only:
 * - updates manual variable forecast inputs
 * - no ledger mutation
 * - no transaction creation
 *
 * v0.2.1 audit hardening:
 * - removes fixed SQL dependency on payslip_2026_04
 * - reads active payslip from salary_forecast_config.active_payslip_id when available
 * - falls back safely to payslip_2026_04 only when config has no active payslip id
 * - exposes active_payslip_source for audit clarity
 * - fixes bill paid-cycle logic so current-month payment does not skip next-month obligations
 *
 * Forecast rules:
 * - conservative baseline uses guaranteed base salary + WFH only
 * - manual variable income remains separate scenario input
 * - MBO/kitty/overtime/manual variable values are not baseline safety income
 */

import { json } from './_lib.js';

const VERSION = 'v0.2.1';
const DEFAULT_SALARY_ID = 'salary_primary';
const FALLBACK_PAYSLIP_ID = 'payslip_2026_04';
const DEFAULT_FX_URL = 'https://open.er-api.com/v6/latest/USD';

const LOW_LIQUID_UNSAFE = 5000;
const LOW_LIQUID_WATCH = 10000;
const PROJECTION_DAYS = 30;

const TYPE_PLUS = new Set(['income', 'salary', 'borrow', 'debt_in', 'opening']);
const TYPE_MINUS = new Set(['expense', 'repay', 'cc_spend', 'atm', 'debt_out']);

export async function onRequest(context) {
  if (context.request.method === 'POST') return updateManualVariables(context);
  return getForecast(context);
}

async function updateManualVariables(context) {
  const db = context.env.DB;
  const body = await context.request.json().catch(() => ({}));

  const fields = {
    manual_overtime_general_pkr: moneyInput(body.manual_overtime_general_pkr),
    manual_overtime_eid_pkr: moneyInput(body.manual_overtime_eid_pkr),
    manual_mbo_pkr: moneyInput(body.manual_mbo_pkr),
    manual_referral_bonus_pkr: moneyInput(body.manual_referral_bonus_pkr),
    manual_spot_bonus_pkr: moneyInput(body.manual_spot_bonus_pkr),
    manual_kitty_cash_pkr: moneyInput(body.manual_kitty_cash_pkr),
    manual_other_variable_pkr: moneyInput(body.manual_other_variable_pkr),
    manual_eobi_pkr: moneyInput(body.manual_eobi_pkr, 400)
  };

  await db.prepare(`
    UPDATE salary_forecast_config
    SET
      manual_overtime_general_pkr = ?,
      manual_overtime_eid_pkr = ?,
      manual_mbo_pkr = ?,
      manual_referral_bonus_pkr = ?,
      manual_spot_bonus_pkr = ?,
      manual_kitty_cash_pkr = ?,
      manual_other_variable_pkr = ?,
      manual_eobi_pkr = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    fields.manual_overtime_general_pkr,
    fields.manual_overtime_eid_pkr,
    fields.manual_mbo_pkr,
    fields.manual_referral_bonus_pkr,
    fields.manual_spot_bonus_pkr,
    fields.manual_kitty_cash_pkr,
    fields.manual_other_variable_pkr,
    fields.manual_eobi_pkr,
    DEFAULT_SALARY_ID
  ).run();

  return json({
    ok: true,
    version: VERSION,
    mode: 'manual_variable_update',
    transaction_created: false,
    ledger_mutation: false,
    fields
  });
}

async function getForecast(context) {
  const db = context.env.DB;
  const now = new Date();

  try {
    const configRes = await readFirst(
      db,
      `SELECT * FROM salary_forecast_config WHERE id = ?`,
      [DEFAULT_SALARY_ID]
    );

    const config = configRes.row || {};
    const activePayslip = resolveActivePayslip(config);

    const [
      payslipRes,
      componentsRes,
      accountsRes,
      transactionsRes,
      billsRes,
      debtsRes,
      reconciliationRes
    ] = await Promise.all([
      readFirst(db, `SELECT * FROM salary_payslips WHERE id = ?`, [activePayslip.id]),
      readAll(db, `SELECT * FROM salary_payslip_components WHERE payslip_id = ?`, [activePayslip.id]),
      readAll(db, `SELECT * FROM accounts`, []),
      readAll(db, `SELECT * FROM transactions`, []),
      readAll(db, `SELECT * FROM bills`, []),
      readAll(db, `SELECT * FROM debts`, []),
      readAll(db, `SELECT * FROM reconciliation ORDER BY declared_at DESC`, [])
    ]);

    const payslip = payslipRes.row || {};
    const components = componentsRes.rows || [];
    const accounts = activeAccounts(accountsRes.rows || []);
    const transactions = activeTransactions(transactionsRes.rows || []);
    const bills = visibleBills(billsRes.rows || []);
    const debts = activeDebts(debtsRes.rows || []);
    const reconciliation = reconciliationRes.rows || [];

    const fx = await fetchUsdPkr(config.fx_source_url || DEFAULT_FX_URL);
    const salary = computeSalary(config, payslip, components, fx, now, activePayslip);
    const balances = computeAccountBalances(accounts, transactions);
    const position = computeCurrentPosition(accounts, balances);

    const obligations = computeObligationsBeforeSalary({
      bills,
      debts,
      salaryDate: salary.next_salary_date,
      now
    });

    const truth = computeReconciliationTruth(accounts, balances, reconciliation, transactions);

    const baseline = computeBaselineForecast({
      salary,
      position,
      obligations,
      now
    });

    const dailyProjection = computeDailyCashProjection30d({
      now,
      salary,
      position,
      bills,
      debts
    });

    const confidence = computeForecastConfidence(truth);

    const debtFree = computeDebtFreeForecast({
      debts,
      baseline,
      salary,
      dailyProjection
    });

    return json({
      ok: true,
      version: VERSION,
      computed_at: now.toISOString(),
      forecast_meta: {
        active_payslip_id: activePayslip.id,
        active_payslip_source: activePayslip.source,
        salary_config_id: DEFAULT_SALARY_ID,
        hardcoded_payslip_removed: true,
        bill_paid_cycle_logic: 'due_cycle_month',
        ledger_mutation: false
      },
      salary,
      current_position: position,
      obligations_before_salary: obligations,
      baseline_forecast: baseline,
      daily_cash_projection_30d: dailyProjection.days,
      cash_projection_summary: dailyProjection.summary,
      debt_free_forecast: debtFree,
      scenarios: {
        confirmed_variable: {
          amount: round2(salary.manual_variable_total_pkr),
          projected_cash_after_salary: round2(baseline.projected_cash_after_salary),
          projected_cash_after_salary_with_manual_variables: round2(dailyProjection.summary.cash_after_salary_and_obligations_with_manual_variables),
          note: 'Manual variable fields are included in scenario forecast net salary but are visible separately from conservative baseline.'
        },
        conservative_baseline: {
          forecast_net_salary: round2(salary.baseline_net_without_manual_variables_pkr),
          projection_mode: 'base_salary_plus_wfh_only',
          manual_variables_included: false,
          projected_cash_after_salary_and_obligations: round2(dailyProjection.summary.cash_after_salary_and_obligations)
        },
        baseline_without_manual_variables: {
          forecast_net_salary: round2(salary.baseline_net_without_manual_variables_pkr),
          projected_cash_after_salary: round2(position.total_liquid + obligations.net_expected_before_salary + salary.baseline_net_without_manual_variables_pkr)
        },
        mbo_possible: {
          amount: round2(salary.manual_variables.manual_mbo_pkr),
          status: salary.manual_variables.manual_mbo_pkr > 0 ? 'manually_entered' : 'zero_default',
          note: 'MBO is manual scenario input and should stay 0 unless confirmed or intentionally modeled.'
        }
      },
      tax: salary.tax,
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
      },
      health_detail: {
        salary_config_error: configRes.error || null,
        payslip_error: payslipRes.error || null,
        components_error: componentsRes.error || null,
        accounts_error: accountsRes.error || null,
        transactions_error: transactionsRes.error || null,
        bills_error: billsRes.error || null,
        debts_error: debtsRes.error || null,
        reconciliation_error: reconciliationRes.error || null,
        fx_error: fx.error || null
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

function resolveActivePayslip(config) {
  const configured = text(config.active_payslip_id);

  if (configured) {
    return {
      id: configured,
      source: 'salary_forecast_config.active_payslip_id'
    };
  }

  return {
    id: FALLBACK_PAYSLIP_ID,
    source: 'fallback_default_until_configured'
  };
}

function computeSalary(config, payslip, components, fx, now, activePayslip) {
  const baseSalary = number(config.guaranteed_base_salary || 111333.34);
  const wfhUsd = number(config.wfh_usd_amount || 30);

  const fxRate = fx.ok ? number(fx.usd_pkr) : numberOrNull(config.salary_day_fx_rate);
  const wfhPkr = fxRate ? round2(wfhUsd * fxRate) : 0;

  const manualVariables = {
    manual_overtime_general_pkr: number(config.manual_overtime_general_pkr),
    manual_overtime_eid_pkr: number(config.manual_overtime_eid_pkr),
    manual_mbo_pkr: number(config.manual_mbo_pkr),
    manual_referral_bonus_pkr: number(config.manual_referral_bonus_pkr),
    manual_spot_bonus_pkr: number(config.manual_spot_bonus_pkr),
    manual_kitty_cash_pkr: number(config.manual_kitty_cash_pkr),
    manual_other_variable_pkr: number(config.manual_other_variable_pkr)
  };

  const manualVariableTotal = Object.values(manualVariables).reduce((sum, val) => sum + number(val), 0);
  const eobi = number(config.manual_eobi_pkr || 400);

  const payslipAnnualTaxable = number(payslip.annual_taxable_income);
  const payslipAnnualTax = number(payslip.annual_tax_liability);
  const incomeTaxPaidYtd = number(payslip.income_tax_paid_ytd);
  const remainingTaxPayable = number(payslip.remaining_tax_payable);

  const baseIncomeTax = projectedBaseIncomeTax(payslip);

  const taxableVariableThisMonth = round2(wfhPkr + manualVariableTotal);
  const annualTaxableWithVariables = round2(payslipAnnualTaxable + taxableVariableThisMonth);
  const annualTaxWithVariables = calculatePkSalariedTax(annualTaxableWithVariables);
  const variableIncomeTax = round2(Math.max(0, annualTaxWithVariables - payslipAnnualTax));

  const grossForecast = round2(baseSalary + wfhPkr + manualVariableTotal);
  const forecastNet = round2(grossForecast - eobi - baseIncomeTax - variableIncomeTax);

  const grossWithoutManual = round2(baseSalary + wfhPkr);
  const variableTaxWithoutManual = round2(Math.max(0, calculatePkSalariedTax(payslipAnnualTaxable + wfhPkr) - payslipAnnualTax));
  const netWithoutManual = round2(grossWithoutManual - eobi - baseIncomeTax - variableTaxWithoutManual);

  const nextSalaryDate = normalizeDate(config.next_salary_date) || dateOnly(nextDayOfMonth(number(config.salary_day || 1), now));

  return {
    next_salary_date: nextSalaryDate,
    days_until_salary: daysUntil(now, nextSalaryDate),
    last_salary_received_date: normalizeDate(config.last_salary_received_date),
    salary_day: number(config.salary_day || 1),

    base_salary_pkr: round2(baseSalary),
    wfh_usd_amount: round2(wfhUsd),
    salary_day_fx_rate: fxRate,
    fx_rate_source: fx.source_name,
    fx_source_url: fx.source_url,
    fx_fetched_at: fx.fetched_at,
    fx_status: fx.status,
    fx_error: fx.error || null,
    wfh_taxable_pkr: round2(wfhPkr),

    manual_variables: manualVariables,
    manual_variable_total_pkr: round2(manualVariableTotal),

    gross_salary_forecast_pkr: grossForecast,
    eobi_deduction_pkr: round2(eobi),
    base_income_tax_pkr: round2(baseIncomeTax),
    variable_income_tax_pkr: round2(variableIncomeTax),
    forecast_net_salary_pkr: forecastNet,
    baseline_net_without_manual_variables_pkr: netWithoutManual,
    baseline_includes_wfh: true,
    safety_baseline_note: 'Safety forecast uses base salary plus WFH live FX, with manual variables defaulting to 0 unless operator enters them.',

    active_payslip_id: activePayslip.id,
    active_payslip_source: activePayslip.source,
    payslip_found: !!payslip.id,
    payslip_month: payslip.payslip_month || null,
    actual_last_net_salary: number(payslip.actual_net_salary),
    actual_last_gross_salary: number(payslip.actual_gross_salary),
    projected_next_net_salary_from_payslip: number(payslip.projected_next_net_salary),
    projected_following_net_salary_from_payslip: number(payslip.projected_following_net_salary),

    tax_formula_version: config.tax_formula_version || 'PK_SALARIED_2025_26',
    tax: {
      annual_taxable_income_from_payslip: round2(payslipAnnualTaxable),
      annual_taxable_income_with_forecast_variables: round2(annualTaxableWithVariables),
      annual_tax_liability_from_payslip: round2(payslipAnnualTax),
      annual_tax_liability_with_forecast_variables: round2(annualTaxWithVariables),
      income_tax_paid_ytd: round2(incomeTaxPaidYtd),
      remaining_tax_payable_from_payslip: round2(remainingTaxPayable),
      base_income_tax_pkr: round2(baseIncomeTax),
      variable_income_tax_pkr: round2(variableIncomeTax),
      tax_rate_percent_from_payslip: number(payslip.tax_rate_percent)
    },

    payslip_components: components.map(row => ({
      name: row.component_name,
      type: row.component_type,
      amount: number(row.amount),
      ytd_amount: number(row.ytd_amount),
      forecast_class: row.forecast_class
    }))
  };
}

function calculatePkSalariedTax(annualTaxableIncome) {
  const income = number(annualTaxableIncome);

  if (income <= 600000) return 0;
  if (income <= 1200000) return round2((income - 600000) * 0.01);
  if (income <= 2200000) return round2(6000 + ((income - 1200000) * 0.11));
  if (income <= 3200000) return round2(116000 + ((income - 2200000) * 0.23));
  if (income <= 4100000) return round2(346000 + ((income - 3200000) * 0.30));

  return round2(616000 + ((income - 4100000) * 0.35));
}

function projectedBaseIncomeTax(payslip) {
  const monthlyBase = number(payslip.projected_next_net_salary)
    ? round2(number(payslip.regular_gross_salary) - number(payslip.projected_next_net_salary))
    : 930;

  if (monthlyBase > 0 && monthlyBase < 5000) return monthlyBase;
  return 930;
}

function computeBaselineForecast({ salary, position, obligations, now }) {
  const beforeSalary = round2(position.total_liquid + obligations.net_expected_before_salary);
  const afterSalary = round2(beforeSalary + salary.forecast_net_salary_pkr);
  const afterSalaryConservative = round2(beforeSalary + salary.baseline_net_without_manual_variables_pkr);
  const freeAfterObligations = round2(salary.forecast_net_salary_pkr - obligations.total_committed_before_salary);
  const freeAfterObligationsConservative = round2(salary.baseline_net_without_manual_variables_pkr - obligations.total_committed_before_salary);

  let firstUnsafeDate = null;
  let topAction = null;

  if (beforeSalary < LOW_LIQUID_UNSAFE) {
    firstUnsafeDate = dateOnly(startOfDay(now));
    topAction = 'Liquid cash falls below unsafe threshold before salary. Review obligations due before salary.';
  } else if (beforeSalary < LOW_LIQUID_WATCH) {
    topAction = 'Liquid cash is thin before salary. Avoid non-essential spending.';
  }

  return {
    projected_cash_before_salary: beforeSalary,
    projected_cash_after_salary: afterSalary,
    projected_cash_after_salary_conservative: afterSalaryConservative,
    free_salary_after_obligations: freeAfterObligations,
    free_salary_after_obligations_conservative: freeAfterObligationsConservative,
    salary_already_committed: round2(obligations.total_committed_before_salary),
    first_unsafe_date: firstUnsafeDate,
    top_action: topAction,
    runway_status: beforeSalary < LOW_LIQUID_UNSAFE
      ? 'unsafe_before_salary'
      : beforeSalary < LOW_LIQUID_WATCH
        ? 'watch_before_salary'
        : 'safe_until_salary'
  };
}

function computeObligationsBeforeSalary({ bills, debts, salaryDate, now }) {
  const salaryDay = parseDate(salaryDate);
  const billsDue = [];
  const debtsDue = [];
  const receivablesDue = [];

  for (const bill of bills) {
    const due = billDueDate(bill, now);

    if (!due || !salaryDay || !isOnOrBefore(due, salaryDay)) continue;
    if (isBillPaidForDueCycle(bill, due)) continue;

    billsDue.push({
      id: bill.id,
      name: bill.name,
      amount: round2(number(bill.amount)),
      due_date: dateOnly(due),
      due_cycle_month: monthKey(due),
      days_until_due: daysUntil(now, dateOnly(due)),
      default_account_id: bill.default_account_id || null
    });
  }

  for (const debt of debts) {
    const remaining = remainingDebtAmount(debt);
    if (remaining <= 0) continue;

    const due = debtDueDate(debt, now);
    if (!due || !salaryDay || !isOnOrBefore(due, salaryDay)) continue;

    const row = {
      id: debt.id,
      name: debt.name,
      kind: normalizeDebtKind(debt.kind),
      remaining_amount: round2(remaining),
      installment_amount: nullableRound2(debt.installment_amount),
      due_date: dateOnly(due),
      days_until_due: daysUntil(now, dateOnly(due))
    };

    if (row.kind === 'owed') receivablesDue.push(row);
    else debtsDue.push(row);
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
    net_expected_before_salary: round2(receivableTotal - billTotal - debtTotal),
    bill_paid_cycle_logic: 'Bill is skipped only when last_paid_date belongs to the same due-cycle month as the computed due date.'
  };
}

function computeDailyCashProjection30d({ now, salary, position, bills, debts }) {
  const today = startOfDay(now);

  let running = round2(position.total_liquid);
  let runningWithManual = round2(position.total_liquid);
  let lowest = running;
  let lowestDate = dateOnly(today);
  let firstUnsafeDate = running < LOW_LIQUID_UNSAFE ? dateOnly(today) : null;
  let firstWatchDate = running < LOW_LIQUID_WATCH ? dateOnly(today) : null;
  let salaryDateSeen = false;
  let cashAfterSalaryAndObligations = null;
  let cashAfterSalaryAndObligationsWithManual = null;

  const salaryDate = parseDate(salary.next_salary_date);
  const days = [];

  for (let index = 0; index < PROJECTION_DAYS; index++) {
    const day = addDays(today, index);
    const dayText = dateOnly(day);
    const openingBalance = running;
    const openingBalanceWithManual = runningWithManual;

    const billEvents = billsDueOnDate(bills, day, now);
    const debtEvents = debtsDueOnDate(debts, day, now, 'owe');
    const receivableEvents = debtsDueOnDate(debts, day, now, 'owed');

    const billsOutflow = billEvents.reduce((sum, row) => sum + number(row.amount), 0);
    const debtOutflow = debtEvents.reduce((sum, row) => sum + number(row.amount), 0);
    const receivableInflow = receivableEvents.reduce((sum, row) => sum + number(row.amount), 0);

    const salaryInflow = salaryDate && sameDay(day, salaryDate)
      ? number(salary.baseline_net_without_manual_variables_pkr)
      : 0;

    const manualVariableScenarioInflow = salaryDate && sameDay(day, salaryDate)
      ? number(salary.forecast_net_salary_pkr) - number(salary.baseline_net_without_manual_variables_pkr)
      : 0;

    const totalInflow = round2(receivableInflow + salaryInflow);
    const totalOutflow = round2(billsOutflow + debtOutflow);

    running = round2(running + totalInflow - totalOutflow);
    runningWithManual = round2(runningWithManual + totalInflow + manualVariableScenarioInflow - totalOutflow);

    if (running < lowest) {
      lowest = running;
      lowestDate = dayText;
    }

    if (!firstUnsafeDate && running < LOW_LIQUID_UNSAFE) firstUnsafeDate = dayText;
    if (!firstWatchDate && running < LOW_LIQUID_WATCH) firstWatchDate = dayText;

    if (salaryInflow > 0) {
      salaryDateSeen = true;
      cashAfterSalaryAndObligations = running;
      cashAfterSalaryAndObligationsWithManual = runningWithManual;
    }

    days.push({
      date: dayText,
      day_index: index,
      opening_balance: round2(openingBalance),
      bills_due: billEvents,
      debts_due: debtEvents,
      receivables_due: receivableEvents,
      salary_inflow: round2(salaryInflow),
      manual_variable_scenario_inflow: round2(manualVariableScenarioInflow),
      receivable_inflow: round2(receivableInflow),
      total_inflow: round2(totalInflow),
      bills_outflow: round2(billsOutflow),
      debt_outflow: round2(debtOutflow),
      total_outflow: round2(totalOutflow),
      closing_balance: round2(running),
      closing_balance_with_manual_variables: round2(runningWithManual),
      status: running < LOW_LIQUID_UNSAFE
        ? 'unsafe'
        : running < LOW_LIQUID_WATCH
          ? 'watch'
          : 'safe'
    });
  }

  const finalDay = days[days.length - 1] || null;

  const summary = {
    projection_days: PROJECTION_DAYS,
    projection_start_date: dateOnly(today),
    projection_end_date: finalDay ? finalDay.date : null,
    conservative_mode: true,
    conservative_salary_used: round2(salary.baseline_net_without_manual_variables_pkr),
    manual_variables_separated: true,
    manual_variable_total: round2(salary.manual_variable_total_pkr),
    starting_liquid_cash: round2(position.total_liquid),
    ending_balance_30d: finalDay ? round2(finalDay.closing_balance) : round2(position.total_liquid),
    ending_balance_30d_with_manual_variables: finalDay ? round2(finalDay.closing_balance_with_manual_variables) : round2(position.total_liquid),
    lowest_projected_balance: round2(lowest),
    lowest_projected_balance_date: lowestDate,
    first_unsafe_date: firstUnsafeDate,
    first_watch_date: firstWatchDate,
    salary_date: salary.next_salary_date,
    salary_date_in_projection: salaryDateSeen,
    cash_after_salary_and_obligations: cashAfterSalaryAndObligations == null ? null : round2(cashAfterSalaryAndObligations),
    cash_after_salary_and_obligations_with_manual_variables: cashAfterSalaryAndObligationsWithManual == null ? null : round2(cashAfterSalaryAndObligationsWithManual),
    runway_status: firstUnsafeDate
      ? 'unsafe_in_30d'
      : firstWatchDate
        ? 'watch_in_30d'
        : 'safe_30d',
    top_action: projectionTopAction(firstUnsafeDate, firstWatchDate, lowest, salary.next_salary_date)
  };

  return { days, summary };
}

function projectionTopAction(firstUnsafeDate, firstWatchDate, lowest, salaryDate) {
  if (firstUnsafeDate) {
    return `Cash is projected to fall below ${LOW_LIQUID_UNSAFE} on ${firstUnsafeDate}. Reduce or delay obligations before that date.`;
  }

  if (firstWatchDate) {
    return `Cash is projected to enter watch range on ${firstWatchDate}. Keep spending tight until salary date ${salaryDate}.`;
  }

  return `30-day conservative projection stays above watch threshold. Lowest projected balance is ${round2(lowest)}.`;
}

function computeDebtFreeForecast({ debts, baseline, salary, dailyProjection }) {
  const owedByMe = debts
    .filter(debt => normalizeDebtKind(debt.kind) !== 'owed')
    .map(debt => ({
      id: debt.id,
      name: debt.name,
      remaining_amount: round2(remainingDebtAmount(debt)),
      installment_amount: nullableRound2(debt.installment_amount)
    }))
    .filter(debt => debt.remaining_amount > 0);

  const totalRemaining = owedByMe.reduce((sum, row) => sum + number(row.remaining_amount), 0);
  const conservativeMonthlyFreeCash = Math.max(0, number(baseline.free_salary_after_obligations_conservative));
  const scenarioMonthlyFreeCash = Math.max(0, number(baseline.free_salary_after_obligations));

  const monthsConservative = conservativeMonthlyFreeCash > 0
    ? Math.ceil(totalRemaining / conservativeMonthlyFreeCash)
    : null;

  const monthsScenario = scenarioMonthlyFreeCash > 0
    ? Math.ceil(totalRemaining / scenarioMonthlyFreeCash)
    : null;

  return {
    total_debt_remaining: round2(totalRemaining),
    debt_count: owedByMe.length,
    conservative_monthly_free_cash_after_obligations: round2(conservativeMonthlyFreeCash),
    scenario_monthly_free_cash_after_obligations: round2(scenarioMonthlyFreeCash),
    months_to_debt_free_conservative: monthsConservative,
    months_to_debt_free_with_manual_variables: monthsScenario,
    estimated_debt_free_date_conservative: monthsConservative == null ? null : dateOnly(addMonths(new Date(), monthsConservative)),
    estimated_debt_free_date_with_manual_variables: monthsScenario == null ? null : dateOnly(addMonths(new Date(), monthsScenario)),
    manual_variables_in_conservative_math: false,
    note: totalRemaining <= 0
      ? 'No active payable debt remaining.'
      : 'Debt-free forecast uses free salary after known obligations. Conservative path excludes manual variables.',
    cash_projection_runway_status: dailyProjection.summary.runway_status,
    salary_baseline_used: round2(salary.baseline_net_without_manual_variables_pkr)
  };
}

async function readAll(db, sql, binds) {
  try {
    const stmt = db.prepare(sql);
    const res = binds && binds.length
      ? await stmt.bind(...binds).all()
      : await stmt.all();

    return { ok: true, rows: res.results || [], error: null };
  } catch (err) {
    return { ok: false, rows: [], error: err.message || String(err) };
  }
}

async function readFirst(db, sql, binds) {
  try {
    const stmt = db.prepare(sql);
    const row = binds && binds.length
      ? await stmt.bind(...binds).first()
      : await stmt.first();

    return { ok: true, row: row || null, error: null };
  } catch (err) {
    return { ok: false, row: null, error: err.message || String(err) };
  }
}

async function fetchUsdPkr(url) {
  try {
    const res = await fetch(url || DEFAULT_FX_URL, {
      cf: {
        cacheTtl: 300,
        cacheEverything: false
      }
    });

    if (!res.ok) throw new Error('FX HTTP ' + res.status);

    const data = await res.json();
    const rate = data && data.rates ? Number(data.rates.PKR) : null;

    if (!Number.isFinite(rate) || rate <= 0) throw new Error('PKR rate missing');

    return {
      ok: true,
      source_name: 'ExchangeRate-API open endpoint',
      source_url: url || DEFAULT_FX_URL,
      usd_pkr: rate,
      fetched_at: new Date().toISOString(),
      status: 'live'
    };
  } catch (err) {
    return {
      ok: false,
      source_name: 'ExchangeRate-API open endpoint',
      source_url: url || DEFAULT_FX_URL,
      usd_pkr: null,
      fetched_at: new Date().toISOString(),
      status: 'unavailable',
      error: err.message || String(err)
    };
  }
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
    else if (Math.abs(number(drift)) >= 1) drifted++;
    else matched++;
  }

  return {
    matched_count: matched,
    stale_count: stale,
    drifted_count: drifted,
    undeclared_count: undeclared
  };
}

function computeForecastConfidence(truth) {
  if (truth.drifted_count > 0) return { level: 'low', reason: 'One or more accounts are drifted.' };
  if (truth.undeclared_count > 0) return { level: 'medium_low', reason: 'Some accounts are undeclared.' };
  if (truth.stale_count > 0) return { level: 'medium', reason: 'Some declarations are stale.' };
  return { level: 'high', reason: 'All declared accounts are matched at the current cutoff.' };
}

function activeAccounts(rows) {
  return rows.filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !text(row.deleted_at) && !text(row.archived_at) && (!status || status === 'active');
  });
}

function activeTransactions(rows) {
  return rows.filter(row => !isReversalRelated(row));
}

function visibleBills(rows) {
  return rows.filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return !text(row.deleted_at) && status !== 'deleted' && status !== 'archived';
  });
}

function activeDebts(rows) {
  return rows.filter(row => {
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

    if (TYPE_PLUS.has(type)) balances[origin] += amount;
    else if (TYPE_MINUS.has(type)) balances[origin] -= amount + fee + pra;
  }

  const out = {};
  for (const id of Object.keys(balances)) out[id] = round2(balances[id]);

  return out;
}

function latestReconByAccount(rows) {
  const sorted = rows.slice().sort((a, b) => text(b.declared_at).localeCompare(text(a.declared_at)));
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

function billsDueOnDate(bills, day, now) {
  const out = [];

  for (const bill of bills) {
    const due = billDueDate(bill, now);

    if (!due || !sameDay(due, day)) continue;
    if (isBillPaidForDueCycle(bill, due)) continue;

    out.push({
      id: bill.id,
      name: bill.name,
      amount: round2(number(bill.amount)),
      due_date: dateOnly(due),
      due_cycle_month: monthKey(due),
      default_account_id: bill.default_account_id || null
    });
  }

  return out;
}

function debtsDueOnDate(debts, day, now, targetKind) {
  const out = [];

  for (const debt of debts) {
    const kind = normalizeDebtKind(debt.kind);
    if (kind !== targetKind) continue;

    const remaining = remainingDebtAmount(debt);
    if (remaining <= 0) continue;

    const due = debtDueDate(debt, now);
    if (!due || !sameDay(due, day)) continue;

    out.push({
      id: debt.id,
      name: debt.name,
      kind,
      amount: round2(number(debt.installment_amount || remaining)),
      remaining_amount: round2(remaining),
      installment_amount: nullableRound2(debt.installment_amount),
      due_date: dateOnly(due)
    });
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

function isBillPaidForDueCycle(bill, dueDate) {
  const lastPaid = parseDate(bill.last_paid_date);

  if (!lastPaid || !dueDate) return false;

  const explicitCycle = normalizeMonth(bill.paid_cycle_month || bill.last_paid_cycle_month || bill.covered_month);

  if (explicitCycle) {
    return explicitCycle === monthKey(dueDate);
  }

  return monthKey(lastPaid) === monthKey(dueDate);
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

function addDays(date, days) {
  const d = startOfDay(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = startOfDay(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
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

function isOnOrBefore(date, cutoff) {
  if (!date || !cutoff) return false;
  return startOfDay(date).getTime() <= startOfDay(cutoff).getTime();
}

function sameDay(a, b) {
  if (!a || !b) return false;
  return dateOnly(a) === dateOnly(b);
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

function normalizeMonth(value) {
  const raw = text(value);
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 7);
  return null;
}

function monthKey(date) {
  if (!date) return null;
  if (date instanceof Date) return date.toISOString().slice(0, 7);
  return normalizeMonth(date);
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

function moneyInput(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback == null ? 0 : fallback;

  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
