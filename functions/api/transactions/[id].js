/* functions/api/transactions/[id].js
 * Sovereign Finance · Transaction Read + Health Route
 * v0.6.1-transaction-id-health
 *
 * Contract:
 * - GET /api/transactions/:id returns one transaction.
 * - GET /api/transactions/health returns transaction health.
 * - POST does not perform money logic here.
 * - Reversal lives only in /api/transactions/reverse.
 * - PUT and DELETE are blocked to preserve append-only ledger history.
 * - PATCH edits notes ONLY (non-financial annotation); money fields stay immutable.
 */

const VERSION = 'v0.6.1-transaction-id-health';
const CONTRACT_VERSION = 'transactions-id-health-v1';

const REVERSAL_PREFIX = '[REVERSAL OF ';
const REVERSED_BY_PREFIX = '[REVERSED BY ';

export async function onRequestGet(context) {
  try {
    const routeId = getRouteId(context);

    if (routeId === 'health') {
      return ledgerHealth(context);
    }

    if (!routeId) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transaction id required',
        code: 'TRANSACTION_ID_REQUIRED'
      }, 400);
    }

    const db = context.env.DB;
    const txColumns = await tableColumns(db, 'transactions');

    if (!txColumns.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transactions table missing id column',
        code: 'TRANSACTIONS_SCHEMA_INVALID'
      }, 500);
    }

    const row = await selectTransactionById(db, txColumns, routeId);

    if (!row) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transaction not found',
        code: 'TRANSACTION_NOT_FOUND',
        id: routeId
      }, 404);
    }

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      transaction: decorateTransaction(row)
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

export async function onRequestPost() {
  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    error: 'POST is not supported on /api/transactions/:id. Use POST /api/transactions/reverse for append-only reversal.',
    code: 'METHOD_NOT_ALLOWED_USE_CANONICAL_REVERSE',
    canonical_reverse_route: '/api/transactions/reverse',
    committed: false
  }, 405);
}

export async function onRequestPut() {
  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    error: 'Direct transaction edit is blocked. Use append-only reversal and re-entry.',
    code: 'DIRECT_EDIT_BLOCKED',
    committed: false
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    error: 'Direct transaction delete is blocked. Use append-only reversal.',
    code: 'DIRECT_DELETE_BLOCKED',
    committed: false
  }, 405);
}

/* PATCH /api/transactions/:id — notes-only edit.
 * Notes are non-financial annotation, so this is the single permitted mutation on
 * an existing transaction. Money/account/date/type/category stay immutable; edits to
 * those still go through append-only reversal (/api/transactions/reverse). Reversal
 * rows and reversed originals are refused because their notes carry the load-bearing
 * [REVERSAL OF …] / [REVERSED BY …] markers that balance + health logic depend on. */
export async function onRequestPatch(context) {
  try {
    const routeId = getRouteId(context);

    if (!routeId || routeId === 'health') {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transaction id required',
        code: 'TRANSACTION_ID_REQUIRED'
      }, 400);
    }

    let body = {};
    try { body = await context.request.json(); } catch { body = {}; }

    const MONEY_FIELDS = ['amount', 'pkr_amount', 'account_id', 'transfer_to_account_id',
      'date', 'type', 'category_id', 'fee_amount', 'pra_amount', 'currency'];
    const blocked = MONEY_FIELDS.filter(field => field in body);

    if (blocked.length) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'Only notes can be edited on a transaction. Money fields are immutable — use append-only reversal.',
        code: 'DIRECT_EDIT_BLOCKED',
        forbidden_fields: blocked,
        committed: false
      }, 405);
    }

    if (!('notes' in body)) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'notes field required',
        code: 'NOTES_REQUIRED',
        committed: false
      }, 400);
    }

    const db = context.env.DB;
    const txColumns = await tableColumns(db, 'transactions');

    if (!txColumns.has('id') || !txColumns.has('notes')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transactions table missing id or notes column',
        code: 'TRANSACTIONS_SCHEMA_INVALID'
      }, 500);
    }

    const existing = await selectTransactionById(db, txColumns, routeId);

    if (!existing) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transaction not found',
        code: 'TRANSACTION_NOT_FOUND',
        id: routeId
      }, 404);
    }

    const decorated = decorateTransaction(existing);

    if (decorated.is_reversal || decorated.is_reversed) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'Notes cannot be edited on reversal rows or reversed originals — their markers preserve the audit trail.',
        code: 'NOTES_EDIT_BLOCKED_ON_REVERSAL',
        committed: false
      }, 409);
    }

    const notes = cleanText(body.notes, '', 2000);
    const sets = ['notes = ?'];
    const binds = [notes];

    if (txColumns.has('updated_at')) {
      sets.push('updated_at = ?');
      binds.push(new Date().toISOString());
    }

    binds.push(routeId);

    await db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

    const after = await selectTransactionById(db, txColumns, routeId);

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'transaction_notes_update',
      committed: true,
      writes_performed: true,
      money_movement: false,
      transaction: decorateTransaction(after)
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

