// POST /api/auth/set-password — set a password for OAuth-only accounts (empty password_hash)
// Distinct from change-password: no current password required, but only works when none is set.

import { json, audit } from '../_lib.js';
import { getSession, hashPassword } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const user = await context.env.DB.prepare(
      `SELECT password_hash FROM users WHERE id = ?`
    ).bind(session.user_id).first();

    if (!user) return json({ ok: false, error: 'User not found' }, 404);
    if (user.password_hash && user.password_hash !== '') {
      return json({ ok: false, error: 'Password already set. Use change-password instead.' }, 409);
    }

    const body = await context.request.json().catch(() => ({}));
    const newPassword = String(body.new_password || '');
    if (newPassword.length < 8) {
      return json({ ok: false, error: 'Password must be at least 8 characters' }, 400);
    }

    const hash = await hashPassword(newPassword);
    await context.env.DB.prepare(
      `UPDATE users SET password_hash = ? WHERE id = ?`
    ).bind(hash, session.user_id).run();

    await audit(context.env, {
      action: 'PASSWORD_SET',
      entity: 'users',
      entity_id: session.user_id,
      kind: 'mutation',
      created_by: session.user_id,
    });

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
