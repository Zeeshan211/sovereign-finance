/* /api/import/rollback
 * Sovereign Finance — Historical Import Rollback Endpoint
 *
 * POST body: { batch_id: string, confirm?: boolean }
 *
 * Without confirm=true: returns count of transactions that WOULD be deleted (safe preview).
 * With confirm=true: permanently deletes all transactions for that batch_id.
 *
 * This endpoint only deletes rows inserted by /api/import/bulk (historical_import = 1).
 * It CANNOT delete manually-entered transactions.
 */

import { getUserId } from '../_lib.js';

export async function onRequestPost(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await readJSON(context.request);
    const { batch_id, confirm = false } = body;

    if (!batch_id) {
      return json({ ok: false, error: 'batch_id required' }, 400);
    }

    const env = context.env;
    if (!env?.DB) {
      return json({ ok: false, error: 'D1 binding DB is missing' }, 500);
    }
    const db = env.DB;

    const countRow = await db.prepare(`
      SELECT COUNT(*) AS c FROM transactions
      WHERE import_batch_id = ? AND historical_import = 1 AND user_id = ?
    `).bind(batch_id, userId).first();

    const count = countRow?.c ?? 0;

    if (!confirm) {
      return json({
        ok: true,
        dry_run: true,
        batch_id,
        would_delete: count,
        message: 'Pass confirm=true to execute rollback. This is a preview only.'
      });
    }

    if (count === 0) {
      return json({
        ok: true,
        batch_id,
        deleted: 0,
        message: 'No transactions found for this batch_id. Nothing deleted.'
      });
    }

    await db.prepare(`
      DELETE FROM transactions WHERE import_batch_id = ? AND historical_import = 1 AND user_id = ?
    `).bind(batch_id, userId).run();

    return json({
      ok: true,
      batch_id,
      deleted: count,
      message: `Rollback complete. ${count} imported transactions deleted.`
    });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    endpoint: '/api/import/rollback',
    method: 'POST',
    description: 'Rollback a historical import batch. Without confirm=true, returns preview count only.'
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
