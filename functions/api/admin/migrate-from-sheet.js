// /functions/api/admin/migrate-from-sheet.js
// v1.6 — Translate debts.kind ('creditor' → 'owe', 'debtor' → 'owed') per D1 CHECK
//
// CHANGES vs v1.5:
//   - FIX: debts INSERT translates kind field per D1 CHECK constraint
//          ('creditor' → 'owe', 'debtor' → 'owed', default 'owe')
//   - NEW: stats.debt_kind_counts tracks translation distribution
//   - PRESERVED: defer_foreign_keys, child-tables-first cleanup, atomic batch
//   - PRESERVED: amount conversion (cents → PKR via /100)
//   - PRESERVED: transactions type passthrough (D1 CHECK accepts sheet vocab)
//   - PRESERVED: defensive skip for amount<=0 rows
//
// ════════════════════════════════════════════════════════════════════
// SECTION 9 — D1 CHECK CONSTRAINTS (ALL VERIFIED 2026-05-06)
// ════════════════════════════════════════════════════════════════════
// accounts.type:      ('asset', 'liability')
// transactions.type:  ('expense','income','transfer','cc_payment','cc_spend',
//                      'borrow','repay','atm')
// transactions.amount: > 0
// debts.kind:         ('owe', 'owed')   ← NEW translation in v1.6
// bills:              no CHECK constraints
//
// FKs noted:
//   transactions.account_id → accounts(id)
//   transactions.transfer_to_account_id → accounts(id)
//   transactions.category_id → categories(id)
//   bills.category_id → categories(id)
//   bills.default_account_id → accounts(id)
// FK enforcement deferred until end-of-batch via PRAGMA defer_foreign_keys.
// ════════════════════════════════════════════════════════════════════

const VERSION = 'v1.6';

// Translation map for debts.kind (sheet → D1 CHECK)
const DEBT_KIND_TRANSLATION = {
  'creditor': 'owe',   // operator owes them
  'debtor':   'owed'   // they owe operator
};

function translateDebtKind(sheetKind) {
  if (!sheetKind) return 'owe';
  const lower = String(sheetKind).toLowerCase().trim();
  return DEBT_KIND_TRANSLATION[lower] || 'owe';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.MIGRATION_SECRET) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'MIGRATION_SECRET env var not configured on Cloudflare Pages'
    }, 500);
  }

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

  const accounts     = Array.isArray(payload.accounts)     ? payload.accounts     : [];
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const debts        = Array.isArray(payload.debts)        ? payload.debts        : [];
  const debtPaidMap  = (payload.debt_paid_map && typeof payload.debt_paid_map === 'object') ? payload.debt_paid_map : {};
  const bills        = Array.isArray(payload.bills)        ? payload.bills        : [];

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
    transactions_skipped_zero_amount: 0,
    debts_inserted: 0,
    debt_kind_counts: {},
    bills_inserted: 0,
    bills_skipped_no_account: 0,
    type_counts: {}
  };

  try {
    const db = env.DB;
    const statements = [];

    // ── FK fix: defer enforcement until end of batch ──
    statements.push(db.prepare('PRAGMA defer_foreign_keys = ON'));

    // ── Wipe child tables FIRST (verified to exist via sqlite_master 2026-05-05) ──
    statements.push(db.prepare('DELETE FROM audit_log'));
    statements.push(db.prepare('DELETE FROM merchants'));
    statements.push(db.prepare('DELETE FROM categories'));
    statements.push(db.prepare('DELETE FROM snapshot_data'));
    statements.push(db.prepare('DELETE FROM snapshots'));
    statements.push(db.prepare('DELETE FROM reconciliation'));
    statements.push(db.prepare('DELETE FROM goals'));
    statements.push(db.prepare('DELETE FROM budgets'));
    statements.push(db.prepare('DELETE FROM settings'));

    // ── Wipe parent tables ──
    statements.push(db.prepare('DELETE FROM transactions'));
    statements.push(db.prepare('DELETE FROM bills'));
    statements.push(db.prepare('DELETE FROM debts'));
    statements.push(db.prepare('DELETE FROM accounts'));

    // ── INSERT accounts FIRST (parent for transactions/bills FK) ──
    // Schema: id, name, icon, type, kind, opening_balance, currency, color, display_order, status, credit_limit
    // CHECK: type IN ('asset','liability')
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

    // ── INSERT transactions ──
    // Schema: id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, linked_txn_id
    // CHECK: type IN (8-value vocab) + amount > 0
    // FK: account_id REFERENCES accounts(id)
    for (const t of transactions) {
      const sheetType = (t.type || 'expense').toLowerCase().trim();
      const amountPkr = Number(t.amount_minor || 0) / 100;

      if (amountPkr <= 0) {
        stats.transactions_skipped_zero_amount++;
        continue;
      }

      stats.type_counts[sheetType] = (stats.type_counts[sheetType] || 0) + 1;

      const txnId = t.txn_id || ('TXN-MIG-' + Math.random().toString(36).slice(2, 10));
      const noteText = t.note ? String(t.note).slice(0, 500) : null;

      statements.push(db.prepare(
        `INSERT INTO transactions (id, date, type, amount, account_id, category_id, notes, linked_txn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        txnId,
        t.dt_local || null,
        sheetType,
        amountPkr,
        t.account_id || null,
        t.category_id || null,
        noteText,
        t.linked_txn_id || null
      ));
      stats.transactions_inserted++;
    }

    // ── INSERT debts ──
    // Schema: id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes
    // CHECK: kind IN ('owe','owed')   ← NEW v1.6 translation
    for (let i = 0; i < debts.length; i++) {
      const d = debts[i];
      const debtId = 'debt_' + (d.name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30) + '_' + i;
      const paidMinor = debtPaidMap[d.name] || 0;
      const paidPkr = paidMinor / 100;
      const originalPkr = Number(d.original_minor || 0) / 100;
      const d1Kind = translateDebtKind(d.kind);

      stats.debt_kind_counts[d1Kind] = (stats.debt_kind_counts[d1Kind] || 0) + 1;

      statements.push(db.prepare(
        `INSERT INTO debts (id, name, kind, original_amount, paid_amount, snowball_order, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        debtId,
        d.name,
        d1Kind,
        originalPkr,
        paidPkr,
        i + 1,
        'active',
        d.notes || null
      ));
      stats.debts_inserted++;
    }

    // ── INSERT bills ──
    // Schema: id, name, amount, due_day, frequency, default_account_id, last_paid_date, status
    // No CHECK constraints
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

    // ── Re-enable FK enforcement ──
    statements.push(db.prepare('PRAGMA defer_foreign_keys = OFF'));

    // ── Atomic execution ──
    await db.batch(statements);

    return jsonResponse({
      ok: true,
      version: VERSION,
      message: 'Migration complete (atomic, FK-safe, debts.kind translated).',
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
