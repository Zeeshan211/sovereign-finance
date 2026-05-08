/* /api/insights v0.3.0
 * Layer 6A - Rule-based Insights Brain
 *
 * Purpose:
 * - Convert forecast, safety, reconciliation, credit card, debt, obligation, and transaction patterns into action cards.
 *
 * Contract:
 * - GET /api/insights
 * - Read-only.
 * - No schema mutation.
 * - No ledger mutation.
 * - No audit writes.
 * - No generic insights without computed backing.
 *
 * Preserves older analytics fields:
 * - totals
 * - net
 * - by_category
 * - by_account
 * - daily_trend
 */

const VERSION = 'v0.3.0';

const INCOME_TYPES = new Set(['income', 'borrow', 'salary']);
const EXPENSE_TYPES = new Set(['expense', 'repay', 'cc_spend', 'atm']);
const LOW_LIQUID_UNSAFE = 5000;
const LOW_LIQUID_WATCH = 10000;
const OBLIGATION_PRESSURE_WATCH = 0.5;
const OBLIGATION_PRESSURE_RISK = 0.75;
const CC_PRESSURE_WATCH = 0.4;
const CC_PRESSURE_RISK = 0.75;
const DEBT_BURDEN_WATCH = 1;
const DEBT_BURDEN_RISK = 2;
const CASH_CONCENTRATION_WATCH = 0.8;

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const since = dateDaysAgo(days);
  const debug = url.searchParams.get('debug') === '1';

  try {
    const [forecastRes, safetyRes, txnsResult, accountResult, categoryResult, debtsResult, billsResult, reconResult] = await Promise.all([
      readInternalJson(context, '/api/forecast'),
      readInternalJson(context, '/api/safety'),
      env.DB.prepare(
        `SELECT id, date, type, amount, account_id, category_id, notes,
          reversed_by, reversed_at, linked_txn_id, created_at
         FROM transactions
         WHERE date >= ?
         ORDER BY date ASC, datetime(created_at) ASC, id ASC`
      ).bind(since).all(),
      env.DB.prepare(
        `SELECT id, name, icon, kind, type, status, opening_balance
         FROM accounts
         WHERE status = 'active' OR status IS NULL
         ORDER BY display_order, name`
      ).all(),
      safeAll(env.DB, `SELECT id, name, icon FROM categories`),
      safeAll(env.DB, `SELECT * FROM debts`),
      safeAll(env.DB, `SELECT * FROM bills`),
      safeAll(env.DB, `SELECT * FROM reconciliation ORDER BY declared_at DESC`)
    ]);

    const accountRows = accountResult.results || [];
    const categoryRows = categoryResult.results || [];
    const debtRows = debtsResult.results || [];
    const billRows = billsResult.results || [];
    const reconRows = reconResult.results || [];
    const accountMap = toAccountMap(accountRows);
    const categoryMap = toCategoryMap(categoryRows);

    const allRows = txnsResult.results || [];
    const activeRows = allRows.filter(row => !isReversalRow(row));
    const analyticRows = activeRows
      .map(row => classifyRow(row))
      .filter(row => row.classification !== 'ignore');

    const incomeRows = analyticRows.filter(row => row.classification === 'income');
    const expenseRows = analyticRows.filter(row => row.classification === 'expense');

    const incomeTotal = round2(sumAmounts(incomeRows));
    const expenseTotal = round2(sumAmounts(expenseRows));
    const net = round2(incomeTotal - expenseTotal);

    const byCategory = buildCategoryBreakdown(expenseRows, categoryMap);
    const byAccount = buildAccountBreakdown(expenseRows, accountMap);
    const dailyTrend = buildDailyTrend(expenseRows, since, days);

    const forecast = forecastRes.data || null;
    const safety = safetyRes.data || null;

    const computed = computeInsightMetrics({
      forecast,
      safety,
      debts: debtRows,
      bills: billRows,
      accounts: accountRows,
      reconciliation: reconRows,
      byCategory,
      byAccount,
      incomeTotal,
      expenseTotal,
      net
    });

    const insights = buildInsights(computed);
    const topInsight = insights.length ? insights[0] : cleanInsight();

    const body = {
      ok: true,
      version: VERSION,
      computed_at: new Date().toISOString(),
      days,
      since,

      top_insight: topInsight,
      insights,

      metrics: computed,

      totals: {
        income: incomeTotal,
        expense: expenseTotal
      },
      net,
      by_category: byCategory,
      by_account: byAccount,
      daily_trend: dailyTrend,
      top_category: byCategory.length
        ? byCategory[0]
        : {
            id: 'uncategorized',
            name: 'Uncategorized',
            icon: '',
            total: 0,
            count: 0
          },

      sources: {
        forecast: {
          ok: forecastRes.ok,
          version: forecast && forecast.version ? forecast.version : null,
          error: forecastRes.error || null
        },
        safety: {
          ok: safetyRes.ok,
          version: safety && safety.version ? safety.version : null,
          error: safetyRes.error || null
        },
        transactions: {
          ok: true,
          rows_scanned: allRows.length,
          active_rows: activeRows.length,
          analytic_rows: analyticRows.length
        },
        accounts: {
          ok: true,
          rows: accountRows.length
        },
        categories: {
          ok: !categoryResult.error,
          rows: categoryRows.length,
          error: categoryResult.error || null
        },
        debts: {
          ok: !debtsResult.error,
          rows: debtRows.length,
          error: debtsResult.error || null
        },
        bills: {
          ok: !billsResult.error,
          rows: billRows.length,
          error: billsResult.error || null
        },
        reconciliation: {
          ok: !reconResult.error,
          rows: reconRows.length,
          error: reconResult.error || null
        }
      },

      generated_at: new Date().toISOString()
    };

    if (debug) {
      body.debug = {
        total_rows_scanned: allRows.length,
        active_rows: activeRows.length,
        hidden_reversal_rows: allRows.length - activeRows.length,
        analytic_rows: analyticRows.length,
        income_rows: incomeRows.length,
        expense_rows: expenseRows.length,
        ignored_rows: activeRows.length - analyticRows.length,
        category_rows_loaded: categoryRows.length,
        account_rows_loaded: accountRows.length,
        reversal_bridge: 'reversed_by/reversed_at plus Sheet notes markers',
        transfer_rule: 'exclude transfer OUT rows and legacy transfer IN rows from income/expense analytics'
      };
    }

    return json(body);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message,
      computed_at: new Date().toISOString()
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
        data: null,
        error: data && data.error ? data.error : `${pathname} HTTP ${res.status}`
      };
    }

    return { ok: true, data, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err.message || String(err) };
  }
}

