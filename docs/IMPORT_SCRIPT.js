// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — FINAL DEBT DEDUP CLEANUP
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// Archives exactly the duplicates visible in the debt list.
// No new creations. Nothing else touched.
// ══════════════════════════════════════════════════════════════════════

(async function finalDebtDedup() {
  const BASE = 'https://sovereign-finance.pages.dev';

  // Step 1: fetch all debts to find IDs we can't hardcode
  const listR = await fetch(`${BASE}/api/debts`);
  const listData = await listR.json().catch(() => ({}));
  const allDebts = listData.debts || listData.items || [];

  // Find Naseem Momos loan by name/notes (pre-existing, paid=0, incorrect)
  const naseem820Wrong = allDebts.find(d =>
    (d.name || '').toLowerCase().includes('momos') ||
    (d.notes || '').toLowerCase().includes('momos')
  );

  if (naseem820Wrong) {
    console.log(`  Found Naseem Momos loan: ${naseem820Wrong.id} — will archive`);
  } else {
    console.log(`  ℹ Naseem Momos loan not found (may already be archived)`);
  }

  // Hardcoded duplicates (IDs read from idempotency_key notes in the UI)
  const TO_ARCHIVE = [
    // Imran Bhai — v3 script created these with auto-generated IDs;
    // v4 re-created with fixed IDs → v3 copies are the duplicates
    { id: 'debt_1779673321877_iwq56k', reason: 'Imran Plot +50k (v3 auto-id duplicate)' },
    { id: 'debt_1779673322593_yy7b7s', reason: 'Imran Short-term 3k (v3 auto-id duplicate)' },
    { id: 'debt_1779673323413_73dyyh', reason: 'Imran Historical 10k (v3 auto-id duplicate)' },

    // Jamima Khan — "Jamima Cousin" already existed pre-existing
    { id: 'debt_jamima_1000', reason: 'Jamima Khan (duplicate of pre-existing Jamima Cousin)' },

    // Zain — "Zain-Easypaisa" already existed pre-existing
    { id: 'debt_zain_500', reason: 'Zain 500 (duplicate — Zain-Easypaisa pre-existing covers this)' },
  ];

  // Add Naseem momos if found
  if (naseem820Wrong) {
    TO_ARCHIVE.push({ id: naseem820Wrong.id, reason: 'Naseem Momos loan (paid=0 incorrect; Naseem Bibi has paid=500)' });
  }

  console.log(`\nArchiving ${TO_ARCHIVE.length} duplicate debts...`);
  let ok = 0, skipped = 0, fail = 0;

  for (const { id, reason } of TO_ARCHIVE) {
    const r = await fetch(`${BASE}/api/debts/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });

    if (r.ok) {
      console.log(`  ✅ ${id} — ${reason}`);
      ok++;
    } else if (r.status === 404) {
      console.log(`  ℹ  ${id} — not found / already archived (ok)`);
      skipped++;
    } else {
      const d = await r.json().catch(() => ({}));
      console.error(`  ❌ ${id} — HTTP ${r.status}:`, JSON.stringify(d).slice(0, 150));
      fail++;
    }
  }

  console.log(`\n${'═'.repeat(55)}`);
  console.log(`✅ Archived : ${ok}`);
  console.log(`ℹ  Skipped  : ${skipped} (already gone)`);
  console.log(`❌ Failed   : ${fail}`);

  // Final state
  const afterR = await fetch(`${BASE}/api/debts`);
  const afterData = await afterR.json().catch(() => ({}));
  const active = (afterData.debts || afterData.items || []).filter(d => d.status === 'active');

  console.log(`\nActive debts after cleanup (${active.length}):`);
  for (const d of active) {
    const remaining = ((d.original_amount || 0) - (d.paid_amount || 0)).toFixed(2);
    const dir = d.kind === 'owed' ? '← OWED TO ME' : '→ I OWE';
    console.log(`  ${dir}  "${d.name}"  remaining=${remaining}  [${d.id}]`);
  }
  console.log(`${'═'.repeat(55)}`);
  console.log('Hard-refresh /debts to verify.');
})();
