/* /api/import/bulk
 * Sovereign Finance — Historical Import Endpoint
 *
 * POST body: { batch_id: string, dry_run?: boolean, transactions: TxnInput[] }
 *
 * TxnInput: {
 *   date: string (YYYY-MM-DD)
 *   type: string
 *   amount: number (positive; type determines direction)
 *   account_id: string
 *   transfer_to_account_id?: string
 *   category_id?: string
 *   merchant_id?: string
 *   notes?: string
 * }
 *
 * Returns: { ok, batch_id, inserted, skipped, failed, errors[], dry_run }
 *
 * Dedup key: (date, amount, account_id, notes) — same as existing transaction handler.
 * This endpoint is ADDITIVE ONLY — never deletes or modifies existing transactions.
 * Requires migration 10 (historical_import + import_batch_id columns) to be applied first.
 */

import { getUserId } from '../_lib.js';

export async function onRequestPost(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await readJSON(context.request);
    const { transactions, batch_id, dry_run = false } = body;

    if (!Array.isArray(transactions) || !batch_id) {
      return json({ ok: false, error: 'transactions[] + batch_id required' }, 400);
    }

    const env = context.env;
    if (!env?.DB) {
      return json({ ok: false, error: 'D1 binding DB is missing' }, 500);
    }
    const db = env.DB;

    const results = {
      batch_id,
      inserted: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      dry_run
    };

    for (const txn of transactions) {
      try {
        if (!txn.date || !txn.type || txn.amount === undefined || !txn.account_id) {
          results.failed++;
          results.errors.push({
            txn_date: txn.date,
            txn_amount: txn.amount,
            account_id: txn.account_id,
            error: 'missing required fields: date, type, amount, account_id'
          });
          continue;
        }

        const amount = Math.abs(Number(txn.amount));
        if (!Number.isFinite(amount) || amount <= 0) {
          results.failed++;
          results.errors.push({
            txn_date: txn.date,
            txn_amount: txn.amount,
            account_id: txn.account_id,
            error: 'amount must be a non-zero finite number'
          });
          continue;
        }

        const notes = txn.notes || '';

        const existing = await db.prepare(`
          SELECT id FROM transactions
          WHERE date = ? AND amount = ? AND account_id = ? AND COALESCE(notes,'') = ?
            AND user_id = ?
          LIMIT 1
        `).bind(txn.date, amount, txn.account_id, notes, userId).first();

        if (existing) {
          results.skipped++;
          continue;
        }

        if (dry_run) {
          results.inserted++;
          continue;
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        await db.prepare(`
          INSERT INTO transactions (
            id, date, type, amount, account_id, transfer_to_account_id,
            category_id, merchant_id, notes,
            historical_import, import_batch_id, created_at, user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).bind(
          id,
          txn.date,
          txn.type,
          amount,
          txn.account_id,
          txn.transfer_to_account_id || null,
          txn.category_id || null,
          txn.merchant_id || null,
          notes,
          batch_id,
          now,
          userId
        ).run();

        results.inserted++;
      } catch (err) {
        results.failed++;
        results.errors.push({
          txn_date: txn.date,
          txn_amount: txn.amount,
          account_id: txn.account_id,
          error: err.message || String(err)
        });
      }
    }

    return json({ ok: true, ...results });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    endpoint: '/api/import/bulk',
    method: 'POST',
    description: 'Historical batch import. Requires migration 10 (historical_import + import_batch_id columns).'
  });
}

async function readJSON(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
