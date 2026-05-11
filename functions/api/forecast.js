/* /api/forecast — GET */
/* Sovereign Finance v0.6.0-forecast-cc-truth
 *
 * Shipment 6:
 * - Forecast reads real production sources.
 * - No Command Centre gate.
 * - No fake debt zero.
 * - No fake credit-card null when balances/accounts expose CC truth.
 * - Uses /api/balances, /api/bills, and /api/debts as source APIs.
 */

const VERSION = "v0.6.0-forecast-cc-truth";

export async function onRequestGet(context) {
  try {
    const requestUrl = new URL(context.request.url);
    const origin = requestUrl.origin;
    const month = requestUrl.searchParams.get("month") || currentMonth();

    const [balancesResult, billsResult, debtsResult] = await Promise.allSettled([
      readJson(`${origin}/api/balances?debug=1&cb=${Date.now()}`),
      readJson(`${origin}/api/bills?month=${encodeURIComponent(month)}&cb=${Date.now()}`),
      readJson(`${origin}/api/debts?include_inactive=1&cb=${Date.now()}`)
    ]);

    const balances = unwrap(balancesResult, "balances");
    const bills = unwrap(billsResult, "bills");
    const debts = unwrap(debtsResult, "debts");

    const balanceTruth = normalizeBalances(balances.data);
    const billTruth = normalizeBills(bills.data, month);
    const debtTruth = normalizeDebts(debts.data);
    const ccTruth = normalizeCreditCard(balances.data);

    const guaranteedSalary = readGuaranteedSalary(context.env);
    const liquidStart = number(balanceTruth.total_liquid);
    const billsRemaining = number(billTruth.remaining_this_month);
    const debtPayable = number(debtTruth.payable_remaining);
    const debtReceivable = number(debtTruth.receivable_remaining);
    const ccOutstanding = ccTruth.verified ? number(ccTruth.outstanding) : null;

    const projectedBeforeReceivables = round2(
      liquidStart + guaranteedSalary - billsRemaining - debtPayable - (ccOutstanding || 0)
    );

    const projectedWithReceivables = round2(projectedBeforeReceivables + debtReceivable);

    const blockers = [];
    if (!balances.ok) blockers.push(`balances:${balances.error}`);
    if (!bills.ok) blockers.push(`bills:${bills.error}`);
    if (!debts.ok) blockers.push(`debts:${debts.error}`);
    if (!ccTruth.verified) blockers.push("credit_card:verified source unavailable");

    return json({
      ok: true,
      version: VERSION,
      month,
      status: blockers.length ? "degraded" : "ready",
      blockers,
      sources: {
        balances: sourceStatus(balances),
        bills: sourceStatus(bills),
        debts: sourceStatus(debts),
        credit_card: {
          ok: ccTruth.verified,
          source: ccTruth.source,
          account_id: ccTruth.account_id,
          reason: ccTruth.reason || null
        }
      },
      inputs: {
        total_liquid: liquidStart,
        guaranteed_salary: guaranteedSalary,
        bills_remaining_this_month: billsRemaining,
        debt_payable_remaining: debtPayable,
        debt_receivable_remaining: debtReceivable,
        credit_card_outstanding: ccOutstanding
      },
      forecast: {
        projected_cash_after_obligations: projectedBeforeReceivables,
        projected_cash_if_receivables_collected: projectedWithReceivables,
        formula: "total_liquid + guaranteed_salary - bills_remaining - debt_payable - credit_card_outstanding + receivables_optional"
      },
      proof: {
        no_fake_debt_zero: debtTruth.source_count > 0 || debtPayable > 0 || debtReceivable > 0,
        cc_truth_verified: ccTruth.verified,
        command_centre_used: false
      },
      raw_summary: {
        balances_version: balances.data?.version || null,
        bills_version: bills.data?.version || null,
        debts_version: debts.data?.version || null
      }
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

async function readJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  const text = await res.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`non-json response from ${url}`);
  }

  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return body;
}

function unwrap(result, label) {
  if (result.status === "fulfilled") return { ok: true, data: result.value, error: null };
  return { ok: false, data: null, error: result.reason?.message || `${label} unavailable` };
}

function sourceStatus(source) {
  return {
    ok: source.ok,
    version: source.data?.version || null,
    error: source.error || null
  };
}

function normalizeBalances(payload) {
  if (!payload) {
    return { total_liquid: 0, accounts: {}, payable_debt: 0, receivable_debt: 0 };
  }

  const accounts = payload.accounts || {};
  const debt = payload.debt || payload.debts || {};
  const totals = payload.totals || {};

  return {
    total_liquid: number(payload.total_liquid ?? totals.total_liquid ?? payload.liquid_total),
    net_worth: number(payload.net_worth ?? totals.net_worth),
    true_burden: number(payload.true_burden ?? totals.true_burden),
    accounts,
    payable_debt: number(
      payload.debt_payable_remaining ??
      payload.payable_debt ??
      debt.payable_remaining ??
      debt.total_payable ??
      payload.total_payable
    ),
    receivable_debt: number(
      payload.debt_receivable_remaining ??
      payload.receivable_debt ??
      debt.receivable_remaining ??
      debt.total_receivable ??
      payload.total_receivable
    )
  };
}

function normalizeBills(payload, month) {
  const rows = Array.isArray(payload?.bills) ? payload.bills : [];

  const remaining = rows.reduce((sum, bill) => {
    return sum + number(bill.remaining_this_month ?? bill.remaining ?? bill.amount);
  }, 0);

  const paid = rows.reduce((sum, bill) => {
    return sum + number(bill.paid_this_month ?? 0);
  }, 0);

  return {
    month,
    count: rows.length,
    paid_this_month: round2(paid),
    remaining_this_month: round2(remaining)
  };
}

function normalizeDebts(payload) {
  const rows = Array.isArray(payload?.debts) ? payload.debts : [];

  let payable = number(payload?.total_payable ?? payload?.total_owe);
  let receivable = number(payload?.total_receivable ?? payload?.total_owed);

  if (!payable && !receivable && rows.length) {
    for (const debt of rows) {
      const status = String(debt.status || "active").toLowerCase();
      if (["archived", "deleted", "closed", "cancelled"].includes(status)) continue;

      const remaining = number(debt.remaining_amount ?? debt.outstanding_amount ?? debt.original_amount);
      const direction = String(debt.direction || debt.kind || "").toLowerCase();

      if (["owed_to_me", "owed", "receivable"].includes(direction)) {
        receivable += remaining;
      } else {
        payable += remaining;
      }
    }
  }

  return {
    source_count: rows.length,
    payable_remaining: round2(payable),
    receivable_remaining: round2(receivable)
  };
}

function normalizeCreditCard(payload) {
  if (!payload) {
    return { verified: false, outstanding: null, source: null, reason: "balances unavailable" };
  }

  const accounts = payload.accounts || {};
  const accountList = Array.isArray(accounts)
    ? accounts
    : Object.entries(accounts).map(([id, value]) => ({ id, ...(value || {}) }));

  const direct = accountList.find(account => {
    const id = String(account.id || "").toLowerCase();
    const type = String(account.type || "").toLowerCase();
    const kind = String(account.kind || "").toLowerCase();
    const name = String(account.name || "").toLowerCase();

    return id === "cc" || id.includes("credit") || type === "credit" || kind === "credit" || name.includes("credit card");
  });

  if (direct) {
    const rawBalance = number(direct.balance ?? direct.current_balance ?? direct.amount);
    return {
      verified: true,
      outstanding: round2(Math.abs(rawBalance)),
      account_id: direct.id || "cc",
      source: "/api/balances.accounts",
      raw_balance: rawBalance
    };
  }

  const explicit = payload.credit_card || payload.cc || payload.creditCard;

  if (explicit) {
    const outstanding = number(explicit.outstanding ?? explicit.balance ?? explicit.amount);
    return {
      verified: Number.isFinite(outstanding),
      outstanding: round2(Math.abs(outstanding)),
      account_id: explicit.account_id || explicit.id || "cc",
      source: "/api/balances.credit_card",
      raw_balance: outstanding
    };
  }

  const topLevel = payload.credit_card_outstanding ?? payload.cc_outstanding;

  if (topLevel !== undefined && topLevel !== null) {
    const outstanding = number(topLevel);
    return {
      verified: true,
      outstanding: round2(Math.abs(outstanding)),
      account_id: "cc",
      source: "/api/balances.credit_card_outstanding",
      raw_balance: outstanding
    };
  }

  return {
    verified: false,
    outstanding: null,
    account_id: null,
    source: null,
    reason: "No credit-card account/source found in balances payload"
  };
}

function readGuaranteedSalary(env) {
  const raw = env?.GUARANTEED_SALARY || env?.SF_GUARANTEED_SALARY || "0";
  return round2(number(raw));
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
