/* Sovereign Finance — PDF Statement Upload + Gemini Extraction
 * POST /api/reconciliation/upload-pdf  — multipart upload + inline extraction
 * GET  /api/reconciliation/upload-pdf?file_id=xxx — poll status
 *
 * contract_version: pdf-upload-v1.0
 */

const VERSION = 'v1.0.0-pdf-upload';
const CONTRACT_VERSION = 'pdf-upload-v1.0';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DAILY_UPLOAD_LIMIT = 20;

const EXTRACTION_PROMPT = `You are extracting transactions from a bank statement PDF. Return ONLY valid JSON, no markdown, no commentary.

Schema:
{
  transactions: [{
    date: 'YYYY-MM-DD',
    description: string,
    debit: number|null,
    credit: number|null,
    balance: number,
    reference: string|null
  }],
  bank_name: string,
  account_number_last4: string|null,
  detected_currency: string,
  opening_balance: number,
  closing_balance: number,
  period_start: 'YYYY-MM-DD',
  period_end: 'YYYY-MM-DD',
  total_debits: number,
  total_credits: number
}

Rules:
1. Use VALUE DATE if statement has both booking and value date
2. Exactly ONE of debit/credit is populated, the other is null
3. Preserve STAN numbers, IBAN refs, transaction codes inside description
4. Skip header lines, page footers, balance summary lines, brought-forward lines
5. Skip marketing/promotional inserts
6. Use ORIGINAL CURRENCY, do not convert
7. Sort transactions oldest first
8. If unreadable or not a bank statement, return: {error: 'specific reason'}
9. Common Pakistani currency code is PKR
10. Date format must be ISO YYYY-MM-DD always`;

/* ─── POST: upload PDF + extract ─── */

