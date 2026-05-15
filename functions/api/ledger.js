/* /api/ledger
 * Sovereign Finance · Ledger API
 * v0.2.0-linked-reversal-engine
 */

import * as Transactions from './transactions.js';
import * as TransactionsReverse from './transactions/reverse.js';

const VERSION = 'v0.2.0-linked-reversal-engine';

export async function onRequestGet(context) {
  try {
    const response = await Transactions.onRequestGet(context);
    const body = await response.json();

    return json({
      ...body,
      ledger_version: VERSION,
      ledger_contract: {
        endpoint: '/api/ledger',
        transaction_endpoint: '/api/transactions',
        reversal_endpoint: '/api/ledger/reverse',
        purpose: 'Canonical ledger API for Phase 1 backend contract',
        supports_reversal: true,
        supports_linked_transactions: true,
        money_engine: true
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

export async function onRequestPost(context) {
  try {
    const url = new URL(context.request.url);

    if (url.pathname.endsWith('/reverse')) {
      return await TransactionsReverse.onRequestPost(context);
    }

    const response = await Transactions.onRequestPost(context);
    const body = await response.json();

    return json({
      ...body,
      ledger_version: VERSION
    }, response.status || 200);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
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