function computeInsightMetrics(input) {
  const forecast = input.forecast || {};
  const safety = input.safety || {};
  const salary = forecast.salary || {};
  const projection = forecast.cash_projection_summary || {};
  const obligations = forecast.obligations_before_salary || {};
  const currentPosition = forecast.current_position || {};
  const confidence = forecast.forecast_confidence || {};
  const safetyConfidence = safety.confidence || {};

  const conservativeSalary = number(salary.baseline_net_without_manual_variables_pkr);
  const committedBeforeSalary = number(obligations.total_committed_before_salary);
  const ccOutstanding = number(currentPosition.cc_outstanding);
  const totalLiquid = number(currentPosition.total_liquid);
  const lowestProjectedBalance = nullableNumber(projection.lowest_projected_balance);
  const firstUnsafeDate = projection.first_unsafe_date || null;
  const firstWatchDate = projection.first_watch_date || null;

  const activeDebts = (input.debts || []).filter(row => {
    const status = text(row.status || 'active').toLowerCase();
    return (!status || status === 'active') && remainingDebtAmount(row) > 0 && normalizeDebtKind(row.kind) !== 'owed';
  });

  const totalDebtRemaining = activeDebts.reduce((sum, row) => sum + remainingDebtAmount(row), 0);
  const largestAccount = largestAccountByBalance(input.accounts || []);
  const largestCategory = (input.byCategory || [])[0] || null;

  const reconciliationMetrics = reconciliationStatus(input.reconciliation || [], forecast, safety);
  const variableTotal = number(salary.manual_variable_total_pkr);

  return {
    forecast_version: forecast.version || null,
    safety_version: safety.version || null,

    safety_status: safety.safety_status || safety.status || null,
    safety_top_action: safety.top_action || null,
    safety_next_risk_date: safety.next_risk_date || null,
    safety_confidence: safetyConfidence.level || null,

    total_liquid: round2(totalLiquid),
    conservative_net_salary: round2(conservativeSalary),
    committed_before_salary: round2(committedBeforeSalary),
    obligation_pressure: conservativeSalary > 0 ? round4(committedBeforeSalary / conservativeSalary) : null,

    cc_outstanding: round2(ccOutstanding),
    cc_pressure: conservativeSalary > 0 ? round4(ccOutstanding / conservativeSalary) : null,

    total_debt_remaining: round2(totalDebtRemaining),
    active_debt_count: activeDebts.length,
    debt_burden: conservativeSalary > 0 ? round4(totalDebtRemaining / conservativeSalary) : null,

    lowest_projected_balance: lowestProjectedBalance == null ? null : round2(lowestProjectedBalance),
    first_unsafe_date: firstUnsafeDate,
    first_watch_date: firstWatchDate,
    runway_gap_to_unsafe: lowestProjectedBalance == null ? null : round2(lowestProjectedBalance - LOW_LIQUID_UNSAFE),
    runway_gap_to_watch: lowestProjectedBalance == null ? null : round2(lowestProjectedBalance - LOW_LIQUID_WATCH),

    manual_variable_total: round2(variableTotal),
    manual_variables_used_for_safety: !!safety.manual_variables_used_for_safety,

    forecast_confidence: confidence.level || null,
    reconciliation_confidence: reconciliationMetrics.confidence,
    reconciliation_blockers: reconciliationMetrics.blockers,

    largest_liquid_account: largestAccount,
    cash_concentration: totalLiquid > 0 && largestAccount ? round4(number(largestAccount.balance) / totalLiquid) : null,

    top_spend_category: largestCategory,
    period_income: round2(input.incomeTotal),
    period_expense: round2(input.expenseTotal),
    period_net: round2(input.net)
  };
}

