/* ─── /api/balances · v0.2.0 · Sub-1D-3-RESHIP ─── */
/* CHANGES from v0.1.0:
 *   - Skips IN-half of transfer pairs (rows with type='income' + category_id='transfer' + linked_txn_id)
 *     Previously double-counted destination on every new pair-style transfer
 *   - Skips reverse-of-IN-half (type='expense' + category_id='transfer' + notes starting "REVERSAL of ")
 *   - Active debts roll-up included for total_owe (was missing — frontend was getting 0)
 *   - Cache: no-cache header preserved
 */

export async function onRequest(context) {
  try {
    const db = context.env.DB;

    /* ── Accounts ── */
    const accountsResult = await db.prepare(
      'SELECT id, name, icon, type, kind, opening_balance, display_order FROM accounts ORDER BY display_order'
    ).all();
    const accounts = accountsResult.results;

    /* ── Transactions ── */
    const txResult = await db.prepare(
      `SELECT id, type, amount, account_id, transfer_to_account_id,
              category_id, notes, linked_txn_id, reversed_by
       FROM transactions`
    ).all();
    const transactions = txResult.results;

    /* ── Balance computation ── */
    const balances = {};
    accounts.forEach(a => { balances[a.id] = a.opening_balance || 0; });

    function isTransferInHalf(t) {
      return t.type === 'income'
        && t.category_id === 'transfer'
        && t.linked_txn_id;
    }
    function isReverseOfTransferInHalf(t) {
      return t.type === 'expense'
        && t.category_id === 'transfer'
        && t.notes && String(t.notes).startsWith('REVERSAL of ');
    }

    transactions.forEach(tx => {
      if (isTransferInHalf(tx)) return;
      if (isReverseOfTransferInHalf(tx)) return;

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
        balances[tx.account_id] = (balances[tx.account_id] || 0) - amt;
        if (tx.transfer_to_account_id) {
          balances[tx.transfer_to_account_id] = (balances[tx.transfer_to_account_id] || 0) + amt;
        }
      }
    });

    /* ── Roll-up totals ── */
    let totalAssets = 0;
    let totalLiabilities = 0;
    accounts.forEach(a => {
      const b = balances[a.id] || 0;
      if (a.type === 'asset') totalAssets += b;
      else if (a.type === 'liability') totalLiabilities += b;
    });
    const netWorth = totalAssets - totalLiabilities;

    const totalLiquid = accounts
      .filter(a => a.type === 'asset')
      .reduce((s, a) => s + (balances[a.id] || 0), 0);

    /* ── Personal debts roll-up (active, kind='owe') ── */
    let totalOwe = 0;
    try {
      const debtsRes = await db.prepare(
        `SELECT original_amount, paid_amount FROM debts WHERE status='active' AND kind='owe'`
      ).all();
      (debtsRes.results || []).forEach(d => {
        totalOwe += Math.max(0, (d.original_amount || 0) - (d.paid_amount || 0));
      });
    } catch (e) { /* non-fatal */ }

    /* ── Account list with live balances ── */
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
      total_liabilities: Math.round(totalLiabilities * 100) / 100,
      total_liquid_assets: Math.round(totalLiquid * 100) / 100,
      cc_outstanding: Math.round((balances['cc'] || 0) * 100) / 100,
      total_owe: Math.round(totalOwe * 100) / 100,
      total_debts: Math.round(totalOwe * 100) / 100,
      account_count: accounts.length,
      accounts: accountsWithBalances
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
