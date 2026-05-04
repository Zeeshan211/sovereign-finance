/* ─── Sovereign Finance · Budgets Catch-All API · v0.2.0 ───
 * Mirrors goals/debts/bills/accounts pattern.
 *
 * Schema reality:
 *   - category_id is the natural primary key (one budget per category)
 *   - monthly_amount = fixed envelope cap
 *   - status added 2026-05-04 for soft-delete
 *   - notes optional
 *   - "spent_this_period" computed live from transactions WHERE category_id matches AND date >= start of current month
 *
 * Routes:
 *   GET    /api/budgets                  → list (active) + summary + live spent computation
 *   POST   /api/budgets                  → create
 *   GET    /api/budgets/{category_id}    → single + live spent
 *   PUT    /api/budgets/{category_id}    → edit (snapshot + audit)
 *   DELETE /api/budgets/{category_id}?created_by=web → soft-delete (snapshot + audit)
 *
 * Banking-grade per Active Principle #2.
 */

import { json, audit, snapshot } from '../_lib.js';

/* ─── Helpers ─── */
function startOfMonthUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function endOfMonthUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

async function spentForCategory(db, categoryId, startDate, endDate) {
  const r = await db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS spent
       FROM transactions
       WHERE category_id = ?
         AND type = 'expense'
         AND date >= ?
         AND date <= ?
         AND (reversed_by IS NULL OR reversed_by = '')`
    )
    .bind(categoryId, startDate, endDate)
    .first();
  return Number(r?.spent || 0);
}

function computeBudgetUI(b, spent) {
  const cap = Number(b.monthly_amount) || 0;
  const remaining = Math.max(0, cap - spent);
  const overspent = Math.max(0, spent - cap);
  const pct = cap > 0 ? Math.min(999, Math.round((spent / cap) * 100)) : 0;

  let status_label;
  if (cap === 0) status_label = 'no cap';
  else if (overspent > 0) status_label = 'over';
  else if (pct >= 90) status_label = 'critical';
  else if (pct >= 75) status_label = 'warning';
  else status_label = 'on track';

  return {
    ...b,
    spent_this_period: spent,
    remaining,
    overspent,
    pct,
    status_label,
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

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[budgets api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

/* ─── GET /api/budgets ─── */
async function handleList(db) {
  const rs = await db
    .prepare(`SELECT * FROM budgets WHERE status = 'active' OR status IS NULL ORDER BY monthly_amount DESC, category_id ASC`)
    .all();
  const rows = rs.results || [];

  const startDate = startOfMonthUTC();
  const endDate = endOfMonthUTC();

  const enriched = await Promise.all(
    rows.map(async b => {
      const spent = await spentForCategory(db, b.category_id, startDate, endDate);
      return computeBudgetUI(b, spent);
    })
  );

  const total_cap = enriched.reduce((s, b) => s + (Number(b.monthly_amount) || 0), 0);
  const total_spent = enriched.reduce((s, b) => s + (Number(b.spent_this_period) || 0), 0);
  const total_remaining = enriched.reduce((s, b) => s + (Number(b.remaining) || 0), 0);
  const over_count = enriched.filter(b => b.overspent > 0).length;

  return json({
    ok: true,
    budgets: enriched,
    count: enriched.length,
    total_cap,
    total_spent,
    total_remaining,
    over_count,
    period_start: startDate,
    period_end: endDate,
  });
}

/* ─── POST /api/budgets ─── */
async function handleCreate(db, request) {
  const body = await request.json().catch(() => ({}));
  const category_id = (body.category_id || '').trim();
  const monthly_amount = Number(body.monthly_amount);
  const notes = body.notes || null;

  if (!category_id) return json({ ok: false, error: 'category_id is required' }, 400);
  if (category_id.length > 40) return json({ ok: false, error: 'category_id too long (max 40)' }, 400);
  if (monthly_amount === undefined || monthly_amount === null || isNaN(monthly_amount)) {
    return json({ ok: false, error: 'monthly_amount is required' }, 400);
  }
  if (monthly_amount < 0) return json({ ok: false, error: 'monthly_amount cannot be negative' }, 400);

  const existing = await db.prepare(`SELECT category_id FROM budgets WHERE category_id = ?`).bind(category_id).first();
  if (existing) return json({ ok: false, error: 'Budget for this category already exists — edit it instead' }, 409);

  await db
    .prepare(
      `INSERT INTO budgets (category_id, monthly_amount, notes, status)
       VALUES (?, ?, ?, 'active')`
    )
    .bind(category_id, monthly_amount, notes)
    .run();

  await audit(db, {
    action: 'BUDGET_CREATE',
    entity_type: 'budget',
    entity_id: category_id,
    details: { category_id, monthly_amount, notes },
    created_by: 'web',
  });

  return json({ ok: true, category_id, action: 'BUDGET_CREATE' });
}

/* ─── GET /api/budgets/{category_id} ─── */
async function handleSingle(db, categoryId) {
  const row = await db.prepare(`SELECT * FROM budgets WHERE category_id = ?`).bind(categoryId).first();
  if (!row) return json({ ok: false, error: 'Budget not found' }, 404);
  const spent = await spentForCategory(db, categoryId, startOfMonthUTC(), endOfMonthUTC());
  return json({ ok: true, budget: computeBudgetUI(row, spent) });
}

/* ─── PUT /api/budgets/{category_id} ─── */
async function handleEdit(db, categoryId, request) {
  const body = await request.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM budgets WHERE category_id = ?`).bind(categoryId).first();
  if (!existing) return json({ ok: false, error: 'Budget not found' }, 404);

  const allowed = ['monthly_amount', 'notes', 'status'];
  const updates = {};
  for (const k of allowed) {
    if (k in body && body[k] !== undefined) updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No editable fields supplied' }, 400);
  }

  if ('monthly_amount' in updates) {
    const a = Number(updates.monthly_amount);
    if (isNaN(a)) return json({ ok: false, error: 'monthly_amount must be a number' }, 400);
    if (a < 0) return json({ ok: false, error: 'monthly_amount cannot be negative' }, 400);
    updates.monthly_amount = a;
  }

  // Snapshot before mutation
  const snapId = await snapshot(db, {
    label: `budget_edit_${categoryId}_${Date.now()}`,
    tables: ['budgets'],
    where: `category_id = '${categoryId}'`,
  });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  await db.prepare(`UPDATE budgets SET ${sets} WHERE category_id = ?`).bind(...vals, categoryId).run();

  await audit(db, {
    action: 'BUDGET_EDIT',
    entity_type: 'budget',
    entity_id: categoryId,
    details: { before: existing, after: updates, snapshot_id: snapId },
    created_by: 'web',
  });

  return json({ ok: true, category_id: categoryId, updated_fields: Object.keys(updates), snapshot_id: snapId });
}

/* ─── DELETE /api/budgets/{category_id} ─── */
async function handleDelete(db, categoryId, request) {
  const url = new URL(request.url);
  const created_by = url.searchParams.get('created_by') || 'web';

  const existing = await db.prepare(`SELECT * FROM budgets WHERE category_id = ?`).bind(categoryId).first();
  if (!existing) return json({ ok: false, error: 'Budget not found' }, 404);
  if (existing.status === 'deleted') return json({ ok: false, error: 'Already deleted' }, 409);

  const snapId = await snapshot(db, {
    label: `budget_delete_${categoryId}_${Date.now()}`,
    tables: ['budgets'],
    where: `category_id = '${categoryId}'`,
  });

  await db
    .prepare(`UPDATE budgets SET status = 'deleted' WHERE category_id = ?`)
    .bind(categoryId)
    .run();

  await audit(db, {
    action: 'BUDGET_DELETE',
    entity_type: 'budget',
    entity_id: categoryId,
    details: { before: existing, snapshot_id: snapId },
    created_by,
  });

  return json({ ok: true, category_id: categoryId, action: 'BUDGET_DELETE', snapshot_id: snapId });
}
