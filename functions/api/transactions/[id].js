/* ─── /api/transactions/:id — GET, PUT, DELETE single tx ─── */
/* Cloudflare Pages Function v0.2.0 */

export async function onRequestGet(context) {
  try {
    const id = context.params.id;
    const stmt = context.env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, fee_amount, pra_amount, created_at
       FROM transactions WHERE id = ?`
    ).bind(id);
    const row = await stmt.first();

    if (!row) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    return jsonResponse({ ok: true, transaction: row });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const id = context.params.id;
    const body = await context.request.json();

    const amount = parseFloat(body.amount);
    if (isNaN(amount) || amount <= 0) {
      return jsonResponse({ ok: false, error: 'Amount must be greater than 0' }, 400);
    }
    if (!body.account_id) {
      return jsonResponse({ ok: false, error: 'account_id required' }, 400);
    }
    const allowedTypes = ['expense','income','transfer','cc_payment','cc_spend','borrow','repay','atm'];
    if (!allowedTypes.includes(body.type)) {
      return jsonResponse({ ok: false, error: 'Invalid type' }, 400);
    }

    const date = body.date || new Date().toISOString().slice(0, 10);
    const notes = (body.notes || '').slice(0, 200);

    const stmt = context.env.DB.prepare(
      `UPDATE transactions
       SET date = ?, type = ?, amount = ?, account_id = ?,
           transfer_to_account_id = ?, category_id = ?, notes = ?
       WHERE id = ?`
    ).bind(
      date, body.type, amount, body.account_id,
      body.transfer_to_account_id || null,
      body.category_id || 'other',
      notes, id
    );
    const result = await stmt.run();

    if (!result.success) return jsonResponse({ ok: false, error: 'Update failed' }, 500);
    return jsonResponse({ ok: true, id: id });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const id = context.params.id;
    const stmt = context.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(id);
    const result = await stmt.run();
    if (!result.success) return jsonResponse({ ok: false, error: 'Delete failed' }, 500);
    return jsonResponse({ ok: true, id: id });
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