function buildInsights(metrics) {
  const insights = [];

  addCashRunwayInsight(insights, metrics);
  addSafetyInsight(insights, metrics);
  addObligationInsight(insights, metrics);
  addCreditCardInsight(insights, metrics);
  addDebtInsight(insights, metrics);
  addReconciliationInsight(insights, metrics);
  addVariableIncomeInsight(insights, metrics);
  addCashConcentrationInsight(insights, metrics);
  addSpendingInsight(insights, metrics);

  if (!insights.length) insights.push(cleanInsight());

  return insights
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.order - b.order)
    .map(({ order, ...item }) => item);
}

function addCashRunwayInsight(insights, m) {
  if (m.lowest_projected_balance == null) {
    insights.push(makeInsight({
      order: 10,
      id: 'cash_runway_missing',
      severity: 'watch',
      title: 'Cash runway could not be fully evaluated',
      meaning: 'The 30-day projection did not return a lowest projected balance.',
      action: 'Verify /api/forecast before trusting runway conclusions.',
      source: 'forecast',
      confidence: 'low',
      evidence: { forecast_version: m.forecast_version }
    }));
    return;
  }

  if (m.lowest_projected_balance < 0) {
    insights.push(makeInsight({
      order: 10,
      id: 'cash_runway_negative',
      severity: 'critical',
      title: 'Cash runway goes negative',
      meaning: `Lowest projected balance is ${money(m.lowest_projected_balance)}.`,
      action: 'Reduce, delay, or re-sequence obligations before the lowest-balance date.',
      source: 'forecast',
      confidence: 'high',
      evidence: {
        lowest_projected_balance: m.lowest_projected_balance,
        first_unsafe_date: m.first_unsafe_date,
        runway_gap_to_unsafe: m.runway_gap_to_unsafe
      }
    }));
    return;
  }

  if (m.first_unsafe_date || m.lowest_projected_balance < LOW_LIQUID_UNSAFE) {
    insights.push(makeInsight({
      order: 10,
      id: 'cash_runway_unsafe',
      severity: 'risk',
      title: 'Cash runway enters unsafe range',
      meaning: `Projected cash falls below ${money(LOW_LIQUID_UNSAFE)}${m.first_unsafe_date ? ` on ${m.first_unsafe_date}` : ''}.`,
      action: 'Use Forecast to identify which bill, debt, or cash movement causes the unsafe date.',
      source: 'forecast',
      confidence: 'high',
      evidence: {
        lowest_projected_balance: m.lowest_projected_balance,
        first_unsafe_date: m.first_unsafe_date,
        runway_gap_to_unsafe: m.runway_gap_to_unsafe
      }
    }));
    return;
  }

  if (m.first_watch_date || m.lowest_projected_balance < LOW_LIQUID_WATCH) {
    insights.push(makeInsight({
      order: 10,
      id: 'cash_runway_watch',
      severity: 'watch',
      title: 'Cash runway enters watch range',
      meaning: `Lowest projected balance is ${money(m.lowest_projected_balance)}.`,
      action: 'Keep non-essential spending tight until salary and required obligations clear.',
      source: 'forecast',
      confidence: 'high',
      evidence: {
        lowest_projected_balance: m.lowest_projected_balance,
        first_watch_date: m.first_watch_date,
        runway_gap_to_watch: m.runway_gap_to_watch
      }
    }));
  }
}

