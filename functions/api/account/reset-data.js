// POST /api/account/reset-data — wipe all financial data, keep account intact
// Requires { confirm: "RESET MY DATA" } in the body as an intentional gate.

import { json, audit } from '../_lib.js';

export async function onRequestPost(context) {
  try {
    const userId = context.data?.user_id;
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await context.request.json().catch(() => ({}));
    if (body.confirm !== 'RESET MY DATA') {
      return json({ ok: false, error: 'Send { "confirm": "RESET MY DATA" } to confirm' }, 400);
    }

    const db = context.env.DB;
    const tables = [
      'transactions', 'accounts', 'bills', 'bill_payments',
      'debts', 'debt_payments', 'goals', 'budgets',
      'snapshots', 'snapshot_data', 'categories',
      'merchants', 'reconciliation', 'intl_rates',
    ];

    for (const table of tables) {
      await db.prepare(
        `DELETE FROM ${table} WHERE user_id = ?`
      ).bind(userId).run().catch(() => {});
    }

    // user_preferences: reset to defaults rather than delete
    await db.prepare(
      `UPDATE user_preferences
       SET theme = 'dark', primary_currency = 'PKR', date_format = 'DD/MM/YYYY',
           week_start = 'monday', privacy_mode = 0, compact_numbers = 1,
           updated_at = ?
       WHERE user_id = ?`
    ).bind(new Date().toISOString(), userId).run().catch(() => {});

    await audit(context.env, {
      action: 'ACCOUNT_DATA_RESET',
      entity: 'users',
      entity_id: userId,
      kind: 'mutation',
      detail: { tables_cleared: tables },
      created_by: userId,
    });

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
