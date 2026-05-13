/* /api/bills
 * Sovereign Finance · Bills Backend
 * v0.6.1-bills-effective-payment-state
 *
 * Fix:
 * - Current cycle no longer counts bill_payments whose linked ledger transaction is reversed.
 * - Health and current_cycle use the same effective payment classifier.
 * - Raw bill_payments.status remains stored status.
 * - effective_status is computed from ledger truth.
 * - Ledger-reversed payments are excluded from paid_total.
 */

const VERSION = 'v0.6.1-bills-effective-payment-state';

const DEFAULT_CATEGORY_ID = 'bills_utilities';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const parts = pathParts(context);
    const route = parts[0] || '';
    const url = new URL(context.request.url);

    if (!route) {
      return getBillsOverview(db, url);
    }

    if (route === 'health') {
      return getBillsHealth(db);
    }

    if (route === 'history') {
      return getBillHistory(db, url);
    }

    if (route === 'cycle' || route === 'current-cycle') {
      return getBillsOverview(db, url);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported bills GET route'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const parts = pathParts(context);
    const route = parts[0] || '';
    const body = await readJSON(context.request);

    if (route === 'pay') {
      return payBill(context, body);
    }

    if (route === 'reverse-payment' || route === 'reverse') {
      return reverseBillPayment(context, body);
    }

    if (route === 'defer') {
      return deferBill(db, body);
    }

    if (route === 'update' || route === 'edit') {
      return updateBill(db, body);
    }

    if (route === 'health-repair' || route === 'repair') {
      return repairLedgerReversedPayments(db);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported bills POST route'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

/* ─────────────────────────────
 * Overview / current cycle
 * ───────────────────────────── */

async function getBillsOverview(db, url) {
  const month = normalizeMonth(url.searchParams.get('month')) || currentMonth();

  const [billCols, paymentCols, txCols] = await Promise.all([
    tableColumns(db, 'bills'),
    tableColumns(db, 'bill_payments'),
    tableColumns(db, 'transactions')
  ]);

  const bills = await loadBills(db, billCols);
  const allPayments = await loadPaymentsForMonth(db, paymentCols, month);
  const txMap = await loadTransactionMapForPayments(db, txCols, allPayments);

  const enrichedBills = [];
  let expectedPaisa = 0;
  let paidPaisa = 0;
  let paidCount = 0;
  let partialCount = 0;
  let unpaidCount = 0;

  for (const bill of bills) {
    if (!isActiveBill(bill)) continue;

    const amountPaisa = billAmountPaisa(bill);
    expectedPaisa += amountPaisa;

    const billPayments = allPayments.filter(p => String(p.bill_id) === String(bill.id));
    const cycle = buildBillCycle(bill, billPayments, txMap, month);

    paidPaisa += cycle.paid_paisa;

    if (cycle.status === 'paid') paidCount += 1;
    else if (cycle.status === 'partial') partialCount += 1;
    else unpaidCount += 1;

    enrichedBills.push({
      ...bill,
      month,
      amount: paisaToMoney(amountPaisa),
      amount_paisa: amountPaisa,
      current_cycle: cycle,

      paid_amount: cycle.paid_amount,
      paid_paisa: cycle.paid_paisa,
      remaining_amount: cycle.remaining_amount,
      remaining_paisa: cycle.remaining_paisa,
      payment_status: cycle.status,
      status_for_month: cycle.status
    });
  }

  const remainingPaisa = Math.max(0, expectedPaisa - paidPaisa);
  const health = await computeBillsHealth(db);

  return json({
    ok: true,
    version: VERSION,
    month,

    expected_this_cycle: paisaToMoney(expectedPaisa),
    expected_this_cycle_paisa: expectedPaisa,
    paid_this_cycle: paisaToMoney(paidPaisa),
    paid_this_cycle_paisa: paidPaisa,
    remaining: paisaToMoney(remainingPaisa),
    remaining_paisa: remainingPaisa,

    paid_count: paidCount,
    partial_count: partialCount,
    unpaid_count: unpaidCount,

    bills: enrichedBills,
    current_cycle: {
      month,
      expected_paisa: expectedPaisa,
      expected_amount: paisaToMoney(expectedPaisa),
      paid_paisa: paidPaisa,
      paid_amount: paisaToMoney(paidPaisa),
      remaining_paisa: remainingPaisa,
      remaining_amount: paisaToMoney(remainingPaisa),
      paid_count: paidCount,
      partial_count: partialCount,
      unpaid_count: unpaidCount
    },

    health: {
      status: health.status,
      payment_rows: health.payment_rows,
      orphans: health.orphans,
      active_payment_reversed_txn_mismatch: health.active_payment_reversed_txn_mismatch,
      missing_reversal_txn: health.missing_reversal_txn,
      duplicate_bill_month_amount: health.duplicate_bill_month_amount,
      amount_mismatches: health.amount_mismatches
    },

    rules: {
      current_cycle_uses_effective_status: true,
      active_payment_requires_unreversed_ledger_txn: true,
      raw_payment_status_is_not_money_truth: true
    }
  });
}

function buildBillCycle(bill, payments, txMap, month) {
  const amountPaisa = billAmountPaisa(bill);

  const enrichedPayments = payments.map(payment => {
    const tx = payment.transaction_id ? txMap.get(String(payment.transaction_id)) : null;
    const classifier = classifyPaymentEffectiveness(payment, tx);

    return {
      ...payment,
      amount: paymentAmount(payment),
      amount_paisa: paymentAmountPaisa(payment),
      ledger_transaction: tx ? sanitizeTransaction(tx) : null,
      effective_status: classifier.effective_status,
      effective_paid: classifier.effective_paid,
      effective_exclusion_reason: classifier.reason,
      ledger_reversed: classifier.ledger_reversed,
      ledger_missing: classifier.ledger_missing
    };
  });

  const effectiveActive = enrichedPayments.filter(payment => payment.effective_paid === true);

  const paidPaisa = effectiveActive.reduce((sum, payment) => {
    return sum + paymentAmountPaisa(payment);
  }, 0);

  const remainingPaisa = Math.max(0, amountPaisa - paidPaisa);

  let status = 'unpaid';
  if (paidPaisa >= amountPaisa && amountPaisa > 0) status = 'paid';
  else if (paidPaisa > 0) status = 'partial';

  return {
    month,
    bill_id: bill.id,
    amount_paisa: amountPaisa,
    amount: paisaToMoney(amountPaisa),

    paid_paisa: paidPaisa,
    paid_amount: paisaToMoney(paidPaisa),
    remaining_paisa: remainingPaisa,
    remaining_amount: paisaToMoney(remainingPaisa),
    status,

    raw_payment_count: enrichedPayments.length,
    active_payment_count: effectiveActive.length,
    ignored_payment_count: enrichedPayments.length - effectiveActive.length,

    payments: enrichedPayments,
    active_payments: effectiveActive,
    ignored_payments: enrichedPayments.filter(payment => payment.effective_paid !== true)
  };
}

/* ─────────────────────────────
 * Health
 * ───────────────────────────── */

async function getBillsHealth(db) {
  const health = await computeBillsHealth(db);
  return json({
    ok: true,
    version: VERSION,
    health,
    status: health.status,
    payment_rows: health.payment_rows,
    orphans: health.orphans,
    active_payment_reversed_txn_mismatch: health.active_payment_reversed_txn_mismatch,
    missing_reversal_txn: health.missing_reversal_txn,
    duplicate_bill_month_amount: health.duplicate_bill_month_amount,
    amount_mismatches: health.amount_mismatches
  });
}

async function computeBillsHealth(db) {
  const [billCols, paymentCols, txCols] = await Promise.all([
    tableColumns(db, 'bills'),
    tableColumns(db, 'bill_payments'),
    tableColumns(db, 'transactions')
  ]);

  const bills = await loadBills(db, billCols, { includeInactive: true });
  const payments = await loadAllPayments(db, paymentCols);
  const txMap = await loadTransactionMapForPayments(db, txCols, payments);

  const billIds = new Set(bills.map(b => String(b.id)));

  let orphans = 0;
  let activePaymentReversedTxnMismatch = 0;
  let missingReversalTxn = 0;
  let amountMismatches = 0;

  const dupMap = new Map();

  for (const payment of payments) {
    if (!billIds.has(String(payment.bill_id))) {
      orphans += 1;
    }

    const tx = payment.transaction_id ? txMap.get(String(payment.transaction_id)) : null;
    const classifier = classifyPaymentEffectiveness(payment, tx);

    if (classifier.ledger_reversed && String(payment.status || 'paid') === 'paid') {
      activePaymentReversedTxnMismatch += 1;
    }

    if (payment.reversal_transaction_id && !txMap.get(String(payment.reversal_transaction_id))) {
      missingReversalTxn += 1;
    }

    if (tx && Math.abs(paymentAmountPaisa(payment) - txAmountPaisa(tx)) > 0) {
      amountMismatches += 1;
    }

    const key = [
      payment.bill_id,
      payment.month || payment.cycle_month || '',
      paymentAmountPaisa(payment),
      payment.transaction_id || ''
    ].join('|');

    dupMap.set(key, (dupMap.get(key) || 0) + 1);
  }

  let duplicateBillMonthAmount = 0;
  for (const count of dupMap.values()) {
    if (count > 1) duplicateBillMonthAmount += count - 1;
  }

  const status = (
    orphans ||
    activePaymentReversedTxnMismatch ||
    missingReversalTxn ||
    duplicateBillMonthAmount ||
    amountMismatches
  ) ? 'warn' : 'ok';

  return {
    status,
    version: VERSION,
    payment_rows: payments.length,
    orphans,
    active_payment_reversed_txn_mismatch: activePaymentReversedTxnMismatch,
    missing_reversal_txn: missingReversalTxn,
    duplicate_bill_month_amount: duplicateBillMonthAmount,
    amount_mismatches: amountMismatches,
    note: 'Health detects stored-row mismatches. Current cycle excludes ledger-reversed payments regardless of stored status.'
  };
}

/* ─────────────────────────────
 * History
 * ───────────────────────────── */

async function getBillHistory(db, url) {
  const billId = url.searchParams.get('bill_id') || url.searchParams.get('id');

  if (!billId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill_id required'
    }, 400);
  }

  const [paymentCols, txCols] = await Promise.all([
    tableColumns(db, 'bill_payments'),
    tableColumns(db, 'transactions')
  ]);

  const payments = await loadPaymentsForBill(db, paymentCols, billId);
  const txMap = await loadTransactionMapForPayments(db, txCols, payments);

  const enriched = payments.map(payment => {
    const tx = payment.transaction_id ? txMap.get(String(payment.transaction_id)) : null;
    const classifier = classifyPaymentEffectiveness(payment, tx);

    return {
      ...payment,
      amount: paymentAmount(payment),
      amount_paisa: paymentAmountPaisa(payment),
      ledger_transaction: tx ? sanitizeTransaction(tx) : null,
      effective_status: classifier.effective_status,
      effective_paid: classifier.effective_paid,
      effective_exclusion_reason: classifier.reason,
      ledger_reversed: classifier.ledger_reversed,
      ledger_missing: classifier.ledger_missing
    };
  });

  return json({
    ok: true,
    version: VERSION,
    bill_id: billId,
    payments: enriched
  });
}

