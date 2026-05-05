/* ─── /api/balances · v0.4.0 · Sub-1D-DEBT-TOTAL ─── */
/* Cloudflare Pages Function — liability-aware transfer math + debt totals */
/*
 * Changes vs v0.3.1:
 *   - Added `total_debts` field (SUM of debts.outstanding from debts table)
 *   - Added `total_owe` field (alias of total_debts for store.js compat)
 *   - Added `debt_count` for hub widget display
 *   - store.js reads `d.total_owe || d.total_debts` — both now defined
 *   - Debts table is separate from liabilities (which are CC-style accounts).
 *     Debts represent IOUs to specific people/entities (CRED-1 through CRED-6 + DEBT-1).
 *
 * PRESERVED from v0.3.1:
 *   - total_liquid_assets alias (Sub-1D-FIELD-RECONCILE)
 *   - Liability-aware transfer math (Sub-1D-CC-RECONCILE)
 *   - All type handlers
 *   - Roll-up logic + cc_outstanding
 *   - Error shape
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

    // Fetch debts (outstanding only) — Sub-1D-DEBT-TOTAL
    const debtsStmt = db.prepare(
      "SELECT outstanding FROM debts WHERE status != 'closed' OR status IS NULL"
    );
    const debtsResult = await debtsStmt.all();
    const debtRows = debtsResult.results;

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
        balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
      } else if (tx.type === 'borrow') {
        balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
      } else if (tx.type === 'transfer') {
        const srcType = acctType[tx.account_id];
        if (srcType === 'liability') {
          balances[tx.account_id] = (balances[tx.account_id] || 0) + amt;
        } else {
          balances[tx.account_id] = (balances[tx.account_id] || 0) - amt;
        }
        if (tx.transfer_to_account_id) {
          const dstType = acctType[tx.transfer_to_account_id];
          if (dstType === 'liability') {
            balances[tx.transfer_to_account_id] = (balances[tx.transfer_to_account_id] || 0) - amt;
          } else {
            balances[tx.transfer_to_account_id] = (balances[tx.transfer_to_account_id] || 0) + amt;
          }
        }
      }
    });

    // Roll up totals (accounts side)
    let totalAssets = 0;
    let totalLiabilities = 0;
    accounts.forEach(a => {
      const b = balances[a.id] || 0;
      if (a.type === 'asset') totalAssets += b;
      else if (a.type === 'liability') totalLiabilities += b;
    });

    // Roll up debts side — Sub-1D-DEBT-TOTAL
    let totalDebts = 0;
    debtRows.forEach(d => {
      totalDebts += (d.outstanding || 0);
    });

    const netWorth = totalAssets - totalLiabilities - totalDebts;

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
      total_debts: Math.round(totalDebts * 100) / 100,
      total_owe: Math.round(totalDebts * 100) / 100,
      cc_outstanding: Math.round((balances['cc'] || 0) * 100) / 100,
      account_count: accounts.length,
      debt_count: debtRows.length,
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
