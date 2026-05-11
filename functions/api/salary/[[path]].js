/* /api/salary — GET/POST */
/* Sovereign Finance v0.2.0-salary-truth
 *
 * Shipment 7:
 * - Salary is its own truth source.
 * - Guaranteed income is forecast-eligible.
 * - Variable income is excluded unless variable_confirmed=true.
 * - No Command Centre dependency.
 * - Schema-safe enough for current D1 setup.
 */

const VERSION = "v0.2.0-salary-truth";

const DEFAULT_SALARY = {
  id: "primary",
  guaranteed_monthly: 111333.34,
  variable_monthly: 0,
  variable_confirmed: false,
  notes: ""
};

export async function onRequestGet(context) {
  try {
    const db = context.env?.DB || null;
    const row = db ? await readSalaryRow(db) : null;
    const salary = normalizeSalary(row || DEFAULT_SALARY);

    return json({
      ok: true,
      version: VERSION,
      salary,
      guaranteed_monthly: salary.guaranteed_monthly,
      variable_monthly: salary.variable_monthly,
      variable_confirmed: salary.variable_confirmed,
      forecast_eligible_monthly: salary.forecast_eligible_monthly,
      contract: {
        source_of_truth: "/api/salary",
        forecast_rule: "guaranteed_monthly + variable_monthly only when variable_confirmed=true",
        command_centre_used: false
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env?.DB || null;
    if (!db) throw new Error("D1 binding DB is missing.");

    await ensureSalaryTable(db);

    const body = await readJson(context.request);
    const existing = await readSalaryRow(db);

    const guaranteed = numberOr(body.guaranteed_monthly ?? body.guaranteed ?? body.base_salary, existing?.guaranteed_monthly ?? DEFAULT_SALARY.guaranteed_monthly);
    const variable = numberOr(body.variable_monthly ?? body.variable ?? body.bonus ?? body.commission, existing?.variable_monthly ?? DEFAULT_SALARY.variable_monthly);
    const variableConfirmed = booleanOr(body.variable_confirmed, existing?.variable_confirmed ?? DEFAULT_SALARY.variable_confirmed);
    const notes = clean(body.notes ?? existing?.notes ?? "");
    const now = new Date().toISOString();

    if (guaranteed < 0) throw new Error("guaranteed_monthly cannot be negative.");
    if (variable < 0) throw new Error("variable_monthly cannot be negative.");

    const row = {
      id: "primary",
      guaranteed_monthly: round2(guaranteed),
      variable_monthly: round2(variable),
      variable_confirmed: variableConfirmed ? 1 : 0,
      notes,
      updated_at: now
    };

    await db.prepare(`
      INSERT INTO salary_config
        (id, guaranteed_monthly, variable_monthly, variable_confirmed, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        guaranteed_monthly = excluded.guaranteed_monthly,
        variable_monthly = excluded.variable_monthly,
        variable_confirmed = excluded.variable_confirmed,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).bind(
      row.id,
      row.guaranteed_monthly,
      row.variable_monthly,
      row.variable_confirmed,
      row.notes,
      row.updated_at
    ).run();

    const salary = normalizeSalary(await readSalaryRow(db));

    return json({
      ok: true,
      version: VERSION,
      salary,
      guaranteed_monthly: salary.guaranteed_monthly,
      variable_monthly: salary.variable_monthly,
      variable_confirmed: salary.variable_confirmed,
      forecast_eligible_monthly: salary.forecast_eligible_monthly,
      contract: {
        forecast_rule: "guaranteed_monthly + variable_monthly only when variable_confirmed=true",
        command_centre_used: false
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function ensureSalaryTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS salary_config (
      id TEXT PRIMARY KEY,
      guaranteed_monthly REAL NOT NULL DEFAULT 0,
      variable_monthly REAL NOT NULL DEFAULT 0,
      variable_confirmed INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function readSalaryRow(db) {
  try {
    await ensureSalaryTable(db);

    const row = await db.prepare(`
      SELECT id, guaranteed_monthly, variable_monthly, variable_confirmed, notes, updated_at
      FROM salary_config
      WHERE id = 'primary'
      LIMIT 1
    `).first();

    return row || null;
  } catch (err) {
    return null;
  }
}

function normalizeSalary(row) {
  const guaranteed = round2(numberOr(row?.guaranteed_monthly, DEFAULT_SALARY.guaranteed_monthly));
  const variable = round2(numberOr(row?.variable_monthly, DEFAULT_SALARY.variable_monthly));
  const confirmed = Boolean(Number(row?.variable_confirmed || 0));
  const forecastEligible = round2(guaranteed + (confirmed ? variable : 0));

  return {
    id: clean(row?.id || "primary"),
    guaranteed_monthly: guaranteed,
    variable_monthly: variable,
    variable_confirmed: confirmed,
    forecast_eligible_monthly: forecastEligible,
    notes: clean(row?.notes || ""),
    updated_at: row?.updated_at || null
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function booleanOr(value, fallback) {
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  if (value === true || value === 1) return true;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "confirmed"].includes(text);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