/* ─────────────────────────────
 * Mutations
 * ───────────────────────────── */

async function payBill(context, body) {
  const db = context.env.DB;

  const billId = clean(body.bill_id || body.id, 120);
  const amount = Number(body.amount);
  const month = normalizeMonth(body.month || body.cycle_month) || currentMonth();

  if (!billId) {
    return json({ ok: false, version: VERSION, error: 'bill_id required' }, 400);
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be greater than zero' }, 400);
  }

  const [billCols, paymentCols] = await Promise.all([
    tableColumns(db, 'bills'),
    tableColumns(db, 'bill_payments')
  ]);

  const bill = await getBillById(db, billCols, billId);
  if (!bill) {
    return json({ ok: false, version: VERSION, error: 'bill not found' }, 404);
  }

  const accountId = clean(body.account_id || bill.account_id || bill.default_account_id || 'cash', 120);
  const categoryId = clean(body.category_id || bill.category_id || DEFAULT_CATEGORY_ID, 120);
  const notes = clean(
    body.notes || `${bill.name || bill.label || 'Bill'} · Bill payment · ${month}`,
    240
  );

  const dryRun = body.dry_run === true || body.dry_run === '1' || body.dry_run === 'true';

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      dry_run: true,
      writes_performed: false,
      expected_writes: [
        { model: 'transactions', rows: 1 },
        { model: 'bill_payments', rows: 1 }
      ],
      normalized_payload: {
        bill_id: billId,
        month,
        amount,
        account_id: accountId,
        category_id: categoryId,
        notes
      }
    });
  }

  const txResult = await internalPost(context, '/api/transactions', {
    type: 'expense',
    amount,
    account_id: accountId,
    category_id: categoryId,
    date: body.date || todayISO(),
    notes,
    created_by: body.created_by || 'bills'
  });

  const txId = txResult.id || txResult.transaction_id;

  if (!txId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'transaction write succeeded but no transaction id was returned',
      transaction_response: txResult
    }, 500);
  }

  await ensureBillPaymentsTable(db);

  const paymentId = makeId('billpay');
  const now = nowISO();

  const row = filterToCols(paymentCols, {
    id: paymentId,
    bill_id: billId,
    month,
    cycle_month: month,
    amount,
    amount_paisa: moneyToPaisa(amount),
    transaction_id: txId,
    status: 'paid',
    paid_at: now,
    created_at: now,
    created_by: body.created_by || 'bills'
  });

  await insertRow(db, 'bill_payments', row).run();

  return json({
    ok: true,
    version: VERSION,
    id: paymentId,
    bill_payment_id: paymentId,
    transaction_id: txId,
    bill_id: billId,
    month,
    amount,
    amount_paisa: moneyToPaisa(amount),
    status: 'paid'
  });
}

