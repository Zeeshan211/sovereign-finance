/* /api/debts/payments/:payment_id/reverse
 * Sovereign Finance · Retired Debt Payment Reverse Route
 * v1.1.0-retired-use-canonical-transactions-reverse
 *
 * This route is intentionally retired.
 *
 * Canonical reversal owner:
 *   POST /api/transactions/reverse
 *
 * Reason:
 *   Ledger reversal must be centralized in the Transactions API.
 *   Debt repair after reversal must happen as module repair inside the canonical reversal flow.
 */

const VERSION = 'v1.1.0-retired-use-canonical-transactions-reverse';
const CONTRACT_VERSION = 'debts-v1';

export async function onRequestGet(context) {
  return retired(context, 'GET');
}

export async function onRequestPost(context) {
  return retired(context, 'POST');
}

export async function onRequestPut(context) {
  return retired(context, 'PUT');
}

export async function onRequestPatch(context) {
  return retired(context, 'PATCH');
}

export async function onRequestDelete(context) {
  return retired(context, 'DELETE');
}

async function retired(context, method) {
  const paymentId = getPaymentId(context);

  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    retired: true,
    code: 'DEBT_PAYMENT_REVERSE_ROUTE_RETIRED',
    error: 'This debt payment reverse route is retired. Use the canonical transaction reversal route.',
    method,
    received_payment_id: paymentId || null,

    canonical_route: '/api/transactions/reverse',
    canonical_method: 'POST',

    canonical_payload_example: {
      id: 'transaction_id_here',
      reason: 'Reversal reason',
      created_by: 'web-ledger'
    },

    canonical_behavior: {
      debt_payment_marker: '[DEBT_PAYMENT] or [DEBT_RECEIVE]',
      expected_repair: 'Canonical reversal should mark linked debt_payments row reversed, recalculate debt paid_amount, and reopen settled debt if needed.',
      debt_origin_marker: '[DEBT_ORIGIN] or [DEBT_ORIGIN_REPAIR]',
      origin_rule: 'If origin has payments, canonical reversal should block until payments are reversed first.'
    },

    reason: 'Debt payment reversal must be owned only by POST /api/transactions/reverse.',
    committed: false,
    writes_performed: false,
    warnings: [
      'No payment row was updated.',
      'No reversal transaction was created.',
      'No debt paid_amount was recalculated.',
      'No account balance was affected.'
    ]
  }, 410);
}

function getPaymentId(context) {
  const params = context && context.params ? context.params : {};
  return text(params.payment_id || params.paymentId || params.id || '', '', 160);
}

function text(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
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
