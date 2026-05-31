/* ─── /api/goals/[[path]] · v0.3.0 · TRACE-AUDIT FIXES ─── */
/*
 * Changes vs v0.2.0 (per TRACE audit findings 3, 7, 13):
 *   - Audit signature fix: was {entity_type, details} → now {entity, detail} per _lib.js contract
 *   - Snapshot signature fix: was snapshot(db, {label, tables, where}) → now snapshot(env, label, createdBy)
 *   - Contribute handler now blocks overflow past target_amount (returns 400 if would exceed)
 *   - Contribute INSERT uses correct column 'category_id' (was already correct, double-checked)
 *
 * Deferred (semantic, not correctness):
 *   - Goals contribute uses type='expense' — should arguably be type='transfer' to a goal-account
 *     destination. Math works. Semantic improvement for next session.
 */

import { json, audit, snapshot, uuid } from '../_lib.js';

const ALLOWED_STATUS = ['active', 'completed', 'paused', 'archived'];

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length === 1) {
      const id = path[0];
      const goal = await db.prepare(
        "SELECT * FROM goals WHERE id = ?"
      ).bind(id).first();
      if (!goal) return json({ ok: false, error: 'Goal not found' }, 404);
      return json({ ok: true, goal: enrichGoal(goal) });
    }

    const goals = await db.prepare(
      "SELECT * FROM goals WHERE status != 'archived' OR status IS NULL ORDER BY display_order, deadline"
    ).all();
    return json({ ok: true, goals: (goals.results || []).map(enrichGoal) });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