function addSafetyInsight(insights, m) {
  const status = text(m.safety_status).toLowerCase();
  if (!status) return;

  if (status === 'critical' || status === 'unsafe') {
    insights.push(makeInsight({
      order: 20,
      id: 'safety_engine_action_required',
      severity: status === 'critical' ? 'critical' : 'risk',
      title: 'Safety Engine requires action',
      meaning: `Safety status is ${status.toUpperCase()}.`,
      action: m.safety_top_action || 'Open Forecast and resolve the top Safety driver.',
      source: 'safety',
      confidence: m.safety_confidence || 'medium',
      evidence: {
        safety_status: m.safety_status,
        next_risk_date: m.safety_next_risk_date,
        safety_top_action: m.safety_top_action
      }
    }));
    return;
  }

  if (status === 'watch') {
    insights.push(makeInsight({
      order: 20,
      id: 'safety_engine_watch',
      severity: 'watch',
      title: 'Safety Engine is in watch mode',
      meaning: 'The system sees at least one watch item but not a full unsafe state.',
      action: m.safety_top_action || 'Review the top Safety driver before it becomes urgent.',
      source: 'safety',
      confidence: m.safety_confidence || 'medium',
      evidence: {
        safety_status: m.safety_status,
        next_risk_date: m.safety_next_risk_date,
        safety_top_action: m.safety_top_action
      }
    }));
  }
}

