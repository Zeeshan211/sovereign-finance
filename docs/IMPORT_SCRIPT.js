// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — ZAIN DEBT FIX
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// Archives both Zain-Easypaisa entries, creates one clean Zain debt: 500 owed to me.
// ══════════════════════════════════════════════════════════════════════

(async function fixZain() {
  const BASE = 'https://sovereign-finance.pages.dev';

  // Find all Zain debts by name
  const listR = await fetch(`${BASE}/api/debts`);
  const listData = await listR.json().catch(() => ({}));
  const allDebts = listData.debts || listData.items || [];

  const zainDebts = allDebts.filter(d =>
    (d.name || '').toLowerCase().includes('zain')
  );

  console.log(`Found ${zainDebts.length} Zain debt(s):`);
  for (const d of zainDebts) {
    console.log(`  [${d.status}] ${d.id} — "${d.name}" remaining=${((d.original_amount||0)-(d.paid_amount||0)).toFixed(2)}`);
  }

  // Archive all of them
  let archived = 0;
  for (const d of zainDebts) {
    const r = await fetch(`${BASE}/api/debts/${d.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });
    if (r.ok) {
      console.log(`  ✅ Archived ${d.id}`);
      archived++;
    } else if (r.status === 404) {
      console.log(`  ℹ  ${d.id} already archived`);
    } else {
      const e = await r.json().catch(() => ({}));
      console.error(`  ❌ Failed ${d.id}:`, JSON.stringify(e).slice(0, 120));
    }
  }

  // Create clean Zain entry: 500 owed to me
  console.log('\nCreating clean Zain debt (500 owed to me)...');
  const cr = await fetch(`${BASE}/api/debts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      id: 'debt_zain_clean_500',
      name: 'Zain',
      kind: 'owed',
      original_amount: 500,
      paid_amount: 0,
      movement_now: false,
    }),
  });
  const crData = await cr.json().catch(() => ({}));
  if (cr.ok) {
    console.log(`  ✅ Created Zain — id: ${crData.debt?.id || 'debt_zain_clean_500'} | remaining: ${crData.debt?.remaining_amount ?? 500}`);
  } else {
    console.error('  ❌ Create failed:', JSON.stringify(crData).slice(0, 200));
  }

  console.log('\nDone. Hard-refresh /debts to verify.');
})();
