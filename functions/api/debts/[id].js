/* /api/debts/:id
 * Sovereign Finance · Debt Item Route
 * v0.6.1-user-scoped
 *
 * This route is intentionally NON-MONEY ONLY.
 *
 * Allowed:
 *   GET one debt
 *   PUT/POST action=update      → schedule/details/notes only
 *   PUT/POST action=defer       → schedule only
 *   PUT/POST action=archive     → non-money terminal hide/archive
 *   PUT/POST action=reactivate  → reopen archived/paused record without ledger movement
 *
 * Blocked here:
 *   payment
 *   receive
 *   pay
 *   settle
 *   paid_amount edits
 *   original_amount edits
 *   kind/direction edits
 *   any ledger/account mutation
 *
 * Canonical money owner:
 *   POST /api/debts
 *   action=payment
 *
 * Canonical reversal owner:
 *   POST /api/transactions/reverse
 */

import { getUserId } from '../_lib.js';

const VERSION = 'v0.6.1-user-scoped';
const CONTRACT_VERSION = 'debts-v1';

const TERMINAL_STATUSES = new Set([
  'settled',
  'archived',
  'closed',
  'deleted',
  'paid',
  'finished',
  'completed',
  'done'
]);

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

const BLOCKED_MONEY_ACTIONS = new Set([
  'pay',
  'payment',
  'record_payment',
  'receive',
  'settle',
  'manual_settle',
  'mark_paid',
  'paid',
  'close_as_paid',
  'delete_with_money',
  'reverse',
  'reverse_payment'
]);

const BLOCKED_MONEY_FIELDS = [
  'kind',
  'direction',
  'original_amount',
  'amount',
  'paid_amount',
  'remaining_amount',
  'outstanding_amount',
  'account_id',
  'source_account_id',
  'destination_account_id',
  'from_account_id',
  'to_account_id',
  'movement_now',
  'money_moved_now',
  'ledger_movement_now',
  'create_ledger',
  'transaction_id',
  'ledger_transaction_id',
  'origin_transaction_id',
  'payment_transaction_id'
];

export async function onRequestGet(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'Unauthorized' }, 401);

    const db = requireDb(context.env);
    const id = requireClean(context.params.id, 'id');

    const row = await readDebt(db, id, userId);

    if (!row) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_get',
        code: 'DEBT_NOT_FOUND',
        error: 'Debt not found',
        id,
        committed: false,
        writes_performed: false,
        read_only: true
      }, 404);
    }

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_item_get',
      committed: false,
      writes_performed: false,
      read_only: true,
      debt: normalizeDebt(row),
      allowed_actions: [
        'update',
        'defer',
        'archive',
        'reactivate'
      ],
      blocked_actions: [
        'pay',
        'receive',
        'payment',
        'settle',
        'reverse'
      ],
      canonical_money_route: {
        route: '/api/debts',
        method: 'POST',
        action: 'payment'
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_item_get',
      code: 'DEBT_ITEM_GET_FAILED',
      error: err.message || String(err),
      committed: false,
      writes_performed: false,
      read_only: true
    }, 500);
  }
}

export async function onRequestPut(context) {
  return handleWrite(context, 'PUT');
}

export async function onRequestPost(context) {
  return handleWrite(context, 'POST');
}

export async function onRequestPatch(context) {
  return handleWrite(context, 'PATCH');
}

async function handleWrite(context, method) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'Unauthorized' }, 401);

    const db = requireDb(context.env);
    const id = requireClean(context.params.id, 'id');
    const body = await readJson(context.request);
    const action = clean(body.action || 'update').toLowerCase();

    const row = await readDebt(db, id, userId);

    if (!row) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: `debt_item_${action}`,
        code: 'DEBT_NOT_FOUND',
        error: 'Debt not found',
        id,
        committed: false,
        writes_performed: false
      }, 404);
    }

    if (BLOCKED_MONEY_ACTIONS.has(action)) {
      return blockedMoneyAction({
        method,
        id,
        action,
        reason: 'This action can change money truth and is blocked on /api/debts/:id.'
      });
    }

    const forbiddenFields = findBlockedMoneyFields(body);

    if (forbiddenFields.length) {
      return blockedMoneyAction({
        method,
        id,
        action,
        reason: 'This request contains fields that can change money truth and are blocked on /api/debts/:id.',
        forbidden_fields: forbiddenFields
      });
    }

    if (action === 'defer') {
      return deferDebt(db, id, body, row, method, userId);
    }

    if (action === 'archive') {
      return setNonMoneyStatus(db, id, 'archived', body.notes, row, {
        method,
        action: 'archive',
        reason: 'Debt archived without ledger/account movement.'
      }, userId);
    }

    if (action === 'reactivate') {
      return setNonMoneyStatus(db, id, 'active', body.notes, row, {
        method,
        action: 'reactivate',
        reason: 'Debt reactivated without ledger/account movement.'
      }, userId);
    }

    if (action === 'update' || action === 'edit' || action === 'schedule_update') {
      return updateDebtNonMoney(db, id, body, row, method, userId);
    }

    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: `debt_item_${action}`,
      code: 'UNSUPPORTED_DEBT_ITEM_ACTION',
      error: `Unsupported debt item action "${action}".`,
      id,
      supported_actions: [
        'update',
        'defer',
        'archive',
        'reactivate'
      ],
      canonical_money_route: {
        route: '/api/debts',
        method: 'POST',
        action: 'payment'
      },
      committed: false,
      writes_performed: false
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_item_write',
      code: 'DEBT_ITEM_WRITE_FAILED',
      error: err.message || String(err),
      committed: false,
      writes_performed: false
    }, 500);
  }
}