async function reverseBillPayment(context, body) {
  const db = context.env.DB;
  const paymentId = clean(body.payment_id || body.id, 120);

  if (!paymentId) {
    return json({ ok: false, version: VERSION, error: 'payment_id required' }, 400);
  }

  const paymentCols = await tableColumns(db, 'bill_payments');
  const payment = await getBillPaymentById(db, paymentCols, paymentId);

  if (!payment) {
    return json({ ok: false, version: VERSION, error: 'bill payment not found' }, 404);
  }

  if (String(payment.status || '').toLowerCase() === 'reversed') {
    return json({
      ok: true,
      version: VERSION,
      id: paymentId,
      already_reversed: true,
      payment
    });
  }

  let reversalId = null;

  if (payment.transaction_id) {
    const reverseResult = await tryReverseTransaction(context, payment.transaction_id, body.reason || 'Bill payment reversed');
    reversalId = reverseResult.reversal_transaction_id || reverseResult.id || reverseResult.reversal_id || null;
  }

  const now = nowISO();

  const updates = {
    status: 'reversed',
    reversed_at: now,
    reversal_transaction_id: reversalId
  };

  await updateRowById(db, 'bill_payments', paymentCols, paymentId, updates);

  return json({
    ok: true,
    version: VERSION,
    id: paymentId,
    bill_payment_id: paymentId,
    status: 'reversed',
    reversed_at: now,
    reversal_transaction_id: reversalId
  });
}

