/* /api/salary
 * Sovereign Finance · Salary Contract Source
 * v0.2.1-salary-contract-source-precision
 *
 * Phase 3 purpose:
 * - Salary is a saved backend contract, not page-only display state.
 * - Forecast reads salary from this contract.
 * - Saving salary must NOT mutate account balances or ledger.
 * - Preserve FX precision.
 * - Return whole-rupee computed salary values for Forecast/Hub consistency.
 */

const VERSION = 'v0.2.1-salary-contract-source-precision';
const CONTRACT_ID = 'salary_contract_current';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        }
      }, 500);
    }

    const tableOk = await tableExists(db, 'salary_contracts');

    if (!tableOk) {
      return json({
        ok: true,
        version: VERSION,
        source: 'salary_contract',
        contract: null,
        computed: emptyComputed(),
        forecast_source: disabledForecastSource('salary_contracts table missing'),
        salary: [],
        contract_health: {
          ok: false,
          reason: 'salary_contracts table missing'
        }
      });
    }

    const contract = await loadCurrentContract(db);
    const normalized = normalizeContract(contract || {});
    const computed = computeSalary(normalized);
    const forecastSource = buildForecastSource(normalized, computed);

    return json({
      ok: true,
      version: VERSION,
      source: 'salary_contract',
      contract: contract ? normalized : null,
      computed,
      forecast_source: forecastSource,
      salary: contract ? [normalized] : [],
      contract_health: {
        ok: Boolean(contract),
        saved_contract_exists: Boolean(contract),
        forecast_enabled: forecastSource.enabled,
        money_precision: 'whole_rupees_for_outputs',
        fx_precision: 'preserved_input_precision'
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'SALARY_GET_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const body = await readJson(context.request);
    const dryRun = isDryRun(url, body);

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        }
      }, 500);
    }

    const tableOk = await tableExists(db, 'salary_contracts');

    if (!tableOk) {
      return json({
        ok: false,
        version: VERSION,
        action: dryRun ? 'salary.contract.dry_run' : 'salary.contract.save',
        error: {
          code: 'SALARY_CONTRACTS_TABLE_MISSING',
          message: 'salary_contracts table does not exist.'
        }
      }, 500);
    }

    const contract = normalizeContract({
      id: CONTRACT_ID,
      effective_month: body.effective_month,
      basic: body.basic,
      hra: body.hra,
      medical: body.medical,
      utility: body.utility,
      contract_base: body.contract_base,
      wfh_usd: body.wfh_usd,
      wfh_fx_rate: body.wfh_fx_rate,
      include_wfh: body.include_wfh,
      other_allowance: body.other_allowance,
      deductions: body.deductions,
      payday: body.payday,
      payout_account_id: body.payout_account_id,
      include_in_forecast: body.include_in_forecast,
      notes: body.notes,
      updated_at: nowSql()
    });

    const validation = validateContract(contract);

    if (!validation.ok) {
      return json({
        ok: false,
        version: VERSION,
        action: dryRun ? 'salary.contract.dry_run' : 'salary.contract.save',
        error: validation.error,
        contract,
        computed: computeSalary(contract),
        forecast_source: disabledForecastSource(validation.error.message)
      }, 400);
    }

    const computed = computeSalary(contract);
    const forecastSource = buildForecastSource(contract, computed);

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        action: 'salary.contract.dry_run',
        dry_run: true,
        writes_performed: false,
        contract,
        computed,
        forecast_source: forecastSource,
        contract_health: {
          ok: true,
          would_save: true,
          money_precision: 'whole_rupees_for_outputs',
          fx_precision: 'preserved_input_precision'
        }
      });
    }

    await saveContract(db, contract);

    const saved = normalizeContract(await loadCurrentContract(db));
    const savedComputed = computeSalary(saved);
    const savedForecastSource = buildForecastSource(saved, savedComputed);

    return json({
      ok: true,
      version: VERSION,
      action: 'salary.contract.save',
      writes_performed: true,
      contract: saved,
      computed: savedComputed,
      forecast_source: savedForecastSource,
      salary: [saved],
      contract_health: {
        ok: true,
        saved_contract_exists: true,
        forecast_enabled: savedForecastSource.enabled,
        money_precision: 'whole_rupees_for_outputs',
        fx_precision: 'preserved_input_precision'
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'SALARY_POST_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

/* ─────────────────────────────
 * Data access
 * ───────────────────────────── */

async function loadCurrentContract(db) {
  const cols = await tableColumns(db, 'salary_contracts');
  const selectCols = Array.from(cols).join(', ');

  if (!selectCols) return null;

  let row = null;

  if (cols.has('id')) {
    row = await db.prepare(
      `SELECT ${selectCols}
       FROM salary_contracts
       WHERE id = ?
       LIMIT 1`
    ).bind(CONTRACT_ID).first();
  }

  if (row) return row;

  const orderBy = cols.has('updated_at')
    ? 'datetime(updated_at) DESC'
    : cols.has('effective_month')
      ? 'effective_month DESC'
      : 'rowid DESC';

  return db.prepare(
    `SELECT ${selectCols}
     FROM salary_contracts
     ORDER BY ${orderBy}
     LIMIT 1`
  ).first();
}

async function saveContract(db, contract) {
  const cols = await tableColumns(db, 'salary_contracts');

  if (!cols.size) {
    throw new Error('salary_contracts table has no readable columns');
  }

  const now = nowSql();

  const row = {
    id: CONTRACT_ID,
    effective_month: contract.effective_month,
    basic: contract.basic,
    hra: contract.hra,
    medical: contract.medical,
    utility: contract.utility,
    contract_base: contract.contract_base,
    wfh_usd: contract.wfh_usd,
    wfh_fx_rate: contract.wfh_fx_rate,
    include_wfh: boolToDb(contract.include_wfh),
    other_allowance: contract.other_allowance,
    deductions: contract.deductions,
    payday: contract.payday,
    payout_account_id: contract.payout_account_id,
    include_in_forecast: boolToDb(contract.include_in_forecast),
    notes: contract.notes,
    updated_at: now,
    created_at: now
  };

  const exists = cols.has('id')
    ? await db.prepare('SELECT id FROM salary_contracts WHERE id = ? LIMIT 1').bind(CONTRACT_ID).first()
    : null;

  if (exists) {
    const updateKeys = Object.keys(row).filter(key => key !== 'id' && cols.has(key));

    if (!updateKeys.length) {
      throw new Error('salary_contracts table has no supported columns to update');
    }

    await db.prepare(
      `UPDATE salary_contracts
       SET ${updateKeys.map(key => `${key} = ?`).join(', ')}
       WHERE id = ?`
    ).bind(...updateKeys.map(key => row[key]), CONTRACT_ID).run();

    return;
  }

  const insertKeys = Object.keys(row).filter(key => cols.has(key));

  if (!insertKeys.length) {
    throw new Error('salary_contracts table has no supported columns to insert');
  }

  await db.prepare(
    `INSERT INTO salary_contracts (${insertKeys.join(', ')})
     VALUES (${insertKeys.map(() => '?').join(', ')})`
  ).bind(...insertKeys.map(key => row[key])).run();
}

/* ─────────────────────────────
 * Contract normalization
 * ───────────────────────────── */

function normalizeContract(input) {
  const basic = wholeRupee(input.basic);
  const hra = wholeRupee(input.hra);
  const medical = wholeRupee(input.medical);
  const utility = wholeRupee(input.utility);

  const providedContractBase = numberOrNull(input.contract_base);
  const derivedContractBase = wholeRupee(basic + hra + medical + utility);
  const contractBase = providedContractBase == null
    ? derivedContractBase
    : wholeRupee(providedContractBase);

  const wfhUsd = decimalMoney(input.wfh_usd, 0, 6);
  const wfhFxRate = decimalMoney(input.wfh_fx_rate, 0, 6);

  return {
    id: safeText(input.id || CONTRACT_ID, CONTRACT_ID, 120),
    effective_month: normalizeEffectiveMonth(input.effective_month),
    basic,
    hra,
    medical,
    utility,
    contract_base: contractBase,
    wfh_usd: wfhUsd,
    wfh_fx_rate: wfhFxRate,
    include_wfh: toBool(input.include_wfh, false),
    other_allowance: wholeRupee(input.other_allowance),
    deductions: wholeRupee(input.deductions),
    payday: normalizePayday(input.payday),
    payout_account_id: safeText(input.payout_account_id || 'meezan', 'meezan', 120),
    include_in_forecast: toBool(input.include_in_forecast, true),
    notes: safeText(input.notes, '', 1000),
    updated_at: input.updated_at || null
  };
}

function validateContract(contract) {
  if (!contract.effective_month) {
    return {
      ok: false,
      error: {
        code: 'EFFECTIVE_MONTH_REQUIRED',
        message: 'effective_month is required in YYYY-MM format.'
      }
    };
  }

  if (!contract.payday || contract.payday < 1 || contract.payday > 31) {
    return {
      ok: false,
      error: {
        code: 'INVALID_PAYDAY',
        message: 'payday must be between 1 and 31.'
      }
    };
  }

  if (!contract.payout_account_id) {
    return {
      ok: false,
      error: {
        code: 'PAYOUT_ACCOUNT_REQUIRED',
        message: 'payout_account_id is required.'
      }
    };
  }

  if (contract.contract_base < 0 || contract.other_allowance < 0 || contract.deductions < 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_AMOUNT',
        message: 'Salary amounts cannot be negative.'
      }
    };
  }

  if (contract.include_wfh && (contract.wfh_usd <= 0 || contract.wfh_fx_rate <= 0)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_WFH',
        message: 'WFH USD and FX rate must be greater than 0 when include_wfh is true.'
      }
    };
  }

  return { ok: true };
}

