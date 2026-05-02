/* ─── POST /api/debts/:id/pay — record payment ─── */

export async function onRequestPost(context) {
  try {
    const debtId = context.params.id;
    const body = await context.request.json();
    const amount = parseFloat(body.amount);
    if (isNaN(amount) || amount <= 0) {
      return jsonResponse({ ok: false, error: 'Amount must be > 0' }, 400);
    }
    if (!body.account_id) {
      return jsonResponse({ ok: false, error: 'account_id required' }, 400);
    }

    const db = context.env.DB;

    const debtStmt = db.prepare('SELECT * FROM debts WHERE id = ?').bind(debtId);
    const debt = await debtStmt.first();
    if (!debt) return jsonResponse({ ok: false, error: 'Debt not found' }, 404);

    const txType = debt.kind === 'owe' ? 'expense' : 'income';
    const categoryId = debt.kind === 'owe' ? 'debt' : 'gift';
    const date = body.date || new Date().toISOString().slice(0, 10);
    const txId = 'tx_pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const notes = (debt.kind === 'owe' ? 'Paid ' : 'Received from ') + debt.name;

    await db.prepare(
      `INSERT INTO transactions (id, date, type, amount, account_id, category_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(txId, date, txType, amount, body.account_id, categoryId, notes).run();

    const newPaid = (debt.paid_amount || 0) + amount;
    const status = newPaid >= debt.original_amount ? 'closed' : 'active';
    await db.prepare(
      'UPDATE debts SET paid_amount = ?, status = ? WHERE id = ?'
    ).bind(newPaid, status, debtId).run();

    return jsonResponse({
      ok: true,
      tx_id: txId,
      new_paid_amount: newPaid,
      status: status,
      remaining: debt.original_amount - newPaid
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
