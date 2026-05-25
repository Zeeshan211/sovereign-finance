// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — BALANCE RECONCILIATION
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// One adjustment transaction per drifted account.
// Source of truth: latest bank statement closing balances.
//
//   Cash       app=-900.00      real=0.00       → +900 (user confirmed zero cash)
//   NayaPay    app=-3,999.69    real=0.31       → +4,000 (May 25 stmt closing)
//   Meezan     app=448.01       real=10.01      → -438 (May 24 stmt last entry)
//   Mashreq    app=-25.07       real=9.93       → +35 (Jul25–May26 stmt closing)
//   Alfalah CC app=103,800.33   real=99,739.00  → -4,061.33 (limit 100k, avail 261)
// ══════════════════════════════════════════════════════════════════════

(async function reconcileBalances() {
  const BASE = 'https://sovereign-finance.pages.dev';
  const DATE = '2026-05-25';

  const ADJUSTMENTS = [
    {
      account_id: 'cash',
      type: 'adjustment_positive',
      amount: 900,
      notes: 'Reconciliation: cash = 0 (confirmed). App showed -900.',
    },
    {
      account_id: 'naya_pay',
      type: 'adjustment_positive',
      amount: 4000,
      notes: 'Reconciliation: NayaPay closing balance = Rs 0.31 per May 25 statement. App showed -3,999.69.',
    },
    {
      account_id: 'meezan',
      type: 'adjustment_negative',
      amount: 438,
      notes: 'Reconciliation: Meezan closing balance = Rs 10.01 per May 24 statement. App showed 448.01.',
    },
    {
      account_id: 'mashreq',
      type: 'adjustment_positive',
      amount: 35,
      notes: 'Reconciliation: Mashreq closing balance = Rs 9.93 per Jul25-May26 statement. App showed -25.07.',
    },
    {
      account_id: 'cc',
      type: 'adjustment_negative',
      amount: 4061.33,
      notes: 'Reconciliation: Alfalah CC real outstanding = Rs 99,739 (limit 100k, avail 261). App showed 103,800.33.',
    },
  ];

  console.log('Running balance reconciliation...\n');
  let ok = 0, fail = 0;

  for (const adj of ADJUSTMENTS) {
    const r = await fetch(`${BASE}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...adj, date: DATE }),
    });
    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      const after = data.account?.balance_after ?? data.balance_after ?? '(check app)';
      console.log(`  ✅ ${adj.account_id.padEnd(10)} ${adj.type === 'adjustment_positive' ? '+' : '-'}${adj.amount}  →  new balance: ${after}`);
      ok++;
    } else {
      console.error(`  ❌ ${adj.account_id} FAILED HTTP ${r.status}:`, JSON.stringify(data).slice(0, 200));
      fail++;
    }
  }

  console.log(`\n${'═'.repeat(55)}`);
  console.log(`✅ Done: ${ok}   ❌ Failed: ${fail}`);
  console.log('');
  console.log('Expected balances:');
  console.log('  Cash       →  Rs 0.00');
  console.log('  NayaPay    →  Rs 0.31');
  console.log('  Meezan     →  Rs 10.01');
  console.log('  Mashreq    →  Rs 9.93');
  console.log('  Alfalah CC →  Rs 99,739.00 outstanding');
  console.log(`${'═'.repeat(55)}`);
  console.log('Hard-refresh /accounts to verify.');
})();
