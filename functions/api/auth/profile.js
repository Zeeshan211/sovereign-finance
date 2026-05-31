// PATCH /api/auth/profile — update display name
// Auth routes skip middleware session check; we validate the session here.

import { json, audit } from '../_lib.js';
import { getSession } from '../_lib/auth.js';

export async function onRequestPatch(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await context.request.json().catch(() => ({}));
    const fullName = String(body.full_name || '').trim().slice(0, 100);
    if (!fullName) return json({ ok: false, error: 'full_name is required' }, 400);

    await context.env.DB.prepare(
      `UPDATE users SET full_name = ? WHERE id = ?`
    ).bind(fullName, session.user_id).run();

    await audit(context.env, {
      action: 'PROFILE_UPDATE',
      entity: 'users',
      entity_id: session.user_id,
      kind: 'mutation',
      detail: { full_name: fullName },
      created_by: session.user_id,
    });

    return json({ ok: true, user: { id: session.user_id, email: session.email, full_name: fullName, role: session.role } });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