async function deferBill(db, body) {
  const billId = clean(body.bill_id || body.id, 120);
  if (!billId) return json({ ok: false, version: VERSION, error: 'bill_id required' }, 400);

  const billCols = await tableColumns(db, 'bills');
  const updates = {};

  if (billCols.has('deferred_until')) updates.deferred_until = clean(body.deferred_until || body.until || '', 40);
  if (billCols.has('deferred_month')) updates.deferred_month = clean(body.deferred_month || body.month || '', 20);
  if (billCols.has('updated_at')) updates.updated_at = nowISO();

  if (!Object.keys(updates).length) {
    return json({
      ok: false,
      version: VERSION,
      error: 'No supported defer columns exist on bills table'
    }, 409);
  }

  await updateRowById(db, 'bills', billCols, billId, updates);

  return json({
    ok: true,
    version: VERSION,
    id: billId,
    updated: updates
  });
}

async function updateBill(db, body) {
  const billId = clean(body.bill_id || body.id, 120);
  if (!billId) return json({ ok: false, version: VERSION, error: 'bill_id required' }, 400);

  const billCols = await tableColumns(db, 'bills');

  const updates = filterToCols(billCols, {
    name: body.name,
    label: body.label,
    amount: body.amount,
    amount_paisa: body.amount_paisa != null ? body.amount_paisa : (body.amount != null ? moneyToPaisa(body.amount) : undefined),
    due_day: body.due_day,
    account_id: body.account_id,
    default_account_id: body.default_account_id,
    category_id: body.category_id,
    status: body.status,
    active: body.active,
    updated_at: nowISO()
  });

  for (const key of Object.keys(updates)) {
    if (updates[key] === undefined) delete updates[key];
  }

  if (!Object.keys(updates).length) {
    return json({
      ok: false,
      version: VERSION,
      error: 'No supported bill fields supplied'
    }, 400);
  }

  await updateRowById(db, 'bills', billCols, billId, updates);

  return json({
    ok: true,
    version: VERSION,
    id: billId,
    updated: updates
  });
}

