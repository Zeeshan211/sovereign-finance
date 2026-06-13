/* functions/api/transactions/reverse.js
 * Sovereign Finance · Canonical Transaction Reversal
 * v0.6.1-user-scoped
 *
 * Contract:
 * - This file owns POST /api/transactions/reverse.
 * - Reversal is append-only.
 * - Original rows are never deleted.
 * - Reversal rows are inserted.
 * - Original rows are marked reversed.
 * - Linked pairs reverse as pairs.
 * - Intl package rows reverse as packages.
 * - Debt and bill module state is repaired when markers are present.
 * - No Debts API list/create/payment logic belongs in this file.
 */

import { getUserId } from '../_lib.js';

const VERSION = 'v0.6.1-user-scoped';
const CONTRACT_VERSION = 'ledger-reversal-v1';

const REVERSAL_PREFIX = '[REVERSAL OF ';
const REVERSED_BY_PREFIX = '[REVERSED BY ';

const IN_TYPES = new Set([
  'income',
  'salary',
  'opening',
  'borrow',
  'debt_in',
  'adjustment_positive'
]);

const OUT_TYPES = new Set([
  'expense',
  'transfer',
  'cc_payment',
  'cc_spend',
  'repay',
  'atm',
  'debt_out',
  'adjustment_negative'
]);

export async function onRequestGet() {
  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    route: '/api/transactions/reverse',
    method: 'POST',
    required_body: {
      transaction_id: 'string',
      reason: 'string'
    },
    aliases: {
      id: 'transaction_id'
    },
    rules: [
      'append-only reversal',
      'original rows are marked reversed',
      'reversal rows are inserted',
      'linked pairs reverse together',
      'module markers trigger repair hooks'
    ]
  });
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, version: VERSION, contract_version: CONTRACT_VERSION, action: 'reverse_transaction', error: 'Unauthorized', code: 'UNAUTHORIZED', committed: false }, 401);
    const body = await readJSON(context.request);

    const transactionId = cleanText(body.transaction_id || body.id, '', 200);
    const reason = cleanText(body.reason, '', 500);
    const createdBy = cleanText(body.created_by, 'web-ledger', 100) || 'web-ledger';

    if (!transactionId) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: 'transaction_id required',
        code: 'TRANSACTION_ID_REQUIRED',
        committed: false
      }, 400);
    }

    if (!reason) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: 'reason required',
        code: 'REASON_REQUIRED',
        committed: false
      }, 400);
    }

    const txColumns = await tableColumns(db, 'transactions');

    if (!txColumns.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: 'transactions table missing id column',
        code: 'TRANSACTIONS_SCHEMA_INVALID',
        committed: false
      }, 500);
    }

    const target = await selectTransactionById(db, txColumns, transactionId, userId);

    if (!target) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: 'transaction not found',
        code: 'TRANSACTION_NOT_FOUND',
        transaction_id: transactionId,
        committed: false
      }, 404);
    }

    const decoratedTarget = decorateTransaction(target);

    if (decoratedTarget.is_reversal) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: 'Cannot reverse a reversal row',
        code: 'REVERSAL_ROW_BLOCKED',
        transaction_id: transactionId,
        committed: false
      }, 409);
    }

    if (decoratedTarget.is_reversed) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: 'Transaction already reversed',
        code: 'ALREADY_REVERSED',
        transaction_id: transactionId,
        reversed_by: target.reversed_by || null,
        reversed_at: target.reversed_at || null,
        committed: false
      }, 409);
    }

    const plan = await buildReversalPlan(db, txColumns, decoratedTarget, reason, createdBy, userId);

    if (!plan.ok) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'reverse_transaction',
        error: plan.error,
        code: plan.code || 'REVERSAL_BLOCKED',
        details: plan.details || null,
        committed: false
      }, plan.status || 409);
    }

    const statements = [];

    for (const row of plan.reversal_rows) {
      statements.push(buildInsertStatement(db, 'transactions', filterToCols(txColumns, row)));
    }

    for (const original of plan.original_rows) {
      statements.push(buildMarkReversedStatement(
        db,
        txColumns,
        original.id,
        plan.reversal_ids.join(','),
        reason,
        plan.now,
        userId
      ));
    }

    if (plan.module_repair && Array.isArray(plan.module_repair.statements)) {
      statements.push(...plan.module_repair.statements);
    }

    await db.batch(statements);

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'reverse_transaction',
      committed: true,
      reversed_id: transactionId,
      kind: plan.kind,
      original_transaction_ids: plan.original_rows.map(row => row.id),
      reversal_transaction_ids: plan.reversal_ids,
      reversal_ids: plan.reversal_ids,
      ledger: {
        original_rows_marked_reversed: plan.original_rows.length,
        reversal_rows_created: plan.reversal_rows.length,
        append_only: true
      },
      account: {
        balance_source: 'ledger',
        should_restore_through_reversal_rows: true,
        impacts: plan.reversal_rows.map(row => ({
          transaction_id: row.id,
          account_id: row.account_id || null,
          type: row.type,
          amount: Math.abs(Number(row.pkr_amount || row.amount || 0)),
          account_delta: signedAmount(row.type, Math.abs(Number(row.pkr_amount || row.amount || 0)))
        }))
      },
      module_repair: plan.module_repair ? plan.module_repair.summary : {
        status: 'not_required'
      },
      warnings: plan.warnings || []
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'reverse_transaction',
      error: err && err.message ? err.message : String(err),
      committed: false
    }, 500);
  }
}

