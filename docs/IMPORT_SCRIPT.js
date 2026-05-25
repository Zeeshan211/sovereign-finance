// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — BALANCE RECONCILIATION
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// Creates one adjustment transaction per drifted account.
// Based on statement closing balances vs app balances:
//
//   Cash      app=-900.00   real=0.00     → +900 adjustment
//   NayaPay   app=-3999.69  real=0.31     → +4000 adjustment
//   Meezan    app=448.01    real=10.01    → -438 adjustment
//
// Mashreq and Alfalah CC skipped (no closed statement yet).
// ══════════════════════════════════════════════════════════════════════

(async function reconcileBalances() {
  const BASE = 'https://sovereign-finance.pages.dev';
  const DATE = '2026-05-25';

  const ADJUSTMENTS = [
    {
      account_id: 'cash',
      type: 'adjustment_positive',
      amount: 900,
      notes: 'Reconciliation: cash balance correction. Statement truth = Rs 0, app showed -900.',
    },
    {
      account_id: 'naya_pay',
      type: 'adjustment_positive',
      amount: 4000,
      notes: 'Reconciliation: NayaPay balance correction. Statement closing = Rs 0.31, app showed -3,999.69.',
    },
    {
      account_id: 'meezan',
      type: 'adjustment_negative',
      amount: 438,
      notes: 'Reconciliation: Meezan balance correction. Statement closing = Rs 10.01, app showed 448.01.',
    },
  ];

  console.log('Running balance reconciliation adjustments...\n');
  let ok = 0, fail = 0;

  for (const adj of ADJUSTMENTS) {
    // Dry run first
    const dryR = await fetch(`${BASE}/api/transactions?dry_run=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...adj, date: DATE, dry_run: true }),
    });
    const dryData = await dryR.json().catch(() => ({}));

    if (!dryR.ok) {
      console.error(`❌ DRY RUN FAILED for ${adj.account_id}: HTTP ${dryR.status}`, JSON.stringify(dryData).slice(0, 200));
      fail++;
      continue;
    }

    const balBefore = dryData.account?.balance_before ?? dryData.balance_before ?? '?';
    const balAfter  = dryData.account?.balance_after  ?? dryData.balance_after  ?? '?';
    console.log(`  ${adj.account_id}: dry run ok — balance ${balBefore} → ${balAfter}`);

    // Real insert
    const r = await fetch(`${BASE}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...adj, date: DATE }),
    });
    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      const after = data.account?.balance_after ?? data.balance_after ?? '(check app)';
      console.log(`  ✅ ${adj.account_id} adjusted — new balance: ${after}  id: ${data.transaction?.id || data.id || ''}`);
      ok++;
    } else {
      console.error(`  ❌ ${adj.account_id} FAILED: HTTP ${r.status}`, JSON.stringify(data).slice(0, 200));
      fail++;
    }
  }

  console.log(`\n${'═'.repeat(55)}`);
  console.log(`✅ Done : ${ok}   ❌ Failed : ${fail}`);
  console.log('');
  console.log('Expected balances after this:');
  console.log('  Cash      → Rs 0.00   (was -900)');
  console.log('  NayaPay   → Rs 0.31   (was -3,999.69)');
  console.log('  Meezan    → Rs 10.01  (was 448.01)');
  console.log('');
  console.log('Skipped (no closed statement yet):');
  console.log('  Mashreq Bank — reconcile manually when statement available');
  console.log('  Alfalah CC   — billing period closes Jun 5; reconcile then');
  console.log(`${'═'.repeat(55)}`);
  console.log('Hard-refresh /accounts to verify.');
})();
