/* ─── Sovereign Finance · Goals Catch-All API · v0.2.0 ───
 * Mirrors debts/bills/accounts catch-all pattern.
 *
 * Routes:
 *   GET    /api/goals                       → list (active only) + summary
 *   POST   /api/goals                       → create
 *   GET    /api/goals/{id}                  → single
 *   PUT    /api/goals/{id}                  → edit (snapshot + audit)
 *   DELETE /api/goals/{id}?created_by=web   → soft-delete (snapshot + audit)
 *   POST   /api/goals/{id}/contribute       → add to current_amount
 *                                              + creates a transfer_out from source_account
 *                                              + audit + snapshot
 *
 * Banking-grade per Active Principle #2.
 */

import { json, audit, snapshot } from '../_lib.js';

/* ─── Helpers ─── */
function slugifyId(name) {
  const slug = String(name || 'goal')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  const rand = Math.random().toString(36).slice(2, 8);
  return 'goal_' + (slug || 'unnamed') + '_' + rand;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function computeGoalUI(g) {
  const target = Number(g.target_amount) || 0;
  const current = Number(g.current_amount) || 0;
  const remaining = Math.max(0, target - current);
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

  let daysToDeadline = null;
  let deadlineLabel = 'no deadline';
  if (g.deadline) {
    const dl = new Date(g.deadline);
    const now = new Date();
    daysToDeadline = Math.ceil((dl - now) / (1000 * 60 * 60 * 24));
    if (daysToDeadline < 0) deadlineLabel = `${Math.abs(daysToDeadline)} day${daysToDeadline === -1 ? '' : 's'} overdue`;
    else if (daysToDeadline === 0) deadlineLabel = 'due today';
    else if (daysToDeadline < 365) deadlineLabel = `${daysToDeadline} day${daysToDeadline === 1 ? '' : 's'} left`;
    else deadlineLabel = `${Math.round(daysToDeadline / 365 * 10) / 10} years left`;
  }

  return {
    ...g,
    remaining,
    pct,
    days_to_deadline: daysToDeadline,
    deadline_label: deadlineLabel,
    is_achieved: pct >= 100,
  };
}

/* ─── Cloudflare Pages Function entry ─── */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;
  const db = env.DB;

  try {
    if (segments.length === 0) {
      if (method === 'GET') return await handleList(db);
      if (method === 'POST') return await handleCreate(db, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 1) {
      const id = segments[0];
      if (method === 'GET') return await handleSingle(db, id);
      if (method === 'PUT') return await handleEdit(db, id, request);
      if (method === 'DELETE') return await handleDelete(db, id, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 2 && segments[1] === 'contribute') {
      if (method === 'POST') return await handleContribute(db, segments[0], request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[goals api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

/* ─── GET /api/goals ─── */
async function handleList(db) {
  const rs = await db
    .prepare(`SELECT * FROM goals WHERE status = 'active' ORDER BY display_order ASC, name ASC`)
    .all();
  const rows = (rs.results || []).map(computeGoalUI);

  const total_target = rows.reduce((s, g) => s + (Number(g.target_amount) || 0), 0);
  const total_current = rows.reduce((s, g) => s + (Number(g.current_amount) || 0), 0);
  const total_remaining = rows.reduce((s, g) => s + (Number(g.remaining) || 0), 0);
  const achieved_count = rows.filter(g => g.is_achieved).length;

  return json({
    ok: true,
    goals: rows,
    count: rows.length,
    total_target,
    total_current,
    total_remaining,
    achieved_count,
  });
}

/* ─── POST /api/goals ─── */
async function handleCreate(db, request) {
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const target_amount = Number(body.target_amount);
  const current_amount = Number(body.current_amount || 0);
  const deadline = body.deadline || null;
  const source_account_id = body.source_account_id || null;
  const display_order = Number(body.display_order || 99);
  const notes = body.notes || null;

  if (!name) return json({ ok: false, error: 'Name is required' }, 400);
  if (name.length > 80) return json({ ok: false, error: 'Name too long (max 80)' }, 400);
  if (!target_amount || target_amount <= 0) return json({ ok: false, error: 'Target amount must be > 0' }, 400);
  if (current_amount < 0) return json({ ok: false, error: 'Current amount cannot be negative' }, 400);

  const id = body.id || slugifyId(name);
  const existing = await db.prepare(`SELECT id FROM goals WHERE id = ?`).bind(id).first();
  if (existing) return json({ ok: false, error: 'Goal id already exists — pick a different name' }, 409);

  await db
    .prepare(
      `INSERT INTO goals
        (id, name, target_amount, current_amount, deadline, source_account_id,
         status, display_order, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    )
    .bind(id, name, target_amount, current_amount, deadline, source_account_id, display_order, notes)
    .run();

  await audit(db, {
    action: 'GOAL_CREATE',
    entity_type: 'goal',
    entity_id: id,
    details: { name, target_amount, current_amount, deadline, source_account_id, display_order },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'GOAL_CREATE' });
}

/* ─── GET /api/goals/{id} ─── */
async function handleSingle(db, id) {
  const row = await db.prepare(`SELECT * FROM goals WHERE id = ?`).bind(id).first();
  if (!row) return json({ ok: false, error: 'Goal not found' }, 404);
  return json({ ok: true, goal: computeGoalUI(row) });
}

/* ─── PUT /api/goals/{id} ─── */
async function handleEdit(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM goals WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Goal not found' }, 404);

  const allowed = ['name', 'target_amount', 'current_amount', 'deadline',
                   'source_account_id', 'display_order', 'notes', 'status'];
  const updates = {};
  for (const k of allowed) {
    if (k in body && body[k] !== undefined) updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No editable fields supplied' }, 400);
  }

  if ('name' in updates) {
    const n = String(updates.name || '').trim();
    if (!n) return json({ ok: false, error: 'Name cannot be empty' }, 400);
    if (n.length > 80) return json({ ok: false, error: 'Name too long' }, 400);
    updates.name = n;
  }
  if ('target_amount' in updates) {
    const a = Number(updates.target_amount);
    if (!a || a <= 0) return json({ ok: false, error: 'Target amount must be > 0' }, 400);
    updates.target_amount = a;
  }
  if ('current_amount' in updates) {
    const c = Number(updates.current_amount);
    if (c < 0) return json({ ok: false, error: 'Current amount cannot be negative' }, 400);
    updates.current_amount = c;
  }
  if ('display_order' in updates) updates.display_order = Number(updates.display_order) || 0;

  const snapId = await snapshot(db, {
    label: `goal_edit_${id}_${Date.now()}`,
    tables: ['goals'],
    where: `id = '${id}'`,
  });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  await db.prepare(`UPDATE goals SET ${sets} WHERE id = ?`).bind(...vals, id).run();

  await audit(db, {
    action: 'GOAL_EDIT',
    entity_type: 'goal',
    entity_id: id,
    details: { before: existing, after: updates, snapshot_id: snapId },
    created_by: 'web',
  });

  return json({ ok: true, id, updated_fields: Object.keys(updates), snapshot_id: snapId });
}

/* ─── DELETE /api/goals/{id} ─── */
async function handleDelete(db, id, request) {
  const url = new URL(request.url);
  const created_by = url.searchParams.get('created_by') || 'web';

  const existing = await db.prepare(`SELECT * FROM goals WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Goal not found' }, 404);
  if (existing.status === 'deleted') return json({ ok: false, error: 'Already deleted' }, 409);

  const snapId = await snapshot(db, {
    label: `goal_delete_${id}_${Date.now()}`,
    tables: ['goals'],
    where: `id = '${id}'`,
  });

  await db
    .prepare(`UPDATE goals SET status = 'deleted' WHERE id = ?`)
    .bind(id)
    .run();

  await audit(db, {
    action: 'GOAL_DELETE',
    entity_type: 'goal',
    entity_id: id,
    details: { before: existing, snapshot_id: snapId },
    created_by,
  });

  return json({ ok: true, id, action: 'GOAL_DELETE', snapshot_id: snapId });
}

/* ─── POST /api/goals/{id}/contribute ─── */
async function handleContribute(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const amount = Number(body.amount);
  const account_id = body.account_id || null;
  const date = body.date || todayUTC();
  const notes = body.notes || null;

  if (!amount || amount <= 0) return json({ ok: false, error: 'Amount must be > 0' }, 400);

  const goal = await db.prepare(`SELECT * FROM goals WHERE id = ? AND status = 'active'`).bind(id).first();
  if (!goal) return json({ ok: false, error: 'Goal not found or deleted' }, 404);

  // If account specified, verify it exists
  let txnId = null;
  if (account_id) {
    const acc = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(account_id).first();
    if (!acc) return json({ ok: false, error: `Account ${account_id} not found` }, 400);
  }

  const snapId = await snapshot(db, {
    label: `goal_contribute_${id}_${Date.now()}`,
    tables: ['goals'],
    where: `id = '${id}'`,
  });

  // Optionally create a transfer_out txn from the source account
  if (account_id) {
    txnId = 'TXN-GOAL-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const txnNotes = notes || `Goal contribution: ${goal.name}`;
    await db
      .prepare(
        `INSERT INTO transactions
          (id, type, amount, date, account_id, notes, created_at)
         VALUES (?, 'expense', ?, ?, ?, ?, ?)`
      )
      .bind(txnId, amount, date, account_id, txnNotes, new Date().toISOString())
      .run();
  }

  // Bump current_amount
  const newAmount = (Number(goal.current_amount) || 0) + amount;
  await db
    .prepare(`UPDATE goals SET current_amount = ? WHERE id = ?`)
    .bind(newAmount, id)
    .run();

  await audit(db, {
    action: 'GOAL_CONTRIBUTE',
    entity_type: 'goal',
    entity_id: id,
    details: {
      goal_name: goal.name,
      amount,
      account_id,
      date,
      txn_id: txnId,
      previous_current: goal.current_amount,
      new_current: newAmount,
      snapshot_id: snapId,
    },
    created_by: 'web',
  });

  return json({
    ok: true,
    id,
    txn_id: txnId,
    snapshot_id: snapId,
    action: 'GOAL_CONTRIBUTE',
    new_current_amount: newAmount,
  });
}
