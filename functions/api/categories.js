/* ─── /api/categories — GET list ─── */
/* Cloudflare Pages Function v0.1.0 · Sub-1D-CATEGORY-RECONCILE Ship A */
/*
 * Returns live category list from D1.
 * Solves: store.js was hardcoding 12 categories with drifted IDs vs D1's 15 real categories.
 *   - groceries (store) vs grocery (D1)
 *   - debt_payment (store) vs debt (D1)
 *   - cc_payment (store) vs cc_pay (D1)
 *   - missing in store: cc_spend, biller, transfer
 *
 * Schema (per SCHEMA.md):
 *   id TEXT pk · name TEXT not null · icon TEXT · type TEXT · parent_id TEXT
 *   monthly_budget REAL default 0 · color TEXT · display_order INTEGER default 0
 *
 * No POST/PUT/DELETE this ship — categories are seeded via migration, not via API.
 * Ship B (store.js v0.2.0) will fetch this endpoint on init.
 */

export async function onRequestGet(context) {
  try {
    const stmt = context.env.DB.prepare(
      `SELECT id, name, icon, type, parent_id, monthly_budget, color, display_order
       FROM categories
       ORDER BY display_order, name`
    );
    const result = await stmt.all();

    return jsonResponse({
      ok: true,
      count: result.results.length,
      categories: result.results
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