async function repairLedgerReversedPayments(db) {
  const [paymentCols, txCols] = await Promise.all([
    tableColumns(db, 'bill_payments'),
    tableColumns(db, 'transactions')
  ]);

  const payments = await loadAllPayments(db, paymentCols);
  const txMap = await loadTransactionMapForPayments(db, txCols, payments);

  let repaired = 0;
  const repairedIds = [];

  for (const payment of payments) {
    const tx = payment.transaction_id ? txMap.get(String(payment.transaction_id)) : null;
    const classifier = classifyPaymentEffectiveness(payment, tx);

    if (classifier.ledger_reversed && String(payment.status || 'paid') === 'paid') {
      await updateRowById(db, 'bill_payments', paymentCols, payment.id, {
        status: 'reversed',
        reversed_at: tx?.reversed_at || nowISO(),
        reversal_transaction_id: tx?.reversed_by || payment.reversal_transaction_id || null
      });
      repaired += 1;
      repairedIds.push(payment.id);
    }
  }

  return json({
    ok: true,
    version: VERSION,
    repaired,
    repaired_ids: repairedIds
  });
}

/* ─────────────────────────────
 * Core classifier
 * ───────────────────────────── */

function classifyPaymentEffectiveness(payment, tx) {
  const rawStatus = String(payment.status || 'paid').toLowerCase();

  if (rawStatus === 'reversed' || rawStatus === 'voided' || rawStatus === 'cancelled') {
    return {
      effective_status: rawStatus,
      effective_paid: false,
      reason: 'payment_status_' + rawStatus,
      ledger_reversed: Boolean(tx && isReversedTransaction(tx)),
      ledger_missing: false
    };
  }

  if (payment.reversed_at || payment.reversal_transaction_id) {
    return {
      effective_status: 'reversed',
      effective_paid: false,
      reason: 'payment_has_reversal_marker',
      ledger_reversed: Boolean(tx && isReversedTransaction(tx)),
      ledger_missing: false
    };
  }

  if (payment.transaction_id && !tx) {
    return {
      effective_status: 'ledger_missing',
      effective_paid: false,
      reason: 'linked_transaction_missing',
      ledger_reversed: false,
      ledger_missing: true
    };
  }

  if (tx && isReversedTransaction(tx)) {
    return {
      effective_status: 'ledger_reversed',
      effective_paid: false,
      reason: 'linked_transaction_reversed',
      ledger_reversed: true,
      ledger_missing: false
    };
  }

  if (rawStatus === 'paid') {
    return {
      effective_status: 'paid',
      effective_paid: true,
      reason: null,
      ledger_reversed: false,
      ledger_missing: false
    };
  }

  return {
    effective_status: rawStatus || 'unknown',
    effective_paid: false,
    reason: 'payment_status_not_paid',
    ledger_reversed: false,
    ledger_missing: false
  };
}

