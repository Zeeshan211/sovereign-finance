import { getSession } from './_lib/auth.js';

// Trusted origins for CSRF protection (mutation endpoints)
const ALLOWED_ORIGINS = new Set([
  'https://sovereign-finance.pages.dev',
  'https://liquidityos.sherk3344.workers.dev',
  'https://liquidityos.com',
]);

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function addSecurityHeaders(response) {
  const cloned = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    cloned.headers.set(key, value);
  }
  return cloned;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;
  const method = context.request.method;

  // Public: auth routes + health (skip session check but still add security headers)
  if (
    path.startsWith('/api/auth/') ||
    path === '/api/health' ||
    path === '/api/deploy-check'
  ) {
    const response = await context.next();
    return addSecurityHeaders(response);
  }

  // CSRF protection: verify Origin on mutations
  if (MUTATION_METHODS.has(method)) {
    const origin = context.request.headers.get('Origin');
    // If Origin is present and not in allowlist → reject
    // No Origin header is acceptable for server-to-server calls
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ ok: false, error: 'Forbidden: Origin not allowed' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          ...SECURITY_HEADERS,
        },
      });
    }
  }

  const session = await getSession(context.env, context.request).catch(() => null);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        ...SECURITY_HEADERS,
      },
    });
  }

  context.data.user_id = session.user_id;
  context.data.user_email = session.email;
  context.data.session_id = session.id;

  const response = await context.next();
  return addSecurityHeaders(response);
}
