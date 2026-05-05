// /functions/api/admin/migrate-from-sheet.js
// v1.2 — Schema-correct + type-canonicalization
//
// CHANGES vs v1.1:
//   - FIX: bills INSERT was using wrong column names (account_id/last_paid_dt/amount_minor)
//          → now uses canonical (default_account_id/last_paid_date/amount in PKR)
//   - FIX: transaction type translation — sheet/legacy 'borrow' → canonical 'debt_in'
//          and 'repay' → 'debt_out' per Layer 1 spec
//   - NEW: pre-flight check: MIGRATION_SECRET env var must be set; clear 500 if not
//   - PRESERVED: full-replace semantics (DELETE all 4 tables in batch before INSERT)
//   - PRESERVED: amount conversion (cents from sheet → PKR for D1)
//   - PRESERVED: atomic db.batch() — all-or-nothing, snapshot-protected
//
// ════════════════════════════════════════════════════════════════════
// SECTION 9 — VOCABULARY TRANSLATION TABLE (Pattern 21 lock)
// ════════════════════════════════════════════════════════════════════
// Sheet exporter (Sheet_To_D1_Export.gs v1.2) sends LEGACY vocabulary.
// This endpoint translates to CANONICAL vocabulary at INSERT time.
// Until sheet exporter is rewritten to v1.3 (canonical-direct), this
// translation layer is required.
//
//   SHEET LEGACY      →   D1 CANONICAL (Layer 1 spec)
//   ────────────         ────────────────────────────
//   'borrow'          →   'debt_in'    (receiving from debtor)
//   'repay'           →   'debt_out'   (paying creditor)
//   'income'          →   'income'     (no change)
//   'expense'         →   'expense'    (no change)
//   'transfer'        →   'transfer'   (no change)
//
//   amount_minor (cents) →   amount (PKR decimal)  via /100
//   dt_local             →   date                  (no transform)
//   note                 →   notes                 (no transform)
//   txn_id               →   id                    (no transform)
//
// ════════════════════════════════════════════════════════════════════

const VERSION = 'v1.2';

const TYPE_TRANSLATION = {
  'borrow': 'debt_in',
  'repay':  'debt_out',
  'income': 'income',
  'expense': 'expense',
  'transfer': 'transfer',
  'opening': 'opening',
  'salary': 'income',
  'cc_spend': 'expense',
  'cc_payment': 'transfer',
  'atm': 'expense'
};

