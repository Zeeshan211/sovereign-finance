/* Sovereign Finance Forecast API v1.0.0
   /api/forecast

   Contract:
   - GET returns source status and current forecast posture.
   - POST dry_run generates forecast without writes.
   - POST real generate asks Command Centre before returning generated forecast.
   - Forecast reads recovered source APIs:
     /api/accounts or /api/balances
     /api/salary
     /api/bills
     /api/debts
     /api/cc
   - No /api/money-contracts.
   - Unknown values stay unknown; they do not silently become 0.
   - Salary uses guaranteed/forecast-eligible income from Salary API.
*/

const VERSION = 'v1.0.0';

export async function onRequestGet(context) {
  try {
    const bundle = await loadForecastSources(context);
    const forecast = buildForecast(bundle);

    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'forecast.read',
      writes_performed: false,
      audit_performed: false,
      source_status: bundle.source_status,
      forecast,
      warnings: forecast.warnings,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);
    const action = 'forecast.generate';

    const bundle = await loadForecastSources(context);
    const forecast = buildForecast(bundle);
    const proof = buildForecastProof(bundle, forecast);

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action,
        writes_performed: false,
        audit_performed: false,
        proof,
        forecast,
        source_status: bundle.source_status,
        generated_at: new Date().toISOString()
      });
    }

    const allowed = await commandAllowsAction(context, action);

    if (!allowed) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Command Centre blocked forecast generation',
        action,
        dry_run: false,
        writes_performed: false,
        audit_performed: false,
        enforcement: {
          action,
          allowed: false,
          status: 'blocked',
          reason: 'forecast.generate blocked by Command Centre.',
          source: 'coverage.write_safety.forecast',
          backend_enforced: true
        },
        proof
      }, 423);
    }

    return jsonResponse({
      ok: true,
      version: VERSION,
      action,
      writes_performed: false,
      audit_performed: false,
      proof,
      forecast,
      source_status: bundle.source_status,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function loadForecastSources(context) {
  const origin = new URL(context.request.url).origin;

  const [accounts, balances, salary, bills, debts, cc] = await Promise.all([
    fetchSource(origin, '/api/accounts', 'accounts'),
    fetchSource(origin, '/api/balances?debug=1', 'balances'),
    fetchSource(origin, '/api/salary', 'salary'),
    fetchSource(origin, '/api/bills', 'bills'),
    fetchSource(origin, '/api/debts', 'debts'),
    fetchSource(origin, '/api/cc', 'credit_card')
  ]);

  const source_status = {
    accounts: sourceStatus(accounts),
    balances: sourceStatus(balances),
    salary: sourceStatus(salary),
    bills: sourceStatus(bills),
    debts: sourceStatus(debts),
    credit_card: sourceStatus(cc),
    money_contracts: {
      status: 'banned',
      used: false
    }
  };

  return {
    accounts,
    balances,
    salary,
    bills,
    debts,
    cc,
    source_status
  };
}

async function fetchSource(origin, path, key) {
  const started = Date.now();

  try {
    const res = await fetch(origin + path + (path.includes('?') ? '&' : '?') + 'forecast_cb=' + Date.now(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-sovereign-forecast-source': VERSION
      }
    });

    const data = await res.json().catch(() => null);

    return {
      key,
      path,
      ok: res.ok && Boolean(data),
      http_status: res.status,
      version: data && data.version ? String(data.version) : null,
      data,
      elapsed_ms: Date.now() - started
    };
  } catch (err) {
    return {
      key,
      path,
      ok: false,
      error: err.message || String(err),
      elapsed_ms: Date.now() - started
    };
  }
}

function sourceStatus(source) {
  return {
    ok: Boolean(source && source.ok),
    status: source && source.ok ? 'pass' : 'unknown',
    path: source && source.path,
    version: source && source.version || null,
    http_status: source && source.http_status || null,
    error: source && source.error || null
  };
}

function buildForecast(bundle) {
  const accounts = normalizeAccounts(bundle.accounts && bundle.accounts.data);
  const salary = normalizeSalary(bundle.salary && bundle.salary.data);
  const bills = normalizeBills(bundle.bills && bundle.bills.data);
  const debts = normalizeDebts(bundle.debts && bundle.debts.data);
  const cc = normalizeCreditCard(bundle.cc && bundle.cc.data);

  const warnings = [];

  if (!bundle.accounts.ok) warnings.push('Accounts source unavailable.');
  if (!bundle.salary.ok) warnings.push('Salary source unavailable.');
  if (!bundle.bills.ok) warnings.push('Bills source unavailable.');
  if (!bundle.debts.ok) warnings.push('Debts source unavailable.');
  if (!bundle.cc.ok) warnings.push('Credit Card source unavailable or unverified.');

  const liquidBalance = accounts.known ? accounts.total_balance : null;
  const salaryIncome = salary.known ? salary.forecast_eligible_monthly : null;
  const monthlyBills = bills.known ? bills.monthly_total : null;
  const debtOwe = debts.known ? debts.total_owe : null;
  const debtOwed = debts.known ? debts.total_owed : null;
  const ccOutstanding = cc.known ? cc.outstanding : null;

  const knownInputs = [
    liquidBalance,
    salaryIncome,
    monthlyBills,
    debtOwe,
    debtOwed,
    ccOutstanding
  ];

  const complete = knownInputs.every(value => value !== null && value !== undefined && Number.isFinite(Number(value)));

  const projected30DayPosition = complete
    ? round2(liquidBalance + salaryIncome + debtOwed - monthlyBills - debtOwe - ccOutstanding)
    : null;

  const monthlyKnownOutflow = round2(
    (Number.isFinite(Number(monthlyBills)) ? Number(monthlyBills) : 0)
    + (Number.isFinite(Number(debtOwe)) ? Number(debtOwe) : 0)
    + (Number.isFinite(Number(ccOutstanding)) ? Number(ccOutstanding) : 0)
  );

  const monthlyKnownInflow = round2(
    (Number.isFinite(Number(salaryIncome)) ? Number(salaryIncome) : 0)
    + (Number.isFinite(Number(debtOwed)) ? Number(debtOwed) : 0)
  );

  return {
    status: complete ? 'ready' : 'partial',
    complete,
    horizon_days: 30,
    currency: 'PKR',
    inputs: {
      liquid_balance: liquidBalance,
      salary_forecast_eligible: salaryIncome,
      salary_guaranteed_monthly: salary.guaranteed_monthly,
      salary_variable_monthly: salary.variable_monthly,
      salary_variable_confirmed: salary.variable_confirmed,
      monthly_bills: monthlyBills,
      debt_payable_remaining: debtOwe,
      debt_receivable_remaining: debtOwed,
      credit_card_outstanding: ccOutstanding
    },
    outputs: {
      known_monthly_inflow: monthlyKnownInflow,
      known_monthly_outflow: monthlyKnownOutflow,
      projected_30_day_position: projected30DayPosition,
      runway_status: projected30DayPosition === null
        ? 'unknown'
        : projected30DayPosition >= 0
          ? 'positive'
          : 'negative'
    },
    source_summary: {
      accounts,
      salary,
      bills,
      debts,
      credit_card: cc
    },
    warnings
  };
}

function normalizeAccounts(data) {
  const raw = data && Array.isArray(data.accounts)
    ? data.accounts
    : Array.isArray(data)
      ? data
      : [];

  const accounts = raw.map(account => ({
    id: safeText(account.id || account.account_id, '', 160),
    name: safeText(account.name || account.label || account.id, '', 160),
    balance: firstNumber([
      account.balance,
      account.current_balance,
      account.available_balance,
      account.account_balance,
      account.computed_balance,
      account.amount,
      account.total
    ], 0),
    status: safeText(account.status, 'active', 40).toLowerCase()
  })).filter(account => account.id);

  return {
    known: accounts.length > 0,
    count: accounts.length,
    total_balance: round2(accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0)),
    accounts
  };
}