async function ledgerHealth(context) {
  const db = context.env.DB;
  const txColumns = await tableColumns(db, 'transactions');

  if (!txColumns.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'transactions table missing id column',
      code: 'TRANSACTIONS_SCHEMA_INVALID'
    }, 500);
  }

  const rowsResult = await db.prepare(
    `SELECT ${selectTransactionColumns(txColumns).join(', ')}
     FROM transactions
     ORDER BY ${buildOrderBy(txColumns)}
     LIMIT 5000`
  ).all();

  const rows = (rowsResult.results || []).map(row => decorateTransaction(row));
  const byId = new Map(rows.map(row => [String(row.id), row]));

  const reversalRows = rows.filter(row => row.is_reversal);
  const reversedOriginals = rows.filter(row => row.is_reversed && !row.is_reversal);
  const activeRows = rows.filter(row => !row.is_reversal && !row.is_reversed);

  const linkedIntegrity = await checkLinkedIntegrity(db, txColumns, rows, byId);
  const reversalIntegrity = await checkReversalIntegrity(db, txColumns, reversalRows, byId);
  const accountRefs = checkAccountRefs(activeRows);
  const categoryRefs = checkCategoryRefs(activeRows);
  const fxCoverage = checkFxCoverage(rows);
  const duplicateReversals = checkDuplicateReversals(reversalRows);

  const criticalErrors = []
    .concat(accountRefs.errors)
    .concat(linkedIntegrity.critical_errors)
    .concat(reversalIntegrity.critical_errors)
    .concat(duplicateReversals.errors);

  const warnings = []
    .concat(categoryRefs.warnings)
    .concat(linkedIntegrity.warnings)
    .concat(reversalIntegrity.warnings);

  const status = criticalErrors.length ? 'fail' : (warnings.length ? 'warn' : 'pass');

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'transactions.health',
    status,
    health: {
      status,
      total_scanned: rows.length,
      active_count: activeRows.length,
      reversal_count: reversalRows.length,
      reversed_original_count: reversedOriginals.length,

      checks: {
        account_refs_ok: accountRefs.ok,
        category_refs_ok: categoryRefs.ok,
        linked_integrity_ok: linkedIntegrity.ok,
        reversal_integrity_ok: reversalIntegrity.ok,
        duplicate_reversal_ok: duplicateReversals.ok,
        fx_snapshot_coverage_ok: fxCoverage.coverage_pct === 100
      },

      counts: {
        missing_account_refs: accountRefs.errors.length,
        missing_category_refs: categoryRefs.warnings.length,
        orphan_linked_rows: linkedIntegrity.orphan_linked_rows.length,
        linked_amount_mismatches: linkedIntegrity.amount_mismatches.length,
        reversal_integrity_errors: reversalIntegrity.errors.length,
        duplicate_reversal_groups: duplicateReversals.errors.length
      },

      account_ref_errors: accountRefs.errors,
      category_ref_warnings: categoryRefs.warnings,

      orphan_linked_rows: linkedIntegrity.orphan_linked_rows,
      linked_amount_mismatches: linkedIntegrity.amount_mismatches,
      linked_integrity_warnings: linkedIntegrity.warnings,

      reversal_integrity_errors: reversalIntegrity.errors,
      reversal_integrity_warnings: reversalIntegrity.warnings,

      duplicate_reversal_errors: duplicateReversals.errors,

      fx_snapshot_coverage: fxCoverage,

      policy: {
        health_is_read_only: true,
        reversal_owner: '/api/transactions/reverse',
        default_transactions_route_hides_reversed: true,
        linked_rows_checked_against_full_table: true,
        reversal_originals_checked_against_full_table: true,
        category_missing_is_warning_not_blocker: true,
        direct_edit_blocked: true,
        direct_delete_blocked: true
      }
    },

    critical_errors: criticalErrors,
    warnings
  });
}

