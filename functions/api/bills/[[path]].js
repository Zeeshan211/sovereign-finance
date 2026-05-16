/* Sovereign Finance Bills API
 * /api/bills
 * v0.8.0-bills-engine-root-contract
 *
 * B2 purpose:
 * - Make /api/bills the Bills engine source of truth.
 * - Derive current-cycle paid/remaining/status from bill_payments + ledger.
 * - Exclude payments linked to reversed ledger transactions.
 * - Add repair action for active bill payments linked to reversed transactions.
 * - Remove silent Cash fallback for bill payments.
 * - Keep frontend routes:
 *   GET  /api/bills
 *   GET  /api/bills/history?bill_id=...
 *   POST /api/bills/pay
 *   POST /api/bills/update
 *   POST /api/bills/defer
 *   POST /api/bills/repair
 *   POST /api/bills { action: "create" }
 */

const VERSION = 'v0.8.0-bills-engine-root-contract';
const DEFAULT_CATEGORY_ID = 'bills_utilities';

export async function onRequestGet(context) {
  try {
    const db = database(context.env);
    if (!db) return json(errorPayload('DB_BINDING_MISSING', 'D1 binding DB is missing.'), 500);

    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = clean(url.searchParams.get('action')).toLowerCase();

    if (path[0] === 'history' || action === 'history') {
      return getHistory(db, url);
    }

    if (path[0] === 'cycle' || action === 'cycle') {
      return getOverview(db, url);
    }

    if (path[0] && !isReservedPath(path[0])) {
      return getBillDetail(db, path[0], url);
    }

    return getOverview(db, url);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILLS_GET_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = database(context.env);
    if (!db) return json(errorPayload('DB_BINDING_MISSING', 'D1 binding DB is missing.'), 500);

    const url = new URL(context.request.url);
    const path = getPath(context);
    const body = await readJson(context.request);
    const routeAction = clean(path[0]).toLowerCase();
    const bodyAction = clean(body.action).toLowerCase();
    const action = routeAction || bodyAction || 'create';
    const dryRun = isDryRun(url, body);

    if (action === 'pay' || action === 'payment' || action === 'record_payment') {
      return payBill(db, body, dryRun);
    }

    if (action === 'update' || action === 'edit') {
      return updateBill(db, body, dryRun);
    }

    if (action === 'defer') {
      return deferBill(db, body, dryRun);
    }

    if (
      action === 'repair' ||
      action === 'repair_reversed_payments' ||
      action === 'repair-reversed-payments'
    ) {
      return repairReversedPayments(db, body, dryRun);
    }

    if (action === 'create' || action === 'add' || action === '') {
      return createBill(db, body, dryRun);
    }

    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'UNSUPPORTED_ACTION',
        message: `Unsupported Bills action: ${action}`
      },
      supported_actions: ['create', 'pay', 'update', 'defer', 'repair']
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILLS_POST_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = database(context.env);
    if (!db) return json(errorPayload('DB_BINDING_MISSING', 'D1 binding DB is missing.'), 500);

    const path = getPath(context);
    const body = await readJson(context.request);
    const billId = clean(path[0] || body.bill_id || body.id);

    return updateBill(db, { ...body, bill_id: billId }, false);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILLS_PUT_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = database(context.env);
    if (!db) return json(errorPayload('DB_BINDING_MISSING', 'D1 binding DB is missing.'), 500);

    const path = getPath(context);
    const billId = clean(path[0]);

    if (!billId) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'BILL_ID_REQUIRED',
          message: 'Bill id is required.'
        }
      }, 400);
    }

    const cols = await tableColumns(db, 'bills');
    const bill = await findBill(db, billId);

    if (!bill) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'BILL_NOT_FOUND',
          message: `Bill not found: ${billId}`
        }
      }, 404);
    }

    const updates = {};
    if (cols.has('status')) updates.status = 'deleted';
    if (cols.has('deleted_at')) updates.deleted_at = nowIso();
    if (cols.has('updated_at')) updates.updated_at = nowSql();

    if (!Object.keys(updates).length) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'BILL_DELETE_UNSUPPORTED',
          message: 'Bills table has no supported soft-delete columns.'
        }
      }, 409);
    }

    await updateRow(db, 'bills', cols, updates, 'id = ?', [billId]);

    return json({
      ok: true,
      version: VERSION,
      action: 'bill.delete',
      writes_performed: true,
      bill_id: billId
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILLS_DELETE_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

/* ─────────────────────────────
 * Overview
 * ───────────────────────────── */

async function getOverview(db, url) {
  const month = normalizeMonth(url.searchParams.get('month')) || currentMonth();
  const bills = await loadBills(db);
  const payments = await loadBillPayments(db);
  const txnsById = await loadTransactionsById(db);

  const rows = [];
  let expectedThisCycle = 0;
  let paidThisCycle = 0;
  let remaining = 0;
  let paidCount = 0;
  let partialCount = 0;
  let unpaidCount = 0;
  let ledgerReversedExcludedCount = 0;

  for (const bill of bills) {
    if (!isActiveBill(bill)) continue;

    const cycle = buildCurrentCycle({
      bill,
      month,
      payments,
      txnsById
    });

    expectedThisCycle = round2(expectedThisCycle + cycle.amount);
    paidThisCycle = round2(paidThisCycle + cycle.paid_amount);
    remaining = round2(remaining + cycle.remaining_amount);
    ledgerReversedExcludedCount += cycle.ignored_payments.filter(p => p.ignore_reason === 'linked_transaction_reversed').length;

    if (cycle.status === 'paid') paidCount += 1;
    else if (cycle.status === 'partial') partialCount += 1;
    else unpaidCount += 1;

    rows.push({
      ...bill,
      current_cycle: cycle,
      ledger_linked: cycle.payments.some(p => Boolean(p.transaction_id)),
      ledger_reversed_excluded_count: cycle.ignored_payments.filter(p => p.ignore_reason === 'linked_transaction_reversed').length
    });
  }

  const health = buildEmbeddedHealth({ payments, txnsById });

  return json({
    ok: true,
    version: VERSION,
    month,
    expected_this_cycle: round2(expectedThisCycle),
    paid_this_cycle: round2(paidThisCycle),
    remaining: round2(remaining),
    paid_count: paidCount,
    partial_count: partialCount,
    unpaid_count: unpaidCount,
    ledger_reversed_excluded_count: ledgerReversedExcludedCount,
    count: rows.length,
    bills: rows,
    current_cycle: rows,
    health,
    rules: {
      bills_engine_source: '/api/bills',
      current_cycle_is_backend_truth: true,
      frontend_should_not_recalculate_paid_remaining: true,
      active_payment_linked_to_reversed_transaction_is_excluded: true,
      no_silent_cash_fallback_for_payments: true,
      bill_creation_does_not_move_money: true,
      bill_payment_moves_money_through_ledger: true
    },
    contract: {
      endpoint: '/api/bills',
      health_endpoint: '/api/bills/health',
      pay_endpoint: '/api/bills/pay',
      update_endpoint: '/api/bills/update',
      defer_endpoint: '/api/bills/defer',
      repair_endpoint: '/api/bills/repair'
    }
  });
}

async function getBillDetail(db, billId, url) {
  const bill = await findBill(db, billId);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_NOT_FOUND',
        message: `Bill not found: ${billId}`
      }
    }, 404);
  }

  const month = normalizeMonth(url.searchParams.get('month')) || currentMonth();
  const payments = await loadBillPayments(db);
  const txnsById = await loadTransactionsById(db);
  const current_cycle = buildCurrentCycle({ bill, month, payments, txnsById });

  return json({
    ok: true,
    version: VERSION,
    bill: {
      ...bill,
      current_cycle
    }
  });
}

