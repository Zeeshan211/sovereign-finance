// Auth helpers — Web Crypto API only, no npm deps
// Password hashing: PBKDF2-SHA256 10k iterations (fits Workers 50ms CPU budget)

const COOKIE_NAME = 'sid';
const SESSION_DAYS = 30;
const RATE_LIMIT_WINDOW_MIN = 15;
const RATE_LIMIT_MAX = 5;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-256' }, key, 256
  );
  return `pbkdf2:10000:${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [, iters, saltHex, expectedHex] = stored.split(':');
    const salt = fromHex(saltHex);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      // reads iteration count from stored hash — compatible with any past cost
      { name: 'PBKDF2', salt, iterations: Number(iters), hash: 'SHA-256' }, key, 256
    );
    return toHex(new Uint8Array(bits)) === expectedHex;
  } catch {
    return false;
  }
}

export async function hashToken(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(buf));
}

export function generateToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Path=/`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}

export function getTokenFromCookie(request) {
  const h = request.headers.get('Cookie') || '';
  const m = h.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? m[1].trim() : null;
}

export async function getSession(env, request) {
  const token = getTokenFromCookie(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const session = await env.DB.prepare(
    `SELECT s.id, s.user_id, u.email, u.role, u.status, u.household_id
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > ?
       AND u.status = 'active'`
  ).bind(tokenHash, now).first();
  if (session) {
    env.DB.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`)
      .bind(now, session.id).run().catch(() => {});
  }
  return session || null;
}

export async function createSession(env, userId, request) {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const sessionId = 'sess-' + toHex(crypto.getRandomValues(new Uint8Array(8)));
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  const ip = request.headers.get('CF-Connecting-IP') ||
              request.headers.get('X-Forwarded-For') || null;
  const ua = request.headers.get('User-Agent') || null;
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, userId, tokenHash, ip, ua, expiresAt).run();
  return token;
}

export async function checkRateLimit(env, ip) {
  const window = getRateLimitWindow();
  try {
    const result = await env.DB.prepare(
      `INSERT INTO auth_rate_limits (ip_address, window_start, attempt_count)
       VALUES (?, ?, 1)
       ON CONFLICT (ip_address, window_start)
       DO UPDATE SET attempt_count = attempt_count + 1
       RETURNING attempt_count`
    ).bind(ip, window).first();
    return (result ? result.attempt_count : 1) > RATE_LIMIT_MAX;
  } catch {
    return false;
  }
}

export async function recordLoginAttempt(env, email, ip, success, reason) {
  await env.DB.prepare(
    `INSERT INTO login_attempts (email, ip_address, success, failure_reason)
     VALUES (?, ?, ?, ?)`
  ).bind(email, ip, success ? 1 : 0, reason || null).run().catch(() => {});
}

function getRateLimitWindow() {
  const now = new Date();
  const m = Math.floor(now.getUTCMinutes() / RATE_LIMIT_WINDOW_MIN) * RATE_LIMIT_WINDOW_MIN;
  now.setUTCMinutes(m, 0, 0);
  return now.toISOString().slice(0, 16);
}

function toHex(buf) {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}
