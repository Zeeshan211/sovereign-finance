/* Sovereign Finance Salary API
 * /api/salary
 * v0.2.0-salary-contract-source
 *
 * Purpose:
 * - Salary is not just a display page.
 * - Salary contract is an input/source-of-truth for Forecast.
 * - GET returns saved contract + computed salary summary.
 * - POST /api/salary?dry_run=1 validates/calculates without writing.
 * - POST /api/salary saves the contract.
 */

const VERSION = 'v0.2.0-salary-contract-source';

export async function onRequestGet(context) {
  return withJsonErrors('GET', async () => {
    const db = context.env.DB;
    await ensureSalaryTable(db);

    const contract = await latestContract(db);
    const normalized = normalizeContract(contract || defaultContract());
    const computed = computeSalary(normalized);

    return json({
      ok: true,
      version: VERSION,
      source: 'salary_contract',
      contract: normalized,
      computed,
      forecast_source: buildForecastSource(normalized, computed),

      /* Backward-compatible shape for current salary.html normalizer */
      salary: [
        {
          id: normalized.id,
          effective_month: normalized.effective_month,
          month: normalized.effective_month,
          basic: normalized.basic,
          hra: normalized.hra,
          medical: normalized.medical,
          utility: normalized.utility,
          contract_base: normalized.contract_base,
          wfh_usd: normalized.wfh_usd,
          wfh_fx_rate: normalized.wfh_fx_rate,
          wfh_allowance: computed.wfh_allowance,
          include_wfh: normalized.include_wfh,
          other_allowance: normalized.other_allowance,
          deductions: normalized.deductions,
          total_deductions: normalized.deductions,
          gross: computed.gross,
          net: computed.net,
          net_payable: computed.net,
          paid_amount: 0,
          remaining_amount: computed.net,
          payday: normalized.payday,
          expected_date: computed.expected_date,
          account_id: normalized.payout_account_id,
          status: normalized.include_in_forecast ? 'forecast source' : 'disabled',
          notes: normalized.notes
        }
      ],

      summary: {
        gross: computed.gross,
        deductions: normalized.deductions,
        net: computed.net,
        remaining: computed.net,
        current_month: normalized.effective_month,
        expected_date: computed.expected_date
      }
    });
  });
}