async function getHistory(db, url) {
  const billId = clean(url.searchParams.get('bill_id') || url.searchParams.get('id'));

  if (!billId) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_ID_REQUIRED',
        message: 'bill_id is required.'
      }
    }, 400);
  }

  const bill = await findBill(db, billId);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_NOT_FOUND',
        message: `Bill not found: ${billId}`
      }
    }, 404);
  }

  const payments = (await loadBillPayments(db)).filter(p => p.bill_id === billId);
  const txnsById = await loadTransactionsById(db);

  const history = payments.map(payment => {
    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
    const classified = classifyPayment(payment, tx);

    return {
      ...payment,
      effective_paid: classified.effective_paid,
      ignore_reason: classified.ignore_reason,
      linked_transaction: tx || null
    };
  });

  return json({
    ok: true,
    version: VERSION,
    bill,
    payments: history,
    count: history.length
  });
}

/* ─────────────────────────────
 * Current-cycle engine
 * ───────────────────────────── */

function buildCurrentCycle(input) {
  const { bill, month, payments, txnsById } = input;
  const amount = bill.amount;
  const billPayments = payments.filter(payment => {
    if (payment.bill_id !== bill.id) return false;

    const paymentMonth = payment.bill_month || monthFromDate(payment.paid_date);
    return paymentMonth === month;
  });

  const activePayments = [];
  const ignoredPayments = [];

  for (const payment of billPayments) {
    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
    const classified = classifyPayment(payment, tx);
    const decorated = {
      ...payment,
      effective_paid: classified.effective_paid,
      ignore_reason: classified.ignore_reason,
      linked_transaction: tx || null
    };

    if (classified.effective_paid) activePayments.push(decorated);
    else ignoredPayments.push(decorated);
  }

  const paidAmount = round2(activePayments.reduce((sum, payment) => {
    return sum + Number(payment.amount || 0);
  }, 0));

  const remainingAmount = round2(Math.max(0, amount - paidAmount));
  const status = remainingAmount <= 0
    ? 'paid'
    : paidAmount > 0
      ? 'partial'
      : 'unpaid';

  return {
    month,
    amount,
    paid_amount: paidAmount,
    remaining_amount: remainingAmount,
    status,
    payments: activePayments,
    ignored_payments: ignoredPayments,
    effective_payment_count: activePayments.length,
    ignored_payment_count: ignoredPayments.length,
    due_day: bill.due_day,
    due_date: dueDateForMonth(month, bill.due_day)
  };
}

