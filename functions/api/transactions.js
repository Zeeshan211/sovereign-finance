/* ─── /api/transactions — GET list, POST create ─── */
/* Cloudflare Pages Function v0.0.8 */

export async function onRequestGet(context) {
  try {
    const stmt = context.env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, fee_amount, pra_amount, created_at
       FROM transactions
       ORDER BY date DESC, created_at DESC
       LIMIT 200`
    );
    const result = await stmt.all();

    return jsonResponse({
      ok: true,
      count: result.results.length,
      transactions: result.results
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    // Validate required fields
    const amount = parseFloat(body.amount);
    if (isNaN(amount) || amount <= 0) {
      return jsonResponse({ ok: false, error: 'Amount must be greater than 0' }, 400);
    }
    if (!body.account_id) {
      return jsonResponse({ ok: false, error: 'account_id required' }, 400);
    }
    if (!body.type) {
      return jsonResponse({ ok: false, error: 'type required' }, 400);
    }

    const allowedTypes = ['expense','income','transfer','cc_payment','cc_spend','borrow','repay','atm'];
    if (!allowedTypes.includes(body.type)) {
      return jsonResponse({ ok: false, error: 'Invalid type' }, 400);
    }

    // Generate ID and timestamps
    const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const date = body.date || new Date().toISOString().slice(0, 10);
    const notes = (body.notes || '').slice(0, 200);

    // Insert
    const stmt = context.env.DB.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      date,
      body.type,
      amount,
      body.account_id,
      body.transfer_to_account_id || null,
      body.category_id || 'other',
      notes,
      body.fee_amount || 0,
      body.pra_amount || 0
    );

    await stmt.run();

    return jsonResponse({ ok: true, id: id });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
