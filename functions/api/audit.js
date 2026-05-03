// /api/audit — read audit log (paginated, filterable)
// Query params: ?limit=50 &offset=0 &action=X &entity=Y &kind=Z

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const action = url.searchParams.get('action');
  const entity = url.searchParams.get('entity');
  const kind   = url.searchParams.get('kind');

  const where = [];
  const binds = [];
  if (action) { where.push('action = ?'); binds.push(action); }
  if (entity) { where.push('entity = ?'); binds.push(entity); }
  if (kind)   { where.push('kind = ?');   binds.push(kind); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const countRes = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`)
      .bind(...binds).first();

    const rowsRes = await env.DB
      .prepare(
        `SELECT id, timestamp, action, entity, entity_id, kind, detail, created_by, ip
         FROM audit_log ${whereSql}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset).all();

    return _json({
      ok: true,
      total: countRes?.n || 0,
      limit, offset,
      rows: rowsRes?.results || []
    });
  } catch (e) {
    return _json({ ok: false, error: e.message || String(e) }, 500);
  }
}

export const onRequestPost = () => _json({ ok: false, error: 'Read-only endpoint' }, 405);

function _json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
