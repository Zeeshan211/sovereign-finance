/* ─── /api/debts catch-all (base + subroutes) · v0.2.0 · Sub-1D-3c-fix2 ───
 * Consolidated routing — handles BOTH:
 *   /api/debts                    (base list/create)
 *   /api/debts/{id}               (single GET/PUT/DELETE)
 *   /api/debts/{id}/pay           (payment subroute)
 *
 * Fixes: previously /api/debts (no trailing path) hit this catch-all with
 *        empty params.path and returned 400. Now empty path → list/create.
 */

import { json, audit, snapshot } from '../_lib.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method.toUpperCase();
  const segs = params.path || [];

  /* ─── BASE: /api/debts ─── */
  if (segs.length === 0) {
    if (method === 'GET')  return handleList(env);
    if (method === 'POST') return handleCreate(request, env);
    return json({ ok: false, error: 'Method not allowed for /api/debts' }, 405);
  }

  const debtId = segs[0];
  const sub    = segs[1] || '';

  /* ─── /api/debts/{id}/pay ─── */
  if (sub === 'pay') {
    if (method !== 'POST') return json({ ok: false, error: 'pay requires POST' }, 405);
    return handlePay(request, env, debtId);
  }

  /* ─── /api/debts/{id} ─── */
  if (segs.length === 1) {
    if (method === 'GET')    return handleGetOne(env, debtId);
    if (method === 'PUT')    return handleEdit(request, env, debtId);
    if (method === 'DELETE') return handleSoftDelete(request, env, debtId);
    return json({ ok: false, error: 'Method not allowed for /api/debts/{id}' }, 405);
  }

  return json({ ok: false, error: 'Unknown debt subroute' }, 404);
}

/* ── LIST + summary ── */
async function handleList(env) {
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

/* ── CREATE ── */
async function handleCreate(request, env) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

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

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const id = 'debt_' + (slug || 'unnamed_' + Date.now().toString(36));

  try {
    const existing = await env.DB.prepare('SELECT id FROM debts WHERE id = ?').bind(id).first();
    if (existing) {
      return json({ ok: false, error: `A debt with id "${id}" already exists. Pick a different name.` }, 409);
    }
  } catch (e) { /* non-fatal */ }

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

  try {
    await env.DB.prepare(
      `INSERT INTO debts (id, name, kind, original_amount, paid_amount,
                          snowball_order, due_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(id, name, kind, original, paid, order, dueDate, notes).run();
  } catch (e) {
    return json({ ok: false, error: 'Insert failed: ' + e.message }, 500);
  }

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

/* ── GET single ── */
async function handleGetOne(env, id) {
  try {
    const row = await env.DB.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order,
              due_date, status, notes, created_at
       FROM debts WHERE id = ?`
    ).bind(id).first();
    if (!row) return json({ ok: false, error: 'Debt not found' }, 404);
    return json({ ok: true, debt: row });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ── PUT edit ── */
async function handleEdit(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const before = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, error: 'Debt not found' }, 404);

  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-debt-edit-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  const allowed = ['name', 'kind', 'original_amount', 'paid_amount', 'snowball_order', 'due_date', 'notes', 'status'];
  const updates = {};
  allowed.forEach(k => {
    if (k in body && body[k] !== undefined && body[k] !== null) updates[k] = body[k];
  });

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No fields to update' }, 400);
  }

  const newOriginal = parseFloat(updates.original_amount ?? before.original_amount);
  const newPaid     = parseFloat(updates.paid_amount     ?? before.paid_amount);
  if (!isNaN(newOriginal) && !isNaN(newPaid) && newPaid > newOriginal) {
    return json({ ok: false, error: 'paid_amount cannot exceed original_amount' }, 400);
  }
  if ('name' in updates) {
    updates.name = String(updates.name).trim();
    if (!updates.name) return json({ ok: false, error: 'name cannot be empty' }, 400);
    if (updates.name.length > 80) return json({ ok: false, error: 'name max 80 chars' }, 400);
  }
  if ('notes' in updates) updates.notes = String(updates.notes).slice(0, 500);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  try {
    await env.DB.prepare(`UPDATE debts SET ${setClauses} WHERE id = ?`)
      .bind(...values, id).run();
  } catch (e) {
    return json({ ok: false, error: 'Update failed: ' + e.message }, 500);
  }

  const after = { ...before, ...updates };
  await audit(env, {
    action: 'DEBT_EDIT',
    entity: 'debt',
    entity_id: id,
    kind:   'mutation',
    detail: { before, after, snapshot_id: snap.snapshot_id, fields: Object.keys(updates) },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    id,
    snapshot_id: snap.snapshot_id,
    updated_fields: Object.keys(updates),
    after
  });
}