function addObligationInsight(insights, m) {
  if (m.obligation_pressure == null) return;

  if (m.obligation_pressure >= OBLIGATION_PRESSURE_RISK) {
    insights.push(makeInsight({
      order: 30,
      id: 'obligation_pressure_high',
      severity: 'risk',
      title: 'Obligations consume most of conservative salary',
      meaning: `Known obligations before salary equal ${percent(m.obligation_pressure)} of conservative net salary.`,
      action: 'Review bills and debts due before salary and move anything non-critical if possible.',
      source: 'forecast',
      confidence: 'high',
      evidence: {
        committed_before_salary: m.committed_before_salary,
        conservative_net_salary: m.conservative_net_salary,
        obligation_pressure: m.obligation_pressure
      }
    }));
    return;
  }

  if (m.obligation_pressure >= OBLIGATION_PRESSURE_WATCH) {
    insights.push(makeInsight({
      order: 30,
      id: 'obligation_pressure_watch',
      severity: 'watch',
      title: 'Obligation pressure is elevated',
      meaning: `Known obligations before salary equal ${percent(m.obligation_pressure)} of conservative net salary.`,
      action: 'Keep upcoming bill/debt dates visible before any optional spend.',
      source: 'forecast',
      confidence: 'high',
      evidence: {
        committed_before_salary: m.committed_before_salary,
        conservative_net_salary: m.conservative_net_salary,
        obligation_pressure: m.obligation_pressure
      }
    }));
  }
}

function addCreditCardInsight(insights, m) {
  if (m.cc_pressure == null || m.cc_outstanding <= 0) return;

  if (m.cc_pressure >= CC_PRESSURE_RISK) {
    insights.push(makeInsight({
      order: 40,
      id: 'credit_card_pressure_high',
      severity: 'risk',
      title: 'Credit Card pressure is high',
      meaning: `Credit Card outstanding equals ${percent(m.cc_pressure)} of conservative net salary.`,
      action: 'Open Credit Card planner and prioritize reducing outstanding before adding new obligations.',
      source: 'credit_card',
      confidence: 'high',
      evidence: {
        cc_outstanding: m.cc_outstanding,
        conservative_net_salary: m.conservative_net_salary,
        cc_pressure: m.cc_pressure
      }
    }));
    return;
  }

  if (m.cc_pressure >= CC_PRESSURE_WATCH) {
    insights.push(makeInsight({
      order: 40,
      id: 'credit_card_pressure_watch',
      severity: 'watch',
      title: 'Credit Card pressure needs attention',
      meaning: `Credit Card outstanding equals ${percent(m.cc_pressure)} of conservative net salary.`,
      action: 'Keep the Credit Card payoff path visible while planning bills and debts.',
      source: 'credit_card',
      confidence: 'high',
      evidence: {
        cc_outstanding: m.cc_outstanding,
        conservative_net_salary: m.conservative_net_salary,
        cc_pressure: m.cc_pressure
      }
    }));
  }
}

function addDebtInsight(insights, m) {
  if (m.debt_burden == null || m.total_debt_remaining <= 0) return;

  if (m.debt_burden >= DEBT_BURDEN_RISK) {
    insights.push(makeInsight({
      order: 50,
      id: 'debt_burden_high',
      severity: 'risk',
      title: 'Debt burden is heavy versus conservative salary',
      meaning: `Active payable debt equals ${percent(m.debt_burden)} of conservative net salary.`,
      action: 'Use the debt-free forecast before increasing any discretionary spending.',
      source: 'debts',
      confidence: 'high',
      evidence: {
        total_debt_remaining: m.total_debt_remaining,
        active_debt_count: m.active_debt_count,
        debt_burden: m.debt_burden
      }
    }));
    return;
  }

  if (m.debt_burden >= DEBT_BURDEN_WATCH) {
    insights.push(makeInsight({
      order: 50,
      id: 'debt_burden_watch',
      severity: 'watch',
      title: 'Debt burden is still material',
      meaning: `Active payable debt equals ${percent(m.debt_burden)} of conservative net salary.`,
      action: 'Keep debt payoff order visible until debt-free forecast improves.',
      source: 'debts',
      confidence: 'high',
      evidence: {
        total_debt_remaining: m.total_debt_remaining,
        active_debt_count: m.active_debt_count,
        debt_burden: m.debt_burden
      }
    }));
  }
}

