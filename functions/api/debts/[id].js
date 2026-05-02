/* ─── /api/debts/:id — GET / PUT / DELETE single debt ─── */

export async function onRequestGet(context) {
  try {
    const stmt = context.env.DB.prepare(
      'SELECT * FROM debts WHERE id = ?'
    ).bind(context.params.id);
    const row = await stmt.first();
    if (!row) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    return jsonResponse({ ok: true, debt: row });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const id = context.params.id;
    const body = await context.request.json();
    const stmt = context.env.DB.prepare(
      `UPDATE debts SET name = ?, kind = ?, original_amount = ?, paid_amount = ?,
                       snowball_order = ?, due_date = ?, status = ?, notes = ?
       WHERE id = ?`
    ).bind(
      body.name, body.kind, body.original_amount, body.paid_amount,
      body.snowball_order || 0, body.due_date || null,
      body.status || 'active', body.notes || null, id
    );
    await stmt.run();
    return jsonResponse({ ok: true, id });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const stmt = context.env.DB.prepare('DELETE FROM debts WHERE id = ?').bind(context.params.id);
    await stmt.run();
    return jsonResponse({ ok: true });
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