function classifyPayment(payment, tx) {
  const status = clean(payment.status).toLowerCase();
  const notes = clean(payment.notes).toUpperCase();

  if (status === 'reversed' || status === 'voided' || status === 'cancelled' || status === 'canceled') {
    return { effective_paid: false, ignore_reason: 'payment_status_reversed' };
  }

  if (payment.reversed_at || payment.reversal_transaction_id) {
    return { effective_paid: false, ignore_reason: 'payment_marked_reversed' };
  }

  if (notes.includes('[REVERSED') || notes.includes('[REVERSAL')) {
    return { effective_paid: false, ignore_reason: 'payment_notes_reversal_marker' };
  }

  if (!payment.transaction_id) {
    return { effective_paid: false, ignore_reason: 'missing_transaction_id' };
  }

  if (!tx) {
    return { effective_paid: false, ignore_reason: 'transaction_not_found' };
  }

  if (isReversedTxn(tx)) {
    return { effective_paid: false, ignore_reason: 'linked_transaction_reversed' };
  }

  return { effective_paid: true, ignore_reason: null };
}

/* ─────────────────────────────
 * Mutations
 * ───────────────────────────── */

async function createBill(db, body, dryRun) {
  const cols = await tableColumns(db, 'bills');
  const name = clean(body.name || body.title);
  const amount = money(body.amount || body.expected_amount);
  const id = clean(body.id) || makeId('bill');
  const dueDay = normalizeDueDay(body.due_day);
  const frequency = clean(body.frequency || 'monthly') || 'monthly';
  const categoryId = clean(body.category_id || DEFAULT_CATEGORY_ID);
  const defaultAccountId = clean(body.default_account_id || body.account_id || body.payment_account_id);
  const notes = clean(body.notes);

  if (!name) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'BILL_NAME_REQUIRED', message: 'Bill name is required.' }
    }, 400);
  }

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'BILL_AMOUNT_REQUIRED', message: 'Bill amount must be greater than 0.' }
    }, 400);
  }

  const row = {
    id,
    name,
    title: name,
    amount,
    expected_amount: amount,
    due_day: dueDay,
    frequency,
    category_id: categoryId,
    default_account_id: defaultAccountId || null,
    account_id: defaultAccountId || null,
    last_paid_date: null,
    last_paid_account_id: null,
    auto_post: 0,
    status: 'active',
    notes,
    created_at: nowSql(),
    updated_at: nowSql(),
    deleted_at: null
  };

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'bill.create.dry_run',
      dry_run: true,
      writes_performed: false,
      bill: filterToColumns(row, cols)
    });
  }

  await insertRow(db, 'bills', cols, row);

  const bill = await findBill(db, id);

  return json({
    ok: true,
    version: VERSION,
    action: 'bill.create',
    writes_performed: true,
    bill
  });
}

