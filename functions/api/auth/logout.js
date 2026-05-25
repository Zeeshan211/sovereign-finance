import { json, audit } from '../_lib.js';
import { getSession, getTokenFromCookie, hashToken, clearSessionCookie } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() }
      });
    }

    const token = getTokenFromCookie(context.request);
    if (token) {
      const tokenHash = await hashToken(token);
      await context.env.DB.prepare(
        `UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?`
      ).bind(tokenHash).run();
    }

    await audit(context.env, {
      action: 'USER_LOGOUT',
      entity: 'sessions',
      entity_id: session.id,
      kind: 'mutation',
      created_by: session.user_id
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() }
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
