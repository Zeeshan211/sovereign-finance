/* /api/transactions/:id
 * Sovereign Finance v0.5.0-ledger-id-hardening
 *
 * Routes handled by this file:
 * - GET  /api/transactions/health
 * - POST /api/transactions/reverse
 * - GET  /api/transactions/:id
 *
 * Explicitly blocked:
 * - PUT    /api/transactions/:id
 * - DELETE /api/transactions/:id
 *
 * Ledger rule:
 * Corrections are append-only reversals only.
 */

import { audit } from '../_lib.js';

const VERSION = 'v0.5.0-ledger-id-hardening';

const REVERSAL_PREFIX = '[REVERSAL OF ';
const REVERSED_BY_PREFIX = '[REVERSED BY ';

export async function onRequestGet(context) {
  try {
    const routeId = getRouteId(context);

    if (routeId === 'health') {
      return ledgerHealth(context);
    }

    if (!routeId) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'transaction id required'
      }, 400);
    }

    const db = context.env.DB;
    const txColumns = await getTableColumns(db, 'transactions');
    const row = await selectTransactionById(db, txColumns, routeId);

    if (!row) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'transaction not found',
        id: routeId
      }, 404);
    }

    return jsonResponse({
      ok: true,
      version: VERSION,
      transaction: decorateTransaction(row)
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const routeId = getRouteId(context);

    if (routeId !== 'reverse') {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Unsupported POST route. Use POST /api/transactions/reverse.'
      }, 405);
    }

    return reverseTransaction(context);
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

export async function onRequestPut() {
  return jsonResponse({
    ok: false,
    version: VERSION,
    error: 'Direct transaction edit is blocked. Use append-only reversal and re-entry.'
  }, 405);
}

export async function onRequestDelete() {
  return jsonResponse({
    ok: false,
    version: VERSION,
    error: 'Direct transaction delete is blocked. Use append-only reversal.'
  }, 405);
}

