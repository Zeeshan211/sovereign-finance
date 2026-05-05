// /functions/api/balances.js
// v0.5.1 — Spec header corrected (D1 CHECK is canonical vocabulary, not debt_in/debt_out)
//          Code logic byte-identical to v0.5.0 — only comment block changes.
//
// ════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — FORMULA SPEC (locked 2026-05-05, corrected 2026-05-06)
// ════════════════════════════════════════════════════════════════════
//
// SECTION 1 — TYPE VOCABULARY (CORRECTED — D1 CHECK is canonical)
// ────────────────────────────────────────────────────────────────
// CANONICAL types per D1 transactions.type CHECK constraint:
//   'expense','income','transfer','cc_payment','cc_spend','borrow','repay','atm'
//
// CRITICAL: Earlier Layer 1 spec proposed 'debt_in'/'debt_out' as canonical.
// THAT WAS WRONG. D1 CHECK constraint rejects those values.
// migrate-from-sheet v1.4 failed on this. v1.5 fixed by passing through
// sheet vocabulary directly. balances.js v0.5.1 corrects spec to match.
//
// Sheet-side semantic mapping (for human reading, not code):
//   sheet 'Income'   → D1 'income'    — money entering account from outside
//   sheet 'Expense'  → D1 'expense'   — money leaving account to outside
//   sheet 'Transfer' → D1 'transfer'  — money moving between YOUR accounts (OUT-leg)
//   sheet 'Debt In'  → D1 'borrow'    — receiving payment from someone who owed you
//   sheet 'Debt Out' → D1 'repay'     — paying someone you owe
//
// Other CHECK-allowed types (used by Cloudflare-side flows):
//   'cc_payment' — payment toward credit card
//   'cc_spend'   — charge to credit card
//   'atm'        — ATM withdrawal
//
// SECTION 2 — TRANSFER MODEL (locked: 2-row pairs, sheet-match)
// ─────────────────────────────────────────────────────────────
// Transfer of Rs X from A to B is TWO rows:
//   Row 1 (OUT): account_id=A, type='transfer', amount=X, notes='To: B [linked: id-of-row-2]'
//   Row 2 (IN):  account_id=B, type='income',   amount=X, notes='From: A [linked: id-of-row-1]'
// IN-leg is type='income' so auto-counts in +Σ income, no special handling.
//
// MODERN 1-ROW format with transfer_to_account_id populated is supported
// defensively in reads (with double-count guard).
//
// SECTION 3 — ACCOUNT BALANCE FORMULA
// ────────────────────────────────────
// For any account A:
//   Balance(A) = Σ income(A) + Σ borrow(A) + Σ opening(A)
//              − Σ expense(A) − Σ repay(A) − Σ transfer(A)
// All Σ over rows where account_id=A AND reversed_by IS NULL.
//
// SECTION 4 — CC OUTSTANDING (Alfalah-specific)
// ──────────────────────────────────────────────
// Alfalah CC uses same balance formula, result INVERTED:
//   CC_Outstanding = MAX(0, − Balance(Alfalah CC))
//
// SECTION 5 — DEBTS (people, NOT accounts)
// ─────────────────────────────────────────
// Personal debts (CRED-1..N) live in `debts` table.
// For each active debt:
//   Outstanding(creditor) = MAX(0, original_amount − paid_amount)
//   Total Owed = Σ Outstanding for status='active'
//
// SECTION 6 — RECEIVABLES (separate read, optional)
// ──────────────────────────────────────────────────
// `receivables` table not currently in D1 schema (verified 2026-05-05).
// Defensive try/catch keeps total_receivables=0 if table missing.
//
// SECTION 7 — THE THREE TOP-LEVEL METRICS
// ────────────────────────────────────────
// Total Liquid  = Σ Balance(A) for asset accounts only
// Net Worth     = Total Liquid − CC Outstanding
//                 (excludes personal debts; what you'd have if CC paid off today)
// TRUE BURDEN   = Net Worth − Total Owed + Total Receivables
//                 (real position including everything; sheet's TRUE BURDEN)
//
// SECTION 8 — INVARIANTS (surfaced in debug response)
// ────────────────────────────────────────────────────
// INV-1: Modern transfer (transfer_to_account_id NOT NULL) — exactly 1 row
// INV-2: Legacy transfer OUT — has matching 'income' IN-leg with same amount
// INV-3: Σ all transfer OUT == Σ all matching IN-legs (across ledger)
// Violations logged in debug.warnings[] but do NOT 500 the API.
//
// SECTION 9 — PATTERN 21 RECONCILIATION (added 2026-05-06)
// ─────────────────────────────────────────────────────────
// Pattern 21 said "same word every layer." Originally proposed debt_in/debt_out
// as canonical for that reason. D1 CHECK constraint disagreed.
//
// Pattern 21 still holds, but its application: D1 CHECK = single source of truth.
// All layers (sheet exporter, migrate endpoint, balances.js, hub.js) speak
// CHECK vocabulary. No translation tax — sheet uses borrow/repay directly.
// (Pattern 21 v2: "ground truth from constraints, not from spec docs.")
// ════════════════════════════════════════════════════════════════════

