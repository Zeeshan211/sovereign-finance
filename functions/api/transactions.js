/* ─── /api/transactions — GET list, POST create ─── */
/* Cloudflare Pages Function v0.1.0 · reversed-row filter */
/*
 * Changes vs v0.0.9:
 *   - GET now excludes reversed transactions by default
 *   - GET now selects reversed_by, reversed_at, linked_txn_id
 *   - Optional audit view: /api/transactions?include_reversed=1
 *
 * Ground Zero rule:
 *   Active transaction lists must match formula-layer truth.
 *   Reversed originals must not appear in normal UI/API lists.
 *
 * PRESERVED from v0.0.9:
 *   - POST validation
 *   - POST insert shape
 *   - Audit-after-write behavior
 *   - Response shape
 */

import { audit } from './_lib.js';

const VERSION = 'v0.1.0';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const includeReversed = url.searchParams.get('include_reversed') === '1';

    const whereClause = includeReversed
      ? ''
      : `WHERE (reversed_by IS NULL OR reversed_by = '')
           AND (reversed_at IS NULL OR reversed_at = '')`;

    const stmt = context.env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, fee_amount, pra_amount, created_at,
              reversed_by, reversed_at, linked_txn_id
       FROM transactions
       ${whereClause}
       ORDER BY date DESC, created_at DESC
       LIMIT 200`
    );

    const result = await stmt.all();

    return jsonResponse({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
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

    const allowedTypes = ['expense', 'income', 'transfer', 'cc_payment', 'cc_spend', 'borrow', 'repay', 'atm'];
    if (!allowedTypes.includes(body.type)) {
      return jsonResponse({ ok: false, error: 'Invalid type' }, 400);
    }

    const id = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const date = body.date || new Date().toISOString().slice(0, 10);
    const notes = (body.notes || '').slice(0, 200);

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
      version: VERSION,
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
