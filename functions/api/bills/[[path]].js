/*  Sovereign Finance  /api/bills/[[path]]  v0.3.5  Rs 0 bill backend trust guard  */
/*
 * Handles:
 *   GET    /api/bills
 *   POST   /api/bills
 *   GET    /api/bills/{id}
 *   PUT    /api/bills/{id}
 *   DELETE /api/bills/{id}
 *   POST   /api/bills/{id}/pay
 *
 * Contract:
 *   - Bill payments validate selected payment account.
 *   - Non-zero DB bills create expense transactions.
 *   - Rs 0 DB bills are always mark_done, regardless of browser-sent amount.
 *   - Rs 0 bills never create fake Rs 0 or Rs 1 transactions.
 *   - last_paid_date and last_paid_account_id are saved.
 *   - Snapshot failure blocks destructive edit/delete and real non-zero payment.
 *   - Rs 0 mark_done may proceed even if snapshot fails because it only updates bill paid metadata.
 *   - Audit failure does not break successful DB mutations.
 *   - Delete/archive stays soft-only.
 */

import { json, audit, snapshot, uuid } from '../_lib.js';

const VERSION = 'v0.3.5';
const ALLOWED_FREQ = ['monthly', 'weekly', 'yearly', 'custom'];
const CONDITION_VISIBLE_BILL = "(deleted_at IS NULL OR deleted_at = '')";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length === 1) {
      const id = path[0];

      const bill = await db.prepare(
        `SELECT * FROM bills
         WHERE id = ?
           AND ${CONDITION_VISIBLE_BILL}`
      ).bind(id).first();

      if (!bill) return json({ ok: false, version: VERSION, error: 'Bill not found' }, 404);

      return json({ ok: true, version: VERSION, bill: decorateBill(bill) });
    }

    const bills = await db.prepare(
      `SELECT * FROM bills
       WHERE ${CONDITION_VISIBLE_BILL}
       ORDER BY due_day, name`
    ).all();

    return json({
      ok: true,
      version: VERSION,
      count: (bills.results || []).length,
      bills: (bills.results || []).map(decorateBill)
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = context.params.path || [];

    if (path.length === 2 && path[1] === 'pay') {
      return payBill(context, path[0]);
    }

    if (path.length === 0) {
      return createBill(context);
    }

    return json({ ok: false, version: VERSION, error: 'Path not supported for POST' }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createBill(context) {
  const db = context.env.DB;
  const body = await readJSON(context.request);

  const name = String(body.name || '').trim();
  const amount = Number(body.amount);

  if (!name) return json({ ok: false, version: VERSION, error: 'name required' }, 400);
  if (name.length > 80) return json({ ok: false, version: VERSION, error: 'name max 80 chars' }, 400);
  if (!Number.isFinite(amount) || amount < 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be 0 or greater' }, 400);
  }

  const frequency = body.frequency || 'monthly';
  if (!ALLOWED_FREQ.includes(frequency)) {
    return json({ ok: false, version: VERSION, error: 'Invalid frequency' }, 400);
  }

  const dueDay = body.due_day == null || body.due_day === '' ? null : Number(body.due_day);

  if (dueDay != null && (dueDay < 1 || dueDay > 31)) {
    return json({ ok: false, version: VERSION, error: 'due_day must be 1-31' }, 400);
  }

  const id = body.id || ('BILL-' + uuid());
  const autoPost = body.auto_post ? 1 : 0;
  const defaultAccountId = cleanNullable(body.default_account_id);

  if (defaultAccountId) {
    const accountCheck = await validateAccount(db, defaultAccountId);
    if (!accountCheck.ok) return json({ ok: false, version: VERSION, error: accountCheck.error }, 400);
  }

  await db.prepare(
    `INSERT INTO bills
      (id, name, amount, due_day, frequency, category_id, default_account_id, auto_post, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).bind(
    id,
    name,
    amount,
    dueDay,
    frequency,
    body.category_id || null,
    defaultAccountId,
    autoPost
  ).run();

  const auditResult = await safeAudit(context.env, {
    action: 'BILL_CREATE',
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: {
      id,
      name,
      amount,
      due_day: dueDay,
      frequency,
      category_id: body.category_id || null,
      default_account_id: defaultAccountId,
      auto_post: !!autoPost
    },
    created_by: body.created_by || 'web-bill-create'
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires bill id' }, 400);
    }

    const id = path[0];
    const body = await readJSON(context.request);

    const bill = await db.prepare(
      `SELECT * FROM bills
       WHERE id = ?
         AND ${CONDITION_VISIBLE_BILL}`
    ).bind(id).first();

    if (!bill) return json({ ok: false, version: VERSION, error: 'Bill not found' }, 404);

    const snap = await safeSnapshot(context.env, 'pre-bill-edit-' + id + '-' + Date.now(), body.created_by || 'web-bill-edit');
    if (!snap.ok) {
      return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);
    }

    const updates = [];
    const values = [];
    const editable = [
      'name',
      'amount',
      'due_day',
      'frequency',
      'category_id',
      'default_account_id',
      'auto_post',
      'last_paid_date',
      'last_paid_account_id'
    ];

    for (const field of editable) {
      if (body[field] === undefined) continue;

      if (field === 'name') {
        const name = String(body[field] || '').trim();
        if (!name) return json({ ok: false, version: VERSION, error: 'name cannot be empty' }, 400);
        if (name.length > 80) return json({ ok: false, version: VERSION, error: 'name max 80 chars' }, 400);
        updates.push('name = ?');
        values.push(name);
        continue;
      }

      if (field === 'amount') {
        const amount = Number(body[field]);
        if (!Number.isFinite(amount) || amount < 0) {
          return json({ ok: false, version: VERSION, error: 'amount must be 0 or greater' }, 400);
        }
        updates.push('amount = ?');
        values.push(amount);
        continue;
      }

      if (field === 'due_day') {
        const dueDay = body[field] == null || body[field] === '' ? null : Number(body[field]);
        if (dueDay != null && (dueDay < 1 || dueDay > 31)) {
          return json({ ok: false, version: VERSION, error: 'due_day must be 1-31' }, 400);
        }
        updates.push('due_day = ?');
        values.push(dueDay);
        continue;
      }

      if (field === 'frequency') {
        const frequency = body[field] || 'monthly';
        if (!ALLOWED_FREQ.includes(frequency)) {
          return json({ ok: false, version: VERSION, error: 'Invalid frequency' }, 400);
        }
        updates.push('frequency = ?');
        values.push(frequency);
        continue;
      }

      if (field === 'auto_post') {
        updates.push('auto_post = ?');
        values.push(body[field] ? 1 : 0);
        continue;
      }

      if (field === 'default_account_id' || field === 'last_paid_account_id') {
        const accountId = cleanNullable(body[field]);
        if (accountId) {
          const accountCheck = await validateAccount(db, accountId);
          if (!accountCheck.ok) return json({ ok: false, version: VERSION, error: accountCheck.error }, 400);
        }
        updates.push(field + ' = ?');
        values.push(accountId);
        continue;
      }

      if (field === 'last_paid_date') {
        const date = cleanNullable(body[field]);
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return json({ ok: false, version: VERSION, error: 'last_paid_date must be YYYY-MM-DD' }, 400);
        }
        updates.push('last_paid_date = ?');
        values.push(date);
        continue;
      }

      updates.push(field + ' = ?');
      values.push(body[field] || null);
    }

    if (updates.length === 0) {
      return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    values.push(id);

    await db.prepare(
      'UPDATE bills SET ' + updates.join(', ') + ' WHERE id = ?'
    ).bind(...values).run();

    const auditResult = await safeAudit(context.env, {
      action: 'BILL_UPDATE',
      entity: 'bill',
      entity_id: id,
      kind: 'mutation',
      detail: {
        updated_fields: updates.map(x => x.split(' = ')[0]),
        snapshot_id: snap.snapshot_id || null,
        body
      },
      created_by: body.created_by || 'web-bill-edit'
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      updated_fields: updates.map(x => x.split(' = ')[0]),
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
      return json({ ok: false, version: VERSION, error: 'Path requires bill id' }, 400);
    }

    const id = path[0];
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || 'delete';
    const createdBy = url.searchParams.get('created_by') || 'web-bill-delete';

    const bill = await db.prepare(
      `SELECT * FROM bills
       WHERE id = ?
         AND ${CONDITION_VISIBLE_BILL}`
    ).bind(id).first();

    if (!bill) return json({ ok: false, version: VERSION, error: 'Bill not found' }, 404);

    const snap = await safeSnapshot(context.env, 'pre-bill-' + action + '-' + id + '-' + Date.now(), createdBy);
    if (!snap.ok) {
      return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);
    }

    if (action === 'archive') {
      await db.prepare(
        "UPDATE bills SET status = 'archived' WHERE id = ?"
      ).bind(id).run();

      const auditResult = await safeAudit(context.env, {
        action: 'BILL_ARCHIVE',
        entity: 'bill',
        entity_id: id,
        kind: 'mutation',
        detail: {
          archived: true,
          snapshot_id: snap.snapshot_id || null
        },
        created_by: createdBy
      });

      return json({
        ok: true,
        version: VERSION,
        id,
        status: 'archived',
        snapshot_id: snap.snapshot_id || null,
        audited: auditResult.ok,
        audit_error: auditResult.error || null
      });
    }

    await db.prepare(
      "UPDATE bills SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?"
    ).bind(id).run();

    const auditResult = await safeAudit(context.env, {
      action: 'BILL_DELETE',
      entity: 'bill',
      entity_id: id,
      kind: 'mutation',
      detail: {
        soft_delete: true,
        snapshot_id: snap.snapshot_id || null
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      status: 'deleted',
      soft_delete: true,
      snapshot_id: snap.snapshot_id || null,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function payBill(context, billId) {
  const db = context.env.DB;
  const body = await readJSON(context.request);

  const bill = await db.prepare(
    `SELECT * FROM bills
     WHERE id = ?
       AND ${CONDITION_VISIBLE_BILL}`
  ).bind(billId).first();

  if (!bill) return json({ ok: false, version: VERSION, error: 'Bill not found' }, 404);

  const dbBillAmount = Number(bill.amount);
  if (!Number.isFinite(dbBillAmount) || dbBillAmount < 0) {
    return json({ ok: false, version: VERSION, error: 'Stored bill amount is invalid' }, 400);
  }

  const requestedAccountId = cleanNullable(body.account_id);
  const defaultAccountId = cleanNullable(bill.default_account_id);
  const accountId = requestedAccountId || defaultAccountId;

  /*
   * TRUST BOUNDARY:
   * The database bill amount decides whether this is mark_done or paid.
   * Browser/body amount must never upgrade a Rs 0 bill into a transaction.
   */
  const amount = dbBillAmount === 0
    ? 0
    : body.amount == null || body.amount === ''
      ? dbBillAmount
      : Number(body.amount);

  if (!Number.isFinite(amount) || amount < 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be 0 or greater' }, 400);
  }

  let accountCheck = { ok: true, account: null };

  if (accountId) {
    accountCheck = await validateAccount(db, accountId);
    if (!accountCheck.ok) return json({ ok: false, version: VERSION, error: accountCheck.error }, 400);
  }

  if (amount > 0 && !accountId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'account_id required for paid bill. Select a payment account or set default_account_id on this bill.'
    }, 400);
  }

  const date = body.date || new Date().toISOString().slice(0, 10);
  const createdBy = body.created_by || (amount === 0 ? 'web-bill-mark-done' : 'web-bill-pay');
  const accountSource = requestedAccountId ? 'request.account_id' : accountId ? 'bill.default_account_id' : 'none_zero_amount';

  if (amount === 0) {
    const snap = await safeSnapshot(context.env, 'pre-bill-mark-done-' + billId + '-' + Date.now(), createdBy);

    await db.prepare(
      `UPDATE bills
       SET last_paid_date = ?,
           last_paid_account_id = ?
       WHERE id = ?`
    ).bind(date, accountId || null, billId).run();

    const auditResult = await safeAudit(context.env, {
      action: 'BILL_MARK_DONE',
      entity: 'bill',
      entity_id: billId,
      kind: 'mutation',
      detail: {
        amount: 0,
        db_bill_amount: dbBillAmount,
        browser_amount_ignored: body.amount == null ? null : Number(body.amount),
        account_id: accountId || null,
        account_name: accountCheck.account ? accountCheck.account.name : null,
        account_source: accountSource,
        date,
        bill_name: bill.name,
        snapshot_id: snap.snapshot_id || null,
        snapshot_ok: snap.ok,
        snapshot_error: snap.error || null,
        transaction_created: false
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      mode: 'mark_done',
      bill_id: billId,
      txn_id: null,
      transaction_created: false,
      amount: 0,
      db_bill_amount: dbBillAmount,
      browser_amount_ignored: body.amount == null ? null : Number(body.amount),
      date,
      account_id: accountId || null,
      account_name: accountCheck.account ? accountCheck.account.name : null,
      account_source: accountSource,
      last_paid_account_id: accountId || null,
      snapshot_id: snap.snapshot_id || null,
      snapshot_ok: snap.ok,
      snapshot_error: snap.error || null,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  }

  const snap = await safeSnapshot(context.env, 'pre-bill-pay-' + billId + '-' + Date.now(), createdBy);
  if (!snap.ok) {
    return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);
  }

  const txnId = 'TXN-' + uuid();
  const notes = String(body.notes || ('Bill payment: ' + bill.name)).slice(0, 200);

  await db.batch([
    db.prepare(
      `INSERT INTO transactions
        (id, type, amount, date, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, 'expense', ?, ?, ?, NULL, NULL, ?, 0, 0)`
    ).bind(txnId, amount, date, accountId, notes),

    db.prepare(
      `UPDATE bills
       SET last_paid_date = ?,
           last_paid_account_id = ?
       WHERE id = ?`
    ).bind(date, accountId, billId)
  ]);

  const auditResult = await safeAudit(context.env, {
    action: 'BILL_PAY',
    entity: 'bill',
    entity_id: billId,
    kind: 'mutation',
    detail: {
      txn_id: txnId,
      amount,
      db_bill_amount: dbBillAmount,
      account_id: accountId,
      account_name: accountCheck.account ? accountCheck.account.name : null,
      account_source: accountSource,
      date,
      bill_name: bill.name,
      snapshot_id: snap.snapshot_id || null,
      transaction_created: true
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    mode: 'paid',
    bill_id: billId,
    txn_id: txnId,
    transaction_created: true,
    amount,
    db_bill_amount: dbBillAmount,
    date,
    account_id: accountId,
    account_name: accountCheck.account ? accountCheck.account.name : null,
    account_source: accountSource,
    last_paid_account_id: accountId,
    snapshot_id: snap.snapshot_id || null,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function validateAccount(db, accountId) {
  const account = await db.prepare(
    `SELECT * FROM accounts WHERE id = ? LIMIT 1`
  ).bind(accountId).first();

  if (!account) {
    return { ok: false, error: 'Payment account not found: ' + accountId };
  }

  const status = String(account.status || 'active').toLowerCase();
  if (status && status !== 'active') {
    return { ok: false, error: 'Payment account is not active: ' + accountId };
  }

  return { ok: true, account };
}

function decorateBill(bill) {
  const lastPaidDate = cleanNullable(bill.last_paid_date);

  return {
    ...bill,
    paid_this_month: isPaidThisMonth(lastPaidDate),
    can_mark_done: Number(bill.amount) === 0
  };
}

function isPaidThisMonth(dateText) {
  if (!dateText || !/^\d{4}-\d{2}-\d{2}/.test(dateText)) return false;

  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

  return dateText.slice(0, 7) === currentMonth;
}

function cleanNullable(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? text : null;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (e) {
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