function translateType(sheetType) {
  if (!sheetType) return 'expense';
  const lower = String(sheetType).toLowerCase().trim();
  return TYPE_TRANSLATION[lower] || lower;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Pre-flight: secret must be configured
  if (!env.MIGRATION_SECRET) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'MIGRATION_SECRET env var not configured on Cloudflare Pages — cannot authenticate import requests'
    }, 500);
  }

  // Auth
  const providedSecret = request.headers.get('X-Migration-Secret');
  if (!providedSecret || providedSecret !== env.MIGRATION_SECRET) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Invalid or missing X-Migration-Secret header'
    }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Invalid JSON body: ' + err.message
    }, 400);
  }

  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const debts = Array.isArray(payload.debts) ? payload.debts : [];
  const debtPaidMap = (payload.debt_paid_map && typeof payload.debt_paid_map === 'object') ? payload.debt_paid_map : {};
  const bills = Array.isArray(payload.bills) ? payload.bills : [];

  if (transactions.length > 10000) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Safety cap: cannot import >10000 transactions in one batch (got ' + transactions.length + ')'
    }, 400);
  }

  const stats = {
    accounts_inserted: 0,
    transactions_inserted: 0,
    transactions_translated: 0,
    debts_inserted: 0,
    bills_inserted: 0,
    bills_skipped_no_account: 0,
    type_translation_counts: {}
  };

  try {
    const db = env.DB;
    const statements = [];

    // ── Wipe (atomic with rest of batch — all-or-nothing) ──
    statements.push(db.prepare('DELETE FROM accounts'));
    statements.push(db.prepare('DELETE FROM transactions'));
    statements.push(db.prepare('DELETE FROM debts'));
    statements.push(db.prepare('DELETE FROM bills'));

    // ── Accounts ──
    // Schema: id, name, icon, type, kind, opening_balance, currency, color, display_order, status, credit_limit
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i];
      statements.push(db.prepare(
        `INSERT INTO accounts (id, name, icon, type, kind, opening_balance, currency, color, display_order, status, credit_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        a.id,
        a.name,
        a.icon || null,
        a.kind === 'cc' || a.kind === 'liability' ? 'liability' : 'asset',
        a.kind || 'bank',
        Number(a.opening_balance || 0),
        a.currency || 'PKR',
        a.color || null,
        i + 1,
        'active',
        a.cc_limit != null ? Number(a.cc_limit) : (a.credit_limit != null ? Number(a.credit_limit) : null)
      ));
      stats.accounts_inserted++;
    }

    // ── Transactions ──
    // Schema columns we write: id, date, type, amount, account_id, category_id, notes, created_at
    // Translation: amount_minor (cents) → amount (PKR), borrow/repay → debt_in/debt_out
    for (const t of transactions) {
      const sheetType = t.type;
      const canonicalType = translateType(sheetType);
      stats.type_translation_counts[canonicalType] = (stats.type_translation_counts[canonicalType] || 0) + 1;
      if (sheetType !== canonicalType) stats.transactions_translated++;

      const amountPkr = Number(t.amount_minor || 0) / 100;
      const txnId = t.txn_id || ('TXN-MIG-' + Math.random().toString(36).slice(2, 10));
      const noteText = t.note ? String(t.note).slice(0, 500) : null;

      statements.push(db.prepare(
        `INSERT INTO transactions (id, date, type, amount, account_id, category_id, notes, linked_txn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        txnId,
        t.dt_local || null,
        canonicalType,
        amountPkr,
        t.account_id || null,
        t.category_id || null,
        noteText,
        t.linked_txn_id || null
      ));
      stats.transactions_inserted++;
    }

    // ── Debts ──
    // Schema: id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes
    for (let i = 0; i < debts.length; i++) {
      const d = debts[i];
      const debtId = 'debt_' + (d.name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30) + '_' + i;
      const paidMinor = debtPaidMap[d.name] || 0;
      const paidPkr = paidMinor / 100;
      const originalPkr = Number(d.original_minor || 0) / 100;

      statements.push(db.prepare(
        `INSERT INTO debts (id, name, kind, original_amount, paid_amount, snowball_order, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        debtId,
        d.name,
        d.kind || 'creditor',
        originalPkr,
        paidPkr,
        i + 1,
        'active',
        d.notes || null
      ));
      stats.debts_inserted++;
    }

    // ── Bills ──
    // Schema: id, name, amount, due_day, frequency, category_id, default_account_id, last_paid_date, auto_post, status
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      const billId = 'bill_' + (b.name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30) + '_' + i;
      const amountPkr = Number(b.amount_minor || 0) / 100;

      if (!b.account_id) {
        stats.bills_skipped_no_account++;
        continue;
      }

      statements.push(db.prepare(
        `INSERT INTO bills (id, name, amount, due_day, frequency, default_account_id, last_paid_date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        billId,
        b.name,
        amountPkr,
        b.due_day != null ? Number(b.due_day) : null,
        b.frequency || 'monthly',
        b.account_id,
        b.last_paid_dt || null,
        'active'
      ));
      stats.bills_inserted++;
    }

    // ── Atomic execution ──
    await db.batch(statements);

    return jsonResponse({
      ok: true,
      version: VERSION,
      message: 'Migration complete (atomic). All 4 tables wiped + reinserted.',
      stats: stats,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message,
      stack: err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : null,
      partial_stats: stats
    }, 500);
  }
}

// GET on this endpoint returns 405 (POST-only)
export async function onRequest(context) {
  if (context.request.method === 'POST') {
    return onRequestPost(context);
  }
  return jsonResponse({
    ok: false,
    version: VERSION,
    error: 'Method not allowed — use POST with X-Migration-Secret header'
  }, 405);
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