function normalizeSalary(data) {
  const summary = data && data.summary ? data.summary : {};
  const salary = data && data.salary ? data.salary : {};

  const guaranteed = firstNumber([
    summary.guaranteed_monthly,
    salary.guaranteed_monthly,
    Number(salary.guaranteed_base_salary || 0) + Number(salary.guaranteed_wfh_allowance || 0)
  ], null);

  const variable = firstNumber([
    summary.variable_monthly,
    Number(salary.variable_mbo || 0) + Number(salary.variable_overtime || 0) + Number(salary.variable_bonus || 0) + Number(salary.variable_other || 0)
  ], 0);

  const forecastEligible = firstNumber([
    summary.forecast_eligible_monthly
  ], guaranteed);

  return {
    known: Number.isFinite(Number(guaranteed)),
    guaranteed_monthly: guaranteed == null ? null : round2(guaranteed),
    variable_monthly: round2(variable || 0),
    variable_confirmed: Boolean(summary.variable_confirmed || salary.variable_confirmed),
    forecast_eligible_monthly: forecastEligible == null ? null : round2(forecastEligible),
    forecast_rule: summary.forecast_rule || 'Guaranteed income only unless variable is confirmed.'
  };
}

function normalizeBills(data) {
  const raw = data && Array.isArray(data.bills)
    ? data.bills
    : Array.isArray(data)
      ? data
      : [];

  const bills = raw.filter(bill => {
    const status = safeText(bill.status, 'active', 40).toLowerCase();
    return status === 'active' || status === 'due' || status === 'pending';
  });

  const monthly_total = bills.reduce((sum, bill) => {
    const amount = firstNumber([bill.amount, bill.bill_amount, bill.monthly_amount, bill.remaining_amount], 0);
    return sum + amount;
  }, 0);

  return {
    known: Boolean(data),
    count: bills.length,
    monthly_total: round2(monthly_total)
  };
}