function isReversedTransaction(tx) {
  const notes = String(tx?.notes || '').toUpperCase();

  return !!(
    tx?.reversed_by ||
    tx?.reversed_at ||
    notes.includes('[REVERSED BY ') ||
    notes.includes('[REVERSAL OF ')
  );
}

/* ─────────────────────────────
 * Loaders
 * ───────────────────────────── */

async function loadBills(db, cols, options = {}) {
  if (!cols.has('id')) return [];

  const wanted = [
    'id',
    'name',
    'label',
    'amount',
    'amount_paisa',
    'due_day',
    'account_id',
    'default_account_id',
    'category_id',
    'status',
    'active',
    'deferred_until',
    'deferred_month',
    'created_at',
    'updated_at'
  ].filter(col => cols.has(col));

  const order = cols.has('due_day')
    ? 'due_day, name, id'
    : (cols.has('name') ? 'name, id' : 'id');

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM bills
     ORDER BY ${order}`
  ).all();

  return (rows.results || [])
    .filter(row => options.includeInactive || isActiveBill(row))
    .map(row => ({
      id: row.id,
      name: row.name || row.label || row.id,
      label: row.label || row.name || row.id,
      amount: row.amount != null ? Number(row.amount) : paisaToMoney(row.amount_paisa || 0),
      amount_paisa: billAmountPaisa(row),
      due_day: row.due_day == null ? null : Number(row.due_day),
      account_id: row.account_id || row.default_account_id || '',
      default_account_id: row.default_account_id || row.account_id || '',
      category_id: row.category_id || DEFAULT_CATEGORY_ID,
      status: row.status || 'active',
      active: row.active,
      deferred_until: row.deferred_until || null,
      deferred_month: row.deferred_month || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    }));
}

async function loadPaymentsForMonth(db, cols, month) {
  if (!cols.has('bill_id')) return [];

  const wanted = paymentSelectColumns(cols);
  const monthCol = cols.has('month') ? 'month' : (cols.has('cycle_month') ? 'cycle_month' : null);

  if (!monthCol) {
    return loadAllPayments(db, cols);
  }

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM bill_payments
     WHERE ${monthCol} = ?
     ORDER BY ${cols.has('paid_at') ? 'datetime(paid_at) DESC,' : ''} ${cols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
  ).bind(month).all();

  return normalizePayments(rows.results || []);
}

async function loadPaymentsForBill(db, cols, billId) {
  if (!cols.has('bill_id')) return [];

  const wanted = paymentSelectColumns(cols);

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM bill_payments
     WHERE bill_id = ?
     ORDER BY ${cols.has('paid_at') ? 'datetime(paid_at) DESC,' : ''} ${cols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
  ).bind(billId).all();

  return normalizePayments(rows.results || []);
}

async function loadAllPayments(db, cols) {
  if (!cols.has('id')) return [];

  const wanted = paymentSelectColumns(cols);

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM bill_payments
     ORDER BY ${cols.has('paid_at') ? 'datetime(paid_at) DESC,' : ''} ${cols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
  ).all();

  return normalizePayments(rows.results || []);
}

function paymentSelectColumns(cols) {
  return [
    'id',
    'bill_id',
    'month',
    'cycle_month',
    'amount',
    'amount_paisa',
    'transaction_id',
    'status',
    'paid_at',
    'reversed_at',
    'reversal_transaction_id',
    'created_at',
    'created_by'
  ].filter(col => cols.has(col));
}

function normalizePayments(rows) {
  return rows.map(row => ({
    id: row.id,
    bill_id: row.bill_id,
    month: row.month || row.cycle_month || '',
    cycle_month: row.cycle_month || row.month || '',
    amount: paymentAmount(row),
    amount_paisa: paymentAmountPaisa(row),
    transaction_id: row.transaction_id || null,
    status: row.status || 'paid',
    paid_at: row.paid_at || row.created_at || null,
    reversed_at: row.reversed_at || null,
    reversal_transaction_id: row.reversal_transaction_id || null,
    created_at: row.created_at || null,
    created_by: row.created_by || null
  }));
}

async function loadTransactionMapForPayments(db, cols, payments) {
  const ids = Array.from(new Set(
    payments
      .flatMap(payment => [payment.transaction_id, payment.reversal_transaction_id])
      .filter(Boolean)
      .map(String)
  ));

  const map = new Map();

  if (!ids.length || !cols.has('id')) return map;

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'category_id',
    'notes',
    'reversed_by',
    'reversed_at',
    'created_at'
  ].filter(col => cols.has(col));

  for (const chunk of chunks(ids, 50)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db.prepare(
      `SELECT ${wanted.join(', ')}
       FROM transactions
       WHERE id IN (${placeholders})`
    ).bind(...chunk).all();

    for (const row of rows.results || []) {
      map.set(String(row.id), row);
    }
  }

  return map;
}

async function getBillById(db, cols, billId) {
  if (!cols.has('id')) return null;

  const wanted = [
    'id',
    'name',
    'label',
    'amount',
    'amount_paisa',
    'account_id',
    'default_account_id',
    'category_id',
    'status',
    'active'
  ].filter(col => cols.has(col));

  return db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM bills
     WHERE id = ?
     LIMIT 1`
  ).bind(billId).first();
}

