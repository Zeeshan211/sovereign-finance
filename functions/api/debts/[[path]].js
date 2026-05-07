/*  Sovereign Finance  /api/debts/[[path]]  v0.3.0  Debt Due Schedule Engine  */
/*
 * Handles:
 *   GET    /api/debts
 *   POST   /api/debts
 *   GET    /api/debts/{id}
 *   PUT    /api/debts/{id}
 *   DELETE /api/debts/{id}
 *   POST   /api/debts/{id}/pay
 *
 * v0.3.0:
 *   - Reads debt schedule metadata:
 *       due_day, due_date, installment_amount, frequency, last_paid_date
 *   - Computes:
 *       remaining_amount, next_due_date, days_until_due, days_overdue,
 *       due_status, schedule_missing
 *   - Keeps payment flow unchanged except it updates last_paid_date after payment.
 *   - No undefined value is passed into D1 bind().
 *   - Audit failure does not break successful DB mutations.
 *   - Cancel remains soft-only.
 */

import { json, uuid } from '../_lib.js';

const VERSION = 'v0.3.0';
const ACTIVE_CONDITION = "(status IS NULL OR status = 'active')";
const ALLOWED_FREQUENCY = ['monthly', 'weekly', 'yearly', 'custom'];
const DUE_SOON_DAYS = 3;

