/* Sovereign Finance Hub API
 * /api/hub
 * v0.1.0-hub-contract-health
 *
 * Phase 6 purpose:
 * - Backend-only Hub aggregator.
 * - Reads already-hardened API contracts.
 * - Does NOT mutate ledger/accounts/debts/salary/forecast/reconciliation.
 * - Gives the Hub page one stable health/dashboard source.
 */

const VERSION = 'v0.1.0-hub-contract-health';

export async function onRequestGet(context) {
  const checkedAt = new Date().toISOString();

  try {
    const origin = new URL(context.request.url).origin;
    const headers = forwardHeaders(context.request);

    const [
      healthResult,
      balancesResult,
      debtsHealthResult,
      debtsResult,
      salaryResult,
      forecastResult,
      reconciliationResult
    ] = await Promise.all([
      fetchJson(origin, '/api/health', headers),
      fetchJson(origin, '/api/balances', headers),
      fetchJson(origin, '/api/debts/health', headers),
      fetchJson(origin, '/api/debts', headers),
      fetchJson(origin, '/api/salary', headers),
      fetchJson(origin, '/api/forecast?horizon=30', headers),
      fetchJson(origin, '/api/reconciliation', headers)
    ]);

    const health = buildHealth({
      healthResult,
      balancesResult,
      debtsHealthResult,
      debtsResult,
      salaryResult,
      forecastResult,
      reconciliationResult
    });

    const summary = buildSummary({
      balances: balancesResult.json,
      debts: debtsResult.json,
      salary: salaryResult.json,
      forecast: forecastResult.json,
      reconciliation: reconciliationResult.json
    });

    const alerts = buildAlerts(health, summary, {
      debtsHealthResult
    });

    return json({
      ok: health.overall === 'pass',
      version: VERSION,
      checked_at: checkedAt,
      phase: 'Phase 6 — Hub health/dashboard aggregator',
      health,
      summary,
      alerts,
      sources: {
        health: sourceMeta('/api/health', healthResult),
        balances: sourceMeta('/api/balances', balancesResult),
        debts_health: sourceMeta('/api/debts/health', debtsHealthResult),
        debts: sourceMeta('/api/debts', debtsResult),
        salary: sourceMeta('/api/salary', salaryResult),
        forecast: sourceMeta('/api/forecast?horizon=30', forecastResult),
        reconciliation: sourceMeta('/api/reconciliation', reconciliationResult)
      },
      contract: {
        hub_is_read_only: true,
        mutates_ledger: false,
        mutates_accounts: false,
        mutates_debts: false,
        mutates_salary: false,
        mutates_forecast: false,
        mutates_reconciliation: false,
        dashboard_source: 'backend_contract_aggregator',
        required_phase_order: [
          'Phase 1 Ledger / Accounts / Health',
          'Phase 2 Debts payment + reversal integrity',
          'Phase 3 Salary contract source',
          'Phase 4 Forecast aggregate source',
          'Phase 5 Reconciliation manual snapshot source',
          'Phase 6 Hub health/dashboard aggregator'
        ]
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      checked_at: checkedAt,
      error: {
        code: 'HUB_AGGREGATE_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie, Cf-Access-Jwt-Assertion'
    }
  });
}

function buildHealth(input) {
  const healthOk =
    input.healthResult.ok &&
    input.healthResult.json &&
    input.healthResult.json.ok === true;

  const balancesOk =
    input.balancesResult.ok &&
    input.balancesResult.json &&
    input.balancesResult.json.ok === true;

  const debtsOk =
    input.debtsHealthResult.ok &&
    input.debtsHealthResult.json &&
    input.debtsHealthResult.json.ok === true &&
    normalizeHealthStatus(input.debtsHealthResult.json.health?.status) === 'pass';

  const salaryOk =
    input.salaryResult.ok &&
    input.salaryResult.json &&
    input.salaryResult.json.ok === true &&
    input.salaryResult.json.forecast_source?.enabled === true &&
    Number(input.salaryResult.json.forecast_source?.monthly_salary_net || 0) > 0;

  const forecastOk =
    input.forecastResult.ok &&
    input.forecastResult.json &&
    input.forecastResult.json.ok === true &&
    Number(input.forecastResult.json.summary?.cash_now || 0) > 0 &&
    Number(input.forecastResult.json.summary?.expected_income || 0) > 0 &&
    input.forecastResult.json.sources?.salary_enabled === true;

  const reconciliationOk =
    input.reconciliationResult.ok &&
    input.reconciliationResult.json &&
    input.reconciliationResult.json.ok === true &&
    Array.isArray(input.reconciliationResult.json.rows);

  const services = {
    health: {
      ok: healthOk,
      version: input.healthResult.json?.version || null,
      endpoint: '/api/health'
    },
    accounts: {
      ok: balancesOk,
      version: input.balancesResult.json?.version || null,
      endpoint: '/api/balances',
      balance_source: 'transactions_canonical'
    },
    debts: {
      ok: debtsOk,
      version: input.debtsResult.json?.version || input.debtsHealthResult.json?.version || null,
      endpoint: '/api/debts',
      health_status: input.debtsHealthResult.json?.health?.status || null
    },
    salary: {
      ok: salaryOk,
      version: input.salaryResult.json?.version || null,
      endpoint: '/api/salary',
      forecast_enabled: input.salaryResult.json?.forecast_source?.enabled || false,
      salary_amount: Number(input.salaryResult.json?.forecast_source?.monthly_salary_net || 0)
    },
    forecast: {
      ok: forecastOk,
      version: input.forecastResult.json?.version || null,
      endpoint: '/api/forecast?horizon=30',
      salary_enabled: input.forecastResult.json?.sources?.salary_enabled || false
    },
    reconciliation: {
      ok: reconciliationOk,
      version: input.reconciliationResult.json?.version || null,
      endpoint: '/api/reconciliation',
      rows_loaded: Array.isArray(input.reconciliationResult.json?.rows)
        ? input.reconciliationResult.json.rows.length
        : 0
    }
  };

  const overall = Object.values(services).every(service => service.ok) ? 'pass' : 'warn';

  return {
    overall,
    services,
    invariants: {
      ledger_accounts_health_passed: healthOk && balancesOk,
      debt_reversal_integrity_passed: debtsOk,
      salary_contract_source_passed: salaryOk,
      forecast_aggregate_source_passed: forecastOk,
      reconciliation_snapshot_source_passed: reconciliationOk,
      hub_read_only: true
    }
  };
}

function buildSummary(input) {
  const balances = input.balances || {};
  const debts = input.debts || {};
  const salary = input.salary || {};
  const forecast = input.forecast || {};
  const reconciliation = input.reconciliation || {};

  const forecastSummary = forecast.summary || {};
  const forecastSources = forecast.sources || {};
  const salarySource = salary.forecast_source || {};
  const reconciliationSummary = reconciliation.summary || {};

  return {
    cash_now: number(
      forecastSummary.cash_now,
      number(balances.total_liquid, number(balances.totals?.liquid, 0))
    ),
    total_assets: number(balances.total_assets, number(balances.totals?.assets, 0)),
    total_liquid: number(balances.total_liquid, number(balances.totals?.liquid, 0)),
    liabilities_total: number(balances.liabilities_total, number(balances.totals?.liabilities, 0)),
    net_worth: number(balances.net_worth, number(balances.totals?.net_worth, 0)),

    active_debts_count: Array.isArray(debts.debts) ? debts.debts.length : number(debts.count, 0),
    total_owe: number(debts.total_owe, 0),
    total_owed: number(debts.total_owed, 0),

    salary_enabled: salarySource.enabled === true,
    salary_amount: wholeRupee(
      salarySource.monthly_salary_net ||
      salarySource.expected_income_amount ||
      forecastSources.salary_amount ||
      0
    ),
    salary_payday: salarySource.expected_payday || null,
    salary_payout_account_id: salarySource.payout_account_id || null,

    forecast_horizon_days: number(forecast.horizon_days, 30),
    forecast_expected_income: wholeRupee(forecastSummary.expected_income || 0),
    forecast_expected_outflow: wholeRupee(forecastSummary.expected_outflow || 0),
    forecast_projected_end: wholeRupee(forecastSummary.projected_end || 0),
    forecast_event_count: Array.isArray(forecast.events) ? forecast.events.length : 0,

    reconciliation_account_count: number(reconciliationSummary.account_count, 0),
    reconciliation_matched_count: number(reconciliationSummary.matched_count, 0),
    reconciliation_pending_statement_count: number(reconciliationSummary.pending_statement_count, 0),
    reconciliation_exception_count: number(reconciliationSummary.exception_count, 0)
  };
}

function buildAlerts(health, summary, raw) {
  const alerts = [];

  for (const [name, service] of Object.entries(health.services)) {
    if (!service.ok) {
      alerts.push({
        level: 'warn',
        code: `SERVICE_${name.toUpperCase()}_NOT_PASSING`,
        title: `${name} contract is not passing`,
        detail: `${service.endpoint} did not meet the Phase 6 Hub health requirement.`,
        endpoint: service.endpoint
      });
    }
  }

  if (summary.salary_enabled && summary.salary_amount <= 0) {
    alerts.push({
      level: 'warn',
      code: 'SALARY_ENABLED_WITH_ZERO_AMOUNT',
      title: 'Salary is enabled but amount is zero',
      detail: 'Salary forecast source must emit a positive monthly net amount.',
      endpoint: '/api/salary'
    });
  }

  if (summary.forecast_expected_income <= 0 && summary.salary_amount > 0) {
    alerts.push({
      level: 'warn',
      code: 'FORECAST_MISSING_SALARY_INCOME',
      title: 'Forecast income does not include salary',
      detail: 'Forecast should include saved salary contract income.',
      endpoint: '/api/forecast?horizon=30'
    });
  }

  if (summary.cash_now <= 0 && summary.total_liquid > 0) {
    alerts.push({
      level: 'warn',
      code: 'FORECAST_CASH_MISMATCH',
      title: 'Forecast cash does not match liquid balances',
      detail: 'Forecast cash_now should use canonical transaction balances.',
      endpoint: '/api/forecast?horizon=30'
    });
  }

  const debtHealth = raw.debtsHealthResult.json?.health || {};
  if (
    Array.isArray(debtHealth.payments_with_reversed_transaction_but_active_payment) &&
    debtHealth.payments_with_reversed_transaction_but_active_payment.length > 0
  ) {
    alerts.push({
      level: 'critical',
      code: 'DEBT_REVERSED_PAYMENT_ACTIVE',
      title: 'Debt payment reversal integrity issue',
      detail: 'A debt payment linked to a reversed transaction is still active.',
      endpoint: '/api/debts/health'
    });
  }

  return alerts;
}

async function fetchJson(origin, path, headers) {
  const url = origin + path;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers
    });

    const text = await response.text();

    let parsed = null;

    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: response.status,
        url,
        json: null,
        error: {
          code: 'NON_JSON_RESPONSE',
          message: `Expected JSON from ${path}, received ${text.slice(0, 80)}`
        }
      };
    }

    return {
      ok: response.ok,
      status: response.status,
      url,
      json: parsed,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      url,
      json: null,
      error: {
        code: 'FETCH_FAILED',
        message: err.message || String(err)
      }
    };
  }
}

function forwardHeaders(request) {
  const headers = new Headers();

  const cookie = request.headers.get('Cookie');
  const authorization = request.headers.get('Authorization');
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');

  if (cookie) headers.set('Cookie', cookie);
  if (authorization) headers.set('Authorization', authorization);
  if (cfAccessJwt) headers.set('Cf-Access-Jwt-Assertion', cfAccessJwt);

  headers.set('Accept', 'application/json');

  return headers;
}

function sourceMeta(endpoint, result) {
  return {
    endpoint,
    ok: result.ok,
    status: result.status,
    version: result.json?.version || null,
    error: result.error || null
  };
}

function normalizeHealthStatus(value) {
  const raw = String(value || '').toLowerCase();

  if (raw === 'pass' || raw === 'ok' || raw === 'healthy') return 'pass';
  if (raw === 'warn' || raw === 'warning') return 'warn';
  if (raw === 'fail' || raw === 'failed' || raw === 'error') return 'fail';

  return raw || 'unknown';
}

function number(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? n : fallback;
}

function wholeRupee(value) {
  const n = number(value, 0);
  return Math.round(n);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
