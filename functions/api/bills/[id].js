/* functions/api/bills/[id].js
 * v0.5.0-delegate-to-catchall
 *
 * Why this file is now a shim:
 *   Cloudflare Pages routes `/api/bills/<single-segment>` to this `[id].js`
 *   BEFORE the catchall `[[path]].js`. The previous version of this file
 *   rejected reserved words like 'pay' / 'update' / 'defer' / 'repair' /
 *   'history' / 'health' / 'cycle' with RESERVED_BILLS_ROUTE, which made
 *   POST /api/bills/pay (and friends) impossible to reach — the catchall
 *   never ran.
 *
 *   The catchall `[[path]].js` v0.8.1 already implements:
 *     - GET    /api/bills/:id            (getBillDetail)
 *     - PUT    /api/bills/:id            (onRequestPut)
 *     - DELETE /api/bills/:id            (onRequestDelete)
 *     - POST   /api/bills/pay            (payBill via routeAction)
 *     - POST   /api/bills/update         (updateBill via routeAction)
 *     - POST   /api/bills/defer          (deferBill via routeAction)
 *     - POST   /api/bills/repair         (repairReversedPayments via routeAction)
 *     - GET    /api/bills/history        (getHistory)
 *     - GET    /api/bills/cycle          (getOverview)
 *
 *   So this file delegates EVERY method to the catchall. No behavior change
 *   for single-id GET/PUT/DELETE. For 'pay'/'update'/'defer'/'repair' the
 *   delegation actually unblocks the broken paths.
 *
 *   To remove this file entirely after confirming the catchall works:
 *     git rm functions/api/bills/\[id\].js
 *     git commit -m "remove [id] shim — catchall owns /api/bills/:id"
 */

import {
  onRequestGet as catchallGet,
  onRequestPost as catchallPost,
  onRequestPut as catchallPut,
  onRequestDelete as catchallDelete
} from './[[path]].js';

/**
 * Cloudflare Pages exposes the path segment as context.params.id for
 * `[id].js` routes and as context.params.path for `[[path]].js` routes.
 * Catchall handlers read `context.params.path`. We normalize the param so
 * the catchall handlers see the same shape regardless of which file caught
 * the request.
 */
function bridge(context) {
  const id = context.params && context.params.id;
  const path = Array.isArray(id) ? id : (id ? [id] : []);
  return {
    ...context,
    params: { ...(context.params || {}), path }
  };
}

export async function onRequestGet(context)    { return catchallGet(bridge(context)); }
export async function onRequestPost(context)   { return catchallPost(bridge(context)); }
export async function onRequestPut(context)    { return catchallPut(bridge(context)); }
export async function onRequestDelete(context) { return catchallDelete(bridge(context)); }
