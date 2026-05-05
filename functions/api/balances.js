/* ─── /api/balances · v0.4.2 · Sub-1D-DEBT-TOTAL ground-truth fix ─── */
/* Cloudflare Pages Function — liability-aware transfer math + debt totals */
/*
 * Changes vs v0.4.1:
 *   - Used PRAGMA table_info(debts) ground truth from D1 console.
 *   - Real columns: original_amount, paid_amount, status (default 'active'). 
 *     No `outstanding` column, no `closed_at` column.
 *   - Outstanding computed as (original_amount - paid_amount).
 *   - Filter on status = 'active' to count only active debts.
 *   - Pattern 7 violated TWICE in this ship arc (v0.4.0 + v0.4.1) — codified
 *     mandatory schema-read rule in memory after second failure.
 *
 * PRESERVED from v0.4.1:
 *   - total_debts + total_owe + debt_count fields
 *   - net_worth = assets - liabilities - debts
 *   - All v0.3.1 + v0.3.0 logic (FIELD-RECONCILE alias, CC-RECONCILE math)
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

    // Fetch active debts — Sub-1D-DEBT-TOTAL (ground-truth schema)
    // Real columns: original_amount, paid_amount, status (default 'active')
    // Outstanding = original_amount - paid_amount
    const debtsStmt = db.prepare(
      "SELECT (original_amount - COALESCE(paid_amount, 0)) AS outstanding FROM debts WHERE status = 'active'"
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

    // Roll up debts side
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
