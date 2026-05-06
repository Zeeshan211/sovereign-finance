/* ─── /api/salary/[[path]] · v0.2.2 · Layer 2 salary data contract ─── */
/*
 * Handles:
 *   GET  /api/salary
 *   GET  /api/salary?month=YYYY-MM
 *   GET  /api/salary/detect?month=YYYY-MM
 *   POST /api/salary/recategorize
 *
 * Layer 2 contract:
 *   - Salary API must not depend only on category_id='salary'.
 *   - Migrated salary rows may be category_id NULL but identifiable by notes.
 *   - Active rows exclude D1 reversals and Sheet-imported reversal markers.
 *   - Response includes stable summary fields so UI does not render NaN/zero components.
 *   - Recategorize snapshots before mutation.
 *   - Audit failure does not break successful recategorization.
 */

import { json, audit, snapshot } from '../_lib.js';

const VERSION = 'v0.2.2';

const SOURCE_ACCOUNT = 'meezan';
const FORECAST_NET = 154750;
const TOLERANCE_PCT = 30;

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method.toUpperCase();

  try {
    if (segments.length === 0 && method === 'GET') {
      return listSalaryContract(env, request);
    }

    if (segments.length === 1 && segments[0] === 'detect' && method === 'GET') {
      return detectSalaryCandidates(env, request);
    }

    if (segments.length === 1 && segments[0] === 'recategorize' && method === 'POST') {
      return recategorizeSalary(env, request);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Not found. Available: GET /api/salary, GET /api/salary/detect, POST /api/salary/recategorize'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function listSalaryContract(env, request) {
  const db = env.DB;
  const url = new URL(request.url);
  const month = (url.searchParams.get('month') || nowMonthYM()).slice(0, 7);
  const { start, end } = monthRange(month);

  const rowsResult = await db.prepare(
    `SELECT id, date, amount, account_id, category_id, notes,
            reversed_by, reversed_at, linked_txn_id, created_at
     FROM transactions
     WHERE type = 'income'
       AND account_id = ?
       AND date BETWEEN ? AND ?
     ORDER BY date DESC, datetime(created_at) DESC, id DESC`
  ).bind(SOURCE_ACCOUNT, start, end).all();

  const allIncomeRows = rowsResult.results || [];
  const activeIncomeRows = allIncomeRows.filter(t => !isReversalRow(t));
  const salaryRows = activeIncomeRows.filter(isSalaryLikeRow);

  const salaries = salaryRows.map(row => normalizeSalaryRow(row));
  const totalSalary = round2(salaries.reduce((sum, row) => sum + (Number(row.amount) || 0), 0));

  const primary = salaries.length
    ? salaries.slice().sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0]
    : null;

  const diffAmt = primary ? round2(Math.abs((Number(primary.amount) || 0) - FORECAST_NET)) : null;
  const diffPct = primary ? round1((diffAmt / FORECAST_NET) * 100) : null;

  return json({
    ok: true,
    version: VERSION,
    month,
    source_account: SOURCE_ACCOUNT,

    forecast_net: FORECAST_NET,
    tolerance_pct: TOLERANCE_PCT,

    count: salaries.length,
    component_count: salaries.length,
    total_salary: totalSalary,
    total_detected: totalSalary,

    primary_salary: primary,
    diff_amount: diffAmt,
    diff_pct: diffPct,
    confidence: primary ? classifyConfidence(diffPct) : 'none',

    components: salaries,
    salaries,

    fields: buildFieldSummary(primary, totalSalary, salaries.length),

    debug: {
      income_rows_in_month: allIncomeRows.length,
      active_income_rows_in_month: activeIncomeRows.length,
      hidden_reversal_rows_in_month: allIncomeRows.length - activeIncomeRows.length,
      salary_like_rows: salaries.length,
      detection_rule: 'category_id salary OR notes contains salary/payslip/forecast net',
      reversal_bridge: 'reversed_by/reversed_at columns plus Sheet notes markers'
    }
  });
}

async function detectSalaryCandidates(env, request) {
  const db = env.DB;
  const url = new URL(request.url);
  const month = (url.searchParams.get('month') || nowMonthYM()).slice(0, 7);
  const { start, end } = monthRange(month);

  const minAmt = FORECAST_NET * (1 - TOLERANCE_PCT / 100);
  const maxAmt = FORECAST_NET * (1 + TOLERANCE_PCT / 100);

  const result = await db.prepare(
    `SELECT id, date, amount, account_id, category_id, notes,
            reversed_by, reversed_at, linked_txn_id, created_at
     FROM transactions
     WHERE type = 'income'
       AND account_id = ?
       AND amount BETWEEN ? AND ?
       AND date BETWEEN ? AND ?
     ORDER BY date DESC, amount DESC, datetime(created_at) DESC`
  ).bind(SOURCE_ACCOUNT, minAmt, maxAmt, start, end).all();

  const rows = (result.results || []).filter(t => !isReversalRow(t));

  const candidates = rows.map(t => {
    const diffAmt = Math.abs((Number(t.amount) || 0) - FORECAST_NET);
    const diffPct = (diffAmt / FORECAST_NET) * 100;

    return {
      ...normalizeSalaryRow(t),
      diff_amount: round2(diffAmt),
      diff_pct: round1(diffPct),
      confidence: classifyConfidence(diffPct),
      is_already_salary: String(t.category_id || '').toLowerCase() === 'salary' || isSalaryLikeRow(t)
    };
  });

  return json({
    ok: true,
    version: VERSION,
    month,
    source_account: SOURCE_ACCOUNT,
    forecast_net: FORECAST_NET,
    tolerance_pct: TOLERANCE_PCT,
    range: {
      min: Math.round(minAmt),
      max: Math.round(maxAmt)
    },
    candidates,
    count: candidates.length
  });
}

