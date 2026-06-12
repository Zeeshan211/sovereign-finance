// POST /api/auth/oauth-google
// Verifies a Google ID token (from Identity Services / One Tap) and signs the user in.
// Creates a new account if none exists for this Google identity.
// Links the Google identity to an existing account if the email matches.

import { json, uuid, audit } from '../_lib.js';
import { createSession, sessionCookie, checkRateLimit } from '../_lib/auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    // Rate-limit by IP (reuses the same window as password logins)
    const ip =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For') ||
      'unknown';
    if (await checkRateLimit(env, ip)) {
      return json({ ok: false, error: 'Too many requests. Try again shortly.' }, 429);
    }

    const body = await request.json().catch(() => ({}));
    const credential = String(body.credential || '').trim();
    if (!credential) return json({ ok: false, error: 'Missing Google credential' }, 400);

    // Verify the ID token with Google's tokeninfo endpoint.
    // This validates signature, expiry, and returns the decoded payload.
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    if (!verifyRes.ok) return json({ ok: false, error: 'Google token verification failed' }, 401);

    const payload = await verifyRes.json();
    if (payload.error) return json({ ok: false, error: 'Invalid Google token' }, 401);

    // Validate the audience matches our app's Client ID (prevents token stuffing).
    if (payload.aud !== env.GOOGLE_CLIENT_ID) {
      return json({ ok: false, error: 'Token audience mismatch' }, 401);
    }

    const emailVerified = payload.email_verified === 'true' || payload.email_verified === true;
    if (!emailVerified) {
      return json({ ok: false, error: 'Google account email is not verified' }, 401);
    }

    const { sub, email, name } = payload;
    if (!sub || !email) return json({ ok: false, error: 'Incomplete Google profile' }, 400);

    const normalizedEmail = email.toLowerCase().trim();
    let isNew = false;

    // 1. Check for an existing OAuth identity (returning Google user)
    let user = await env.DB.prepare(`
      SELECT u.* FROM users u
      JOIN oauth_identities oi ON oi.user_id = u.id
      WHERE oi.provider = 'google' AND oi.provider_sub = ?
    `).bind(sub).first();

    if (!user) {
      // 2. No Google identity — check if an account with this email already exists
      const existing = await env.DB.prepare(
        `SELECT * FROM users WHERE email = ?`
      ).bind(normalizedEmail).first();

      if (existing) {
        // Link Google identity to the existing account (account merge)
        user = existing;
        await env.DB.prepare(`
          INSERT INTO oauth_identities (user_id, provider, provider_sub, provider_email)
          VALUES (?, 'google', ?, ?)
          ON CONFLICT(provider, provider_sub) DO NOTHING
        `).bind(existing.id, sub, email).run();
      } else {
        // 3. Brand-new user — create account with empty password_hash
        const userId = 'user_' + uuid();
        isNew = true;

        // First registered user (any auth method) becomes owner
        const ownerExists = await env.DB.prepare(
          `SELECT id FROM users WHERE role = 'owner' LIMIT 1`
        ).first();
        const role = ownerExists ? 'member' : 'owner';

        // Ensure the default household exists
        const hhExists = await env.DB.prepare(
          `SELECT id FROM households WHERE id = 'hh_owner'`
        ).first();
        if (!hhExists) {
          await env.DB.prepare(
            `INSERT INTO households (id, name, owner_user_id) VALUES ('hh_owner', 'My Household', ?)`
          ).bind(userId).run();
        }

        const displayName = (name || normalizedEmail.split('@')[0]).slice(0, 100);
        await env.DB.prepare(`
          INSERT INTO users (id, household_id, email, password_hash, full_name, role, status)
          VALUES (?, 'hh_owner', ?, '', ?, ?, 'active')
        `).bind(userId, normalizedEmail, displayName, role).run();

        await env.DB.prepare(`
          INSERT INTO oauth_identities (user_id, provider, provider_sub, provider_email)
          VALUES (?, 'google', ?, ?)
        `).bind(userId, sub, email).run();

        // Backfill any legacy NULL-attributed rows to the first owner
        if (!ownerExists) {
          for (const tbl of [
            'accounts', 'transactions', 'bills', 'bill_payments', 'budgets',
            'categories', 'debts', 'debt_payments', 'goals', 'merchants',
            'nano_loans', 'reconciliation', 'salary', 'salary_config',
            'salary_contracts', 'salary_payslips', 'snapshots', 'audit_log'
          ]) {
            await env.DB.prepare(
              `UPDATE ${tbl} SET user_id = ? WHERE user_id IS NULL`
            ).bind(userId).run().catch(() => {});
          }
        }

        user = { id: userId, email: normalizedEmail, role };
      }
    }

    const token = await createSession(env, user.id, request);

    await audit(env, {
      action: 'USER_OAUTH_LOGIN',
      entity: 'users',
      entity_id: user.id,
      kind: 'auth',
      detail: { provider: 'google', email: normalizedEmail, is_new: isNew },
      created_by: user.id,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        is_new: isNew,
        user: { id: user.id, email: user.email, role: user.role },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': sessionCookie(token),
        },
      }
    );
  } catch (e) {
    return json({ ok: false, error: e.message || 'Internal server error' }, 500);
  }
}
