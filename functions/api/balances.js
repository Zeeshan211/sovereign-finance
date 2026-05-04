/* ─── /api/debts · v0.2.0 · Sub-1D-3-PARITY ───
 * GET    list active debts (existing behaviour preserved)
 * GET    ?id=X single debt
 * POST   create new debt
 * PUT    update debt fields (snapshot + audit)
 * DELETE soft-delete (status='deleted', snapshot + audit)
 * POST /payment subroute moved to /api/debts/payment.js (separate file, next session)
 *
 * All mutations: snapshot before, audit after. No hard deletes, ever.
 */

import { json, audit, snapshot, uuid } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  try {
    if (id) {
      const row = await env.DB.prepare(
        `SELECT id, name, kind, original_amount, paid_amount, snowball_order,
                due_date, status, notes
         FROM debts WHERE id = ?`
      ).bind(id).first();
      if (!row) return json({ ok: false, error: 'Not found' }, 404);
      return json({ ok: true, debt: row });
    }

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
      if (d.kind === 'owe') totalOwe += remaining;
      else if (d.kind === 'owed') totalOwed += remaining;
    });

    return json({
      ok: true,
      count: debts.length,
      total_owe: Math.round(totalOwe * 100) / 100,
      total_owed: Math.round(totalOwed * 100) / 100,
      debts
    });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

/* ── POST: create ── */
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const name = (body.name || '').trim();
  const original = parseFloat(body.original_amount);
  if (!name) return json({ ok: false, error: 'name required' }, 400);
  if (isNaN(original) || original <= 0) return json({ ok: false, error: 'original_amount must be > 0' }, 400);

  const id = 'debt_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  const kind = body.kind === 'owed' ? 'owed' : 'owe';
  const paid = parseFloat(body.paid_amount) || 0;
  const order = parseInt(body.snowball_order) || 99;
  const dueDate = body.due_date || null;
  const notes = (body.notes || '').slice(0, 500);
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const createdBy = body.created_by || 'web';

  try {
    await env.DB.prepare(
      `INSERT INTO debts (id, name, kind, original_amount, paid_amount,
                          snowball_order, due_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(id, name, kind, original, paid, order, dueDate, notes).run();
  } catch (e) {
    return json({ ok: false, error: 'Insert failed: ' + e.message }, 500);
  }

  await audit(env, {
    action: 'DEBT_ADD',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: { name, kind, original_amount: original, paid_amount: paid, due_date: dueDate, notes: notes || null },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id });
}

/* ── PUT: edit fields (snapshot before) ── */
export async function onRequestPut({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const id = (body.id || '').trim();
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  const before = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  // Snapshot before
  const snap = await snapshot(env, `pre-debt-edit-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  const updates = {};
  ['name', 'kind', 'original_amount', 'paid_amount', 'snowball_order', 'due_date', 'notes', 'status']
    .forEach(k => { if (k in body && body[k] !== undefined) updates[k] = body[k]; });

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No fields to update' }, 400);
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  try {
    await env.DB.prepare(`UPDATE debts SET ${setClauses} WHERE id = ?`)
      .bind(...values, id).run();
  } catch (e) {
    return json({ ok: false, error: 'Update failed: ' + e.message }, 500);
  }

  await audit(env, {
    action: 'DEBT_EDIT',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: { before, after: { ...before, ...updates }, snapshot_id: snap.snapshot_id },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id, snapshot_id: snap.snapshot_id, updated_fields: Object.keys(updates) });
}

/* ── DELETE: soft-delete (status='deleted', snapshot before) ── */
export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  const before = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, error: 'Not found' }, 404);
  if (before.status === 'deleted') return json({ ok: false, error: 'Already deleted' }, 409);

  const createdBy = url.searchParams.get('created_by') || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-debt-delete-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  try {
    await env.DB.prepare(`UPDATE debts SET status='deleted' WHERE id = ?`)
      .bind(id).run();
  } catch (e) {
    return json({ ok: false, error: 'Soft-delete failed: ' + e.message }, 500);
  }

  await audit(env, {
    action: 'DEBT_DELETE',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: { before, snapshot_id: snap.snapshot_id, soft_delete: true },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id, soft_deleted: true, snapshot_id: snap.snapshot_id });
}
