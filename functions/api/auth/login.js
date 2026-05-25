import { json } from '../_lib.js';
import { verifyPassword, createSession, sessionCookie, checkRateLimit, recordLoginAttempt } from '../_lib/auth.js';

export async function onRequestPost(context) {
  const ip = context.request.headers.get('CF-Connecting-IP') ||
              context.request.headers.get('X-Forwarded-For') || 'unknown';
  try {
    const limited = await checkRateLimit(context.env, ip);
    if (limited) {
      return json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' }, 429);
    }

    const body = await readJSON(context.request);
    const email = clean(body.email);
    const password = String(body.password || '');

    if (!email || !password) return json({ ok: false, error: 'email and password required' }, 400);

    const user = await context.env.DB.prepare(
      `SELECT id, email, password_hash, role, status
       FROM users WHERE email = ? AND status = 'active'`
    ).bind(email).first();

    if (!user || !user.password_hash) {
      await recordLoginAttempt(context.env, email, ip, false, 'user_not_found');
      return json({ ok: false, error: 'Invalid email or password' }, 401);
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await recordLoginAttempt(context.env, email, ip, false, 'wrong_password');
      return json({ ok: false, error: 'Invalid email or password' }, 401);
    }

    await recordLoginAttempt(context.env, email, ip, true, null);

    const token = await createSession(context.env, user.id, context.request);

    context.env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
    ).bind(user.id).run().catch(() => {});

    return new Response(JSON.stringify({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role }
    }), {
      status: 200,
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