export async function onRequestPost(context) {
  return withJsonErrors('POST', async () => {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const dryRun = url.searchParams.get('dry_run') === '1' || url.searchParams.get('dry_run') === 'true';

    await ensureSalaryTable(db);

    const body = await readJSON(context.request);
    const normalized = normalizeContract({
      ...body,
      id: body.id || 'salary_contract_current'
    });

    const validation = validateContract(normalized);
    const computed = computeSalary(normalized);

    if (!validation.ok) {
      return json({
        ok: false,
        version: VERSION,
        action: 'salary.contract.save',
        dry_run: dryRun,
        error: validation.error,
        contract: normalized,
        computed
      }, 400);
    }

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        action: 'salary.contract.dry_run',
        dry_run: true,
        writes_performed: false,
        contract: normalized,
        computed,
        forecast_source: buildForecastSource(normalized, computed)
      });
    }

    await db.prepare(
      `INSERT OR REPLACE INTO salary_contracts (
        id,
        effective_month,
        basic,
        hra,
        medical,
        utility,
        contract_base,
        wfh_usd,
        wfh_fx_rate,
        include_wfh,
        other_allowance,
        deductions,
        payday,
        payout_account_id,
        include_in_forecast,
        notes,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(
      normalized.id,
      normalized.effective_month,
      normalized.basic,
      normalized.hra,
      normalized.medical,
      normalized.utility,
      normalized.contract_base,
      normalized.wfh_usd,
      normalized.wfh_fx_rate,
      normalized.include_wfh ? 1 : 0,
      normalized.other_allowance,
      normalized.deductions,
      normalized.payday,
      normalized.payout_account_id,
      normalized.include_in_forecast ? 1 : 0,
      normalized.notes
    ).run();

    const saved = normalizeContract(await latestContract(db));
    const savedComputed = computeSalary(saved);

    return json({
      ok: true,
      version: VERSION,
      action: 'salary.contract.save',
      writes_performed: true,
      contract: saved,
      computed: savedComputed,
      forecast_source: buildForecastSource(saved, savedComputed)
    });
  });
}

/* ─────────────────────────────
 * Table + persistence
 * ───────────────────────────── */

async function ensureSalaryTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS salary_contracts (
      id TEXT PRIMARY KEY,
      effective_month TEXT NOT NULL,
      basic REAL NOT NULL DEFAULT 0,
      hra REAL NOT NULL DEFAULT 0,
      medical REAL NOT NULL DEFAULT 0,
      utility REAL NOT NULL DEFAULT 0,
      contract_base REAL NOT NULL DEFAULT 0,
      wfh_usd REAL NOT NULL DEFAULT 0,
      wfh_fx_rate REAL NOT NULL DEFAULT 0,
      include_wfh INTEGER NOT NULL DEFAULT 1,
      other_allowance REAL NOT NULL DEFAULT 0,
      deductions REAL NOT NULL DEFAULT 0,
      payday INTEGER NOT NULL DEFAULT 1,
      payout_account_id TEXT NOT NULL DEFAULT '',
      include_in_forecast INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
}

async function latestContract(db) {
  return db.prepare(
    `SELECT *
     FROM salary_contracts
     ORDER BY datetime(updated_at) DESC
     LIMIT 1`
  ).first();
}

/* ─────────────────────────────
 * Normalize / validate / compute
 * ───────────────────────────── */

function defaultContract() {
  return {
    id: 'salary_contract_current',
    effective_month: currentMonth(),
    basic: 0,
    hra: 0,
    medical: 0,
    utility: 0,
    contract_base: 0,
    wfh_usd: 30,
    wfh_fx_rate: 279.233333,
    include_wfh: true,
    other_allowance: 0,
    deductions: 0,
    payday: 1,
    payout_account_id: 'meezan',
    include_in_forecast: true,
    notes: ''
  };
}

function normalizeContract(input) {
  const fallback = defaultContract();
  const basic = moneyNumber(input.basic, fallback.basic);
  const hra = moneyNumber(input.hra, fallback.hra);
  const medical = moneyNumber(input.medical, fallback.medical);
  const utility = moneyNumber(input.utility, fallback.utility);

  const explicitContractBase = moneyNumber(input.contract_base, NaN);
  const contractBase = Number.isFinite(explicitContractBase)
    ? explicitContractBase
    : round2(basic + hra + medical + utility);

  return {
    id: safeText(input.id || fallback.id, fallback.id, 120),
    effective_month: normalizeMonth(input.effective_month || input.month || fallback.effective_month),
    basic,
    hra,
    medical,
    utility,
    contract_base: contractBase,
    wfh_usd: moneyNumber(input.wfh_usd, fallback.wfh_usd),
    wfh_fx_rate: moneyNumber(input.wfh_fx_rate, fallback.wfh_fx_rate),
    include_wfh: boolValue(input.include_wfh, fallback.include_wfh),
    other_allowance: moneyNumber(input.other_allowance, fallback.other_allowance),
    deductions: moneyNumber(input.deductions || input.total_deductions, fallback.deductions),
    payday: clampInt(input.payday || input.due_day || input.expected_day, fallback.payday, 1, 31),
    payout_account_id: safeText(input.payout_account_id || input.account_id || fallback.payout_account_id, fallback.payout_account_id, 120),
    include_in_forecast: boolValue(input.include_in_forecast, fallback.include_in_forecast),
    notes: safeText(input.notes, '', 1000),
    updated_at: input.updated_at || null
  };
}

function validateContract(contract) {
  if (!contract.effective_month) return { ok: false, error: 'effective_month required' };
  if (contract.payday < 1 || contract.payday > 31) return { ok: false, error: 'payday must be 1-31' };
  if (!contract.payout_account_id) return { ok: false, error: 'payout_account_id required' };

  const fields = [
    'basic',
    'hra',
    'medical',
    'utility',
    'contract_base',
    'wfh_usd',
    'wfh_fx_rate',
    'other_allowance',
    'deductions'
  ];

  for (const field of fields) {
    if (!Number.isFinite(Number(contract[field])) || Number(contract[field]) < 0) {
      return { ok: false, error: `${field} must be 0 or greater` };
    }
  }

  return { ok: true };
}

function computeSalary(contract) {
  const wfhAllowance = contract.include_wfh
    ? round2(contract.wfh_usd * contract.wfh_fx_rate)
    : 0;

  const gross = round2(contract.contract_base + wfhAllowance + contract.other_allowance);
  const net = round2(Math.max(0, gross - contract.deductions));
  const expectedDate = expectedDateForMonth(contract.effective_month, contract.payday);

  return {
    basic: contract.basic,
    hra: contract.hra,
    medical: contract.medical,
    utility: contract.utility,
    contract_base: contract.contract_base,
    wfh_allowance: wfhAllowance,
    other_allowance: contract.other_allowance,
    gross,
    deductions: contract.deductions,
    net,
    paid: 0,
    remaining: net,
    payday: contract.payday,
    expected_date: expectedDate,
    payout_account_id: contract.payout_account_id,
    include_in_forecast: contract.include_in_forecast
  };
}

function buildForecastSource(contract, computed) {
  return {
    type: 'salary_income',
    source: 'salary_contract',
    enabled: Boolean(contract.include_in_forecast),
    monthly_salary_net: computed.net,
    expected_income_amount: computed.net,
    expected_payday: contract.payday,
    expected_date: computed.expected_date,
    payout_account_id: contract.payout_account_id,
    effective_month: contract.effective_month,
    description: 'Expected monthly salary income from saved salary contract.'
  };
}

/* ─────────────────────────────
 * Helpers
 * ───────────────────────────── */

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function withJsonErrors(method, fn) {
  try {
    return await fn();
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      method,
      error: err.message || String(err),
      stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 6).join('\n')
    }, 500);
  }
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

function safeText(value, fallback = '', max = 500) {
  const raw = value == null || value === '' ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function moneyNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? round2(n) : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  return ['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function normalizeMonth(value) {
  const raw = safeText(value, currentMonth(), 40);

  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7);

  return currentMonth();
}

function expectedDateForMonth(month, payday) {
  const normalized = normalizeMonth(month);
  const [yearText, monthText] = normalized.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Number(payday || 1)), maxDay);

  return `${normalized}-${String(day).padStart(2, '0')}`;
}