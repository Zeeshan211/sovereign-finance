/* /api/debts/repair
 * Sovereign Finance · Retired Standalone Debts Repair Route
 * v1.1.0-retired-use-canonical-debts-repair-actions
 *
 * This route is intentionally retired.
 *
 * Canonical repair owner:
 *   POST /api/debts
 *
 * Canonical repair actions:
 *   action = "repair_ledger"
 *   action = "repair_settled_debts"
 *   action = "repair_reversed_payments"
 *
 * Reason:
 *   Repair logic must be centralized in functions/api/debts/[[path]].js.
 *   No standalone repair endpoint should mutate debts separately from the canonical contract owner.
 */

const VERSION = 'v1.1.0-retired-use-canonical-debts-repair-actions';
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
  const url = new URL(context.request.url);
  const action = text(url.searchParams.get('action'), '', 120);

  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    retired: true,
    code: 'DEBTS_STANDALONE_REPAIR_ROUTE_RETIRED',
    error: 'This standalone debts repair route is retired. Use canonical POST /api/debts repair actions.',
    method,
    received_action: action || null,

    canonical_route: '/api/debts',
    canonical_method: 'POST',

    canonical_actions: {
      repair_ledger: {
        description: 'Create explicit missing debt origin ledger row when backend proof says origin movement is required.',
        payload_example: {
          action: 'repair_ledger',
          debt_id: 'debt_id_here',
          account_id: 'account_id_here',
          date: 'YYYY-MM-DD',
          idempotency_key: 'client-generated-key'
        }
      },

      repair_settled_debts: {
        description: 'Explicitly settle fully paid active debts and normalize terminal statuses.',
        payload_example: {
          action: 'repair_settled_debts',
          dry_run: true
        }
      },

      repair_reversed_payments: {
        description: 'Explicitly repair debt_payments rows linked to already reversed ledger transactions.',
        payload_example: {
          action: 'repair_reversed_payments',
          dry_run: true
        }
      }
    },

    reason: 'Debt repair writes must be owned only by functions/api/debts/[[path]].js through POST /api/debts actions.',
    committed: false,
    writes_performed: false,
    warnings: [
      'No debt row was updated.',
      'No debt status was normalized.',
      'No ledger transaction was created.',
      'No debt payment row was updated.',
      'No account balance was affected.'
    ]
  }, 410);
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