async function buildReversalPlan(db, txColumns, target, reason, createdBy, userId) {
  const now = nowISO();

  if (target.intl_package_id) {
    return buildIntlPackageReversalPlan(db, txColumns, target, reason, createdBy, now, userId);
  }

  const linkedId = target.linked_txn_id || extractLinkedId(target.notes);

  if (linkedId) {
    return buildLinkedPairReversalPlan(db, txColumns, target, linkedId, reason, createdBy, now, userId);
  }

  return buildSingleReversalPlan(db, txColumns, target, reason, createdBy, now, userId);
}

async function buildSingleReversalPlan(db, txColumns, target, reason, createdBy, now, userId) {
  const moduleRepairPrecheck = await precheckModuleRepair(db, [target], userId);

  if (!moduleRepairPrecheck.ok) {
    return moduleRepairPrecheck;
  }

  const reversalId = makeTxnId('rv');
  const reversalRow = makeReversalRow(txColumns, target, reversalId, reason, createdBy, now, null, userId);
  const moduleRepair = await buildModuleRepairPlan(db, [target], [reversalId], userId);

  return {
    ok: true,
    kind: 'single',
    now,
    original_rows: [target],
    reversal_rows: [reversalRow],
    reversal_ids: [reversalId],
    module_repair: moduleRepair,
    warnings: []
  };
}

async function buildLinkedPairReversalPlan(db, txColumns, target, linkedId, reason, createdBy, now, userId) {
  const linked = await selectTransactionById(db, txColumns, linkedId, userId);

  if (!linked) {
    return {
      ok: false,
      status: 409,
      code: 'LINKED_TRANSACTION_NOT_FOUND',
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
      code: 'LINKED_TRANSACTION_NOT_ELIGIBLE',
      error: 'Linked transaction is not eligible for reversal.',
      details: {
        target_id: target.id,
        linked_id: linkedId,
        linked_is_reversal: linkedState.is_reversal,
        linked_is_reversed: linkedState.is_reversed
      }
    };
  }

  const originals = [target, linkedState];
  const moduleRepairPrecheck = await precheckModuleRepair(db, originals, userId);

  if (!moduleRepairPrecheck.ok) {
    return moduleRepairPrecheck;
  }

  const firstReversalId = makeTxnId('rv');
  const secondReversalId = makeTxnId('rv');

  const firstReversal = makeReversalRow(txColumns, target, firstReversalId, reason, createdBy, now, secondReversalId, userId);
  const secondReversal = makeReversalRow(txColumns, linkedState, secondReversalId, reason, createdBy, now, firstReversalId, userId);

  const moduleRepair = await buildModuleRepairPlan(db, originals, [firstReversalId, secondReversalId], userId);

  return {
    ok: true,
    kind: 'linked_pair',
    now,
    original_rows: originals,
    reversal_rows: [firstReversal, secondReversal],
    reversal_ids: [firstReversalId, secondReversalId],
    module_repair: moduleRepair,
    warnings: []
  };
}