async function recategorizeSalary(env, request) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  const month = (body.month || nowMonthYM()).slice(0, 7);
  const txnIds = Array.isArray(body.txn_ids) ? body.txn_ids : [];
  const createdBy = body.created_by || 'web-salary-recat';

  if (txnIds.length === 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'txn_ids array required (non-empty)'
    }, 400);
  }

  const snap = await safeSnapshot(env, 'pre-salary-recat-' + month + '-' + Date.now(), createdBy);
  if (!snap.ok) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Snapshot failed: ' + snap.error
    }, 500);
  }

  const updates = [];
  const failures = [];

  for (const id of txnIds) {
    try {
      const before = await db.prepare(
        `SELECT id, type, account_id, category_id, notes, amount, reversed_by, reversed_at
         FROM transactions
         WHERE id = ?`
      ).bind(id).first();

      if (!before) {
        failures.push({ id, error: 'Not found' });
        continue;
      }

      if (isReversalRow(before)) {
        failures.push({ id, error: 'Cannot recategorize reversal row' });
        continue;
      }

      if (String(before.type || '').toLowerCase() !== 'income') {
        failures.push({ id, error: 'Only income transactions can be salary' });
        continue;
      }

      if (before.account_id !== SOURCE_ACCOUNT) {
        failures.push({ id, error: 'Salary source account must be ' + SOURCE_ACCOUNT });
        continue;
      }

      const newNotes = buildSalaryNotes(before.notes, month);

      await db.prepare(
        `UPDATE transactions
         SET category_id = 'salary',
             notes = ?
         WHERE id = ?`
      ).bind(newNotes, id).run();

      updates.push({
        id,
        before_category: before.category_id,
        after_category: 'salary',
        amount: Number(before.amount) || 0
      });
    } catch (err) {
      failures.push({ id, error: err.message });
    }
  }

  const auditResult = await safeAudit(env, {
    action: 'SALARY_RECATEGORIZE',
    entity: 'salary',
    entity_id: month,
    kind: 'mutation',
    detail: {
      month,
      snapshot_id: snap.snapshot_id || null,
      requested_count: txnIds.length,
      updated_count: updates.length,
      failed_count: failures.length,
      updates,
      failures
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    month,
    snapshot_id: snap.snapshot_id || null,
    requested_count: txnIds.length,
    updated_count: updates.length,
    failed_count: failures.length,
    updates,
    failures,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

function normalizeSalaryRow(row) {
  const amount = Number(row.amount) || 0;
  const diffAmt = Math.abs(amount - FORECAST_NET);
  const diffPct = (diffAmt / FORECAST_NET) * 100;

  return {
    id: row.id,
    date: row.date,
    amount,
    account_id: row.account_id,
    category_id: row.category_id || null,
    notes: row.notes || '',
    created_at: row.created_at || null,
    diff_amount: round2(diffAmt),
    diff_pct: round1(diffPct),
    confidence: classifyConfidence(diffPct)
  };
}

function buildFieldSummary(primary, totalSalary, count) {
  return {
    month_total: totalSalary,
    component_count: count,
    primary_amount: primary ? Number(primary.amount) || 0 : 0,
    primary_date: primary ? primary.date : null,
    forecast_net: FORECAST_NET,
    status: count > 0 ? 'detected' : 'missing'
  };
}

function isSalaryLikeRow(row) {
  const category = String(row.category_id || '').toLowerCase();
  const notes = String(row.notes || '').toLowerCase();

  if (category === 'salary') return true;
  if (notes.includes('salary')) return true;
  if (notes.includes('payslip')) return true;
  if (notes.includes('forecast net')) return true;
  if (notes.includes('auto-detected payslip credit')) return true;

  return false;
}

function isReversalRow(row) {
  if (!row) return false;

  if (row.reversed_by || row.reversed_at) return true;

  const notes = String(row.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function buildSalaryNotes(notes, month) {
  const current = String(notes || '').trim();

  if (current.toLowerCase().includes('salary')) return current.slice(0, 200);

  return (`Salary ${month}` + (current ? ' · ' + current : '')).slice(0, 200);
}

function classifyConfidence(diffPct) {
  const n = Number(diffPct);

  if (!Number.isFinite(n)) return 'none';
  if (n <= 5) return 'high';
  if (n <= 15) return 'medium';

  return 'low';
}

function nowMonthYM() {
  const d = new Date();

  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthRange(ym) {
  const [yearRaw, monthRaw] = String(ym || nowMonthYM()).split('-').map(Number);
  const year = Number.isFinite(yearRaw) ? yearRaw : new Date().getFullYear();
  const month = Number.isFinite(monthRaw) ? monthRaw : (new Date().getMonth() + 1);

  const mm = String(month).padStart(2, '0');
  const start = year + '-' + mm + '-01';
  const last = new Date(year, month, 0).getDate();
  const end = year + '-' + mm + '-' + String(last).padStart(2, '0');

  return { start, end };
}

async function safeSnapshot(env, label, createdBy) {
  try {
    const result = await snapshot(env, label, createdBy);

    return {
      ok: !!(result && result.ok),
      snapshot_id: result && result.snapshot_id ? result.snapshot_id : null,
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      snapshot_id: null,
      error: err.message
    };
  }
}

async function safeAudit(env, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail || {})
    };

    const result = await audit(env, payload);

    return {
      ok: !!(result && result.ok),
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}
