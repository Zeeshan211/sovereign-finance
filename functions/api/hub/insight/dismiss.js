/* POST /api/hub/insight/dismiss */
const VERSION = 'v1.0.0-hub-insight-dismiss';

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

  const { insight_id, insight_signature, reason } = body;
  if (!insight_id || !insight_signature) return jsonErr('insight_id and insight_signature required', 400);

  const id = `idismiss_${userId}_${insight_signature}_${Date.now()}`;
  const now = new Date().toISOString();

  const existing = await db.prepare(
    `SELECT id FROM hub_insight_dismissals WHERE user_id = ? AND insight_signature = ?`
  ).bind(userId, insight_signature).first().catch(() => null);

  if (existing) {
    return json({ ok: true, version: VERSION, action: 'dismiss', committed: false, writes_performed: false, data: { already_dismissed: true } });
  }

  await db.prepare(
    `INSERT INTO hub_insight_dismissals (id, user_id, insight_signature, dismissed_at, reason) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, userId, insight_signature, now, reason || null).run();

  await db.prepare(
    `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(`audit_${id}`, userId, 'hub_insight_dismiss', 'hub_insight_dismissal', id, JSON.stringify({ insight_id, insight_signature, reason }), now).run().catch(() => null);

  await db.prepare(`DELETE FROM hub_snapshot_cache WHERE user_id = ?`).bind(userId).run().catch(() => null);

  return json({ ok: true, version: VERSION, action: 'dismiss', committed: true, writes_performed: true, data: { id } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function jsonErr(msg, status = 500) {
  return json({ ok: false, error: msg }, status);
}
