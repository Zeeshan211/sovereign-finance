/* Sovereign Finance — Statement Reconciliation v0.2
 * POST /api/reconciliation/dry-run
 * contract_version: reconciliation-v0.2
 *
 * Runs matching engine against the ledger.
 * Returns a reconciliation plan with 8 classifications.
 * NEVER writes to ledger. Period.
 *
 * Classifications:
 *   MATCHED_EXISTING      — statement row has a matching ledger entry
 *   MISSING_SAFE_TO_IMPORT — statement row has no ledger match, safe to add
 *   POSSIBLE_DUPLICATE    — 2 statement rows match 1 ledger row
 *   TRANSFER_PAIR_FOUND   — outflow/inflow matches a transaction in another account
 *   TRANSFER_PAIR_MISSING — description hints at a transfer, no other account match
 *   NEEDS_REVIEW          — amount candidates found but date/description mismatch
 *   PENDING_UNPOSTED      — ledger entry in last 3 days with no statement counterpart
 *   DO_NOT_IMPORT         — reserved for Phase 2 commit logic
 */

import { getUserId } from '../_lib.js';

const VERSION          = 'v0.2.0-statement-reconciliation';
const CONTRACT_VERSION = 'reconciliation-v0.2';

const POSITIVE_TYPES = new Set(['income', 'salary', 'opening', 'borrow', 'debt_in']);
const NEGATIVE_TYPES = new Set(['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment']);

