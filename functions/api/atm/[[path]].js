/* ─── /api/atm/[[path]] · Sovereign Finance ATM Engine ───
 * v0.2.0-atm-catchall-contract
 *
 * Contract:
 * - ATM withdrawal is bank/wallet/prepaid → cash.
 * - Source account decreases through ledger.
 * - Cash account increases through ledger.
 * - ATM fee is a separate source-account expense row.
 * - ATM fee must NOT be linked to the withdrawal transfer pair.
 * - No direct account balance mutation.
 * - Accounts remain ledger-derived from transactions_canonical.
 *
 * Supported:
 * - GET  /api/atm
 * - GET  /api/atm?action=health
 * - GET  /api/atm/health
 * - POST /api/atm
 * - POST /api/atm/withdraw
 * - POST /api/atm/reverse
 */

import { json, audit } from '../_lib.js';

const VERSION = 'v0.2.0-atm-catchall-contract';
const CONTRACT_VERSION = 'atm-v1';

const DEFAULT_SOURCE_ACCOUNT_ID = 'mashreq';
const DEFAULT_DEST_ACCOUNT_ID = 'cash';
const DEFAULT_FEE_PKR = 35;
const REVERSAL_WINDOW_DAYS = 10;
const MONTHLY_CAP_HINT = 15;