/* ── DELETE soft ── */
async function handleSoftDelete(request, env, id) {
  const before = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, error: 'Debt not found' }, 404);
  if (before.status === 'deleted') return json({ ok: false, error: 'Already deleted' }, 409);

  const url = new URL(request.url);
  const createdBy = url.searchParams.get('created_by') || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-debt-delete-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  try {
    await env.DB.prepare(`UPDATE debts SET status = 'deleted' WHERE id = ?`).bind(id).run();
  } catch (e) {
    return json({ ok: false, error: 'Soft-delete failed: ' + e.message }, 500);
  }

  await audit(env, {
    action: 'DEBT_DELETE',
    entity: 'debt',
    entity_id: id,
    kind:   'mutation',
    detail: { before, snapshot_id: snap.snapshot_id, soft_delete: true },
    created_by: createdBy,
    ip
  });

  return json({ ok: true, id, soft_deleted: true, snapshot_id: snap.snapshot_id });
}

/* ── POST {id}/pay ── */
async function handlePay(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const debt = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!debt) return json({ ok: false, error: 'Debt not found' }, 404);
  if (debt.status !== 'active') return json({ ok: false, error: 'Debt is not active (status=' + debt.status + ')' }, 409);

  const amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) {
    return json({ ok: false, error: 'amount must be > 0' }, 400);
  }

  const accountId = (body.account_id || '').trim();
  if (!accountId) return json({ ok: false, error: 'account_id required' }, 400);

  const date = body.date || new Date().toISOString().slice(0, 10);
  const noteIn = (body.notes || '').slice(0, 200);
  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const remaining = (debt.original_amount || 0) - (debt.paid_amount || 0);
  if (amount > remaining + 0.01) {
    return json({
      ok: false,
      error: `Payment ${amount} exceeds remaining ${remaining.toFixed(2)} on ${debt.name}`
    }, 400);
  }

  const txnId = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const baseNote = noteIn || `Payment to ${debt.name}`;
  const txnNotes = baseNote.includes(debt.name) ? baseNote : `${baseNote} · ${debt.name}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
          (id, date, type, amount, account_id, transfer_to_account_id,
           category_id, notes, fee_amount, pra_amount)
         VALUES (?, ?, 'repay', ?, ?, NULL, 'debt_payment', ?, 0, 0)`
      ).bind(txnId, date, amount, accountId, txnNotes),

      env.DB.prepare(
        `UPDATE debts SET paid_amount = MIN(original_amount, COALESCE(paid_amount, 0) + ?) WHERE id = ?`
      ).bind(amount, id)
    ]);
  } catch (e) {
    return json({ ok: false, error: 'Pay batch failed: ' + e.message }, 500);
  }

  const newPaid = Math.min(debt.original_amount, (debt.paid_amount || 0) + amount);
  const auditRes = await audit(env, {
    action: 'DEBT_PAY',
    entity: 'debt',
    entity_id: id,
    kind:   'mutation',
    detail: {
      txn_id: txnId,
      account_id: accountId,
      amount,
      date,
      debt_name: debt.name,
      paid_before: debt.paid_amount,
      paid_after: newPaid,
      remaining_before: remaining,
      remaining_after: debt.original_amount - newPaid,
      notes: noteIn || null
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    txn_id: txnId,
    debt_id: id,
    debt_name: debt.name,
    amount,
    paid_after: newPaid,
    remaining_after: debt.original_amount - newPaid,
    fully_paid: newPaid >= debt.original_amount,
    audited: auditRes.ok
  });
}