export async function onRequestPost(context) {
  try {
    const { env, request } = context;
    const db = env.DB;
    if (!db) return json(dbErr(), 500);

    const userId = context.data?.user_id;
    if (!userId) return json(authErr(), 401);

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return json(validErr('Request must be multipart/form-data', 'WRONG_CONTENT_TYPE'), 400);
    }

    const formData = await request.formData().catch(() => null);
    if (!formData) return json(validErr('Could not parse form data', 'FORM_PARSE_ERROR'), 400);

    const file = formData.get('file');
    const accountId = clean(formData.get('account_id') || '');

    if (!file || typeof file === 'string') {
      return json(validErr('file field is required (PDF binary)', 'FILE_REQUIRED'), 400);
    }
    if (!accountId) {
      return json(validErr('account_id is required', 'ACCOUNT_ID_REQUIRED'), 400);
    }

    if (file.type !== 'application/pdf') {
      return json(validErr(
        `Only PDF files accepted. Got: ${file.type || 'unknown'}`,
        'INVALID_FILE_TYPE'
      ), 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const sizeBytes = arrayBuffer.byteLength;

    if (sizeBytes > MAX_BYTES) {
      return json(validErr(
        `File too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
        'FILE_TOO_LARGE'
      ), 400);
    }

    const account = await db.prepare(
      'SELECT id, name FROM accounts WHERE id = ? LIMIT 1'
    ).bind(accountId).first();
    if (!account) {
      return json(validErr('Account not found or does not belong to you', 'ACCOUNT_NOT_FOUND'), 404);
    }

    const rateLimitOk = await checkRateLimit(db, userId);
    if (!rateLimitOk) {
      return json({
        ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
        action: 'upload_pdf',
        error: 'Daily upload limit reached (20 per day). Try again tomorrow or use CSV paste.',
        code: 'RATE_LIMIT_EXCEEDED'
      }, 429);
    }

    if (!env.STATEMENTS) {
      return json(validErr('R2 bucket not configured', 'R2_UNAVAILABLE'), 503);
    }

    const fileId = `sf_${Date.now()}_${rand()}`;
    const safeFilename = sanitizeFilename(file.name || 'statement.pdf');
    const r2Key = `users/${userId}/statements/${fileId}.pdf`;
    const now = nowSql();

    try {
      await env.STATEMENTS.put(r2Key, arrayBuffer, {
        httpMetadata: {
          contentType: 'application/pdf',
          contentDisposition: `attachment; filename="${safeFilename}"`
        }
      });
    } catch (r2Err) {
      return json(srvErr(r2Err, 'R2 upload failed'), 502);
    }

    await ensureStatementFilesTable(db);

    await db.prepare(
      `INSERT INTO statement_files
         (id, user_id, account_id, r2_key, original_filename, content_type,
          size_bytes, extraction_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(fileId, userId, accountId, r2Key, safeFilename, 'application/pdf', sizeBytes, now).run();

    const extraction = await extractPdf(env, db, fileId, userId, accountId, r2Key, arrayBuffer);

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'upload_pdf',
      writes_performed: true,
      file_id: fileId,
      status: extraction.status,
      message: extraction.message,
      summary: extraction.summary || null,
      statement_import_id: extraction.statement_import_id || null,
      rows_preview: extraction.rows_preview || null,
      error: extraction.error || null
    });

  } catch (e) {
    return json(srvErr(e), 500);
  }
}

/* ─── GET: poll status ─── */

export async function onRequestGet(context) {
  try {
    const { env, request } = context;
    const db = env.DB;
    if (!db) return json(dbErr(), 500);

    const userId = context.data?.user_id;
    if (!userId) return json(authErr(), 401);

    const url = new URL(request.url);
    const fileId = clean(url.searchParams.get('file_id') || '');
    if (!fileId) return json(validErr('file_id query param required', 'FILE_ID_REQUIRED'), 400);

    await ensureStatementFilesTable(db);

    const row = await db.prepare(
      `SELECT * FROM statement_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(fileId, userId).first();

    if (!row) return json(validErr('File not found', 'NOT_FOUND'), 404);

    return json({ ok: true, version: VERSION, action: 'get_statement_file', file: row });

  } catch (e) {
    return json(srvErr(e), 500);
  }
}

/* ─── Gemini Extraction ─── */

async function extractPdf(env, db, fileId, userId, accountId, r2Key, arrayBuffer) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    await updateFileStatus(db, fileId, 'failed', null, 'GEMINI_API_KEY not configured');
    return { status: 'failed', error: 'Extraction service not configured', message: 'Configuration error' };
  }

  let base64Pdf;
  try {
    base64Pdf = arrayBufferToBase64(arrayBuffer);
  } catch (e) {
    await updateFileStatus(db, fileId, 'failed', null, 'Failed to encode PDF');
    return { status: 'failed', error: 'Could not read PDF file', message: 'PDF encoding failed' };
  }

  const geminiPayload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: base64Pdf } },
        { text: EXTRACTION_PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8000,
      responseMimeType: 'application/json'
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
    ]
  };

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  let geminiRes;
  try {
    geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiPayload)
    });

    if (geminiRes.status === 429) {
      await sleep(2000);
      geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload)
      });
      if (geminiRes.status === 429) {
        await updateFileStatus(db, fileId, 'rate_limited', null, 'Gemini rate limit hit');
        return {
          status: 'rate_limited',
          error: 'AI service is busy. Please try again in a minute.',
          message: 'Rate limited'
        };
      }
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => 'unknown error');
      const detail = `Gemini HTTP ${geminiRes.status}: ${errText.slice(0, 500)}`;
      console.error('[upload-pdf] Gemini error', { status: geminiRes.status, body: errText.slice(0, 500) });
      await updateFileStatus(db, fileId, 'failed', null, detail);
      return { status: 'failed', error: `AI service error (HTTP ${geminiRes.status})`, message: detail };
    }
  } catch (fetchErr) {
    await updateFileStatus(db, fileId, 'failed', null, `Network error calling Gemini: ${fetchErr.message}`);
    return { status: 'failed', error: 'Network error calling extraction service', message: 'Network failure' };
  }

  let geminiData;
  try {
    geminiData = await geminiRes.json();
  } catch {
    await updateFileStatus(db, fileId, 'failed', null, 'Could not parse Gemini response JSON');
    return { status: 'failed', error: 'Could not parse statement', message: 'Invalid Gemini response' };
  }

  let extracted;
  try {
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('No text in Gemini response');
    extracted = JSON.parse(rawText);
  } catch (parseErr) {
    await updateFileStatus(db, fileId, 'failed', null, `JSON parse error: ${parseErr.message}`);
    return { status: 'failed', error: 'Could not parse statement', message: 'Extraction parse error' };
  }

  if (extracted.error) {
    await updateFileStatus(db, fileId, 'failed', null, extracted.error);
    return {
      status: 'failed',
      error: extracted.error,
      message: 'AI could not read this document as a bank statement'
    };
  }

  const txns = Array.isArray(extracted.transactions) ? extracted.transactions : [];
  if (!txns.length) {
    await updateFileStatus(db, fileId, 'failed', null, 'No transactions found in statement');
    return { status: 'failed', error: 'No transactions found', message: 'Empty statement' };
  }

  const csvText = transactionsToCsv(txns);
  let statementImportId = null;

  try {
    const importResult = await callImportStatement(env, db, accountId, csvText, userId);
    if (importResult.ok) {
      statementImportId = importResult.import_id;
    }
  } catch (_) {}

  const now = nowSql();
  await db.prepare(
    `UPDATE statement_files SET
       extraction_status = 'complete',
       extraction_result_json = ?,
       extracted_row_count = ?,
       statement_import_id = ?,
       detected_bank = ?,
       detected_currency = ?,
       detected_opening_balance = ?,
       detected_closing_balance = ?,
       detected_period_start = ?,
       detected_period_end = ?,
       extraction_cost_cents = 0,
       extracted_at = ?
     WHERE id = ?`
  ).bind(
    JSON.stringify(extracted),
    txns.length,
    statementImportId,
    extracted.bank_name || null,
    extracted.detected_currency || null,
    extracted.opening_balance ?? null,
    extracted.closing_balance ?? null,
    extracted.period_start || null,
    extracted.period_end || null,
    now,
    fileId
  ).run();

  return {
    status: 'complete',
    message: `Found ${txns.length} transactions`,
    statement_import_id: statementImportId,
    summary: {
      bank: extracted.bank_name,
      currency: extracted.detected_currency,
      period_start: extracted.period_start,
      period_end: extracted.period_end,
      opening_balance: extracted.opening_balance,
      closing_balance: extracted.closing_balance,
      total_debits: extracted.total_debits,
      total_credits: extracted.total_credits,
      transaction_count: txns.length
    },
    rows_preview: txns.slice(0, 5)
  };
}

/* ─── Internal import-statement call ─── */

async function callImportStatement(env, db, accountId, csvText, createdBy) {
  const { parseCsvInternal, insertStatementImport } = getImportHelpers();
  return insertStatementImport(db, accountId, csvText, createdBy || 'pdf-upload');
}

/* ─── Inline import-statement logic (avoids HTTP round-trip) ─── */

function getImportHelpers() {
  function parseCsvLine(line) {
    const result = [];
    let current = '';
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
    if (val == null) return null;
    const s = String(val).replace(/,/g, '').replace(/rs\.?/ig, '').trim();
    if (!s || s === '-') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  function buildIdemKey(accountId, date, amount, description) {
    const nd = String(description || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
    let h = 0;
    for (let i = 0; i < nd.length; i++) h = Math.imul(31, h) + nd.charCodeAt(i) | 0;
    return `recon:${accountId}:${date}:${amount}:${(h >>> 0).toString(16).padStart(8, '0')}`;
  }

  async function insertStatementImport(db, accountId, csvText, createdBy) {
    const lines = csvText.trim().split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { ok: false, error: 'CSV too short' };

    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim().replace(/[^a-z0-9]/g, '_'));
    const fi = (aliases) => { for (const a of aliases) { const i = header.indexOf(a); if (i !== -1) return i; } return -1; };

    const dateIdx    = fi(['date', 'posted_date']);
    const descIdx    = fi(['description', 'narration']);
    const debitIdx   = fi(['debit', 'withdrawal']);
    const creditIdx  = fi(['credit', 'deposit']);
    const balanceIdx = fi(['balance', 'running_balance']);

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const rawDate = (cols[dateIdx] || '').trim();
      if (!rawDate) continue;
      const posted_date = rawDate.slice(0, 10);
      rows.push({
        posted_date,
        description: (cols[descIdx] || '').trim(),
        debit:   parseAmount(cols[debitIdx]),
        credit:  parseAmount(cols[creditIdx]),
        balance: parseAmount(cols[balanceIdx])
      });
    }

    if (!rows.length) return { ok: false, error: 'No rows parsed' };

    const now2 = nowSql();
    const importId = `stmt_${Date.now()}_${rand()}`;
    const stmtRows = rows.map((row, i) => ({
      id:              `stmtx_${Date.now()}_${i}_${rand()}`,
      import_id:       importId,
      account_id:      accountId,
      posted_date:     row.posted_date,
      description:     row.description,
      debit:           row.debit ?? null,
      credit:          row.credit ?? null,
      balance:         row.balance ?? null,
      idempotency_key: buildIdemKey(accountId, row.posted_date, row.debit ?? row.credit ?? 0, row.description)
    }));

    const closingBalance = rows[rows.length - 1].balance;
    const insertImport = db.prepare(
      `INSERT INTO statement_imports
         (id, account_id, imported_at, row_count, date_from, date_to,
          statement_closing_balance, raw_csv, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(importId, accountId, now2, rows.length, rows[0].posted_date, rows[rows.length - 1].posted_date,
      closingBalance, csvText.slice(0, 50000), createdBy, now2);

    const insertRowStmts = stmtRows.map(r =>
      db.prepare(
        `INSERT OR IGNORE INTO statement_transactions
           (id, import_id, account_id, posted_date, description,
            debit, credit, balance, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(r.id, r.import_id, r.account_id, r.posted_date, r.description,
        r.debit, r.credit, r.balance, r.idempotency_key, now2)
    );

    await db.batch([insertImport, ...insertRowStmts]);
    return { ok: true, import_id: importId, row_count: rows.length };
  }

  return { insertStatementImport };
}

/* ─── CSV Builder ─── */

function transactionsToCsv(transactions) {
  const header = 'date,description,debit,credit,balance';
  const rows = transactions.map(t => {
    const date = t.date || '';
    const desc = `"${(t.description || '').replace(/"/g, '""')}"`;
    const debit   = t.debit  != null ? t.debit  : '';
    const credit  = t.credit != null ? t.credit : '';
    const balance = t.balance != null ? t.balance : '';
    return `${date},${desc},${debit},${credit},${balance}`;
  });
  return [header, ...rows].join('\n');
}

/* ─── Rate limiting (20 uploads/day/user) ─── */

async function checkRateLimit(db, userId) {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStr = todayStart.toISOString().replace('T', ' ').slice(0, 19);

    const result = await db.prepare(
      `SELECT COUNT(*) as cnt FROM statement_files
       WHERE user_id = ? AND created_at >= ? AND deleted_at IS NULL`
    ).bind(userId, todayStr).first();

    return (result?.cnt ?? 0) < DAILY_UPLOAD_LIMIT;
  } catch {
    return true;
  }
}

/* ─── Table Bootstrap ─── */

async function ensureStatementFilesTable(db) {
  const ddl = `CREATE TABLE IF NOT EXISTS statement_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    original_filename TEXT,
    content_type TEXT,
    size_bytes INTEGER,
    extraction_status TEXT DEFAULT 'pending',
    extraction_result_json TEXT,
    extracted_row_count INTEGER,
    statement_import_id TEXT,
    extraction_provider TEXT DEFAULT 'gemini-2.0-flash',
    extraction_cost_cents INTEGER DEFAULT 0,
    extraction_error TEXT,
    detected_bank TEXT,
    detected_currency TEXT,
    detected_opening_balance REAL,
    detected_closing_balance REAL,
    detected_period_start TEXT,
    detected_period_end TEXT,
    deleted_at TEXT,
    created_at TEXT,
    extracted_at TEXT
  )`;
  try { await db.prepare(ddl).run(); } catch (_) {}
  const idxes = [
    `CREATE INDEX IF NOT EXISTS idx_stmt_files_user    ON statement_files(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_stmt_files_account ON statement_files(account_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_stmt_files_status  ON statement_files(extraction_status)`
  ];
  for (const s of idxes) { try { await db.prepare(s).run(); } catch (_) {} }
}

async function updateFileStatus(db, fileId, status, importId, errorMsg) {
  try {
    await db.prepare(
      `UPDATE statement_files SET extraction_status = ?, statement_import_id = ?,
       extraction_error = ?, extracted_at = ? WHERE id = ?`
    ).bind(status, importId ?? null, errorMsg ?? null, nowSql(), fileId).run();
  } catch (_) {}
}

/* ─── base64 conversion (chunked to avoid stack overflow on large PDFs) ─── */

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ─── Helpers ─── */

function sanitizeFilename(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 255) || 'statement.pdf';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clean(v) { return String(v == null ? '' : v).trim(); }

function nowSql() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function rand() { return Math.random().toString(36).slice(2, 8); }

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function dbErr()   { return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'DB binding missing',  code: 'DB_BINDING_MISSING' }; }
function authErr() { return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'Unauthorized',        code: 'UNAUTHORIZED' }; }
function validErr(message, code) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    action: 'upload_pdf', error: message, code, writes_performed: false };
}
function srvErr(e, msg) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: msg || (e?.message || String(e)), code: 'INTERNAL_ERROR' };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
