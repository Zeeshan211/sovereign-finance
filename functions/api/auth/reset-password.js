import { json, audit } from '../_lib.js';
import { hashToken, hashPassword, createSession, sessionCookie } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const body = await readJSON(context.request);
    const token = String(body.token || '').trim();
    const newPw = String(body.new_password || body.password || '');

    if (!token || !newPw) return json({ ok: false, error: 'token and new_password required' }, 400);
    if (newPw.length < 8) return json({ ok: false, error: 'password must be at least 8 characters' }, 400);

    const tokenHash = await hashToken(token);
    const now = new Date().toISOString();

    const reset = await context.env.DB.prepare(
      `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`
    ).bind(tokenHash).first();

    if (!reset) return json({ ok: false, error: 'Invalid or expired reset token' }, 400);
    if (reset.used_at) return json({ ok: false, error: 'Reset token already used' }, 400);
    if (reset.expires_at < now) return json({ ok: false, error: 'Reset token expired' }, 400);

    const newHash = await hashPassword(newPw);
    await context.env.DB.batch([
      context.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(newHash, reset.user_id),
      context.env.DB.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`).bind(now, reset.id),
      context.env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).bind(now, reset.user_id)
    ]);

    const sessionToken = await createSession(context.env, reset.user_id, context.request);

    await audit(context.env, {
      action: 'PASSWORD_RESET_COMPLETE',
      entity: 'users',
      entity_id: reset.user_id,
      kind: 'mutation',
      created_by: reset.user_id
    });

    return new Response(JSON.stringify({ ok: true, message: 'Password reset successful.' }), {
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(sessionToken)
      }
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function readJSON(req) { try { return await req.json(); } catch { return {}; } }
