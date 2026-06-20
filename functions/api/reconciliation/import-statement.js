/* Sovereign Finance — Statement Reconciliation v0.4
 * POST /api/reconciliation/import-statement
 * contract_version: reconciliation-v0.3
 *
 * Accepts two paste formats, either as a single block (legacy, account_id
 * given in the request body) or as a MULTI-ACCOUNT paste with one block per
 * account, delimited by a "## ACCOUNT: <Name>" header line:
 *
 *   ## ACCOUNT: Meezan Current
 *   DATE | DESCRIPTION | AMOUNT | BALANCE
 *   ...
 *   # count=N opening=O closing=C
 *
 *   ## ACCOUNT: HBL Savings
 *   ...
 *
 *   1. Pipe (preferred, self-verifying):
 *        DATE | DESCRIPTION | AMOUNT | BALANCE     (AMOUNT signed: - out, + in)
 *        # count=N opening=O closing=C             (optional checksum footer)
 *      Verified by continuity (balance[i]-balance[i-1] == amount[i]) and
 *      envelope (opening + Σamount == closing, rowcount == count) BEFORE any
 *      storage. A failed checksum rejects the whole paste and names the row.
 *   2. CSV (fallback): date,description,debit,credit,balance
 *
 * Each detected account block is resolved against the user's own accounts by
 * name (case-insensitive substring match). Unresolvable blocks are returned
 * as per-block errors WITHOUT aborting the other blocks in the same paste.
 *
 * Stores rows in statement_imports + statement_transactions.
 * NEVER writes to ledger. Period.
 */

import { getUserId } from '../_lib.js';

const VERSION = 'v0.4.0-multi-account-paste';
const CONTRACT_VERSION = 'reconciliation-v0.3';

const ACCOUNT_HEADER_RE = /^##\s*ACCOUNT\s*:\s*(.+?)\s*$/im;

