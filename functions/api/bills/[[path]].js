/* ─── /api/bills/[[path]] · v0.3.0 · TRACE-AUDIT FIXES ─── */
/*
 * Changes vs v0.2.0 (per TRACE audit findings 1, 5, 9):
 *   - Audit signature fix: was {entity_type, details} → now {entity, detail} per _lib.js contract
 *   - Snapshot signature fix: was snapshot(db, {label, tables, where}) → now snapshot(env, label, createdBy)
 *   - Pay INSERT column fix: was 'category' → now 'category_id' per SCHEMA.md transactions table
 *   - All 4 audit calls + 3 snapshot calls + 1 INSERT statement corrected
 */

import { json, audit, snapshot, uuid } from '../_lib.js';

const ALLOWED_FREQ = ['monthly', 'weekly', 'yearly', 'custom'];

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length === 1) {
      const id = path[0];
      const bill = await db.prepare(
        "SELECT * FROM bills WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')"
      ).bind(id).first();
      if (!bill) return json({ ok: false, error: 'Bill not found' }, 404);
      return json({ ok: true, bill });
    }

    const bills = await db.prepare(
      "SELECT * FROM bills WHERE (deleted_at IS NULL OR deleted_at = '') ORDER BY due_day, name"
    ).all();
    return json({ ok: true, bills: bills.results || [] });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    // POST /api/bills/{id}/pay
    if (path.length === 2 && path[1] === 'pay') {
      return await payBill(context, path[0]);
    }

    // POST /api/bills → create
    if (path.length === 0) {
      const body = await context.request.json();
      if (!body.name || !body.amount) {
        return json({ ok: false, error: 'name + amount required' }, 400);
      }
      if (body.frequency && !ALLOWED_FREQ.includes(body.frequency)) {
        return json({ ok: false, error: 'Invalid frequency' }, 400);
      }

      const id = body.id || ('BILL-' + uuid());

      await db.prepare(
        "INSERT INTO bills (id, name, amount, due_day, frequency, category_id, default_account_id, auto_post, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')"
      ).bind(
        id, body.name, body.amount,
        body.due_day || null,
        body.frequency || 'monthly',
        body.category_id || null,
        body.default_account_id || null,
        body.auto_post ? 1 : 0
      ).run();

      await audit(context.env, {
        action: 'BILL_CREATE',
        entity: 'bill',
        entity_id: id,
        kind: 'mutation',
        detail: JSON.stringify(body),
        created_by: body.created_by || 'web-bill-create'
      });

      return json({ ok: true, id });
    }

    return json({ ok: false, error: 'Path not supported for POST' }, 400);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    if (path.length !== 1) return json({ ok: false, error: 'Path requires bill id' }, 400);

    const id = path[0];
    const body = await context.request.json();

    // Snapshot before mutate (correct signature)
    await snapshot(context.env, 'pre-bill-edit-' + id + '-' + Date.now(), body.created_by || 'web-bill-edit');

    const updates = [];
    const values = [];
    const editable = ['name', 'amount', 'due_day', 'frequency', 'category_id', 'default_account_id', 'auto_post'];
    editable.forEach(field => {
      if (body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(field === 'auto_post' ? (body[field] ? 1 : 0) : body[field]);
      }
    });
    if (updates.length === 0) return json({ ok: false, error: 'Nothing to update' }, 400);

    values.push(id);
    await db.prepare("UPDATE bills SET " + updates.join(', ') + " WHERE id = ?").bind(...values).run();

    await audit(context.env, {
      action: 'BILL_UPDATE',
      entity: 'bill',
      entity_id: id,
      kind: 'mutation',
      detail: JSON.stringify(body),
      created_by: body.created_by || 'web-bill-edit'
    });

    return json({ ok: true, id });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    if (path.length !== 1) return json({ ok: false, error: 'Path requires bill id' }, 400);

    const id = path[0];
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || 'delete';
    const createdBy = url.searchParams.get('created_by') || 'web-bill-delete';

    // Snapshot before mutate (correct signature)
    await snapshot(context.env, 'pre-bill-' + action + '-' + id + '-' + Date.now(), createdBy);

    if (action === 'archive') {
      await db.prepare("UPDATE bills SET status = 'archived' WHERE id = ?").bind(id).run();
      await audit(context.env, {
        action: 'BILL_ARCHIVE',
        entity: 'bill',
        entity_id: id,
        kind: 'mutation',
        detail: 'Archived',
        created_by: createdBy
      });
      return json({ ok: true, id, status: 'archived' });
    }

    await db.prepare("UPDATE bills SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?").bind(id).run();
    await audit(context.env, {
      action: 'BILL_DELETE',
      entity: 'bill',
      entity_id: id,
      kind: 'mutation',
      detail: 'Soft delete',
      created_by: createdBy
    });
    return json({ ok: true, id, status: 'deleted' });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

async function payBill(context, billId) {
  const db = context.env.DB;
  const body = await context.request.json();

  const bill = await db.prepare(
    "SELECT * FROM bills WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')"
  ).bind(billId).first();
  if (!bill) return json({ ok: false, error: 'Bill not found' }, 404);

  const accountId = body.account_id || bill.default_account_id;
  if (!accountId) return json({ ok: false, error: 'account_id required (no default on bill)' }, 400);

  const amount = body.amount || bill.amount;
  if (!amount || amount <= 0) return json({ ok: false, error: 'Invalid amount' }, 400);

  const date = body.date || new Date().toISOString().slice(0, 10);
  const txnId = 'TXN-' + uuid();

  // Snapshot before mutate (correct signature)
  await snapshot(context.env, 'pre-bill-pay-' + billId + '-' + Date.now(), body.created_by || 'web-bill-pay');

  // Insert transaction with correct column name 'category_id' (was 'category' — would crash)
  await db.prepare(
    "INSERT INTO transactions (id, type, amount, date, account_id, category_id, notes) VALUES (?, 'expense', ?, ?, ?, ?, ?)"
  ).bind(
    txnId, amount, date, accountId,
    bill.category_id || 'bills',
    'Bill payment: ' + bill.name
  ).run();

  // Update bill last_paid_date
  await db.prepare("UPDATE bills SET last_paid_date = ? WHERE id = ?").bind(date, billId).run();

  await audit(context.env, {
    action: 'BILL_PAY',
    entity: 'bill',
    entity_id: billId,
    kind: 'mutation',
    detail: JSON.stringify({ txn_id: txnId, amount, account_id: accountId, date }),
    created_by: body.created_by || 'web-bill-pay'
  });

  return json({ ok: true, bill_id: billId, txn_id: txnId, amount, date });
}
