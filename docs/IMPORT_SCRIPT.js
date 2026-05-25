// ══════════════════════════════════════════════════════════════════════
// SOVEREIGN FINANCE — May 24 2026 Import Script
// Paste into DevTools console at https://sovereign-finance.pages.dev
// ══════════════════════════════════════════════════════════════════════
// Steps:  1 — Rollback old batch dd185a3f
//         2 — Dry run 33 new May-24 transactions (chunks of 25)
//         3 — Real import (auto-proceeds if dry run is clean)
//         4 — Create 5 debts
//         5 — Create 6 bills
//         6 — Print audit trail + rollback command
// NOTE: endpoint uses field `transactions`, not `items`
// ══════════════════════════════════════════════════════════════════════

(async function sovereignImport() {
  'use strict';

  const BASE      = 'https://sovereign-finance.pages.dev';
  const OLD_BATCH = 'dd185a3f-24ed-408a-9471-9838cd0dc94e';
  const NEW_BATCH = crypto.randomUUID();

  // ── hard-fail POST: throws + prints full error JSON on non-2xx ──────
  async function post(path, body) {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (!r.ok) {
      console.error(`\n❌ HARD FAIL  POST ${path}  HTTP ${r.status}:`);
      console.error(JSON.stringify(data, null, 2));
      throw new Error(`HTTP ${r.status} on ${path}`);
    }
    return data;
  }

  function chunks(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  const audit = {
    new_batch: NEW_BATCH,
    rollback_deleted: null,
    dry:  { inserted: 0, skipped: 0, failed: 0 },
    real: { inserted: 0, skipped: 0, failed: 0 },
    debts_ok: [], debts_fail: [],
    bills_ok: [], bills_fail: [],
  };

  // ════════════════════════════════════════════════════════════════════
  // STEP 1 — ROLLBACK OLD BATCH
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 1: ROLLBACK', OLD_BATCH);

  const preview = await post('/api/import/rollback', { batch_id: OLD_BATCH });
  console.log(`  Preview: would_delete=${preview.would_delete ?? 0}  message=${preview.message}`);

  const rb = await post('/api/import/rollback', { batch_id: OLD_BATCH, confirm: true });
  if (!rb.ok) { console.error('Rollback failed:', JSON.stringify(rb)); return; }

  audit.rollback_deleted = rb.deleted ?? 0;
  console.log(`  ✅ Rollback done — ${audit.rollback_deleted} rows deleted`);

  // ════════════════════════════════════════════════════════════════════
  // STEP 2 — TRANSACTIONS  (2026-05-24 only, 33 items)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 2: TRANSACTIONS  new_batch=' + NEW_BATCH);

  const TRANSACTIONS = [
    // ── MEEZAN ──────────────────────────────────────────────────────
    { date:'2026-05-24', type:'income',     amount:3000,    account_id:'meezan',
      notes:'Loan from Imran Bhai - short-term 3k' },

    { date:'2026-05-24', type:'expense',    amount:500,     account_id:'meezan',
      notes:'Transfer to Naseem - debt partial payment (820 → 320)' },

    { date:'2026-05-24', type:'cc_payment', amount:2000,    account_id:'meezan',
      transfer_to_account_id:'cc',
      notes:'Alfalah CC payment from Meezan' },

    { date:'2026-05-24', type:'cc_payment', amount:500,     account_id:'meezan',
      transfer_to_account_id:'cc',
      notes:'Alfalah CC secondary payment from Meezan (leftover of 3k loan)' },

    { date:'2026-05-24', type:'income',     amount:20,      account_id:'meezan',
      notes:'Transfer received from Mashreq for noodles' },

    { date:'2026-05-24', type:'expense',    amount:10,      account_id:'meezan',
      notes:'Noodles Meezan net share (200 total: 190 NayaPay + 10 Meezan; 10 leftover)' },

    // ── MASHREQ ─────────────────────────────────────────────────────
    { date:'2026-05-24', type:'income',     amount:100000,  account_id:'mashreq',
      notes:'Inflow for Aunt plot payment (cash source)' },

    { date:'2026-05-24', type:'atm',        amount:20000,   account_id:'mashreq',
      notes:'ATM withdrawal 1/5 Allied Bank - plot payment cash' },
    { date:'2026-05-24', type:'expense',    amount:35,      account_id:'mashreq',
      notes:'Allied Bank ATM fee 1/5 (Rs 35 est. — verify vs statement)' },

    { date:'2026-05-24', type:'atm',        amount:20000,   account_id:'mashreq',
      notes:'ATM withdrawal 2/5 Allied Bank - plot payment cash' },
    { date:'2026-05-24', type:'expense',    amount:35,      account_id:'mashreq',
      notes:'Allied Bank ATM fee 2/5 (Rs 35 est. — verify vs statement)' },

    { date:'2026-05-24', type:'atm',        amount:20000,   account_id:'mashreq',
      notes:'ATM withdrawal 3/5 Allied Bank - plot payment cash' },
    { date:'2026-05-24', type:'expense',    amount:35,      account_id:'mashreq',
      notes:'Allied Bank ATM fee 3/5 (Rs 35 est. — verify vs statement)' },

    { date:'2026-05-24', type:'atm',        amount:20000,   account_id:'mashreq',
      notes:'ATM withdrawal 4/5 Allied Bank - plot payment cash' },
    { date:'2026-05-24', type:'expense',    amount:35,      account_id:'mashreq',
      notes:'Allied Bank ATM fee 4/5 (Rs 35 est. — verify vs statement)' },

    { date:'2026-05-24', type:'atm',        amount:20000,   account_id:'mashreq',
      notes:'ATM withdrawal 5/5 Allied Bank - plot payment cash' },
    { date:'2026-05-24', type:'expense',    amount:35,      account_id:'mashreq',
      notes:'Allied Bank ATM fee 5/5 (Rs 35 est. — verify vs statement)' },

    { date:'2026-05-24', type:'transfer',   amount:20,      account_id:'mashreq',
      transfer_to_account_id:'meezan',
      notes:'Transfer to Meezan for noodles split' },

    // ── NAYAPAY ─────────────────────────────────────────────────────
    { date:'2026-05-24', type:'expense',    amount:190,     account_id:'naya_pay',
      notes:'Noodles - NayaPay portion (200 total, Meezan covers 10)' },

    // ── ALFALAH CC ──────────────────────────────────────────────────
    { date:'2026-05-24', type:'cc_spend',   amount:4900,    account_id:'cc',
      notes:'Google Claude Subscription' },

    { date:'2026-05-24', type:'cc_spend',   amount:220.50,  account_id:'cc',
      notes:'Foreign Transaction Fee (Claude USD charge)' },

    { date:'2026-05-24', type:'cc_spend',   amount:35.28,   account_id:'cc',
      notes:'16% Excise Duty on Foreign Transaction Charges' },

    { date:'2026-05-24', type:'cc_spend',   amount:245,     account_id:'cc',
      notes:'Section 236Y 5% Advance Tax' },

    { date:'2026-05-24', type:'cc_spend',   amount:2000,    account_id:'cc',
      notes:'PTCL Islamabad' },

    { date:'2026-05-24', type:'cc_spend',   amount:2000,    account_id:'cc',
      notes:'PTCL Islamabad (2nd entry)' },

    { date:'2026-05-24', type:'cc_payment', amount:2000,    account_id:'cc',
      notes:'Payment received from Meezan' },

    { date:'2026-05-24', type:'cc_payment', amount:500,     account_id:'cc',
      notes:'Secondary payment received from Meezan (leftover)' },

    // ── CASH ────────────────────────────────────────────────────────
    { date:'2026-05-24', type:'income',     amount:650,     account_id:'cash',
      notes:'Zain returned cash - cat treats debt' },

    { date:'2026-05-24', type:'income',     amount:500,     account_id:'cash',
      notes:'Zain returned cash - house maid debt' },

    { date:'2026-05-24', type:'expense',    amount:650,     account_id:'cash',
      notes:'Cat treats' },

    { date:'2026-05-24', type:'expense',    amount:500,     account_id:'cash',
      notes:'House maid salary advance - May 2026 paid in full' },

    { date:'2026-05-24', type:'income',     amount:100000,  account_id:'cash',
      notes:'Cash from Allied Bank ATM (5×20k) for Aunt plot payment' },

    { date:'2026-05-24', type:'expense',    amount:100000,  account_id:'cash',
      notes:'Plot payment to Aunt (cash handover)' },
  ];

  // DRY RUN ────────────────────────────────────────────────────────────
  console.log(`  Dry run: ${TRANSACTIONS.length} transactions in chunks of 25...`);
  for (const ch of chunks(TRANSACTIONS, 25)) {
    const r = await post('/api/import/bulk', {
      batch_id: NEW_BATCH, dry_run: true, transactions: ch,
    });
    audit.dry.inserted += r.inserted ?? 0;
    audit.dry.skipped  += r.skipped  ?? 0;
    audit.dry.failed   += r.failed   ?? 0;
    if (r.errors?.length) console.warn('  Dry run chunk errors:', JSON.stringify(r.errors));
  }
  console.log(`  Dry run → would_insert=${audit.dry.inserted}  skip=${audit.dry.skipped}  fail=${audit.dry.failed}`);

  if (audit.dry.failed > 0) {
    console.error('⛔ Dry run failures > 0. NOT proceeding to real import.');
    return;
  }

  // REAL IMPORT ────────────────────────────────────────────────────────
  console.log('  ✅ Dry run clean. Running real import...');
  for (const ch of chunks(TRANSACTIONS, 25)) {
    const r = await post('/api/import/bulk', {
      batch_id: NEW_BATCH, dry_run: false, transactions: ch,
    });
    audit.real.inserted += r.inserted ?? 0;
    audit.real.skipped  += r.skipped  ?? 0;
    audit.real.failed   += r.failed   ?? 0;
    if (r.errors?.length) console.warn('  Import chunk errors:', JSON.stringify(r.errors));
  }
  console.log(`  ✅ Import → inserted=${audit.real.inserted}  skipped=${audit.real.skipped}  failed=${audit.real.failed}`);

  // ════════════════════════════════════════════════════════════════════
  // STEP 3A — DEBTS  (5 records)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 3A: DEBTS');

  const DEBTS = [
    { action:'create', kind:'owe', name:'Naseem - Momos Loan',
      original_amount:820, paid_amount:500,
      notes:`Borrowed May 22. Rs500 paid May 24. Outstanding Rs320. batch=${NEW_BATCH}` },

    { action:'create', kind:'owe', name:'Aunt - Plot Purchase',
      original_amount:700000, paid_amount:300000,
      notes:`Plot 700k. 200k Imran Bhai + 100k cash May 24. Outstanding 400k. batch=${NEW_BATCH}` },

    { action:'create', kind:'owe', name:'Imran Bhai - Plot Contribution',
      original_amount:250000, paid_amount:0,
      notes:`200k paid to Aunt + 50k additional. Outstanding 250k. batch=${NEW_BATCH}` },

    { action:'create', kind:'owe', name:'Imran Bhai - Short-term Loan May 24',
      original_amount:3000, paid_amount:0,
      notes:`3k cash to Meezan May 24. Separate from plot debt. batch=${NEW_BATCH}` },

    { action:'create', kind:'owe', name:'Imran Bhai - Historical 10k',
      original_amount:10000, paid_amount:0,
      notes:`Historical standalone debt. batch=${NEW_BATCH}` },
  ];

  for (const d of DEBTS) {
    try {
      await post('/api/debts', d);
      const outstanding = d.original_amount - d.paid_amount;
      audit.debts_ok.push(`${d.name}  (outstanding Rs${outstanding.toLocaleString()})`);
      console.log(`  ✅ ${d.name}  outstanding Rs${outstanding.toLocaleString()}`);
    } catch (e) {
      audit.debts_fail.push(d.name);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // STEP 3B — BILLS  (6 records)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n━━━ STEP 3B: BILLS');

  const BILLS = [
    { action:'create', name:'House Maid Salary',
      amount:500,  due_day:1,  frequency:'monthly', default_account_id:'cash',
      notes:`Advance paid May 24. batch=${NEW_BATCH}` },

    { action:'create', name:'StormFiber Internet',
      amount:3000, due_day:10, frequency:'monthly', default_account_id:'naya_pay',
      notes:`batch=${NEW_BATCH}` },

    { action:'create', name:'PTCL Islamabad',
      amount:2000, due_day:15, frequency:'monthly', default_account_id:'cc',
      notes:`batch=${NEW_BATCH}` },

    { action:'create', name:'Google Claude Subscription',
      amount:4900, due_day:24, frequency:'monthly', default_account_id:'cc',
      notes:`~USD17.50/mo at current rate. batch=${NEW_BATCH}` },

    { action:'create', name:'K-Electric',
      amount:1,    due_day:20, frequency:'monthly', default_account_id:'meezan',
      notes:`Variable — update amount each cycle. batch=${NEW_BATCH}` },

    { action:'create', name:'SNGPL Gas',
      amount:1,    due_day:20, frequency:'monthly', default_account_id:'meezan',
      notes:`Variable — update amount each cycle. batch=${NEW_BATCH}` },
  ];

  for (const b of BILLS) {
    try {
      await post('/api/bills', b);
      audit.bills_ok.push(`${b.name}  due=${b.due_day}th  Rs${b.amount}/mo`);
      console.log(`  ✅ ${b.name}  (due ${b.due_day}th, Rs ${b.amount})`);
    } catch (e) {
      audit.bills_fail.push(b.name);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // AUDIT TRAIL
  // ════════════════════════════════════════════════════════════════════
  const sep = '═'.repeat(64);
  console.log('\n' + sep);
  console.log('🏁  AUDIT TRAIL — May 24 2026');
  console.log(sep);
  console.log(`  Old batch rolled back : ${audit.rollback_deleted} rows deleted`);
  console.log(`  New batch ID          : ${audit.new_batch}`);
  console.log(`  Date range            : 2026-05-24 only`);
  console.log(`  Transactions inserted : ${audit.real.inserted}`);
  console.log(`  Transactions skipped  : ${audit.real.skipped}  (already in DB)`);
  console.log(`  Transactions failed   : ${audit.real.failed}`);
  console.log('');
  console.log(`  Debts created (${audit.debts_ok.length}/${DEBTS.length}):`);
  audit.debts_ok.forEach(d   => console.log(`    ✅ ${d}`));
  audit.debts_fail.forEach(d => console.log(`    ❌ FAILED: ${d}`));
  console.log('');
  console.log(`  Bills created (${audit.bills_ok.length}/${BILLS.length}):`);
  audit.bills_ok.forEach(b   => console.log(`    ✅ ${b}`));
  audit.bills_fail.forEach(b => console.log(`    ❌ FAILED: ${b}`));
  console.log('');
  console.log('  ⚠  ATM fees estimated Rs 35 × 5 = Rs 175 (based on May-18 refund).');
  console.log('     Confirm vs Mashreq statement — edit entries manually if different.');
  console.log('  ⚠  PRA 5% IT Service Tax on PTCL: amount unknown — SKIPPED.');
  console.log('     Add manually once Alfalah CC statement arrives.');
  console.log('');
  console.log('  ROLLBACK COMMAND (to undo everything above):');
  console.log(`  POST /api/import/rollback`);
  console.log(`  { "batch_id": "${audit.new_batch}", "confirm": true }`);
  console.log('');
  console.log('  NEXT STEPS:');
  console.log('  1. Hard-refresh /accounts (incognito) — verify balances');
  console.log('  2. Hard-refresh /debts — verify 5 debts + outstanding amounts');
  console.log('  3. Hard-refresh /bills — mark House Maid as paid for May');
  console.log('  4. Hard-refresh / (Hub) — Net Worth should show plot liability');
  console.log(sep);

  return audit;
})().then(r => r && console.log('[SFIMPORT done]'));
