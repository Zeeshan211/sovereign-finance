// DELETE /api/auth/sessions/others — revoke all sessions except the current one

import { json, audit } from '../../_lib.js';
import { getSession, getTokenFromCookie, hashToken } from '../../_lib/auth.js';

export async function onRequestDelete(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const token = getTokenFromCookie(context.request);
    const currentHash = token ? await hashToken(token) : null;

    if (!currentHash) return json({ ok: false, error: 'Cannot determine current session' }, 400);

    const now = new Date().toISOString();
    const result = await context.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
       WHERE user_id = ? AND token_hash != ? AND revoked_at IS NULL`
    ).bind(now, session.user_id, currentHash).run();

    const count = result.meta?.changes || 0;

    await audit(context.env, {
      action: 'SESSIONS_REVOKED_OTHERS',
      entity: 'sessions',
      entity_id: session.user_id,
      kind: 'mutation',
      detail: { count },
      created_by: session.user_id,
    });

    return json({ ok: true, revoked: count });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
