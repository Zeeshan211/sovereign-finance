// ════════════════════════════════════════════════════════════════════
// /api/transactions/reverse — atomic soft-reverse + linked-pair handling
// LOCKED · Sub-1D-3a · v0.0.2
//
// CHANGES from v0.0.1:
//   - If original has linked_txn_id (transfer pair), reverses BOTH atomically
//   - Snapshot label includes both ids for traceability
//   - Audit detail records pair info
// ════════════════════════════════════════════════════════════════════

import { json, audit, snapshot, uuid } from '../_lib.js';

const REVERSE_TYPE = {
  expense:    'income',
  income:     'expense',
  transfer:   'transfer',
  cc_payment: 'cc_payment',
  cc_spend:   'income',
  borrow:     'repay',
  repay:      'borrow',
  atm:        'income'
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
            category_id, notes, fee_amount, pra_amount, reversed_by, linked_txn_id, created_at
     FROM transactions WHERE id = ?`
  ).bind(id).first();

  if (!orig) return json({ ok: false, error: 'Transaction not found' }, 404);
  if (orig.reversed_by) {
    return json({ ok: false, error: 'Already reversed (linked to ' + orig.reversed_by + ')' }, 409);
  }

  // ─── 2. If linked pair, fetch the partner ──────────────────────────
  let partner = null;
  if (orig.linked_txn_id) {
    partner = await env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, reversed_by
       FROM transactions WHERE id = ?`
    ).bind(orig.linked_txn_id).first();

    if (partner && partner.reversed_by) {
      return json({ ok: false, error: 'Partner row already reversed (' + partner.reversed_by + ')' }, 409);
    }
  }

  // ─── 3. Snapshot before mutate ─────────────────────────────────────
  const snapLabel = partner
    ? `pre-reverse-pair-${id}-${partner.id}`
    : `pre-reverse-${id}`;
  const snapResult = await snapshot(env, snapLabel, createdBy);
  if (!snapResult.ok) {
    return json({ ok: false, error: 'Snapshot failed: ' + snapResult.error }, 500);
  }

  // ─── 4. Build reverse rows ─────────────────────────────────────────
  const stamp = Date.now();
  const nowIso = new Date().toISOString();
  const stmts = [];
  const reverseIds = {};

  // Helper to build reverse row for any txn
  function buildReverse(t, suffix) {
    const newId = 'tx_rev_' + stamp + '_' + suffix + Math.random().toString(36).slice(2, 6);
    const reverseType = REVERSE_TYPE[t.type] || 'income';

    let revAccount = t.account_id;
    let revTransferTo = t.transfer_to_account_id;
    if (t.type === 'transfer' || t.type === 'cc_payment') {
      revAccount = t.transfer_to_account_id || t.account_id;
      revTransferTo = t.account_id;
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO transactions
           (id, date, type, amount, account_id, transfer_to_account_id,
            category_id, notes, fee_amount, pra_amount, reversed_by, reversed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        newId,
        t.date,
        reverseType,
        t.amount,
        revAccount,
        revTransferTo,
        t.category_id,
        'REVERSAL of ' + t.id + (t.notes ? ' · was: ' + t.notes.slice(0, 100) : ''),
        t.fee_amount || 0,
        t.pra_amount || 0,
        t.id,
        nowIso
      )
    );

    stmts.push(
      env.DB.prepare(`UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?`)
        .bind(newId, nowIso, t.id)
    );

    return newId;
  }

  reverseIds.original = buildReverse(orig, 'a');
  if (partner) {
    reverseIds.partner = buildReverse(partner, 'b');
  }

  // ─── 5. Debt restore (only if original was 'repay') ───────────────
  let debtRestored = null;
  if (orig.type === 'repay' && orig.notes) {
    const match = orig.notes.match(/(CRED-\d|DEBT-\d|[A-Z][A-Z0-9-]{1,30})/i);
    if (match) {
      const debtName = match[1];
      stmts.push(
        env.DB.prepare(
          `UPDATE debts SET paid_amount = MAX(0, COALESCE(paid_amount, 0) - ?) WHERE name = ?`
        ).bind(orig.amount, debtName)
      );
      debtRestored = { name: debtName, amount_restored: orig.amount };
    }
  }

  // ─── 6. Execute atomic batch ───────────────────────────────────────
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return json({
      ok: false,
      error: 'Reverse batch failed: ' + (e.message || String(e)),
      snapshot_id: snapResult.snapshot_id
    }, 500);
  }

  // ─── 7. Audit ──────────────────────────────────────────────────────
  const ip = request.headers.get('CF-Connecting-IP') || null;
  const auditRes = await audit(env, {
    action: 'TXN_REVERSE',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      reversed_pair: !!partner,
      original_ids: partner ? [orig.id, partner.id] : [orig.id],
      reverse_ids:  partner ? [reverseIds.original, reverseIds.partner] : [reverseIds.original],
      snapshot_id: snapResult.snapshot_id,
      debt_restored: debtRestored,
      original_type: orig.type,
      amount: orig.amount
    },
    created_by: createdBy,
    ip
  });

  return json({
    ok: true,
    original_id: id,
    reverse_id: reverseIds.original,
    partner_id: partner ? partner.id : null,
    partner_reverse_id: reverseIds.partner || null,
    snapshot_id: snapResult.snapshot_id,
    debt_restored: debtRestored,
    audited: auditRes.ok
  });
}

export const onRequestGet = () =>
  json({ ok: false, error: 'POST only' }, 405);