async function getBillPaymentById(db, cols, paymentId) {
  if (!cols.has('id')) return null;

  const wanted = paymentSelectColumns(cols);

  return db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM bill_payments
     WHERE id = ?
     LIMIT 1`
  ).bind(paymentId).first();
}

/* ─────────────────────────────
 * DB helpers
 * ───────────────────────────── */

async function ensureBillPaymentsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL,
      month TEXT,
      amount REAL,
      amount_paisa INTEGER,
      transaction_id TEXT,
      status TEXT DEFAULT 'paid',
      paid_at TEXT,
      reversed_at TEXT,
      reversal_transaction_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT
    )
  `).run();

  const needed = {
    cycle_month: 'TEXT',
    amount_paisa: 'INTEGER',
    reversed_at: 'TEXT',
    reversal_transaction_id: 'TEXT',
    created_by: 'TEXT'
  };

  for (const [col, type] of Object.entries(needed)) {
    await safeAddColumn(db, 'bill_payments', col, type);
  }
}

async function safeAddColumn(db, table, col, type) {
  const cols = await tableColumns(db, table);
  if (cols.has(col)) return;

  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
  } catch {
    // ignore duplicate race
  }
}

async function updateRowById(db, table, cols, id, updates) {
  const filtered = filterToCols(cols, updates);
  delete filtered.id;

  const keys = Object.keys(filtered).filter(key => filtered[key] !== undefined);

  if (!keys.length) return;

  await db.prepare(
    `UPDATE ${table}
     SET ${keys.map(key => `${key} = ?`).join(', ')}
     WHERE id = ?`
  ).bind(...keys.map(key => filtered[key]), id).run();
}