async function payBill(db, body, dryRun) {
  const billId = clean(body.bill_id || body.id);
  const bill = await findBill(db, billId);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'BILL_NOT_FOUND', message: `Bill not found: ${billId}` }
    }, 404);
  }

  const amount = money(body.amount || bill.amount);

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'PAYMENT_AMOUNT_REQUIRED', message: 'Payment amount must be greater than 0.' }
    }, 400);
  }

  const explicitAccount = clean(body.account_id || body.payment_account_id || body.paid_from_account_id);
  const billDefaultAccount = clean(bill.default_account_id || bill.account_id || bill.last_paid_account_id);
  const accountId = explicitAccount || billDefaultAccount;

  if (!accountId) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'PAYMENT_ACCOUNT_REQUIRED',
        message: 'Payment account is required. Bills engine no longer silently defaults to Cash.'
      },
      bill_id: bill.id,
      bill_name: bill.name
    }, 400);
  }

  const paidDate = normalizeDate(body.paid_date || body.payment_date || body.date) || todayISO();
  const month = normalizeMonth(body.bill_month || body.month || body.cycle_month) || monthFromDate(paidDate);
  const categoryId = clean(body.category_id || bill.category_id || DEFAULT_CATEGORY_ID);
  const paymentId = clean(body.payment_id || body.idempotency_key) || makeId('billpay');
  const txId = clean(body.transaction_id) || makeId('tx_bill_expense');
  const createdAt = nowSql();
  const notes = clean(body.notes);

  const transaction = {
    id: txId,
    date: paidDate,
    type: 'expense',
    transaction_type: 'expense',
    amount,
    account_id: accountId,
    category_id: categoryId,
    notes: `Bill payment: ${bill.name} | bill_id=${bill.id} | payment_id=${paymentId} | bill_month=${month} | account_id=${accountId} | [BILL_PAYMENT]${notes ? ' | ' + notes : ''}`,
    description: `Bill payment: ${bill.name}`,
    memo: `Bill payment: ${bill.name}`,
    fee_amount: 0,
    pra_amount: 0,
    created_at: createdAt,
    updated_at: createdAt,
    reversed_by: null,
    reversed_at: null,
    linked_txn_id: null,
    status: 'active'
  };

  const payment = {
    id: paymentId,
    bill_id: bill.id,
    bill_name_snapshot: bill.name,
    bill_month: month,
    month,
    cycle_month: month,
    amount,
    amount_paisa: toPaisa(amount),
    paid_amount: amount,
    paid_amount_paisa: toPaisa(amount),
    account_id: accountId,
    category_id: categoryId,
    paid_date: paidDate,
    payment_date: paidDate,
    date: paidDate,
    transaction_id: txId,
    txn_id: txId,
    ledger_transaction_id: txId,
    status: 'paid',
    notes,
    created_at: createdAt,
    updated_at: createdAt,
    created_by: clean(body.created_by || 'web-bills')
  };

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'bill.pay.dry_run',
      dry_run: true,
      writes_performed: false,
      bill,
      transaction,
      payment,
      rule: 'Payment creates an expense transaction and a bill_payments snapshot. No silent cash fallback.'
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  const paymentCols = await tableColumns(db, 'bill_payments');
  const billCols = await tableColumns(db, 'bills');

  const batch = [
    prepareInsert(db, 'transactions', txCols, transaction),
    prepareInsert(db, 'bill_payments', paymentCols, payment)
  ];

  const billUpdate = {};
  if (billCols.has('last_paid_date')) billUpdate.last_paid_date = paidDate;
  if (billCols.has('last_paid_account_id')) billUpdate.last_paid_account_id = accountId;
  if (billCols.has('default_account_id') && !bill.default_account_id) billUpdate.default_account_id = accountId;
  if (billCols.has('updated_at')) billUpdate.updated_at = createdAt;

  const updateStmt = prepareUpdate(db, 'bills', billCols, billUpdate, 'id = ?', [bill.id]);
  if (updateStmt) batch.push(updateStmt);

  await db.batch(batch);

  const url = new URL('https://local/api/bills');
  url.searchParams.set('month', month);
  const overviewResponse = await getOverview(db, url);
  const overview = await overviewResponse.json();

  return json({
    ok: true,
    version: VERSION,
    action: 'bill.pay',
    writes_performed: true,
    bill_id: bill.id,
    payment_id: paymentId,
    transaction_id: txId,
    bill: (overview.bills || []).find(row => row.id === bill.id) || null,
    overview,
    rule: 'Bill payment moved money through ledger and linked bill_payments.transaction_id.'
  });
}

