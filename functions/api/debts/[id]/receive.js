/* /api/debts/:id/receive
 * Sovereign Finance · Retired Debt Receive Route
 * v1.1.0-retired-use-canonical-debts-payment
 *
 * This route is intentionally retired.
 *
 * Canonical payment/receive owner:
 *   POST /api/debts
 *   body.action = "payment"
 *
 * Reason:
 *   Receiving money against an "owed" debt is still a debt payment action.
 *   The canonical Debts API decides direction from debt.kind:
 *     kind = owe  → expense + [DEBT_PAYMENT]
 *     kind = owed → income  + [DEBT_RECEIVE]
 */

const VERSION = 'v1.1.0-retired-use-canonical-debts-payment';
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
  const debtId = getDebtId(context);

  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    retired: true,
    code: 'DEBT_RECEIVE_ROUTE_RETIRED',
    error: 'This debt receive route is retired. Use the canonical Debts payment route.',
    method,
    received_debt_id: debtId || null,

    canonical_route: '/api/debts',
    canonical_method: 'POST',
    canonical_action: 'payment',

    canonical_payload_example: {
      action: 'payment',
      debt_id: debtId || 'debt_id_here',
      amount: 2500,
      account_id: 'account_id_here',
      date: 'YYYY-MM-DD',
      notes: 'Receive/payment notes',
      idempotency_key: 'client-generated-key'
    },

    canonical_behavior: {
      owe: 'Backend writes expense with [DEBT_PAYMENT].',
      owed: 'Backend writes income with [DEBT_RECEIVE].'
    },

    optional_partial_payment_schedule_fields: {
      next_due_date: 'YYYY-MM-DD',
      due_day: 1,
      installment_amount: 2500,
      frequency: 'monthly'
    },

    reason: 'Debt receive ledger writes must be owned only by POST /api/debts action=payment.',
    committed: false,
    writes_performed: false,
    warnings: [
      'No debt row was updated.',
      'No ledger transaction was created.',
      'No account balance was affected.'
    ]
  }, 410);
}

function getDebtId(context) {
  const params = context && context.params ? context.params : {};
  return text(params.id || params.debt_id || '', '', 160);
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
