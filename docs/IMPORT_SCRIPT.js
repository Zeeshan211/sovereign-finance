// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — DEBT FIX v4
// Paste into DevTools console at https://sovereign-finance.pages.dev
//
// PHASE 1 — Diagnostic: show all current debts
// PHASE 2 — Archive 19 script-created duplicates
// PHASE 3 — Fix Naseem (archive + recreate with paid_amount=500)
// PHASE 4 — Create missing debts:
//           Aunt (700k original, 300k paid, 400k outstanding)
//           Jamima Khan (1,000 owed to me)
//           Zain (500 owed to me)
// PHASE 5 — Create Imran Bhai entries (idempotent — safe to re-run)
//           Plot +50k, Short-term 3k, Historical 10k
// ══════════════════════════════════════════════════════════════════════

(async function debtFixV4() {
  const BASE = 'https://sovereign-finance.pages.dev';

  // ── PHASE 1: Diagnostic ─────────────────────────────────────────────
  console.log('═══ PHASE 1: Current debt state ═══');
  const diagR = await fetch(`${BASE}/api/debts`);
  const diagData = await diagR.json().catch(() => ({}));
  const allDebts = diagData.debts || diagData.items || [];

  if (allDebts.length === 0) {
    console.log('  ⚠ No debts returned or endpoint error:', JSON.stringify(diagData).slice(0, 200));
  } else {
    console.log(`  Found ${allDebts.length} debts:`);
    for (const d of allDebts) {
      const out = d.original_amount ?? '?';
      const paid = d.paid_amount ?? '?';
      const remaining = (typeof out === 'number' && typeof paid === 'number') ? (out - paid) : '?';
      console.log(`  [${d.status || '?'}] ${d.id} — "${d.name}" | kind=${d.kind} | orig=${out} paid=${paid} remaining=${remaining}`);
    }
  }

  // ── PHASE 2: Archive 19 duplicates ──────────────────────────────────
  console.log('\n═══ PHASE 2: Archive duplicate debts ═══');
  const TO_ARCHIVE = [
    'debt_1779670399694_h4reoe',
    'debt_1779667846215_3jji4z',
    'debt_1779669175677_dcayip',
    'debt_1779670401924_eo3n6j',
    'debt_1779670400496_xzsm05',
    'debt_1779670401214_6jcqhb',
    'debt_1779667845428_812lyo',
    'debt_1779669175002_o5770q',
    'debt_1779667844014_d5qvn4',
    'debt_1779669173641_k3pruh',
    'debt_1779667844767_nrv02c',
    'debt_1779669174346_jj6lyj',
    'debt_1779667847747_w3eka2',
    'debt_1779669177007_dpbpzu',
    'debt_1779670399064_rr37lc',
    'debt_1779667846931_2d57so',
    'debt_1779669176290_b3s1sg',
    'debt_1779667848579_vqghrv',
    'debt_1779669177728_16j2z7',
  ];

  let archOk = 0, archFail = 0;

  for (const id of TO_ARCHIVE) {
    const r = await fetch(`${BASE}/api/debts/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });
    if (r.ok) {
      archOk++;
    } else {
      const d = await r.json().catch(() => ({}));
      // 404 = already archived or never existed — that's fine
      if (r.status === 404) {
        console.log(`  ℹ ${id} — not found (already archived or never existed)`);
      } else {
        console.error(`  ❌ ${id} — HTTP ${r.status}:`, JSON.stringify(d).slice(0, 120));
        archFail++;
      }
    }
  }

  console.log(`  Phase 2 done — ✅ ${archOk} archived, ❌ ${archFail} hard-failed`);

  // ── PHASE 3: Fix Naseem — archive + recreate with correct paid_amount ─
  console.log('\n═══ PHASE 3: Fix Naseem debt ═══');
  console.log('  Archiving debt_naseem...');
  const nasArch = await fetch(`${BASE}/api/debts/debt_naseem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'archive' }),
  });
  if (nasArch.ok) {
    console.log('  ✅ debt_naseem archived');
  } else if (nasArch.status === 404) {
    console.log('  ℹ debt_naseem not found — may already be archived');
  } else {
    const d = await nasArch.json().catch(() => ({}));
    console.error('  ❌ Archive naseem failed:', JSON.stringify(d).slice(0, 200));
  }

  console.log('  Creating Naseem Bibi with original=820, paid=500...');
  const nasCr = await fetch(`${BASE}/api/debts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      id: 'debt_naseem_fix_820',
      name: 'Naseem Bibi',
      kind: 'owe',
      original_amount: 820,
      paid_amount: 500,
      movement_now: false,
      notes: 'Total 820 owed, 500 paid May 24. Outstanding 320.',
    }),
  });
  const nasCrData = await nasCr.json().catch(() => ({}));
  if (nasCr.ok) {
    console.log(`  ✅ Naseem recreated — id: ${nasCrData.debt?.id || 'debt_naseem_fix_820'} | remaining: ${nasCrData.debt?.remaining_amount ?? 320}`);
  } else {
    console.error('  ❌ Create Naseem failed:', JSON.stringify(nasCrData).slice(0, 200));
  }

  // ── PHASE 4: Create missing debts ────────────────────────────────────
  console.log('\n═══ PHASE 4: Create missing debts ═══');

  const TO_CREATE = [
    {
      id: 'debt_aunt_plot_700k',
      name: 'Aunt — Plot Purchase',
      kind: 'owe',
      original_amount: 700000,
      paid_amount: 300000,
      movement_now: false,
      notes: '700k total. 300k paid. 400k outstanding for plot purchase.',
    },
    {
      id: 'debt_jamima_1000',
      name: 'Jamima Khan',
      kind: 'owed',
      original_amount: 1000,
      paid_amount: 0,
      movement_now: false,
      notes: '1,000 owed to me.',
    },
    {
      id: 'debt_zain_500',
      name: 'Zain',
      kind: 'owed',
      original_amount: 500,
      paid_amount: 0,
      movement_now: false,
      notes: '500 owed to me.',
    },
  ];

  for (const payload of TO_CREATE) {
    const r = await fetch(`${BASE}/api/debts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', ...payload }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const alreadyFlag = data.already_recorded ? ' (already existed)' : '';
      console.log(`  ✅ ${payload.name}${alreadyFlag} — id: ${data.debt?.id || payload.id}`);
    } else {
      console.error(`  ❌ ${payload.name} — HTTP ${r.status}:`, JSON.stringify(data).slice(0, 200));
    }
  }

  // ── PHASE 5: Imran Bhai entries (idempotent) ──────────────────────────
  console.log('\n═══ PHASE 5: Imran Bhai debt entries ═══');

  const IMRAN_ENTRIES = [
    {
      id: 'debt_imran_plot_plus50k',
      name: 'Imran Bhai — Plot Funding +50k',
      kind: 'owe',
      original_amount: 50000,
      paid_amount: 0,
      movement_now: false,
      notes: 'Additional 50k. debt_cred_1_5 holds original 250k plot debt.',
    },
    {
      id: 'debt_imran_short_3k_may24',
      name: 'Imran Bhai — Short-term May 24',
      kind: 'owe',
      original_amount: 3000,
      paid_amount: 0,
      movement_now: false,
      notes: 'Short-term loan received May 2024.',
    },
    {
      id: 'debt_imran_historical_10k',
      name: 'Imran Bhai — Historical',
      kind: 'owe',
      original_amount: 10000,
      paid_amount: 0,
      movement_now: false,
      notes: 'Historical outstanding balance.',
    },
  ];

  for (const payload of IMRAN_ENTRIES) {
    const r = await fetch(`${BASE}/api/debts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', ...payload }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      const alreadyFlag = data.already_recorded ? ' (already existed — no duplicate)' : '';
      console.log(`  ✅ ${payload.name}${alreadyFlag} — id: ${data.debt?.id || payload.id}`);
    } else {
      console.error(`  ❌ ${payload.name} — HTTP ${r.status}:`, JSON.stringify(data).slice(0, 200));
    }
  }

  // ── FINAL SUMMARY ─────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('ALL DONE — expected final debt state:');
  console.log('');
  console.log('  I OWE:');
  console.log('    debt_cred_1_5             Imran Bhai — Plot          250k (orig, 115k remaining)');
  console.log('    debt_imran_plot_plus50k   Imran Bhai — Plot +50k     50k');
  console.log('    debt_imran_short_3k_may24 Imran Bhai — Short-term     3k');
  console.log('    debt_imran_historical_10k Imran Bhai — Historical    10k');
  console.log('    debt_cred_2_4             Mashal                     8.5k');
  console.log('    debt_naseem_fix_820       Naseem Bibi                320 remaining (820-500)');
  console.log('    debt_aunt_plot_700k       Aunt — Plot Purchase       400k remaining (700k-300k)');
  console.log('');
  console.log('  OWED TO ME:');
  console.log('    debt_jamima_1000          Jamima Khan                1k');
  console.log('    debt_zain_500             Zain                       500');
  console.log('');
  console.log('Hard-refresh /debts to verify.');
  console.log(`${'═'.repeat(60)}`);
})();
