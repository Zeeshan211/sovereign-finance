/* ─── /api/transactions — GET list, POST create ─── */
/* Cloudflare Pages Function v0.0.9 · Sub-1D-AUDIT-WIRE */
/*
 * Changes vs v0.0.8:
 *   - POST now writes 1 audit_log row after successful insert
 *   - Action mapped from body.type:
 *       transfer    → TRANSFER
 *       cc_payment  → CC_PAYMENT
 *       all others  → TXN_ADD
 *   - audit() failure NEVER breaks the mutation (helper swallows errors)
 *   - Audit detail captures: type, amount, account_id, transfer_to_account_id,
 *     category_id, notes (truncated to 80 in detail for log readability)
 *   - Response now includes audited:true|false so caller can verify
 *
 * PRESERVED from v0.0.8:
 *   - GET list endpoint byte-identical
 *   - POST validation (amount, account_id, type, allowedTypes whitelist)
 *   - ID format ('tx_' + timestamp + random)
 *   - INSERT statement structure
 *   - Local jsonResponse helper with Cache-Control header
 *   - Error response shape (status 500 on insert throw)
 */

import { audit } from './_lib.js';

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

    // ── Sub-1D-AUDIT-WIRE: audit-after-write ──
    let action;
    if (body.type === 'transfer') action = 'TRANSFER';
    else if (body.type === 'cc_payment') action = 'CC_PAYMENT';
    else action = 'TXN_ADD';

    const auditResult = await audit(context.env, {
      action: action,
      entity: 'transaction',
      entity_id: id,
      kind: 'mutation',
      detail: {
        type: body.type,
        amount: amount,
        account_id: body.account_id,
        transfer_to_account_id: body.transfer_to_account_id || null,
        category_id: body.category_id || 'other',
        date: date,
        notes: notes.slice(0, 80)
      },
      created_by: body.created_by || 'web-add'
    });

    return jsonResponse({
      ok: true,
      id: id,
      audited: !!auditResult.ok
    });
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
