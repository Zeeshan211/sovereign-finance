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
  grocery: "groceries",
  groceries: "groceries",

  food: "food_dining",
  food_dining: "food_dining",
  dining: "food_dining",

  transport: "transport",
  travel: "transport",

  bill: "bills_utilities",
  bills: "bills_utilities",
  utility: "bills_utilities",
  utilities: "bills_utilities",
  bills_utilities: "bills_utilities",

  health: "health",
  medical: "health",

  fee: "bank_fee",
  bank_fee: "bank_fee",
  atm: "atm_fee",
  atm_fee: "atm_fee",

  cc: "credit_card",
  card: "credit_card",
  credit: "credit_card",
  credit_card: "credit_card",
  cc_payment: "credit_card",
  cc_spend: "credit_card",

  debt: "debt_payment",
  debt_payment: "debt_payment",
  repay: "debt_payment",
  repayment: "debt_payment",

  salary: "salary_income",
  salary_income: "salary_income",

  income: "manual_income",
  manual_income: "manual_income",
  manual: "manual_income",

  transfer: "transfer",

  misc: "misc",
  miscellaneous: "misc",
  other: "misc",
  general: "misc"
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
