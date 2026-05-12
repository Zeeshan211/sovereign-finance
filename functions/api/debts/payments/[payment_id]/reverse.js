/* /api/debts/payments/:payment_id/reverse
 * Sovereign Finance · Debt Payment Reversal Engine
 * v1.0.0-debts-payment-reverse
 *
 * Banking rule:
 * - Never delete payment history.
 * - Reverse creates an opposite ledger row.
 * - Original ledger row is marked reversed.
 * - debt_payments row is marked reversed.
 * - debts.paid_amount is restored.
 */

import { audit } from '../../../_lib.js';

const VERSION = 'v1.0.0-debts-payment-reverse';
const DEFAULT_CREATED_BY = 'web-debts';

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const paymentId = getPaymentId(context);
    const body = await readJSON(context.request);

    const reason = text(body.reason, '', 500);
    const createdBy = text(body.created_by, DEFAULT_CREATED_BY, 80) || DEFAULT_CREATED_BY;

    if (!paymentId) {
      return json({
        ok: false,
        version: VERSION,
        error: 'payment_id required'
      }, 400);
    }

    if (!reason) {
      return json({
        ok: false,
        version: VERSION,
        error: 'reason required'
      }, 400);
    }

    const payment = await db.prepare(
      `SELECT *
       FROM debt_payments
       WHERE id = ?
       LIMIT 1`
    ).bind(paymentId).first();

    if (!payment) {
      return json({
        ok: false,
        version: VERSION,
        error: 'debt payment not found',
        payment_id: paymentId
      }, 404);
    }

    if (String(payment.status || 'paid') === 'reversed') {
      return json({
        ok: false,
        version: VERSION,
        error: 'debt payment already reversed',
        payment_id: paymentId,
        reversal_transaction_id: payment.reversal_transaction_id || null,
        reversed_at: payment.reversed_at || null
      }, 409);
    }

    const debt = await db.prepare(
      `SELECT *
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(payment.debt_id).first();

    if (!debt) {
      return json({
        ok: false,
        version: VERSION,
        error: 'linked debt not found',
        debt_id: payment.debt_id
      }, 409);
    }

    const txCols = await cols(db, 'transactions');
    const debtCols = await cols(db, 'debts');
    const paymentCols = await cols(db, 'debt_payments');

    const originalTxn = await getTransaction(db, txCols, payment.transaction_id);

    if (!originalTxn) {
      return json({
        ok: false,
        version: VERSION,
        error: 'linked ledger transaction not found',
        transaction_id: payment.transaction_id
      }, 409);
    }

    if (isTxnReversed(originalTxn)) {
      const existingReversalId = originalTxn.reversed_by || extractReversedBy(originalTxn.notes);

      await db.batch([
        buildUpdate(db, 'debt_payments', paymentCols, payment.id, {
          status: 'reversed',
          reversed_at: originalTxn.reversed_at || nowISO(),
          reversal_transaction_id: existingReversalId || payment.reversal_transaction_id || '',
          reason: 'Repair: linked transaction was already reversed. ' + reason
        }),
        buildUpdate(db, 'debts', debtCols, debt.id, restoredDebtPatch(debt, payment))
      ]);

      await safeAudit(context, {
        action: 'DEBT_PAYMENT_REVERSED_REPAIRED',
        entity: 'debt_payment',
        entity_id: payment.id,
        kind: 'mutation',
        detail: {
          debt_id: debt.id,
          original_transaction_id: originalTxn.id,
          existing_reversal_transaction_id: existingReversalId || null,
          reason
        },
        created_by: createdBy
      });

      return json({
        ok: true,
        version: VERSION,
        mode: 'repair_existing_reversal',
        debt_payment_id: payment.id,
        debt_id: debt.id,
        original_transaction_id: originalTxn.id,
        reversal_transaction_id: existingReversalId || null
      });
    }

    const reversalId = makeId('rev_debt');
    const reversalType = oppositeType(originalTxn.type);
    const amount = Math.abs(Number(originalTxn.amount || payment.amount || 0));
    const pkrAmount = Math.abs(Number(originalTxn.pkr_amount || originalTxn.amount || payment.amount || 0));

    const reversalRow = {
      id: reversalId,
      date: todayISO(),
      type: reversalType,
      amount,
      account_id: originalTxn.account_id,
      transfer_to_account_id: null,
      linked_txn_id: originalTxn.id,
      category_id: originalTxn.category_id || payment.category_id || 'debt_payment',
      notes: `[REVERSAL OF ${originalTxn.id}] Debt payment reversal: ${payment.debt_name_snapshot || debt.name} | debt_id=${debt.id} | debt_payment_id=${payment.id} | reason=${reason}`.slice(0, 240),
      fee_amount: 0,
      pra_amount: 0,
      currency: 'PKR',
      pkr_amount: pkrAmount,
      fx_rate_at_commit: 1,
      fx_source: 'debt-reversal',
      created_by: createdBy,
      created_at: nowISO()
    };

    await db.batch([
      buildInsert(db, 'transactions', filterToCols(txCols, reversalRow)),
      buildMarkTxnReversed(db, txCols, originalTxn.id, reversalId, reason),
      buildUpdate(db, 'debt_payments', paymentCols, payment.id, {
        status: 'reversed',
        reversed_at: nowISO(),
        reversal_transaction_id: reversalId,
        reason
      }),
      buildUpdate(db, 'debts', debtCols, debt.id, restoredDebtPatch(debt, payment))
    ]);

    await safeAudit(context, {
      action: 'DEBT_PAYMENT_REVERSED',
      entity: 'debt_payment',
      entity_id: payment.id,
      kind: 'mutation',
      detail: {
        debt_id: debt.id,
        debt_name: debt.name,
        original_transaction_id: originalTxn.id,
        reversal_transaction_id: reversalId,
        amount: Number(payment.amount || 0),
        amount_paisa: Number(payment.amount_paisa || 0),
        reason
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      debt_payment_id: payment.id,
      debt_id: debt.id,
      original_transaction_id: originalTxn.id,
      reversal_transaction_id: reversalId,
      status: 'reversed'
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

function restoredDebtPatch(debt, payment) {
  const currentPaid = Number(debt.paid_amount || 0);
  const amount = Number(payment.amount || 0);
  const newPaid = Math.max(0, roundMoney(currentPaid - amount));
  const original = Number(debt.original_amount || 0);
  const remaining = Math.max(0, roundMoney(original - newPaid));
  const kind = String(debt.kind || '').toLowerCase();

  return {
    paid_amount: newPaid,
    last_paid_date: null,
    status: remaining <= 0
      ? finalStatusForKind(kind)
      : 'active'
  };
}

function finalStatusForKind(kind) {
  return kind === 'owed' ? 'settled' : 'closed';
}

async function getTransaction(db, txCols, id) {
  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'account_id',
    'category_id',
    'notes',
    'pkr_amount',
    'reversed_by',
    'reversed_at'
  ];

  const select = wanted.filter(col => txCols.has(col));

  if (!select.length) return null;

  return db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

function oppositeType(type) {
  const t = String(type || '').toLowerCase();

  if (['expense', 'repay', 'debt_out', 'transfer', 'atm', 'cc_spend'].includes(t)) {
    return 'income';
  }

  if (['income', 'borrow', 'debt_in', 'salary', 'opening'].includes(t)) {
    return 'expense';
  }

  return 'income';
}

function isTxnReversed(txn) {
  const notes = String(txn.notes || '').toUpperCase();

  return !!(
    txn.reversed_by ||
    txn.reversed_at ||
    notes.includes('[REVERSED BY ')
  );
}

function extractReversedBy(notes) {
  const match = String(notes || '').match(/\[REVERSED BY\s+([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function buildMarkTxnReversed(db, txCols, originalId, reversalId, reason) {
  const sets = [];
  const values = [];

  if (txCols.has('reversed_by')) {
    sets.push('reversed_by = ?');
    values.push(reversalId);
  }

  if (txCols.has('reversed_at')) {
    sets.push('reversed_at = ?');
    values.push(nowISO());
  }

  if (txCols.has('notes')) {
    sets.push(
      `notes = CASE
        WHEN notes IS NULL OR notes = '' THEN ?
        ELSE substr(notes || ' ' || ?, 1, 240)
      END`
    );

    const marker = `[REVERSED BY ${reversalId}] ${reason}`.slice(0, 240);
    values.push(marker, marker);
  }

  if (!sets.length) {
    throw new Error('transactions table has no reversal marker columns');
  }

  values.push(originalId);

  return db.prepare(
    `UPDATE transactions
     SET ${sets.join(', ')}
     WHERE id = ?`
  ).bind(...values);
}

async function cols(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const set = new Set();

  for (const row of result.results || []) {
    if (row.name) set.add(row.name);
  }

  return set;
}

function filterToCols(colSet, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (colSet.has(key)) {
      out[key] = value;
    }
  }

  return out;
}

function buildInsert(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('no insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

function buildUpdate(db, table, colSet, id, patch) {
  const keys = Object.keys(patch).filter(key => colSet.has(key));

  if (!keys.length) {
    return db.prepare(`SELECT 1`).bind();
  }

  return db.prepare(
    `UPDATE ${table}
     SET ${keys.map(key => `${key} = ?`).join(', ')}
     WHERE id = ?`
  ).bind(...keys.map(key => patch[key]), id);
}

async function safeAudit(context, event) {
  try {
    const result = await audit(context.env, {
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

function getPaymentId(context) {
  const params = context.params || {};
  return text(params.payment_id || params.id || '', '', 160);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
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

function text(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