async function buildIntlPackageReversalPlan(db, txColumns, target, reason, createdBy, now, userId) {
  const packageId = target.intl_package_id;

  const rowsResult = await db.prepare(
    `SELECT ${selectTransactionColumns(txColumns).join(', ')}
     FROM transactions
     WHERE intl_package_id = ? AND user_id = ?
     ORDER BY date ASC, datetime(created_at) ASC, id ASC`
  ).bind(packageId, userId).all();

  const packageRows = (rowsResult.results || []).map(row => decorateTransaction(row));

  if (!packageRows.length) {
    return {
      ok: false,
      status: 409,
      code: 'INTL_PACKAGE_EMPTY',
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
      code: 'INTL_PACKAGE_ALREADY_REVERSED',
      error: 'Intl package contains rows that are already reversed or reversal rows.',
      details: {
        intl_package_id: packageId,
        blocked_ids: blocked.map(row => row.id)
      }
    };
  }

  const moduleRepairPrecheck = await precheckModuleRepair(db, packageRows, userId);

  if (!moduleRepairPrecheck.ok) {
    return moduleRepairPrecheck;
  }

  const reversalRows = [];
  const reversalIds = [];

  for (const row of packageRows) {
    const reversalId = makeTxnId('rv');
    reversalIds.push(reversalId);
    reversalRows.push(makeReversalRow(txColumns, row, reversalId, reason, createdBy, now, null, userId));
  }

  const moduleRepair = await buildModuleRepairPlan(db, packageRows, reversalIds, userId);

  return {
    ok: true,
    kind: 'intl_package',
    intl_package_id: packageId,
    now,
    original_rows: packageRows,
    reversal_rows: reversalRows,
    reversal_ids: reversalIds,
    module_repair: moduleRepair,
    warnings: []
  };
}

function makeReversalRow(txColumns, original, reversalId, reason, createdBy, now, linkedReversalId, userId) {
  const originalAmount = Math.abs(Number(original.amount || original.pkr_amount || 0));
  const originalPkrAmount = Math.abs(Number(original.pkr_amount || original.amount || 0));
  const reversalType = reversalTypeFor(original.type);

  const notes = `${REVERSAL_PREFIX}${original.id}] ${reason}`.slice(0, 240);

  const row = {
    id: reversalId,
    date: todayISO(),
    type: reversalType,
    amount: roundMoney(originalAmount),
    account_id: original.account_id,
    transfer_to_account_id: original.transfer_to_account_id || null,
    linked_txn_id: linkedReversalId || null,
    category_id: original.category_id || null,
    merchant_id: original.merchant_id || null,
    merchant: original.merchant || null,
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
    source_module: original.source_module || 'transactions',
    source_id: original.source_id || original.id,
    source_action: 'reversal',
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    user_id: userId || null
  };

  return filterToCols(txColumns, row);
}

function reversalTypeFor(type) {
  const normalized = String(type || '').toLowerCase();

  if (normalized === 'adjustment_positive') return 'adjustment_negative';
  if (normalized === 'adjustment_negative') return 'adjustment_positive';

  if (IN_TYPES.has(normalized)) return 'expense';
  if (OUT_TYPES.has(normalized)) return 'income';

  return 'expense';
}

