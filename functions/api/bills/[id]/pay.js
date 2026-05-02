/* ─── POST /api/bills/:id/pay — mark bill paid + create transaction ─── */

export async function onRequestPost(context) {
  try {
    const id = context.params.id;
    const body = await context.request.json();
    const db = context.env.DB;

    const bill = await db.prepare('SELECT * FROM bills WHERE id = ?').bind(id).first();
    if (!bill) return jsonResponse({ ok: false, error: 'Bill not found' }, 404);

    const amount = parseFloat(body.amount) || bill.amount;
    const accountId = body.account_id || bill.default_account_id;
    if (!accountId) return jsonResponse({ ok: false, error: 'account_id required' }, 400);

    const date = body.date || new Date().toISOString().slice(0, 10);
    const txId = 'tx_bill_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const notes = 'Bill: ' + bill.name;

    await db.prepare(
      `INSERT INTO transactions (id, date, type, amount, account_id, category_id, notes)
       VALUES (?, ?, 'expense', ?, ?, ?, ?)`
    ).bind(txId, date, amount, accountId, bill.category_id || 'bills', notes).run();

    await db.prepare('UPDATE bills SET last_paid_date = ? WHERE id = ?').bind(date, id).run();

    return jsonResponse({ ok: true, tx_id: txId, paid_amount: amount });
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