async function checkLinkedIntegrity(db, txColumns, rows, byId) {
  const orphanLinkedRows = [];
  const amountMismatches = [];
  const warnings = [];
  const criticalErrors = [];
  const seen = new Set();

  for (const row of rows) {
    const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

    if (!linkedId) continue;

    const key = [String(row.id), String(linkedId)].sort().join('::');

    if (seen.has(key)) continue;

    seen.add(key);

    let linked = byId.get(String(linkedId));

    if (!linked) {
      linked = await selectTransactionById(db, txColumns, linkedId);
      if (linked) linked = decorateTransaction(linked);
    }

    if (!linked) {
      const issue = {
        id: row.id,
        linked_id: linkedId,
        error: 'linked row missing from transactions table'
      };

      orphanLinkedRows.push(issue);
      criticalErrors.push({
        source: 'transactions',
        code: 'LEDGER_ORPHAN_LINKED_ROW',
        ...issue
      });

      continue;
    }

    const rowAmount = roundMoney(Math.abs(Number(row.pkr_amount || row.amount || 0)));
    const linkedAmount = roundMoney(Math.abs(Number(linked.pkr_amount || linked.amount || 0)));

    if (rowAmount !== linkedAmount) {
      const issue = {
        id: row.id,
        linked_id: linkedId,
        amount: rowAmount,
        linked_amount: linkedAmount,
        error: 'linked amount mismatch'
      };

      amountMismatches.push(issue);

      warnings.push({
        source: 'transactions',
        code: 'LEDGER_LINKED_AMOUNT_MISMATCH',
        ...issue
      });
    }
  }

  return {
    ok: criticalErrors.length === 0,
    orphan_linked_rows: orphanLinkedRows,
    amount_mismatches: amountMismatches,
    critical_errors: criticalErrors,
    warnings
  };
}

async function checkReversalIntegrity(db, txColumns, reversalRows, byId) {
  const errors = [];
  const warnings = [];
  const criticalErrors = [];

  for (const row of reversalRows) {
    const originalId = extractReversalOriginalId(row.notes);

    if (!originalId) {
      const issue = {
        id: row.id,
        error: 'reversal row missing original id marker'
      };

      errors.push(issue);
      criticalErrors.push({
        source: 'transactions',
        code: 'REVERSAL_ORIGINAL_MARKER_MISSING',
        ...issue
      });

      continue;
    }

    let original = byId.get(String(originalId));

    if (!original) {
      original = await selectTransactionById(db, txColumns, originalId);
      if (original) original = decorateTransaction(original);
    }

    if (!original) {
      const issue = {
        id: row.id,
        original_id: originalId,
        error: 'original row not found in transactions table'
      };

      errors.push(issue);
      criticalErrors.push({
        source: 'transactions',
        code: 'REVERSAL_ORIGINAL_NOT_FOUND',
        ...issue
      });

      continue;
    }

    const rowAmount = roundMoney(Math.abs(Number(row.pkr_amount || row.amount || 0)));
    const originalAmount = roundMoney(Math.abs(Number(original.pkr_amount || original.amount || 0)));

    if (rowAmount !== originalAmount) {
      const issue = {
        id: row.id,
        original_id: originalId,
        amount: rowAmount,
        original_amount: originalAmount,
        error: 'reversal amount mismatch'
      };

      errors.push(issue);
      warnings.push({
        source: 'transactions',
        code: 'REVERSAL_AMOUNT_MISMATCH',
        ...issue
      });
    }

    if (!original.is_reversed) {
      const issue = {
        id: row.id,
        original_id: originalId,
        error: 'original exists but is not marked reversed'
      };

      errors.push(issue);
      criticalErrors.push({
        source: 'transactions',
        code: 'REVERSAL_ORIGINAL_NOT_MARKED_REVERSED',
        ...issue
      });
    }
  }

  return {
    ok: criticalErrors.length === 0,
    errors,
    critical_errors: criticalErrors,
    warnings
  };
}

function checkAccountRefs(activeRows) {
  const errors = activeRows
    .filter(row => !row.account_id)
    .map(row => ({
      source: 'transactions',
      code: 'TRANSACTION_ACCOUNT_MISSING',
      id: row.id,
      error: 'active transaction missing account_id'
    }));

  return {
    ok: errors.length === 0,
    errors
  };
}