async function updateBill(db, body, dryRun) {
  const billId = clean(body.bill_id || body.id);
  const bill = await findBill(db, billId);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'BILL_NOT_FOUND', message: `Bill not found: ${billId}` }
    }, 404);
  }

  const cols = await tableColumns(db, 'bills');
  const updates = {};

  if (body.name !== undefined && cols.has('name')) updates.name = clean(body.name);
  if (body.title !== undefined && cols.has('title')) updates.title = clean(body.title);
  if (body.amount !== undefined) {
    const amount = money(body.amount);
    if (amount == null || amount <= 0) {
      return json({
        ok: false,
        version: VERSION,
        error: { code: 'INVALID_AMOUNT', message: 'Amount must be greater than 0.' }
      }, 400);
    }
    if (cols.has('amount')) updates.amount = amount;
    if (cols.has('expected_amount')) updates.expected_amount = amount;
  }
  if (body.due_day !== undefined && cols.has('due_day')) updates.due_day = normalizeDueDay(body.due_day);
  if (body.frequency !== undefined && cols.has('frequency')) updates.frequency = clean(body.frequency || 'monthly');
  if (body.category_id !== undefined && cols.has('category_id')) updates.category_id = clean(body.category_id);
  if (body.default_account_id !== undefined && cols.has('default_account_id')) updates.default_account_id = clean(body.default_account_id) || null;
  if (body.account_id !== undefined && cols.has('account_id')) updates.account_id = clean(body.account_id) || null;
  if (body.status !== undefined && cols.has('status')) updates.status = clean(body.status || 'active');
  if (body.notes !== undefined && cols.has('notes')) updates.notes = clean(body.notes);
  if (cols.has('updated_at')) updates.updated_at = nowSql();

  if (!Object.keys(updates).length) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'NO_SUPPORTED_FIELDS', message: 'No supported bill fields were supplied.' }
    }, 400);
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'bill.update.dry_run',
      dry_run: true,
      writes_performed: false,
      bill_id: bill.id,
      updates
    });
  }

  await updateRow(db, 'bills', cols, updates, 'id = ?', [bill.id]);

  return json({
    ok: true,
    version: VERSION,
    action: 'bill.update',
    writes_performed: true,
    bill: await findBill(db, bill.id)
  });
}

async function deferBill(db, body, dryRun) {
  const billId = clean(body.bill_id || body.id);
  const bill = await findBill(db, billId);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'BILL_NOT_FOUND', message: `Bill not found: ${billId}` }
    }, 404);
  }

  const dueDay = normalizeDueDay(body.due_day || body.new_due_day);
  const cols = await tableColumns(db, 'bills');
  const updates = {};

  if (dueDay != null && cols.has('due_day')) updates.due_day = dueDay;
  if (body.notes !== undefined && cols.has('notes')) updates.notes = clean(body.notes);
  if (cols.has('updated_at')) updates.updated_at = nowSql();

  if (!Object.keys(updates).length) {
    return json({
      ok: false,
      version: VERSION,
      error: { code: 'NO_SUPPORTED_DEFER_FIELDS', message: 'No supported defer fields were supplied.' }
    }, 400);
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'bill.defer.dry_run',
      dry_run: true,
      writes_performed: false,
      bill_id: bill.id,
      updates
    });
  }

  await updateRow(db, 'bills', cols, updates, 'id = ?', [bill.id]);

  return json({
    ok: true,
    version: VERSION,
    action: 'bill.defer',
    writes_performed: true,
    bill: await findBill(db, bill.id)
  });
}