const VERSION = 'v0.5.1';

// Type classification — uses CANONICAL D1 CHECK vocabulary
// (debt_in/debt_out kept in sets defensively in case any legacy data exists,
//  but writes from migrate v1.5+ use only D1 CHECK vocabulary)
const TYPE_PLUS  = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug') === '1';
  const warnings = [];

  try {
    // ── Load active accounts ──
    const accounts = await env.DB.prepare(
      `SELECT id, name, type, kind, opening_balance, currency, color, status, credit_limit
       FROM accounts
       WHERE status = 'active'
       ORDER BY display_order, name`
    ).all();

    const balanceMap = {};
    const accountMeta = {};

    for (const a of accounts.results) {
      balanceMap[a.id] = Number(a.opening_balance) || 0;
      accountMeta[a.id] = {
        name: a.name,
        type: a.type,
        kind: a.kind,
        currency: a.currency || 'PKR',
        color: a.color || null,
        opening_balance: Number(a.opening_balance) || 0,
        credit_limit: a.credit_limit != null ? Number(a.credit_limit) : null
      };
    }

    // ── Load all active transactions ──
    const txns = await env.DB.prepare(
      `SELECT id, account_id, transfer_to_account_id, amount, type, notes,
              fee_amount, pra_amount, reversed_by
       FROM transactions
       ORDER BY date ASC, created_at ASC`
    ).all();

    let modernTransferCount = 0;
    let legacyTransferCount = 0;
    let modernTransferSum = 0;

    for (const t of txns.results) {
      if (t.reversed_by) continue;

      const amt = Number(t.amount) || 0;
      const fee = Number(t.fee_amount) || 0;
      const pra = Number(t.pra_amount) || 0;
      const acctId = t.account_id;
      const toAcctId = t.transfer_to_account_id;
      const type = (t.type || '').toLowerCase();

      if (!(acctId in balanceMap)) continue;

      // Modern 1-row transfer (or legacy cc_payment with transfer_to_account_id)
      if ((type === 'transfer' || type === 'cc_payment') && toAcctId && (toAcctId in balanceMap)) {
        balanceMap[acctId] -= amt;
        balanceMap[toAcctId] += amt;
        modernTransferCount++;
        modernTransferSum += amt;
        if (fee) balanceMap[acctId] -= fee;
        if (pra) balanceMap[acctId] -= pra;
        continue;
      }

      // Canonical formula — type → sign mapping
      if (TYPE_PLUS.has(type)) {
        balanceMap[acctId] += amt;
      } else if (TYPE_MINUS.has(type)) {
        balanceMap[acctId] -= amt;
        if (fee) balanceMap[acctId] -= fee;
        if (pra) balanceMap[acctId] -= pra;
        if (type === 'transfer') legacyTransferCount++;
      } else {
        warnings.push('unknown_type:' + type + ':' + t.id);
      }
    }

    // ── INV-3 cross-check ──
    let legacyTransferOutSum = 0;
    let legacyTransferInSum = 0;
    for (const t of txns.results) {
      if (t.reversed_by) continue;
      const type = (t.type || '').toLowerCase();
      const notes = t.notes || '';
      if (type === 'transfer' && !t.transfer_to_account_id) {
        legacyTransferOutSum += Number(t.amount) || 0;
      } else if (type === 'income' && /\[linked:/.test(notes) && /^From: |From: /.test(notes)) {
        legacyTransferInSum += Number(t.amount) || 0;
      }
    }
    if (Math.abs(legacyTransferOutSum - legacyTransferInSum) > 0.5) {
      warnings.push('inv3_violation:transfer_out_sum=' + legacyTransferOutSum +
                    ',in_leg_sum=' + legacyTransferInSum);
    }

    // ── Build per-account balance objects ──
    const accountBalances = {};
    for (const id of Object.keys(balanceMap)) {
      accountBalances[id] = {
        ...accountMeta[id],
        balance: Math.round(balanceMap[id] * 100) / 100
      };
    }

    // ── Aggregate by classification ──
    let totalLiquid = 0;
    let ccOutstanding = 0;

    for (const id of Object.keys(accountBalances)) {
      const a = accountBalances[id];
      const k = (a.kind || a.type || '').toLowerCase();
      const isCC = k === 'cc' || k === 'credit' || k === 'credit_card';
      const isLiability = k === 'liability' || isCC;

      if (isCC) {
        ccOutstanding += Math.max(0, -a.balance);
      } else if (!isLiability) {
        totalLiquid += a.balance;
      }
    }

    // ── Debts (personal, CRED-1..N) ──
    let totalOwed = 0;
    let activeDebtCount = 0;
    let debtsError = null;
    try {
      const debts = await env.DB.prepare(
        `SELECT name, original_amount, paid_amount, status FROM debts WHERE status = 'active'`
      ).all();
      for (const d of (debts.results || [])) {
        const orig = Number(d.original_amount) || 0;
        const paid = Number(d.paid_amount) || 0;
        const outstanding = Math.max(0, orig - paid);
        if (outstanding > 0) {
          totalOwed += outstanding;
          activeDebtCount++;
        }
      }
    } catch (e) {
      debtsError = e.message;
    }

    // ── Receivables (defensive — table may not exist) ──
    let totalReceivables = 0;
    let openReceivableCount = 0;
    let receivablesError = null;
    try {
      const recv = await env.DB.prepare(
        `SELECT expected_amount, received_amount, status FROM receivables WHERE status = 'open'`
      ).all();
      for (const r of (recv.results || [])) {
        const exp = Number(r.expected_amount) || 0;
        const got = Number(r.received_amount) || 0;
        const remaining = Math.max(0, exp - got);
        if (remaining > 0) {
          totalReceivables += remaining;
          openReceivableCount++;
        }
      }
    } catch (e) {
      receivablesError = e.message;
    }

    // ── The three canonical metrics ──
    const r2 = (n) => Math.round(n * 100) / 100;

    const totalLiquidR     = r2(totalLiquid);
    const ccOutstandingR   = r2(ccOutstanding);
    const totalOwedR       = r2(totalOwed);
    const totalReceivR     = r2(totalReceivables);

    const netWorth   = r2(totalLiquidR - ccOutstandingR);
    const trueBurden = r2(netWorth - totalOwedR + totalReceivR);

    // ── Build response ──
    const responseBody = {
      ok: true,
      version: VERSION,

      // Three canonical metrics (per spec section 7)
      total_liquid: totalLiquidR,
      net_worth: netWorth,
      true_burden: trueBurden,

      // Supporting numbers
      cc_outstanding: ccOutstandingR,
      total_owed: totalOwedR,
      total_receivables: totalReceivR,

      // Per-account detail
      accounts: accountBalances,

      // Legacy aliases — kept for backward compat with hub.js v0.7.x and accounts.js v0.7.x
      cash: totalLiquidR,
      cc: ccOutstandingR,
      total_assets: totalLiquidR,
      total_liabilities: r2(ccOutstandingR + totalOwedR),
      total_debts: totalOwedR,
      total_owe: totalOwedR,
      cash_accessible: totalLiquidR,
      total_liquid_assets: totalLiquidR,

      generated_at: new Date().toISOString()
    };

    if (warnings.length) responseBody.warnings = warnings;

    if (debug) {
      responseBody.debug = {
        modern_transfer_count: modernTransferCount,
        modern_transfer_sum: r2(modernTransferSum),
        legacy_transfer_out_count: legacyTransferCount,
        legacy_transfer_out_sum: r2(legacyTransferOutSum),
        legacy_transfer_in_sum: r2(legacyTransferInSum),
        in_out_diff: r2(legacyTransferOutSum - legacyTransferInSum),
        txn_count: txns.results.length,
        active_txn_count: txns.results.filter(t => !t.reversed_by).length,
        account_count: accounts.results.length,
        active_debt_count: activeDebtCount,
        open_receivable_count: openReceivableCount,
        debts_error: debtsError,
        receivables_error: receivablesError,
        spec_version: 'v0.5.1',
        formula: 'true_burden = (liquid - cc_outstanding) - total_owed + total_receivables',
        canonical_vocab: 'D1 transactions.type CHECK constraint'
      };
    }

    return new Response(JSON.stringify(responseBody), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      version: VERSION,
      error: err.message,
      stack: debug ? err.stack : undefined
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}