/* ─────────────────────────────
 * Salary computation
 * ───────────────────────────── */

function computeSalary(contract) {
  const wfhRaw = contract.include_wfh
    ? decimal(contract.wfh_usd) * decimal(contract.wfh_fx_rate)
    : 0;

  const wfhAllowance = wholeRupee(wfhRaw);

  const gross = wholeRupee(
    contract.contract_base +
    wfhAllowance +
    contract.other_allowance
  );

  const net = wholeRupee(gross - contract.deductions);
  const expectedDate = expectedDateForMonth(contract.effective_month, contract.payday);

  return {
    basic: wholeRupee(contract.basic),
    hra: wholeRupee(contract.hra),
    medical: wholeRupee(contract.medical),
    utility: wholeRupee(contract.utility),
    contract_base: wholeRupee(contract.contract_base),
    wfh_usd: decimalMoney(contract.wfh_usd, 0, 6),
    wfh_fx_rate: decimalMoney(contract.wfh_fx_rate, 0, 6),
    wfh_allowance: wfhAllowance,
    include_wfh: Boolean(contract.include_wfh),
    other_allowance: wholeRupee(contract.other_allowance),
    deductions: wholeRupee(contract.deductions),
    gross,
    net,
    paid: 0,
    remaining: net,
    payday: contract.payday,
    expected_date: expectedDate,
    payout_account_id: contract.payout_account_id,
    include_in_forecast: Boolean(contract.include_in_forecast)
  };
}

