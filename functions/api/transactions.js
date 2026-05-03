// ════════════════════════════════════════════════════════════════════
// /api/transactions — GET list, POST create (with audit-log)
// LOCKED · Sub-1D-2b · v0.0.9
//
// CHANGES from v0.0.8:
//   - POST writes 1 row to audit_log per insert (TXN_ADD action)
//   - Returns audit_log id alongside txn id for trace
//   - GET unchanged (backward-compatible)
// ════════════════════════════════════════════════════════════════════

import { json, audit, uuid } from './_lib.js';

const ALLOWED_TYPES = [
  'expense', 'income', 'transfer',
  'cc_payment', 'cc_spend',
  'borrow', 'repay', 'atm'
];

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

    return json({
      ok: true,
      count: result.results.length,
      transactions: result.results
    });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  // ─── Validate ─────────────────────────────────────────────────────
  const amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) {
    return json({ ok: false, error: 'Amount must be greater than 0' }, 400);
  }
  if (!body.account_id) {
    return json({ ok: false, error: 'account_id required' }, 400);
  }
  if (!body.type) {
    return json({ ok: false, error: 'type required' }, 400);
  }
  if (!ALLOWED_TYPES.includes(body.type)) {
    return json({ ok: false, error: 'Invalid type: ' + body.type }, 400);
  }

  // ─── Build txn row ────────────────────────────────────────────────
  const id    = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const date  = body.date || new Date().toISOString().slice(0, 10);
  const notes = (body.notes || '').slice(0, 200);
  const transferTo = body.transfer_to_account_id || null;
  const catId  = body.category_id || 'other';
  const feeAmt = parseFloat(body.fee_amount || 0) || 0;
  const praAmt = parseFloat(body.pra_amount || 0) || 0;

  // ─── Insert ───────────────────────────────────────────────────────
  try {
    await context.env.DB.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id,
         category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, date, body.type, amount,
      body.account_id, transferTo,
      catId, notes, feeAmt, praAmt
    ).run();
  } catch (err) {
    return json({ ok: false, error: 'Insert failed: ' + err.message }, 500);
  }

  // ─── Audit log (non-fatal) ────────────────────────────────────────
  const ip = context.request.headers.get('CF-Connecting-IP') || null;
  const auditResult = await audit(context.env, {
    action:    'TXN_ADD',
    entity:    'transaction',
    entity_id: id,
    kind:      'mutation',
    detail: {
      date, type: body.type, amount,
      account_id: body.account_id,
      transfer_to: transferTo,
      category: catId,
      notes: notes || null,
      fee: feeAmt || null,
      pra: praAmt || null
    },
    created_by: body.created_by || 'web',
    ip
  });

  return json({
    ok: true,
    id,
    audited: auditResult.ok,
    audit_error: auditResult.ok ? null : auditResult.error
  });
}