async function updateDebtNonMoney(db, id, body, beforeRow, method, userId) {
  const columns = await getColumns(db, 'debts');
  const before = normalizeDebt(beforeRow);
  const patch = {};

  if ('name' in body) {
    const nextName = clean(body.name);
    if (!nextName) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_update',
        code: 'NAME_REQUIRED',
        error: 'name cannot be empty',
        id,
        committed: false,
        writes_performed: false
      }, 400);
    }
    patch.name = nextName;
  }

  if ('due_date' in body || 'next_due_date' in body) {
    patch.due_date = normalizeDate(body.due_date || body.next_due_date);
  }

  if ('due_day' in body) {
    const day = normalizeDueDay(body.due_day);

    if (body.due_day !== null && body.due_day !== '' && day == null) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_update',
        code: 'INVALID_DUE_DAY',
        error: 'due_day must be between 1 and 31',
        id,
        committed: false,
        writes_performed: false
      }, 400);
    }

    patch.due_day = day;
  }

  if ('installment_amount' in body || 'installment' in body || 'monthly_payment' in body) {
    const amount = normalizeNullableMoney(body.installment_amount ?? body.installment ?? body.monthly_payment);

    if ((body.installment_amount ?? body.installment ?? body.monthly_payment) !== null &&
        (body.installment_amount ?? body.installment ?? body.monthly_payment) !== '' &&
        amount == null) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_update',
        code: 'INVALID_INSTALLMENT_AMOUNT',
        error: 'installment_amount must be 0 or greater',
        id,
        committed: false,
        writes_performed: false
      }, 400);
    }

    patch.installment_amount = amount;
  }

  if ('frequency' in body) {
    const frequency = normalizeFrequency(body.frequency);

    if (!frequency) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_update',
        code: 'INVALID_FREQUENCY',
        error: 'frequency must be monthly, weekly, yearly, or custom',
        id,
        committed: false,
        writes_performed: false
      }, 400);
    }

    patch.frequency = frequency;
  }

  if ('snowball_order' in body) {
    patch.snowball_order = nullableNumber(body.snowball_order);
  }

  if ('last_paid_date' in body) {
    return blockedMoneyAction({
      method,
      id,
      action: 'update',
      reason: 'last_paid_date is payment-derived and cannot be manually edited here.',
      forbidden_fields: ['last_paid_date']
    });
  }

  if ('status' in body) {
    const status = normalizeAllowedManualStatus(body.status);

    if (!status) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_update',
        code: 'INVALID_OR_MONEY_STATUS',
        error: 'Only active or paused can be set by generic update. Use archive/reactivate actions for non-money lifecycle changes. Payment/settlement is canonical only through POST /api/debts action=payment.',
        id,
        committed: false,
        writes_performed: false
      }, 409);
    }

    patch.status = status;
  }

  if ('notes' in body) {
    patch.notes = clean(body.notes);
  }

  const keys = Object.keys(patch).filter(key => columns.has(key));

  if (!keys.length) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_item_update',
      code: 'NO_SUPPORTED_NON_MONEY_FIELDS',
      error: 'No supported non-money fields supplied.',
      id,
      supported_fields: [
        'name',
        'due_date',
        'next_due_date',
        'due_day',
        'installment_amount',
        'frequency',
        'snowball_order',
        'status: active|paused only',
        'notes'
      ],
      committed: false,
      writes_performed: false
    }, 400);
  }

  await db.prepare(
    `UPDATE debts
        SET ${keys.map(key => `${key} = ?`).join(', ')}
      WHERE TRIM(id) = TRIM(?) AND user_id = ?`
  ).bind(...keys.map(key => patch[key]), id, userId).run();

  const after = normalizeDebt(await readDebt(db, id, userId));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_item_update',
    method,
    id,
    committed: true,
    writes_performed: true,
    money_movement: false,
    ledger: {
      created: false,
      transaction_id: null,
      account_delta: 0
    },
    account: {
      balance_source: 'ledger',
      impacted: false
    },
    before: debtAuditSummary(before),
    after: debtAuditSummary(after),
    debt: after,
    proof: {
      route_role: 'non_money_item_update',
      updated_fields: keys,
      blocked_money_fields_enforced: true
    },
    warnings: []
  });
}