function buildMarkReversedStatement(db, txColumns, originalId, reversalIds, reason, now, userId) {
  const setParts = [];
  const values = [];

  if (txColumns.has('reversed_by')) {
    setParts.push('reversed_by = ?');
    values.push(reversalIds);
  }

  if (txColumns.has('reversed_at')) {
    setParts.push('reversed_at = ?');
    values.push(now);
  }

  if (txColumns.has('updated_at')) {
    setParts.push('updated_at = ?');
    values.push(now);
  }

  if (txColumns.has('notes')) {
    const marker = `${REVERSED_BY_PREFIX}${reversalIds}] ${reason}`.slice(0, 240);

    setParts.push(
      `notes = CASE
        WHEN notes IS NULL OR notes = '' THEN ?
        ELSE substr(notes || ' ' || ?, 1, 240)
      END`
    );

    values.push(marker, marker);
  }

  if (!setParts.length) {
    throw new Error('transactions table has no reversal marker columns');
  }

  values.push(originalId);

  return db.prepare(
    `UPDATE transactions
     SET ${setParts.join(', ')}
     WHERE id = ? AND user_id = ?`
  ).bind(...values, userId);
}

async function precheckModuleRepair(db, originalRows, userId) {
  for (const row of originalRows) {
    if (!isDebtOrigin(row)) continue;

    const debtId = extractDebtId(row.notes);

    if (!debtId) continue;

    const activePaymentCount = await countActiveDebtPaymentRefs(db, debtId, userId);

    if (activePaymentCount > 0) {
      return {
        ok: false,
        status: 409,
        code: 'DEBT_ORIGIN_HAS_PAYMENTS',
        error: 'Reverse debt payments before reversing the debt origin transaction.',
        details: {
          debt_id: debtId,
          active_payment_refs: activePaymentCount,
          original_transaction_id: row.id
        }
      };
    }
  }

  return {
    ok: true
  };
}

async function buildModuleRepairPlan(db, originalRows, reversalIds, userId) {
  const statements = [];
  const repairs = [];

  for (let i = 0; i < originalRows.length; i += 1) {
    const row = originalRows[i];
    const reversalId = reversalIds[i] || reversalIds[0];

    const debtPaymentRepair = await buildDebtPaymentRepair(db, row, reversalId, userId);

    if (debtPaymentRepair) {
      statements.push(...debtPaymentRepair.statements);
      repairs.push(debtPaymentRepair.summary);
    }

    const debtOriginRepair = await buildDebtOriginRepair(db, row, reversalId, userId);

    if (debtOriginRepair) {
      statements.push(...debtOriginRepair.statements);
      repairs.push(debtOriginRepair.summary);
    }

    const billPaymentRepair = await buildBillPaymentRepair(db, row, reversalId, userId);

    if (billPaymentRepair) {
      statements.push(...billPaymentRepair.statements);
      repairs.push(billPaymentRepair.summary);
    }
  }

  if (!repairs.length) {
    return {
      summary: {
        status: 'not_required'
      },
      statements: []
    };
  }

  return {
    summary: {
      status: 'planned',
      repairs
    },
    statements
  };
}

