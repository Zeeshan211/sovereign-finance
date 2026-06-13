/* Sovereign Finance — Statement Reconciliation v0.2
 * POST /api/reconciliation/import-statement
 * contract_version: reconciliation-v0.2
 *
 * Accepts CSV paste: date,description,debit,credit,balance
 * Stores rows in statement_imports + statement_transactions.
 * NEVER writes to ledger. Period.
 */

import { getUserId } from '../_lib.js';

const VERSION = 'v0.2.0-statement-reconciliation';
const CONTRACT_VERSION = 'reconciliation-v0.2';

export async function onRequestPost(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json(authErr(), 401);

    const db = context.env.DB;
    if (!db) return json(dbErr(), 500);

    const body = await readJson(context.request);
    const accountId = clean(body.account_id);
    const csvText   = clean(body.csv_text || body.csv || '');
    const createdBy = clean(body.created_by || 'web');

    if (!accountId) return json(validErr('account_id is required', 'ACCOUNT_ID_REQUIRED'), 400);
    if (!csvText)   return json(validErr('csv_text is required',   'CSV_REQUIRED'), 400);

    const account = await db.prepare(
      'SELECT id, name FROM accounts WHERE id = ? AND user_id = ? LIMIT 1'
    ).bind(accountId, userId).first();
    if (!account) return json(validErr(`Account not found: ${accountId}`, 'ACCOUNT_NOT_FOUND'), 404);

    const parsed = parseCsv(csvText);
    if (!parsed.ok) return json(validErr(parsed.error, 'CSV_PARSE_ERROR'), 400);
    if (!parsed.rows.length) return json(validErr('CSV contains no data rows', 'CSV_EMPTY'), 400);

    await ensureStatementTables(db);

    const now      = nowSql();
    const importId = `stmt_${Date.now()}_${rand()}`;
    const rows     = parsed.rows;
    const dateFrom = rows[0].posted_date;
    const dateTo   = rows[rows.length - 1].posted_date;
    const closingBalance = rows[rows.length - 1].balance;

    const stmtRows = rows.map((row, i) => {
      const amount = row.debit != null ? row.debit : (row.credit ?? 0);
      return {
        id:              `stmtx_${Date.now()}_${i}_${rand()}`,
        import_id:       importId,
        account_id:      accountId,
        posted_date:     row.posted_date,
        description:     row.description,
        debit:           row.debit  ?? null,
        credit:          row.credit ?? null,
        balance:         row.balance ?? null,
        idempotency_key: buildIdemKey(accountId, row.posted_date, amount, row.description)
      };
    });

    const insertImport = db.prepare(
      `INSERT INTO statement_imports
         (id, account_id, imported_at, row_count, date_from, date_to,
          statement_closing_balance, raw_csv, created_by, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      importId, accountId, now, rows.length,
      dateFrom, dateTo, closingBalance,
      csvText.slice(0, 50000), createdBy, now, userId
    );

    const insertRowStmts = stmtRows.map(r =>
      db.prepare(
        `INSERT OR IGNORE INTO statement_transactions
           (id, import_id, account_id, posted_date, description,
            debit, credit, balance, idempotency_key, created_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        r.id, r.import_id, r.account_id, r.posted_date, r.description,
        r.debit, r.credit, r.balance, r.idempotency_key, now, userId
      )
    );

    await db.batch([insertImport, ...insertRowStmts]);

    return json({
      ok:                       true,
      version:                  VERSION,
      contract_version:         CONTRACT_VERSION,
      action:                   'import_statement',
      writes_performed:         true,
      import_id:                importId,
      account_id:               accountId,
      account_name:             account.name,
      row_count:                rows.length,
      date_from:                dateFrom,
      date_to:                  dateTo,
      statement_closing_balance: closingBalance,
      rows_preview: stmtRows.slice(0, 5).map(r => ({
        posted_date:     r.posted_date,
        description:     r.description,
        debit:           r.debit,
        credit:          r.credit,
        balance:         r.balance,
        amount:          r.debit != null ? -r.debit : (r.credit ?? 0),
        idempotency_key: r.idempotency_key
      })),
      next_step: {
        endpoint: 'POST /api/reconciliation/dry-run',
        body:     { import_id: importId, account_id: accountId }
      },
      contract: {
        mutates_ledger:              false,
        mutates_accounts:            false,
        mutates_transactions:        false,
        writes_statement_imports:    true,
        writes_statement_transactions: true
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

/* ─── CSV Parsing ─── */

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    return { ok: false, error: 'CSV must have a header row and at least one data row' };
  }

  const rawHeader = parseCsvLine(lines[0]);
  const header = rawHeader.map(h => h.toLowerCase().trim().replace(/[^a-z0-9]/g, '_'));

  const findCol = (aliases) => {
    for (const alias of aliases) {
      const i = header.findIndex(h => h === alias);
      if (i !== -1) return i;
    }
    return -1;
  };

  const dateIdx    = findCol(['date', 'posted_date', 'value_date', 'txn_date', 'transaction_date']);
  const descIdx    = findCol(['description', 'narration', 'particulars', 'remarks', 'details', 'desc']);
  const debitIdx   = findCol(['debit', 'withdrawal', 'dr', 'debit_amount', 'withdrawals']);
  const creditIdx  = findCol(['credit', 'deposit', 'cr', 'credit_amount', 'deposits']);
  const balanceIdx = findCol(['balance', 'running_balance', 'closing_balance', 'bal']);

  if (dateIdx  === -1) return { ok: false, error: 'CSV must have a "date" column' };
  if (descIdx  === -1) return { ok: false, error: 'CSV must have a "description" column' };
  if (debitIdx === -1 && creditIdx === -1) return { ok: false, error: 'CSV must have a "debit" or "credit" column' };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols.length) continue;
    const rawDate    = clean(cols[dateIdx]  ?? '');
    const posted_date = normalizeDate(rawDate);
    if (!posted_date) continue;
    rows.push({
      posted_date,
      description: clean(cols[descIdx]    ?? ''),
      debit:       parseAmount(cols[debitIdx]),
      credit:      parseAmount(cols[creditIdx]),
      balance:     parseAmount(cols[balanceIdx])
    });
  }

  return { ok: true, rows };
}

function parseCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseAmount(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).replace(/,/g, '').replace(/rs\.?/ig, '').trim();
  if (!s || s === '-' || s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/* ─── Idempotency Key ─── */

function buildIdemKey(accountId, date, amount, description) {
  const normalizedDesc = String(description || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32);
  const hash = simpleHash(normalizedDesc).toString(16).padStart(8, '0');
  return `recon:${accountId}:${date}:${amount}:${hash}`;
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h >>> 0;
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

function authErr() {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: 'Unauthorized', code: 'UNAUTHORIZED' };
}

function dbErr() {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: 'DB binding missing', code: 'DB_BINDING_MISSING' };
}

function validErr(message, code) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    action: 'import_statement', error: message, code, writes_performed: false };
}

function srvErr(e) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: e.message || String(e), code: 'INTERNAL_ERROR' };
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return '';
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