const ACTIVE_ACCOUNT_CONDITION = "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = cleanText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (action === 'health' || path[0] === 'health') {
      return atmHealth(db);
    }

    const [accountsRes, pendingFees, recentRows, feeStats] = await Promise.all([
      db.prepare(
        `SELECT id, name, icon, type, kind, display_order
         FROM accounts
         WHERE ${ACTIVE_ACCOUNT_CONDITION}
         ORDER BY display_order, name`
      ).all(),
      loadPendingFees(db),
      loadRecentATMRows(db),
      loadFeeStats30d(db)
    ]);

    const accounts = accountsRes.results || [];
    const sourceAccounts = accounts.filter(a => String(a.type || '').toLowerCase() === 'asset' && String(a.kind || '').toLowerCase() !== 'cc');
    const destinationAccounts = accounts.filter(a => String(a.type || '').toLowerCase() === 'asset' && String(a.kind || '').toLowerCase() !== 'cc');

    const totalPending = pendingFees.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const overdueCount = pendingFees.filter(row => Number(row.age_days) > REVERSAL_WINDOW_DAYS).length;

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      route: '/api/atm',
      supported_routes: [
        'GET /api/atm',
        'GET /api/atm?action=health',
        'POST /api/atm',
        'POST /api/atm/withdraw',
        'POST /api/atm/reverse'
      ],
      defaults: {
        source_account_id: DEFAULT_SOURCE_ACCOUNT_ID,
        destination_account_id: DEFAULT_DEST_ACCOUNT_ID,
        fee_pkr: DEFAULT_FEE_PKR,
        reversal_window_days: REVERSAL_WINDOW_DAYS,
        monthly_cap_hint: MONTHLY_CAP_HINT
      },
      accounts,
      source_accounts: sourceAccounts,
      destination_accounts: destinationAccounts,
      pending_fees: pendingFees,
      pending_count: pendingFees.length,
      total_pending_pkr: round2(totalPending),
      overdue_count: overdueCount,
      fees_30d: feeStats,
      recent_atm_rows: recentRows,
      rules: {
        source_account_impact: 'negative',
        cash_account_impact: 'positive',
        fee_account_impact: 'negative',
        fee_is_linked_to_withdrawal_pair: false,
        no_direct_balance_mutation: true,
        balance_source: 'transactions_canonical'
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = getPath(context);
    const body = await readJSON(context.request);
    const action = cleanText(path[0] || body.action || 'withdrawal', 'withdrawal', 80).toLowerCase();

    if (['withdraw', 'withdrawal', 'atm_withdrawal', 'create'].includes(action)) {
      return createATMWithdraw(context, body);
    }

    if (['reverse', 'fee_reverse', 'reverse_fee'].includes(action)) {
      return reverseATMFee(context, body);
    }

    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'Unsupported ATM action',
      code: 'UNSUPPORTED_ATM_ACTION',
      action,
      supported: ['/api/atm', '/api/atm/withdraw', '/api/atm/reverse']
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function createATMWithdraw(context, body) {
  const db = context.env.DB;

  const amount = moneyNumber(body.amount, null);
  const feeAmount = body.no_fee ? 0 : moneyNumber(body.fee_amount ?? body.fee ?? DEFAULT_FEE_PKR, DEFAULT_FEE_PKR);
  const sourceId = cleanId(body.source_account_id || body.from_account_id || body.account_id || DEFAULT_SOURCE_ACCOUNT_ID);
  const destId = cleanId(body.cash_account_id || body.destination_account_id || body.to_account_id || DEFAULT_DEST_ACCOUNT_ID);
  const atmName = cleanText(body.atm_name || body.atm || 'ATM', 80);
  const date = cleanDate(body.date || body.withdrawal_date);
  const notes = cleanText(body.notes || `ATM withdrawal at ${atmName}`, 300);
  const createdBy = cleanText(body.created_by || 'web-atm', 100);
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id || '', 180);

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'amount must be greater than 0',
      code: 'INVALID_AMOUNT',
      committed: false
    }, 400);
  }

  if (feeAmount < 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'fee_amount cannot be negative',
      code: 'INVALID_FEE_AMOUNT',
      committed: false
    }, 400);
  }

  if (!sourceId || !destId) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source and destination accounts are required',
      code: 'ACCOUNTS_REQUIRED',
      committed: false
    }, 400);
  }

  if (sourceId === destId) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source and destination accounts cannot match',
      code: 'SAME_SOURCE_AND_DESTINATION',
      committed: false
    }, 400);
  }

  const [accountCols, txCols] = await Promise.all([
    tableColumns(db, 'accounts'),
    tableColumns(db, 'transactions')
  ]);

  if (!accountCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'accounts table missing id column',
      code: 'ACCOUNTS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  if (!txCols.has('id') || !txCols.has('account_id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'transactions table missing required columns',
      code: 'TRANSACTIONS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  const accounts = await loadAccountMap(db, [sourceId, destId]);

  if (!accounts[sourceId]) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source account not found or inactive',
      code: 'SOURCE_ACCOUNT_NOT_FOUND',
      account_id: sourceId,
      committed: false
    }, 404);
  }

  if (!accounts[destId]) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'destination account not found or inactive',
      code: 'DESTINATION_ACCOUNT_NOT_FOUND',
      account_id: destId,
      committed: false
    }, 404);
  }

  const source = accounts[sourceId];
  const dest = accounts[destId];

  if (String(source.type || '').toLowerCase() !== 'asset' || String(dest.type || '').toLowerCase() !== 'asset') {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'ATM source and destination must both be asset accounts',
      code: 'ATM_ACCOUNTS_MUST_BE_ASSETS',
      committed: false
    }, 400);
  }

  const shouldCreateFee = feeAmount > 0 && !isOwnATM(sourceId, atmName, body.no_fee);
  const atmId = makeTxnId('atm');
  const outId = makeTxnId('atmout');
  const inId = makeTxnId('atmin');
  const feeId = shouldCreateFee ? makeTxnId('atmfee') : null;
  const createdAt = nowISO();

  const outNotes = `[ATM_WITHDRAWAL] atm_id=${atmId} side=source source_account_id=${sourceId} cash_account_id=${destId} ${notes} [linked: ${inId}]`.slice(0, 240);
  const inNotes = `[ATM_WITHDRAWAL] atm_id=${atmId} side=cash source_account_id=${sourceId} cash_account_id=${destId} ${notes} [linked: ${outId}]`.slice(0, 240);

  const outRow = filterToCols(txCols, {
    id: outId,
    date,
    type: 'transfer',
    amount,
    pkr_amount: amount,
    account_id: sourceId,
    transfer_to_account_id: destId,
    linked_txn_id: inId,
    category_id: null,
    merchant_id: null,
    merchant: atmName,
    notes: outNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: atmId,
    source_action: 'withdrawal_source',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:source` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const inRow = filterToCols(txCols, {
    id: inId,
    date,
    type: 'income',
    amount,
    pkr_amount: amount,
    account_id: destId,
    transfer_to_account_id: sourceId,
    linked_txn_id: outId,
    category_id: null,
    merchant_id: null,
    merchant: atmName,
    notes: inNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: atmId,
    source_action: 'withdrawal_cash',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:cash` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const statements = [
    buildInsert(db, 'transactions', outRow),
    buildInsert(db, 'transactions', inRow)
  ];

  let feeRow = null;

  if (shouldCreateFee) {
    const feeCategoryId = await resolveCategoryId(db, 'atm_fee');

    feeRow = filterToCols(txCols, {
      id: feeId,
      date,
      type: 'atm',
      amount: feeAmount,
      pkr_amount: feeAmount,
      account_id: sourceId,
      transfer_to_account_id: null,
      linked_txn_id: null,
      category_id: feeCategoryId,
      merchant_id: null,
      merchant: atmName,
      notes: `[ATM_FEE_PENDING] atm_id=${atmId} source_account_id=${sourceId} ${atmName} ATM fee auto-flag if not reversed in ${REVERSAL_WINDOW_DAYS} days`.slice(0, 240),
      fee_amount: 0,
      pra_amount: 0,
      currency: 'PKR',
      fx_rate_at_commit: 1,
      fx_source: 'PKR-base',
      source_module: 'atm',
      source_id: atmId,
      source_action: 'withdrawal_fee',
      idempotency_key: idempotencyKey ? `${idempotencyKey}:fee` : null,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: createdAt
    });

    statements.push(buildInsert(db, 'transactions', feeRow));
  }

  await db.batch(statements);

  const auditResult = await safeAudit(context.env, {
    action: 'ATM_WITHDRAW',
    entity: 'transaction',
    entity_id: outId,
    kind: 'mutation',
    detail: {
      atm_id: atmId,
      amount,
      fee_amount: shouldCreateFee ? feeAmount : 0,
      source_account_id: sourceId,
      destination_account_id: destId,
      atm_name: atmName,
      out_id: outId,
      in_id: inId,
      fee_id: feeId,
      fee_pending: shouldCreateFee,
      fee_linked_to_pair: false,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm_withdrawal',
    committed: true,
    atm_id: atmId,
    transaction_ids: shouldCreateFee ? [outId, inId, feeId] : [outId, inId],
    ids: shouldCreateFee ? [outId, inId, feeId] : [outId, inId],
    transfer_pair: {
      source_transaction_id: outId,
      cash_transaction_id: inId,
      linked: true,
      amount
    },
    fee_transaction: shouldCreateFee
      ? {
        id: feeId,
        amount: feeAmount,
        linked_to_transfer_pair: false
      }
      : null,
    account_impact: {
      balance_source: 'transactions_canonical',
      source_account_id: sourceId,
      source_account_delta: round2(-amount - (shouldCreateFee ? feeAmount : 0)),
      cash_account_id: destId,
      cash_account_delta: amount
    },
    ledger: {
      rows_created: shouldCreateFee ? 3 : 2,
      withdrawal_pair_created: true,
      fee_row_created: shouldCreateFee,
      fee_row_linked_to_pair: false
    },
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    warnings: []
  });
}

async function reverseATMFee(context, body) {
  const db = context.env.DB;
  const createdBy = cleanText(body.created_by || 'web-atm-reverse', 100);
  const feeTxnId = cleanText(body.fee_txn_id || body.id || '', 160);
  const amount = body.amount != null ? Number(body.amount) : null;

  const pending = await loadPendingFees(db);
  let target = null;

  if (feeTxnId) {
    target = pending.find(row => row.id === feeTxnId);
  } else if (amount && Number.isFinite(amount) && amount > 0) {
    target = pending.find(row => Math.abs((Number(row.amount) || 0) - amount) < 0.01);
  } else {
    target = pending[0] || null;
  }

  if (!target) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_fee_reverse',
      error: 'No matching pending ATM fee found',
      code: 'NO_PENDING_ATM_FEE_FOUND',
      committed: false
    }, 404);
  }

  const txCols = await tableColumns(db, 'transactions');
  const reversalId = makeTxnId('atmrev');
  const date = cleanDate(body.date);
  const createdAt = nowISO();

  const reverseNotes = `[ATM_FEE_REVERSAL] fee_txn_id=${target.id} Reversal of ATM fee`.slice(0, 240);
  const updatedOriginalNotes = `${target.notes || ''} [ATM_FEE_REVERSED_BY: ${reversalId}]`.slice(0, 240);

  const reversalRow = filterToCols(txCols, {
    id: reversalId,
    date,
    type: 'income',
    amount: Number(target.amount) || 0,
    pkr_amount: Number(target.amount) || 0,
    account_id: target.account_id,
    transfer_to_account_id: null,
    linked_txn_id: null,
    category_id: target.category_id || null,
    merchant_id: null,
    merchant: 'ATM',
    notes: reverseNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: extractAtmId(target.notes) || target.id,
    source_action: 'fee_reversal',
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const updates = [];
  updates.push(buildInsert(db, 'transactions', reversalRow));

  const updateParts = [];
  const values = [];

  if (txCols.has('notes')) {
    updateParts.push('notes = ?');
    values.push(updatedOriginalNotes);
  }

  if (txCols.has('updated_at')) {
    updateParts.push('updated_at = ?');
    values.push(createdAt);
  }

  if (updateParts.length) {
    values.push(target.id);
    updates.push(
      db.prepare(`UPDATE transactions SET ${updateParts.join(', ')} WHERE id = ?`).bind(...values)
    );
  }

  await db.batch(updates);

  const auditResult = await safeAudit(context.env, {
    action: 'ATM_FEE_REVERSED',
    entity: 'transaction',
    entity_id: reversalId,
    kind: 'mutation',
    detail: {
      fee_txn_id: target.id,
      reversal_id: reversalId,
      amount: Number(target.amount) || 0,
      account_id: target.account_id,
      date,
      fee_reversal_linked_to_pair: false
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm_fee_reverse',
    committed: true,
    fee_txn_id: target.id,
    reversal_id: reversalId,
    amount: Number(target.amount) || 0,
    account_id: target.account_id,
    linked_to_withdrawal_pair: false,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function atmHealth(db) {
  const txCols = await tableColumns(db, 'transactions');

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'transfer_to_account_id',
    'category_id',
    'notes',
    'created_at',
    'linked_txn_id',
    'reversed_by',
    'reversed_at',
    'source_module',
    'source_id',
    'source_action'
  ].filter(col => txCols.has(col));

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE source_module = 'atm'
        OR notes LIKE '%[ATM_WITHDRAWAL]%'
        OR notes LIKE '%[ATM_WITHDRAW]%'
        OR notes LIKE '%[ATM_FEE_PENDING]%'
        OR notes LIKE '%[ATM_FEE_REVERSAL]%'
     ORDER BY ${txCols.has('date') ? 'date DESC,' : ''} ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC
     LIMIT 500`
  ).all();

  const scanRows = rows.results || [];
  const byId = new Map(scanRows.map(row => [String(row.id), row]));

  const withdrawalRows = scanRows.filter(row =>
    String(row.notes || '').includes('[ATM_WITHDRAWAL]') ||
    String(row.notes || '').includes('[ATM_WITHDRAW]')
  );

  const feeRows = scanRows.filter(row =>
    String(row.notes || '').includes('[ATM_FEE_PENDING]')
  );

  const reversalRows = scanRows.filter(row =>
    String(row.notes || '').includes('[ATM_FEE_REVERSAL]')
  );

  const orphanPairs = [];
  const amountMismatches = [];
  const badFeeLinks = [];

  for (const row of withdrawalRows) {
    if (isInactive(row)) continue;

    const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

    if (!linkedId) {
      orphanPairs.push({
        id: row.id,
        error: 'ATM withdrawal row missing linked id'
      });
      continue;
    }

    const linked = byId.get(String(linkedId));

    if (!linked) {
      orphanPairs.push({
        id: row.id,
        linked_id: linkedId,
        error: 'Linked ATM row not found in ATM scan'
      });
      continue;
    }

    const amount = rowAmount(row);
    const linkedAmount = rowAmount(linked);

    if (amount !== linkedAmount) {
      amountMismatches.push({
        id: row.id,
        linked_id: linkedId,
        amount,
        linked_amount: linkedAmount,
        error: 'ATM withdrawal pair amount mismatch'
      });
    }
  }

  for (const row of feeRows) {
    if (row.linked_txn_id || extractLinkedId(row.notes)) {
      badFeeLinks.push({
        id: row.id,
        linked_id: row.linked_txn_id || extractLinkedId(row.notes),
        error: 'ATM fee must not be linked to withdrawal pair'
      });
    }
  }

  const status = orphanPairs.length || amountMismatches.length || badFeeLinks.length ? 'fail' : 'pass';

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm.health',
    status,
    counts: {
      scanned_rows: scanRows.length,
      withdrawal_rows: withdrawalRows.length,
      fee_rows: feeRows.length,
      fee_reversal_rows: reversalRows.length,
      orphan_pairs: orphanPairs.length,
      amount_mismatches: amountMismatches.length,
      bad_fee_links: badFeeLinks.length
    },
    checks: {
      withdrawal_pairs_complete: orphanPairs.length === 0,
      withdrawal_pair_amounts_match: amountMismatches.length === 0,
      fee_rows_not_linked_to_pairs: badFeeLinks.length === 0,
      health_is_read_only: true
    },
    orphan_pairs: orphanPairs,
    amount_mismatches: amountMismatches,
    bad_fee_links: badFeeLinks,
    rules: {
      withdrawal_source_type: 'transfer',
      withdrawal_cash_type: 'income',
      fee_type: 'atm',
      fee_link_policy: 'fee row is separate and not linked to withdrawal pair',
      legacy_atm_withdraw_marker_supported: true,
      canonical_marker: '[ATM_WITHDRAWAL]'
    }
  });
}

async function loadPendingFees(db) {
  const rows = await db.prepare(
    `SELECT
        id,
        date,
        type,
        amount,
        account_id,
        category_id,
        notes,
        created_at,
        linked_txn_id,
        CAST(julianday('now') - julianday(date) AS INTEGER) AS age_days
     FROM transactions
     WHERE (
        (notes LIKE '%[ATM_FEE_PENDING]%')
        OR
        (notes LIKE '%PENDING reversal%' AND notes LIKE '%ATM%')
     )
     AND (notes IS NULL OR notes NOT LIKE '%[ATM_FEE_REVERSED%')
     AND (reversed_by IS NULL OR reversed_by = '')
     AND (reversed_at IS NULL OR reversed_at = '')
     ORDER BY date DESC, datetime(created_at) DESC, id DESC
     LIMIT 50`
  ).all();

  return rows.results || [];
}

async function loadRecentATMRows(db) {
  const rows = await db.prepare(
    `SELECT
        id,
        date,
        type,
        amount,
        account_id,
        category_id,
        notes,
        created_at,
        linked_txn_id
     FROM transactions
     WHERE source_module = 'atm'
        OR type = 'atm'
        OR notes LIKE '%[ATM_WITHDRAWAL]%'
        OR notes LIKE '%[ATM_WITHDRAW]%'
        OR notes LIKE '%[ATM_FEE_PENDING]%'
        OR notes LIKE '%[ATM_FEE_REVERSAL]%'
        OR notes LIKE '%ATM withdraw%'
        OR notes LIKE '%ATM fee%'
        OR notes LIKE '%PENDING reversal%'
     ORDER BY date DESC, datetime(created_at) DESC, id DESC
     LIMIT 40`
  ).all();

  return rows.results || [];
}

async function loadFeeStats30d(db) {
  const paidRows = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE date >= date('now', '-30 day')
       AND (
        notes LIKE '%[ATM_FEE_PENDING]%'
        OR (notes LIKE '%PENDING reversal%' AND notes LIKE '%ATM%')
       )`
  ).first();

  const reversedRows = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE date >= date('now', '-30 day')
       AND notes LIKE '%[ATM_FEE_REVERSAL]%'`
  ).first();

  const paid = Number(paidRows?.total) || 0;
  const reversed = Number(reversedRows?.total) || 0;

  return {
    paid: round2(paid),
    reversed: round2(reversed),
    net: round2(paid - reversed)
  };
}

async function loadAccountMap(db, ids) {
  const out = {};

  for (const id of ids) {
    if (!id) continue;

    const row = await db.prepare(
      `SELECT id, name, icon, type, kind, status, deleted_at, archived_at
       FROM accounts
       WHERE id = ?
       AND ${ACTIVE_ACCOUNT_CONDITION}`
    ).bind(id).first();

    if (row && row.id) out[row.id] = row;
  }

  return out;
}

async function resolveCategoryId(db, preferredId) {
  const cols = await tableColumns(db, 'categories');

  if (!cols.has('id')) return null;

  const exact = await db.prepare(
    `SELECT id FROM categories WHERE id = ? LIMIT 1`
  ).bind(preferredId).first();

  if (exact && exact.id) return exact.id;

  const fallback = await db.prepare(
    `SELECT id
     FROM categories
     WHERE LOWER(id) IN ('atm_fee', 'bank_fee', 'misc')
        OR LOWER(name) LIKE '%atm%'
        OR LOWER(name) LIKE '%fee%'
     ORDER BY id
     LIMIT 1`
  ).first();

  return fallback && fallback.id ? fallback.id : null;
}

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

  return String(raw).split('/').filter(Boolean);
}

function isOwnATM(sourceId, atmName, noFee) {
  if (noFee) return true;

  const source = String(sourceId || '').toLowerCase();
  const atm = String(atmName || '').toLowerCase();

  return source === 'mashreq' && atm.includes('mashreq');
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

function buildInsert(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('No insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

function rowAmount(row) {
  const pkr = Number(row.pkr_amount);

  if (Number.isFinite(pkr) && pkr !== 0) return round2(Math.abs(pkr));

  const amount = Number(row.amount);

  if (Number.isFinite(amount)) return round2(Math.abs(amount));

  return 0;
}

function isInactive(row) {
  const notes = String(row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function extractAtmId(notes) {
  const match = String(notes || '').match(/atm_id=([A-Za-z0-9_-]+)/i);
  return match ? match[1].trim() : null;
}

function moneyNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? round2(n) : fallback;
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function cleanText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function cleanDate(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function round2(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function safeAudit(env, event) {
  try {
    const result = await audit(env, {
      ...event,
      detail: typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail || {})
    });

    return {
      ok: !!(result && result.ok),
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err)
    };
  }
}