async function repairReversedPayments(db, body, dryRun) {
  const payments = await loadBillPayments(db);
  const txnsById = await loadTransactionsById(db);
  const paymentCols = await tableColumns(db, 'bill_payments');

  const bad = payments.filter(payment => {
    if (!isActivePaymentStatus(payment.status)) return false;
    if (!payment.transaction_id) return false;

    const tx = txnsById.get(payment.transaction_id);
    return tx && isReversedTxn(tx);
  });

  if (!bad.length) {
    return json({
      ok: true,
      version: VERSION,
      action: 'bill.repair_reversed_payments',
      dry_run: Boolean(dryRun),
      writes_performed: false,
      bad_payments_found: 0,
      message: 'No active bill payments linked to reversed ledger transactions were found.'
    });
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'bill.repair_reversed_payments.dry_run',
      dry_run: true,
      writes_performed: false,
      bad_payments_found: bad.length,
      bad_payments: bad.map(payment => {
        const tx = txnsById.get(payment.transaction_id);
        return {
          payment_id: payment.id,
          bill_id: payment.bill_id,
          bill_month: payment.bill_month,
          amount: payment.amount,
          account_id: payment.account_id,
          transaction_id: payment.transaction_id,
          transaction_reversed_by: tx ? tx.reversed_by : null,
          transaction_reversed_at: tx ? tx.reversed_at : null
        };
      })
    });
  }

  const batch = [];

  for (const payment of bad) {
    const tx = txnsById.get(payment.transaction_id);
    const updates = {};

    if (paymentCols.has('status')) updates.status = 'reversed';
    if (paymentCols.has('reversed_at')) updates.reversed_at = tx.reversed_at || nowIso();
    if (paymentCols.has('reversal_transaction_id')) updates.reversal_transaction_id = tx.reversed_by || null;
    if (paymentCols.has('reversed_by')) updates.reversed_by = tx.reversed_by || null;
    if (paymentCols.has('updated_at')) updates.updated_at = nowSql();
    if (paymentCols.has('notes')) {
      updates.notes = appendNote(
        payment.notes,
        `Auto-repaired: linked ledger transaction ${payment.transaction_id} was reversed by ${tx.reversed_by || 'unknown'}.`
      );
    }

    const stmt = prepareUpdate(db, 'bill_payments', paymentCols, updates, 'id = ?', [payment.id]);
    if (stmt) batch.push(stmt);
  }

  await db.batch(batch);

  return json({
    ok: true,
    version: VERSION,
    action: 'bill.repair_reversed_payments',
    writes_performed: true,
    bad_payments_found: bad.length,
    bad_payments_repaired: bad.length,
    repaired_payment_ids: bad.map(payment => payment.id),
    health_check_recommended: '/api/bills/health'
  });
}

/* ─────────────────────────────
 * Loaders
 * ───────────────────────────── */

async function loadBills(db) {
  const cols = await tableColumns(db, 'bills');
  if (!cols.size) return [];

  const select = [
    'id',
    firstExisting(cols, ['name', 'title'], 'name'),
    firstExisting(cols, ['amount', 'expected_amount'], 'amount'),
    col(cols, 'due_day'),
    col(cols, 'due_date'),
    col(cols, 'frequency'),
    col(cols, 'category_id'),
    firstExisting(cols, ['default_account_id', 'account_id'], 'default_account_id'),
    col(cols, 'last_paid_date'),
    col(cols, 'last_paid_account_id'),
    col(cols, 'status'),
    col(cols, 'deleted_at'),
    col(cols, 'notes'),
    col(cols, 'created_at'),
    col(cols, 'updated_at')
  ].filter(Boolean);

  const orderBy = cols.has('due_day')
    ? 'due_day IS NULL, due_day ASC, name ASC'
    : 'name ASC';

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bills
     ORDER BY ${orderBy}`
  ).all();

  return (res.results || []).map(normalizeBill);
}

async function findBill(db, billId) {
  const cols = await tableColumns(db, 'bills');
  if (!cols.size || !cols.has('id')) return null;

  const select = [
    'id',
    firstExisting(cols, ['name', 'title'], 'name'),
    firstExisting(cols, ['amount', 'expected_amount'], 'amount'),
    col(cols, 'due_day'),
    col(cols, 'due_date'),
    col(cols, 'frequency'),
    col(cols, 'category_id'),
    firstExisting(cols, ['default_account_id', 'account_id'], 'default_account_id'),
    col(cols, 'last_paid_date'),
    col(cols, 'last_paid_account_id'),
    col(cols, 'status'),
    col(cols, 'deleted_at'),
    col(cols, 'notes'),
    col(cols, 'created_at'),
    col(cols, 'updated_at')
  ].filter(Boolean);

  const row = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bills
     WHERE id = ?
     LIMIT 1`
  ).bind(billId).first();

  return row ? normalizeBill(row) : null;
}

