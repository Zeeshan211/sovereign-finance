/* ─── /api/debts/* catch-all · v0.1.0 · Sub-1D-3c-F2 ───
 * Handles:
 *   GET    /api/debts/{id}         → fetch single debt
 *   PUT    /api/debts/{id}         → edit fields (snapshot + audit)
 *   DELETE /api/debts/{id}         → soft-delete (status='deleted', snapshot + audit)
 *   POST   /api/debts/{id}/pay     → log a payment (creates 'repay' txn + increments paid_amount + audit)
 *
 * Cloudflare Pages Functions: [[path]].js catches everything under /api/debts/
 *   params.path = ["abc"] for /api/debts/abc
 *   params.path = ["abc", "pay"] for /api/debts/abc/pay
 */

import { json, audit, snapshot } from '../_lib.js';

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method.toUpperCase();
  const segs = params.path || [];

  if (segs.length < 1) {
    return json({ ok: false, error: 'debt id required in path' }, 400);
  }

  const debtId = segs[0];
  const sub    = segs[1] || '';

  /* ── /api/debts/{id}/pay ── */
  if (sub === 'pay') {
    if (method !== 'POST') return json({ ok: false, error: 'pay requires POST' }, 405);
    return handlePay(request, env, debtId);
  }

  /* ── /api/debts/{id} ── */
  if (segs.length === 1) {
    if (method === 'GET')    return handleGetOne(env, debtId);
    if (method === 'PUT')    return handleEdit(request, env, debtId);
    if (method === 'DELETE') return handleSoftDelete(request, env, debtId);
    return json({ ok: false, error: 'Method not allowed for /api/debts/{id}' }, 405);
  }

  return json({ ok: false, error: 'Unknown debt subroute' }, 404);
}

/* ── GET single debt ── */
async function handleGetOne(env, id) {
  try {
    const row = await env.DB.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order,
              due_date, status, notes
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

  /* Snapshot before mutate */
  const snap = await snapshot(env, `pre-debt-edit-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, error: 'Snapshot failed: ' + snap.error }, 500);

  /* Build allowed updates */
  const allowed = ['name', 'kind', 'original_amount', 'paid_amount', 'snowball_order', 'due_date', 'notes', 'status'];
  const updates = {};
  allowed.forEach(k => {
    if (k in body && body[k] !== undefined && body[k] !== null) updates[k] = body[k];
  });

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No fields to update' }, 400);
  }

  /* Validate cross-field constraints */
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

  /* Apply */
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  try {
    await env.DB.prepare(`UPDATE debts SET ${setClauses} WHERE id = ?`)
      .bind(...values, id).run();
  } catch (e) {
    return json({ ok: false, error: 'Update failed: ' + e.message }, 500);
  }

  /* Audit */
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

/* ── POST {id}/pay — log a payment ── */
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
  if (!accountId) return json({ ok: false, error: 'account_id required (which account did the money come from?)' }, 400);

  const date = body.date || new Date().toISOString().slice(0, 10);
  const noteIn = (body.notes || '').slice(0, 200);
  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  /* Cap to remaining */
  const remaining = (debt.original_amount || 0) - (debt.paid_amount || 0);
  if (amount > remaining + 0.01) {
    return json({
      ok: false,
      error: `Payment ${amount} exceeds remaining ${remaining.toFixed(2)} on ${debt.name}`
    }, 400);
  }

  /* Build the payment transaction */
  const txnId = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const baseNote = noteIn || `Payment to ${debt.name}`;
  const txnNotes = baseNote.includes(debt.name) ? baseNote : `${baseNote} · ${debt.name}`;

  /* Atomic batch: insert txn + bump debt.paid_amount */
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

  /* Audit (1 row capturing both effects) */
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