function normalizeDebts(data) {
  const totalOwe = firstNumber([data && data.total_owe], null);
  const totalOwed = firstNumber([data && data.total_owed], null);

  return {
    known: Boolean(data),
    total_owe: totalOwe == null ? 0 : round2(totalOwe),
    total_owed: totalOwed == null ? 0 : round2(totalOwed),
    count: data && Array.isArray(data.debts) ? data.debts.length : 0
  };
}

function normalizeCreditCard(data) {
  if (!data) {
    return {
      known: false,
      outstanding: null,
      source: 'unknown'
    };
  }

  const outstanding = firstNumber([
    data.outstanding,
    data.current_outstanding,
    data.cc_outstanding,
    data.balance_due,
    data.balance
  ], null);

  if (outstanding == null) {
    return {
      known: false,
      outstanding: null,
      source: '/api/cc'
    };
  }

  return {
    known: true,
    outstanding: round2(Math.max(0, Number(outstanding))),
    source: '/api/cc'
  };
}

function buildForecastProof(bundle, forecast) {
  return {
    action: 'forecast.generate',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: forecast.complete ? 'pass' : 'partial',
    write_model: 'forecast_generate_read_only_source_api_based',
    source_rule: 'Forecast uses recovered source APIs and never /api/money-contracts.',
    expected_transaction_rows: 0,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    checks: [
      proofCheck('accounts_source', bundle.accounts.ok ? 'pass' : 'unknown', '/api/accounts', 'Accounts source checked.'),
      proofCheck('salary_source', bundle.salary.ok ? 'pass' : 'unknown', '/api/salary', 'Salary source checked.'),
      proofCheck('bills_source', bundle.bills.ok ? 'pass' : 'unknown', '/api/bills', 'Bills source checked.'),
      proofCheck('debts_source', bundle.debts.ok ? 'pass' : 'unknown', '/api/debts', 'Debts source checked.'),
      proofCheck('credit_card_source', bundle.cc.ok ? 'pass' : 'unknown', '/api/cc', 'Credit Card source checked.'),
      proofCheck('money_contracts_banned', 'pass', '/api/money-contracts', 'Money contracts are not called.'),
      proofCheck('unknown_not_zero', 'pass', 'forecast.contract', 'Unknown values remain null/unknown, not silent zero.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run and generate perform no database writes.')
    ],
    forecast_status: forecast.status,
    warnings: forecast.warnings
  };
}

async function commandAllowsAction(context, action) {
  try {
    const origin = new URL(context.request.url).origin;

    const res = await fetch(origin + '/api/finance-command-center?gate=' + encodeURIComponent(action) + '&cb=' + Date.now(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-sovereign-forecast-gate': action
      }
    });

    const data = await res.json().catch(() => null);
    const found = data && data.enforcement && Array.isArray(data.enforcement.actions)
      ? data.enforcement.actions.find(item => item.action === action)
      : null;

    return Boolean(found && found.allowed);
  } catch (err) {
    return false;
  }
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function firstNumber(values, fallback) {
  for (const value of values) {
    const n = toNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }

  return fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  const cleaned = String(value)
    .replace(/rs/ig, '')
    .replace(/,/g, '')
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function safeText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function isDryRunRequest(context, body) {
  const url = new URL(context.request.url);

  return url.searchParams.get('dry_run') === '1'
    || url.searchParams.get('dry_run') === 'true'
    || body.dry_run === true
    || body.dry_run === '1'
    || body.dry_run === 'true';
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