async function loadBillPayments(db) {
  const exists = await tableExists(db, 'bill_payments');
  if (!exists) return [];

  const cols = await tableColumns(db, 'bill_payments');
  if (!cols.size) return [];

  const select = [
    cols.has('id') ? 'id' : 'rowid AS id',
    col(cols, 'bill_id'),
    firstExisting(cols, ['bill_month', 'month', 'cycle_month'], 'bill_month'),
    firstExisting(cols, ['amount', 'paid_amount'], 'amount'),
    firstExisting(cols, ['amount_paisa', 'paid_amount_paisa'], 'amount_paisa'),
    col(cols, 'account_id'),
    col(cols, 'category_id'),
    firstExisting(cols, ['paid_date', 'payment_date', 'date'], 'paid_date'),
    firstExisting(cols, ['transaction_id', 'txn_id', 'ledger_transaction_id'], 'transaction_id'),
    col(cols, 'status'),
    col(cols, 'reversed_at'),
    firstExisting(cols, ['reversal_transaction_id', 'reversed_by'], 'reversal_transaction_id'),
    col(cols, 'notes'),
    col(cols, 'created_at'),
    col(cols, 'updated_at')
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bill_payments`
  ).all();

  return (res.results || []).map(normalizePayment);
}

async function loadTransactionsById(db) {
  const exists = await tableExists(db, 'transactions');
  const map = new Map();

  if (!exists) return map;

  const cols = await tableColumns(db, 'transactions');
  if (!cols.size || !cols.has('id')) return map;

  const select = [
    'id',
    firstExisting(cols, ['type', 'transaction_type'], 'type'),
    col(cols, 'amount'),
    col(cols, 'account_id'),
    col(cols, 'category_id'),
    firstExisting(cols, ['notes', 'description', 'memo'], 'notes'),
    col(cols, 'created_at'),
    col(cols, 'reversed_by'),
    col(cols, 'reversed_at'),
    firstExisting(cols, ['linked_txn_id', 'linked_transaction_id'], 'linked_txn_id')
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions`
  ).all();

  for (const row of res.results || []) {
    const tx = normalizeTxn(row);
    map.set(tx.id, tx);
  }

  return map;
}

/* ─────────────────────────────
 * Normalizers
 * ───────────────────────────── */

function normalizeBill(row) {
  return {
    id: clean(row.id),
    name: clean(row.name),
    amount: money(row.amount) || 0,
    due_day: normalizeDueDay(row.due_day),
    due_date: normalizeDate(row.due_date),
    frequency: clean(row.frequency || 'monthly') || 'monthly',
    category_id: clean(row.category_id || DEFAULT_CATEGORY_ID),
    default_account_id: clean(row.default_account_id),
    last_paid_date: normalizeDate(row.last_paid_date),
    last_paid_account_id: clean(row.last_paid_account_id),
    status: clean(row.status || 'active') || 'active',
    deleted_at: clean(row.deleted_at),
    notes: clean(row.notes),
    created_at: clean(row.created_at),
    updated_at: clean(row.updated_at)
  };
}

function normalizePayment(row) {
  const amount = row.amount == null
    ? row.amount_paisa == null
      ? null
      : Number(row.amount_paisa) / 100
    : money(row.amount);

  return {
    id: clean(row.id),
    bill_id: clean(row.bill_id),
    bill_month: clean(row.bill_month),
    amount: amount == null ? 0 : round2(amount),
    amount_paisa: row.amount_paisa == null ? null : Number(row.amount_paisa),
    account_id: clean(row.account_id),
    category_id: clean(row.category_id),
    paid_date: normalizeDate(row.paid_date),
    transaction_id: clean(row.transaction_id),
    status: clean(row.status || 'paid') || 'paid',
    reversed_at: clean(row.reversed_at),
    reversal_transaction_id: clean(row.reversal_transaction_id),
    notes: clean(row.notes),
    created_at: clean(row.created_at),
    updated_at: clean(row.updated_at)
  };
}

function normalizeTxn(row) {
  return {
    id: clean(row.id),
    type: clean(row.type).toLowerCase(),
    amount: money(row.amount) || 0,
    account_id: clean(row.account_id),
    category_id: clean(row.category_id),
    notes: clean(row.notes),
    created_at: clean(row.created_at),
    reversed_by: clean(row.reversed_by),
    reversed_at: clean(row.reversed_at),
    linked_txn_id: clean(row.linked_txn_id)
  };
}

/* ─────────────────────────────
 * Health
 * ───────────────────────────── */

function buildEmbeddedHealth(input) {
  const { payments, txnsById } = input;
  const active_payment_reversed_txn_mismatch = [];
  const orphans = [];

  for (const payment of payments) {
    if (!isActivePaymentStatus(payment.status)) continue;

    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;

    if (!payment.transaction_id || !tx) {
      orphans.push({
        payment_id: payment.id,
        bill_id: payment.bill_id,
        transaction_id: payment.transaction_id || null,
        reason: !payment.transaction_id ? 'missing_transaction_id' : 'transaction_not_found'
      });
      continue;
    }

    if (isReversedTxn(tx)) {
      active_payment_reversed_txn_mismatch.push({
        payment_id: payment.id,
        bill_id: payment.bill_id,
        bill_month: payment.bill_month,
        amount: payment.amount,
        transaction_id: payment.transaction_id,
        transaction_reversed_by: tx.reversed_by || null,
        transaction_reversed_at: tx.reversed_at || null
      });
    }
  }

  return {
    status: active_payment_reversed_txn_mismatch.length || orphans.length ? 'warn' : 'pass',
    payment_rows: payments.length,
    orphans,
    active_payment_reversed_txn_mismatch,
    missing_reversal_txn: [],
    duplicate_bill_month_amount: [],
    amount_mismatches: []
  };
}

