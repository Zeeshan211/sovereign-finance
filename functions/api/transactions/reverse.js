// ════════════════════════════════════════════════════════════════════
// /api/transactions/reverse — atomic soft-reverse with audit + snapshot
// LOCKED · Sub-1D-2d · v0.0.1
//
// POST /api/transactions/reverse  body: { id, created_by? }
//
// Behavior:
//  1. Validates target txn exists + not already reversed
//  2. Snapshots full DB (label: pre-reverse-{id})
//  3. Atomic batch:
//       - Inserts opposite row (negative effect via opposite type or amount)
//       - Marks original.reversed_by = newId, reversed_at = now
//       - Marks newRow.reversed_by = original.id (back-link, prevents re-reverse)
//       - If original was 'repay' → restores debts.paid_amount by amount (best-effort)
//  4. Writes audit_log row (action TXN_REVERSE) with full before-state
// ════════════════════════════════════════════════════════════════════

import { json, audit, snapshot, uuid } from '../_lib.js';

// Map original type → reverse type (for soft-reverse opposite row)
const REVERSE_TYPE = {
  expense:    'income',
  income:     'expense',
  transfer:   'transfer',     // amount stays, account_id ↔ transfer_to_account_id swap
  cc_payment: 'cc_payment',   // swap accounts
  cc_spend:   'income',       // refund to CC
  borrow:     'repay',
  repay:      'borrow',
  atm:        'income'        // restore cash withdrawn
};

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch (e) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const id = (body.id || '').trim();
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  const createdBy = body.created_by || 'web-hub';

  // ─── 1. Fetch original ─────────────────────────────────────────────
  const orig = await env.DB.prepare(
    `SELECT id, date, type, amount, account_id, transfer_to_account_id,
            category_id, notes, fee_amount, pra_amount, reversed_by, created_at
     FROM transactions WHERE id = ?`
  ).bind(id).first();

  if (!orig) return json({ ok: false, error: 'Transaction not found' }, 404);
  if (orig.reversed_by) {
    return json({ ok: false, error: 'Already reversed (linked to ' + orig.reversed_by + ')' }, 409);
  }

  // ─── 2. Snapshot before mutate ─────────────────────────────────────
  const snapResult = await snapshot(env, `pre-reverse-${id}`, createdBy);
  if (!snapResult.ok) {
    return json({ ok: false, error: 'Snapshot failed: ' + snapResult.error }, 500);
  }

  // ─── 3. Build reverse row ──────────────────────────────────────────
  const newId = 'tx_rev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const nowIso = new Date().toISOString();
  const reverseType = REVERSE_TYPE[orig.type] || 'income';

  // Account swap for transfer-style reversals
  let revAccount = orig.account_id;
  let revTransferTo = orig.transfer_to_account_id;
  if (orig.type === 'transfer' || orig.type === 'cc_payment') {
    revAccount = orig.transfer_to_account_id;
    revTransferTo = orig.account_id;
  }

  // ─── 4. Linked-pair check ──────────────────────────────────────────
  // Banking-grade pattern: if original is one half of a transfer pair (linked_txn_id
  // exists in the schema as a future column — for now we identify pairs by matching
  // date + amount + opposite account combo). Simplification for v0.0.1: we ONLY
  // reverse the single row. Pair detection lands in Sub-1D-3a (Transfer form) where
  // pairs are explicitly created and tracked via a linked_txn_id column.

  // ─── 5. Atomic batch ───────────────────────────────────────────────
  const stmts = [];

  // Insert reverse row
  stmts.push(
    env.DB.prepare(
      `INSERT INTO transactions
         (id, date, type, amount, account_id, transfer_to_account_id,
          category_id, notes, fee_amount, pra_amount, reversed_by, reversed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      newId,
      orig.date,
      reverseType,
      orig.amount,
      revAccount,
      revTransferTo,
      orig.category_id,
      'REVERSAL of ' + id + (orig.notes ? ' · was: ' + orig.notes.slice(0, 100) : ''),
      orig.fee_amount || 0,
      orig.pra_amount || 0,
      id,        // back-link: this reverse row points to the original
      nowIso
    )
  );

  // Mark original as reversed
  stmts.push(
    env.DB.prepare(
      `UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?`
    ).bind(newId, nowIso, id)
  );

  // If original was a debt repayment, restore the debt's paid_amount (best-effort)
  let debtRestored = null;
  if (orig.type === 'repay' && orig.notes) {
    // Try to extract debt name from notes — sheet pattern: "Payment to CRED-X"
    const match = orig.notes.match(/(CRED-\d|DEBT-\d|[A-Z][A-Z0-9-]{1,30})/i);
    if (match) {
      const debtName = match[1];
      try {
        // Use UPDATE with subquery to safely decrement
        stmts.push(
          env.DB.prepare(
            `UPDATE debts
             SET paid_amount = MAX(0, COALESCE(paid_amount, 0) - ?)
             WHERE name = ?`
          ).bind(orig.amount, debtName)
        );
        debtRestored = { name: debtName, amount_restored: orig.amount };
      } catch (e) {
        // Non-fatal — debt restore is best-effort
      }
    }
  }

  // ─── 6. Execute batch (atomic) ─────────────────────────────────────
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return json({
      ok: false,
      error: 'Reverse batch failed: ' + (e.message || String(e)),
      snapshot_id: snapResult.snapshot_id
    }, 500);
  }

  // ─── 7. Audit log ──────────────────────────────────────────────────
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const auditRes = await audit(env, {
    action: 'TXN_REVERSE',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      reverse_id: newId,
      original: {
        date: orig.date, type: orig.type, amount: orig.amount,
        account_id: orig.account_id,
        transfer_to_account_id: orig.transfer_to_account_id,
        category_id: orig.category_id,
        notes: orig.notes
      },
      reverse_type: reverseType,
      snapshot_id: snapResult.snapshot_id,
      debt_restored: debtRestored
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    original_id: id,
    reverse_id: newId,
    snapshot_id: snapResult.snapshot_id,
    debt_restored: debtRestored,
    audited: auditRes.ok
  });
}

export const onRequestGet = () =>
  json({ ok: false, error: 'POST only' }, 405);