function enrichGoal(g) {
  const target = Number(g.target_amount) || 0;
  const current = Number(g.current_amount) || 0;
  const remaining = Math.max(0, target - current);
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  return {
    ...g,
    remaining,
    pct,
    is_complete: target > 0 && current >= target
  };
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    // POST /api/goals/{id}/contribute
    if (path.length === 2 && path[1] === 'contribute') {
      return await contributeGoal(context, path[0]);
    }

    // POST /api/goals → create
    if (path.length === 0) {
      const body = await context.request.json();
      if (!body.name || !body.target_amount) {
        return json({ ok: false, error: 'name + target_amount required' }, 400);
      }

      const id = body.id || ('GOAL-' + uuid());

      await db.prepare(
        "INSERT INTO goals (id, name, target_amount, current_amount, deadline, source_account_id, status, display_order, notes) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)"
      ).bind(
        id, body.name, body.target_amount,
        body.current_amount || 0,
        body.deadline || null,
        body.source_account_id || null,
        body.display_order || 0,
        body.notes || null
      ).run();

      await audit(context.env, {
        action: 'GOAL_CREATE',
        entity: 'goal',
        entity_id: id,
        kind: 'mutation',
        detail: JSON.stringify(body),
        created_by: body.created_by || 'web-goal-create'
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
    if (path.length !== 1) return json({ ok: false, error: 'Path requires goal id' }, 400);

    const id = path[0];
    const body = await context.request.json();
    const existing = await db.prepare("SELECT * FROM goals WHERE id = ?").bind(id).first();
    if (!existing) return json({ ok: false, error: 'Goal not found' }, 404);

    if (body.status && !ALLOWED_STATUS.includes(body.status)) {
      return json({ ok: false, error: 'Invalid status' }, 400);
    }

    // Snapshot before mutation (correct signature)
    await snapshot(context.env, 'pre-goal-edit-' + id + '-' + Date.now(), body.created_by || 'web-goal-edit');

    const updates = [];
    const values = [];
    const editable = ['name', 'target_amount', 'current_amount', 'deadline', 'source_account_id', 'status', 'display_order', 'notes'];
    editable.forEach(field => {
      if (body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(body[field]);
      }
    });
    if (updates.length === 0) return json({ ok: false, error: 'Nothing to update' }, 400);

    values.push(id);
    await db.prepare("UPDATE goals SET " + updates.join(', ') + " WHERE id = ?").bind(...values).run();

    await audit(context.env, {
      action: 'GOAL_UPDATE',
      entity: 'goal',
      entity_id: id,
      kind: 'mutation',
      detail: JSON.stringify({ before: existing, changes: body }),
      created_by: body.created_by || 'web-goal-edit'
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
    if (path.length !== 1) return json({ ok: false, error: 'Path requires goal id' }, 400);

    const id = path[0];
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || 'archive';
    const createdBy = url.searchParams.get('created_by') || 'web-goal-delete';

    const existing = await db.prepare("SELECT * FROM goals WHERE id = ?").bind(id).first();
    if (!existing) return json({ ok: false, error: 'Goal not found' }, 404);

    // Snapshot before mutation (correct signature)
    await snapshot(context.env, 'pre-goal-' + action + '-' + id + '-' + Date.now(), createdBy);

    const newStatus = action === 'complete' ? 'completed' : 'archived';
    await db.prepare("UPDATE goals SET status = ? WHERE id = ?").bind(newStatus, id).run();

    await audit(context.env, {
      action: 'GOAL_' + action.toUpperCase(),
      entity: 'goal',
      entity_id: id,
      kind: 'mutation',
      detail: JSON.stringify({ before: existing, new_status: newStatus }),
      created_by: createdBy
    });

    return json({ ok: true, id, status: newStatus });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

async function contributeGoal(context, goalId) {
  const db = context.env.DB;
  const body = await context.request.json();

  const goal = await db.prepare("SELECT * FROM goals WHERE id = ?").bind(goalId).first();
  if (!goal) return json({ ok: false, error: 'Goal not found' }, 404);
  if (goal.status === 'completed' || goal.status === 'archived') {
    return json({ ok: false, error: 'Goal is ' + goal.status + ', cannot contribute' }, 400);
  }

  const accountId = body.account_id || goal.source_account_id;
  if (!accountId) return json({ ok: false, error: 'account_id required (no source on goal)' }, 400);

  const amount = Number(body.amount);
  if (!amount || amount <= 0) return json({ ok: false, error: 'Invalid amount' }, 400);

  // Overflow check (per TRACE audit Finding 13)
  const target = Number(goal.target_amount) || 0;
  const current = Number(goal.current_amount) || 0;
  const newTotal = current + amount;
  if (target > 0 && newTotal > target) {
    return json({
      ok: false,
      error: 'Contribution would exceed target. Current: ' + current + ', target: ' + target + ', max contribution: ' + (target - current),
      max_contribution: target - current
    }, 400);
  }

  const date = body.date || new Date().toISOString().slice(0, 10);
  const txnId = 'TXN-' + uuid();

  // Snapshot before mutation (correct signature)
  await snapshot(context.env, 'pre-goal-contribute-' + goalId + '-' + Date.now(), body.created_by || 'web-goal-contribute');

  // Insert contribution as expense (semantic improvement deferred — math correct)
  await db.prepare(
    "INSERT INTO transactions (id, type, amount, date, account_id, category_id, notes) VALUES (?, 'expense', ?, ?, ?, ?, ?)"
  ).bind(
    txnId, amount, date, accountId,
    'other',
    'Goal contribution: ' + goal.name
  ).run();

  // Update goal current_amount
  await db.prepare("UPDATE goals SET current_amount = ? WHERE id = ?").bind(newTotal, goalId).run();

  // Auto-mark complete if target hit
  if (target > 0 && newTotal >= target) {
    await db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?").bind(goalId).run();
  }

  await audit(context.env, {
    action: 'GOAL_CONTRIBUTE',
    entity: 'goal',
    entity_id: goalId,
    kind: 'mutation',
    detail: JSON.stringify({
      txn_id: txnId,
      amount,
      account_id: accountId,
      date,
      new_current: newTotal,
      auto_completed: target > 0 && newTotal >= target
    }),
    created_by: body.created_by || 'web-goal-contribute'
  });

  return json({
    ok: true,
    goal_id: goalId,
    txn_id: txnId,
    amount,
    new_current: newTotal,
    completed: target > 0 && newTotal >= target
  });
}
