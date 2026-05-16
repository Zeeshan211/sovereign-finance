/* /api/transactions/reverse — POST
 * Sovereign Finance
 * v0.4.0-bill-and-debt-payment-reversal-integrity
 *
 * Purpose:
 * - Reverse a ledger transaction.
 * - Preserve schema-safe transaction writes.
 * - Keep account balances ledger-derived.
 * - If reversing a [DEBT_PAYMENT], mark linked debt_payment as reversed.
 * - If reversing a [BILL_PAYMENT], mark linked bill_payment as reversed.
 * - Prevent future ledger/domain mismatches.
 */

const VERSION = 'v0.4.0-bill-and-debt-payment-reversal-integrity';

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const body = await readJson(context.request);

    const id = clean(body.id);
    const reason = clean(body.reason);
    const createdBy = clean(body.created_by || 'web-ledger');

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: 'DB binding missing'
      }, 500);
    }

    if (!id) {
      return json({
        ok: false,
        version: VERSION,
        error: 'id required'
      }, 400);
    }

    if (!reason) {
      return json({
        ok: false,
        version: VERSION,
        error: 'reason required'
      }, 400);
    }

    const columns = await getColumns(db, 'transactions');
    const original = await db.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first();

    if (!original) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Original transaction not found'
      }, 404);
    }

    const guard = guardReversible(original);

    if (!guard.ok) {
      return json({
        ok: false,
        version: VERSION,
        error: guard.error
      }, 400);
    }

    const linked = await findLinkedTransaction(db, original);

    if (linked) {
      const linkedGuard = guardReversible(linked);

      if (!linkedGuard.ok) {
        return json({
          ok: false,
          version: VERSION,
          error: 'Linked transaction cannot be reversed: ' + linkedGuard.error
        }, 400);
      }

      return reverseLinkedPair({
        db,
        columns,
        original,
        linked,
        reason,
        createdBy
      });
    }

    return reverseSingle({
      db,
      columns,
      original,
      reason,
      createdBy
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

/* ─────────────────────────────
 * Single transaction reversal
 * ───────────────────────────── */

async function reverseSingle(input) {
  const { db, columns, original, reason, createdBy } = input;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const originalId = clean(original.id);
  const originalType = clean(original.type || original.transaction_type || original.kind || 'expense').toLowerCase();
  const amount = Math.abs(Number(original.amount || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Original amount is invalid'
    }, 400);
  }

  const reversalId = makeId('rev');
  const reversalType = oppositeType(originalType);

  const reversalText = `[REVERSAL OF ${originalId}] Reason: ${reason}`;

  const reversalRow = {
    id: reversalId,
    date: today,
    type: reversalType,
    transaction_type: reversalType,
    amount,
    account_id: original.account_id || null,
    transfer_to_account_id: null,
    category_id: original.category_id || null,
    category: original.category || null,
    notes: reversalText,
    description: reversalText,
    memo: reversalText,
    linked_txn_id: originalId,
    reversed_of: originalId,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: 'active',
    fee_amount: 0,
    pra_amount: 0
  };

  const insert = buildInsert('transactions', columns, reversalRow);

  const markOriginal = buildUpdate('transactions', columns, {
    reversed_by: reversalId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, 'id = ?', [originalId]);

  const statements = [
    db.prepare(insert.sql).bind(...insert.values)
  ];

  if (markOriginal) {
    statements.push(db.prepare(markOriginal.sql).bind(...markOriginal.values));
  }

  await db.batch(statements);

  const debtIntegrity = await repairDebtPaymentForReversedTransaction({
    db,
    original,
    originalId,
    reversalId,
    reversedAt: now,
    reason
  });

  const billIntegrity = await repairBillPaymentForReversedTransaction({
    db,
    original,
    originalId,
    reversalId,
    reversedAt: now,
    reason
  });

  return json({
    ok: true,
    version: VERSION,
    mode: 'single',
    original_id: originalId,
    reversal_id: reversalId,
    original_type: originalType,
    reversal_type: reversalType,
    amount,
    account_id: original.account_id || null,
    reason,
    marked_original_reversed: Boolean(markOriginal),
    debt_payment_integrity: debtIntegrity,
    bill_payment_integrity: billIntegrity
  });
}

/* ─────────────────────────────
 * Linked transfer reversal
 * ───────────────────────────── */

async function reverseLinkedPair(input) {
  const { db, columns, original, linked, reason, createdBy } = input;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const pair = normalizeTransferPair(original, linked);

  if (!pair.ok) {
    return json({
      ok: false,
      version: VERSION,
      error: pair.error
    }, 400);
  }

  const amount = Math.abs(Number(pair.amount || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Linked transfer amount is invalid'
    }, 400);
  }

  const reversalSourceId = makeId('revsrc');
  const reversalDestId = makeId('revdst');

  const sourceReversalNotes = `[REVERSAL OF ${pair.outRow.id}] [linked: ${reversalDestId}] Reason: ${reason}`;
  const destinationReversalNotes = `[REVERSAL OF ${pair.inRow.id}] [linked: ${reversalSourceId}] Reason: ${reason}`;

  const sourceReversalRow = {
    id: reversalSourceId,
    date: today,
    type: 'income',
    transaction_type: 'income',
    amount,
    account_id: pair.sourceAccount,
    transfer_to_account_id: null,
    category_id: null,
    category: null,
    notes: sourceReversalNotes,
    description: sourceReversalNotes,
    memo: sourceReversalNotes,
    linked_txn_id: reversalDestId,
    reversed_of: pair.outRow.id,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: 'active',
    fee_amount: 0,
    pra_amount: 0
  };

  const destinationReversalRow = {
    id: reversalDestId,
    date: today,
    type: 'expense',
    transaction_type: 'expense',
    amount,
    account_id: pair.destinationAccount,
    transfer_to_account_id: null,
    category_id: null,
    category: null,
    notes: destinationReversalNotes,
    description: destinationReversalNotes,
    memo: destinationReversalNotes,
    linked_txn_id: reversalSourceId,
    reversed_of: pair.inRow.id,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: 'active',
    fee_amount: 0,
    pra_amount: 0
  };

  const insertSource = buildInsert('transactions', columns, sourceReversalRow);
  const insertDestination = buildInsert('transactions', columns, destinationReversalRow);

  const markOut = buildUpdate('transactions', columns, {
    reversed_by: reversalSourceId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, 'id = ?', [pair.outRow.id]);

  const markIn = buildUpdate('transactions', columns, {
    reversed_by: reversalDestId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, 'id = ?', [pair.inRow.id]);

  const statements = [
    db.prepare(insertSource.sql).bind(...insertSource.values),
    db.prepare(insertDestination.sql).bind(...insertDestination.values)
  ];

  if (markOut) statements.push(db.prepare(markOut.sql).bind(...markOut.values));
  if (markIn) statements.push(db.prepare(markIn.sql).bind(...markIn.values));

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    mode: 'linked_transfer',
    original_out_id: pair.outRow.id,
    original_in_id: pair.inRow.id,
    reversal_source_id: reversalSourceId,
    reversal_destination_id: reversalDestId,
    amount,
    source_account: pair.sourceAccount,
    destination_account: pair.destinationAccount,
    reason,
    marked_originals_reversed: Boolean(markOut && markIn)
  });
}

/* ─────────────────────────────
 * Debt payment reversal integrity
 * ───────────────────────────── */

async function repairDebtPaymentForReversedTransaction(input) {
  const { db, original, originalId, reversalId, reversedAt, reason } = input;
  const markerText = clean(original.notes || original.description || original.memo);

  const paymentCols = await getColumns(db, 'debt_payments');

  if (!paymentCols.size || !paymentCols.has('transaction_id')) {
    return {
      checked: true,
      applicable: false,
      reason: 'debt_payments table or transaction_id column missing'
    };
  }

  const payment = await db.prepare(
    'SELECT * FROM debt_payments WHERE TRIM(transaction_id) = TRIM(?) LIMIT 1'
  ).bind(originalId).first();

  if (!payment && !markerText.includes('[DEBT_PAYMENT]')) {
    return {
      checked: true,
      applicable: false,
      reason: 'transaction is not linked to a debt payment'
    };
  }

  if (!payment) {
    return {
      checked: true,
      applicable: true,
      repaired: false,
      warning: 'transaction has [DEBT_PAYMENT] marker but no debt_payment row was found'
    };
  }

  const paymentStatus = clean(payment.status).toLowerCase();

  if (paymentStatus === 'reversed') {
    return {
      checked: true,
      applicable: true,
      repaired: false,
      already_reversed: true,
      debt_payment_id: payment.id || null,
      debt_id: payment.debt_id || null
    };
  }

  const statements = [];

  const paymentUpdates = { status: 'reversed' };

  if (paymentCols.has('reversed_at')) paymentUpdates.reversed_at = reversedAt;
  if (paymentCols.has('reversal_transaction_id')) paymentUpdates.reversal_transaction_id = reversalId;
  if (paymentCols.has('reversed_by')) paymentUpdates.reversed_by = reversalId;
  if (paymentCols.has('reason')) paymentUpdates.reason = reason || 'linked ledger transaction reversed';
  if (paymentCols.has('updated_at')) paymentUpdates.updated_at = reversedAt;
  if (paymentCols.has('notes')) {
    paymentUpdates.notes = appendNote(
      payment.notes,
      `Reversed by ${reversalId} because linked ledger transaction ${originalId} was reversed.`
    );
  }

  const paymentUpdate = buildUpdate('debt_payments', paymentCols, paymentUpdates, 'id = ?', [payment.id]);

  if (paymentUpdate) {
    statements.push(db.prepare(paymentUpdate.sql).bind(...paymentUpdate.values));
  }

  const recalc = await recalculateDebtFromPayments(db, payment.debt_id);
  const debtCols = await getColumns(db, 'debts');
  const debtUpdates = {};

  if (debtCols.has('paid_amount')) debtUpdates.paid_amount = recalc.paid_amount;
  if (debtCols.has('status')) debtUpdates.status = recalc.status;
  if (debtCols.has('last_paid_date')) debtUpdates.last_paid_date = recalc.last_paid_date;

  const debtUpdate = buildUpdate('debts', debtCols, debtUpdates, 'TRIM(id) = TRIM(?)', [payment.debt_id]);

  if (debtUpdate) {
    statements.push(db.prepare(debtUpdate.sql).bind(...debtUpdate.values));
  }

  if (statements.length) {
    await db.batch(statements);
  }

  return {
    checked: true,
    applicable: true,
    repaired: true,
    debt_payment_id: payment.id || null,
    debt_id: payment.debt_id || null,
    paid_amount_after: recalc.paid_amount,
    remaining_amount_after: recalc.remaining_amount,
    status_after: recalc.status
  };
}

async function recalculateDebtFromPayments(db, debtId) {
  const debt = await db.prepare(
    'SELECT id, original_amount FROM debts WHERE TRIM(id) = TRIM(?) LIMIT 1'
  ).bind(debtId).first();

  if (!debt) {
    return {
      paid_amount: 0,
      remaining_amount: 0,
      status: 'active',
      last_paid_date: null
    };
  }

  const active = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS paid_amount, MAX(paid_date) AS last_paid_date
    FROM debt_payments
    WHERE TRIM(debt_id) = TRIM(?)
      AND (status IS NULL OR status = '' OR status = 'paid' OR status = 'active')
  `).bind(debtId).first();

  const originalAmount = round2(debt.original_amount || 0);
  const paidAmount = round2(active && active.paid_amount ? active.paid_amount : 0);
  const remainingAmount = Math.max(0, round2(originalAmount - paidAmount));

  return {
    paid_amount: paidAmount,
    remaining_amount: remainingAmount,
    status: remainingAmount > 0 ? 'active' : 'settled',
    last_paid_date: active && active.last_paid_date ? active.last_paid_date : null
  };
}

/* ─────────────────────────────
 * Bill payment reversal integrity — B4
 * ───────────────────────────── */

async function repairBillPaymentForReversedTransaction(input) {
  const { db, original, originalId, reversalId, reversedAt, reason } = input;
  const markerText = clean(original.notes || original.description || original.memo);

  const paymentCols = await getColumns(db, 'bill_payments');

  if (!paymentCols.size || !paymentCols.has('transaction_id')) {
    return {
      checked: true,
      applicable: false,
      reason: 'bill_payments table or transaction_id column missing'
    };
  }

  const payment = await db.prepare(
    'SELECT * FROM bill_payments WHERE TRIM(transaction_id) = TRIM(?) LIMIT 1'
  ).bind(originalId).first();

  if (!payment && !markerText.includes('[BILL_PAYMENT]')) {
    return {
      checked: true,
      applicable: false,
      reason: 'transaction is not linked to a bill payment'
    };
  }

  if (!payment) {
    return {
      checked: true,
      applicable: true,
      repaired: false,
      warning: 'transaction has [BILL_PAYMENT] marker but no bill_payment row was found'
    };
  }

  const paymentStatus = clean(payment.status).toLowerCase();

  if (paymentStatus === 'reversed') {
    return {
      checked: true,
      applicable: true,
      repaired: false,
      already_reversed: true,
      bill_payment_id: payment.id || null,
      bill_id: payment.bill_id || null
    };
  }

  const updates = { status: 'reversed' };

  if (paymentCols.has('reversed_at')) updates.reversed_at = reversedAt;
  if (paymentCols.has('reversal_transaction_id')) updates.reversal_transaction_id = reversalId;
  if (paymentCols.has('reversed_by')) updates.reversed_by = reversalId;
  if (paymentCols.has('updated_at')) updates.updated_at = reversedAt;
  if (paymentCols.has('reason')) updates.reason = reason || 'linked ledger transaction reversed';
  if (paymentCols.has('notes')) {
    updates.notes = appendNote(
      payment.notes,
      `Reversed by ${reversalId} because linked ledger transaction ${originalId} was reversed.`
    );
  }

  const statements = [];

  const paymentUpdate = buildUpdate('bill_payments', paymentCols, updates, 'id = ?', [payment.id]);

  if (paymentUpdate) {
    statements.push(db.prepare(paymentUpdate.sql).bind(...paymentUpdate.values));
  }

  const billCols = await getColumns(db, 'bills');

  if (payment.bill_id && billCols.size) {
    const billUpdates = {};

    if (billCols.has('updated_at')) billUpdates.updated_at = reversedAt;

    const billUpdate = buildUpdate('bills', billCols, billUpdates, 'TRIM(id) = TRIM(?)', [payment.bill_id]);

    if (billUpdate) {
      statements.push(db.prepare(billUpdate.sql).bind(...billUpdate.values));
    }
  }

  if (statements.length) {
    await db.batch(statements);
  }

  return {
    checked: true,
    applicable: true,
    repaired: true,
    bill_payment_id: payment.id || null,
    bill_id: payment.bill_id || null,
    bill_month: payment.bill_month || payment.month || payment.cycle_month || null,
    status_after: 'reversed',
    current_cycle_rule: 'Bills current_cycle is derived dynamically and will exclude this reversed payment.'
  };
}

/* ─────────────────────────────
 * Shared transaction helpers
 * ───────────────────────────── */

async function getColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const rows = result && result.results ? result.results : [];

    return new Set(rows.map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function buildInsert(table, columns, row) {
  const keys = Object.keys(row).filter(key => columns.has(key));

  if (!keys.includes('id')) {
    throw new Error(`${table} table missing id column`);
  }

  if (table === 'transactions') {
    if (!keys.includes('type') && !keys.includes('transaction_type')) {
      throw new Error('transactions table missing type column');
    }

    if (!keys.includes('amount')) {
      throw new Error('transactions table missing amount column');
    }
  }

  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const values = keys.map(key => row[key]);

  return { sql, values };
}

function buildUpdate(table, columns, updates, whereSql, whereValues) {
  const keys = Object.keys(updates).filter(key => columns.has(key));

  if (!keys.length) return null;

  const setSql = keys.map(key => `${key} = ?`).join(', ');
  const sql = `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`;
  const values = keys.map(key => updates[key]).concat(whereValues || []);

  return { sql, values };
}

async function findLinkedTransaction(db, tx) {
  const direct = clean(tx.linked_txn_id);
  const fromNotes = extractLinkedId(tx.notes || tx.description || tx.memo);
  const linkedId = direct || fromNotes;

  if (!linkedId || linkedId === tx.id) return null;

  try {
    return await db.prepare('SELECT * FROM transactions WHERE id = ?').bind(linkedId).first();
  } catch {
    return null;
  }
}

function normalizeTransferPair(a, b) {
  const aType = clean(a.type || a.transaction_type).toLowerCase();
  const bType = clean(b.type || b.transaction_type).toLowerCase();

  if (aType === 'transfer' && bType === 'income') {
    return {
      ok: true,
      outRow: a,
      inRow: b,
      amount: Number(a.amount || b.amount || 0),
      sourceAccount: a.account_id,
      destinationAccount: b.account_id
    };
  }

  if (bType === 'transfer' && aType === 'income') {
    return {
      ok: true,
      outRow: b,
      inRow: a,
      amount: Number(b.amount || a.amount || 0),
      sourceAccount: b.account_id,
      destinationAccount: a.account_id
    };
  }

  return {
    ok: false,
    error: 'Linked rows are not a recognized transfer pair'
  };
}

function guardReversible(tx) {
  if (!tx) {
    return { ok: false, error: 'Transaction not found' };
  }

  if (clean(tx.reversed_by) || clean(tx.reversed_at)) {
    return { ok: false, error: 'Transaction is already reversed' };
  }

  const notes = clean(tx.notes || tx.description || tx.memo).toUpperCase();

  if (notes.includes('[REVERSAL OF ')) {
    return { ok: false, error: 'Cannot reverse a reversal row' };
  }

  return { ok: true };
}

function oppositeType(type) {
  const t = clean(type).toLowerCase();

  if (t === 'expense') return 'income';
  if (t === 'income') return 'expense';
  if (t === 'transfer') return 'income';
  if (t === 'cc_payment') return 'cc_spend';
  if (t === 'cc_spend') return 'cc_payment';
  if (t === 'borrow') return 'repay';
  if (t === 'repay') return 'borrow';
  if (t === 'debt_in') return 'debt_out';
  if (t === 'debt_out') return 'debt_in';
  if (t === 'atm') return 'income';
  if (t === 'salary') return 'expense';
  if (t === 'opening') return 'expense';

  return t || 'expense';
}

function extractLinkedId(value) {
  const match = clean(value).match(/\[linked:\s*([^\]\s]+)\]/i);
  return match ? clean(match[1]) : '';
}

function appendNote(existing, addition) {
  const base = clean(existing);
  const next = clean(addition);

  if (!base) return next;
  if (!next) return base;

  return `${base} | ${next}`.slice(0, 1000);
}

function round2(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
