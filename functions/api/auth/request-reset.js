import { json, uuid, audit } from '../_lib.js';
import { hashToken, generateToken } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const body = await readJSON(context.request);
    const email = clean(body.email);
    if (!email) return json({ ok: false, error: 'email required' }, 400);

    // Always return 200 — prevents email enumeration
    const user = await context.env.DB.prepare(
      `SELECT id FROM users WHERE email = ? AND status = 'active'`
    ).bind(email).first();

    if (user) {
      const token = generateToken();
      const tokenHash = await hashToken(token);
      const tokenId = 'rst_' + uuid();
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

      await context.env.DB.prepare(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`
      ).bind(tokenId, user.id, tokenHash, expiresAt).run();

      const resetUrl = `https://liquidityos.sherk3344.workers.dev/reset-password?token=${token}`;

      // Stub: email not wired — write reset_url to audit log for manual retrieval
      await audit(context.env, {
        action: 'PASSWORD_RESET_REQUEST',
        entity: 'password_reset_tokens',
        entity_id: tokenId,
        kind: 'mutation',
        detail: { reset_url: resetUrl, email, expires_at: expiresAt },
        created_by: user.id
      });
    }

    return json({
      ok: true,
      message: 'If that email is registered, a reset link has been logged to the audit trail at /api/audit.'
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function readJSON(req) { try { return await req.json(); } catch { return {}; } }
function clean(v) { return String(v || '').trim().toLowerCase().slice(0, 254); }
