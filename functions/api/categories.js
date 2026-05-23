/* /api/categories — GET */
/* Sovereign Finance v0.2.0-contract-lock
 *
 * Contract:
 * - Categories are backend-owned.
 * - Frontend must not hardcode category IDs as truth.
 * - This endpoint returns canonical category IDs plus aliases for legacy inputs.
 * - Mutating category operations are not part of Shipment 3.
 */

const VERSION = "v0.2.0-contract-lock";

const CATEGORY_ALIASES = {
  grocery: "grocery",
  groceries: "grocery",

  food: "food",
  food_dining: "food",
  dining: "food",

  transport: "transport",
  travel: "transport",

  bill: "bills",
  bills: "bills",
  utility: "bills",
  utilities: "bills",
  bills_utilities: "bills",

  health: "health",
  medical: "health",

  fee: "other",
  bank_fee: "other",
  atm: "other",
  atm_fee: "other",

  cc: "cc_spend",
  card: "cc_spend",
  credit: "cc_spend",
  credit_card: "cc_spend",
  cc_payment: "cc_pay",
  cc_spend: "cc_spend",

  debt: "debt",
  debt_payment: "debt",
  repay: "debt",
  repayment: "debt",

  salary: "salary",
  salary_income: "salary",

  income: "other",
  manual_income: "other",
  manual: "other",

  transfer: "transfer",

  misc: "other",
  miscellaneous: "other",
  other: "other",
  general: "other",
  intl: "other",
  intl_subscription: "other"
};

export async function onRequestGet(context) {
  try {
    const result = await context.env.DB.prepare(
      `SELECT id, name, icon, type, parent_id, monthly_budget, color, display_order
       FROM categories
       ORDER BY display_order, name`
    ).all();

    const categories = result.results || [];
    const ids = new Set(categories.map(row => row.id));

    const aliases = Object.fromEntries(
      Object.entries(CATEGORY_ALIASES).filter(([, canonical]) => ids.has(canonical))
    );

    return jsonResponse({
      ok: true,
      version: VERSION,
      count: categories.length,
      categories,
      contract: {
        source_of_truth: "D1 categories table",
        frontend_rule: "Use IDs returned by this endpoint. Do not invent category IDs.",
        unsupported: ["adjustment"],
        aliases
      }
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache"
    }
  });
}
