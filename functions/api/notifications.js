/*
 * GET /api/notifications
 *
 * Returns recent in-app notifications for the authenticated user from
 * the notification_log table (written by the CC backend's emitNotification helper).
 *
 * Query params:
 *   limit  — max rows (default 20, cap 100)
 *   status — filter by status ('unread' | 'read' | all if omitted)
 *
 * Also supports:
 *   POST { action: 'mark_read', id }        — marks one notification read
 *   POST { action: 'mark_all_read' }        — marks all unread read
 */

import { json } from './_lib.js';

export async function onRequest(context) {
  const { env, request } = context;
  const method = request.method;

  try {
    const db     = requireDb(env);
    const userId = requireUserId(context);

    if (method === 'GET') {
      const url    = new URL(request.url);
      const limit  = Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10));
      const status = url.searchParams.get('status'); // 'unread' | 'read' | null (all)

      let sql = `
        SELECT id, user_id, card_id, notification_type, title, body, data, status, created_at
        FROM   notification_log
        WHERE  user_id = ?
      `;
      const binds = [userId];

      if (status === 'unread' || status === 'read') {
        sql += ` AND status = ?`;
        binds.push(status);
      }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const result = await db.prepare(sql).bind(...binds).all();
      const rows   = result.results || [];

      const unreadCount = rows.filter(r => r.status === 'unread').length;

      return json({
        ok:           true,
        count:        rows.length,
        unread_count: unreadCount,
        notifications: rows.map(r => ({
          id:                r.id,
          card_id:           r.card_id,
          notification_type: r.notification_type,
          title:             r.title,
          body:              r.body,
          status:            r.status,
          created_at:        r.created_at,
        })),
      });
    }

    if (method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const { action, id } = body;

      if (action === 'mark_read' && id) {
        await db.prepare(
          `UPDATE notification_log SET status = 'read' WHERE id = ? AND user_id = ?`
        ).bind(id, userId).run();
        return json({ ok: true, action: 'mark_read', id });
      }

      if (action === 'mark_all_read') {
        await db.prepare(
          `UPDATE notification_log SET status = 'read' WHERE user_id = ? AND status = 'unread'`
        ).bind(userId).run();
        return json({ ok: true, action: 'mark_all_read' });
      }

      return json({ ok: false, error: 'Unknown action', code: 'UNKNOWN_ACTION' }, 400);
    }

    return json({ ok: false, error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);

  } catch (e) {
    if (e.status === 401) {
      return json({ ok: false, error: 'Session required', code: 'UNAUTHORIZED' }, 401);
    }
    return json({ ok: false, error: e.message || String(e), code: 'INTERNAL_ERROR' }, 500);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB not found');
  return env.DB;
}

function requireUserId(context) {
  const userId = context.data?.user_id;
  if (!userId) {
    const e = new Error('Session required');
    e.status = 401;
    throw e;
  }
  return userId;
}
