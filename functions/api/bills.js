/* ─── /api/bills · v0.2.0 · Sub-1D-3-PARITY ───
 * GET           list active bills with status enrichment (existing behaviour)
 * GET ?id=X     single bill
 * POST          create new bill
 * PUT           edit bill fields (snapshot + audit)
 * DELETE        soft-delete (status='deleted', snapshot + audit)
 *
 * Mark-paid + Skip live in /api/bills/action.js (next session — keeps this file simpler)
 * For now mark-paid still works via direct PUT on last_paid_date.
 */

import { json, audit, snapshot, uuid } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  try {
    if (id) {
      const row = await env.DB.prepare(
        `SELECT id, name, amount, due_day, frequency, category_id, default_account_id,
                last_paid_date, auto_post, status, deleted_at
         FROM bills WHERE id = ?`
      ).bind(id).first();
      if (!row) return json({ ok: false, error: 'Not found' }, 404);
      return json({ ok: true, bill: row });
    }

    const result = await env.DB.prepare(
      `SELECT id, name, amount, due_day, frequency, category_id, default_account_id,
              last_paid_date, auto_post, status
       FROM bills
       WHERE status = 'active' OR status IS NULL
       ORDER BY due_day ASC`
    ).all();
    const bills = result.results || [];

    const today = new Date();
    const thisDay = today.getDate();
    const thisMonth = today.toISOString().slice(0, 7);

    const enriched = bills.map(b => {
      const dueDay = b.due_day || 1;
      const lastPaid = b.last_paid_date || '';
      const paidThisPeriod = lastPaid.startsWith(thisMonth);
      const daysToDue = dueDay - thisDay;

      let status = 'upcoming';
      let daysLabel = '';
      if (paidThisPeriod)         { status = 'paid';      daysLabel = 'paid'; }
      else if (daysToDue < 0)     { status = 'overdue';   daysLabel = Math.abs(daysToDue) + 'd overdue'; }
      else if (daysToDue === 0)   { status = 'due-today'; daysLabel = 'due today'; }
      else if (daysToDue <= 3)    { status = 'due-soon';  daysLabel = 'in ' + daysToDue + 'd'; }
      else                        { status = 'upcoming';  daysLabel = 'in ' + daysToDue + 'd'; }

      return { ...b, status, daysLabel, paidThisPeriod };
    });

    const totalMonthly = enriched.reduce((s, b) => s + (b.amount || 0), 0);
    const remaining = enriched.filter(b => !b.paidThisPeriod).reduce((s, b) => s + (b.amount || 0), 0);
    const paidCount = enriched.filter(b => b.paidThisPeriod).length;

    return json({
      ok: true,
      count: enriched.length,
      total_monthly: Math.round(totalMonthly * 100) / 100,
      remaining_this_period: Math.round(remaining * 100) / 100,
      paid_count: paidCount,
      bills: enriched
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
  const amount = parseFloat(body.amount);
  if (!name || isNaN(amount) || amount <= 0) {
    return json({ ok: false, error: 'name and amount > 0 required' }, 400);
  }

  const id = 'bill_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) + '_' + Date.now().toString(36);
  const dueDay = parseInt(body.due_day) || 1;
  const frequency = body.frequency || 'monthly';
  const categoryId = body.category_id || 'bills';
  const defaultAccount = body.default_account_id || null;
  const autoPost = body.auto_post ? 1 : 0;
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const createdBy = body.created_by || 'web';

  try {
    await env.DB.prepare(
      `INSERT INTO bills (id, name, amount, due_day, frequency, category_id,
                          default_account_id, auto_post, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    ).bind(id, name, amount, dueDay, frequency, categoryId, defaultAccount, autoPost).run();
  } catch (e) {
    return json({ ok: false, error: 'Insert failed: ' + e.message }, 500);
  }

  await audit(env, {
    action: 'BILL_ADD',
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: { name, amount, due_day: dueDay, frequency, category_id: categoryId, default_account_id: defaultAccount },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id });
}

/* ── PUT: edit fields ── */
export async function onRequestPut({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const id = (body.id || '').trim();
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  const before = await env.DB.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-bill-edit-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  const updates = {};
  ['name', 'amount', 'due_day', 'frequency', 'category_id', 'default_account_id', 'last_paid_date', 'auto_post', 'status']
    .forEach(k => { if (k in body && body[k] !== undefined) updates[k] = body[k]; });

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No fields to update' }, 400);
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  try {
    await env.DB.prepare(`UPDATE bills SET ${setClauses} WHERE id = ?`)
      .bind(...values, id).run();
  } catch (e) {
    return json({ ok: false, error: 'Update failed: ' + e.message }, 500);
  }

  // Detect mark-paid pattern (last_paid_date being set/changed)
  const isMarkPaid = 'last_paid_date' in updates && updates.last_paid_date !== before.last_paid_date;
  const action = isMarkPaid ? 'BILL_MARK_PAID' : 'BILL_EDIT';

  await audit(env, {
    action,
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: { before, after: { ...before, ...updates }, snapshot_id: snap.snapshot_id, mark_paid: isMarkPaid },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id, snapshot_id: snap.snapshot_id, updated_fields: Object.keys(updates), action });
}

/* ── DELETE: soft-delete ── */
export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  const before = await env.DB.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, error: 'Not found' }, 404);
  if (before.status === 'deleted') return json({ ok: false, error: 'Already deleted' }, 409);

  const createdBy = url.searchParams.get('created_by') || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-bill-delete-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  try {
    await env.DB.prepare(
      `UPDATE bills SET status='deleted', deleted_at=datetime('now') WHERE id = ?`
    ).bind(id).run();
  } catch (e) {
    return json({ ok: false, error: 'Soft-delete failed: ' + e.message }, 500);
  }

  await audit(env, {
    action: 'BILL_DELETE',
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: { before, snapshot_id: snap.snapshot_id, soft_delete: true },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id, soft_deleted: true, snapshot_id: snap.snapshot_id });
}
