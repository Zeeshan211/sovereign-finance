// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — BALANCE DRIFT AUDIT
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// For every account: fetches all transactions, shows running balance,
// and flags where it diverges from statement truth.
// ══════════════════════════════════════════════════════════════════════

(async function balanceDriftAudit() {
  const BASE = 'https://sovereign-finance.pages.dev';

  // Statement closing balances (source of truth)
  const TRUTH = {
    cash:    { real: 0,          label: 'Cash (user confirmed)' },
    naya_pay:{ real: 0.31,       label: 'NayaPay (May 25 stmt)' },
    meezan:  { real: 10.01,      label: 'Meezan (May 24 stmt)' },
    mashreq: { real: 9.93,       label: 'Mashreq (Jul25-May26 stmt)' },
    cc:      { real: -99739,     label: 'Alfalah CC (100k limit - 261 avail) — negative = liability' },
  };

  // Fetch all accounts
  const accR = await fetch(`${BASE}/api/accounts`);
  const accData = await accR.json().catch(() => ({}));
  const accounts = accData.accounts || accData.items || [];

  console.log(`Found ${accounts.length} accounts\n`);

  for (const acc of accounts) {
    const id = acc.id;
    const truth = TRUTH[id];

    // Fetch transactions for this account
    const txR = await fetch(`${BASE}/api/transactions?account_id=${id}&limit=500`);
    const txData = await txR.json().catch(() => ({}));
    const txns = txData.transactions || txData.items || [];

    const appBalance = acc.balance ?? acc.current_balance ?? 0;
    const isLiability = acc.type === 'cc' || acc.kind === 'liability' || (acc.account_type || '').toLowerCase().includes('cc');

    console.log(`${'═'.repeat(60)}`);
    console.log(`ACCOUNT: ${acc.name || id}  [${id}]`);
    console.log(`  Type    : ${acc.account_type || acc.type || acc.kind || '?'}`);
    console.log(`  App Bal : ${appBalance}`);
    if (truth) {
      const drift = parseFloat((appBalance - truth.real).toFixed(2));
      console.log(`  Real Bal: ${truth.real}  (${truth.label})`);
      console.log(`  DRIFT   : ${drift > 0 ? '+' : ''}${drift}  ${Math.abs(drift) < 0.01 ? '✅ CLEAN' : '⚠ NEEDS FIX'}`);
    } else {
      console.log(`  Real Bal: (no statement provided)`);
    }
    console.log(`  Txn Count: ${txns.length}`);

    if (txns.length === 0) {
      console.log('  (no transactions)');
      continue;
    }

    // Sort by date ascending
    const sorted = [...txns].sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`\n  Transaction audit (oldest → newest):`);
    console.log(`  ${'Date'.padEnd(12)} ${'Type'.padEnd(20)} ${'Amount'.padStart(12)}  Notes`);
    console.log(`  ${'-'.repeat(70)}`);

    let running = 0;
    for (const tx of sorted) {
      const amt = parseFloat(tx.amount || 0);
      const type = tx.type || tx.transaction_type || '?';

      // Determine effect on account balance
      let effect = 0;
      if (isLiability) {
        // For CC: charges increase outstanding (negative for user), payments decrease
        if (['cc_spend', 'expense', 'cc_payment_charge'].includes(type)) effect = amt;
        else if (['cc_payment', 'income', 'adjustment_negative'].includes(type)) effect = -amt;
        else if (type === 'adjustment_positive') effect = amt;
      } else {
        // Asset accounts
        if (['income', 'cc_payment', 'atm', 'adjustment_positive'].includes(type)) effect = amt;
        else if (['expense', 'cc_spend', 'adjustment_negative'].includes(type)) effect = -amt;
        else if (type === 'transfer') {
          // transfers: depends on direction
          effect = tx.account_id === id ? -amt : amt;
        }
      }

      running += effect;
      const flag = '';
      const note = (tx.notes || tx.description || '').slice(0, 40);
      console.log(`  ${(tx.date || '?').padEnd(12)} ${type.padEnd(20)} ${(effect >= 0 ? '+' : '') + effect.toFixed(2).padStart(11)}  ${note} ${flag}`);
    }

    console.log(`  ${'-'.repeat(70)}`);
    console.log(`  Computed running total : ${running.toFixed(2)}`);
    console.log(`  App reported balance   : ${appBalance}`);
    if (truth) console.log(`  Statement truth        : ${truth.real}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY — accounts with drift:');
  for (const acc of accounts) {
    const truth = TRUTH[acc.id];
    if (!truth) continue;
    const appBal = acc.balance ?? acc.current_balance ?? 0;
    const drift = parseFloat((appBal - truth.real).toFixed(2));
    if (Math.abs(drift) > 0.01) {
      console.log(`  ⚠ ${(acc.name || acc.id).padEnd(15)} app=${appBal}  real=${truth.real}  drift=${drift > 0 ? '+' : ''}${drift}`);
    }
  }
  console.log(`${'═'.repeat(60)}`);
})();