async function reverseTransaction(context) {
  const db = context.env.DB;
  const body = await readJSON(context.request);

  const id = cleanText(body.id || body.transaction_id, '', 160);
  const reason = cleanText(body.reason, '', 500);
  const createdBy = cleanText(body.created_by, 'web-ledger', 80) || 'web-ledger';

  if (!id) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'id required'
    }, 400);
  }

  if (!reason) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'reason required'
    }, 400);
  }

  const txColumns = await getTableColumns(db, 'transactions');
  const packageColumns = await getTableColumns(db, 'intl_package');
  const target = await selectTransactionById(db, txColumns, id);

  if (!target) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'transaction not found',
      id
    }, 404);
  }

  const targetState = decorateTransaction(target);

  if (targetState.is_reversal) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Cannot reverse a reversal row',
      id
    }, 409);
  }

  if (targetState.is_reversed) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Transaction already reversed',
      id,
      reversed_by: target.reversed_by || null,
      reversed_at: target.reversed_at || null
    }, 409);
  }

  const reversalPlan = await buildReversalPlan(db, txColumns, targetState, reason, createdBy);

  if (!reversalPlan.ok) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: reversalPlan.error,
      details: reversalPlan.details || null
    }, reversalPlan.status || 409);
  }

  const statements = [];

  for (const reversalRow of reversalPlan.reversal_rows) {
    statements.push(buildInsertStatement(db, 'transactions', filterInsertable(txColumns, reversalRow)));
  }

  for (const originalRow of reversalPlan.original_rows) {
    statements.push(buildMarkReversedStatement(db, txColumns, originalRow.id, reversalPlan.reversal_ids.join(','), reason));
  }

  if (
    reversalPlan.intl_package_id &&
    packageColumns.size > 0 &&
    packageColumns.has('status')
  ) {
    statements.push(buildIntlPackageVoidStatement(db, packageColumns, reversalPlan.intl_package_id, createdBy));
  }

  if (reversalPlan.debt_restore && reversalPlan.debt_restore.statements) {
    statements.push(...reversalPlan.debt_restore.statements);
  }

  await db.batch(statements);

  const auditResult = await safeAudit(context, {
    action: reversalPlan.kind === 'intl_package' ? 'INTL_PACKAGE_REVERSE' : 'TXN_REVERSE',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      reason,
      target_id: id,
      reversal_ids: reversalPlan.reversal_ids,
      reversed_original_ids: reversalPlan.original_rows.map(row => row.id),
      kind: reversalPlan.kind,
      intl_package_id: reversalPlan.intl_package_id || null,
      debt_restore: reversalPlan.debt_restore ? reversalPlan.debt_restore.summary : null
    },
    created_by: createdBy
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    reversed_id: id,
    kind: reversalPlan.kind,
    reversal_ids: reversalPlan.reversal_ids,
    reversed_original_ids: reversalPlan.original_rows.map(row => row.id),
    intl_package_id: reversalPlan.intl_package_id || null,
    debt_restore: reversalPlan.debt_restore ? reversalPlan.debt_restore.summary : null,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function buildReversalPlan(db, txColumns, target, reason, createdBy) {
  const now = new Date().toISOString();

  if (target.intl_package_id) {
    return buildIntlPackageReversalPlan(db, txColumns, target, reason, createdBy, now);
  }

  const linkedId = target.linked_txn_id || extractLinkedId(target.notes);

  if (linkedId) {
    return buildLinkedPairReversalPlan(db, txColumns, target, linkedId, reason, createdBy, now);
  }

  return buildSingleReversalPlan(db, txColumns, target, reason, createdBy, now);
}

async function buildSingleReversalPlan(db, txColumns, target, reason, createdBy, now) {
  const reversalId = makeTxnId('rv');

  const reversalRow = makeReversalRow(txColumns, target, reversalId, reason, createdBy, now, null);
  const debtRestore = await buildDebtRestorePlan(db, target, reversalId);

  return {
    ok: true,
    kind: 'single',
    original_rows: [target],
    reversal_rows: [reversalRow],
    reversal_ids: [reversalId],
    debt_restore: debtRestore
  };
}

async function buildLinkedPairReversalPlan(db, txColumns, target, linkedId, reason, createdBy, now) {
  const linked = await selectTransactionById(db, txColumns, linkedId);

  if (!linked) {
    return {
      ok: false,
      status: 409,
      error: 'Linked transaction not found; cannot safely reverse partial pair.',
      details: {
        target_id: target.id,
        linked_id: linkedId
      }
    };
  }

  const linkedState = decorateTransaction(linked);

  if (linkedState.is_reversal || linkedState.is_reversed) {
    return {
      ok: false,
      status: 409,
      error: 'Linked transaction is not eligible for reversal.',
      details: {
        target_id: target.id,
        linked_id: linkedId,
        linked_is_reversal: linkedState.is_reversal,
        linked_is_reversed: linkedState.is_reversed
      }
    };
  }

  const firstReversalId = makeTxnId('rv');
  const secondReversalId = makeTxnId('rv');

  const firstReversal = makeReversalRow(txColumns, target, firstReversalId, reason, createdBy, now, secondReversalId);
  const secondReversal = makeReversalRow(txColumns, linkedState, secondReversalId, reason, createdBy, now, firstReversalId);

  const firstDebtRestore = await buildDebtRestorePlan(db, target, firstReversalId);
  const secondDebtRestore = await buildDebtRestorePlan(db, linkedState, secondReversalId);

  const debtRestore = mergeDebtRestorePlans(db, firstDebtRestore, secondDebtRestore);

  return {
    ok: true,
    kind: 'linked_pair',
    original_rows: [target, linkedState],
    reversal_rows: [firstReversal, secondReversal],
    reversal_ids: [firstReversalId, secondReversalId],
    debt_restore: debtRestore
  };
}

async function buildIntlPackageReversalPlan(db, txColumns, target, reason, createdBy, now) {
  const packageId = target.intl_package_id;

  const rowsResult = await db.prepare(
    `SELECT ${selectTransactionColumns(txColumns).join(', ')}
     FROM transactions
     WHERE intl_package_id = ?
     ORDER BY date ASC, datetime(created_at) ASC, id ASC`
  ).bind(packageId).all();

  const packageRows = (rowsResult.results || []).map(row => decorateTransaction(row));

  if (!packageRows.length) {
    return {
      ok: false,
      status: 409,
      error: 'No rows found for intl package.',
      details: {
        intl_package_id: packageId
      }
    };
  }

  const blocked = packageRows.filter(row => row.is_reversal || row.is_reversed);

  if (blocked.length) {
    return {
      ok: false,
      status: 409,
      error: 'Intl package contains rows that are already reversed or reversal rows.',
      details: {
        intl_package_id: packageId,
        blocked_ids: blocked.map(row => row.id)
      }
    };
  }

  const reversalRows = [];
  const reversalIds = [];

  for (const row of packageRows) {
    const reversalId = makeTxnId('rv');
    reversalIds.push(reversalId);
    reversalRows.push(makeReversalRow(txColumns, row, reversalId, reason, createdBy, now, null));
  }

  return {
    ok: true,
    kind: 'intl_package',
    intl_package_id: packageId,
    original_rows: packageRows,
    reversal_rows: reversalRows,
    reversal_ids: reversalIds,
    debt_restore: null
  };
}

function makeReversalRow(txColumns, original, reversalId, reason, createdBy, now, linkedReversalId) {
  const originalAmount = Number(original.amount) || 0;
  const originalPkrAmount = Number(original.pkr_amount || original.amount || 0);
  const notes = `${REVERSAL_PREFIX}${original.id}] ${reason}`.slice(0, 220);

  const row = {
    id: reversalId,
    date: todayISO(),
    type: original.type,
    amount: roundMoney(originalAmount),
    account_id: original.account_id,
    transfer_to_account_id: original.transfer_to_account_id || null,
    linked_txn_id: linkedReversalId || null,
    category_id: original.category_id || null,
    notes,
    fee_amount: 0,
    pra_amount: 0,
    currency: original.currency || 'PKR',
    pkr_amount: roundMoney(originalPkrAmount),
    fx_rate_at_commit: Number(original.fx_rate_at_commit || 1),
    fx_source: original.fx_source || 'reversal-original-snapshot',
    intl_package_id: original.intl_package_id || null,
    reversed_by: null,
    reversed_at: null,
    created_by: createdBy,
    created_at: now
  };

  row.amount = -Math.abs(row.amount);
  row.pkr_amount = -Math.abs(row.pkr_amount);

  if (isNegativeType(original.type)) {
    row.amount = Math.abs(row.amount);
    row.pkr_amount = Math.abs(row.pkr_amount);
  }

  return filterInsertable(txColumns, row);
}

function buildMarkReversedStatement(db, txColumns, originalId, reversalIds, reason) {
  const setParts = [];
  const values = [];

  if (txColumns.has('reversed_by')) {
    setParts.push('reversed_by = ?');
    values.push(reversalIds);
  }

  if (txColumns.has('reversed_at')) {
    setParts.push('reversed_at = ?');
    values.push(new Date().toISOString());
  }

  if (txColumns.has('notes')) {
    setParts.push(
      `notes = CASE
        WHEN notes IS NULL OR notes = '' THEN ?
        ELSE substr(notes || ' ' || ?, 1, 220)
      END`
    );

    const marker = `${REVERSED_BY_PREFIX}${reversalIds}] ${reason}`.slice(0, 220);
    values.push(marker, marker);
  }

  if (!setParts.length) {
    throw new Error('transactions table has no reversal marker columns');
  }

  values.push(originalId);

  return db.prepare(
    `UPDATE transactions
     SET ${setParts.join(', ')}
     WHERE id = ?`
  ).bind(...values);
}

function buildIntlPackageVoidStatement(db, packageColumns, packageId, createdBy) {
  const setParts = ['status = ?'];
  const values = ['voided'];

  if (packageColumns.has('voided_at')) {
    setParts.push('voided_at = ?');
    values.push(new Date().toISOString());
  }

  if (packageColumns.has('voided_by')) {
    setParts.push('voided_by = ?');
    values.push(createdBy);
  }

  if (packageColumns.has('updated_at')) {
    setParts.push('updated_at = ?');
    values.push(new Date().toISOString());
  }

  values.push(packageId);

  return db.prepare(
    `UPDATE intl_package
     SET ${setParts.join(', ')}
     WHERE id = ?`
  ).bind(...values);
}

async function buildDebtRestorePlan(db, row, reversalId) {
  const type = String(row.type || '').toLowerCase();
  const category = String(row.category_id || '').toLowerCase();
  const notes = String(row.notes || '');

  const looksLikeDebtPayment =
    type === 'repay' ||
    type === 'debt_out' ||
    category.includes('debt') ||
    notes.toLowerCase().includes('debt');

  if (!looksLikeDebtPayment) {
    return null;
  }

  const debtColumns = await getTableColumns(db, 'debts');

  if (!debtColumns.size) {
    return {
      summary: {
        status: 'skipped',
        reason: 'debts table not found',
        row_id: row.id,
        reversal_id: reversalId
      },
      statements: []
    };
  }

  const debtId =
    extractMarkerValue(notes, 'debt_id') ||
    extractMarkerValue(notes, 'debt') ||
    row.debt_id ||
    null;

  if (!debtId) {
    return {
      summary: {
        status: 'skipped',
        reason: 'no debt id marker found',
        row_id: row.id,
        reversal_id: reversalId
      },
      statements: []
    };
  }

  const amount = Math.abs(Number(row.amount) || 0);
  const statements = [];

  if (debtColumns.has('paid_amount')) {
    statements.push(
      db.prepare(
        `UPDATE debts
         SET paid_amount = MAX(0, COALESCE(paid_amount, 0) - ?)
         WHERE id = ?`
      ).bind(amount, debtId)
    );
  }

  if (debtColumns.has('status')) {
    statements.push(
      db.prepare(
        `UPDATE debts
         SET status = CASE
           WHEN COALESCE(paid_amount, 0) - ? <= 0 THEN 'active'
           ELSE status
         END
         WHERE id = ?`
      ).bind(amount, debtId)
    );
  }

  return {
    summary: {
      status: statements.length ? 'planned' : 'skipped',
      reason: statements.length ? 'debt paid_amount restore' : 'debts table lacks restorable columns',
      debt_id: debtId,
      amount,
      row_id: row.id,
      reversal_id: reversalId
    },
    statements
  };
}

function mergeDebtRestorePlans(db, first, second) {
  const plans = [first, second].filter(Boolean);

  if (!plans.length) return null;

  return {
    summary: plans.map(plan => plan.summary),
    statements: plans.flatMap(plan => plan.statements || [])
  };
}

async function ledgerHealth(context) {
  const db = context.env.DB;
  const txColumns = await getTableColumns(db, 'transactions');

  const rowsResult = await db.prepare(
    `SELECT ${selectTransactionColumns(txColumns).join(', ')}
     FROM transactions
     ORDER BY date DESC, datetime(created_at) DESC, id DESC
     LIMIT 5000`
  ).all();

  const rows = (rowsResult.results || []).map(row => decorateTransaction(row));
  const byId = new Map(rows.map(row => [row.id, row]));

  const active = rows.filter(row => !row.is_reversal);
  const reversalRows = rows.filter(row => row.is_reversal);
  const reversedOriginals = rows.filter(row => row.is_reversed && !row.is_reversal);

  const orphanLinkedRows = [];
  const linkedSeen = new Set();

  for (const row of rows) {
    const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

    if (!linkedId) continue;

    const key = [row.id, linkedId].sort().join('::');

    if (linkedSeen.has(key)) continue;

    linkedSeen.add(key);

    if (!byId.has(linkedId)) {
      orphanLinkedRows.push({
        id: row.id,
        linked_id: linkedId
      });
    }
  }

  const packageGroups = new Map();

  for (const row of rows) {
    if (!row.intl_package_id) continue;

    if (!packageGroups.has(row.intl_package_id)) {
      packageGroups.set(row.intl_package_id, []);
    }

    packageGroups.get(row.intl_package_id).push(row);
  }

  const orphanPackageRows = [];

  for (const [packageId, groupRows] of packageGroups.entries()) {
    const activeRows = groupRows.filter(row => !row.is_reversal);
    const reversalCount = groupRows.filter(row => row.is_reversal).length;

    if (activeRows.length > 0 && reversalCount > 0 && reversalCount !== activeRows.length) {
      orphanPackageRows.push({
        intl_package_id: packageId,
        active_count: activeRows.length,
        reversal_count: reversalCount
      });
    }
  }

  const missingAccountRefs = rows
    .filter(row => !row.account_id)
    .map(row => row.id);

  const missingCategoryRefs = rows
    .filter(row => row.type !== 'transfer' && !row.is_reversal && !row.category_id)
    .map(row => row.id);

  const fxRows = rows.filter(row => row.currency && row.currency !== 'PKR');
  const fxCovered = fxRows.filter(row => Number(row.fx_rate_at_commit) > 0);

  const transferInvariant = checkTransferInvariant(rows);

  const reversalIntegrity = checkReversalIntegrity(rows);

  return jsonResponse({
    ok: true,
    version: VERSION,
    health: {
      total_scanned: rows.length,
      active_count: active.length,
      reversal_count: reversalRows.length,
      reversed_original_count: reversedOriginals.length,
      orphan_linked_rows: orphanLinkedRows,
      orphan_package_rows: orphanPackageRows,
      missing_account_refs: missingAccountRefs,
      missing_category_refs: missingCategoryRefs,
      fx_snapshot_coverage: {
        foreign_rows: fxRows.length,
        covered_rows: fxCovered.length,
        coverage_pct: fxRows.length ? roundMoney((fxCovered.length / fxRows.length) * 100) : 100
      },
      transfer_invariant_ok: transferInvariant.ok,
      transfer_invariant_errors: transferInvariant.errors,
      reversal_integrity_ok: reversalIntegrity.ok,
      reversal_integrity_errors: reversalIntegrity.errors,
      status: (
        orphanLinkedRows.length ||
        orphanPackageRows.length ||
        missingAccountRefs.length ||
        missingCategoryRefs.length ||
        !transferInvariant.ok ||
        !reversalIntegrity.ok
      ) ? 'warn' : 'pass'
    }
  });
}

function checkTransferInvariant(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const errors = [];

  for (const row of rows) {
    const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

    if (!linkedId) continue;

    const linked = byId.get(linkedId);

    if (!linked) {
      errors.push({
        id: row.id,
        linked_id: linkedId,
        error: 'missing linked row'
      });
      continue;
    }

    const sameAmount =
      roundMoney(Math.abs(Number(row.amount || 0))) ===
      roundMoney(Math.abs(Number(linked.amount || 0)));

    if (!sameAmount) {
      errors.push({
        id: row.id,
        linked_id: linkedId,
        error: 'linked amount mismatch'
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function checkReversalIntegrity(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const errors = [];

  for (const row of rows) {
    if (!row.is_reversal) continue;

    const originalId = extractReversalOriginalId(row.notes);

    if (!originalId) {
      errors.push({
        id: row.id,
        error: 'reversal row missing original id marker'
      });
      continue;
    }

    const original = byId.get(originalId);

    if (!original) {
      errors.push({
        id: row.id,
        original_id: originalId,
        error: 'original row not found in scan window'
      });
      continue;
    }

    const sameAbsAmount =
      roundMoney(Math.abs(Number(row.amount || 0))) ===
      roundMoney(Math.abs(Number(original.amount || 0)));

    if (!sameAbsAmount) {
      errors.push({
        id: row.id,
        original_id: originalId,
        error: 'reversal amount mismatch'
      });
    }
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
    'created_by',
    'created_at'
  ];

  return wanted.filter(col => columns.has(col));
}

function decorateTransaction(row) {
  const notes = String(row.notes || '');
  const isReversal = isReversalRow(row);
  const isReversed = !!(row.reversed_by || row.reversed_at || notes.includes(REVERSED_BY_PREFIX));
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

function isNegativeType(type) {
  const t = String(type || '').toLowerCase();

  return [
    'expense',
    'transfer',
    'cc_spend',
    'repay',
    'atm',
    'debt_out'
  ].includes(t);
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);

  return match ? match[1].trim() : null;
}

function extractReversalOriginalId(notes) {
  const match = String(notes || '').match(/\[REVERSAL OF\s+([^\]]+)\]/i);

  return match ? match[1].trim() : null;
}

function extractMarkerValue(notes, key) {
  const re = new RegExp('\\[' + key + '\\s*:\\s*([^\\]]+)\\]', 'i');
  const match = String(notes || '').match(re);

  return match ? match[1].trim() : null;
}

async function getTableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = new Set();

    for (const row of result.results || []) {
      if (row.name) {
        columns.add(row.name);
      }
    }

    return columns;
  } catch (err) {
    return new Set();
  }
}

function filterInsertable(columns, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (columns.has(key)) {
      out[key] = value;
    }
  }

  return out;
}

function buildInsertStatement(db, table, row) {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map(key => row[key]);

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
  ).bind(...values);
}

async function safeAudit(context, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail || {})
    };

    const result = await audit(context.env, payload);

    return {
      ok: !!(result && result.ok),
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
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

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function roundMoney(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}