async function buildDebtPaymentRepair(db, row, reversalId, userId) {
  if (!isDebtPayment(row)) return null;

  const debtId = extractDebtId(row.notes);

  if (!debtId) {
    return {
      summary: {
        module: 'debts',
        status: 'skipped',
        reason: 'debt payment marker found but debt_id missing',
        original_transaction_id: row.id,
        reversal_transaction_id: reversalId
      },
      statements: []
    };
  }

  const debtCols = await tableColumns(db, 'debts');
  const paymentCols = await tableColumns(db, 'debt_payments');

  const amount = Math.abs(Number(row.amount || row.pkr_amount || 0));
  const statements = [];

  if (debtCols.has('paid_amount')) {
    const setParts = [
      'paid_amount = MAX(0, COALESCE(paid_amount, 0) - ?)'
    ];
    const values = [amount];

    if (debtCols.has('status')) {
      setParts.push(
        `status = CASE
          WHEN MAX(0, COALESCE(paid_amount, 0) - ?) < COALESCE(original_amount, 0) THEN 'active'
          ELSE status
        END`
      );
      values.push(amount);
    }

    if (debtCols.has('updated_at')) {
      setParts.push('updated_at = ?');
      values.push(nowISO());
    }

    values.push(debtId);

    statements.push(
      db.prepare(
        `UPDATE debts
         SET ${setParts.join(', ')}
         WHERE TRIM(id) = TRIM(?) AND user_id = ?`
      ).bind(...values, userId)
    );
  }

  if (paymentCols.size > 0) {
    const paymentUpdate = buildOptionalUpdateStatement(db, 'debt_payments', paymentCols, {
      status: 'reversed',
      reversed_at: nowISO(),
      reversal_transaction_id: reversalId,
      notes: `Reversed by ${reversalId}`
    }, 'TRIM(transaction_id) = TRIM(?) AND user_id = ?', [row.id, userId]);

    if (paymentUpdate) statements.push(paymentUpdate);
  }

  return {
    summary: {
      module: 'debts',
      action: 'reverse_payment',
      debt_id: debtId,
      amount,
      original_transaction_id: row.id,
      reversal_transaction_id: reversalId,
      status: statements.length ? 'planned' : 'skipped'
    },
    statements
  };
}

async function buildDebtOriginRepair(db, row, reversalId, userId) {
  if (!isDebtOrigin(row)) return null;

  const debtId = extractDebtId(row.notes);

  if (!debtId) {
    return {
      summary: {
        module: 'debts',
        status: 'skipped',
        reason: 'debt origin marker found but debt_id missing',
        original_transaction_id: row.id,
        reversal_transaction_id: reversalId
      },
      statements: []
    };
  }

  const debtCols = await tableColumns(db, 'debts');
  const statements = [];

  if (debtCols.has('status')) {
    const updates = {
      status: 'archived'
    };

    if (debtCols.has('updated_at')) {
      updates.updated_at = nowISO();
    }

    const update = buildOptionalUpdateStatement(
      db,
      'debts',
      debtCols,
      updates,
      'TRIM(id) = TRIM(?) AND user_id = ?',
      [debtId, userId]
    );

    if (update) statements.push(update);
  }

  return {
    summary: {
      module: 'debts',
      action: 'reverse_origin',
      debt_id: debtId,
      original_transaction_id: row.id,
      reversal_transaction_id: reversalId,
      status_after: debtCols.has('status') ? 'archived' : 'unknown',
      status: statements.length ? 'planned' : 'skipped'
    },
    statements
  };
}

async function buildBillPaymentRepair(db, row, reversalId, userId) {
  if (!isBillPayment(row)) return null;

  const billId = extractToken(row.notes, 'bill_id');
  const billMonth = extractToken(row.notes, 'bill_month');
  const paymentCols = await tableColumns(db, 'bill_payments');
  const statements = [];

  if (paymentCols.size > 0) {
    const update = buildOptionalUpdateStatement(db, 'bill_payments', paymentCols, {
      status: 'reversed',
      reversed_at: nowISO(),
      reversal_transaction_id: reversalId,
      notes: `Reversed by ${reversalId}`
    }, 'TRIM(transaction_id) = TRIM(?) AND user_id = ?', [row.id, userId]);

    if (update) statements.push(update);
  }

  return {
    summary: {
      module: 'bills',
      action: 'reverse_payment',
      bill_id: billId || null,
      bill_month: billMonth || null,
      original_transaction_id: row.id,
      reversal_transaction_id: reversalId,
      status: statements.length ? 'planned' : 'skipped'
    },
    statements
  };
}

