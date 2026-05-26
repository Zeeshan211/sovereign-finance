/* POST /api/hub/inbox/dismiss */
const VERSION = 'v1.0.0-hub-inbox-dismiss';

export async function onRequestPost(context) {
  const db = context.env.DB;
  const userId = context.data.user_id;
  if (!userId) return jsonErr('Unauthorized', 401);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return jsonErr('Invalid JSON body', 400);
  }

  const { item_id, item_signature, reason } = body;
  if (!item_id || !item_signature) return jsonErr('item_id and item_signature required', 400);

  const id = `dismiss_${userId}_${item_signature}_${Date.now()}`;
  const now = new Date().toISOString();

  // Idempotency: check if already dismissed
  const existing = await db.prepare(
    `SELECT id FROM hub_dismissals WHERE user_id = ? AND item_signature = ?`
  ).bind(userId, item_signature).first().catch(() => null);

  if (existing) {
    return json({ ok: true, version: VERSION, action: 'dismiss', committed: false, writes_performed: false, data: { already_dismissed: true } });
  }

  await db.prepare(
    `INSERT INTO hub_dismissals (id, user_id, item_signature, dismissed_at, reason) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, userId, item_signature, now, reason || null).run();

  // Audit log
  await db.prepare(
    `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(`audit_${id}`, userId, 'hub_inbox_dismiss', 'hub_dismissal', id, JSON.stringify({ item_id, item_signature, reason }), now).run().catch(() => null);

  // Invalidate snapshot cache
  await db.prepare(`DELETE FROM hub_snapshot_cache WHERE user_id = ?`).bind(userId).run().catch(() => null);

  return json({ ok: true, version: VERSION, action: 'dismiss', committed: true, writes_performed: true, data: { id } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function jsonErr(msg, status = 500) {
  return json({ ok: false, error: msg }, status);
}
