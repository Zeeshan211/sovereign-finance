// /functions/api/balances.js
// v0.4.5 - Fix modern transfer balance handling (transfer_to_account_id was never read)
// Changes vs v0.4.4:
//   - Modern transfer (transfer_to_account_id NOT NULL): subtract from account_id, ADD to transfer_to_account_id
//   - Legacy transfer (transfer_to_account_id IS NULL): unchanged single-leg behavior
//   - All other types unchanged
//   - VERSION bumped from v0.4.4 -> v0.4.5

const VERSION = 'v0.4.5';

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug') === '1';

  try {
    const accounts = await env.DB.prepare(
      `SELECT id, name, type, opening_balance, currency, is_active
       FROM accounts
       WHERE is_active = 1
       ORDER BY display_order, name`
    ).all();

    const balanceMap = {};
    const accountMeta = {};

    for (const a of accounts.results) {
      balanceMap[a.id] = Number(a.opening_balance) || 0;
      accountMeta[a.id] = {
        name: a.name,
        type: a.type,
        currency: a.currency || 'PKR',
        opening_balance: Number(a.opening_balance) || 0
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
        case 'borrow':
        case 'atm':
          balanceMap[acctId] -= amt;
          if (fee) balanceMap[acctId] -= fee;
          if (pra) balanceMap[acctId] -= pra;
          break;

        case 'income':
        case 'salary':
        case 'repay':
          balanceMap[acctId] += amt;
          break;

        case 'cc_payment':
          // Cash out from source account
          balanceMap[acctId] -= amt;
          // Reduce CC balance (which is liability tracked as negative; reducing means += amt back toward 0)
          // We rely on legacy convention where CC accounts have their own row identification by name.
          // If transfer_to_account_id is set, treat it as an explicit destination (modern format).
          if (toAcctId && (toAcctId in balanceMap)) {
            balanceMap[toAcctId] += amt;
          }
          break;

        case 'transfer':
          if (toAcctId && (toAcctId in balanceMap)) {
            // Modern single-row transfer: atomic OUT + IN
            balanceMap[acctId] -= amt;
            balanceMap[toAcctId] += amt;
            modernTransferCount++;
          } else {
            // Legacy 2-row transfer: each row is independent leg
            // OUT-leg convention (notes contain "To:" or no IN marker): subtract
            // IN-leg convention (notes contain "From:" or "(IN)"): add
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
          // Unknown type - no balance change, log if debug
          if (debug) {
            console.log('[balances] unknown type:', t.type, 'txn:', t.id);
          }
          break;
      }
    }

    // Compute aggregates
    const accountBalances = {};
    for (const id of Object.keys(balanceMap)) {
      accountBalances[id] = {
        ...accountMeta[id],
        balance: Math.round(balanceMap[id] * 100) / 100
      };
    }

    // Net worth: sum of all asset accounts minus sum of liability accounts
    let totalAssets = 0;
    let totalLiabilities = 0;
    let cashAccessible = 0;
    let ccOutstanding = 0;

    for (const id of Object.keys(accountBalances)) {
      const a = accountBalances[id];
      if (a.type === 'liability' || a.type === 'cc') {
        // Liabilities tracked as negative balance accumulator means amount owed
        // Convention: CC outstanding shown as positive number representing debt
        const owed = Math.abs(Math.min(0, a.balance));
        totalLiabilities += owed;
        if (a.type === 'cc') ccOutstanding += owed;
      } else {
        totalAssets += a.balance;
        if (a.type === 'cash' || a.type === 'bank' || a.type === 'wallet') {
          cashAccessible += a.balance;
        }
      }
    }

    const netWorth = Math.round((totalAssets - totalLiabilities) * 100) / 100;

    const responseBody = {
      ok: true,
      version: VERSION,
      net_worth: netWorth,
      total_assets: Math.round(totalAssets * 100) / 100,
      total_liabilities: Math.round(totalLiabilities * 100) / 100,
      cash_accessible: Math.round(cashAccessible * 100) / 100,
      cc_outstanding: Math.round(ccOutstanding * 100) / 100,
      accounts: accountBalances,
      // legacy fields kept for backward compat with hub.js v0.7.7 and earlier
      cash: Math.round(cashAccessible * 100) / 100,
      cc: Math.round(ccOutstanding * 100) / 100,
      generated_at: new Date().toISOString()
    };

    if (debug) {
      responseBody.debug = {
        modern_transfer_count: modernTransferCount,
        legacy_transfer_count: legacyTransferCount,
        txn_count: txns.results.length,
        account_count: accounts.results.length
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
