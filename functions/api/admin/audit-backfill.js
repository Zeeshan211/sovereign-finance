/* ─── /api/admin/audit-backfill — POST one-shot ─── */
/* Cloudflare Pages Function v0.1.0 · Sub-1D-AUDIT-WIRE-3 */
/*
 * Idempotent backfill of audit_log entries for historical transactions
 * that pre-date Sub-1D-AUDIT-WIRE (Part 2, 2026-05-04).
 *
 * Schema (per SCHEMA.md):
 *   transactions (17 cols): id, date, type, amount, account_id, transfer_to_account_id,
 *     category_id, notes, fee_amount, pra_amount, created_at, reversed_by, reversed_at,
 *     linked_txn_id, ...
 *   audit_log (9 cols): id, timestamp, action, entity, entity_id, kind, detail, created_by, ip
 *
 * Action mapping (matches transactions.js v0.0.9 + reverse.js v0.0.5):
 *   transfer    → TRANSFER
 *   cc_payment  → CC_PAYMENT
 *   all others  → TXN_ADD
 *   reversed pairs (linked_txn_id non-null AND has reversed_by sibling)
 *     → also write TXN_REVERSE with kind='backfill'
 *
 * IDEMPOTENCY:
 *   Query: find transactions where NO audit_log row exists with
 *     entity='transaction' AND entity_id=tx.id AND action IN (TXN_ADD, TRANSFER, CC_PAYMENT)
 *   So safe to re-run — only inserts what's missing.
 *
 * AUTH:
 *   Requires Authorization header with MIGRATION_SECRET env var (same as
 *   migrate-from-sheet.js). Don't expose blindly.
 *
 * USAGE (one-shot, manual via fetch from authenticated browser):
 *   fetch('/api/admin/audit-backfill', {
 *     method: 'POST',
 *     headers: {'Content-Type':'application/json', 'Authorization': 'Bearer YOUR_SECRET'}
 *   }).then(r=>r.json()).then(console.log)
 *
 * Returns: {ok, scanned, backfilled, skipped (already audited), errors[]}
 */

export async function onRequestPost(context) {
  const env = context.env;

  // Auth check
  const authHeader = context.request.headers.get('Authorization') || '';
  const expectedSecret = env.MIGRATION_SECRET;
  if (!expectedSecret) {
    return jsonResponse({ ok: false, error: 'MIGRATION_SECRET not configured' }, 500);
  }
  if (authHeader !== 'Bearer ' + expectedSecret) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    const db = env.DB;

    // Find transactions with no matching audit_log entry
    // Uses LEFT JOIN with NULL check for idempotency
    const stmt = db.prepare(`
      SELECT t.id, t.date, t.type, t.amount, t.account_id, t.transfer_to_account_id,
             t.category_id, t.notes, t.created_at
      FROM transactions t
      LEFT JOIN audit_log a
        ON a.entity = 'transaction'
        AND a.entity_id = t.id
        AND a.action IN ('TXN_ADD', 'TRANSFER', 'CC_PAYMENT')
      WHERE a.id IS NULL
      ORDER BY t.created_at, t.id
    `);
    const result = await stmt.all();
    const orphanedTxns = result.results;

    let backfilled = 0;
    const errors = [];

    for (const tx of orphanedTxns) {
      let action;
      if (tx.type === 'transfer') action = 'TRANSFER';
      else if (tx.type === 'cc_payment') action = 'CC_PAYMENT';
      else action = 'TXN_ADD';

      const detail = JSON.stringify({
        type: tx.type,
        amount: tx.amount,
        account_id: tx.account_id,
        transfer_to_account_id: tx.transfer_to_account_id || null,
        category_id: tx.category_id || 'other',
        date: tx.date,
        notes: (tx.notes || '').slice(0, 80),
        backfilled_at: new Date().toISOString(),
        original_created_at: tx.created_at
      });

      const auditId = 'audit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      try {
        await db.prepare(`
          INSERT INTO audit_log (id, action, entity, entity_id, kind, detail, created_by)
          VALUES (?, ?, 'transaction', ?, 'backfill', ?, 'system-backfill-2026-05-04')
        `).bind(auditId, action, tx.id, detail).run();

        backfilled++;
      } catch (insertErr) {
        errors.push({ tx_id: tx.id, error: insertErr.message });
      }
    }

    return jsonResponse({
      ok: true,
      scanned: orphanedTxns.length,
      backfilled: backfilled,
      errors: errors,
      message: backfilled === 0 && orphanedTxns.length === 0
        ? 'No backfill needed — all transactions already audited'
        : `Backfilled ${backfilled} of ${orphanedTxns.length} orphaned transactions`
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
