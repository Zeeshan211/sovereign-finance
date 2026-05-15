/* /api/ledger/reverse — POST
 * Sovereign Finance · Ledger Reversal
 * v0.2.0-linked-reversal-engine
 */

import * as TransactionsReverse from '../transactions/reverse.js';

const VERSION = 'v0.2.0-linked-reversal-engine';

export async function onRequestPost(context) {
  try {
    const response = await TransactionsReverse.onRequestPost(context);
    const body = await response.json();

    return json({
      ...body,
      ledger_reversal_version: VERSION,
      ledger_contract: {
        endpoint: '/api/ledger/reverse',
        transaction_reversal_endpoint: '/api/transactions/reverse',
        purpose: 'Canonical reversal endpoint for Phase 1 backend contract',
        supports_single_reversal: true,
        supports_linked_reversal: true,
        marks_original_reversed: true
      }
    }, response.status || 200);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    version: VERSION,
    endpoint: '/api/ledger/reverse',
    method_required: 'POST',
    required_body: {
      id: 'transaction_id',
      reason: 'reason for reversal'
    },
    contract: {
      wraps: '/api/transactions/reverse',
      supports_single_reversal: true,
      supports_linked_reversal: true
    }
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