/* ─────────────────────────────
 * Rules/helpers
 * ───────────────────────────── */

function isReservedPath(value) {
  return ['history', 'cycle', 'pay', 'payment', 'update', 'defer', 'repair', 'health'].includes(clean(value).toLowerCase());
}

function isActiveBill(bill) {
  const status = clean(bill.status || 'active').toLowerCase();

  return status !== 'deleted' &&
    status !== 'archived' &&
    status !== 'inactive' &&
    !bill.deleted_at;
}

function isActivePaymentStatus(statusValue) {
  const status = clean(statusValue).toLowerCase();

  return status === '' ||
    status === 'paid' ||
    status === 'active' ||
    status === 'posted';
}

function isReversedTxn(tx) {
  const notes = clean(tx.notes).toUpperCase();

  return Boolean(
    tx.reversed_by ||
    tx.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function database(env) {
  return env.DB || env.SOVEREIGN_DB || env.FINANCE_DB;
}

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

  return String(raw).split('/').filter(Boolean);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isDryRun(url, body) {
  return url.searchParams.get('dry_run') === '1' ||
    url.searchParams.get('dry_run') === 'true' ||
    body.dry_run === true ||
    body.dry_run === '1' ||
    body.dry_run === 'true';
}

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(tableName).first();

    return Boolean(row && row.name);
  } catch {
    return false;
  }
}

async function tableColumns(db, tableName) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function col(cols, name) {
  return cols.has(name) ? name : null;
}

function firstExisting(cols, names, alias) {
  for (const name of names) {
    if (cols.has(name)) {
      return alias && alias !== name ? `${name} AS ${alias}` : name;
    }
  }

  return `NULL AS ${alias}`;
}

function filterToColumns(row, cols) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function prepareInsert(db, table, cols, row) {
  const filtered = filterToColumns(row, cols);
  const keys = Object.keys(filtered);

  if (!keys.length) {
    throw new Error(`${table} has no compatible insert columns.`);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => filtered[key]));
}

async function insertRow(db, table, cols, row) {
  await prepareInsert(db, table, cols, row).run();
}

function prepareUpdate(db, table, cols, updates, whereSql, whereValues) {
  const filtered = filterToColumns(updates, cols);
  const keys = Object.keys(filtered);

  if (!keys.length) return null;

  return db.prepare(
    `UPDATE ${table}
     SET ${keys.map(key => `${key} = ?`).join(', ')}
     WHERE ${whereSql}`
  ).bind(...keys.map(key => filtered[key]), ...(whereValues || []));
}

async function updateRow(db, table, cols, updates, whereSql, whereValues) {
  const stmt = prepareUpdate(db, table, cols, updates, whereSql, whereValues);
  if (!stmt) return null;

  return stmt.run();
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function money(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  if (!Number.isFinite(n)) return null;

  return round2(n);
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function toPaisa(value) {
  return Math.round(Number(value || 0) * 100);
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return '';

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';

  return d.toISOString().slice(0, 10);
}

function normalizeMonth(value) {
  const raw = clean(value);
  if (!raw) return '';

  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7);

  return '';
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 31) return null;

  return Math.floor(n);
}

function monthFromDate(value) {
  const date = normalizeDate(value);
  return date ? date.slice(0, 7) : currentMonth();
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function dueDateForMonth(month, dueDay) {
  const m = normalizeMonth(month) || currentMonth();
  const day = normalizeDueDay(dueDay);

  if (!day) return '';

  const [yearText, monthText] = m.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, maxDay);

  return `${m}-${String(safeDay).padStart(2, '0')}`;
}

function appendNote(existing, addition) {
  const base = clean(existing);
  const next = clean(addition);

  if (!base) return next;
  if (!next) return base;

  return `${base} | ${next}`.slice(0, 1000);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorPayload(code, message) {
  return {
    ok: false,
    version: VERSION,
    error: { code, message }
  };
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