export async function onRequestPost(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

    const db = context.env.DB;
    if (!db) return json(dbErr(), 500);

    const body      = await readJson(context.request);
    const importId  = clean(body.import_id);
    const accountId = clean(body.account_id);

    if (!importId)  return json(validErr('import_id is required',  'IMPORT_ID_REQUIRED'),  400);
    if (!accountId) return json(validErr('account_id is required', 'ACCOUNT_ID_REQUIRED'), 400);

    await ensureStatementTables(db);

    const importRow = await db.prepare(
      `SELECT * FROM statement_imports WHERE id = ? AND account_id = ? AND user_id = ? LIMIT 1`
    ).bind(importId, accountId, userId).first().catch(() => null);
    if (!importRow) return json(validErr(`Import not found: ${importId}`, 'IMPORT_NOT_FOUND'), 404);

    const stmtRes  = await db.prepare(
      `SELECT * FROM statement_transactions WHERE import_id = ? ORDER BY posted_date, id`
    ).bind(importId).all();
    const stmtRows = stmtRes.results || [];
    if (!stmtRows.length) return json(validErr('No statement rows found for this import', 'NO_STATEMENT_ROWS'), 400);

    const dateFrom = addDays(importRow.date_from, -5);
    const dateTo   = addDays(importRow.date_to,    5);

    const ledgerRes = await db.prepare(
      `SELECT id, type, amount, date, notes, account_id, transfer_to_account_id,
              reversed_by, reversed_at
       FROM transactions
       WHERE account_id = ? AND user_id = ? AND date >= ? AND date <= ?
       ORDER BY date, id`
    ).bind(accountId, userId, dateFrom, dateTo).all();
    const ledgerRows = (ledgerRes.results || []).filter(l => !isReversed(l));

    const ledgerOtherRes = await db.prepare(
      `SELECT id, type, amount, date, notes, account_id, transfer_to_account_id,
              reversed_by, reversed_at
       FROM transactions
       WHERE account_id != ? AND user_id = ? AND date >= ? AND date <= ?
       ORDER BY date, id`
    ).bind(accountId, userId, dateFrom, dateTo).all();
    const ledgerOtherRows = (ledgerOtherRes.results || []).filter(l => !isReversed(l));

    const account    = await db.prepare('SELECT id, name FROM accounts WHERE id = ? AND user_id = ? LIMIT 1').bind(accountId, userId).first().catch(() => null);
    const appBalance = await computeAppBalance(db, accountId, userId);

    const plan = runMatchingEngine(stmtRows, ledgerRows, ledgerOtherRows);

    const matchedLedgerIds = new Set(plan.filter(p => p.matched_ledger_id).map(p => p.matched_ledger_id));
    const today        = todayISO();
    const threeDaysAgo = addDays(today, -3);
    for (const l of ledgerRows) {
      if (matchedLedgerIds.has(l.id)) continue;
      if (l.date >= threeDaysAgo && l.date <= today) {
        plan.push({
          classification:    'PENDING_UNPOSTED',
          statement_row:     null,
          matched_ledger_id: l.id,
          matched_ledger:    fmtLedger(l),
          match_type:        'pending_unposted',
          reason:            'Ledger entry posted in last 3 days with no statement counterpart'
        });
      }
    }

    const classification_counts = {};
    for (const item of plan) {
      classification_counts[item.classification] = (classification_counts[item.classification] || 0) + 1;
    }

    const closingBalance = importRow.statement_closing_balance;
    const drift = closingBalance != null ? round2(appBalance - closingBalance) : null;

    const planId = `recon_plan_${Date.now()}_${rand()}`;
    try {
      await db.prepare(
        `INSERT INTO reconciliation_plans (id, import_id, account_id, plan_json, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(planId, importId, accountId, JSON.stringify({ plan, classification_counts }), nowSql(), userId).run();
    } catch (_) {}

    return json({
      ok:                    true,
      version:               VERSION,
      contract_version:      CONTRACT_VERSION,
      action:                'reconciliation.dry_run',
      writes_performed:      false,
      plan_id:               planId,
      import_id:             importId,
      account_id:            accountId,
      account_name:          account?.name || accountId,
      statement_rows:        stmtRows.length,
      ledger_rows_checked:   ledgerRows.length,
      projected_balance:     closingBalance,
      app_balance_now:       appBalance,
      drift,
      classification_counts,
      plan,
      contract: {
        mutates_ledger:       false,
        mutates_accounts:     false,
        mutates_transactions: false,
        dry_run:              true,
        commit_supported:     false,
        classifications: [
          'MATCHED_EXISTING', 'MISSING_SAFE_TO_IMPORT', 'POSSIBLE_DUPLICATE',
          'TRANSFER_PAIR_FOUND', 'TRANSFER_PAIR_MISSING',
          'NEEDS_REVIEW', 'PENDING_UNPOSTED', 'DO_NOT_IMPORT'
        ]
      }
    });
  } catch (e) {
    return json(srvErr(e), 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

/* ─── Matching Engine ─── */

function runMatchingEngine(stmtRows, ledgerRows, ledgerOtherRows) {
  const plan           = [];
  const usedLedgerIds  = new Set();
  const ledgerMatchMap = new Map(); // ledgerId → count of stmt rows that can match it

  const stmtCandidates = stmtRows.map(stmt => {
    const stmtAmount = stmt.debit != null ? stmt.debit : (stmt.credit ?? 0);
    const isDebit    = stmt.debit != null;
    const candidates = ledgerRows.filter(l => {
      const la = Math.abs(l.amount || 0);
      if (Math.abs(la - stmtAmount) > 0.005) return false;
      const t = (l.type || '').toLowerCase();
      if (isDebit  && !NEGATIVE_TYPES.has(t)) return false;
      if (!isDebit && !POSITIVE_TYPES.has(t)) return false;
      return true;
    });
    for (const l of candidates) {
      ledgerMatchMap.set(l.id, (ledgerMatchMap.get(l.id) || 0) + 1);
    }
    return { stmt, stmtAmount, isDebit, candidates };
  });

  for (const { stmt, stmtAmount, isDebit, candidates } of stmtCandidates) {
    if (!candidates.length) {
      const transferResult = findTransfer(stmt, stmtAmount, isDebit, ledgerOtherRows, usedLedgerIds);
      if (transferResult) {
        plan.push({
          classification:    transferResult.classification,
          statement_row:     fmtStmt(stmt),
          matched_ledger_id: transferResult.ledger?.id || null,
          matched_ledger:    transferResult.ledger ? fmtLedger(transferResult.ledger) : null,
          match_type:        'transfer',
          other_account_id:  transferResult.ledger?.account_id || null,
          reason:            transferResult.reason || null
        });
        if (transferResult.ledger) usedLedgerIds.add(transferResult.ledger.id);
      } else {
        plan.push({
          classification:    'MISSING_SAFE_TO_IMPORT',
          statement_row:     fmtStmt(stmt),
          matched_ledger_id: null,
          matched_ledger:    null,
          match_type:        null,
          suggested_type:    isDebit ? 'expense' : 'income',
          reason:            'No matching ledger transaction found'
        });
      }
      continue;
    }

    let bestMatch = null;
    let matchType = null;

    for (const l of candidates) {
      if (usedLedgerIds.has(l.id)) continue;
      if (Math.abs(dateDiff(stmt.posted_date, l.date)) <= 2) {
        if (descOverlap(stmt.description, l.notes) >= 0.6) {
          bestMatch = l;
          matchType = 'exact';
          break;
        }
      }
    }

    if (!bestMatch) {
      for (const l of candidates) {
        if (usedLedgerIds.has(l.id)) continue;
        if (Math.abs(dateDiff(stmt.posted_date, l.date)) <= 5) {
          bestMatch = l;
          matchType = 'fuzzy';
          break;
        }
      }
    }

    if (bestMatch) {
      const isDuplicate = (ledgerMatchMap.get(bestMatch.id) || 1) > 1;
      plan.push({
        classification:       isDuplicate ? 'POSSIBLE_DUPLICATE' : 'MATCHED_EXISTING',
        statement_row:        fmtStmt(stmt),
        matched_ledger_id:    bestMatch.id,
        matched_ledger:       fmtLedger(bestMatch),
        match_type:           matchType,
        days_diff:            Math.abs(dateDiff(stmt.posted_date, bestMatch.date)),
        description_overlap:  round2(descOverlap(stmt.description, bestMatch.notes)),
        duplicate_warning:    isDuplicate ? 'Multiple statement rows matched this ledger entry' : null
      });
      usedLedgerIds.add(bestMatch.id);
    } else {
      plan.push({
        classification:    'NEEDS_REVIEW',
        statement_row:     fmtStmt(stmt),
        matched_ledger_id: null,
        matched_ledger:    null,
        match_type:        null,
        reason:            'Amount candidates found but date/description mismatch exceeds thresholds'
      });
    }
  }

  return plan;
}

function findTransfer(stmt, stmtAmount, isDebit, ledgerOtherRows, usedLedgerIds) {
  const candidates = ledgerOtherRows.filter(l => {
    if (usedLedgerIds.has(l.id)) return false;
    if (Math.abs(Math.abs(l.amount || 0) - stmtAmount) > 0.005) return false;
    const t = (l.type || '').toLowerCase();
    if (isDebit  && !POSITIVE_TYPES.has(t) && t !== 'transfer') return false;
    if (!isDebit && !NEGATIVE_TYPES.has(t) && t !== 'transfer') return false;
    return true;
  });

  for (const l of candidates) {
    if (Math.abs(dateDiff(stmt.posted_date, l.date)) <= 2) {
      return { classification: 'TRANSFER_PAIR_FOUND', ledger: l, reason: null };
    }
  }
  for (const l of candidates) {
    if (Math.abs(dateDiff(stmt.posted_date, l.date)) <= 5) {
      return { classification: 'TRANSFER_PAIR_FOUND', ledger: l, reason: 'Fuzzy date match' };
    }
  }

  const TRANSFER_KEYWORDS = ['ibft', 'transfer', 'trf', 'tfr', 'inter-bank', 'interbank', 'ift'];
  const desc = (stmt.description || '').toLowerCase();
  if (TRANSFER_KEYWORDS.some(kw => desc.includes(kw))) {
    return {
      classification: 'TRANSFER_PAIR_MISSING',
      ledger:         null,
      reason:         'Description suggests transfer but no matching ledger entry in other accounts'
    };
  }

  return null;
}

/* ─── App Balance ─── */

async function computeAppBalance(db, accountId, userId) {
  try {
    const res = await db.prepare(
      `SELECT type, amount, reversed_by, reversed_at, notes
       FROM transactions WHERE account_id = ? AND user_id = ?`
    ).bind(accountId, userId).all();

    let balance = 0;
    for (const tx of res.results || []) {
      if (isReversed(tx)) continue;
      const t      = (tx.type || '').toLowerCase();
      const amount = Math.abs(tx.amount || 0);
      if (POSITIVE_TYPES.has(t))      balance += amount;
      else if (NEGATIVE_TYPES.has(t)) balance -= amount;
    }
    return round2(balance);
  } catch (_) {
    return 0;
  }
}

function isReversed(tx) {
  if (tx.reversed_by || tx.reversed_at) return true;
  const notes = String(tx.notes || '').toUpperCase();
  return notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY ');
}

/* ─── Description Overlap (Jaccard) ─── */

function descOverlap(desc1, desc2) {
  const t1 = tokenize(desc1);
  const t2 = tokenize(desc2);
  if (t1.size === 0 && t2.size === 0) return 1;
  if (t1.size === 0 || t2.size === 0) return 0;
  let intersect = 0;
  for (const t of t1) { if (t2.has(t)) intersect++; }
  return intersect / (t1.size + t2.size - intersect);
}

function tokenize(desc) {
  if (!desc) return new Set();
  return new Set(
    String(desc).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3)
  );
}

/* ─── Date Helpers ─── */

function dateDiff(d1, d2) {
  return Math.round((new Date(d2 + 'T00:00:00Z') - new Date(d1 + 'T00:00:00Z')) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date((dateStr || todayISO()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ─── Formatters ─── */

function fmtStmt(r) {
  return {
    id:          r.id,
    posted_date: r.posted_date,
    description: r.description,
    debit:       r.debit,
    credit:      r.credit,
    balance:     r.balance,
    amount:      r.debit != null ? -(r.debit) : (r.credit ?? 0)
  };
}

function fmtLedger(l) {
  return {
    id:                     l.id,
    date:                   l.date,
    type:                   l.type,
    amount:                 l.amount,
    account_id:             l.account_id,
    notes:                  l.notes,
    transfer_to_account_id: l.transfer_to_account_id || null
  };
}

/* ─── Table Bootstrap ─── */

async function ensureStatementTables(db) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS statement_imports (
       id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
       imported_at TEXT NOT NULL, row_count INTEGER NOT NULL DEFAULT 0,
       date_from TEXT, date_to TEXT, statement_closing_balance REAL,
       raw_csv TEXT, created_by TEXT DEFAULT 'web',
       created_at TEXT DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS statement_transactions (
       id TEXT PRIMARY KEY, import_id TEXT NOT NULL,
       account_id TEXT NOT NULL, posted_date TEXT NOT NULL,
       description TEXT, debit REAL, credit REAL, balance REAL,
       idempotency_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_txn_idem
       ON statement_transactions(idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_stmt_txn_account ON statement_transactions(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stmt_txn_import  ON statement_transactions(import_id)`,
    `CREATE TABLE IF NOT EXISTS reconciliation_plans (
       id TEXT PRIMARY KEY, import_id TEXT NOT NULL,
       account_id TEXT NOT NULL, plan_json TEXT NOT NULL,
       created_at TEXT DEFAULT CURRENT_TIMESTAMP,
       committed_at TEXT, committed_by TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_recon_plan_import  ON reconciliation_plans(import_id)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_plan_account ON reconciliation_plans(account_id)`
  ];
  for (const sql of ddl) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

/* ─── Generic Helpers ─── */

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function dbErr() {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: 'DB binding missing', code: 'DB_BINDING_MISSING' };
}

function validErr(message, code) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    action: 'reconciliation.dry_run', error: message, code, writes_performed: false };
}

function srvErr(e) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: e.message || String(e), code: 'INTERNAL_ERROR' };
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function rand() {
  return Math.random().toString(36).slice(2, 8);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
