/* /api/onboarding
 * Sovereign Finance · Onboarding Status + Completion
 *
 * GET  /api/onboarding          — check completion status
 * POST /api/onboarding          — action: "complete" → seed categories + mark done
 *
 * Per-user isolation: every write is stamped with getUserId(context).
 * Category IDs are per-user UUIDs to avoid PRIMARY KEY conflicts across users.
 */

import { getUserId, json, uuid, audit } from '../_lib.js';

const VERSION = 'v1.0.0-onboarding';

const SEED_CATEGORIES = [
  { slug: 'food',      name: 'Food & Dining',    icon: '🍽️', type: 'expense', order: 10 },
  { slug: 'grocery',   name: 'Groceries',         icon: '🛒', type: 'expense', order: 20 },
  { slug: 'transport', name: 'Transport',          icon: '🚗', type: 'expense', order: 30 },
  { slug: 'bills',     name: 'Bills & Utilities',  icon: '⚡', type: 'expense', order: 40 },
  { slug: 'health',    name: 'Health',             icon: '🏥', type: 'expense', order: 50 },
  { slug: 'personal',  name: 'Personal',           icon: '👤', type: 'expense', order: 60 },
  { slug: 'family',    name: 'Family',             icon: '👨‍👩‍👧', type: 'expense', order: 70 },
  { slug: 'gift',      name: 'Gifts',              icon: '🎁', type: 'expense', order: 80 },
  { slug: 'other',     name: 'Other',              icon: '📦', type: 'expense', order: 90 },
  { slug: 'salary',    name: 'Salary',             icon: '💰', type: 'income',  order: 100 },
  { slug: 'transfer',  name: 'Transfer',           icon: '🔄', type: 'system',  order: 200 },
  { slug: 'cc_pay',    name: 'CC Payment',         icon: '💳', type: 'system',  order: 210 },
  { slug: 'debt',      name: 'Debt',               icon: '📝', type: 'system',  order: 220 },
];

export async function onRequestGet(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const prefs = await context.env.DB.prepare(
      `SELECT onboarding_completed FROM user_preferences WHERE user_id = ?`
    ).bind(userId).first();

    return json({
      ok: true,
      version: VERSION,
      onboarding_completed: Boolean(prefs?.onboarding_completed)
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await context.request.json().catch(() => ({}));
    const action = String(body.action || '').toLowerCase();

    if (action !== 'complete') {
      return json({ ok: false, version: VERSION, error: 'unknown action; expected action="complete"' }, 400);
    }

    const db = context.env.DB;

    // Seed default categories for this user if they have none
    const existing = await db.prepare(
      `SELECT COUNT(*) as cnt FROM categories WHERE user_id = ?`
    ).bind(userId).first();

    let categoriesSeeded = 0;

    if (!existing?.cnt || Number(existing.cnt) === 0) {
      // Generate unique per-user category IDs to avoid PRIMARY KEY conflicts
      const userTag = userId.replace(/[^a-z0-9]/gi, '').toLowerCase().substring(4, 10);

      for (const cat of SEED_CATEGORIES) {
        const catId = `${cat.slug}_${userTag}_${uuid()}`.substring(0, 60);
        await db.prepare(
          `INSERT OR IGNORE INTO categories (id, name, icon, type, display_order, user_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(catId, cat.name, cat.icon, cat.type, cat.order, userId).run();
        categoriesSeeded++;
      }
    }

    // Upsert user_preferences row with onboarding_completed = 1
    await db.prepare(
      `INSERT INTO user_preferences (user_id, onboarding_completed, updated_at)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE
         SET onboarding_completed = 1, updated_at = datetime('now')`
    ).bind(userId).run();

    await audit(context.env, {
      action: 'ONBOARDING_COMPLETE',
      entity: 'users',
      entity_id: userId,
      kind: 'mutation',
      detail: { categories_seeded: categoriesSeeded },
      created_by: userId,
      user_id: userId
    });

    return json({
      ok: true,
      version: VERSION,
      action: 'complete',
      committed: true,
      writes_performed: true,
      data: { categories_seeded: categoriesSeeded }
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}
