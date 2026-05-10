/* Sovereign Finance Salary API v0.1.0
   /api/salary

   Contract:
   - GET returns current salary profile.
   - POST dry_run validates salary profile and performs no write.
   - POST real save asks Command Centre before writing.
   - Salary separates guaranteed income from variable income.
   - Forecast should use guaranteed income unless variable income is explicitly confirmed.
   - No fake entries.
   - No /api/money-contracts.
*/

const VERSION = 'v0.1.0';

const DEFAULT_PROFILE = {
  id: 'salary_profile_main',
  currency: 'PKR',
  pay_frequency: 'monthly',
  guaranteed_base_salary: 111333.34,
  guaranteed_wfh_allowance: 0,
  variable_mbo: 0,
  variable_overtime: 0,
  variable_bonus: 0,
  variable_other: 0,
  variable_confirmed: false,
  next_pay_date: null,
  notes: '',
  updated_at: null
};

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const profile = await readSalaryProfile(db);

    return jsonResponse({
      ok: true,
      version: VERSION,
      salary: profile,
      summary: summarizeSalary(profile),
      source_rule: 'Forecast may use guaranteed income only unless variable income is explicitly confirmed.'
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
    const db = context.env.DB;
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);

    const validation = buildSalaryPayload(body);

    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action: 'salary.save',
        error: validation.error
      }, 400);
    }

    const payload = validation.payload;
    const proof = buildSalaryProof(payload);

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'salary.save',
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: payload,
        summary: summarizeSalary(payload)
      });
    }

    const allowed = await commandAllowsAction(context, 'salary.save');

    if (!allowed) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Command Centre blocked salary save',
        action: 'salary.save',
        dry_run: false,
        writes_performed: false,
        audit_performed: false,
        enforcement: {
          action: 'salary.save',
          allowed: false,
          status: 'blocked',
          reason: 'salary.save real write blocked by Command Centre.',
          source: 'coverage.write_safety.salary',
          backend_enforced: true
        },
        proof
      }, 423);
    }

    await ensureSalaryTable(db);
    await saveSalaryProfile(db, payload);

    const saved = await readSalaryProfile(db);

    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'salary.save',
      writes_performed: true,
      audit_performed: false,
      salary: saved,
      summary: summarizeSalary(saved),
      proof
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function readSalaryProfile(db) {
  try {
    const row = await db.prepare(
      `SELECT
         id,
         currency,
         pay_frequency,
         guaranteed_base_salary,
         guaranteed_wfh_allowance,
         variable_mbo,
         variable_overtime,
         variable_bonus,
         variable_other,
         variable_confirmed,
         next_pay_date,
         notes,
         updated_at
       FROM salary_profile
       WHERE id = ?
       LIMIT 1`
    ).bind(DEFAULT_PROFILE.id).first();

    if (!row) return { ...DEFAULT_PROFILE };

    return normalizeSalaryProfile(row);
  } catch (err) {
    return { ...DEFAULT_PROFILE };
  }
}

