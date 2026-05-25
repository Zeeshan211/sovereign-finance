import { json } from '../_lib.js';
import { getSession } from '../_lib/auth.js';

export async function onRequestGet(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);
    return json({
      ok: true,
      user: { id: session.user_id, email: session.email, role: session.role }
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
