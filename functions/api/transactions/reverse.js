/* ─── /api/transactions/reverse — POST ─── */
/* Cloudflare Pages Function v0.0.5 · Sub-1D-AUDIT-WIRE-2 */
/*
 * Audit-safe reversal: never DELETE, always insert opposite txn + mark original.
 *
 * Changes vs v0.0.4:
 *   - Writes 1 audit_log row per user-action (single reverse OR linked-pair reverse)
 *   - Action: TXN_REVERSE
 *   - Detail captures: original_id(s), reversal_id(s), reversal_type, original_type, amount
 *   - audit() failure does NOT break the reversal (helper swallows errors silently)
 *   - Response now includes audited:true|false
 *
 * PRESERVED from v0.0.4:
 *   - Linked-pair detection (transfer reversals reverse BOTH legs)
 *   - Reversal-type mapping (expense→income, income→expense, transfer→transfer,
 *     cc_payment→cc_spend, cc_spend→cc_payment, borrow→repay, repay→borrow, atm→atm)
 *   - reversed_by + reversed_at columns updated on original(s)
 *   - All validation (id required, original exists, not already reversed)
 *   - Error response shapes
 */

import { audit } from '../_lib.js';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    if (!body.id) {
      return jsonResponse({ ok: false, error: 'id required' }, 400);
    }

    const db = context.env.DB;

    // Fetch original
    const orig = await db.prepare(
      'SELECT * FROM transactions WHERE id = ?'
    ).bind(body.id).first();

    if (!orig) return jsonResponse({ ok: false, error: 'Original transaction not found' }, 404);
    if (orig.reversed_by) return jsonResponse({ ok: false, error: 'Already reversed' }, 400);

    // Detect linked pair (transfer pairs share linked_txn_id)
    let linked = null;
    if (orig.linked_txn_id) {
      linked = await db.prepare(
        'SELECT * FROM transactions WHERE id = ?'
      ).bind(orig.linked_txn_id).first();
      if (linked && linked.reversed_by) {
        return jsonResponse({ ok: false, error: 'Linked leg already reversed' }, 400);
      }
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const createdBy = body.created_by || 'web-reverse';

    const reversalType = mapReversalType(orig.type);

    if (!linked) {
      // ── Single-row reverse path ──
      const reversalId = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const reversalNotes = ('Reversal of ' + orig.id + (orig.notes ? ' (' + orig.notes + ')' : '')).slice(0, 200);

      await db.prepare(
        `INSERT INTO transactions
           (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        reversalId,
        today,
        reversalType,
        orig.amount,
        orig.account_id,
        orig.transfer_to_account_id || null,
        orig.category_id || 'other',
        reversalNotes,
        0,
        0
      ).run();

      await db.prepare(
        'UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?'
      ).bind(reversalId, now, orig.id).run();

      // ── Sub-1D-AUDIT-WIRE-2: audit-after-write ──
      const auditResult = await audit(context.env, {
        action: 'TXN_REVERSE',
        entity: 'transaction',
        entity_id: orig.id,
        kind: 'mutation',
        detail: {
          original_id: orig.id,
          reversal_id: reversalId,
          original_type: orig.type,
          reversal_type: reversalType,
          amount: orig.amount,
          account_id: orig.account_id,
          paired: false
        },
        created_by: createdBy
      });

      return jsonResponse({
        ok: true,
        reversal_id: reversalId,
        original_id: orig.id,
        audited: !!auditResult.ok
      });
    }

    // ── Linked-pair reverse path (transfer reversal) ──
    const reversalIdA = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const reversalIdB = 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const noteSuffix = orig.notes ? ' (' + orig.notes + ')' : '';
    const reversalNotesA = ('Reversal of ' + orig.id + noteSuffix).slice(0, 200);
    const reversalNotesB = ('Reversal of ' + linked.id + (linked.notes ? ' (' + linked.notes + ')' : '')).slice(0, 200);

    // Reversal A: mirrors orig (swap source/dest)
    await db.prepare(
      `INSERT INTO transactions
         (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      reversalIdA,
      today,
      mapReversalType(orig.type),
      orig.amount,
      orig.transfer_to_account_id || orig.account_id,
      orig.account_id,
      orig.category_id || 'other',
      reversalNotesA,
      0,
      0,
      reversalIdB
    ).run();

    // Reversal B: mirrors linked
    await db.prepare(
      `INSERT INTO transactions
         (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      reversalIdB,
      today,
      mapReversalType(linked.type),
      linked.amount,
      linked.transfer_to_account_id || linked.account_id,
      linked.account_id,
      linked.category_id || 'other',
      reversalNotesB,
      0,
      0,
      reversalIdA
    ).run();

    // Mark both originals reversed
    await db.prepare(
      'UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?'
    ).bind(reversalIdA, now, orig.id).run();

    await db.prepare(
      'UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?'
    ).bind(reversalIdB, now, linked.id).run();

    // ── Sub-1D-AUDIT-WIRE-2: 1 audit row per user-action (linked-pair reverse) ──
    const auditResult = await audit(context.env, {
      action: 'TXN_REVERSE',
      entity: 'transaction',
      entity_id: orig.id,
      kind: 'mutation',
      detail: {
        original_id: orig.id,
        linked_original_id: linked.id,
        reversal_id_a: reversalIdA,
        reversal_id_b: reversalIdB,
        original_type: orig.type,
        reversal_type: mapReversalType(orig.type),
        amount: orig.amount,
        account_id: orig.account_id,
        transfer_to_account_id: orig.transfer_to_account_id,
        paired: true
      },
      created_by: createdBy
    });

    return jsonResponse({
      ok: true,
      reversal_id: reversalIdA,
      linked_reversal_id: reversalIdB,
      original_id: orig.id,
      linked_original_id: linked.id,
      audited: !!auditResult.ok
    });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function mapReversalType(originalType) {
  const map = {
    expense:    'income',
    income:     'expense',
    transfer:   'transfer',
    cc_payment: 'cc_spend',
    cc_spend:   'cc_payment',
    borrow:     'repay',
    repay:      'borrow',
    atm:        'atm'
  };
  return map[originalType] || originalType;
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