export async function onRequestPost(context) {
  try {
    const userId = getUserId(context);
    if (!userId) return json(authErr(), 401);

    const db = context.env.DB;
    if (!db) return json(dbErr(), 500);

    const body       = await readJson(context.request);
    const rawAccountId = clean(body.account_id);
    const csvText    = clean(body.statement_text || body.text || body.csv_text || body.csv || '');
    const createdBy  = clean(body.created_by || 'web');
    const explicitFmt = body.format;

    if (!csvText) return json(validErr('statement_text is required', 'STATEMENT_REQUIRED'), 400);

    await ensureStatementTables(db);

    const ownAccounts = await db.prepare(
      'SELECT id, name FROM accounts WHERE user_id = ? AND (status = \'active\' OR status IS NULL)'
    ).bind(userId).all().then(r => r.results || []).catch(() => []);

    const blocks = splitAccountBlocks(csvText);

    // Single legacy block with no "## ACCOUNT:" header — resolve via account_id.
    if (blocks.length === 1 && blocks[0].accountName === null) {
      if (!rawAccountId) return json(validErr('account_id is required', 'ACCOUNT_ID_REQUIRED'), 400);
      const account = ownAccounts.find(a => a.id === rawAccountId);
      if (!account) return json(validErr(`Account not found: ${rawAccountId}`, 'ACCOUNT_NOT_FOUND'), 404);
      const result = await processBlock(db, {
        userId, createdBy, accountId: account.id, accountName: account.name,
        text: blocks[0].text, explicitFmt
      });
      if (!result.ok) return json(validErr(result.error, result.code || 'PARSE_ERROR'), 400);
      return json(singleResultBody(result.value));
    }

    // Multi-account paste: resolve each block's header name against the
    // user's own accounts; process independently so one bad block doesn't
    // sink the others.
    const results = [];
    for (const block of blocks) {
      const account = resolveAccountByName(ownAccounts, block.accountName);
      if (!account) {
        results.push({
          ok: false, account_name: block.accountName,
          error: `No account found matching "${block.accountName}"`,
          code: 'ACCOUNT_NOT_FOUND'
        });
        continue;
      }
      const result = await processBlock(db, {
        userId, createdBy, accountId: account.id, accountName: account.name,
        text: block.text, explicitFmt
      });
      results.push(result.ok
        ? { ok: true, ...result.value }
        : { ok: false, account_id: account.id, account_name: account.name, error: result.error, code: result.code || 'PARSE_ERROR' });
    }

    const succeeded = results.filter(r => r.ok);
    const failed    = results.filter(r => !r.ok);

    return json({
      ok:                succeeded.length > 0,
      version:           VERSION,
      contract_version:  CONTRACT_VERSION,
      action:            'import_statement_batch',
      writes_performed:  succeeded.length > 0,
      imports:           results,
      imported_count:    succeeded.length,
      failed_count:       failed.length,
      next_step: succeeded.length ? {
        endpoint: 'POST /api/reconciliation/dry-run',
        body: { import_ids: succeeded.map(r => r.import_id) }
      } : null,
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

// Split a paste into blocks. If no "## ACCOUNT:" header is present anywhere,
// returns a single block with accountName: null (legacy single-account mode).
function splitAccountBlocks(text) {
  const lines = String(text).split(/\r?\n/);
  const headerIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ACCOUNT_HEADER_RE);
    if (m) headerIdxs.push({ i, name: m[1].trim() });
  }
  if (!headerIdxs.length) return [{ accountName: null, text }];

  const blocks = [];
  for (let h = 0; h < headerIdxs.length; h++) {
    const start = headerIdxs[h].i + 1;
    const end   = h + 1 < headerIdxs.length ? headerIdxs[h + 1].i : lines.length;
    blocks.push({ accountName: headerIdxs[h].name, text: lines.slice(start, end).join('\n') });
  }
  return blocks;
}

// Case-insensitive substring match, either direction (header name may be a
// shortened/longer form of the account's stored name).
function resolveAccountByName(accounts, headerName) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(headerName);
  if (!target) return null;
  let best = null;
  for (const a of accounts) {
    const n = norm(a.name);
    if (n === target) return a;
    if ((n.includes(target) || target.includes(n)) && !best) best = a;
  }
  return best;
}

// Parse + verify + store a single account's block. Returns {ok, value} or
// {ok:false, error, code}.
async function processBlock(db, { userId, createdBy, accountId, accountName, text, explicitFmt }) {
  const blockText = clean(text);
  if (!blockText) return { ok: false, error: 'Statement contains no data rows', code: 'STATEMENT_EMPTY' };

  const fmt    = detectFormat(explicitFmt, blockText);
  const parsed = fmt === 'pipe' ? parsePipe(blockText) : parseCsv(blockText);
  if (!parsed.ok) return { ok: false, error: parsed.error, code: parsed.code };
  if (!parsed.rows.length) return { ok: false, error: 'Statement contains no data rows', code: 'STATEMENT_EMPTY' };

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
      idempotency_key: buildIdemKey(accountId, row.posted_date, amount, row.description, importId, i)
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
    blockText.slice(0, 50000), createdBy, now, userId
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

  return {
    ok: true,
    value: {
      import_id:                importId,
      account_id:               accountId,
      account_name:             accountName,
      format:                   fmt,
      checksum:                 parsed.checksum || null,
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
      }))
    }
  };
}

