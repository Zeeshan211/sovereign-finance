// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — FULL CLEANUP / ROLLBACK SCRIPT
// Paste into DevTools console at https://sovereign-finance.pages.dev
// ══════════════════════════════════════════════════════════════════════
// What this does:
//   1. Rolls back BOTH known import batches (old + any new one)
//   2. Fetches all transactions, finds any import_batch_id we don't know
//      about, and rolls those back too
//   3. Archives (soft-deletes) the 5 debts we created by name
//   4. Deletes the 6 bills we created by name
//   5. Prints a clean status report
// ══════════════════════════════════════════════════════════════════════

(async function fullCleanup() {
  'use strict';

  const BASE = 'https://sovereign-finance.pages.dev';

  // ── helpers ────────────────────────────────────────────────────────
  async function req(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(BASE + path, opts);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    return { ok: r.ok, status: r.status, data };
  }
  const get  = path        => req('GET',    path);
  const post = (path, body) => req('POST',   path, body);
  const del  = path        => req('DELETE',  path);
  const put  = (path, body) => req('PUT',    path, body);

  async function rollbackBatch(batchId) {
    const pv = await post('/api/import/rollback', { batch_id: batchId });
    if (!pv.ok) { console.warn(`  Rollback preview failed for ${batchId}:`, pv.data); return 0; }
    const would = pv.data.would_delete ?? 0;
    if (would === 0) { console.log(`  Batch ${batchId}: 0 rows (nothing to delete)`); return 0; }
    const rb = await post('/api/import/rollback', { batch_id: batchId, confirm: true });
    if (!rb.ok) { console.error(`  Rollback FAILED for ${batchId}:`, rb.data); return 0; }
    console.log(`  ✅ Rolled back ${batchId}: deleted ${rb.data.deleted} rows`);
    return rb.data.deleted ?? 0;
  }

  const report = {
    batches_rolled_back: [],
    batches_empty: [],
    debts_archived: [],
    debts_not_found: [],
    bills_deleted: [],
    bills_not_found: [],
    warnings: [],
  };

  // ════════════════════════════════════════════════════════════════════
  // STEP 1 — ROLL BACK ALL IMPORT BATCHES
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 1: ROLLBACK ALL IMPORT BATCHES');

  // Known batch from old large import
  const KNOWN_BATCH = 'dd185a3f-24ed-408a-9471-9838cd0dc94e';
  const deleted1 = await rollbackBatch(KNOWN_BATCH);
  if (deleted1 > 0) report.batches_rolled_back.push(`${KNOWN_BATCH} (${deleted1} rows)`);
  else report.batches_empty.push(KNOWN_BATCH);

  // Find any OTHER historical import batches by scanning transactions
  console.log('  Scanning transactions for unknown historical import batches...');
  const txRes = await get('/api/transactions?limit=500&include_reversed=true');
  const allTxns = txRes.ok ? (txRes.data.transactions || txRes.data.data || txRes.data || []) : [];
  const otherBatches = new Set();

  if (Array.isArray(allTxns)) {
    for (const tx of allTxns) {
      const bid = tx.import_batch_id;
      if (bid && bid !== KNOWN_BATCH) otherBatches.add(bid);
    }
  }

  if (otherBatches.size > 0) {
    console.log(`  Found ${otherBatches.size} additional batch(es):`, [...otherBatches]);
    for (const bid of otherBatches) {
      const d = await rollbackBatch(bid);
      if (d > 0) report.batches_rolled_back.push(`${bid} (${d} rows)`);
      else report.batches_empty.push(bid);
    }
  } else {
    console.log('  No additional batches found in transaction list.');
  }

  // ════════════════════════════════════════════════════════════════════
  // STEP 2 — ARCHIVE DEBTS WE CREATED (by name match)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 2: ARCHIVE DEBTS');

  const OUR_DEBT_NAMES = [
    'Naseem - Momos Loan',
    'Aunt - Plot Purchase',
    'Imran Bhai - Plot Contribution',
    'Imran Bhai - Short-term Loan May 24',
    'Imran Bhai - Historical 10k',
    // Also catch the earlier names we used in the first script
    'Naseem Bibi',
    'Aunt — Plot Purchase',
    'Imran Bhai — Plot Funding',
    'Imran Bhai — Short-term May 24',
    'Imran Bhai — Historical',
    'Mashal',
    'Jamima Khan',
    'Zain Easypaisa',
  ];

  const debtsRes = await get('/api/debts?include_terminal=true');
  const allDebts = debtsRes.ok
    ? (debtsRes.data.debts || debtsRes.data.data || debtsRes.data || [])
    : [];

  console.log(`  Found ${Array.isArray(allDebts) ? allDebts.length : '?'} total debts`);

  if (Array.isArray(allDebts)) {
    for (const debt of allDebts) {
      const nameMatch = OUR_DEBT_NAMES.some(n =>
        debt.name?.toLowerCase().includes(n.toLowerCase()) ||
        n.toLowerCase().includes((debt.name || '').toLowerCase())
      );
      if (!nameMatch) continue;

      // Try PUT to archive
      const r = await put(`/api/debts/${debt.id}`, { status: 'archived' });
      if (r.ok) {
        console.log(`  ✅ Archived debt: "${debt.name}" (id=${debt.id})`);
        report.debts_archived.push(debt.name);
      } else {
        console.warn(`  ⚠ Could not archive "${debt.name}":`, r.data);
        report.warnings.push(`Debt archive failed: ${debt.name}`);
      }
    }
  }

  const foundNames = report.debts_archived;
  for (const name of OUR_DEBT_NAMES) {
    if (!foundNames.some(f => f.toLowerCase().includes(name.toLowerCase()))) {
      report.debts_not_found.push(name);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // STEP 3 — DELETE BILLS WE CREATED (by name match)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 3: DELETE BILLS');

  const OUR_BILL_NAMES = [
    'House Maid Salary',
    'StormFiber Internet',
    'StormFiber',
    'PTCL Islamabad',
    'Google Claude Subscription',
    'K-Electric',
    'SNGPL Gas',
    'SNGPL',
  ];

  const billsRes = await get('/api/bills');
  const allBills = billsRes.ok
    ? (billsRes.data.bills || billsRes.data.data || billsRes.data || [])
    : [];

  console.log(`  Found ${Array.isArray(allBills) ? allBills.length : '?'} total bills`);

  if (Array.isArray(allBills)) {
    for (const bill of allBills) {
      const nameMatch = OUR_BILL_NAMES.some(n =>
        bill.name?.toLowerCase().includes(n.toLowerCase())
      );
      if (!nameMatch) continue;

      const r = await del(`/api/bills/${bill.id}`);
      if (r.ok) {
        console.log(`  ✅ Deleted bill: "${bill.name}" (id=${bill.id})`);
        report.bills_deleted.push(bill.name);
      } else {
        console.warn(`  ⚠ Could not delete "${bill.name}":`, r.data);
        report.warnings.push(`Bill delete failed: ${bill.name}`);
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // REPORT
  // ════════════════════════════════════════════════════════════════════
  const sep = '═'.repeat(62);
  console.log('\n' + sep);
  console.log('🧹  CLEANUP COMPLETE');
  console.log(sep);

  console.log(`\n  Import batches rolled back (${report.batches_rolled_back.length}):`);
  if (report.batches_rolled_back.length)
    report.batches_rolled_back.forEach(b => console.log(`    ✅ ${b}`));
  else
    console.log('    (none had rows — may not have been imported)');

  console.log(`\n  Debts archived (${report.debts_archived.length}):`);
  if (report.debts_archived.length)
    report.debts_archived.forEach(d => console.log(`    ✅ ${d}`));
  else
    console.log('    (none found by name — may not have been created)');

  console.log(`\n  Bills deleted (${report.bills_deleted.length}):`);
  if (report.bills_deleted.length)
    report.bills_deleted.forEach(b => console.log(`    ✅ ${b}`));
  else
    console.log('    (none found by name — may not have been created)');

  if (report.warnings.length) {
    console.warn(`\n  ⚠ Warnings (${report.warnings.length}):`);
    report.warnings.forEach(w => console.warn(`    ${w}`));
  }

  console.log('\n  VERIFY:');
  console.log('  1. Hard-refresh /transactions  — historical rows should be gone');
  console.log('  2. Hard-refresh /debts          — our debts should be archived/gone');
  console.log('  3. Hard-refresh /bills          — our bills should be gone');
  console.log('  4. Hard-refresh /accounts       — balances should be back to normal');
  console.log(sep);

  return report;
})().then(r => r && console.log('[cleanup done]', r));
