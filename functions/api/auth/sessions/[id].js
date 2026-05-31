// DELETE /api/auth/sessions/:id — revoke a specific session by ID

import { json, audit } from '../../_lib.js';
import { getSession } from '../../_lib/auth.js';

export async function onRequestDelete(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const sessionId = context.params.id;
    if (!sessionId) return json({ ok: false, error: 'Session ID required' }, 400);

    const now = new Date().toISOString();
    const result = await context.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    ).bind(now, sessionId, session.user_id).run();

    if (!result.meta?.changes) {
      return json({ ok: false, error: 'Session not found or already revoked' }, 404);
    }

    await audit(context.env, {
      action: 'SESSION_REVOKED',
      entity: 'sessions',
      entity_id: sessionId,
      kind: 'mutation',
      created_by: session.user_id,
    });

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
