// GET /api/auth/sessions — list active sessions for the current user

import { json } from '../_lib.js';
import { getSession, getTokenFromCookie, hashToken } from '../_lib/auth.js';

export async function onRequestGet(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const token = getTokenFromCookie(context.request);
    const currentHash = token ? await hashToken(token) : null;

    const { results } = await context.env.DB.prepare(
      `SELECT id, ip_address, user_agent, created_at, last_active_at, expires_at,
              CASE WHEN token_hash = ? THEN 1 ELSE 0 END AS is_current
       FROM sessions
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at > datetime('now')
       ORDER BY last_active_at DESC`
    ).bind(currentHash || '', session.user_id).all();

    return json({ ok: true, sessions: results || [] });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