function checkCategoryRefs(activeRows) {
  const warnings = activeRows
    .filter(row => categoryRequired(row) && !row.category_id)
    .map(row => ({
      source: 'transactions',
      code: 'TRANSACTION_CATEGORY_MISSING',
      id: row.id,
      type: row.type,
      error: 'active transaction missing category_id'
    }));

  return {
    ok: true,
    warnings
  };
}

function categoryRequired(row) {
  const type = String(row.type || '').toLowerCase();

  if (!type) return false;
  if (type === 'transfer') return false;
  if (type === 'income') return false;
  if (type === 'opening') return false;
  if (type === 'salary') return false;

  return true;
}

function checkFxCoverage(rows) {
  const fxRows = rows.filter(row => row.currency && row.currency !== 'PKR');
  const covered = fxRows.filter(row => Number(row.fx_rate_at_commit) > 0);

  return {
    foreign_rows: fxRows.length,
    covered_rows: covered.length,
    coverage_pct: fxRows.length ? roundMoney((covered.length / fxRows.length) * 100) : 100
  };
}

function checkDuplicateReversals(reversalRows) {
  const map = new Map();

  for (const row of reversalRows) {
    const originalId = extractReversalOriginalId(row.notes);

    if (!originalId) continue;

    if (!map.has(originalId)) map.set(originalId, []);
    map.get(originalId).push(row.id);
  }

  const errors = [];

  for (const [originalId, reversalIds] of map.entries()) {
    if (reversalIds.length <= 1) continue;

    errors.push({
      source: 'transactions',
      code: 'DUPLICATE_REVERSAL',
      original_id: originalId,
      reversal_ids: reversalIds,
      error: 'multiple reversal rows found for one original'
    });
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

async function selectTransactionById(db, txColumns, id) {
  const cols = selectTransactionColumns(txColumns);

  if (!cols.length) {
    throw new Error('transactions table has no readable columns');
  }

  return db.prepare(
    `SELECT ${cols.join(', ')}
     FROM transactions
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

function selectTransactionColumns(columns) {
  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'account_id',
    'transfer_to_account_id',
    'linked_txn_id',
    'category_id',
    'merchant_id',
    'merchant',
    'notes',
    'fee_amount',
    'pra_amount',
    'currency',
    'pkr_amount',
    'fx_rate_at_commit',
    'fx_source',
    'intl_package_id',
    'reversed_by',
    'reversed_at',
    'source_module',
    'source_id',
    'source_action',
    'idempotency_key',
    'created_by',
    'created_at',
    'updated_at'
  ];

  return wanted.filter(col => columns.has(col));
}

function decorateTransaction(row) {
  const notes = String(row.notes || '');
  const isReversal = isReversalRow(row);
  const isReversed = isReversedOriginal(row);
  const linkedFromNote = extractLinkedId(notes);
  const groupId = row.intl_package_id || row.linked_txn_id || linkedFromNote || null;

  return {
    ...row,
    display_amount: Number(row.pkr_amount || row.amount || 0),
    is_reversal: isReversal,
    is_reversed: isReversed,
    reverse_eligible: !isReversal && !isReversed,
    reverse_block_reason: isReversal
      ? 'reversal_row'
      : (isReversed ? 'already_reversed' : null),
    group_id: groupId,
    group_type: row.intl_package_id
      ? 'intl_package'
      : (groupId ? 'linked_pair' : 'single')
  };
}

function isReversalRow(row) {
  const notes = String(row && row.notes || '').toUpperCase();
  return notes.includes('[REVERSAL OF ');
}

function isReversedOriginal(row) {
  const notes = String(row && row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSED BY ')
  );
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function extractReversalOriginalId(notes) {
  const match = String(notes || '').match(/\[REVERSAL OF\s+([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = new Set();

    for (const row of result.results || []) {
      if (row.name) columns.add(row.name);
    }

    return columns;
  } catch {
    return new Set();
  }
}

function buildOrderBy(cols) {
  const parts = [];

  if (cols.has('date')) parts.push('date DESC');
  if (cols.has('created_at')) parts.push('datetime(created_at) DESC');
  if (cols.has('id')) parts.push('id DESC');

  return parts.length ? parts.join(', ') : 'rowid DESC';
}

function getRouteId(context) {
  const params = context.params || {};

  return cleanText(
    params.id ||
      params.transaction_id ||
      params.path ||
      '',
    '',
    200
  );
}

function roundMoney(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function cleanText(value, fallback = '', maxLen = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen);
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
