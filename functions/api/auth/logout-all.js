// POST /api/auth/logout-all — revoke ALL sessions including the current one

import { json, audit } from '../_lib.js';
import { getSession, clearSessionCookie } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const now = new Date().toISOString();
    const result = await context.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(now, session.user_id).run();

    const count = result.meta?.changes || 0;

    await audit(context.env, {
      action: 'LOGOUT_ALL',
      entity: 'sessions',
      entity_id: session.user_id,
      kind: 'mutation',
      detail: { sessions_revoked: count },
      created_by: session.user_id,
    });

    return new Response(JSON.stringify({ ok: true, sessions_revoked: count }), {
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
