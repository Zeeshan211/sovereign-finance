/* ─── /api/atm/[[path]] · v0.1.0 · Sheet ATM logic web port ─── */
/*
 * Source logic:
 *   Finance_ATM.gs v1.2
 *
 * Contract:
 *   - ATM withdraw writes a linked transfer pair:
 *       OUT: type=transfer, source account
 *       IN:  type=income, destination account
 *   - Optional ATM fee writes a separate type=atm row on source account.
 *   - Pending fee can be reversed later with a type=income reversal row.
 *   - No new D1 table.
 *   - No schema migration.
 *
 * Routes:
 *   GET  /api/atm
 *   POST /api/atm/withdraw
 *   POST /api/atm/reverse
 */

import { json, audit } from '../_lib.js';

const VERSION = 'v0.1.0';

const DEFAULT_SOURCE_ACCOUNT_ID = 'mashreq';
const DEFAULT_DEST_ACCOUNT_ID = 'cash';
const DEFAULT_FEE_PKR = 35;
const REVERSAL_WINDOW_DAYS = 10;
const MONTHLY_CAP_HINT = 15;

const ACTIVE_ACCOUNT_CONDITION = "(deleted_at IS NULL OR deleted_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

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
    const sourceAccounts = accounts.filter(a => a.type === 'asset' && a.kind !== 'cc');
    const destinationAccounts = accounts.filter(a => a.type === 'asset' && a.kind !== 'cc');

    const totalPending = pendingFees.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const overdueCount = pendingFees.filter(row => Number(row.age_days) > REVERSAL_WINDOW_DAYS).length;

    return json({
      ok: true,
      version: VERSION,
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
      recent_atm_rows: recentRows
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = context.params.path || [];
    const action = path[0] || '';

    if (action === 'withdraw') return createATMWithdraw(context);
    if (action === 'reverse') return reverseATMFee(context);

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported ATM action',
      supported: ['/api/atm/withdraw', '/api/atm/reverse']
    }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createATMWithdraw(context) {
  const db = context.env.DB;
  const body = await context.request.json();

  const amount = Number(body.amount);
  const feeAmount = body.no_fee ? 0 : normalizeFee(body.fee_amount);
  const sourceId = cleanId(body.source_account_id || body.from_account_id || DEFAULT_SOURCE_ACCOUNT_ID);
  const destId = cleanId(body.destination_account_id || body.to_account_id || DEFAULT_DEST_ACCOUNT_ID);
  const atmName = cleanText(body.atm_name || body.atm || 'ATM', 80);
  const date = cleanDate(body.date);
  const createdBy = cleanText(body.created_by || 'web-atm-withdraw', 80);

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be greater than 0' }, 400);
  }

  if (feeAmount < 0) {
    return json({ ok: false, version: VERSION, error: 'fee_amount cannot be negative' }, 400);
  }

  if (!sourceId || !destId) {
    return json({ ok: false, version: VERSION, error: 'source and destination accounts are required' }, 400);
  }

  if (sourceId === destId) {
    return json({ ok: false, version: VERSION, error: 'source and destination accounts cannot match' }, 400);
  }

  const accounts = await loadAccountMap(db, [sourceId, destId]);

  if (!accounts[sourceId]) {
    return json({ ok: false, version: VERSION, error: 'source account not found', account_id: sourceId }, 404);
  }

  if (!accounts[destId]) {
    return json({ ok: false, version: VERSION, error: 'destination account not found', account_id: destId }, 404);
  }

  const source = accounts[sourceId];
  const dest = accounts[destId];

  if (source.type !== 'asset' || dest.type !== 'asset') {
    return json({ ok: false, version: VERSION, error: 'ATM source and destination must both be asset accounts' }, 400);
  }

  const shouldCreateFee = feeAmount > 0 && !isOwnATM(sourceId, atmName, body.no_fee);
  const outId = makeTxnId('atmout');
  const inId = makeTxnId('atmin');
  const feeId = shouldCreateFee ? makeTxnId('atmfee') : null;

  const baseNotes = cleanText(body.notes || `ATM withdraw at ${atmName}`, 120);
  const outNotes = `To: ${dest.name || destId} · ${baseNotes} (OUT) [ATM_WITHDRAW] [linked: ${inId}]`.slice(0, 200);
  const inNotes = `From: ${source.name || sourceId} · ${baseNotes} (IN) [ATM_WITHDRAW] [linked: ${outId}]`.slice(0, 200);

  const statements = [
    db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      outId,
      date,
      'transfer',
      amount,
      sourceId,
      null,
      null,
      outNotes,
      0,
      0,
      inId
    ),
    db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      inId,
      date,
      'income',
      amount,
      destId,
      null,
      null,
      inNotes,
      0,
      0,
      outId
    )
  ];

  if (shouldCreateFee) {
    statements.push(
      db.prepare(
        `INSERT INTO transactions
          (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        feeId,
        date,
        'atm',
        feeAmount,
        sourceId,
        null,
        null,
        `${atmName} ATM fee · [ATM_FEE_PENDING] [linked: ${outId}] auto-flag if not reversed in ${REVERSAL_WINDOW_DAYS} days`.slice(0, 200),
        0,
        0,
        outId
      )
    );
  }

  await db.batch(statements);

  const auditResult = await safeAudit(context.env, {
    action: 'ATM_WITHDRAW',
    entity: 'transaction',
    entity_id: outId,
    kind: 'mutation',
    detail: {
      amount,
      fee_amount: shouldCreateFee ? feeAmount : 0,
      source_account_id: sourceId,
      destination_account_id: destId,
      atm_name: atmName,
      out_id: outId,
      in_id: inId,
      fee_id: feeId,
      fee_pending: shouldCreateFee,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    transfer_model: 'sheet_atm_v1_2_transfer_pair',
    ids: shouldCreateFee ? [outId, inId, feeId] : [outId, inId],
    out_id: outId,
    in_id: inId,
    fee_id: feeId,
    fee_pending: shouldCreateFee,
    amount,
    fee_amount: shouldCreateFee ? feeAmount : 0,
    source_account_id: sourceId,
    destination_account_id: destId,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function reverseATMFee(context) {
  const db = context.env.DB;
  const body = await context.request.json();

  const createdBy = cleanText(body.created_by || 'web-atm-reverse', 80);
  const feeTxnId = cleanText(body.fee_txn_id || body.id || '', 120);
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
      error: 'No matching pending ATM fee found'
    }, 404);
  }

  const reversalId = makeTxnId('atmrev');
  const date = cleanDate(body.date);

  const reverseNotes = `[ATM_FEE_REVERSAL] Reversal of ${target.id} · ${target.notes || ''}`.slice(0, 200);
  const updatedOriginalNotes = `${target.notes || ''} [ATM_FEE_REVERSED_BY: ${reversalId}]`.slice(0, 200);

  await db.batch([
    db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      reversalId,
      date,
      'income',
      Number(target.amount) || 0,
      target.account_id,
      null,
      null,
      reverseNotes,
      0,
      0,
      target.id
    ),
    db.prepare(
      `UPDATE transactions
       SET notes = ?, linked_txn_id = ?
       WHERE id = ?`
    ).bind(
      updatedOriginalNotes,
      reversalId,
      target.id
    )
  ]);

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
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    fee_txn_id: target.id,
    reversal_id: reversalId,
    amount: Number(target.amount) || 0,
    account_id: target.account_id,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
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
        notes,
        created_at,
        linked_txn_id,
        CAST(julianday('now') - julianday(date) AS INTEGER) AS age_days
     FROM transactions
     WHERE (
        (type = 'atm' AND notes LIKE '%[ATM_FEE_PENDING]%')
        OR
        (notes LIKE '%PENDING reversal%' AND notes LIKE '%ATM%')
     )
     AND (notes IS NULL OR notes NOT LIKE '%[ATM_FEE_REVERSED%')
     AND (reversed_by IS NULL OR reversed_by = '')
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
        notes,
        created_at,
        linked_txn_id
     FROM transactions
     WHERE type = 'atm'
        OR notes LIKE '%[ATM_WITHDRAW]%'
        OR notes LIKE '%[ATM_FEE_PENDING]%'
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
        (type = 'atm' AND notes LIKE '%[ATM_FEE_PENDING]%')
        OR
        (notes LIKE '%PENDING reversal%' AND notes LIKE '%ATM%')
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

function isOwnATM(sourceId, atmName, noFee) {
  if (noFee) return true;

  const source = String(sourceId || '').toLowerCase();
  const atm = String(atmName || '').toLowerCase();

  return source === 'mashreq' && atm.includes('mashreq');
}

function normalizeFee(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_FEE_PKR;

  const n = Number(value);

  if (!Number.isFinite(n)) return DEFAULT_FEE_PKR;

  return n;
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function cleanText(value, max) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max || 200);
}

function cleanDate(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return new Date().toISOString().slice(0, 10);
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
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
      error: err.message
    };
  }
}
