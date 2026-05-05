// /functions/api/balances.js
// v0.4.8 - CRITICAL: fix borrow/repay sign semantics
// Changes vs v0.4.7:
//   - FIX: 'borrow' is money INTO account (loan received) — was subtracting, now ADDS
//   - FIX: 'repay' is money OUT of account (debt installment paid) — was adding, now SUBTRACTS
//   - Sheet convention: borrow = inflow when YOU borrow; repay = outflow when YOU pay debt
//   - Single bug accounts for ~Rs 200k UBL + ~Rs 220k Meezan inflation vs sheet
//   - VERSION bumped from v0.4.7 -> v0.4.8

const VERSION = 'v0.4.8';

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug') === '1';

  try {
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

    const txns = await env.DB.prepare(
      `SELECT id, account_id, transfer_to_account_id, amount, type, notes,
              fee_amount, pra_amount
       FROM transactions
       ORDER BY date ASC, created_at ASC`
    ).all();

    let modernTransferCount = 0;
    let legacyTransferCount = 0;

    for (const t of txns.results) {
      const amt = Number(t.amount) || 0;
      const fee = Number(t.fee_amount) || 0;
      const pra = Number(t.pra_amount) || 0;
      const acctId = t.account_id;
      const toAcctId = t.transfer_to_account_id;

      if (!(acctId in balanceMap)) continue;

      switch (t.type) {
        case 'expense':
        case 'cc_spend':
        case 'repay':
        case 'atm':
          balanceMap[acctId] -= amt;
          if (fee) balanceMap[acctId] -= fee;
          if (pra) balanceMap[acctId] -= pra;
          break;

        case 'income':
        case 'salary':
        case 'borrow':
          balanceMap[acctId] += amt;
          break;

        case 'cc_payment':
          balanceMap[acctId] -= amt;
          if (toAcctId && (toAcctId in balanceMap)) {
            balanceMap[toAcctId] += amt;
          }
          break;

        case 'transfer':
          if (toAcctId && (toAcctId in balanceMap)) {
            balanceMap[acctId] -= amt;
            balanceMap[toAcctId] += amt;
            modernTransferCount++;
          } else {
            const notes = t.notes || '';
            const isInLeg = /(^|\s)From: /.test(notes) || /\(IN\)/.test(notes);
            if (isInLeg) {
              balanceMap[acctId] += amt;
            } else {
              balanceMap[acctId] -= amt;
            }
            legacyTransferCount++;
          }
          break;

        default:
          if (debug) {
            console.log('[balances] unknown type:', t.type, 'txn:', t.id);
          }
          break;
      }
    }

    const accountBalances = {};
    for (const id of Object.keys(balanceMap)) {
      accountBalances[id] = {
        ...accountMeta[id],
        balance: Math.round(balanceMap[id] * 100) / 100
      };
    }

    let totalAssets = 0;
    let totalLiabilities = 0;
    let cashAccessible = 0;
    let ccOutstanding = 0;

    for (const id of Object.keys(accountBalances)) {
      const a = accountBalances[id];
      const k = (a.kind || a.type || '').toLowerCase();
      if (k === 'liability' || k === 'cc' || k === 'credit' || k === 'credit_card') {
        const owed = Math.abs(Math.min(0, a.balance));
        totalLiabilities += owed;
        if (k === 'cc' || k === 'credit' || k === 'credit_card') ccOutstanding += owed;
      } else {
        totalAssets += a.balance;
        if (k === 'cash' || k === 'bank' || k === 'wallet' || k === 'asset') {
          cashAccessible += a.balance;
        }
      }
    }

    let totalDebts = 0;
    let debtCount = 0;
    let debtsError = null;
    try {
      const debts = await env.DB.prepare(
        `SELECT name, original_amount, paid_amount, status
         FROM debts
         WHERE status = 'active'`
      ).all();
      for (const d of (debts.results || [])) {
        const orig = Number(d.original_amount) || 0;
        const paid = Number(d.paid_amount) || 0;
        const outstanding = orig - paid;
        if (outstanding > 0) {
          totalDebts += outstanding;
          debtCount++;
        }
      }
    } catch (e) {
      debtsError = e.message;
    }

    const netWorth = Math.round((totalAssets - totalLiabilities - totalDebts) * 100) / 100;

    const responseBody = {
      ok: true,
      version: VERSION,
      net_worth: netWorth,
      total_assets: Math.round(totalAssets * 100) / 100,
      total_liabilities: Math.round(totalLiabilities * 100) / 100,
      total_debts: Math.round(totalDebts * 100) / 100,
      total_owe: Math.round(totalDebts * 100) / 100,
      cash_accessible: Math.round(cashAccessible * 100) / 100,
      total_liquid_assets: Math.round(cashAccessible * 100) / 100,
      cc_outstanding: Math.round(ccOutstanding * 100) / 100,
      accounts: accountBalances,
      cash: Math.round(cashAccessible * 100) / 100,
      cc: Math.round(ccOutstanding * 100) / 100,
      generated_at: new Date().toISOString()
    };

    if (debug) {
      responseBody.debug = {
        modern_transfer_count: modernTransferCount,
        legacy_transfer_count: legacyTransferCount,
        txn_count: txns.results.length,
        account_count: accounts.results.length,
        active_debt_count: debtCount,
        debts_error: debtsError
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
