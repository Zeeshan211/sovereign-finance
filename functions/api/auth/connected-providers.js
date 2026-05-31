// GET /api/auth/connected-providers — list OAuth providers linked to the current account

import { json } from '../_lib.js';
import { getSession } from '../_lib/auth.js';

export async function onRequestGet(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const { results } = await context.env.DB.prepare(
      `SELECT provider, provider_email, created_at
       FROM oauth_identities
       WHERE user_id = ?
       ORDER BY created_at ASC`
    ).bind(session.user_id).all();

    return json({ ok: true, providers: results || [] });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
