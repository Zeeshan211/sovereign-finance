/* ─── /api/balances · v0.3.1 · Sub-1D-FIELD-RECONCILE ─── */
/* Cloudflare Pages Function — liability-aware transfer math */
/*
 * Changes vs v0.3.0:
 *   - Added `total_liquid_assets` field to response (alias of total_assets for now).
 *   - store.js reads d.total_liquid_assets — was undefined before this ship.
 *   - When fixed-deposit / investment account types are introduced later,
 *     total_liquid_assets will diverge from total_assets (liquid excludes those).
 *   - Both fields returned for backward + forward compat.
 *
 * PRESERVED from v0.3.0:
 *   - Liability-aware transfer math (Sub-1D-CC-RECONCILE)
 *   - All type handlers (income, expense, cc_spend, cc_payment, repay, atm, borrow, transfer)
 *   - Roll-up logic (totalAssets, totalLiabilities, netWorth)
 *   - cc_outstanding direct from balances['cc']
 *   - Error shape (status 500 on throw)
 */

export async function onRequest(context) {
  try {
    const db = context.env.DB;

    // Fetch accounts
    const accountsStmt = db.prepare(
      'SELECT id, name, icon, type, kind, opening_balance, display_order FROM accounts ORDER BY display_order'
    );
    const accountsResult = await accountsStmt.all();
    const accounts = accountsResult.results;

    // Build a fast lookup table for account type (asset vs liability)
    const acctType = {};
    accounts.forEach(a => { acctType[a.id] = a.type; });

    // Fetch all transactions
    const txStmt = db.prepare(
      'SELECT type, amount, account_id, transfer_to_account_id FROM transactions'
    );
    const txResult = await txStmt.all();
    const transactions = txResult.results;

    // Compute per-account balance
    const balances = {};
    accounts.forEach(a => { balances[a.id] = a.opening_balance || 0; });

    transactions.forEach(tx => {
      const amt = tx.amount || 0;
      if (tx.type === 'income') {
        balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
      } else if (tx.type === 'expense' || tx.type === 'cc_payment' || tx.type === 'repay' || tx.type === 'atm') {
        balances[tx.account_id] = (balances[tx.account_id] || 0) - amt;
      } else if (tx.type === 'cc_spend') {
        // Spending on CC = liability balance grows
        balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
      } else if (tx.type === 'borrow') {
        // Borrowing = asset increases
        balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
      } else if (tx.type === 'transfer') {
        // ── Sub-1D-CC-RECONCILE: liability-aware double-entry ──
        // Source side
        const srcType = acctType[tx.account_id];
        if (srcType === 'liability') {
          // Drawing from a liability (cash advance, BT out) → liability grows
          balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
        } else {
          // Asset source (default) → asset depletes
          balances[tx.account_id] = (balances[tx.account_id] || 0) - amt;
        }
        // Destination side (only if specified)
        if (tx.transfer_to_account_id) {
          const dstType = acctType[tx.transfer_to_account_id];
          if (dstType === 'liability') {
            // Paying down a liability (CC payment, debt paydown) → liability shrinks
            balances[tx.transfer_to_account_id] = (balances[tx.transfer_to_account_id] || 0) - amt;
          } else {
            // Asset dest (default) → asset grows
            balances[tx.transfer_to_account_id] = (balances[tx.transfer_to_account_id] || 0) + amt;
          }
        }
      }
    });

    // Roll up totals
    let totalAssets = 0;
    let totalLiabilities = 0;
    accounts.forEach(a => {
      const b = balances[a.id] || 0;
      if (a.type === 'asset') totalAssets += b;
      else if (a.type === 'liability') totalLiabilities += b;
    });

    const netWorth = totalAssets - totalLiabilities;

    // Account list with live balances
    const accountsWithBalances = accounts.map(a => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      type: a.type,
      kind: a.kind,
      display_order: a.display_order,
      balance: Math.round((balances[a.id] || 0) * 100) / 100
    }));

    return new Response(JSON.stringify({
      ok: true,
      net_worth: Math.round(netWorth * 100) / 100,
      total_assets: Math.round(totalAssets * 100) / 100,
      total_liquid_assets: Math.round(totalAssets * 100) / 100,
      total_liabilities: Math.round(totalLiabilities * 100) / 100,
      cc_outstanding: Math.round((balances['cc'] || 0) * 100) / 100,
      account_count: accounts.length,
      accounts: accountsWithBalances
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
