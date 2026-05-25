// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — DEBT CLEANUP + CREATE v3
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// What this does (in order):
//   PHASE 1 — Archive 19 duplicate debts our import scripts created
//             Uses POST /api/debts/{id} { action:'archive' }
//             Pre-existing debts (debt_cred_*, debt_naseem, debt_20260522_*)
//             are NOT touched.
//   PHASE 2 — Create 3 Imran Bhai debt entries:
//             • Plot +50k (addition to existing 250k plot debt)
//             • Short-term 3k May 24
//             • Historical 10k
// ══════════════════════════════════════════════════════════════════════

(async function debtCleanupAndCreate() {
  const BASE = 'https://sovereign-finance.pages.dev';

  // ── PHASE 1: Archive duplicates ──────────────────────────────────────
  const TO_ARCHIVE = [
    { id: 'debt_1779670399694_h4reoe', name: 'Aunt - Plot Purchase' },
    { id: 'debt_1779667846215_3jji4z', name: 'Aunt — Plot Purchase (run 1)' },
    { id: 'debt_1779669175677_dcayip', name: 'Aunt — Plot Purchase (run 2)' },
    { id: 'debt_1779670401924_eo3n6j', name: 'Imran Bhai - Historical 10k' },
    { id: 'debt_1779670400496_xzsm05', name: 'Imran Bhai - Plot Contribution' },
    { id: 'debt_1779670401214_6jcqhb', name: 'Imran Bhai - Short-term Loan May 24' },
    { id: 'debt_1779667845428_812lyo', name: 'Imran Bhai — Historical (run 1)' },
    { id: 'debt_1779669175002_o5770q', name: 'Imran Bhai — Historical (run 2)' },
    { id: 'debt_1779667844014_d5qvn4', name: 'Imran Bhai — Plot Funding (run 1)' },
    { id: 'debt_1779669173641_k3pruh', name: 'Imran Bhai — Plot Funding (run 2)' },
    { id: 'debt_1779667844767_nrv02c', name: 'Imran Bhai — Short-term (run 1)' },
    { id: 'debt_1779669174346_jj6lyj', name: 'Imran Bhai — Short-term (run 2)' },
    { id: 'debt_1779667847747_w3eka2', name: 'Mashal (run 1)' },
    { id: 'debt_1779669177007_dpbpzu', name: 'Mashal (run 2)' },
    { id: 'debt_1779670399064_rr37lc', name: 'Naseem - Momos Loan' },
    { id: 'debt_1779667846931_2d57so', name: 'Naseem Bibi (run 1)' },
    { id: 'debt_1779669176290_b3s1sg', name: 'Naseem Bibi (run 2)' },
    { id: 'debt_1779667848579_vqghrv', name: 'Jamima Khan (run 1)' },
    { id: 'debt_1779669177728_16j2z7', name: 'Jamima Khan (run 2)' },
  ];

  console.log('═══ PHASE 1: Archive duplicate debts ═══');
  console.log(`Archiving ${TO_ARCHIVE.length} debts...`);
  let archiveOk = 0, archiveFail = 0;

  for (const { id, name } of TO_ARCHIVE) {
    const r = await fetch(`${BASE}/api/debts/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }

    if (r.ok) {
      console.log(`  ✅ ${name} (${id})`);
      archiveOk++;
    } else {
      console.error(`  ❌ ${name} (${id}) — HTTP ${r.status}:`, JSON.stringify(data));
      archiveFail++;
    }
  }

  console.log(`\nPhase 1 done — ✅ ${archiveOk} archived, ❌ ${archiveFail} failed`);

  // ── PHASE 2: Create new Imran Bhai debt entries ───────────────────────
  console.log('\n═══ PHASE 2: Create Imran Bhai debt entries ═══');
  console.log('Note: original_amount on debt_cred_1_5 is not patchable via API.');
  console.log('The +50k is tracked as a separate debt entry.');

  const TO_CREATE = [
    {
      name: 'Imran Bhai — Plot Funding +50k',
      kind: 'owe',
      original_amount: 50000,
      paid_amount: 0,
      movement_now: false,
      notes: 'Additional 50k added to plot funding total. debt_cred_1_5 holds original 250k.',
    },
    {
      name: 'Imran Bhai — Short-term May 24',
      kind: 'owe',
      original_amount: 3000,
      paid_amount: 0,
      movement_now: false,
      notes: 'Short-term loan received May 2024.',
    },
    {
      name: 'Imran Bhai — Historical',
      kind: 'owe',
      original_amount: 10000,
      paid_amount: 0,
      movement_now: false,
      notes: 'Historical outstanding balance.',
    },
  ];

  let createOk = 0, createFail = 0;

  for (const payload of TO_CREATE) {
    const r = await fetch(`${BASE}/api/debts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', ...payload }),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }

    if (r.ok) {
      const debt = data.debt || {};
      console.log(`  ✅ Created: ${payload.name} — id: ${debt.id || '(check app)'}`);
      createOk++;
    } else {
      console.error(`  ❌ Failed: ${payload.name} — HTTP ${r.status}:`, JSON.stringify(data));
      createFail++;
    }
  }

  console.log(`\nPhase 2 done — ✅ ${createOk} created, ❌ ${createFail} failed`);

  // ── FINAL SUMMARY ─────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(55)}`);
  console.log('FINAL SUMMARY');
  console.log(`  Phase 1 — Archive duplicates : ✅ ${archiveOk} / ❌ ${archiveFail}`);
  console.log(`  Phase 2 — Create new debts   : ✅ ${createOk} / ❌ ${createFail}`);
  console.log('');
  console.log('Preserved (untouched):');
  console.log('  debt_cred_1_5          — Imran Bhai plot 250k (original)');
  console.log('  debt_cred_2_4          — Mashal');
  console.log('  debt_naseem            — Naseem Bibi');
  console.log('  debt_20260522_naseem_* — Naseem momos loan');
  console.log('  debt_1778744239552_*   — Naseem (older)');
  console.log('');
  console.log('After running: hard-refresh /debts in the app.');
  console.log('You should see:');
  console.log('  I owe → Imran Bhai (250k + 50k + 3k + 10k), Mashal, Naseem, Aunt');
  console.log('  Owed to me → Jamima Khan (1k)');
  console.log(`${'═'.repeat(55)}`);
})();
