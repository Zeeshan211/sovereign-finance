import { getSession } from './_lib/auth.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Public: auth routes + health
  if (
    path.startsWith('/api/auth/') ||
    path === '/api/health' ||
    path === '/api/deploy-check'
  ) {
    return context.next();
  }

  const session = await getSession(context.env, context.request).catch(() => null);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  context.data.user_id = session.user_id;
  context.data.user_email = session.email;
  context.data.session_id = session.id;
  return context.next();
}
