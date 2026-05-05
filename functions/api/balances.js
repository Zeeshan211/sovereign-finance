// /functions/api/balances.js
// v0.5.2 — Sheet reversal marker bridge for formula-layer active rows
//
// SOVEREIGN FINANCE — FORMULA SPEC
//
// Canonical D1 transaction types:
//   expense, income, transfer, cc_payment, cc_spend, borrow, repay, atm
//
// Sheet semantic mapping:
//   Income   -> income
//   Expense  -> expense
//   Transfer -> transfer
//   Debt In  -> borrow
//   Debt Out -> repay
//
// Account balance formula:
//   Balance(A) = income(A) + borrow(A) + opening(A)
//              - expense(A) - repay(A) - transfer(A)
//
// Active rows exclude:
//   1. D1-native reversals using reversed_by / reversed_at
//   2. Imported Sheet reversal markers in notes:
//      [REVERSED BY ...]
//      [REVERSAL OF ...]
//
// Top metrics:
//   Total Liquid = sum asset account balances, excluding credit card
//   Net Worth    = Total Liquid - CC Outstanding
//   True Burden  = Net Worth - Total Owed + Total Receivables

const VERSION = 'v0.5.2';

const TYPE_PLUS = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

function isReversalRow(t) {
  if (!t) return false;

  if (t.reversed_by || t.reversed_at) return true;

  const notes = String(t.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug') === '1';
  const warnings = [];

  try {
    const accountsResult = await env.DB.prepare(
      `SELECT id, name, type, kind, opening_balance, currency, color, status, credit_limit
       FROM accounts
       WHERE status = 'active'
       ORDER BY display_order, name`
    ).all();

    const accountRows = accountsResult.results || [];
    const balanceMap = {};
    const accountMeta = {};

    for (const a of accountRows) {
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

    const txnsResult = await env.DB.prepare(
      `SELECT id, account_id, transfer_to_account_id, amount, type, notes,
              fee_amount, pra_amount, reversed_by, reversed_at, linked_txn_id
       FROM transactions
       ORDER BY date ASC, created_at ASC`
    ).all();

    const allTxns = txnsResult.results || [];
    const activeTxns = allTxns.filter(t => !isReversalRow(t));
    const hiddenReversalCount = allTxns.length - activeTxns.length;

    let modernTransferCount = 0;
    let legacyTransferCount = 0;
    let modernTransferSum = 0;

    for (const t of activeTxns) {
      const amt = Number(t.amount) || 0;
      const fee = Number(t.fee_amount) || 0;
      const pra = Number(t.pra_amount) || 0;
      const acctId = t.account_id;
      const toAcctId = t.transfer_to_account_id;
      const type = String(t.type || '').toLowerCase();

      if (!(acctId in balanceMap)) continue;

      if ((type === 'transfer' || type === 'cc_payment') && toAcctId && (toAcctId in balanceMap)) {
        balanceMap[acctId] -= amt;
        balanceMap[toAcctId] += amt;

        modernTransferCount++;
        modernTransferSum += amt;

        if (fee) balanceMap[acctId] -= fee;
        if (pra) balanceMap[acctId] -= pra;

        continue;
      }

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

    let legacyTransferOutSum = 0;
    let legacyTransferInSum = 0;

    for (const t of activeTxns) {
      const type = String(t.type || '').toLowerCase();
      const notes = String(t.notes || '');

      if (type === 'transfer' && !t.transfer_to_account_id) {
        legacyTransferOutSum += Number(t.amount) || 0;
      } else if (type === 'income' && /\[linked:/i.test(notes) && /^From:/i.test(notes)) {
        legacyTransferInSum += Number(t.amount) || 0;
      }
    }

    if (Math.abs(legacyTransferOutSum - legacyTransferInSum) > 0.5) {
      warnings.push(
        'inv3_violation:transfer_out_sum=' +
          legacyTransferOutSum +
          ',in_leg_sum=' +
          legacyTransferInSum
      );
    }

    const accountBalances = {};

    for (const id of Object.keys(balanceMap)) {
      accountBalances[id] = {
        ...accountMeta[id],
        balance: round2(balanceMap[id])
      };
    }

    let totalLiquid = 0;
    let ccOutstanding = 0;

    for (const id of Object.keys(accountBalances)) {
      const a = accountBalances[id];
      const k = String(a.kind || a.type || '').toLowerCase();
      const isCC = k === 'cc' || k === 'credit' || k === 'credit_card';
      const isLiability = k === 'liability' || isCC;

      if (isCC) {
        ccOutstanding += Math.max(0, -a.balance);
      } else if (!isLiability) {
        totalLiquid += a.balance;
      }
    }

    let totalOwed = 0;
    let activeDebtCount = 0;
    let debtsError = null;

    try {
      const debts = await env.DB.prepare(
        `SELECT name, original_amount, paid_amount, status
         FROM debts
         WHERE status = 'active'`
      ).all();

      for (const d of debts.results || []) {
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

    let totalReceivables = 0;
    let openReceivableCount = 0;
    let receivablesError = null;

    try {
      const recv = await env.DB.prepare(
        `SELECT expected_amount, received_amount, status
         FROM receivables
         WHERE status = 'open'`
      ).all();

      for (const r of recv.results || []) {
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

    const totalLiquidR = round2(totalLiquid);
    const ccOutstandingR = round2(ccOutstanding);
    const totalOwedR = round2(totalOwed);
    const totalReceivablesR = round2(totalReceivables);

    const netWorth = round2(totalLiquidR - ccOutstandingR);
    const trueBurden = round2(netWorth - totalOwedR + totalReceivablesR);

    const responseBody = {
      ok: true,
      version: VERSION,

      total_liquid: totalLiquidR,
      net_worth: netWorth,
      true_burden: trueBurden,

      cc_outstanding: ccOutstandingR,
      total_owed: totalOwedR,
      total_receivables: totalReceivablesR,

      accounts: accountBalances,

      cash: totalLiquidR,
      cc: ccOutstandingR,
      total_assets: totalLiquidR,
      total_liabilities: round2(ccOutstandingR + totalOwedR),
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
        modern_transfer_sum: round2(modernTransferSum),
        legacy_transfer_out_count: legacyTransferCount,
        legacy_transfer_out_sum: round2(legacyTransferOutSum),
        legacy_transfer_in_sum: round2(legacyTransferInSum),
        in_out_diff: round2(legacyTransferOutSum - legacyTransferInSum),

        txn_count: allTxns.length,
        active_txn_count: activeTxns.length,
        hidden_reversal_count: hiddenReversalCount,

        account_count: accountRows.length,
        active_debt_count: activeDebtCount,
        open_receivable_count: openReceivableCount,

        debts_error: debtsError,
        receivables_error: receivablesError,

        spec_version: 'v0.5.2',
        formula: 'true_burden = (liquid - cc_outstanding) - total_owed + total_receivables',
        canonical_vocab: 'D1 transactions.type CHECK constraint',
        reversal_bridge: 'reversed_by/reversed_at columns plus Sheet notes markers'
      };
    }

    return new Response(JSON.stringify(responseBody), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      version: VERSION,
      error: err.message,
      stack: debug ? err.stack : undefined
    }), {
      status: 500,
      headers: {
        'content-type': 'application/json'
      }
    });
  }
}