async function ensureSalaryTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS salary_profile (
       id TEXT PRIMARY KEY,
       currency TEXT,
       pay_frequency TEXT,
       guaranteed_base_salary REAL,
       guaranteed_wfh_allowance REAL,
       variable_mbo REAL,
       variable_overtime REAL,
       variable_bonus REAL,
       variable_other REAL,
       variable_confirmed INTEGER,
       next_pay_date TEXT,
       notes TEXT,
       updated_at TEXT
     )`
  ).run();
}

async function saveSalaryProfile(db, payload) {
  await db.prepare(
    `INSERT INTO salary_profile
     (id, currency, pay_frequency, guaranteed_base_salary, guaranteed_wfh_allowance, variable_mbo, variable_overtime, variable_bonus, variable_other, variable_confirmed, next_pay_date, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       currency = excluded.currency,
       pay_frequency = excluded.pay_frequency,
       guaranteed_base_salary = excluded.guaranteed_base_salary,
       guaranteed_wfh_allowance = excluded.guaranteed_wfh_allowance,
       variable_mbo = excluded.variable_mbo,
       variable_overtime = excluded.variable_overtime,
       variable_bonus = excluded.variable_bonus,
       variable_other = excluded.variable_other,
       variable_confirmed = excluded.variable_confirmed,
       next_pay_date = excluded.next_pay_date,
       notes = excluded.notes,
       updated_at = datetime('now')`
  ).bind(
    payload.id,
    payload.currency,
    payload.pay_frequency,
    payload.guaranteed_base_salary,
    payload.guaranteed_wfh_allowance,
    payload.variable_mbo,
    payload.variable_overtime,
    payload.variable_bonus,
    payload.variable_other,
    payload.variable_confirmed ? 1 : 0,
    payload.next_pay_date,
    payload.notes
  ).run();
}

function buildSalaryPayload(body) {
  const currency = safeText(body.currency, 'PKR', 12).toUpperCase();
  const payFrequency = safeText(body.pay_frequency, 'monthly', 40).toLowerCase();

  const guaranteedBaseSalary = toNumber(body.guaranteed_base_salary ?? body.base_salary, DEFAULT_PROFILE.guaranteed_base_salary);
  const guaranteedWfhAllowance = toNumber(body.guaranteed_wfh_allowance ?? body.wfh_allowance, 0);
  const variableMbo = toNumber(body.variable_mbo ?? body.mbo, 0);
  const variableOvertime = toNumber(body.variable_overtime ?? body.overtime, 0);
  const variableBonus = toNumber(body.variable_bonus ?? body.bonus, 0);
  const variableOther = toNumber(body.variable_other ?? body.other_variable, 0);
  const variableConfirmed = body.variable_confirmed === true || body.variable_confirmed === 'true' || body.variable_confirmed === '1';
  const nextPayDate = normalizeDate(body.next_pay_date || body.pay_date);
  const notes = safeText(body.notes, '', 1000);

  if (!['monthly', 'weekly', 'biweekly', 'yearly', 'custom'].includes(payFrequency)) {
    return { ok: false, error: 'Invalid pay_frequency' };
  }

  const values = [
    guaranteedBaseSalary,
    guaranteedWfhAllowance,
    variableMbo,
    variableOvertime,
    variableBonus,
    variableOther
  ];

  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    return { ok: false, error: 'Salary amounts must be 0 or greater' };
  }

  if (guaranteedBaseSalary <= 0) {
    return { ok: false, error: 'Guaranteed base salary must be greater than 0' };
  }

  return {
    ok: true,
    payload: {
      id: DEFAULT_PROFILE.id,
      currency,
      pay_frequency: payFrequency,
      guaranteed_base_salary: round2(guaranteedBaseSalary),
      guaranteed_wfh_allowance: round2(guaranteedWfhAllowance),
      variable_mbo: round2(variableMbo),
      variable_overtime: round2(variableOvertime),
      variable_bonus: round2(variableBonus),
      variable_other: round2(variableOther),
      variable_confirmed: variableConfirmed,
      next_pay_date: nextPayDate,
      notes,
      updated_at: null
    }
  };
}

function normalizeSalaryProfile(row) {
  return {
    id: safeText(row.id, DEFAULT_PROFILE.id, 160),
    currency: safeText(row.currency, 'PKR', 12).toUpperCase(),
    pay_frequency: safeText(row.pay_frequency, 'monthly', 40).toLowerCase(),
    guaranteed_base_salary: round2(toNumber(row.guaranteed_base_salary, DEFAULT_PROFILE.guaranteed_base_salary)),
    guaranteed_wfh_allowance: round2(toNumber(row.guaranteed_wfh_allowance, 0)),
    variable_mbo: round2(toNumber(row.variable_mbo, 0)),
    variable_overtime: round2(toNumber(row.variable_overtime, 0)),
    variable_bonus: round2(toNumber(row.variable_bonus, 0)),
    variable_other: round2(toNumber(row.variable_other, 0)),
    variable_confirmed: row.variable_confirmed === 1 || row.variable_confirmed === true || row.variable_confirmed === 'true',
    next_pay_date: normalizeDate(row.next_pay_date),
    notes: safeText(row.notes, '', 1000),
    updated_at: row.updated_at || null
  };
}

function summarizeSalary(profile) {
  const guaranteed_monthly = round2(
    toNumber(profile.guaranteed_base_salary, 0)
    + toNumber(profile.guaranteed_wfh_allowance, 0)
  );

  const variable_monthly = round2(
    toNumber(profile.variable_mbo, 0)
    + toNumber(profile.variable_overtime, 0)
    + toNumber(profile.variable_bonus, 0)
    + toNumber(profile.variable_other, 0)
  );

  const forecast_eligible_monthly = profile.variable_confirmed
    ? round2(guaranteed_monthly + variable_monthly)
    : guaranteed_monthly;

  return {
    currency: profile.currency || 'PKR',
    pay_frequency: profile.pay_frequency || 'monthly',
    guaranteed_monthly,
    variable_monthly,
    variable_confirmed: Boolean(profile.variable_confirmed),
    forecast_eligible_monthly,
    forecast_rule: profile.variable_confirmed
      ? 'Forecast may include guaranteed + confirmed variable income.'
      : 'Forecast may include guaranteed income only.'
  };
}

function buildSalaryProof(profile) {
  const summary = summarizeSalary(profile);

  return {
    action: 'salary.save',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'salary_profile_command_centre_gated',
    expected_salary_rows: 1,
    expected_transaction_rows: 0,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      guaranteed_monthly: summary.guaranteed_monthly,
      variable_monthly: summary.variable_monthly,
      variable_confirmed: summary.variable_confirmed,
      forecast_eligible_monthly: summary.forecast_eligible_monthly
    },
    checks: [
      proofCheck('base_salary_valid', 'pass', 'request.guaranteed_base_salary', 'Guaranteed base salary is greater than 0.'),
      proofCheck('amounts_valid', 'pass', 'request.amounts', 'All salary amounts are 0 or greater.'),
      proofCheck('forecast_rule_valid', 'pass', 'computed.forecast_rule', summary.forecast_rule),
      proofCheck('command_gate_required', 'pass', 'finance-command-center', 'Real salary save asks Command Centre before writing.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before saving salary profile.')
    ]
  };
}

async function commandAllowsAction(context, action) {
  try {
    const origin = new URL(context.request.url).origin;

    const res = await fetch(origin + '/api/finance-command-center?gate=' + encodeURIComponent(action) + '&cb=' + Date.now(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-sovereign-salary-gate': action
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

function normalizeDate(value) {
  const raw = safeText(value, '', 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
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

function isDryRunRequest(context, body) {
  const url = new URL(context.request.url);

  return url.searchParams.get('dry_run') === '1'
    || url.searchParams.get('dry_run') === 'true'
    || body.dry_run === true
    || body.dry_run === '1'
    || body.dry_run === 'true';
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

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
