/* functions/api/transactions/[id]/reverse.js
 * v0.1.0-reverse-by-id-shim
 *
 * Why this file exists:
 *   Frontend (transactions-v084.js) posts to
 *     POST /api/transactions/<tx_id>/reverse
 *   The transactions catchall does not handle this URL pattern.
 *   The canonical handler lives at /api/transactions/reverse and expects
 *   transaction_id in the body.
 *
 *   This shim intercepts the frontend's URL, merges the path id into the
 *   body, and delegates to the canonical handler. No money logic lives here.
 *
 * To delete after the frontend is rewritten to call /api/transactions/reverse
 * directly:
 *   git rm functions/api/transactions/\[id\]/reverse.js
 */

import { onRequestPost as canonicalReverse } from '../reverse.js';

export async function onRequestPost(context) {
  try {
    const id = context.params?.id;
    let body = {};
    try { body = await context.request.json(); } catch { body = {}; }

    const merged = {
      ...body,
      transaction_id: id || body.transaction_id || body.id,
      id: id || body.id
    };

    const proxyRequest = new Request(context.request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merged)
    });

    return canonicalReverse({ ...context, request: proxyRequest });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      version: 'reverse-shim-v0.1.0',
      error: {
        code: 'REVERSE_SHIM_FAILED',
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null
      }
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}