function addReconciliationInsight(insights, m) {
  if (m.reconciliation_confidence === 'low') {
    insights.push(makeInsight({
      order: 60,
      id: 'reconciliation_confidence_low',
      severity: 'risk',
      title: 'Reconciliation confidence is low',
      meaning: 'One or more reconciliation blockers weaken cash truth.',
      action: 'Resolve reconciliation blockers before treating forecasts as final.',
      source: 'reconciliation',
      confidence: 'high',
      evidence: {
        reconciliation_confidence: m.reconciliation_confidence,
        blockers: m.reconciliation_blockers
      }
    }));
    return;
  }

  if (m.reconciliation_confidence === 'medium') {
    insights.push(makeInsight({
      order: 60,
      id: 'reconciliation_confidence_medium',
      severity: 'watch',
      title: 'Reconciliation confidence needs refresh',
      meaning: 'Some declarations may be stale or incomplete.',
      action: 'Refresh declarations for accounts that changed after last balance check.',
      source: 'reconciliation',
      confidence: 'medium',
      evidence: {
        reconciliation_confidence: m.reconciliation_confidence,
        blockers: m.reconciliation_blockers
      }
    }));
  }
}

function addVariableIncomeInsight(insights, m) {
  if (m.manual_variable_total > 0) {
    insights.push(makeInsight({
      order: 70,
      id: 'manual_variables_entered',
      severity: 'info',
      title: 'Manual variable income is entered',
      meaning: `Manual variable income total is ${money(m.manual_variable_total)}.`,
      action: 'Keep safety decisions anchored to conservative baseline unless the variable amount is confirmed.',
      source: 'forecast',
      confidence: 'high',
      evidence: {
        manual_variable_total: m.manual_variable_total,
        manual_variables_used_for_safety: m.manual_variables_used_for_safety
      }
    }));
    return;
  }

  insights.push(makeInsight({
    order: 70,
    id: 'variable_income_zero_default',
    severity: 'info',
    title: 'Variable income is safely excluded',
    meaning: 'MBO, overtime, referral, spot bonus, kitty cash, and other variables are at 0 by default.',
    action: 'Only enter variable income when it is confirmed or intentionally being modeled.',
    source: 'forecast',
    confidence: 'high',
    evidence: {
      manual_variable_total: m.manual_variable_total,
      manual_variables_used_for_safety: m.manual_variables_used_for_safety
    }
  }));
}

function addCashConcentrationInsight(insights, m) {
  if (!m.largest_liquid_account || m.cash_concentration == null) return;

  if (m.cash_concentration >= CASH_CONCENTRATION_WATCH && m.total_liquid > 0) {
    insights.push(makeInsight({
      order: 80,
      id: 'cash_concentration_watch',
      severity: 'watch',
      title: 'Cash is concentrated in one account',
      meaning: `${m.largest_liquid_account.name} holds ${percent(m.cash_concentration)} of liquid cash.`,
      action: 'Confirm the main payment account can cover the next obligation before due date.',
      source: 'accounts',
      confidence: 'medium',
      evidence: {
        account_id: m.largest_liquid_account.id,
        account_name: m.largest_liquid_account.name,
        account_balance: m.largest_liquid_account.balance,
        cash_concentration: m.cash_concentration,
        total_liquid: m.total_liquid
      }
    }));
  }
}

function addSpendingInsight(insights, m) {
  if (!m.top_spend_category || number(m.top_spend_category.total) <= 0) return;

  insights.push(makeInsight({
    order: 90,
    id: 'top_spend_category',
    severity: 'info',
    title: 'Top spending category identified',
    meaning: `${m.top_spend_category.name} is the top expense category for the selected period at ${money(m.top_spend_category.total)}.`,
    action: 'Review whether this category is required or reducible before the next salary cycle.',
    source: 'transactions',
    confidence: 'medium',
    evidence: {
      category_id: m.top_spend_category.id,
      category_name: m.top_spend_category.name,
      total: m.top_spend_category.total,
      count: m.top_spend_category.count
    }
  }));
}

