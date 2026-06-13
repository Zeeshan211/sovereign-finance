// DELETE /api/account — permanently delete the user account and all associated data
// Requires { confirm: "DELETE MY ACCOUNT" } in the body as an intentional gate.

import { json, audit, getUserId } from '../_lib.js';
import { clearSessionCookie } from '../_lib/auth.js';

export async function onRequestDelete(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await context.request.json().catch(() => ({}));
    if (body.confirm !== 'DELETE MY ACCOUNT') {
      return json({ ok: false, error: 'Send { "confirm": "DELETE MY ACCOUNT" } to confirm' }, 400);
    }

    const db = context.env.DB;

    // Audit before deleting — record identity before it's gone
    await audit(context.env, {
      action: 'ACCOUNT_DELETED',
      entity: 'users',
      entity_id: userId,
      kind: 'mutation',
      created_by: userId,
      user_id: userId,
    });

    // ON DELETE CASCADE handles most child records; explicit deletes for safety
    const tables = [
      'transactions', 'accounts', 'bills', 'bill_payments',
      'debts', 'debt_payments', 'goals', 'budgets',
      'snapshots', 'categories', 'merchants',
      'reconciliation', 'intl_rates', 'oauth_identities',
      'sessions', 'user_preferences',
    ];

    // snapshot_data has no user_id column — scope via parent snapshots,
    // and delete BEFORE snapshots rows are removed.
    await db.prepare(
      `DELETE FROM snapshot_data
       WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id = ?)`
    ).bind(userId).run().catch(() => {});

    for (const table of tables) {
      await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`)
        .bind(userId).run().catch(() => {});
    }

    await db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearSessionCookie(),
      },
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
