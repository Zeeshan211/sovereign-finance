/* Sovereign Finance — Statement Files CRUD
 * GET    /api/reconciliation/statement-files?account_id=xxx  — list uploads
 * DELETE /api/reconciliation/statement-files/:id             — soft delete
 *
 * contract_version: statement-files-v1.0
 */

const VERSION = 'v1.0.0-statement-files';
const CONTRACT_VERSION = 'statement-files-v1.0';
const PAGE_SIZE = 20;

export async function onRequestGet(context) {
  try {
    const { env, request } = context;
    const db = env.DB;
    if (!db) return json(dbErr(), 500);

    const userId = context.data?.user_id;
    if (!userId) return json(authErr(), 401);

    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get('account_id') || '');
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const offset = (page - 1) * PAGE_SIZE;

    await ensureStatementFilesTable(db);

    let rows;
    if (accountId) {
      rows = await db.prepare(
        `SELECT id, user_id, account_id, original_filename, size_bytes,
                extraction_status, extracted_row_count, statement_import_id,
                detected_bank, detected_currency, detected_opening_balance,
                detected_closing_balance, detected_period_start, detected_period_end,
                extraction_error, created_at, extracted_at
         FROM statement_files
         WHERE user_id = ? AND account_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(userId, accountId, PAGE_SIZE, offset).all();
    } else {
      rows = await db.prepare(
        `SELECT id, user_id, account_id, original_filename, size_bytes,
                extraction_status, extracted_row_count, statement_import_id,
                detected_bank, detected_currency, detected_opening_balance,
                detected_closing_balance, detected_period_start, detected_period_end,
                extraction_error, created_at, extracted_at
         FROM statement_files
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(userId, PAGE_SIZE, offset).all();
    }

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'list_statement_files',
      files: rows.results ?? [],
      page,
      page_size: PAGE_SIZE
    });

  } catch (e) {
    return json(srvErr(e), 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const { env, request } = context;
    const db = env.DB;
    if (!db) return json(dbErr(), 500);

    const userId = context.data?.user_id;
    if (!userId) return json(authErr(), 401);

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const fileId = clean(pathParts[pathParts.length - 1]);

    if (!fileId || fileId === 'statement-files') {
      return json(validErr('File ID required in path', 'FILE_ID_REQUIRED'), 400);
    }

    await ensureStatementFilesTable(db);

    const row = await db.prepare(
      `SELECT id, r2_key FROM statement_files WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(fileId, userId).first();

    if (!row) return json(validErr('File not found', 'NOT_FOUND'), 404);

    if (env.STATEMENTS) {
      try { await env.STATEMENTS.delete(row.r2_key); } catch (_) {}
    }

    await db.prepare(
      `UPDATE statement_files SET deleted_at = ? WHERE id = ?`
    ).bind(nowSql(), fileId).run();

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'delete_statement_file',
      writes_performed: true,
      file_id: fileId
    });

  } catch (e) {
    return json(srvErr(e), 500);
  }
}

async function ensureStatementFilesTable(db) {
  const ddl = `CREATE TABLE IF NOT EXISTS statement_files (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
    r2_key TEXT NOT NULL, original_filename TEXT, content_type TEXT, size_bytes INTEGER,
    extraction_status TEXT DEFAULT 'pending', extraction_result_json TEXT,
    extracted_row_count INTEGER, statement_import_id TEXT,
    extraction_provider TEXT DEFAULT 'gemini-1.5-flash', extraction_cost_cents INTEGER DEFAULT 0,
    extraction_error TEXT, detected_bank TEXT, detected_currency TEXT,
    detected_opening_balance REAL, detected_closing_balance REAL,
    detected_period_start TEXT, detected_period_end TEXT,
    deleted_at TEXT, created_at TEXT, extracted_at TEXT
  )`;
  try { await db.prepare(ddl).run(); } catch (_) {}
}

function clean(v) { return String(v == null ? '' : v).trim(); }
function nowSql() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function dbErr()   { return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'DB binding missing', code: 'DB_BINDING_MISSING' }; }
function authErr() { return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION, error: 'Unauthorized',       code: 'UNAUTHORIZED' }; }
function validErr(message, code) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    action: 'statement_files', error: message, code, writes_performed: false };
}
function srvErr(e) {
  return { ok: false, version: VERSION, contract_version: CONTRACT_VERSION,
    error: e?.message || String(e), code: 'INTERNAL_ERROR' };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
