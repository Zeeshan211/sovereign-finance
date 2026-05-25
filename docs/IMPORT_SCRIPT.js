// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — DEBT CLEANUP v2
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// What this does:
//   Archives the 19 specific debts our scripts created
//   (identified by ID from previous console output).
//   Pre-existing debts (debt_cred_*, debt_naseem, debt_20260522_*)
//   are NOT touched.
// ══════════════════════════════════════════════════════════════════════

(async function cleanupDebts() {
  const BASE = 'https://sovereign-finance.pages.dev';

  // Exactly the IDs our scripts created — pulled from previous run output
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

  console.log(`Archiving ${TO_ARCHIVE.length} debts...`);
  let ok = 0, fail = 0;

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
      ok++;
    } else {
      console.error(`  ❌ ${name} (${id}) — HTTP ${r.status}:`, JSON.stringify(data));
      fail++;
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Archived : ${ok}`);
  console.log(`❌ Failed   : ${fail}`);
  console.log(`\nPreserved (untouched):`);
  console.log(`  debt_cred_1_5            — Imran Bhai (pre-existing)`);
  console.log(`  debt_cred_2_4            — Mashal (pre-existing)`);
  console.log(`  debt_naseem              — Naseem (pre-existing)`);
  console.log(`  debt_20260522_naseem_*   — Naseem momos loan (pre-existing)`);
  console.log(`  debt_1778744239552_*     — Naseem (older, not touched)`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`\nHard-refresh /debts — you should see only pre-existing debts now.`);
})();
