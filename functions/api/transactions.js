// ════════════════════════════════════════════════════════════════════
// /api/transactions — GET list, POST create (single OR atomic transfer pair)
// LOCKED · Sub-1D-3a · v0.0.10
//
// CHANGES from v0.0.9:
//   - POST type=transfer now creates ATOMIC PAIR:
//       OUT row: from source, type='transfer', amount, linked_txn_id=IN.id
//       IN  row: to dest,    type='income',   amount, linked_txn_id=OUT.id, category='transfer'
//   - Both rows in single db.batch() = all-or-nothing
//   - Validates source ≠ dest, both accounts exist, amount > 0
//   - Returns { ok, id (OUT), linked_id (IN), audited }
//   - Non-transfer types unchanged (single insert)
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
              category_id, notes, fee_amount, pra_amount, created_at,
              reversed_by, reversed_at, linked_txn_id
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

  // ─── Common validation ────────────────────────────────────────────
  const amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) {
    return json({ ok: false, error: 'Amount must be greater than 0' }, 400);
  }
  if (!body.account_id) return json({ ok: false, error: 'account_id required' }, 400);
  if (!body.type)       return json({ ok: false, error: 'type required' }, 400);
  if (!ALLOWED_TYPES.includes(body.type)) {
    return json({ ok: false, error: 'Invalid type: ' + body.type }, 400);
  }

  const date    = body.date || new Date().toISOString().slice(0, 10);
  const notes   = (body.notes || '').slice(0, 200);
  const catId   = body.category_id || 'other';
  const feeAmt  = parseFloat(body.fee_amount || 0) || 0;
  const praAmt  = parseFloat(body.pra_amount || 0) || 0;
  const ip      = context.request.headers.get('CF-Connecting-IP') || null;
  const createdBy = body.created_by || 'web';

  // ─── BRANCH: Transfer = atomic pair ───────────────────────────────
  if (body.type === 'transfer') {
    const dest = body.transfer_to_account_id;
    if (!dest) return json({ ok: false, error: 'transfer_to_account_id required for transfer' }, 400);
    if (dest === body.account_id) {
      return json({ ok: false, error: 'Source and destination cannot be the same' }, 400);
    }

    // Verify both accounts exist
    try {
      const accChk = await context.env.DB.prepare(
        `SELECT id FROM accounts WHERE id IN (?, ?)`
      ).bind(body.account_id, dest).all();
      if (!accChk.results || accChk.results.length !== 2) {
        return json({ ok: false, error: 'One or both accounts not found' }, 400);
      }
    } catch (e) {
      return json({ ok: false, error: 'Account check failed: ' + e.message }, 500);
    }

    const stamp = Date.now();
    const outId = 'tx_' + stamp + '_o' + Math.random().toString(36).slice(2, 6);
    const inId  = 'tx_' + stamp + '_i' + Math.random().toString(36).slice(2, 6);
    const noteOut = notes || `Transfer to ${dest}`;
    const noteIn  = notes ? notes + ' (received)' : `Transfer from ${body.account_id}`;

    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO transactions
            (id, date, type, amount, account_id, transfer_to_account_id,
             category_id, notes, fee_amount, pra_amount, linked_txn_id)
           VALUES (?, ?, 'transfer', ?, ?, ?, 'transfer', ?, ?, ?, ?)`
        ).bind(outId, date, amount, body.account_id, dest, noteOut, feeAmt, praAmt, inId),

        context.env.DB.prepare(
          `INSERT INTO transactions
            (id, date, type, amount, account_id, transfer_to_account_id,
             category_id, notes, fee_amount, pra_amount, linked_txn_id)
           VALUES (?, ?, 'income', ?, ?, NULL, 'transfer', ?, 0, 0, ?)`
        ).bind(inId, date, amount, dest, noteIn, outId)
      ]);
    } catch (e) {
      return json({ ok: false, error: 'Transfer batch failed: ' + e.message }, 500);
    }

    // Audit BOTH rows in one record
    const auditRes = await audit(context.env, {
      action:    'TRANSFER',
      entity:    'transaction',
      entity_id: outId,
      kind:      'mutation',
      detail: {
        pair: [outId, inId],
        date, amount,
        from: body.account_id,
        to:   dest,
        notes: notes || null,
        fee: feeAmt || null
      },
      created_by: createdBy,
      ip
    });

    return json({
      ok: true,
      id: outId,
      linked_id: inId,
      type: 'transfer',
      audited: auditRes.ok,
      audit_error: auditRes.ok ? null : auditRes.error
    });
  }

  // ─── BRANCH: Non-transfer = single insert (v0.0.9 behavior) ────────
  const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  try {
    await context.env.DB.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id,
         category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, date, body.type, amount,
      body.account_id, body.transfer_to_account_id || null,
      catId, notes, feeAmt, praAmt
    ).run();
  } catch (err) {
    return json({ ok: false, error: 'Insert failed: ' + err.message }, 500);
  }

  const auditResult = await audit(context.env, {
    action:    'TXN_ADD',
    entity:    'transaction',
    entity_id: id,
    kind:      'mutation',
    detail: {
      date, type: body.type, amount,
      account_id: body.account_id,
      category: catId,
      notes: notes || null,
      fee: feeAmt || null,
      pra: praAmt || null
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    id,
    audited: auditResult.ok,
    audit_error: auditResult.ok ? null : auditResult.error
  });
}
