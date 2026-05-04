/* ─── Sovereign Finance · Bills Catch-All API · v0.2.0 ───
 * Mirrors debts/[[path]].js v0.2.0 architecture.
 *
 * Routes:
 *   GET    /api/bills                     → list with computed status + summary
 *   POST   /api/bills                     → create (audit + auto-id)
 *   GET    /api/bills/{id}                → single
 *   PUT    /api/bills/{id}                → edit (snapshot + audit)
 *   DELETE /api/bills/{id}?created_by=web → soft-delete (snapshot + audit)
 *   POST   /api/bills/{id}/pay            → atomic txn create + last_paid_date bump + audit
 *
 * Frontend contract (bills.js v0.8.0):
 *   POST /api/bills        → {name, amount, due_day, default_account_id, category_id}
 *   POST /api/bills/{id}/pay → {amount, account_id, date}
 *
 * Banking-grade per Active Principle #2: snap-before-mutate + audit-after-write.
 */

import { json, uuid, audit, snapshot } from '../_lib.js';

/* ─── Helpers ─── */
function slugifyId(name) {
  const slug = String(name || 'bill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 10);
  return 'bill_' + (slug || 'unnamed') + '_' + rand;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function periodKey(dateStr, frequency) {
  // For monthly bills: YYYY-MM key. (Other frequencies treated as monthly for now — extend later.)
  const d = dateStr ? new Date(dateStr) : new Date();
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function computeBillUI(bill) {
  // Adds: paidThisPeriod, daysLabel, status (paid|upcoming|due-today|overdue)
  const today = new Date();
  const currentPeriod = periodKey(today.toISOString(), bill.frequency || 'monthly');
  const paidPeriod = bill.last_paid_date
    ? periodKey(bill.last_paid_date, bill.frequency || 'monthly')
    : null;
  const paidThisPeriod = paidPeriod === currentPeriod;

  const todayDay = today.getUTCDate();
  const dueDay = Number(bill.due_day) || 1;
  const daysUntilDue = dueDay - todayDay;

  let status, daysLabel;
  if (paidThisPeriod) {
    status = 'paid';
    daysLabel = 'paid this month';
  } else if (daysUntilDue === 0) {
    status = 'due-today';
    daysLabel = 'due today';
  } else if (daysUntilDue > 0) {
    status = 'upcoming';
    daysLabel = `due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`;
  } else {
    status = 'overdue';
    const lateBy = Math.abs(daysUntilDue);
    daysLabel = `${lateBy} day${lateBy === 1 ? '' : 's'} late`;
  }

  return { ...bill, paidThisPeriod, daysLabel, status };
}

/* ─── Cloudflare Pages Function entry ─── */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path; // undefined | string[] from [[path]].js
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;
  const db = env.DB;

  try {
    // /api/bills (no segments)
    if (segments.length === 0) {
      if (method === 'GET') return await handleList(db);
      if (method === 'POST') return await handleCreate(db, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    // /api/bills/{id}
    if (segments.length === 1) {
      const id = segments[0];
      if (method === 'GET') return await handleSingle(db, id);
      if (method === 'PUT') return await handleEdit(db, id, request);
      if (method === 'DELETE') return await handleDelete(db, id, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    // /api/bills/{id}/pay
    if (segments.length === 2 && segments[1] === 'pay') {
      if (method === 'POST') return await handlePay(db, segments[0], request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[bills api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

/* ─── GET /api/bills ─── */
async function handleList(db) {
  const rs = await db
    .prepare(`SELECT * FROM bills WHERE status = 'active' ORDER BY due_day ASC, name ASC`)
    .all();
  const rows = (rs.results || []).map(computeBillUI);

  const total_monthly = rows.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const remaining_this_period = rows
    .filter(b => !b.paidThisPeriod)
    .reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const paid_count = rows.filter(b => b.paidThisPeriod).length;

  return json({
    ok: true,
    bills: rows,
    count: rows.length,
    total_monthly,
    remaining_this_period,
    paid_count,
  });
}

/* ─── POST /api/bills ─── */
async function handleCreate(db, request) {
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const amount = Number(body.amount);
  const due_day = Math.max(1, Math.min(31, Number(body.due_day) || 1));
  const frequency = body.frequency || 'monthly';
  const category_id = body.category_id || 'bills';
  const default_account_id = body.default_account_id || null;
  const auto_post = body.auto_post ? 1 : 0;

  if (!name) return json({ ok: false, error: 'Name is required' }, 400);
  if (name.length > 80) return json({ ok: false, error: 'Name too long (max 80)' }, 400);
  if (!amount || amount <= 0) return json({ ok: false, error: 'Amount must be > 0' }, 400);

  const id = body.id || slugifyId(name);

  const existing = await db.prepare(`SELECT id FROM bills WHERE id = ?`).bind(id).first();
  if (existing) return json({ ok: false, error: 'Bill id already exists — pick a different name' }, 409);

  await db
    .prepare(
      `INSERT INTO bills
        (id, name, amount, due_day, frequency, category_id, default_account_id,
         last_paid_date, auto_post, status, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', NULL)`
    )
    .bind(id, name, amount, due_day, frequency, category_id, default_account_id, auto_post)
    .run();

  await audit(db, {
    action: 'BILL_CREATE',
    entity_type: 'bill',
    entity_id: id,
    details: { name, amount, due_day, frequency, category_id, default_account_id },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'BILL_CREATE' });
}

/* ─── GET /api/bills/{id} ─── */
async function handleSingle(db, id) {
  const row = await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!row) return json({ ok: false, error: 'Bill not found' }, 404);
  return json({ ok: true, bill: computeBillUI(row) });
}

/* ─── PUT /api/bills/{id} ─── */
async function handleEdit(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Bill not found' }, 404);

  const allowed = ['name', 'amount', 'due_day', 'frequency', 'category_id', 'default_account_id', 'auto_post', 'status'];
  const updates = {};
  for (const k of allowed) {
    if (k in body && body[k] !== undefined) updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No editable fields supplied' }, 400);
  }

  // Validate
  if ('name' in updates) {
    const n = String(updates.name || '').trim();
    if (!n) return json({ ok: false, error: 'Name cannot be empty' }, 400);
    if (n.length > 80) return json({ ok: false, error: 'Name too long' }, 400);
    updates.name = n;
  }
  if ('amount' in updates) {
    const a = Number(updates.amount);
    if (!a || a <= 0) return json({ ok: false, error: 'Amount must be > 0' }, 400);
    updates.amount = a;
  }
  if ('due_day' in updates) {
    updates.due_day = Math.max(1, Math.min(31, Number(updates.due_day) || 1));
  }
  if ('auto_post' in updates) updates.auto_post = updates.auto_post ? 1 : 0;

  // Snapshot before mutation
  const snapId = await snapshot(db, {
    label: `bill_edit_${id}_${Date.now()}`,
    tables: ['bills'],
    where: `id = '${id}'`,
  });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  await db
    .prepare(`UPDATE bills SET ${sets} WHERE id = ?`)
    .bind(...vals, id)
    .run();

  await audit(db, {
    action: 'BILL_EDIT',
    entity_type: 'bill',
    entity_id: id,
    details: { before: existing, after: updates, snapshot_id: snapId },
    created_by: 'web',
  });

  return json({ ok: true, id, updated_fields: Object.keys(updates), snapshot_id: snapId });
}

/* ─── DELETE /api/bills/{id} ─── */
async function handleDelete(db, id, request) {
  const url = new URL(request.url);
  const created_by = url.searchParams.get('created_by') || 'web';

  const existing = await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Bill not found' }, 404);
  if (existing.status === 'deleted') return json({ ok: false, error: 'Already deleted' }, 409);

  const snapId = await snapshot(db, {
    label: `bill_delete_${id}_${Date.now()}`,
    tables: ['bills'],
    where: `id = '${id}'`,
  });

  await db
    .prepare(`UPDATE bills SET status = 'deleted', deleted_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run();

  await audit(db, {
    action: 'BILL_DELETE',
    entity_type: 'bill',
    entity_id: id,
    details: { before: existing, snapshot_id: snapId },
    created_by,
  });

  return json({ ok: true, id, action: 'BILL_DELETE', snapshot_id: snapId });
}

/* ─── POST /api/bills/{id}/pay ─── */
async function handlePay(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const account_id = body.account_id;
  const date = body.date || todayUTC();
  const notes = body.notes || null;

  if (!amount || amount <= 0) return json({ ok: false, error: 'Amount must be > 0' }, 400);
  if (!account_id) return json({ ok: false, error: 'account_id is required' }, 400);

  const bill = await db.prepare(`SELECT * FROM bills WHERE id = ? AND status = 'active'`).bind(id).first();
  if (!bill) return json({ ok: false, error: 'Bill not found or deleted' }, 404);

  // Verify account exists
  const acc = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(account_id).first();
  if (!acc) return json({ ok: false, error: `Account ${account_id} not found` }, 400);

  // Snapshot before mutation (covers both bill row and the new transaction)
  const snapId = await snapshot(db, {
    label: `bill_pay_${id}_${Date.now()}`,
    tables: ['bills'],
    where: `id = '${id}'`,
  });

  // Create transaction (expense out of account, category from bill)
  const txnId = uuid('txn');
  const category = bill.category_id || 'bills';
  const txnNotes = notes || `Bill payment: ${bill.name}`;

  await db
    .prepare(
      `INSERT INTO transactions
        (id, type, amount, date, account_id, category, notes, created_at)
       VALUES (?, 'expense', ?, ?, ?, ?, ?, ?)`
    )
    .bind(txnId, amount, date, account_id, category, txnNotes, new Date().toISOString())
    .run();

  // Bump last_paid_date
  await db
    .prepare(`UPDATE bills SET last_paid_date = ? WHERE id = ?`)
    .bind(date, id)
    .run();

  await audit(db, {
    action: 'BILL_PAY',
    entity_type: 'bill',
    entity_id: id,
    details: {
      bill_name: bill.name,
      amount,
      account_id,
      date,
      txn_id: txnId,
      snapshot_id: snapId,
    },
    created_by: 'web',
  });

  return json({ ok: true, id, txn_id: txnId, snapshot_id: snapId, action: 'BILL_PAY' });
}
