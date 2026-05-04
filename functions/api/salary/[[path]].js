/* ─── Sovereign Finance · Salary Detect & Recategorize API · v0.1.0 ───
 * Sub-1D-4d Ship 1 of 1.
 *
 * Routes:
 *   GET  /api/salary/detect           → preview matches (dry-run, no writes)
 *   POST /api/salary/recategorize     → execute recategorization (snapshot + audit)
 *
 * Detection rule (rule-based, derived from existing D1 ground truth):
 *   - type = 'income'
 *   - account_id = 'meezan' (configurable via body.account_id)
 *   - amount within ±10% of body.expected_amount (default 165788, derived from existing payslip)
 *   - current category_id IN ('other', NULL) — only touch unclassified income
 *   - exclude reversed
 *
 * Banking-grade per Active Principle #2: snapshot before mutation + audit after.
 *
 * Architectural choice: signature is request-time, not stored.
 * Frontend can pass signature on each call. Defaults match current Meezan payslip pattern.
 * Future enhancement: store signature in settings table for persistence.
 */

import { json, audit, snapshot } from '../_lib.js';

const DEFAULT_SIGNATURE = {
  account_id: 'meezan',
  expected_amount: 165788,
  tolerance_pct: 10,        // ±10% of expected
  target_category_id: 'salary',
  source_categories: ['other'], // only recategorize from these (preserves manual edits)
};

function buildSignature(body) {
  const sig = {
    account_id: body.account_id || DEFAULT_SIGNATURE.account_id,
    expected_amount: Number(body.expected_amount || DEFAULT_SIGNATURE.expected_amount),
    tolerance_pct: Number(body.tolerance_pct || DEFAULT_SIGNATURE.tolerance_pct),
    target_category_id: body.target_category_id || DEFAULT_SIGNATURE.target_category_id,
    source_categories: Array.isArray(body.source_categories) ? body.source_categories : DEFAULT_SIGNATURE.source_categories,
  };
  sig.min_amount = sig.expected_amount * (1 - sig.tolerance_pct / 100);
  sig.max_amount = sig.expected_amount * (1 + sig.tolerance_pct / 100);
  return sig;
}

async function findMatches(db, sig) {
  // Build dynamic NULL-or-IN clause for source_categories
  const cats = sig.source_categories;
  const placeholders = cats.map(() => '?').join(',');
  const sql = `
    SELECT id, date, amount, account_id, category_id, notes
    FROM transactions
    WHERE type = 'income'
      AND account_id = ?
      AND amount >= ?
      AND amount <= ?
      AND (category_id IS NULL OR category_id IN (${placeholders}))
      AND (reversed_by IS NULL OR reversed_by = '')
    ORDER BY date DESC
  `;
  const rs = await db.prepare(sql).bind(sig.account_id, sig.min_amount, sig.max_amount, ...cats).all();
  return rs.results || [];
}

/* ─── Cloudflare Pages Function entry ─── */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;
  const db = env.DB;

  try {
    if (segments.length === 1 && segments[0] === 'detect') {
      if (method === 'GET') return await handleDetect(db, request);
      if (method === 'POST') return await handleDetect(db, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 1 && segments[0] === 'recategorize') {
      if (method === 'POST') return await handleRecategorize(db, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return json({ ok: false, error: 'Not found. Available: GET /api/salary/detect, POST /api/salary/recategorize' }, 404);
  } catch (e) {
    console.error('[salary api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

/* ─── /api/salary/detect (dry-run, no writes) ─── */
async function handleDetect(db, request) {
  let body = {};
  if (request.method === 'POST') {
    body = await request.json().catch(() => ({}));
  } else {
    // GET: read query params
    const url = new URL(request.url);
    if (url.searchParams.get('account_id')) body.account_id = url.searchParams.get('account_id');
    if (url.searchParams.get('expected_amount')) body.expected_amount = url.searchParams.get('expected_amount');
    if (url.searchParams.get('tolerance_pct')) body.tolerance_pct = url.searchParams.get('tolerance_pct');
  }
  const sig = buildSignature(body);
  const matches = await findMatches(db, sig);

  return json({
    ok: true,
    action: 'DETECT',
    signature: {
      account_id: sig.account_id,
      expected_amount: sig.expected_amount,
      tolerance_pct: sig.tolerance_pct,
      amount_range: { min: sig.min_amount, max: sig.max_amount },
      target_category_id: sig.target_category_id,
      source_categories: sig.source_categories,
    },
    matches,
    match_count: matches.length,
    would_recategorize_to: sig.target_category_id,
    note: matches.length === 0
      ? 'No matches found. Adjust signature (account_id, expected_amount, tolerance_pct) and retry.'
      : `${matches.length} txn(s) would be recategorized to '${sig.target_category_id}'. Call POST /api/salary/recategorize to execute.`,
  });
}

/* ─── /api/salary/recategorize (executes mutation) ─── */
async function handleRecategorize(db, request) {
  const body = await request.json().catch(() => ({}));
  const created_by = body.created_by || 'web';
  const sig = buildSignature(body);

  // Verify target category exists
  const cat = await db.prepare(`SELECT id FROM categories WHERE id = ?`).bind(sig.target_category_id).first();
  if (!cat) {
    return json({
      ok: false,
      error: `Target category '${sig.target_category_id}' not found in categories table`,
    }, 400);
  }

  const matches = await findMatches(db, sig);
  if (matches.length === 0) {
    return json({
      ok: true,
      action: 'RECATEGORIZE',
      matches: [],
      match_count: 0,
      updated_count: 0,
      note: 'No matches found. Nothing to recategorize.',
    });
  }

  // Snapshot before mutation
  const snapId = await snapshot(db, {
    label: `salary_recategorize_${Date.now()}`,
    tables: ['transactions'],
    where: `id IN (${matches.map(m => `'${m.id}'`).join(',')})`,
  });

  // Bulk update — use IN clause for atomicity
  const ids = matches.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  await db
    .prepare(`UPDATE transactions SET category_id = ? WHERE id IN (${placeholders})`)
    .bind(sig.target_category_id, ...ids)
    .run();

  await audit(db, {
    action: 'SALARY_RECATEGORIZE',
    entity_type: 'transactions',
    entity_id: 'bulk',
    details: {
      signature: sig,
      matched_ids: ids,
      previous_categories: matches.map(m => ({ id: m.id, prev: m.category_id })),
      new_category: sig.target_category_id,
      snapshot_id: snapId,
    },
    created_by,
  });

  return json({
    ok: true,
    action: 'SALARY_RECATEGORIZE',
    snapshot_id: snapId,
    match_count: matches.length,
    updated_count: ids.length,
    updated_ids: ids,
    new_category: sig.target_category_id,
  });
}