function singleResultBody(value) {
  return {
    ok:                true,
    version:           VERSION,
    contract_version:  CONTRACT_VERSION,
    action:            'import_statement',
    writes_performed:  true,
    ...value,
    next_step: {
      endpoint: 'POST /api/reconciliation/dry-run',
      body:     { import_id: value.import_id, account_id: value.account_id }
    },
    contract: {
      mutates_ledger:              false,
      mutates_accounts:            false,
      mutates_transactions:        false,
      writes_statement_imports:    true,
      writes_statement_transactions: true
    }
  };
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

/* ─── Pipe format + checksum verification (Phase 1) ─── */

// Auto-detect: explicit body.format wins; otherwise a '|' in the first
// non-comment line means pipe, else CSV.
function detectFormat(explicit, text) {
  const f = clean(explicit).toLowerCase();
  if (f === 'pipe' || f === 'csv') return f;
  const firstData = String(text).split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#'));
  return firstData && firstData.includes('|') ? 'pipe' : 'csv';
}

const paisa = (x) => Math.round((x || 0) * 100);

// Parse + verify the pipe format. Returns rows in the SAME internal shape as
// parseCsv (posted_date/description/debit/credit/balance) so all downstream
// storage code is unchanged. On any checksum failure, returns ok:false with a
// message naming the exact offending row — and writes nothing.
function parsePipe(text) {
  const allLines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let footer = null;
  const dataLines = [];

  for (const line of allLines) {
    if (line.startsWith('#')) {
      const m = line.match(/count\s*=\s*(\d+)/i);
      const o = line.match(/opening\s*=\s*(-?[\d.,]+)/i);
      const c = line.match(/closing\s*=\s*(-?[\d.,]+)/i);
      footer = {
        count:   m ? parseInt(m[1], 10) : null,
        opening: o ? parseAmount(o[1]) : null,
        closing: c ? parseAmount(c[1]) : null
      };
      continue;
    }
    dataLines.push(line);
  }

  const parsed = [];
  for (let i = 0; i < dataLines.length; i++) {
    const parts = dataLines[i].split('|').map(p => p.trim());
    if (parts.length < 3) {
      // Tolerate a header row at the very top (no parseable date).
      if (i === 0 && !normalizeDate(parts[0])) continue;
      return { ok: false, code: 'PIPE_MALFORMED_ROW',
        error: `Row ${i + 1} ("${dataLines[i]}") must be DATE | DESCRIPTION | AMOUNT | BALANCE` };
    }
    const posted_date = normalizeDate(parts[0]);
    if (!posted_date) {
      if (i === 0) continue; // header row — skip silently
      return { ok: false, code: 'PIPE_BAD_DATE',
        error: `Row ${i + 1} ("${dataLines[i]}") has an unrecognized date "${parts[0]}"` };
    }
    const amount = parseAmount(parts[2]);
    if (amount === null) {
      return { ok: false, code: 'PIPE_BAD_AMOUNT',
        error: `Row ${i + 1} (${posted_date}) has an unreadable AMOUNT "${parts[2]}". Use a signed number, e.g. -850.00 or +3000.00` };
    }
    const balance = parts.length >= 4 ? parseAmount(parts[3]) : null;
    parsed.push({ posted_date, description: parts[1] || '', amount, balance, line: dataLines[i] });
  }

  if (!parsed.length) return { ok: true, rows: [], checksum: null };

  const verify = verifyChecksum(parsed, footer);
  if (!verify.ok) return verify;

  const rows = parsed.map(r => ({
    posted_date: r.posted_date,
    description: r.description,
    debit:  r.amount < 0 ? Math.abs(r.amount) : null,
    credit: r.amount >= 0 ? r.amount : null,
    balance: r.balance
  }));

  return { ok: true, rows, checksum: verify.checksum };
}

// Continuity: balance[i] - balance[i-1] == amount[i] (in integer paisa).
// Envelope: opening + Σamount == closing; rowcount == count.
// Any mismatch means the external AI duplicated, dropped, or mis-signed a row.
function verifyChecksum(parsed, footer) {
  const haveAllBalances = parsed.every(r => r.balance != null);

  // Row-to-row continuity (needs balances on consecutive rows).
  if (haveAllBalances) {
    for (let i = 1; i < parsed.length; i++) {
      const prev = paisa(parsed[i - 1].balance);
      const curr = paisa(parsed[i].balance);
      const amt  = paisa(parsed[i].amount);
      if (curr - prev !== amt) {
        return { ok: false, code: 'CHECKSUM_CONTINUITY_FAILED',
          error: `Balance break at row ${i + 1} (${parsed[i].posted_date} "${parsed[i].description}"): ` +
                 `previous balance Rs ${parsed[i - 1].balance.toFixed(2)} ${parsed[i].amount < 0 ? '−' : '+'} ` +
                 `Rs ${Math.abs(parsed[i].amount).toFixed(2)} should equal Rs ${((prev + amt) / 100).toFixed(2)}, ` +
                 `but the statement shows Rs ${parsed[i].balance.toFixed(2)}. A row is likely duplicated, dropped, or mis-signed.` };
      }
    }
  }

  // Envelope checks (need the footer).
  if (footer) {
    if (footer.count != null && footer.count !== parsed.length) {
      return { ok: false, code: 'CHECKSUM_COUNT_MISMATCH',
        error: `Row count mismatch: the footer says count=${footer.count} but ${parsed.length} rows were pasted. A row is missing or duplicated.` };
    }
    const sumAmt = parsed.reduce((s, r) => s + paisa(r.amount), 0);
    if (footer.opening != null && footer.closing != null) {
      const expected = paisa(footer.opening) + sumAmt;
      if (expected !== paisa(footer.closing)) {
        return { ok: false, code: 'CHECKSUM_ENVELOPE_FAILED',
          error: `Envelope check failed: opening Rs ${footer.opening.toFixed(2)} + total movement Rs ${(sumAmt / 100).toFixed(2)} ` +
                 `= Rs ${((paisa(footer.opening) + sumAmt) / 100).toFixed(2)}, but the footer's closing is Rs ${footer.closing.toFixed(2)}. ` +
                 `The pasted rows do not add up to the statement's closing balance.` };
      }
    }
    // Opening must lead into the first row's balance too.
    if (footer.opening != null && haveAllBalances) {
      const expectFirst = paisa(footer.opening) + paisa(parsed[0].amount);
      if (expectFirst !== paisa(parsed[0].balance)) {
        return { ok: false, code: 'CHECKSUM_OPENING_FAILED',
          error: `Opening check failed: opening Rs ${footer.opening.toFixed(2)} ${parsed[0].amount < 0 ? '−' : '+'} ` +
                 `Rs ${Math.abs(parsed[0].amount).toFixed(2)} should equal the first row's balance, ` +
                 `but it shows Rs ${parsed[0].balance.toFixed(2)}. The first row or the opening balance is wrong.` };
      }
    }
    // Closing must equal the last row's balance.
    if (footer.closing != null && haveAllBalances) {
      const last = parsed[parsed.length - 1].balance;
      if (paisa(last) !== paisa(footer.closing)) {
        return { ok: false, code: 'CHECKSUM_CLOSING_FAILED',
          error: `Closing check failed: footer closing is Rs ${footer.closing.toFixed(2)} but the last row's balance is Rs ${last.toFixed(2)}.` };
      }
    }
  }

  const verified = haveAllBalances && !!footer &&
    footer.count != null && footer.opening != null && footer.closing != null;

  return {
    ok: true,
    checksum: {
      verified,
      continuity_checked: haveAllBalances,
      envelope_checked:   !!footer,
      rows: parsed.length,
      opening: footer ? footer.opening : null,
      closing: footer ? footer.closing : (haveAllBalances ? parsed[parsed.length - 1].balance : null),
      note: verified
        ? 'Fully verified: every row balances and the statement adds up end-to-end.'
        : (haveAllBalances
            ? 'Row-to-row balances verified; add a "# count=N opening=O closing=C" footer for full end-to-end proof.'
            : 'No running balance present — rows accepted without checksum (duplicate guard still applies at commit).')
    }
  };
}

/* ─── Idempotency Key ─── */

// statement_transactions is a per-import SNAPSHOT, not a dedup target — the
// real duplicate guard lives at commit (content key on the append-only ledger).
// So this key MUST be unique per import + row, or re-pasting a statement you've
// imported before collides on the global UNIQUE(idempotency_key) index, all
// rows get INSERT-OR-IGNORE'd away, and the import lands with zero rows.
function buildIdemKey(accountId, date, amount, description, importId, rowIndex) {
  const normalizedDesc = String(description || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32);
  const hash = simpleHash(normalizedDesc).toString(16).padStart(8, '0');
  return `recon:${importId}:${rowIndex}:${accountId}:${date}:${amount}:${hash}`;
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
