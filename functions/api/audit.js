/* ─── /api/audit — read audit_log entries with filters ─── */

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 200, 500);
    const action = url.searchParams.get('action') || '';

    let query = 'SELECT * FROM audit_log';
    const binds = [];
    if (action) {
      query += ' WHERE action = ?';
      binds.push(action);
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    binds.push(limit);

    const stmt = context.env.DB.prepare(query).bind(...binds);
    const result = await stmt.all();
    const rows = result.results || [];

    const actionsResult = await context.env.DB.prepare(
      'SELECT DISTINCT action, COUNT(*) as count FROM audit_log GROUP BY action ORDER BY count DESC'
    ).all();

    return jsonResponse({
      ok: true,
      count: rows.length,
      entries: rows,
      actions: actionsResult.results || []
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  });
}