async function countActiveDebtPaymentRefs(db, debtId, userId) {
  let count = 0;

  const txCols = await tableColumns(db, 'transactions');

  if (txCols.has('notes')) {
    const where = [
      'notes LIKE ?',
      "(notes LIKE '%[DEBT_PAYMENT]%' OR notes LIKE '%[DEBT_RECEIVE]%')",
      "notes NOT LIKE '%[REVERSAL OF %'"
    ];

    if (txCols.has('reversed_by')) {
      where.push("(reversed_by IS NULL OR reversed_by = '')");
    }

    if (txCols.has('reversed_at')) {
      where.push("(reversed_at IS NULL OR reversed_at = '')");
    }

    const row = await db.prepare(
      `SELECT COUNT(*) AS c
       FROM transactions
       WHERE ${where.join(' AND ')} AND user_id = ?`
    ).bind(`%debt_id=${debtId}%`, userId).first();

    count += Number(row && row.c || 0);
  }

  const paymentCols = await tableColumns(db, 'debt_payments');

  if (paymentCols.size > 0 && paymentCols.has('debt_id')) {
    const where = ['TRIM(debt_id) = TRIM(?)'];

    if (paymentCols.has('status')) {
      where.push("(status IS NULL OR status = '' OR status = 'paid' OR status = 'active')");
    }

    const row = await db.prepare(
      `SELECT COUNT(*) AS c
       FROM debt_payments
       WHERE ${where.join(' AND ')} AND user_id = ?`
    ).bind(debtId, userId).first();

    count += Number(row && row.c || 0);
  }

  return count;
}

function isDebtPayment(row) {
  const notes = String(row.notes || '').toUpperCase();
  return notes.includes('[DEBT_PAYMENT]') || notes.includes('[DEBT_RECEIVE]');
}

function isDebtOrigin(row) {
  const notes = String(row.notes || '').toUpperCase();
  return notes.includes('[DEBT_ORIGIN]') || notes.includes('[DEBT_ORIGIN_REPAIR]');
}

function isBillPayment(row) {
  const notes = String(row.notes || '').toUpperCase();
  return notes.includes('[BILL_PAYMENT]') || notes.includes('BILL_ID=');
}

function extractDebtId(notes) {
  return extractToken(notes, 'debt_id') || extractToken(notes, 'debt');
}

function extractToken(notes, key) {
  const re = new RegExp(`${key}=([A-Za-z0-9_-]+)`, 'i');
  const match = String(notes || '').match(re);
  return match ? match[1].trim() : null;
}

function buildOptionalUpdateStatement(db, table, columns, desired, whereSql, whereValues) {
  const setParts = [];
  const values = [];

  for (const [key, value] of Object.entries(desired)) {
    if (!columns.has(key)) continue;

    if (key === 'notes') {
      setParts.push(
        `notes = CASE
          WHEN notes IS NULL OR notes = '' THEN ?
          ELSE substr(notes || ' | ' || ?, 1, 1000)
        END`
      );
      values.push(value, value);
      continue;
    }

    setParts.push(`${key} = ?`);
    values.push(value);
  }

  if (!setParts.length) return null;

  return db.prepare(
    `UPDATE ${table}
     SET ${setParts.join(', ')}
     WHERE ${whereSql}`
  ).bind(...values, ...whereValues);
}

async function selectTransactionById(db, txColumns, id, userId) {
  const cols = selectTransactionColumns(txColumns);

  if (!cols.length) {
    throw new Error('transactions table has no readable columns');
  }

  return db.prepare(
    `SELECT ${cols.join(', ')}
     FROM transactions
     WHERE id = ? AND user_id = ?
     LIMIT 1`
  ).bind(id, userId).first();
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

function signedAmount(type, amount) {
  const normalized = String(type || '').toLowerCase();
  const n = Math.abs(Number(amount) || 0);

  if (IN_TYPES.has(normalized)) return n;
  if (OUT_TYPES.has(normalized)) return -n;

  return n;
}

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const set = new Set();

    for (const row of result.results || []) {
      if (row.name) set.add(row.name);
    }

    return set;
  } catch {
    return new Set();
  }
}

function filterToCols(cols, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function buildInsertStatement(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('No insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
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

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
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
