/* ─── /api/debts/[[path]] · v0.2.3 · safe debt edit/correction contract ─── */
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
 *   - Allows safe correction of wrong debt kind: owe <-> owed.
 *   - PUT binds only defined/sanitized values. No undefined reaches D1.
 *   - Cancel is soft-only: status='cancelled'.
 *   - Payment/receive creates transaction and updates paid_amount.
 *   - Generated debt transactions keep category_id NULL until merchant/category engine is active.
 *   - Audit is best-effort; mutation success is not blocked by audit failure.
 */

import { json, audit, uuid } from '../_lib.js';

const VERSION = 'v0.2.3';
const ACTIVE_CONDITION = "(status IS NULL OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);

    if (path.length === 1) {
      const id = path[0];

      const debt = await db.prepare(
        `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
         FROM debts
         WHERE id = ?`
      ).bind(id).first();

      if (!debt) {
        return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
      }

      return json({ ok: true, version: VERSION, debt: normalizeDebt(debt) });
    }

    const includeInactive = new URL(context.request.url).searchParams.get('include_inactive') === '1';

    const sql = includeInactive
      ? `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
         FROM debts
         ORDER BY kind, snowball_order, name`
      : `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
         FROM debts
         WHERE ${ACTIVE_CONDITION}
         ORDER BY kind, snowball_order, name`;

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
    const path = getPath(context);

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
    const path = getPath(context);

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires debt id' }, 400);
    }

    const id = path[0];
    const body = await readJSON(context.request);
    const createdBy = safeText(body.created_by, 'web-debts-edit', 80);

    const before = await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!before) {
      return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const updates = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      const name = safeText(body.name, '', 80);
      if (!name) return json({ ok: false, version: VERSION, error: 'name cannot be empty' }, 400);
      updates.push('name = ?');
      values.push(name);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'kind')) {
      const kind = normalizeKind(body.kind);
      if (!kind) return json({ ok: false, version: VERSION, error: 'kind must be owe or owed' }, 400);
      updates.push('kind = ?');
      values.push(kind);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'original_amount')) {
      const original = Number(body.original_amount);
      if (!Number.isFinite(original) || original < 0) {
        return json({ ok: false, version: VERSION, error: 'original_amount must be 0 or greater' }, 400);
      }
      updates.push('original_amount = ?');
      values.push(original);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'paid_amount')) {
      const paid = Number(body.paid_amount);
      if (!Number.isFinite(paid) || paid < 0) {
        return json({ ok: false, version: VERSION, error: 'paid_amount must be 0 or greater' }, 400);
      }
      updates.push('paid_amount = ?');
      values.push(paid);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'snowball_order')) {
      const order = body.snowball_order === '' || body.snowball_order == null ? null : Number(body.snowball_order);
      updates.push('snowball_order = ?');
      values.push(Number.isFinite(order) ? order : null);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'due_date')) {
      updates.push('due_date = ?');
      values.push(body.due_date ? safeText(body.due_date, '', 20) : null);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      updates.push('notes = ?');
      values.push(safeText(body.notes, '', 500));
    }

    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      const status = safeText(body.status, 'active', 20).toLowerCase();
      if (!['active', 'cancelled', 'closed'].includes(status)) {
        return json({ ok: false, version: VERSION, error: 'Invalid status' }, 400);
      }
      updates.push('status = ?');
      values.push(status);
    }

    if (!updates.length) {
      return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    values.push(id);

    await db.prepare(
      `UPDATE debts SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    const after = await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    const auditResult = await safeAudit(context.env, {
      action: 'DEBT_UPDATE',
      entity: 'debt',
      entity_id: id,
      kind: 'mutation',
      detail: {
        before: normalizeDebt(before),
        after: normalizeDebt(after),
        updated_fields: updates.map(x => x.split(' = ')[0])
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      debt: normalizeDebt(after),
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
    const path = getPath(context);

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires debt id' }, 400);
    }

    const id = path[0];
    const url = new URL(context.request.url);
    const createdBy = safeText(url.searchParams.get('created_by'), 'web-debts-cancel', 80);

    const before = await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!before) {
      return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    await db.prepare(
      `UPDATE debts SET status = 'cancelled' WHERE id = ?`
    ).bind(id).run();

    const auditResult = await safeAudit(context.env, {
      action: 'DEBT_CANCEL',
      entity: 'debt',
      entity_id: id,
      kind: 'mutation',
      detail: {
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

  const name = safeText(body.name, '', 80);
  const kind = normalizeKind(body.kind || 'owe');
  const original = Number(body.original_amount);
  const paid = Number(body.paid_amount || 0);
  const id = body.id ? safeText(body.id, '', 120) : ('debt_' + uuid());

  if (!name) return json({ ok: false, version: VERSION, error: 'name required' }, 400);
  if (!kind) return json({ ok: false, version: VERSION, error: 'kind must be owe or owed' }, 400);
  if (!Number.isFinite(original) || original <= 0) {
    return json({ ok: false, version: VERSION, error: 'original_amount must be greater than 0' }, 400);
  }
  if (!Number.isFinite(paid) || paid < 0) {
    return json({ ok: false, version: VERSION, error: 'paid_amount must be 0 or greater' }, 400);
  }

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
    body.due_date ? safeText(body.due_date, '', 20) : null,
    safeText(body.notes, '', 500)
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
    created_by: safeText(body.created_by, 'web-debts', 80)
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
    `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes, created_at
     FROM debts
     WHERE id = ?
       AND ${ACTIVE_CONDITION}`
  ).bind(debtId).first();

  if (!debt) {
    return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
  }

  const amount = Number(body.amount);
  const accountId = safeText(body.account_id, '', 80);
  const date = safeText(body.date, new Date().toISOString().slice(0, 10), 20);
  const notes = safeText(body.notes, 'Debt payment: ' + debt.name, 200);
  const createdBy = safeText(body.created_by, 'web-debts-pay', 80);

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be greater than 0' }, 400);
  }

  if (!accountId) {
    return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);
  }

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
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);

  return String(raw).split('/').filter(Boolean);
}

function normalizeDebt(row) {
  const original = Number(row.original_amount) || 0;
  const paid = Number(row.paid_amount) || 0;

  return {
    ...row,
    kind: normalizeKind(row.kind) || 'owe',
    original_amount: original,
    paid_amount: paid,
    remaining_amount: Math.max(0, original - paid)
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

function safeText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
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

async function safeAudit(env, event) {
  try {
    const detail = typeof event.detail === 'string'
      ? event.detail
      : JSON.stringify(event.detail || {});

    const result = await audit(env, {
      action: safeText(event.action, 'UNKNOWN', 80),
      entity: safeText(event.entity, 'unknown', 80),
      entity_id: safeText(event.entity_id, '', 160),
      kind: safeText(event.kind, 'event', 40),
      detail,
      created_by: safeText(event.created_by, 'system', 80)
    });

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