function buildForecastSource(contract, computed) {
  const enabled = Boolean(
    contract &&
    contract.include_in_forecast &&
    computed &&
    computed.net > 0 &&
    contract.payout_account_id
  );

  if (!enabled) {
    let reason = 'salary contract not enabled for forecast';

    if (!contract) reason = 'no saved salary contract';
    else if (!contract.include_in_forecast) reason = 'salary excluded from forecast';
    else if (!computed || computed.net <= 0) reason = 'salary net amount is zero';
    else if (!contract.payout_account_id) reason = 'payout account missing';

    return disabledForecastSource(reason);
  }

  return {
    type: 'salary_income',
    source: 'salary_contract',
    enabled: true,
    monthly_salary_net: wholeRupee(computed.net),
    expected_income_amount: wholeRupee(computed.net),
    expected_payday: contract.payday,
    expected_date: computed.expected_date,
    payout_account_id: contract.payout_account_id,
    effective_month: contract.effective_month,
    version: VERSION,
    rule: 'Salary forecast source emits whole-rupee net salary from saved salary contract.'
  };
}

function disabledForecastSource(reason) {
  return {
    type: 'salary_income',
    source: 'salary_contract',
    enabled: false,
    monthly_salary_net: 0,
    expected_income_amount: 0,
    expected_payday: null,
    expected_date: null,
    payout_account_id: null,
    reason,
    version: VERSION
  };
}

function emptyComputed() {
  return {
    basic: 0,
    hra: 0,
    medical: 0,
    utility: 0,
    contract_base: 0,
    wfh_usd: 0,
    wfh_fx_rate: 0,
    wfh_allowance: 0,
    include_wfh: false,
    other_allowance: 0,
    deductions: 0,
    gross: 0,
    net: 0,
    paid: 0,
    remaining: 0,
    payday: null,
    expected_date: null,
    payout_account_id: null,
    include_in_forecast: false
  };
}

/* ─────────────────────────────
 * Helpers
 * ───────────────────────────── */

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(tableName).first();

    return Boolean(row && row.name);
  } catch {
    return false;
  }
}

async function tableColumns(db, tableName) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((result.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isDryRun(url, body) {
  return url.searchParams.get('dry_run') === '1' ||
    url.searchParams.get('dry_run') === 'true' ||
    body.dry_run === true ||
    body.dry_run === '1' ||
    body.dry_run === 'true';
}

function normalizeEffectiveMonth(value) {
  const raw = safeText(value, '', 20);

  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7);

  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  return `${now.getUTCFullYear()}-${month}`;
}

function normalizePayday(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 1;

  return Math.min(31, Math.max(1, Math.floor(n)));
}

function expectedDateForMonth(effectiveMonth, payday) {
  const month = normalizeEffectiveMonth(effectiveMonth);
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(normalizePayday(payday), maxDay);

  return `${month}-${String(day).padStart(2, '0')}`;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(String(value).replace(/,/g, '').trim());

  return Number.isFinite(n) ? n : null;
}

function decimal(value) {
  const n = numberOrNull(value);

  return n == null ? 0 : n;
}

function decimalMoney(value, fallback = 0, places = 6) {
  const n = numberOrNull(value);

  if (n == null) return fallback;

  const factor = Math.pow(10, places);

  return Math.round(n * factor) / factor;
}

function wholeRupee(value) {
  const n = numberOrNull(value);

  if (n == null) return 0;

  return Math.round(n);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(raw)) return false;

  return fallback;
}

function boolToDb(value) {
  return value ? 1 : 0;
}

function safeText(value, fallback = '', max = 500) {
  const raw = value === undefined || value === null ? fallback : value;

  return String(raw === undefined || raw === null ? '' : raw).trim().slice(0, max);
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
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
