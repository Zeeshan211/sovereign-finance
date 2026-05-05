/* ─── /api/debts catch-all · v0.2.1 · Layer 2 debt payment contract ─── */
/*
 * Handles:
 *   GET    /api/debts
 *   POST   /api/debts
 *   GET    /api/debts/{id}
 *   PUT    /api/debts/{id}
 *   DELETE /api/debts/{id}
 *   POST   /api/debts/{id}/pay
 *
 * Layer 2 fixes:
 *   - Debt payment writes category_id as NULL to avoid category/FK drift.
 *   - Debt payment supports:
 *       kind=owe  -> repay  -> money leaves account
 *       kind=owed -> borrow -> money enters account
 *   - Audit detail is JSON.stringified through safeAudit.
 *   - Payment mutation is DB batch: transaction row + debt paid_amount update.
 */

import { json, audit, snapshot } from '../_lib.js';

const VERSION = 'v0.2.1';

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method.toUpperCase();
  const segs = params.path || [];

  if (segs.length === 0) {
    if (method === 'GET') return handleList(env);
    if (method === 'POST') return handleCreate(request, env);
    return json({ ok: false, version: VERSION, error: 'Method not allowed for /api/debts' }, 405);
  }

  const debtId = segs[0];
  const sub = segs[1] || '';

  if (sub === 'pay') {
    if (method !== 'POST') return json({ ok: false, version: VERSION, error: 'pay requires POST' }, 405);
    return handlePay(request, env, debtId);
  }

  if (segs.length === 1) {
    if (method === 'GET') return handleGetOne(env, debtId);
    if (method === 'PUT') return handleEdit(request, env, debtId);
    if (method === 'DELETE') return handleSoftDelete(request, env, debtId);
    return json({ ok: false, version: VERSION, error: 'Method not allowed for /api/debts/{id}' }, 405);
  }

  return json({ ok: false, version: VERSION, error: 'Unknown debt subroute' }, 404);
}

async function handleList(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order,
              due_date, status, notes
       FROM debts
       WHERE status = 'active'
       ORDER BY snowball_order ASC`
    ).all();

    const debts = result.results || [];
    let totalOwe = 0;
    let totalOwed = 0;

    debts.forEach(d => {
      const remaining = Math.max(0, (Number(d.original_amount) || 0) - (Number(d.paid_amount) || 0));
      if (d.kind === 'owe') totalOwe += remaining;
      else if (d.kind === 'owed') totalOwed += remaining;
    });

    return json({
      ok: true,
      version: VERSION,
      count: debts.length,
      total_owe: round2(totalOwe),
      total_owed: round2(totalOwed),
      debts
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Invalid JSON' }, 400);
  }

  const name = String(body.name || '').trim();
  if (!name) return json({ ok: false, version: VERSION, error: 'name required' }, 400);
  if (name.length > 80) return json({ ok: false, version: VERSION, error: 'name max 80 chars' }, 400);

  const original = parseFloat(body.original_amount);
  if (isNaN(original) || original <= 0) {
    return json({ ok: false, version: VERSION, error: 'original_amount must be > 0' }, 400);
  }

  const kind = body.kind === 'owed' ? 'owed' : 'owe';
  const paid = Math.max(0, parseFloat(body.paid_amount) || 0);

  if (paid > original) {
    return json({ ok: false, version: VERSION, error: 'paid_amount cannot exceed original_amount' }, 400);
  }

  const dueDate = body.due_date || null;
  const notes = String(body.notes || '').slice(0, 500);
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const createdBy = body.created_by || 'web';

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const id = 'debt_' + (slug || 'unnamed_' + Date.now().toString(36));

  try {
    const existing = await env.DB.prepare('SELECT id FROM debts WHERE id = ?').bind(id).first();
    if (existing) {
      return json({ ok: false, version: VERSION, error: `A debt with id "${id}" already exists. Pick a different name.` }, 409);
    }
  } catch (e) {}

  let order = parseInt(body.snowball_order, 10);
  if (isNaN(order) || order <= 0) {
    try {
      const maxRow = await env.DB.prepare(
        `SELECT MAX(snowball_order) AS m
         FROM debts
         WHERE kind = ? AND status = 'active'`
      ).bind(kind).first();

      order = ((maxRow && maxRow.m) || 0) + 1;
    } catch (e) {
      order = 99;
    }
  }

  try {
    await env.DB.prepare(
      `INSERT INTO debts
        (id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(id, name, kind, original, paid, order, dueDate, notes).run();
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Insert failed: ' + e.message }, 500);
  }

  const auditRes = await safeAudit(env, {
    action: 'DEBT_ADD',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: {
      name,
      kind,
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
    version: VERSION,
    id,
    name,
    kind,
    original_amount: original,
    paid_amount: paid,
    snowball_order: order,
    audited: auditRes.ok,
    audit_error: auditRes.error || null
  });
}

async function handleGetOne(env, id) {
  try {
    const row = await env.DB.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order,
              due_date, status, notes, created_at
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!row) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);

    return json({ ok: true, version: VERSION, debt: row });
  } catch (e) {
    return json({ ok: false, version: VERSION, error: e.message }, 500);
  }
}