function makeInsight(input) {
  return {
    order: input.order || 999,
    id: input.id,
    severity: input.severity || 'info',
    title: input.title,
    meaning: input.meaning,
    action: input.action,
    source: input.source || 'computed',
    confidence: input.confidence || 'medium',
    evidence: input.evidence || {}
  };
}

function cleanInsight() {
  return {
    id: 'finance_core_clean',
    severity: 'info',
    title: 'No major insight flags from available data',
    meaning: 'Forecast, safety, and transaction analytics did not produce a risk or watch insight.',
    action: 'Keep forecast, reconciliation, bills, and debts updated.',
    source: 'computed',
    confidence: 'medium',
    evidence: {}
  };
}

function reconciliationStatus(rows, forecast, safety) {
  const blockers = [];

  const forecastConfidence = forecast && forecast.forecast_confidence ? forecast.forecast_confidence : {};
  const safetyConfidence = safety && safety.confidence ? safety.confidence : {};

  if (Array.isArray(forecastConfidence.blockers)) blockers.push(...forecastConfidence.blockers);
  if (Array.isArray(safetyConfidence.blockers)) blockers.push(...safetyConfidence.blockers);

  const unique = Array.from(new Set(blockers.filter(Boolean)));

  if (unique.some(item => String(item).includes('drift'))) return { confidence: 'low', blockers: unique };
  if (unique.length) return { confidence: 'medium', blockers: unique };

  if (!rows.length) return { confidence: 'medium', blockers: ['no_reconciliation_rows_loaded'] };
  return { confidence: 'high', blockers: [] };
}

function largestAccountByBalance(accounts) {
  const liquid = (accounts || [])
    .filter(row => {
      const kind = String(row.kind || row.type || '').toLowerCase();
      const status = String(row.status || 'active').toLowerCase();
      return (!status || status === 'active') && kind !== 'cc' && kind !== 'credit' && kind !== 'credit_card' && kind !== 'liability';
    })
    .map(row => ({
      id: row.id,
      name: row.name || humanizeId(row.id),
      balance: round2(row.opening_balance)
    }))
    .sort((a, b) => number(b.balance) - number(a.balance));

  return liquid.length ? liquid[0] : null;
}

function classifyRow(row) {
  const type = String(row.type || '').toLowerCase();

  if (isLegacyTransferIn(row)) {
    return { ...row, classification: 'ignore', ignored_reason: 'legacy_transfer_in' };
  }

  if (type === 'transfer' || type === 'cc_payment') {
    return { ...row, classification: 'ignore', ignored_reason: 'transfer_movement' };
  }

  if (INCOME_TYPES.has(type)) return { ...row, classification: 'income' };
  if (EXPENSE_TYPES.has(type)) return { ...row, classification: 'expense' };

  return { ...row, classification: 'ignore', ignored_reason: 'unknown_or_non_analytic_type' };
}

function isReversalRow(row) {
  if (!row) return false;
  if (row.reversed_by || row.reversed_at) return true;

  const notes = String(row.notes || '').toUpperCase();
  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function isLegacyTransferIn(row) {
  const type = String(row.type || '').toLowerCase();
  const notes = String(row.notes || '');
  return type === 'income' && /^From:/i.test(notes) && /\[linked:/i.test(notes);
}

function buildCategoryBreakdown(rows, categoryMap) {
  const map = {};

  for (const row of rows) {
    const category = getCategory(row.category_id, categoryMap);
    const key = category.id;

    if (!map[key]) {
      map[key] = {
        id: category.id,
        name: category.name,
        icon: category.icon,
        total: 0,
        count: 0
      };
    }

    map[key].total += Number(row.amount) || 0;
    map[key].count += 1;
  }

  return Object.values(map)
    .map(row => ({ ...row, total: round2(row.total) }))
    .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));
}