function filterToCols(cols, row) {
  const out = {};

  for (const [key, value] of Object.entries(row || {})) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function insertRow(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('No insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
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

/* ─────────────────────────────
 * Transaction helpers
 * ───────────────────────────── */

async function internalPost(context, path, body) {
  const url = new URL(context.request.url);
  const [pathname, search = ''] = path.split('?');

  url.pathname = pathname;
  url.search = search ? '?' + search : '';

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload || payload.ok === false) {
    throw new Error((payload && payload.error) || 'HTTP ' + response.status);
  }

  return payload;
}

async function tryReverseTransaction(context, transactionId, reason) {
  const attempts = [
    {
      path: `/api/transactions/${encodeURIComponent(transactionId)}/reverse`,
      body: { reason, created_by: 'bills' }
    },
    {
      path: '/api/transactions/reverse',
      body: { id: transactionId, reason, created_by: 'bills' }
    },
    {
      path: `/api/transactions/${encodeURIComponent(transactionId)}`,
      body: { action: 'reverse', reason, created_by: 'bills' }
    }
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      return await internalPost(context, attempt.path, attempt.body);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('transaction reversal failed');
}

/* ─────────────────────────────
 * Money / status helpers
 * ───────────────────────────── */

function isActiveBill(bill) {
  const status = String(bill.status || 'active').toLowerCase();

  if (status === 'inactive' || status === 'archived' || status === 'deleted') return false;
  if (bill.active === 0 || bill.active === false || bill.active === '0' || bill.active === 'false') return false;

  return true;
}

function billAmountPaisa(bill) {
  if (bill.amount_paisa != null && Number.isFinite(Number(bill.amount_paisa))) {
    return Math.round(Number(bill.amount_paisa));
  }

  return moneyToPaisa(bill.amount || 0);
}

function paymentAmount(payment) {
  if (payment.amount != null && Number.isFinite(Number(payment.amount))) {
    return roundMoney(Number(payment.amount));
  }

  return paisaToMoney(payment.amount_paisa || 0);
}

function paymentAmountPaisa(payment) {
  if (payment.amount_paisa != null && Number.isFinite(Number(payment.amount_paisa))) {
    return Math.round(Number(payment.amount_paisa));
  }

  return moneyToPaisa(payment.amount || 0);
}

function txAmountPaisa(tx) {
  const pkr = Number(tx.pkr_amount);
  if (Number.isFinite(pkr) && pkr !== 0) return moneyToPaisa(pkr);

  const amount = Number(tx.amount);
  if (Number.isFinite(amount)) return moneyToPaisa(amount);

  return 0;
}

function moneyToPaisa(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function paisaToMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function sanitizeTransaction(tx) {
  return {
    id: tx.id,
    date: tx.date || null,
    type: tx.type || null,
    amount: tx.amount != null ? Number(tx.amount) : null,
    pkr_amount: tx.pkr_amount != null ? Number(tx.pkr_amount) : null,
    account_id: tx.account_id || null,
    category_id: tx.category_id || null,
    reversed_by: tx.reversed_by || null,
    reversed_at: tx.reversed_at || null,
    is_reversed: isReversedTransaction(tx)
  };
}

/* ─────────────────────────────
 * Utility
 * ───────────────────────────── */

function pathParts(context) {
  const raw = context.params && context.params.path;

  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (!raw) return [];

  return String(raw).split('/').filter(Boolean);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function normalizeMonth(value) {
  const raw = clean(value, 20);
  return /^\d{4}-\d{2}$/.test(raw) ? raw : null;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function chunks(values, size) {
  const out = [];

  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }

  return out;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache'
    }
  });
}