async function handleEdit(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Invalid JSON' }, 400);
  }

  const before = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);

  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-debt-edit-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);

  const allowed = ['name', 'kind', 'original_amount', 'paid_amount', 'snowball_order', 'due_date', 'notes', 'status'];
  const updates = {};

  allowed.forEach(k => {
    if (k in body && body[k] !== undefined && body[k] !== null) updates[k] = body[k];
  });

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, version: VERSION, error: 'No fields to update' }, 400);
  }

  const newOriginal = parseFloat(updates.original_amount ?? before.original_amount);
  const newPaid = parseFloat(updates.paid_amount ?? before.paid_amount);

  if (!isNaN(newOriginal) && !isNaN(newPaid) && newPaid > newOriginal) {
    return json({ ok: false, version: VERSION, error: 'paid_amount cannot exceed original_amount' }, 400);
  }

  if ('name' in updates) {
    updates.name = String(updates.name).trim();
    if (!updates.name) return json({ ok: false, version: VERSION, error: 'name cannot be empty' }, 400);
    if (updates.name.length > 80) return json({ ok: false, version: VERSION, error: 'name max 80 chars' }, 400);
  }

  if ('notes' in updates) updates.notes = String(updates.notes).slice(0, 500);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);

  try {
    await env.DB.prepare(`UPDATE debts SET ${setClauses} WHERE id = ?`).bind(...values, id).run();
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Update failed: ' + e.message }, 500);
  }

  const after = { ...before, ...updates };

  await safeAudit(env, {
    action: 'DEBT_EDIT',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: {
      before,
      after,
      snapshot_id: snap.snapshot_id,
      fields: Object.keys(updates)
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    snapshot_id: snap.snapshot_id,
    updated_fields: Object.keys(updates),
    after
  });
}

async function handleSoftDelete(request, env, id) {
  const before = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();
  if (!before) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
  if (before.status === 'deleted') return json({ ok: false, version: VERSION, error: 'Already deleted' }, 409);

  const url = new URL(request.url);
  const createdBy = url.searchParams.get('created_by') || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const snap = await snapshot(env, `pre-debt-delete-${id}`, createdBy);
  if (!snap.ok) return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);

  try {
    await env.DB.prepare(`UPDATE debts SET status = 'deleted' WHERE id = ?`).bind(id).run();
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Soft-delete failed: ' + e.message }, 500);
  }

  await safeAudit(env, {
    action: 'DEBT_DELETE',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: {
      before,
      snapshot_id: snap.snapshot_id,
      soft_delete: true
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    soft_deleted: true,
    snapshot_id: snap.snapshot_id
  });
}

async function handlePay(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Invalid JSON' }, 400);
  }

  const debt = await env.DB.prepare(`SELECT * FROM debts WHERE id = ?`).bind(id).first();

  if (!debt) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
  if (debt.status !== 'active') {
    return json({ ok: false, version: VERSION, error: 'Debt is not active (status=' + debt.status + ')' }, 409);
  }

  const amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be > 0' }, 400);
  }

  const accountId = String(body.account_id || '').trim();
  if (!accountId) return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);

  const date = body.date || new Date().toISOString().slice(0, 10);
  const noteIn = String(body.notes || '').slice(0, 200);
  const createdBy = body.created_by || 'web';
  const ip = request.headers.get('CF-Connecting-IP') || null;

  const originalAmount = Number(debt.original_amount) || 0;
  const paidBefore = Number(debt.paid_amount) || 0;
  const remaining = Math.max(0, originalAmount - paidBefore);

  if (amount > remaining + 0.01) {
    return json({
      ok: false,
      version: VERSION,
      error: `Payment ${amount} exceeds remaining ${remaining.toFixed(2)} on ${debt.name}`
    }, 400);
  }

  const kind = debt.kind === 'owed' ? 'owed' : 'owe';
  const txnType = kind === 'owed' ? 'borrow' : 'repay';
  const action = kind === 'owed' ? 'DEBT_RECEIVE' : 'DEBT_PAY';
  const txnId = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  const defaultNote = kind === 'owed'
    ? `Received from ${debt.name}`
    : `Payment to ${debt.name}`;

  const baseNote = noteIn || defaultNote;
  const txnNotes = baseNote.includes(debt.name) ? baseNote : `${baseNote} · ${debt.name}`;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
          (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 0)`
      ).bind(txnId, date, txnType, amount, accountId, txnNotes),

      env.DB.prepare(
        `UPDATE debts
         SET paid_amount = MIN(original_amount, COALESCE(paid_amount, 0) + ?)
         WHERE id = ?`
      ).bind(amount, id)
    ]);
  } catch (e) {
    return json({ ok: false, version: VERSION, error: 'Pay batch failed: ' + e.message }, 500);
  }

  const newPaid = Math.min(originalAmount, paidBefore + amount);
  const remainingAfter = round2(originalAmount - newPaid);

  const auditRes = await safeAudit(env, {
    action,
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: {
      txn_id: txnId,
      txn_type: txnType,
      account_id: accountId,
      amount,
      date,
      debt_name: debt.name,
      debt_kind: kind,
      paid_before: paidBefore,
      paid_after: newPaid,
      remaining_before: remaining,
      remaining_after: remainingAfter,
      notes: noteIn || null
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    version: VERSION,
    txn_id: txnId,
    txn_type: txnType,
    debt_id: id,
    debt_name: debt.name,
    debt_kind: kind,
    amount,
    paid_after: newPaid,
    remaining_after: remainingAfter,
    fully_paid: newPaid >= originalAmount,
    audited: auditRes.ok,
    audit_error: auditRes.error || null
  });
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

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
