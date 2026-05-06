/* ─── /api/deploy-check · v0.1.0 · read-only deploy probe ─── */
/*
 * Purpose:
 *   Proves which Cloudflare Pages Functions deploy is live.
 *
 * Risk:
 *   Read-only.
 *   No D1 access.
 *   No ledger writes.
 *   No imports.
 *
 * Expected route:
 *   GET /api/deploy-check
 */

const VERSION = 'v0.1.0';
const BUILD_LABEL = 'layer-5A-functions-deploy-probe';
const SHIPPED_FOR = 'debt-api-live-version-drift';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  return new Response(JSON.stringify({
    ok: true,
    version: VERSION,
    build_label: BUILD_LABEL,
    shipped_for: SHIPPED_FOR,
    route: '/api/deploy-check',
    method: context.request.method,
    host: url.host,
    timestamp_utc: new Date().toISOString()
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
