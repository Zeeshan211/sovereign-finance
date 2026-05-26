/* POST /api/hub/event/defer */
const VERSION = 'v1.0.0-hub-event-defer';

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

  const { event_id, new_date, reason } = body;
  if (!event_id || !new_date) return jsonErr('event_id and new_date required', 400);

  const now = new Date().toISOString();

  // Only bills can be deferred for v1
  if (!event_id.startsWith('bill_')) {
    return json({ ok: false, version: VERSION, action: 'defer', committed: false, writes_performed: false, error: 'Only bill events can be deferred in v1' }, 400);
  }

  // Extract bill_id from event_id format "bill_{billId}_{date}"
  const parts = event_id.replace('bill_', '').split('_');
  const billId = parts[0];
  if (!billId) return jsonErr('Could not extract bill_id from event_id', 400);

  // Verify bill belongs to user
  const bill = await db.prepare(
    `SELECT id, user_id FROM bills WHERE id = ? AND user_id = ?`
  ).bind(billId, userId).first();

  if (!bill) return jsonErr('Bill not found or unauthorized', 404);

  // Update bill next_due_date
  await db.prepare(
    `UPDATE bills SET next_due_date = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).bind(new_date, now, billId, userId).run();

  // Audit log
  const auditId = `audit_defer_${billId}_${Date.now()}`;
  await db.prepare(
    `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(auditId, userId, 'hub_event_defer', 'bill', billId, JSON.stringify({ event_id, new_date, reason }), now).run().catch(() => null);

  // Invalidate snapshot cache
  await db.prepare(`DELETE FROM hub_snapshot_cache WHERE user_id = ?`).bind(userId).run().catch(() => null);

  return json({ ok: true, version: VERSION, action: 'defer', committed: true, writes_performed: true, data: { bill_id: billId, new_date } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function jsonErr(msg, status = 500) {
  return json({ ok: false, error: msg }, status);
}
