/* ─── /api/debts/[[path]] · v0.2.2 · editable debt correction contract ─── */
/*
 * Handles:
 *   GET    /api/debts
 *   POST   /api/debts
 *   GET    /api/debts/{id}
 *   PUT    /api/debts/{id}
 *   DELETE /api/debts/{id}
 *   POST   /api/debts/{id}/pay
 *
 * Contract:
 *   - Debts are editable because wrong-section entry is a real operating risk.
 *   - Changing kind owe <-> owed is allowed and audited.
 *   - Cancel is soft-only: status='cancelled'. No hard delete.
 *   - Pay/receive creates a transaction and updates paid_amount.
 *   - category_id stays NULL in generated transactions until merchant/category engine is active.
 *   - Snapshot before edit/cancel/pay.
 *   - Audit failure does not break successful DB mutation.
 */

import { json, audit, snapshot, uuid } from '../_lib.js';

const VERSION = 'v0.2.2';
const ACTIVE_CONDITION = "(status IS NULL OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length === 1) {
      const id = path[0];

      const debt = await db.prepare(
        `SELECT * FROM debts WHERE id = ?`
      ).bind(id).first();

      if (!debt) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);

      return json({ ok: true, version: VERSION, debt: normalizeDebt(debt) });
    }

    const includeInactive = new URL(context.request.url).searchParams.get('include_inactive') === '1';

    const sql = includeInactive
      ? `SELECT * FROM debts ORDER BY kind, snowball_order, name`
      : `SELECT * FROM debts WHERE ${ACTIVE_CONDITION} ORDER BY kind, snowball_order, name`;

    const res = await db.prepare(sql).all();
    const debts = (res.results || []).map(normalizeDebt);

    return json({
      ok: true,
      version: VERSION,
      count: debts.length,
      total_owe: round2(sumRemaining(debts.filter(d => d.kind === 'owe'))),
      total_owed: round2(sumRemaining(debts.filter(d => d.kind === 'owed'))),
      debts
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = context.params.path || [];

    if (path.length === 2 && path[1] === 'pay') {
      return payDebt(context, path[0]);
    }

    if (path.length === 0) {
      return createDebt(context);
    }

    return json({ ok: false, version: VERSION, error: 'Path not supported for POST' }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires debt id' }, 400);
    }

    const id = path[0];
    const body = await readJSON(context.request);

    const before = await db.prepare(
      `SELECT * FROM debts WHERE id = ?`
    ).bind(id).first();

    if (!before) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);

    const snap = await safeSnapshot(context.env, 'pre-debt-edit-' + id + '-' + Date.now(), body.created_by || 'web-debts-edit');
    if (!snap.ok) return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);

    const updates = [];
    const values = [];

    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return json({ ok: false, version: VERSION, error: 'name cannot be empty' }, 400);
      if (name.length > 80) return json({ ok: false, version: VERSION, error: 'name max 80 chars' }, 400);
      updates.push('name = ?');
      values.push(name);
    }

    if (body.kind !== undefined) {
      const kind = normalizeKind(body.kind);
      if (!kind) return json({ ok: false, version: VERSION, error: 'kind must be owe or owed' }, 400);
      updates.push('kind = ?');
      values.push(kind);
    }

    if (body.original_amount !== undefined) {
      const original = Number(body.original_amount);
      if (!(original >= 0)) return json({ ok: false, version: VERSION, error: 'original_amount must be 0 or greater' }, 400);
      updates.push('original_amount = ?');
      values.push(original);
    }

    if (body.paid_amount !== undefined) {
      const paid = Number(body.paid_amount);
      if (!(paid >= 0)) return json({ ok: false, version: VERSION, error: 'paid_amount must be 0 or greater' }, 400);
      updates.push('paid_amount = ?');
      values.push(paid);
    }

    if (body.snowball_order !== undefined) {
      const order = body.snowball_order === '' || body.snowball_order == null ? null : Number(body.snowball_order);
      updates.push('snowball_order = ?');
      values.push(order);
    }

    if (body.due_date !== undefined) {
      updates.push('due_date = ?');
      values.push(body.due_date || null);
    }

    if (body.notes !== undefined) {
      updates.push('notes = ?');
      values.push(String(body.notes || '').slice(0, 500));
    }

    if (body.status !== undefined) {
      const status = String(body.status || 'active').trim().toLowerCase();
      if (!['active', 'cancelled', 'closed'].includes(status)) {
        return json({ ok: false, version: VERSION, error: 'Invalid status' }, 400);
      }
      updates.push('status = ?');
      values.push(status);
    }

    if (updates.length === 0) {
      return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    values.push(id);

    await db.prepare(
      `UPDATE debts SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    const after = await db.prepare(
      `SELECT * FROM debts WHERE id = ?`
    ).bind(id).first();

    const auditResult = await safeAudit(context.env, {
      action: 'DEBT_UPDATE',
      entity: 'debt',
      entity_id: id,
      kind: 'mutation',
      detail: {
        snapshot_id: snap.snapshot_id || null,
        before: normalizeDebt(before),
        after: normalizeDebt(after),
        updated_fields: updates.map(x => x.split(' = ')[0])
      },
      created_by: body.created_by || 'web-debts-edit'
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      debt: normalizeDebt(after),
      snapshot_id: snap.snapshot_id || null,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires debt id' }, 400);
    }

    const id = path[0];
    const url = new URL(context.request.url);
    const createdBy = url.searchParams.get('created_by') || 'web-debts-cancel';

    const before = await db.prepare(
      `SELECT * FROM debts WHERE id = ?`
    ).bind(id).first();

    if (!before) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);

    const snap = await safeSnapshot(context.env, 'pre-debt-cancel-' + id + '-' + Date.now(), createdBy);
    if (!snap.ok) return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);

    await db.prepare(
      `UPDATE debts SET status = 'cancelled' WHERE id = ?`
    ).bind(id).run();

    const auditResult = await safeAudit(context.env, {
      action: 'DEBT_CANCEL',
      entity: 'debt',
      entity_id: id,
      kind: 'mutation',
      detail: {
        snapshot_id: snap.snapshot_id || null,
        before: normalizeDebt(before),
        soft_cancel: true
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      status: 'cancelled',
      soft_cancel: true,
      snapshot_id: snap.snapshot_id || null,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createDebt(context) {
  const db = context.env.DB;
  const body = await readJSON(context.request);

  const name = String(body.name || '').trim();
  const kind = normalizeKind(body.kind || 'owe');
  const original = Number(body.original_amount);
  const paid = Number(body.paid_amount || 0);

  if (!name) return json({ ok: false, version: VERSION, error: 'name required' }, 400);
  if (!kind) return json({ ok: false, version: VERSION, error: 'kind must be owe or owed' }, 400);
  if (!(original > 0)) return json({ ok: false, version: VERSION, error: 'original_amount must be greater than 0' }, 400);
  if (!(paid >= 0)) return json({ ok: false, version: VERSION, error: 'paid_amount must be 0 or greater' }, 400);

  const id = body.id || ('debt_' + uuid());

  await db.prepare(
    `INSERT INTO debts
      (id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).bind(
    id,
    name,
    kind,
    original,
    paid,
    body.snowball_order == null || body.snowball_order === '' ? null : Number(body.snowball_order),
    body.due_date || null,
    String(body.notes || '').slice(0, 500)
  ).run();

  const auditResult = await safeAudit(context.env, {
    action: 'DEBT_CREATE',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: {
      id,
      name,
      kind,
      original_amount: original,
      paid_amount: paid
    },
    created_by: body.created_by || 'web-debts'
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function payDebt(context, debtId) {
  const db = context.env.DB;
  const body = await readJSON(context.request);

  const debt = await db.prepare(
    `SELECT * FROM debts WHERE id = ? AND ${ACTIVE_CONDITION}`
  ).bind(debtId).first();

  if (!debt) return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);

  const amount = Number(body.amount);
  const accountId = body.account_id;
  const date = body.date || new Date().toISOString().slice(0, 10);
  const notes = String(body.notes || ('Debt payment: ' + debt.name)).slice(0, 200);
  const createdBy = body.created_by || 'web-debts-pay';

  if (!(amount > 0)) return json({ ok: false, version: VERSION, error: 'amount must be greater than 0' }, 400);
  if (!accountId) return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);

  const snap = await safeSnapshot(context.env, 'pre-debt-pay-' + debtId + '-' + Date.now(), createdBy);
  if (!snap.ok) return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);

  const txnId = 'TXN-' + uuid();
  const txnType = normalizeKind(debt.kind) === 'owed' ? 'income' : 'expense';
  const newPaid = Number(debt.paid_amount || 0) + amount;

  await db.batch([
    db.prepare(
      `INSERT INTO transactions
        (id, type, amount, date, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 0)`
    ).bind(txnId, txnType, amount, date, accountId, notes),

    db.prepare(
      `UPDATE debts SET paid_amount = ? WHERE id = ?`
    ).bind(newPaid, debtId)
  ]);

  const auditResult = await safeAudit(context.env, {
    action: normalizeKind(debt.kind) === 'owed' ? 'DEBT_RECEIVE' : 'DEBT_PAY',
    entity: 'debt',
    entity_id: debtId,
    kind: 'mutation',
    detail: {
      snapshot_id: snap.snapshot_id || null,
      txn_id: txnId,
      debt_id: debtId,
      debt_kind: normalizeKind(debt.kind),
      amount,
      account_id: accountId,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    debt_id: debtId,
    txn_id: txnId,
    amount,
    new_paid_amount: newPaid,
    snapshot_id: snap.snapshot_id || null,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

function normalizeDebt(row) {
  return {
    ...row,
    kind: normalizeKind(row.kind) || 'owe',
    original_amount: Number(row.original_amount) || 0,
    paid_amount: Number(row.paid_amount) || 0,
    remaining_amount: Math.max(0, (Number(row.original_amount) || 0) - (Number(row.paid_amount) || 0))
  };
}

function normalizeKind(kind) {
  const text = String(kind || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'debt'].includes(text)) return 'owe';
  if (['owed', 'owed_me', 'receivable', 'to_me'].includes(text)) return 'owed';

  return null;
}

function sumRemaining(rows) {
  return rows.reduce((sum, debt) => sum + Math.max(0, (Number(debt.original_amount) || 0) - (Number(debt.paid_amount) || 0)), 0);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
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
