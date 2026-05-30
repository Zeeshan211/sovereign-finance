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
  try {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

export async function onRequest(context) {
  try {
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

    // Single-user app: only the owner role may access data.
    // Members created before this fix are blocked here.
    if (session.role !== 'owner') {
      return new Response(JSON.stringify({ ok: false, error: 'Access denied. This is a single-user instance.' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          ...SECURITY_HEADERS,
        },
      });
    }

    context.data.user_id = session.user_id;
    context.data.user_email = session.email;
    context.data.session_id = session.id;
    context.data.role = session.role;

    const response = await context.next();
    return addSecurityHeaders(response);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error', detail: String(err && err.message || err) }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...SECURITY_HEADERS,
      },
    });
  }
}
