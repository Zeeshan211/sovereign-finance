/* ─── /api/salary/[[path]] · v0.2.1 · TRACE-AUDIT FIXES (regression fix) ─── */
/*
 * v0.2.0 was a regression — replaced detect/recategorize with wrong "create salary" endpoint.
 * v0.2.1 restores original v0.1.0 functionality + applies the audit/snapshot signature fixes.
 *
 * Endpoints (matches v0.1.0 contract):
 *   GET  /api/salary/detect?month=YYYY-MM  → find candidate Meezan income txns for salary
 *   POST /api/salary/recategorize          → batch-update txn category_id to 'salary' + notes
 *   GET  /api/salary                       → list all salary-categorized txns
 *
 * Audit + snapshot signature fixes from TRACE audit:
 *   - audit() now uses entity/detail (was entity_type/details — wrote NULL)
 *   - snapshot() now uses snapshot(env, label, createdBy) (was {object} — silently failed)
 */

import { json, audit, snapshot } from '../_lib.js';

const SOURCE_ACCOUNT = 'meezan';
const FORECAST_NET = 154750;
const TOLERANCE_PCT = 30;

function nowMonthYM() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return { start, end };
}

function classifyConfidence(diffPct) {
  if (diffPct <= 5) return 'high';
  if (diffPct <= 15) return 'medium';
  return 'low';
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;

  try {
    if (segments.length === 0 && method === 'GET') {
      return await listSalaries(env);
    }

    if (segments.length === 1 && segments[0] === 'detect' && method === 'GET') {
      return await detectSalaryCandidates(env, request);
    }

    if (segments.length === 1 && segments[0] === 'recategorize' && method === 'POST') {
      return await recategorizeSalary(env, request);
    }

    return json({
      ok: false,
      error: 'Not found. Available: GET /api/salary, GET /api/salary/detect, POST /api/salary/recategorize'
    }, 404);
  } catch (e) {
    console.error('[salary api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function listSalaries(env) {
  const db = env.DB;
  const r = await db.prepare(
    "SELECT * FROM transactions WHERE category_id = 'salary' AND type = 'income' AND (reversed_at IS NULL OR reversed_at = '') ORDER BY date DESC LIMIT 50"
  ).all();
  return json({ ok: true, salaries: r.results || [], count: (r.results || []).length });
}

async function detectSalaryCandidates(env, request) {
  const db = env.DB;
  const url = new URL(request.url);
  const month = (url.searchParams.get('month') || nowMonthYM()).slice(0, 7);

  const { start, end } = monthRange(month);
  const minAmt = FORECAST_NET * (1 - TOLERANCE_PCT / 100);
  const maxAmt = FORECAST_NET * (1 + TOLERANCE_PCT / 100);

  const r = await db
    .prepare(
      `SELECT id, date, amount, account_id, category_id, notes
         FROM transactions
        WHERE type = 'income'
          AND account_id = ?
          AND amount BETWEEN ? AND ?
          AND date BETWEEN ? AND ?
          AND (reversed_by IS NULL OR reversed_by = '')
        ORDER BY date DESC, amount DESC`
    )
    .bind(SOURCE_ACCOUNT, minAmt, maxAmt, start, end)
    .all();

  const rows = r.results || [];
  const candidates = rows.map(t => {
    const diffAmt = Math.abs(t.amount - FORECAST_NET);
    const diffPct = (diffAmt / FORECAST_NET) * 100;
    return {
      ...t,
      diff_pct: Math.round(diffPct * 10) / 10,
      confidence: classifyConfidence(diffPct),
      is_already_salary: t.category_id === 'salary'
    };
  });

  return json({
    ok: true,
    month,
    forecast_net: FORECAST_NET,
    tolerance_pct: TOLERANCE_PCT,
    range: { min: Math.round(minAmt), max: Math.round(maxAmt) },
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
    return json({ ok: false, error: 'txn_ids array required (non-empty)' }, 400);
  }

  // Snapshot before mutation (correct signature — was silently failing in v0.1.0)
  await snapshot(env, 'pre-salary-recat-' + month + '-' + Date.now(), createdBy);

  const updates = [];
  const failures = [];

  for (const id of txnIds) {
    try {
      const before = await db.prepare(
        "SELECT id, category_id, notes, amount FROM transactions WHERE id = ?"
      ).bind(id).first();

      if (!before) {
        failures.push({ id, error: 'Not found' });
        continue;
      }

      const newNotes = (before.notes && before.notes.includes('Salary'))
        ? before.notes
        : `Salary ${month}` + (before.notes ? ` · ${before.notes}` : '');

      await db.prepare(
        "UPDATE transactions SET category_id = 'salary', notes = ? WHERE id = ?"
      ).bind(newNotes, id).run();

      updates.push({
        id,
        before_category: before.category_id,
        after_category: 'salary',
        amount: before.amount
      });
    } catch (e) {
      failures.push({ id, error: e.message });
    }
  }

  // Audit batch (correct signature — was writing NULL detail in v0.1.0)
  await audit(env, {
    action: 'SALARY_RECATEGORIZE',
    entity: 'salary',
    entity_id: month,
    kind: 'mutation',
    detail: JSON.stringify({
      month,
      requested_count: txnIds.length,
      updated_count: updates.length,
      failed_count: failures.length,
      updates,
      failures
    }),
    created_by: createdBy
  });

  return json({
    ok: true,
    month,
    requested_count: txnIds.length,
    updated_count: updates.length,
    failed_count: failures.length,
    updates,
    failures
  });
}
