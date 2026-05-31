import { json, uuid, audit } from '../_lib.js';
import { hashPassword, createSession, sessionCookie } from '../_lib/auth.js';

export async function onRequestPost(context) {
  try {
    const body = await readJSON(context.request);
    const email = clean(body.email);
    const password = String(body.password || '');

    if (!email || !password) return json({ ok: false, error: 'email and password required' }, 400);
    if (!isValidEmail(email)) return json({ ok: false, error: 'invalid email' }, 400);
    if (password.length < 8) return json({ ok: false, error: 'password must be at least 8 characters' }, 400);

    const existing = await context.env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(email).first();
    if (existing) return json({ ok: false, error: 'email already registered' }, 409);

    const passwordHash = await hashPassword(password);
    const userId = 'user_' + uuid();

    // First real user (with password) becomes owner
    const ownerExists = await context.env.DB.prepare(
      `SELECT id FROM users WHERE password_hash IS NOT NULL LIMIT 1`
    ).first();
    const role = ownerExists ? 'member' : 'owner';

    // Use or create household
    let householdId = 'hh_owner';
    const hhExists = await context.env.DB.prepare(
      `SELECT id FROM households WHERE id = 'hh_owner'`
    ).first();
    if (!hhExists) {
      await context.env.DB.prepare(
        `INSERT INTO households (id, name, owner_user_id) VALUES ('hh_owner', 'My Household', ?)`
      ).bind(userId).run();
    }

    await context.env.DB.prepare(
      `INSERT INTO users (id, household_id, email, password_hash, full_name, role, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    ).bind(userId, householdId, email, passwordHash, email.split('@')[0], role).run();

    // Backfill NULL-attributed rows to first real owner
    if (!ownerExists) {
      for (const tbl of ['accounts', 'transactions', 'bills', 'debts']) {
        await context.env.DB.prepare(
          `UPDATE ${tbl} SET user_id = ? WHERE user_id IS NULL`
        ).bind(userId).run().catch(() => {});
      }
    }

    const token = await createSession(context.env, userId, context.request);

    await audit(context.env, {
      action: 'USER_REGISTER',
      entity: 'users',
      entity_id: userId,
      kind: 'mutation',
      detail: { email, role },
      created_by: userId
    });

    return new Response(JSON.stringify({ ok: true, user: { id: userId, email, role } }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(token)
      }
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function readJSON(req) { try { return await req.json(); } catch { return {}; } }
function clean(v) { return String(v || '').trim().toLowerCase().slice(0, 254); }
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
