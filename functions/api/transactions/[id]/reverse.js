/* functions/api/transactions/[id]/reverse.js
 * Sovereign Finance · Transaction Reverse By ID Shim
 * v0.2.0-reverse-by-id-shim
 *
 * Contract:
 * - This file owns POST /api/transactions/:id/reverse only as a route shim.
 * - No money logic lives here.
 * - No ledger rows are created here.
 * - No debt/bill/account repair logic lives here.
 * - It forwards the path id into the canonical reversal route:
 *     POST /api/transactions/reverse
 *
 * Canonical owner:
 *   functions/api/transactions/reverse.js
 */

import { onRequestPost as canonicalReversePost } from '../reverse.js';

const VERSION = 'v0.2.0-reverse-by-id-shim';
const CONTRACT_VERSION = 'ledger-reversal-shim-v1';

export async function onRequestGet(context) {
  const transactionId = getTransactionId(context);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    route: '/api/transactions/:id/reverse',
    canonical_route: '/api/transactions/reverse',
    transaction_id: transactionId || null,
    method: 'POST',
    role: 'shim_only',
    money_logic: false,
    required_body: {
      reason: 'string'
    },
    forwarded_body: {
      transaction_id: transactionId || ':id',
      id: transactionId || ':id',
      reason: 'string',
      created_by: 'string'
    }
  });
}

export async function onRequestPost(context) {
  try {
    const transactionId = getTransactionId(context);

    if (!transactionId) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transaction id required in route path',
        code: 'ROUTE_TRANSACTION_ID_REQUIRED',
        committed: false
      }, 400);
    }

    const body = await readJSON(context.request);

    const mergedBody = {
      ...body,
      transaction_id: transactionId,
      id: transactionId,
      created_by: cleanText(body.created_by, 'web-ledger', 100) || 'web-ledger'
    };

    const proxyRequest = new Request(context.request.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(mergedBody)
    });

    return canonicalReversePost({
      ...context,
      request: proxyRequest
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err && err.message ? err.message : String(err),
      code: 'REVERSE_SHIM_FAILED',
      committed: false,
      stack: err && err.stack
        ? String(err.stack).split('\n').slice(0, 4).join(' | ')
        : null
    }, 500);
  }
}

export async function onRequestPut() {
  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    error: 'PUT is not supported. Use POST /api/transactions/:id/reverse with a reason.',
    code: 'METHOD_NOT_ALLOWED',
    committed: false
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    error: 'DELETE is not supported. Ledger corrections must use append-only reversal.',
    code: 'METHOD_NOT_ALLOWED',
    committed: false
  }, 405);
}

function getTransactionId(context) {
  const params = context && context.params ? context.params : {};

  return cleanText(
    params.id ||
      params.transaction_id ||
      params.path ||
      '',
    '',
    200
  );
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function cleanText(value, fallback = '', maxLen = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
