// DELETE /api/auth/connected-providers/:provider — unlink an OAuth provider
// Safety: blocked if the user has no password and this is their last provider.

import { json, audit } from '../../_lib.js';
import { getSession } from '../../_lib/auth.js';

export async function onRequestDelete(context) {
  try {
    const session = await getSession(context.env, context.request);
    if (!session) return json({ ok: false, error: 'Unauthorized' }, 401);

    const provider = context.params.provider;
    if (!provider) return json({ ok: false, error: 'Provider required' }, 400);

    const user = await context.env.DB.prepare(
      `SELECT password_hash FROM users WHERE id = ?`
    ).bind(session.user_id).first();

    if (!user) return json({ ok: false, error: 'User not found' }, 404);

    const { results: providers } = await context.env.DB.prepare(
      `SELECT provider FROM oauth_identities WHERE user_id = ?`
    ).bind(session.user_id).all();

    const hasPassword = user.password_hash && user.password_hash !== '';
    const remainingProviders = (providers || []).filter(p => p.provider !== provider);

    if (!hasPassword && remainingProviders.length === 0) {
      return json({
        ok: false,
        error: 'Cannot remove your only sign-in method. Set a password first.',
      }, 409);
    }

    const result = await context.env.DB.prepare(
      `DELETE FROM oauth_identities WHERE user_id = ? AND provider = ?`
    ).bind(session.user_id, provider).run();

    if (!result.meta?.changes) {
      return json({ ok: false, error: 'Provider not found or already removed' }, 404);
    }

    await audit(context.env, {
      action: 'OAUTH_PROVIDER_DISCONNECTED',
      entity: 'oauth_identities',
      entity_id: session.user_id,
      kind: 'mutation',
      detail: { provider },
      created_by: session.user_id,
    });

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