const DEBT_COLUMNS = `
  id,
  name,
  kind,
  original_amount,
  paid_amount,
  snowball_order,
  due_date,
  due_day,
  installment_amount,
  frequency,
  last_paid_date,
  status,
  notes,
  created_at
`;

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);

    if (path.length === 1) {
      const id = safeText(path[0], '', 160);

      const debt = await db.prepare(
        `SELECT ${DEBT_COLUMNS}
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
      ? `SELECT ${DEBT_COLUMNS}
         FROM debts
         ORDER BY kind, snowball_order, name`
      : `SELECT ${DEBT_COLUMNS}
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
      schedule_missing_count: debts.filter(d => d.schedule_missing && d.status === 'active').length,
      due_soon_count: debts.filter(d => d.due_status === 'due_soon').length,
      overdue_count: debts.filter(d => d.due_status === 'overdue').length,
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

    const id = safeText(path[0], '', 160);
    const body = await readJSON(context.request);
    const createdBy = safeText(body.created_by, 'web-debts-edit', 80);

    if (!id) {
      return json({ ok: false, version: VERSION, error: 'Debt id required' }, 400);
    }

    const beforeRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!beforeRaw) {
      return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const before = normalizeDebt(beforeRaw);
    const patch = buildDebtPatch(body);

    if (!patch.ok) {
      return json({ ok: false, version: VERSION, error: patch.error }, 400);
    }

    if (!patch.fields.length) {
      return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    const setSql = patch.fields.map(field => `${field} = ?`).join(', ');
    const bindValues = patch.values.concat([id]).map(cleanBind);

    await db.prepare(
      `UPDATE debts SET ${setSql} WHERE id = ?`
    ).bind(...bindValues).run();

    const afterRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    const after = normalizeDebt(afterRaw);

    const auditResult = await directAudit(db, {
      action: 'DEBT_UPDATE',
      entity: 'debt',
      entity_id: id,
      kind: 'mutation',
      detail: {
        before,
        after,
        updated_fields: patch.fields
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      debt: after,
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

    const id = safeText(path[0], '', 160);
    const url = new URL(context.request.url);
    const createdBy = safeText(url.searchParams.get('created_by'), 'web-debts-cancel', 80);

    const beforeRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!beforeRaw) {
      return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const before = normalizeDebt(beforeRaw);

    await db.prepare(
      `UPDATE debts SET status = ?
       WHERE id = ?`
    ).bind('cancelled', id).run();

    const auditResult = await directAudit(db, {
      action: 'DEBT_CANCEL',
      entity: 'debt',
      entity_id: id,
      kind: 'mutation',
      detail: {
        before,
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

  const snowballOrder = body.snowball_order == null || body.snowball_order === ''
    ? null
    : Number(body.snowball_order);

  const dueDate = normalizeDate(body.due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const installmentAmount = normalizeNullableAmount(body.installment_amount);
  const frequency = normalizeFrequency(body.frequency || 'monthly');
  const lastPaidDate = normalizeDate(body.last_paid_date);
  const notes = safeText(body.notes, '', 500);
  const createdBy = safeText(body.created_by, 'web-debts', 80);

  if (!name) {
    return json({ ok: false, version: VERSION, error: 'name required' }, 400);
  }

  if (!kind) {
    return json({ ok: false, version: VERSION, error: 'kind must be owe or owed' }, 400);
  }

  if (!Number.isFinite(original) || original <= 0) {
    return json({ ok: false, version: VERSION, error: 'original_amount must be greater than 0' }, 400);
  }

  if (!Number.isFinite(paid) || paid < 0) {
    return json({ ok: false, version: VERSION, error: 'paid_amount must be 0 or greater' }, 400);
  }

  if (body.due_day !== undefined && body.due_day !== null && body.due_day !== '' && dueDay == null) {
    return json({ ok: false, version: VERSION, error: 'due_day must be 1-31' }, 400);
  }

  if (body.installment_amount !== undefined && body.installment_amount !== null && body.installment_amount !== '' && installmentAmount == null) {
    return json({ ok: false, version: VERSION, error: 'installment_amount must be 0 or greater' }, 400);
  }

  if (!frequency) {
    return json({ ok: false, version: VERSION, error: 'Invalid frequency' }, 400);
  }

  await db.prepare(
    `INSERT INTO debts
      (id, name, kind, original_amount, paid_amount, snowball_order, due_date, due_day, installment_amount, frequency, last_paid_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    cleanBind(id),
    cleanBind(name),
    cleanBind(kind),
    cleanBind(original),
    cleanBind(paid),
    cleanBind(Number.isFinite(snowballOrder) ? snowballOrder : null),
    cleanBind(dueDate),
    cleanBind(dueDay),
    cleanBind(installmentAmount),
    cleanBind(frequency),
    cleanBind(lastPaidDate),
    'active',
    cleanBind(notes)
  ).run();

  const afterRaw = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     WHERE id = ?`
  ).bind(id).first();

  const auditResult = await directAudit(db, {
    action: 'DEBT_CREATE',
    entity: 'debt',
    entity_id: id,
    kind: 'mutation',
    detail: normalizeDebt(afterRaw),
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    debt: normalizeDebt(afterRaw),
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function payDebt(context, debtIdRaw) {
  const db = context.env.DB;
  const body = await readJSON(context.request);

  const debtId = safeText(debtIdRaw, '', 160);

  const debtRaw = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     WHERE id = ?
       AND ${ACTIVE_CONDITION}`
  ).bind(debtId).first();

  if (!debtRaw) {
    return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
  }

  const debt = normalizeDebt(debtRaw);
  const amount = Number(body.amount);
  const accountId = safeText(body.account_id, '', 80);
  const date = normalizeDate(body.date) || new Date().toISOString().slice(0, 10);
  const notes = safeText(body.notes, 'Debt payment: ' + debt.name, 200);
  const createdBy = safeText(body.created_by, 'web-debts-pay', 80);

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be greater than 0' }, 400);
  }

  if (!accountId) {
    return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);
  }

  const txnId = 'TXN-' + uuid();
  const txnType = debt.kind === 'owed' ? 'income' : 'expense';
  const newPaid = Number(debt.paid_amount || 0) + amount;

  await db.batch([
    db.prepare(
      `INSERT INTO transactions
        (id, type, amount, date, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 0)`
    ).bind(
      cleanBind(txnId),
      cleanBind(txnType),
      cleanBind(amount),
      cleanBind(date),
      cleanBind(accountId),
      cleanBind(notes)
    ),
    db.prepare(
      `UPDATE debts
       SET paid_amount = ?,
           last_paid_date = ?
       WHERE id = ?`
    ).bind(cleanBind(newPaid), cleanBind(date), cleanBind(debtId))
  ]);

  const afterRaw = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     WHERE id = ?`
  ).bind(debtId).first();

  const auditResult = await directAudit(db, {
    action: debt.kind === 'owed' ? 'DEBT_RECEIVE' : 'DEBT_PAY',
    entity: 'debt',
    entity_id: debtId,
    kind: 'mutation',
    detail: {
      txn_id: txnId,
      debt_id: debtId,
      debt_kind: debt.kind,
      amount,
      account_id: accountId,
      date,
      before: debt,
      after: normalizeDebt(afterRaw)
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
    debt: normalizeDebt(afterRaw),
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

function buildDebtPatch(body) {
  const fields = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = safeText(body.name, '', 80);
    if (!name) return { ok: false, error: 'name cannot be empty' };
    fields.push('name');
    values.push(name);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'kind')) {
    const kind = normalizeKind(body.kind);
    if (!kind) return { ok: false, error: 'kind must be owe or owed' };
    fields.push('kind');
    values.push(kind);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'original_amount')) {
    const original = Number(body.original_amount);
    if (!Number.isFinite(original) || original < 0) {
      return { ok: false, error: 'original_amount must be 0 or greater' };
    }
    fields.push('original_amount');
    values.push(original);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'paid_amount')) {
    const paid = Number(body.paid_amount);
    if (!Number.isFinite(paid) || paid < 0) {
      return { ok: false, error: 'paid_amount must be 0 or greater' };
    }
    fields.push('paid_amount');
    values.push(paid);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'snowball_order')) {
    const order = body.snowball_order === '' || body.snowball_order == null
      ? null
      : Number(body.snowball_order);

    fields.push('snowball_order');
    values.push(Number.isFinite(order) ? order : null);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'due_date')) {
    fields.push('due_date');
    values.push(normalizeDate(body.due_date));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'due_day')) {
    const dueDay = normalizeDueDay(body.due_day);

    if (body.due_day !== null && body.due_day !== '' && body.due_day !== undefined && dueDay == null) {
      return { ok: false, error: 'due_day must be 1-31' };
    }

    fields.push('due_day');
    values.push(dueDay);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'installment_amount')) {
    const installmentAmount = normalizeNullableAmount(body.installment_amount);

    if (body.installment_amount !== null && body.installment_amount !== '' && body.installment_amount !== undefined && installmentAmount == null) {
      return { ok: false, error: 'installment_amount must be 0 or greater' };
    }

    fields.push('installment_amount');
    values.push(installmentAmount);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'frequency')) {
    const frequency = normalizeFrequency(body.frequency || 'monthly');

    if (!frequency) {
      return { ok: false, error: 'Invalid frequency' };
    }

    fields.push('frequency');
    values.push(frequency);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'last_paid_date')) {
    fields.push('last_paid_date');
    values.push(normalizeDate(body.last_paid_date));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    fields.push('notes');
    values.push(safeText(body.notes, '', 500));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = safeText(body.status, 'active', 20).toLowerCase();

    if (!['active', 'cancelled', 'closed'].includes(status)) {
      return { ok: false, error: 'Invalid status' };
    }

    fields.push('status');
    values.push(status);
  }

  return { ok: true, fields, values };
}

async function directAudit(db, event) {
  try {
    const id = 'audit_' + uuid();
    const action = safeText(event.action, 'UNKNOWN', 80);
    const entity = safeText(event.entity, 'unknown', 80);
    const entityId = safeText(event.entity_id, '', 160);
    const kind = safeText(event.kind, 'event', 40);
    const detail = JSON.stringify(event.detail || {});
    const createdBy = safeText(event.created_by, 'system', 80);
    const ip = '';

    await db.prepare(
      `INSERT INTO audit_log
        (id, timestamp, action, entity, entity_id, kind, detail, created_by, ip)
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      cleanBind(id),
      cleanBind(action),
      cleanBind(entity),
      cleanBind(entityId),
      cleanBind(kind),
      cleanBind(detail),
      cleanBind(createdBy),
      cleanBind(ip)
    ).run();

    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(x => safeText(x, '', 180));

  return String(raw).split('/').filter(Boolean).map(x => safeText(x, '', 180));
}

function normalizeDebt(row) {
  const original = Number(row && row.original_amount) || 0;
  const paid = Number(row && row.paid_amount) || 0;
  const remaining = Math.max(0, original - paid);

  const dueDate = row && row.due_date ? normalizeDate(row.due_date) : null;
  const dueDay = row && row.due_day == null ? null : normalizeDueDay(row.due_day);
  const installmentAmount = row && row.installment_amount == null ? null : normalizeNullableAmount(row.installment_amount);
  const frequency = normalizeFrequency(row && row.frequency ? row.frequency : 'monthly') || 'monthly';
  const lastPaidDate = row && row.last_paid_date ? normalizeDate(row.last_paid_date) : null;

  const schedule = computeDebtSchedule({
    remaining,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    last_paid_date: lastPaidDate
  });

  return {
    id: safeText(row && row.id, '', 160),
    name: safeText(row && row.name, '', 120),
    kind: normalizeKind(row && row.kind) || 'owe',
    original_amount: round2(original),
    paid_amount: round2(paid),
    remaining_amount: round2(remaining),
    snowball_order: row && row.snowball_order == null ? null : Number(row.snowball_order),
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount == null ? null : round2(installmentAmount),
    frequency,
    last_paid_date: lastPaidDate,
    next_due_date: schedule.next_due_date,
    days_until_due: schedule.days_until_due,
    days_overdue: schedule.days_overdue,
    due_status: schedule.due_status,
    schedule_missing: schedule.schedule_missing,
    status: safeText(row && row.status, 'active', 40),
    notes: safeText(row && row.notes, '', 500),
    created_at: row && row.created_at ? safeText(row.created_at, '', 40) : null
  };
}

function computeDebtSchedule(input) {
  const remaining = Number(input.remaining) || 0;
  const dueDate = input.due_date || null;
  const dueDay = input.due_day == null ? null : Number(input.due_day);
  const lastPaidDate = input.last_paid_date || null;

  if (remaining <= 0) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'paid_off',
      schedule_missing: false
    };
  }

  let nextDue = null;

  if (dueDate) {
    nextDue = parseDate(dueDate);
  } else if (dueDay != null) {
    nextDue = nextDueFromDay(dueDay, lastPaidDate);
  }

  if (!nextDue) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'no_schedule',
      schedule_missing: true
    };
  }

  const today = startOfDay(new Date());
  const days = daysBetween(today, nextDue);

  if (days < 0) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: 0,
      days_overdue: Math.abs(days),
      due_status: 'overdue',
      schedule_missing: false
    };
  }

  if (days === 0) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: 0,
      days_overdue: 0,
      due_status: 'due_today',
      schedule_missing: false
    };
  }

  if (days <= DUE_SOON_DAYS) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: days,
      days_overdue: 0,
      due_status: 'due_soon',
      schedule_missing: false
    };
  }

  return {
    next_due_date: dateOnly(nextDue),
    days_until_due: days,
    days_overdue: 0,
    due_status: 'scheduled',
    schedule_missing: false
  };
}

function nextDueFromDay(dueDay, lastPaidDate) {
  const now = new Date();
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), dueDay);

  if (lastPaidDate && lastPaidDate.slice(0, 7) === today.toISOString().slice(0, 7)) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, dueDay);
  } else if (candidate < today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, dueDay);
  }

  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, max);
  return new Date(Date.UTC(year, monthIndex, safeDay));
}

function parseDate(value) {
  const raw = normalizeDate(value);

  if (!raw) return null;

  const date = new Date(raw + 'T00:00:00.000Z');

  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function normalizeDate(value) {
  const raw = safeText(value, '', 40);

  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;

  return raw.slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const day = Number(value);

  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  return Math.floor(day);
}

function normalizeNullableAmount(value) {
  if (value === undefined || value === null || value === '') return null;

  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) return null;

  return amount;
}

function normalizeFrequency(value) {
  const frequency = safeText(value, 'monthly', 20).toLowerCase();

  if (ALLOWED_FREQUENCY.includes(frequency)) return frequency;

  return null;
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

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.round(ms / 86400000);
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function safeText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function cleanBind(value) {
  if (value === undefined) return null;
  if (Number.isNaN(value)) return null;

  return value;
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