async function deferDebt(db, id, body, beforeRow, method, userId) {
  const columns = await getColumns(db, 'debts');
  const before = normalizeDebt(beforeRow);

  const patch = {};

  const nextDate = normalizeDate(body.next_due_date || body.due_date || body.follow_up_date);
  const nextDay = body.due_day === undefined ? undefined : normalizeDueDay(body.due_day);
  const note = clean(body.notes);

  if (nextDate) patch.due_date = nextDate;

  if (body.due_day !== undefined) {
    if (body.due_day !== null && body.due_day !== '' && nextDay == null) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_item_defer',
        code: 'INVALID_DUE_DAY',
        error: 'due_day must be between 1 and 31',
        id,
        committed: false,
        writes_performed: false
      }, 400);
    }

    patch.due_day = nextDay;
  }

  if (!nextDate && body.due_day === undefined) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_item_defer',
      code: 'DEFER_DATE_OR_DAY_REQUIRED',
      error: 'Provide next_due_date/due_date or due_day to defer.',
      id,
      committed: false,
      writes_performed: false
    }, 400);
  }

  if (columns.has('notes')) {
    patch.notes = appendNote(beforeRow.notes, note, nextDate ? `Deferred to ${nextDate}` : `Due day changed to ${nextDay}`);
  }

  const keys = Object.keys(patch).filter(key => columns.has(key));

  await db.prepare(
    `UPDATE debts
        SET ${keys.map(key => `${key} = ?`).join(', ')}
      WHERE TRIM(id) = TRIM(?) AND user_id = ?`
  ).bind(...keys.map(key => patch[key]), id, userId).run();

  const after = normalizeDebt(await readDebt(db, id, userId));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_item_defer',
    method,
    id,
    committed: true,
    writes_performed: true,
    money_movement: false,
    ledger: {
      created: false,
      transaction_id: null,
      account_delta: 0
    },
    account: {
      balance_source: 'ledger',
      impacted: false
    },
    before: debtAuditSummary(before),
    after: debtAuditSummary(after),
    debt: after,
    proof: {
      route_role: 'non_money_schedule_update',
      updated_fields: keys,
      account_effect: 'none'
    },
    warnings: []
  });
}

async function setNonMoneyStatus(db, id, status, incomingNote, beforeRow, meta, userId) {
  const columns = await getColumns(db, 'debts');
  const before = normalizeDebt(beforeRow);

  const patch = {
    status
  };

  if (columns.has('notes')) {
    patch.notes = appendNote(beforeRow.notes, incomingNote, `Status changed to ${status}`);
  }

  const keys = Object.keys(patch).filter(key => columns.has(key));

  await db.prepare(
    `UPDATE debts
        SET ${keys.map(key => `${key} = ?`).join(', ')}
      WHERE TRIM(id) = TRIM(?) AND user_id = ?`
  ).bind(...keys.map(key => patch[key]), id, userId).run();

  const after = normalizeDebt(await readDebt(db, id, userId));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: `debt_item_${meta.action}`,
    method: meta.method,
    id,
    committed: true,
    writes_performed: true,
    money_movement: false,
    ledger: {
      created: false,
      transaction_id: null,
      account_delta: 0
    },
    account: {
      balance_source: 'ledger',
      impacted: false
    },
    before: debtAuditSummary(before),
    after: debtAuditSummary(after),
    debt: after,
    proof: {
      route_role: 'non_money_status_update',
      status,
      account_effect: 'none',
      reason: meta.reason
    },
    warnings: []
  });
}

function blockedMoneyAction(input) {
  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: `debt_item_${input.action || 'blocked'}`,
    code: 'DEBT_ITEM_MONEY_ACTION_BLOCKED',
    error: input.reason || 'Money action blocked on /api/debts/:id.',
    method: input.method || null,
    id: input.id || null,
    forbidden_fields: input.forbidden_fields || [],

    canonical_money_route: {
      route: '/api/debts',
      method: 'POST',
      action: 'payment',
      payload_example: {
        action: 'payment',
        debt_id: input.id || 'debt_id_here',
        amount: 2500,
        account_id: 'account_id_here',
        date: 'YYYY-MM-DD',
        notes: 'Payment notes',
        idempotency_key: 'client-generated-key'
      }
    },

    canonical_reversal_route: {
      route: '/api/transactions/reverse',
      method: 'POST'
    },

    committed: false,
    writes_performed: false,
    warnings: [
      'No debt row was updated.',
      'No ledger transaction was created.',
      'No account balance was affected.',
      'Use canonical Debts payment route for money movement.'
    ]
  }, 409);
}

