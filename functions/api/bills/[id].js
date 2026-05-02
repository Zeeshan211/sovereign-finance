/* ─── /api/bills/:id — GET, PUT, DELETE ─── */

export async function onRequestGet(context) {
  try {
    const row = await context.env.DB.prepare('SELECT * FROM bills WHERE id = ?').bind(context.params.id).first();
    if (!row) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    return jsonResponse({ ok: true, bill: row });
  } catch (err) { return jsonResponse({ ok: false, error: err.message }, 500); }
}

export async function onRequestPut(context) {
  try {
    const id = context.params.id;
    const body = await context.request.json();
    await context.env.DB.prepare(
      `UPDATE bills SET name = ?, amount = ?, due_day = ?, frequency = ?,
                       category_id = ?, default_account_id = ?, auto_post = ?
       WHERE id = ?`
    ).bind(
      body.name, parseFloat(body.amount) || 0, parseInt(body.due_day) || 1,
      body.frequency || 'monthly', body.category_id || 'bills',
      body.default_account_id || null, body.auto_post ? 1 : 0, id
    ).run();
    return jsonResponse({ ok: true, id });
  } catch (err) { return jsonResponse({ ok: false, error: err.message }, 500); }
}

export async function onRequestDelete(context) {
  try {
    await context.env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(context.params.id).run();
    return jsonResponse({ ok: true });
  } catch (err) { return jsonResponse({ ok: false, error: err.message }, 500); }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  });
}
