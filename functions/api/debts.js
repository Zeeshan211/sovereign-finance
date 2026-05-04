/* ─── /api/debts · v0.3.0 · Sub-1D-3c ───
 * GET  /api/debts          → list active + summary totals (existing behaviour preserved)
 * POST /api/debts          → create new debt with audit log
 *
 * Subroutes (/api/debts/{id} and /api/debts/{id}/pay) live in
 * functions/api/debts/[[path]].js — coming in Turn 2 of Sub-1D-3c.
 */

import { json, audit } from './_lib.js';

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (method === 'GET')  return handleGet(env);
  if (method === 'POST') return handlePost(request, env);
  return json({ ok: false, error: 'Method not allowed' }, 405);
}

/* ── GET — list active + summary ── */
async function handleGet(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order,
              due_date, status, notes
       FROM debts WHERE status = 'active' ORDER BY snowball_order ASC`
    ).all();

    const debts = result.results || [];
    let totalOwe = 0;
    let totalOwed = 0;
    debts.forEach(d => {
      const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
      if (d.kind === 'owe')  totalOwe  += remaining;
      else if (d.kind === 'owed') totalOwed += remaining;
    });

    return json({
      ok: true,
      count: debts.length,
      total_owe:  Math.round(totalOwe  * 100) / 100,
      total_owed: Math.round(totalOwed * 100) / 100,
      debts
    });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

/* ── POST — create new debt ── */
async function handlePost(request, env) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  /* ── Validate ── */
  const name = (body.name || '').trim();
  if (!name) return json({ ok: false, error: 'name required' }, 400);
  if (name.length > 80) return json({ ok: false, error: 'name max 80 chars' }, 400);

  const original = parseFloat(body.original_amount);
  if (isNaN(original) || original <= 0) {
    return json({ ok: false, error: 'original_amount must be > 0' }, 400);
  }

  const kind = body.kind === 'owed' ? 'owed' : 'owe';
  const paid = Math.max(0, parseFloat(body.paid_amount) || 0);
  if (paid > original) {
    return json({ ok: false, error: 'paid_amount cannot exceed original_amount' }, 400);
  }

  const dueDate = body.due_date || null;
  const notes   = (body.notes || '').slice(0, 500);
  const ip      = request.headers.get('CF-Connecting-IP') || null;
  const createdBy = body.created_by || 'web';

  /* ── Generate id from name (slugify) ── */
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const id = 'debt_' + (slug || 'unnamed_' + Date.now().toString(36));

  /* ── Check for duplicate id ── */
  try {
    const existing = await env.DB.prepare('SELECT id FROM debts WHERE id = ?').bind(id).first();
    if (existing) {
      return json({ ok: false, error: `A debt with id "${id}" already exists. Pick a different name.` }, 409);
    }
  } catch (e) { /* non-fatal — proceed */ }

  /* ── Determine snowball_order ── */
  let order = parseInt(body.snowball_order, 10);
  if (isNaN(order) || order <= 0) {
    try {
      const maxRow = await env.DB.prepare(
        `SELECT MAX(snowball_order) AS m FROM debts WHERE kind = ? AND status = 'active'`
      ).bind(kind).first();
      order = ((maxRow && maxRow.m) || 0) + 1;
    } catch (e) {
      order = 99;
    }
  }

  /* ── Insert ── */
  try {
    await env.DB.prepare(
      `INSERT INTO debts (id, name, kind, original_amount, paid_amount,
                          snowball_order, due_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(id, name, kind, original, paid, order, dueDate, notes).run();
  } catch (e) {
    return json({ ok: false, error: 'Insert failed: ' + e.message }, 500);
  }

  /* ── Audit ── */
  const auditRes = await audit(env, {
    action:    'DEBT_ADD',
    entity:    'debt',
    entity_id: id,
    kind:      'mutation',
    detail: {
      name, kind,
      original_amount: original,
      paid_amount: paid,
      snowball_order: order,
      due_date: dueDate,
      notes: notes || null
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    id,
    name,
    kind,
    original_amount: original,
    paid_amount: paid,
    snowball_order: order,
    audited: auditRes.ok,
    audit_error: auditRes.ok ? null : auditRes.error
  });
}