function buildAccountBreakdown(rows, accountMap) {
  const map = {};

  for (const row of rows) {
    const account = getAccount(row.account_id, accountMap);
    const key = account.id;

    if (!map[key]) {
      map[key] = {
        id: account.id,
        name: account.name,
        icon: account.icon,
        total: 0,
        count: 0
      };
    }

    map[key].total += Number(row.amount) || 0;
    map[key].count += 1;
  }

  return Object.values(map)
    .map(row => ({ ...row, total: round2(row.total) }))
    .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));
}

function buildDailyTrend(rows, since, days) {
  const map = {};

  for (let i = days - 1; i >= 0; i--) {
    const d = dateDaysAgo(i);
    map[d] = 0;
  }

  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    if (!(date in map)) map[date] = 0;
    map[date] += Number(row.amount) || 0;
  }

  return Object.keys(map)
    .sort()
    .map(date => ({ date, total: round2(map[date]) }))
    .filter(row => row.date >= since);
}

function getCategory(categoryId, categoryMap) {
  const id = categoryId == null || categoryId === '' ? 'uncategorized' : String(categoryId);
  if (categoryMap[id]) return categoryMap[id];

  if (id === 'uncategorized') {
    return { id: 'uncategorized', name: 'Uncategorized', icon: '' };
  }

  return { id, name: humanizeId(id), icon: '' };
}

function getAccount(accountId, accountMap) {
  const id = accountId == null || accountId === '' ? 'unknown' : String(accountId);
  if (accountMap[id]) return accountMap[id];

  return { id, name: humanizeId(id), icon: '' };
}

function toAccountMap(rows) {
  const map = {};

  for (const row of rows || []) {
    if (!row || !row.id) continue;
    map[row.id] = {
      id: row.id,
      name: row.name || humanizeId(row.id),
      icon: row.icon || iconForAccount(row)
    };
  }

  return map;
}

function toCategoryMap(rows) {
  const map = {};

  for (const row of rows || []) {
    if (!row || !row.id) continue;
    map[row.id] = {
      id: row.id,
      name: row.name || humanizeId(row.id),
      icon: row.icon || ''
    };
  }

  return map;
}

async function safeAll(db, sql) {
  try {
    return await db.prepare(sql).all();
  } catch (err) {
    return { results: [], error: err.message };
  }
}

function iconForAccount(row) {
  const kind = String(row.kind || row.type || '').toLowerCase();
  if (kind === 'cash') return '';
  if (kind === 'wallet') return '';
  if (kind === 'cc') return '';
  if (kind === 'credit_card') return '';
  if (kind === 'prepaid') return '';
  return '';
}

function remainingDebtAmount(debt) {
  return Math.max(0, number(debt.original_amount) - number(debt.paid_amount));
}

function normalizeDebtKind(kind) {
  const val = text(kind).toLowerCase();
  if (['owed', 'owed_me', 'receivable', 'to_me'].includes(val)) return 'owed';
  return 'owe';
}

function humanizeId(id) {
  return String(id || 'Unknown')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
}

function severityRank(severity) {
  if (severity === 'critical') return 0;
  if (severity === 'risk') return 1;
  if (severity === 'watch') return 2;
  return 3;
}

function sumAmounts(rows) {
  return rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

function dateDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(daysAgo || 0));
  return d.toISOString().slice(0, 10);
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function percent(value) {
  return `${Math.round(number(value) * 1000) / 10}%`;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function money(value) {
  const n = number(value);
  const sign = n < 0 ? '-' : '';
  return sign + 'Rs ' + Math.abs(round2(n)).toLocaleString('en-PK', {
    maximumFractionDigits: 2
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