async function readDebt(db, id, userId) {
  return db.prepare(
    `SELECT ${DEBT_COLUMNS}
       FROM debts
      WHERE TRIM(id) = TRIM(?) AND user_id = ?
      LIMIT 1`
  ).bind(id, userId).first();
}

function normalizeDebt(row) {
  const original = round2(row?.original_amount || 0);
  const paid = round2(row?.paid_amount || 0);
  const remaining = Math.max(0, round2(original - paid));
  const kind = normalizeKind(row?.kind) || 'owe';
  const status = normalizeStatus(row?.status || 'active');

  return {
    id: clean(row?.id),
    name: clean(row?.name),
    kind,
    direction: kind === 'owed' ? 'owed_to_me' : 'i_owe',
    original_amount: original,
    paid_amount: paid,
    remaining_amount: remaining,
    outstanding_amount: remaining,
    snowball_order: row?.snowball_order == null ? null : Number(row.snowball_order),
    due_date: normalizeDate(row?.due_date),
    due_day: normalizeDueDay(row?.due_day),
    installment_amount: normalizeNullableMoney(row?.installment_amount),
    frequency: normalizeFrequency(row?.frequency || 'monthly') || 'monthly',
    last_paid_date: normalizeDate(row?.last_paid_date),
    next_due_date: normalizeDate(row?.due_date),
    status,
    terminal: TERMINAL_STATUSES.has(status),
    notes: clean(row?.notes),
    created_at: row?.created_at || null,
    allowed_actions: allowedActions(status)
  };
}

function debtAuditSummary(debt) {
  return {
    id: debt.id,
    name: debt.name,
    kind: debt.kind,
    original_amount: debt.original_amount,
    paid_amount: debt.paid_amount,
    remaining_amount: debt.remaining_amount,
    due_date: debt.due_date,
    due_day: debt.due_day,
    installment_amount: debt.installment_amount,
    frequency: debt.frequency,
    status: debt.status
  };
}

function allowedActions(status) {
  if (TERMINAL_STATUSES.has(String(status || '').toLowerCase())) {
    return ['update', 'reactivate'];
  }

  return ['update', 'defer', 'archive', 'reactivate'];
}

function findBlockedMoneyFields(body) {
  const present = [];

  for (const field of BLOCKED_MONEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body || {}, field)) {
      present.push(field);
    }
  }

  return present;
}

async function getColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map(row => row.name).filter(Boolean));
}

function normalizeKind(value) {
  const text = clean(value).toLowerCase();

  if (['i_owe', 'owe', 'payable', 'debt', 'debt_out', 'borrowed'].includes(text)) return 'owe';
  if (['owed_to_me', 'owed', 'owed_me', 'receivable', 'to_me', 'debt_in'].includes(text)) return 'owed';

  return null;
}

function normalizeStatus(value) {
  const text = clean(value || 'active').toLowerCase();

  if (!text) return 'active';
  if (text === 'paused') return 'paused';
  if (text === 'active') return 'active';
  if (TERMINAL_STATUSES.has(text)) return text;

  return 'active';
}

function normalizeAllowedManualStatus(value) {
  const text = clean(value || '').toLowerCase();

  if (text === 'active') return 'active';
  if (text === 'paused') return 'paused';

  return null;
}

function normalizeDate(value) {
  const raw = clean(value);

  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;

  return raw.slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  if (!Number.isFinite(n) || n < 1 || n > 31) return null;

  return Math.floor(n);
}

function normalizeFrequency(value) {
  const text = clean(value || 'monthly').toLowerCase();

  return ['monthly', 'weekly', 'yearly', 'custom'].includes(text) ? text : null;
}

function normalizeNullableMoney(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) return null;

  return round2(n);
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function appendNote(existing, incoming, systemNote) {
  return [
    clean(existing),
    systemNote ? `[${new Date().toISOString()}] ${systemNote}` : '',
    clean(incoming)
  ].filter(Boolean).join(' | ').slice(0, 1000);
}

function round2(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function requireClean(value, field) {
  const text = clean(value);

  if (!text) throw new Error(`${field} required`);

  return text;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB is missing.');
  return env.DB;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
