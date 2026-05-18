/* /api/bills/:id/pay
 * Sovereign Finance · Retired Bill Item Pay Route
 * v1.0.0-retired-use-canonical-bills-payment
 *
 * This route is intentionally retired.
 *
 * Canonical payment owner:
 *   POST /api/bills
 *   body.action = "payment"
 *
 * Compatibility route that may still work:
 *   POST /api/bills/pay
 *
 * Reason:
 *   Bill payment money movement must be centralized in functions/api/bills/[[path]].js.
 *   This prevents duplicate ledger writes, old cycle math, missing bill_month handling,
 *   missing advance-payment handling, and account drift.
 */

const VERSION = 'v1.0.0-retired-use-canonical-bills-payment';
const CONTRACT_VERSION = 'bills-v1';

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
  const billId = getBillId(context);

  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    retired: true,
    code: 'BILL_ITEM_PAY_ROUTE_RETIRED',
    error: 'This bill item pay route is retired. Use the canonical Bills payment route.',
    method,
    received_bill_id: billId || null,

    canonical_route: '/api/bills',
    canonical_method: 'POST',
    canonical_action: 'payment',

    compatibility_route: '/api/bills/pay',
    compatibility_method: 'POST',

    canonical_payload_example: {
      action: 'payment',
      bill_id: billId || 'bill_id_here',
      amount: 5000,
      account_id: 'account_id_here',
      date: 'YYYY-MM-DD',
      bill_month: 'YYYY-MM',
      notes: 'Payment notes',
      idempotency_key: 'client-generated-key'
    },

    current_cycle_example: {
      action: 'payment',
      bill_id: billId || 'bill_id_here',
      amount: 5000,
      account_id: 'meezan',
      date: '2026-05-19',
      bill_month: '2026-05',
      notes: 'Paid current cycle'
    },

    advance_payment_example: {
      action: 'payment',
      bill_id: billId || 'bill_id_here',
      amount: 5000,
      account_id: 'meezan',
      date: '2026-05-19',
      bill_month: '2026-06',
      notes: 'Advance payment for future cycle'
    },

    canonical_behavior: {
      create_bill: 'Creates bill obligation only. No ledger movement.',
      pay_bill: 'Creates ledger expense transaction and bill_payments link row.',
      current_cycle: 'bill_month equal to current month updates current-cycle paid/remaining proof.',
      advance_cycle: 'future bill_month is treated as paid in advance.',
      account_balance: 'Account balance must remain ledger-derived.'
    },

    reason: 'Bill payment ledger writes must be owned only by the canonical Bills API.',
    committed: false,
    writes_performed: false,
    warnings: [
      'No bill row was updated.',
      'No bill payment row was created.',
      'No ledger transaction was created.',
      'No account balance was affected.',
      'Use POST /api/bills with action=payment or POST /api/bills/pay compatibility route.'
    ]
  }, 410);
}

function getBillId(context) {
  const params = context && context.params ? context.params : {};
  return text(params.id || params.bill_id || '', '', 160);
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
