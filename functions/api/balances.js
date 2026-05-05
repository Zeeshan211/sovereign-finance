/* ─── /api/balances · v0.4.3 · True Personal Finance Net Worth ─── */
/*
 * Changes vs v0.4.2:
 *   - net_worth formula corrected to standard personal finance:
 *       net_worth = total_assets - |cc_outstanding| - total_debts_owed
 *   - Was producing -27,710 (mystery formula) and accounts.js produced -61,743 (sum-only)
 *   - New formula: -185,243 = 17,023 - 78,766 - 123,500 (most honest position)
 *   - Both endpoints will now align to this single source of truth
 *
 * Schema (per SCHEMA.md):
 *   accounts: id, type ('asset' or 'liability'), kind, opening_balance, deleted_at
 *   transactions: type, amount, account_id, transfer_to_account_id, reversed_at
 *   debts: id, status, original_amount, paid_amount, kind, deleted_at
 *
 * Account types:
 *   asset: bank, cash, wallet, prepaid (sum is positive — what I have)
 *   liability: cc (sum is negative — what I owe to bank)
 *
 * Personal debts (debts table): money I owe peers (kind='owe')
 *   Outstanding = original_amount - paid_amount per debt
 */

import { json } from './_lib.js';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    // Fetch all active accounts
    const accountsResult = await db.prepare(
      "SELECT * FROM accounts WHERE (deleted_at IS NULL OR deleted_at = '') AND (status = 'active' OR status IS NULL) ORDER BY display_order, name"
    ).all();
    const accounts = accountsResult.results || [];

    // Fetch all non-reversed transactions
    const txnsResult = await db.prepare(
      "SELECT type, amount, account_id, transfer_to_account_id FROM transactions WHERE (reversed_at IS NULL OR reversed_at = '')"
    ).all();
    const txns = txnsResult.results || [];

    // Compute per-account balance using liability-aware logic
    const balances = {};
    accounts.forEach(a => { balances[a.id] = a.opening_balance || 0; });

    txns.forEach(t => {
      const amt = t.amount || 0;
      const acct = accounts.find(a => a.id === t.account_id);
      const destAcct = t.transfer_to_account_id ? accounts.find(a => a.id === t.transfer_to_account_id) : null;

      if (t.type === 'income') {
        if (acct) balances[acct.id] += amt;
      } else if (t.type === 'expense' || t.type === 'cc_payment' || t.type === 'repay' || t.type === 'atm') {
        if (acct) balances[acct.id] -= amt;
      } else if (t.type === 'cc_spend') {
        if (acct) balances[acct.id] += amt;
      } else if (t.type === 'borrow') {
        if (acct) balances[acct.id] += amt;
      } else if (t.type === 'transfer') {
        if (acct) {
          if (acct.type === 'liability') balances[acct.id] += amt;
          else balances[acct.id] -= amt;
        }
        if (destAcct) {
          if (destAcct.type === 'liability') balances[destAcct.id] -= amt;
          else balances[destAcct.id] += amt;
        }
      }
    });

    // Compute totals
    let totalAssets = 0;
    let totalLiabilities = 0;
    let ccOutstanding = 0;

    const enrichedAccounts = accounts.map(a => {
      const b = Math.round((balances[a.id] || 0) * 100) / 100;
      if (a.type === 'asset') totalAssets += b;
      else if (a.type === 'liability') totalLiabilities += b;
      if (a.kind === 'cc') ccOutstanding += b;
      return {
        id: a.id,
        name: a.name,
        icon: a.icon,
        type: a.type,
        kind: a.kind,
        display_order: a.display_order,
        balance: b
      };
    });

    // Fetch personal debts (active, kind='owe' = money I owe to peers)
    const debtsResult = await db.prepare(
      "SELECT id, original_amount, paid_amount, kind, status FROM debts WHERE status = 'active' AND (deleted_at IS NULL OR deleted_at = '')"
    ).all();
    const debts = debtsResult.results || [];

    let totalOwe = 0;       // money I owe peers
    let totalOwedToMe = 0;  // money owed to me by peers

    debts.forEach(d => {
      const outstanding = (d.original_amount || 0) - (d.paid_amount || 0);
      if (outstanding > 0) {
        if (d.kind === 'owe') totalOwe += outstanding;
        else totalOwedToMe += outstanding;
      }
    });

    const totalDebts = totalOwe;  // legacy field name, same value

    // TRUE NET WORTH: standard personal finance formula
    //   net_worth = assets - |cc_outstanding| - what_i_owe + what_others_owe_me
    // For your case (no peer-owes-you debts): assets - |cc| - debts_owed
    const netWorth = Math.round(
      (totalAssets - Math.abs(ccOutstanding) - totalOwe + totalOwedToMe) * 100
    ) / 100;

    const totalLiquidAssets = Math.round(totalAssets * 100) / 100;
    const debtCount = debts.filter(d => {
      const outstanding = (d.original_amount || 0) - (d.paid_amount || 0);
      return outstanding > 0;
    }).length;

    return json({
      ok: true,
      net_worth: netWorth,
      total_assets: Math.round(totalAssets * 100) / 100,
      total_liquid_assets: totalLiquidAssets,
      total_liabilities: Math.round(totalLiabilities * 100) / 100,
      total_debts: Math.round(totalOwe * 100) / 100,
      total_owe: Math.round(totalOwe * 100) / 100,
      total_owed_to_me: Math.round(totalOwedToMe * 100) / 100,
      cc_outstanding: Math.round(ccOutstanding * 100) / 100,
      account_count: accounts.length,
      debt_count: debtCount,
      accounts: enrichedAccounts
    });

  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
