import { json, audit } from '../_lib.js';
import { getSession, verifyPassword, hashPassword } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await readJSON(context.request);
    const currentPw = String(body.current || body.current_password || '');
    const newPw = String(body.new || body.new_password || '');

    if (!currentPw || !newPw) return json({ ok: false, error: 'current and new passwords required' }, 400);
    if (newPw.length < 8) return json({ ok: false, error: 'new password must be at least 8 characters' }, 400);

    const user = await context.env.DB.prepare(
      `SELECT id, password_hash FROM users WHERE id = ?`
    ).bind(session.user_id).first();

    if (!user || !user.password_hash) return json({ ok: false, error: 'Unauthorized' }, 401);

    const valid = await verifyPassword(currentPw, user.password_hash);
    if (!valid) return json({ ok: false, error: 'Current password is incorrect' }, 403);

    const newHash = await hashPassword(newPw);
    await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(newHash, session.user_id),
      context.env.DB.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).bind(session.user_id)
    ]);

    await audit(context.env, {
      action: 'PASSWORD_CHANGE',
      entity: 'users',
      entity_id: session.user_id,
      kind: 'mutation',
      created_by: session.user_id
    });

    return json({ ok: true, message: 'Password updated. Please log in again.' });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function readJSON(req) { try { return await req.json(); } catch { return {}; } }
