/* Sovereign Finance Bills API
 * /api/bills
 * v0.9.0-bills-contract-owner
 *
 * Contract:
 *   contract_version = bills-v1
 *
 * Banking-grade rules:
 *   - Bill create creates obligation only. No ledger/account movement.
 *   - Bill payment creates ledger expense + bill_payments link row.
 *   - Current-cycle and advance-cycle math is backend truth.
 *   - Reversed ledger payments are excluded from paid totals.
 *   - Account balance remains ledger-derived.
 *   - Frontend must display backend totals/proof only.
 */

import { getUserId } from '../_lib.js';

const VERSION = 'v0.9.0-bills-contract-owner';
const CONTRACT_VERSION = 'bills-v1';
const DEFAULT_CATEGORY_ID = 'bills_utilities';

const ACTIVE_STATUS = 'active';

const INACTIVE_STATUSES = new Set([
  'archived',
  'deleted',
  'disabled',
  'paused',
  'closed',
  'inactive'
]);

export async function onRequestGet(context) {
  return withJsonErrors('GET', async () => {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const db = requireDb(context.env);
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = clean(url.searchParams.get('action')).toLowerCase();

    if (path[0] === 'history' || action === 'history') return getHistory(db, url, userId);
    if (path[0] === 'cycle' || action === 'cycle') return getOverview(db, url, userId);
    if (path[0] && path[0] !== 'health' && !isReservedPath(path[0])) return getBillDetail(db, path[0], url, userId);

    return getOverview(db, url, userId);
  });
}

export async function onRequestPost(context) {
  return withJsonErrors('POST', async () => {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const db = requireDb(context.env);
    const url = new URL(context.request.url);
    const path = getPath(context);
    const body = await readJson(context.request);

    const routeAction = clean(path[0]).toLowerCase();
    const bodyAction = clean(body.action).toLowerCase();
    const action = routeAction || bodyAction || 'create';
    const dryRun = isDryRun(url, body);

    if (action === 'create' || action === 'add' || action === '') return createBill(db, body, dryRun, userId);
    if (action === 'pay' || action === 'payment' || action === 'record_payment') return payBill(db, body, dryRun, userId);
    if (action === 'update' || action === 'edit') return updateBill(db, body, dryRun, userId);
    if (action === 'defer') return deferBill(db, body, dryRun, userId);
    if (action === 'repair' || action === 'repair_reversed_payments' || action === 'repair-reversed-payments') {
      return repairReversedPayments(db, body, dryRun, userId);
    }

    return json(contractError({
      action: 'bill_post',
      code: 'UNSUPPORTED_BILLS_ACTION',
      error: `Unsupported Bills action: ${action}`,
      extra: {
        supported_actions: ['create', 'payment', 'update', 'defer', 'repair_reversed_payments']
      }
    }), 400);
  });
}

export async function onRequestPut(context) {
  return withJsonErrors('PUT', async () => {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const db = requireDb(context.env);
    const path = getPath(context);
    const body = await readJson(context.request);
    const billId = clean(path[0] || body.bill_id || body.id);

    return updateBill(db, { ...body, bill_id: billId }, false, userId);
  });
}

export async function onRequestDelete(context) {
  return withJsonErrors('DELETE', async () => {
    const userId = getUserId(context);
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const db = requireDb(context.env);
    const path = getPath(context);
    const billId = clean(path[0]);

    if (!billId) {
      return json(contractError({
        action: 'bill_archive',
        code: 'BILL_ID_REQUIRED',
        error: 'Bill id is required.'
      }), 400);
    }

    return updateBill(db, {
      bill_id: billId,
      status: 'deleted',
      notes: 'Deleted through DELETE /api/bills/:id'
    }, false);
  });
}

/* ─────────────────────────────
 * GET overview/detail/history
 * ───────────────────────────── */

async function getOverview(db, url) {
  const month = normalizeMonth(url.searchParams.get('month')) || currentMonth();
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  const allBills = await loadBills(db);
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
  let advancePaidTotal = 0;
  let advancePaymentCountTotal = 0;

  for (const bill of allBills) {
    if (!includeInactive && !isActiveBill(bill)) continue;

    const cycle = buildCycle({ bill, month, payments, txnsById });
    const advance = buildAdvanceSummary({ bill, month, payments, txnsById });

    if (isActiveBill(bill)) {
      expectedThisCycle = round2(expectedThisCycle + cycle.expected);
      paidThisCycle = round2(paidThisCycle + cycle.paid);
      remaining = round2(remaining + cycle.remaining);
      ledgerReversedExcludedCount += cycle.ignored_payments.filter(p => p.ignore_reason === 'linked_transaction_reversed').length;

      if (cycle.status === 'paid') paidCount += 1;
      else if (cycle.status === 'partial') partialCount += 1;
      else unpaidCount += 1;

      advancePaidTotal = round2(advancePaidTotal + advance.advance_paid_amount);
      advancePaymentCountTotal += advance.advance_payment_count;
    }

    rows.push({
      ...bill,
      current_cycle: cycle,
      payment_status: cycle.status,
      ledger_linked: cycle.payments.some(p => Boolean(p.transaction_id)),
      ledger_reversed_excluded_count: cycle.ignored_payments.filter(p => p.ignore_reason === 'linked_transaction_reversed').length,
      advance_paid_amount: advance.advance_paid_amount,
      advance_payment_count: advance.advance_payment_count,
      next_paid_cycles: advance.next_cycles
    });
  }

  const health = buildEmbeddedHealth({ payments, txnsById });

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_overview',
    committed: false,
    writes_performed: false,
    read_only: true,

    month,
    include_inactive: includeInactive,

    expected_this_cycle: round2(expectedThisCycle),
    paid_this_cycle: round2(paidThisCycle),
    remaining: round2(remaining),

    paid_count: paidCount,
    partial_count: partialCount,
    unpaid_count: unpaidCount,
    ledger_reversed_excluded_count: ledgerReversedExcludedCount,

    advance_paid_total: round2(advancePaidTotal),
    advance_payment_count_total: advancePaymentCountTotal,

    count: rows.length,
    bills: rows,
    current_cycle: rows,
    health,

    rules: {
      bills_engine_source: '/api/bills',
      current_cycle_is_backend_truth: true,
      frontend_should_not_recalculate_paid_remaining: true,
      active_payment_linked_to_reversed_transaction_is_excluded: true,
      bill_creation_does_not_move_money: true,
      bill_payment_moves_money_through_ledger: true,
      advance_payment_is_explicit_bill_month_greater_than_current_month: true,
      account_balance_source: 'ledger'
    },

    canonical_routes: {
      create: 'POST /api/bills action=create',
      payment: 'POST /api/bills action=payment',
      compatibility_payment: 'POST /api/bills/pay',
      update: 'POST /api/bills action=update',
      defer: 'POST /api/bills action=defer',
      repair: 'POST /api/bills action=repair_reversed_payments',
      reversal: 'POST /api/transactions/reverse'
    },

    warnings: []
  });
}

async function getBillDetail(db, billId, url) {
  const bill = await findBill(db, billId);

  if (!bill) {
    return json(contractError({
      action: 'bill_detail',
      code: 'BILL_NOT_FOUND',
      error: `Bill not found: ${billId}`
    }), 404);
  }

  const month = normalizeMonth(url.searchParams.get('month')) || currentMonth();
  const payments = await loadBillPayments(db);
  const txnsById = await loadTransactionsById(db);

  const cycle = buildCycle({ bill, month, payments, txnsById });
  const advance = buildAdvanceSummary({ bill, month, payments, txnsById });

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_detail',
    committed: false,
    writes_performed: false,
    read_only: true,
    bill: {
      ...bill,
      current_cycle: cycle,
      payment_status: cycle.status,
      advance_paid_amount: advance.advance_paid_amount,
      advance_payment_count: advance.advance_payment_count,
      next_paid_cycles: advance.next_cycles
    },
    warnings: []
  });
}

async function getHistory(db, url) {
  const billId = clean(url.searchParams.get('bill_id') || url.searchParams.get('id'));

  if (!billId) {
    return json(contractError({
      action: 'bill_history',
      code: 'BILL_ID_REQUIRED',
      error: 'bill_id is required.'
    }), 400);
  }

  const bill = await findBill(db, billId);

  if (!bill) {
    return json(contractError({
      action: 'bill_history',
      code: 'BILL_NOT_FOUND',
      error: `Bill not found: ${billId}`
    }), 404);
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
    contract_version: CONTRACT_VERSION,
    action: 'bill_history',
    committed: false,
    writes_performed: false,
    read_only: true,
    bill,
    payments: history,
    count: history.length,
    warnings: []
  });
}

/* ─────────────────────────────
 * Create bill: obligation only
 * ───────────────────────────── */

async function createBill(db, body, dryRun) {
  const cols = await tableColumns(db, 'bills');

  const id = clean(body.id || body.bill_id || body.idempotency_key) || makeId('bill');
  const name = clean(body.name || body.title);
  const amount = money(body.amount ?? body.expected_amount);
  const dueDay = normalizeDueDay(body.due_day);
  const dueDate = normalizeDate(body.due_date);
  const frequency = normalizeFrequency(body.frequency || 'monthly');
  const categoryId = clean(body.category_id || DEFAULT_CATEGORY_ID);
  const defaultAccountId = clean(body.default_account_id || body.account_id || body.payment_account_id);
  const notes = clean(body.notes);
  const now = nowSql();

  if (!name) {
    return json(contractError({
      action: 'bill_create',
      code: 'BILL_NAME_REQUIRED',
      error: 'Bill name is required.'
    }), 400);
  }

  if (amount == null || amount <= 0) {
    return json(contractError({
      action: 'bill_create',
      code: 'BILL_AMOUNT_REQUIRED',
      error: 'Bill amount must be greater than 0.'
    }), 400);
  }

  if (!frequency) {
    return json(contractError({
      action: 'bill_create',
      code: 'INVALID_FREQUENCY',
      error: 'frequency must be monthly, weekly, yearly, or custom.'
    }), 400);
  }

  if (body.due_day !== undefined && body.due_day !== null && body.due_day !== '' && dueDay == null) {
    return json(contractError({
      action: 'bill_create',
      code: 'INVALID_DUE_DAY',
      error: 'due_day must be between 1 and 31.'
    }), 400);
  }

  if (!dueDate && dueDay == null) {
    return json(contractError({
      action: 'bill_create',
      code: 'BILL_DUE_REQUIRED',
      error: 'Provide due_day or due_date.'
    }), 400);
  }

  if (defaultAccountId) {
    const accountCheck = await resolveAccount(db, defaultAccountId);
    if (!accountCheck.ok) {
      return json(contractError({
        action: 'bill_create',
        code: 'ACCOUNT_NOT_FOUND_OR_INACTIVE',
        error: accountCheck.error,
        extra: { account_diagnostics: accountCheck.diagnostics || null }
      }), accountCheck.status || 409);
    }
  }

  const existing = await findBill(db, id);

  if (existing) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'bill_create',
      committed: false,
      writes_performed: false,
      already_recorded: true,
      bill: existing,
      ledger: {
        created: false,
        transaction_id: null,
        account_delta: 0
      },
      account: {
        balance_source: 'ledger',
        impacted: false
      },
      forecast: {
        should_reflect: isActiveBill(existing)
      },
      warnings: []
    });
  }

  const row = {
    id,
    name,
    title: name,
    amount,
    expected_amount: amount,
    due_day: dueDay,
    due_date: dueDate,
    frequency,
    category_id: categoryId,
    default_account_id: defaultAccountId || null,
    account_id: defaultAccountId || null,
    last_paid_date: null,
    last_paid_account_id: null,
    auto_post: 0,
    status: ACTIVE_STATUS,
    notes,
    created_at: now,
    updated_at: now,
    deleted_at: null
  };

  const bill = normalizeBill(row);

  const response = {
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_create',
    committed: !dryRun,
    writes_performed: !dryRun,
    dry_run: Boolean(dryRun),
    bill,
    ledger: {
      created: false,
      transaction_id: null,
      account_delta: 0
    },
    account: {
      balance_source: 'ledger',
      impacted: false
    },
    forecast: {
      should_reflect: true
    },
    proof: {
      bill_row_created: !dryRun,
      money_movement: false,
      account_effect: 'none'
    },
    warnings: []
  };

  if (dryRun) {
    return json({
      ...response,
      committed: false,
      writes_performed: false,
      bill_row: filterToColumns(row, cols)
    });
  }

  await insertRow(db, 'bills', cols, row);

  return json({
    ...response,
    committed: true,
    writes_performed: true,
    bill: await findBill(db, id)
  });
}

/* ─────────────────────────────
 * Pay bill: ledger + bill payment link
 * ───────────────────────────── */

async function payBill(db, body, dryRun) {
  const billId = clean(body.bill_id || body.id);
  const bill = await findBill(db, billId);

  if (!bill) {
    return json(contractError({
      action: 'bill_payment',
      code: 'BILL_NOT_FOUND',
      error: `Bill not found: ${billId}`
    }), 404);
  }

  if (!isActiveBill(bill)) {
    return json(contractError({
      action: 'bill_payment',
      code: 'BILL_NOT_ACTIVE',
      error: 'Only active bills can be paid.'
    }), 409);
  }

  const amount = money(body.amount ?? bill.amount);

  if (amount == null || amount <= 0) {
    return json(contractError({
      action: 'bill_payment',
      code: 'PAYMENT_AMOUNT_REQUIRED',
      error: 'Payment amount must be greater than 0.'
    }), 400);
  }

  const accountId = clean(body.account_id || body.payment_account_id || body.paid_from_account_id || bill.default_account_id);

  if (!accountId) {
    return json(contractError({
      action: 'bill_payment',
      code: 'PAYMENT_ACCOUNT_REQUIRED',
      error: 'Payment account is required. Bills engine cannot silently default to cash.'
    }), 400);
  }

  const accountCheck = await resolveAccount(db, accountId);

  if (!accountCheck.ok) {
    return json(contractError({
      action: 'bill_payment',
      code: 'ACCOUNT_NOT_FOUND_OR_INACTIVE',
      error: accountCheck.error,
      extra: { account_diagnostics: accountCheck.diagnostics || null }
    }), accountCheck.status || 409);
  }

  const paidDate = normalizeDate(body.paid_date || body.payment_date || body.date) || todayISO();
  const billMonth = normalizeMonth(body.bill_month || body.month || body.cycle_month) || monthFromDate(paidDate);
  const current = currentMonth();
  const isAdvance = billMonth > current;

  const categoryId = clean(body.category_id || bill.category_id || DEFAULT_CATEGORY_ID);
  const notes = clean(body.notes);
  const createdBy = clean(body.created_by || 'web-bills');
  const idempotencyKey = clean(body.idempotency_key || body.payment_id || '');

  const paymentId = clean(body.payment_id || body.idempotency_key) || makePaymentId({
    bill_id: bill.id,
    bill_month: billMonth,
    amount,
    account_id: accountId,
    date: paidDate
  });

  const existingPayment = await findExistingPayment(db, paymentId);

  if (existingPayment) {
    const payments = await loadBillPayments(db);
    const txnsById = await loadTransactionsById(db);
    const cycle = buildCycle({ bill, month: billMonth, payments, txnsById });

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'bill_payment',
      committed: false,
      writes_performed: false,
      already_recorded: true,
      bill: billSummary(bill),
      cycle,
      ledger: {
        created: false,
        transaction_id: existingPayment.transaction_id || null,
        account_delta: 0
      },
      payment: {
        created: false,
        payment_id: paymentId
      },
      account: {
        balance_source: 'ledger',
        impacted: false
      },
      forecast: {
        should_reflect: true
      },
      proof: {
        idempotency_key: idempotencyKey || paymentId,
        duplicate_payment_id: paymentId
      },
      warnings: []
    });
  }

  const paymentsBefore = await loadBillPayments(db);
  const txnsByIdBefore = await loadTransactionsById(db);
  const beforeCycle = buildCycle({ bill, month: billMonth, payments: paymentsBefore, txnsById: txnsByIdBefore });

  if (amount > beforeCycle.remaining) {
    return json(contractError({
      action: 'bill_payment',
      code: 'BILL_PAYMENT_OVERPAYMENT_REJECTED',
      error: `Payment exceeds remaining amount for ${billMonth}. Remaining is ${beforeCycle.remaining}. Choose another bill_month for advance payment instead.`,
      extra: {
        bill_id: bill.id,
        bill_month: billMonth,
        expected: beforeCycle.expected,
        paid_before: beforeCycle.paid,
        remaining_before: beforeCycle.remaining,
        attempted_amount: amount,
        advance_selected: isAdvance
      }
    }), 400);
  }

  const txId = clean(body.transaction_id) || makeId('tx_bill_payment');
  const now = nowSql();

  const transaction = {
    id: txId,
    date: paidDate,
    type: 'expense',
    transaction_type: 'expense',
    amount,
    account_id: accountId,
    category_id: categoryId,
    merchant: bill.name,
    merchant_id: null,
    source_module: 'bills',
    source_id: bill.id,
    source_action: isAdvance ? 'advance_payment' : 'payment',
    idempotency_key: paymentId,
    notes: buildBillPaymentNotes({
      bill,
      bill_month: billMonth,
      payment_id: paymentId,
      account_id: accountId,
      notes
    }),
    description: `Bill payment: ${bill.name}`,
    memo: `Bill payment: ${bill.name}`,
    fee_amount: 0,
    pra_amount: 0,
    is_pending_reversal: 0,
    reversal_due_date: null,
    created_at: now,
    updated_at: now,
    reversed_by: null,
    reversed_at: null,
    linked_txn_id: null,
    status: 'active',
    created_by: createdBy
  };

  const payment = {
    id: paymentId,
    bill_id: bill.id,
    bill_name_snapshot: bill.name,
    bill_month: billMonth,
    month: billMonth,
    cycle_month: billMonth,
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
    created_at: now,
    updated_at: now,
    created_by: createdBy
  };

  const afterPaid = round2(beforeCycle.paid + amount);
  const afterRemaining = round2(Math.max(0, beforeCycle.expected - afterPaid));
  const afterStatus = afterRemaining <= 0 ? 'paid' : afterPaid > 0 ? 'partial' : 'unpaid';

  const projectedCycle = {
    bill_month: billMonth,
    expected: beforeCycle.expected,
    paid: afterPaid,
    paid_amount: afterPaid,
    remaining: afterRemaining,
    remaining_amount: afterRemaining,
    status: afterStatus,
    advance: isAdvance
  };

  const responseBase = {
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_payment',
    committed: !dryRun,
    writes_performed: !dryRun,
    dry_run: Boolean(dryRun),

    bill: billSummary(bill),
    cycle: projectedCycle,

    ledger: {
      created: !dryRun,
      transaction_id: txId,
      type: 'expense',
      amount,
      account_id: accountId,
      account_delta: round2(-amount),
      marker: `[BILL_PAYMENT] bill_id=${bill.id} bill_month=${billMonth}`,
      source_module: 'bills',
      source_id: bill.id,
      source_action: isAdvance ? 'advance_payment' : 'payment'
    },

    payment: {
      created: !dryRun,
      payment_id: paymentId
    },

    account: {
      balance_source: 'ledger',
      impacted: true
    },

    forecast: {
      should_reflect: true,
      current_cycle_impacted: billMonth === current,
      future_cycle_impacted: billMonth > current,
      bill_month: billMonth
    },

    proof: {
      payment_id: paymentId,
      transaction_id: txId,
      idempotency_key: idempotencyKey || paymentId,
      expected_transaction_rows: 1,
      expected_bill_payment_rows: 1,
      expected_bill_rows_updated: 1,
      paid_before: beforeCycle.paid,
      paid_after: afterPaid,
      remaining_before: beforeCycle.remaining,
      remaining_after: afterRemaining,
      status_before: beforeCycle.status,
      status_after: afterStatus,
      advance_payment: isAdvance,
      account_effect: 'decrease_selected_account',
      account_delta: round2(-amount),
      money_truth_owner: 'ledger'
    },

    warnings: []
  };

  if (dryRun) {
    return json({
      ...responseBase,
      committed: false,
      writes_performed: false,
      transaction,
      payment
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
  if (billCols.has('updated_at')) billUpdate.updated_at = now;

  const updateStmt = prepareUpdate(db, 'bills', billCols, billUpdate, 'TRIM(id) = TRIM(?)', [bill.id]);
  if (updateStmt) batch.push(updateStmt);

  await db.batch(batch);

  const freshBill = await findBill(db, bill.id);
  const paymentsAfter = await loadBillPayments(db);
  const txnsAfter = await loadTransactionsById(db);
  const cycleAfter = buildCycle({ bill: freshBill, month: billMonth, payments: paymentsAfter, txnsById: txnsAfter });
  const currentCycleAfter = buildCycle({ bill: freshBill, month: current, payments: paymentsAfter, txnsById: txnsAfter });
  const advanceAfter = buildAdvanceSummary({ bill: freshBill, month: current, payments: paymentsAfter, txnsById: txnsAfter });

  return json({
    ...responseBase,
    committed: true,
    writes_performed: true,
    bill: {
      ...freshBill,
      current_cycle: currentCycleAfter,
      payment_status: currentCycleAfter.status,
      advance_paid_amount: advanceAfter.advance_paid_amount,
      advance_payment_count: advanceAfter.advance_payment_count,
      next_paid_cycles: advanceAfter.next_cycles
    },
    cycle: cycleAfter,
    payment: {
      created: true,
      payment_id: paymentId
    },
    payment_id: paymentId,
    transaction_id: txId
  });
}

/* ─────────────────────────────
 * Update / Defer / Repair
 * ───────────────────────────── */

async function updateBill(db, body, dryRun) {
  const billId = clean(body.bill_id || body.id);
  const bill = await findBill(db, billId);

  if (!bill) {
    return json(contractError({
      action: 'bill_update',
      code: 'BILL_NOT_FOUND',
      error: `Bill not found: ${billId}`
    }), 404);
  }

  const cols = await tableColumns(db, 'bills');
  const updates = {};

  if (body.name !== undefined && cols.has('name')) {
    const name = clean(body.name);
    if (!name) {
      return json(contractError({
        action: 'bill_update',
        code: 'BILL_NAME_REQUIRED',
        error: 'Bill name cannot be empty.'
      }), 400);
    }
    updates.name = name;
  }

  if (body.title !== undefined && cols.has('title')) updates.title = clean(body.title);

  if (body.amount !== undefined || body.expected_amount !== undefined) {
    const amount = money(body.amount ?? body.expected_amount);

    if (amount == null || amount <= 0) {
      return json(contractError({
        action: 'bill_update',
        code: 'INVALID_AMOUNT',
        error: 'Amount must be greater than 0.'
      }), 400);
    }

    if (cols.has('amount')) updates.amount = amount;
    if (cols.has('expected_amount')) updates.expected_amount = amount;
  }

  if (body.due_day !== undefined && cols.has('due_day')) {
    const dueDay = normalizeDueDay(body.due_day);

    if (body.due_day !== null && body.due_day !== '' && dueDay == null) {
      return json(contractError({
        action: 'bill_update',
        code: 'INVALID_DUE_DAY',
        error: 'due_day must be between 1 and 31.'
      }), 400);
    }

    updates.due_day = dueDay;
  }

  if (body.due_date !== undefined && cols.has('due_date')) updates.due_date = normalizeDate(body.due_date);

  if (body.frequency !== undefined && cols.has('frequency')) {
    const frequency = normalizeFrequency(body.frequency);

    if (!frequency) {
      return json(contractError({
        action: 'bill_update',
        code: 'INVALID_FREQUENCY',
        error: 'frequency must be monthly, weekly, yearly, or custom.'
      }), 400);
    }

    updates.frequency = frequency;
  }

  if (body.category_id !== undefined && cols.has('category_id')) updates.category_id = clean(body.category_id) || DEFAULT_CATEGORY_ID;
  if (body.default_account_id !== undefined && cols.has('default_account_id')) updates.default_account_id = clean(body.default_account_id) || null;
  if (body.account_id !== undefined && cols.has('account_id')) updates.account_id = clean(body.account_id) || null;

  if (body.status !== undefined && cols.has('status')) {
    const status = clean(body.status || ACTIVE_STATUS).toLowerCase();
    updates.status = status || ACTIVE_STATUS;
  }

  if (body.notes !== undefined && cols.has('notes')) updates.notes = clean(body.notes);
  if (cols.has('updated_at')) updates.updated_at = nowSql();

  if (!Object.keys(updates).length) {
    return json(contractError({
      action: 'bill_update',
      code: 'NO_SUPPORTED_FIELDS',
      error: 'No supported bill fields were supplied.'
    }), 400);
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'bill_update',
      committed: false,
      writes_performed: false,
      dry_run: true,
      bill_id: bill.id,
      updates,
      ledger: {
        created: false,
        transaction_id: null,
        account_delta: 0
      },
      account: {
        balance_source: 'ledger',
        impacted: false
      },
      warnings: []
    });
  }

  await updateRow(db, 'bills', cols, updates, 'TRIM(id) = TRIM(?)', [bill.id]);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_update',
    committed: true,
    writes_performed: true,
    bill_id: bill.id,
    bill: await findBill(db, bill.id),
    ledger: {
      created: false,
      transaction_id: null,
      account_delta: 0
    },
    account: {
      balance_source: 'ledger',
      impacted: false
    },
    forecast: {
      should_reflect: true
    },
    warnings: []
  });
}

async function deferBill(db, body, dryRun) {
  const billId = clean(body.bill_id || body.id);
  const bill = await findBill(db, billId);

  if (!bill) {
    return json(contractError({
      action: 'bill_defer',
      code: 'BILL_NOT_FOUND',
      error: `Bill not found: ${billId}`
    }), 404);
  }

  const dueDay = normalizeDueDay(body.due_day || body.new_due_day);
  const dueDate = normalizeDate(body.due_date || body.next_due_date);
  const cols = await tableColumns(db, 'bills');
  const updates = {};

  if (dueDay != null && cols.has('due_day')) updates.due_day = dueDay;
  if (dueDate && cols.has('due_date')) updates.due_date = dueDate;
  if (body.notes !== undefined && cols.has('notes')) updates.notes = clean(body.notes);
  if (cols.has('updated_at')) updates.updated_at = nowSql();

  if (!Object.keys(updates).length) {
    return json(contractError({
      action: 'bill_defer',
      code: 'NO_SUPPORTED_DEFER_FIELDS',
      error: 'Provide due_day or due_date/next_due_date.'
    }), 400);
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'bill_defer',
      committed: false,
      writes_performed: false,
      dry_run: true,
      bill_id: bill.id,
      updates,
      ledger: {
        created: false,
        transaction_id: null,
        account_delta: 0
      },
      account: {
        balance_source: 'ledger',
        impacted: false
      },
      warnings: []
    });
  }

  await updateRow(db, 'bills', cols, updates, 'TRIM(id) = TRIM(?)', [bill.id]);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_defer',
    committed: true,
    writes_performed: true,
    bill: await findBill(db, bill.id),
    ledger: {
      created: false,
      transaction_id: null,
      account_delta: 0
    },
    account: {
      balance_source: 'ledger',
      impacted: false
    },
    forecast: {
      should_reflect: true
    },
    warnings: []
  });
}

async function repairReversedPayments(db, body, dryRun) {
  const payments = await loadBillPayments(db);
  const txnsById = await loadTransactionsById(db);
  const paymentCols = await tableColumns(db, 'bill_payments');

  const bad = payments.filter(payment => {
    if (!payment) return false;
    if (!isActivePaymentStatus(payment.status)) return false;
    if (!payment.transaction_id) return false;

    const tx = txnsById.get(payment.transaction_id);
    return tx && isReversedTxn(tx);
  });

  if (!bad.length) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'bill_repair_reversed_payments',
      committed: false,
      writes_performed: false,
      dry_run: Boolean(dryRun),
      bad_payments_found: 0,
      message: 'No active bill payments linked to reversed ledger transactions were found.',
      warnings: []
    });
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'bill_repair_reversed_payments',
      committed: false,
      writes_performed: false,
      dry_run: true,
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
      }),
      warnings: []
    });
  }

  const batch = [];

  for (const payment of bad) {
    const tx = txnsById.get(payment.transaction_id);
    const updates = {};

    if (paymentCols.has('status')) updates.status = 'reversed';
    if (paymentCols.has('reversed_at')) updates.reversed_at = (tx && tx.reversed_at) || nowIso();
    if (paymentCols.has('reversal_transaction_id')) updates.reversal_transaction_id = (tx && tx.reversed_by) || null;
    if (paymentCols.has('reversed_by')) updates.reversed_by = (tx && tx.reversed_by) || null;
    if (paymentCols.has('updated_at')) updates.updated_at = nowSql();
    if (paymentCols.has('notes')) {
      updates.notes = appendNote(payment.notes, `Auto-repaired: linked ledger transaction ${payment.transaction_id} was reversed by ${(tx && tx.reversed_by) || 'unknown'}.`);
    }

    const stmt = prepareUpdate(db, 'bill_payments', paymentCols, updates, 'TRIM(id) = TRIM(?)', [payment.id]);
    if (stmt) batch.push(stmt);
  }

  if (batch.length) await db.batch(batch);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'bill_repair_reversed_payments',
    committed: true,
    writes_performed: true,
    bad_payments_found: bad.length,
    bad_payments_repaired: bad.length,
    repaired_payment_ids: bad.map(payment => payment.id),
    health_check_recommended: '/api/bills/health',
    warnings: []
  });
}

/* ─────────────────────────────
 * Cycle engine
 * ───────────────────────────── */

function buildCycle({ bill, month, payments, txnsById }) {
  const expected = round2(bill.amount || 0);

  const billPayments = (payments || []).filter(payment => {
    if (!payment || payment.bill_id !== bill.id) return false;

    const paymentMonth = payment.bill_month || monthFromDate(payment.paid_date);
    return paymentMonth === month;
  });

  const activePayments = [];
  const ignoredPayments = [];

  for (const payment of billPayments) {
    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
    const classified = classifyPayment(payment, tx || null);

    const decorated = {
      ...payment,
      effective_paid: classified.effective_paid,
      ignore_reason: classified.ignore_reason,
      linked_transaction: tx || null
    };

    if (classified.effective_paid) activePayments.push(decorated);
    else ignoredPayments.push(decorated);
  }

  const paid = round2(activePayments.reduce((sum, payment) => sum + round2(payment.amount || 0), 0));
  const remaining = round2(Math.max(0, expected - paid));
  const status = remaining <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  return {
    bill_month: month,
    month,
    expected,
    amount: expected,
    paid,
    paid_amount: paid,
    remaining,
    remaining_amount: remaining,
    status,
    payments: activePayments,
    ignored_payments: ignoredPayments,
    effective_payment_count: activePayments.length,
    ignored_payment_count: ignoredPayments.length,
    due_day: bill.due_day,
    due_date: dueDateForMonth(month, bill.due_day)
  };
}

function buildAdvanceSummary({ bill, month, payments, txnsById }) {
  const futureByMonth = new Map();

  let advancePaidAmount = 0;
  let advancePaymentCount = 0;

  for (const payment of payments || []) {
    if (!payment || payment.bill_id !== bill.id) continue;

    const paymentMonth = payment.bill_month || monthFromDate(payment.paid_date);
    if (!paymentMonth || paymentMonth <= month) continue;

    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
    const classified = classifyPayment(payment, tx || null);

    if (!classified.effective_paid) continue;

    const amount = round2(payment.amount || 0);

    advancePaidAmount = round2(advancePaidAmount + amount);
    advancePaymentCount += 1;

    const bucket = futureByMonth.get(paymentMonth) || {
      month: paymentMonth,
      paid_amount: 0,
      payment_count: 0,
      payments: []
    };

    bucket.paid_amount = round2(bucket.paid_amount + amount);
    bucket.payment_count += 1;
    bucket.payments.push({
      id: payment.id,
      amount,
      account_id: payment.account_id,
      paid_date: payment.paid_date,
      transaction_id: payment.transaction_id,
      notes: payment.notes
    });

    futureByMonth.set(paymentMonth, bucket);
  }

  const next_cycles = Array.from(futureByMonth.values()).sort((a, b) => a.month.localeCompare(b.month));

  return {
    advance_paid_amount: round2(advancePaidAmount),
    advance_payment_count: advancePaymentCount,
    next_cycles
  };
}

function classifyPayment(payment, tx) {
  const status = clean(payment?.status).toLowerCase();
  const notes = clean(payment?.notes).toUpperCase();

  if (status === 'reversed' || status === 'voided' || status === 'cancelled' || status === 'canceled') {
    return { effective_paid: false, ignore_reason: 'payment_status_reversed' };
  }

  if (payment?.reversed_at || payment?.reversal_transaction_id) {
    return { effective_paid: false, ignore_reason: 'payment_marked_reversed' };
  }

  if (notes.includes('[REVERSED') || notes.includes('[REVERSAL')) {
    return { effective_paid: false, ignore_reason: 'payment_notes_reversal_marker' };
  }

  if (!payment?.transaction_id) {
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
 * Loaders
 * ───────────────────────────── */

async function loadBills(db) {
  const cols = await tableColumns(db, 'bills');
  if (!cols.size) return [];

  const select = [
    col(cols, 'id'),
    firstExisting(cols, ['name', 'title'], 'name'),
    firstExisting(cols, ['amount', 'expected_amount'], 'amount'),
    col(cols, 'due_day'),
    col(cols, 'due_date'),
    col(cols, 'frequency'),
    col(cols, 'category_id'),
    firstExisting(cols, ['default_account_id', 'account_id'], 'default_account_id'),
    col(cols, 'account_id'),
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
  const id = clean(billId);
  if (!id) return null;

  const cols = await tableColumns(db, 'bills');
  if (!cols.size || !cols.has('id')) return null;

  const select = [
    col(cols, 'id'),
    firstExisting(cols, ['name', 'title'], 'name'),
    firstExisting(cols, ['amount', 'expected_amount'], 'amount'),
    col(cols, 'due_day'),
    col(cols, 'due_date'),
    col(cols, 'frequency'),
    col(cols, 'category_id'),
    firstExisting(cols, ['default_account_id', 'account_id'], 'default_account_id'),
    col(cols, 'account_id'),
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
      WHERE TRIM(id) = TRIM(?)
      LIMIT 1`
  ).bind(id).first();

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
    firstExisting(cols, ['linked_txn_id', 'linked_transaction_id'], 'linked_txn_id'),
    col(cols, 'source_module'),
    col(cols, 'source_id'),
    col(cols, 'source_action')
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
 * Normalizers / summaries
 * ───────────────────────────── */

function normalizeBill(row) {
  return {
    id: clean(row?.id),
    name: clean(row?.name),
    amount: money(row?.amount) || 0,
    due_day: normalizeDueDay(row?.due_day),
    due_date: normalizeDate(row?.due_date),
    frequency: normalizeFrequency(row?.frequency || 'monthly') || 'monthly',
    category_id: clean(row?.category_id || DEFAULT_CATEGORY_ID),
    default_account_id: clean(row?.default_account_id || row?.account_id),
    account_id: clean(row?.account_id || row?.default_account_id),
    last_paid_date: normalizeDate(row?.last_paid_date),
    last_paid_account_id: clean(row?.last_paid_account_id),
    status: clean(row?.status || ACTIVE_STATUS).toLowerCase() || ACTIVE_STATUS,
    deleted_at: clean(row?.deleted_at),
    notes: clean(row?.notes),
    created_at: clean(row?.created_at),
    updated_at: clean(row?.updated_at)
  };
}

function normalizePayment(row) {
  const amount = row?.amount == null
    ? row?.amount_paisa == null ? null : Number(row.amount_paisa) / 100
    : money(row.amount);

  return {
    id: clean(row?.id),
    bill_id: clean(row?.bill_id),
    bill_month: clean(row?.bill_month),
    amount: amount == null ? 0 : round2(amount),
    amount_paisa: row?.amount_paisa == null ? null : Number(row.amount_paisa),
    account_id: clean(row?.account_id),
    category_id: clean(row?.category_id),
    paid_date: normalizeDate(row?.paid_date),
    transaction_id: clean(row?.transaction_id),
    status: clean(row?.status || 'paid').toLowerCase() || 'paid',
    reversed_at: clean(row?.reversed_at),
    reversal_transaction_id: clean(row?.reversal_transaction_id),
    notes: clean(row?.notes),
    created_at: clean(row?.created_at),
    updated_at: clean(row?.updated_at)
  };
}

function normalizeTxn(row) {
  return {
    id: clean(row?.id),
    type: clean(row?.type).toLowerCase(),
    amount: money(row?.amount) || 0,
    account_id: clean(row?.account_id),
    category_id: clean(row?.category_id),
    notes: clean(row?.notes),
    created_at: clean(row?.created_at),
    reversed_by: clean(row?.reversed_by),
    reversed_at: clean(row?.reversed_at),
    linked_txn_id: clean(row?.linked_txn_id),
    source_module: clean(row?.source_module),
    source_id: clean(row?.source_id),
    source_action: clean(row?.source_action)
  };
}

function billSummary(bill) {
  return {
    id: bill.id,
    name: bill.name,
    expected_amount: bill.amount,
    amount: bill.amount,
    status: bill.status,
    frequency: bill.frequency,
    due_day: bill.due_day,
    due_date: bill.due_date
  };
}

function buildEmbeddedHealth({ payments, txnsById }) {
  const active_payment_reversed_txn_mismatch = [];
  const orphans = [];

  for (const payment of payments || []) {
    if (!payment) continue;
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
    payment_rows: (payments || []).length,
    orphans,
    active_payment_reversed_txn_mismatch,
    missing_reversal_txn: [],
    duplicate_bill_month_amount: [],
    amount_mismatches: []
  };
}

/* ─────────────────────────────
 * Rules / helpers
 * ───────────────────────────── */

function isReservedPath(value) {
  return ['history', 'cycle', 'pay', 'payment', 'update', 'defer', 'repair', 'health'].includes(clean(value).toLowerCase());
}

function isActiveBill(bill) {
  const status = clean(bill?.status || ACTIVE_STATUS).toLowerCase();

  return status === ACTIVE_STATUS && !bill?.deleted_at && !INACTIVE_STATUSES.has(status);
}

function isActivePaymentStatus(statusValue) {
  const status = clean(statusValue).toLowerCase();
  return status === '' || status === 'paid' || status === 'active' || status === 'posted';
}

function isReversedTxn(tx) {
  if (!tx) return false;

  const notes = clean(tx.notes).toUpperCase();

  return Boolean(
    tx.reversed_by ||
    tx.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function buildBillPaymentNotes({ bill, bill_month, payment_id, account_id, notes }) {
  return clean([
    `Bill payment: ${bill.name}`,
    `bill_id=${bill.id}`,
    `payment_id=${payment_id}`,
    `bill_month=${bill_month}`,
    `account_id=${account_id}`,
    `[BILL_PAYMENT] bill_id=${bill.id} bill_month=${bill_month}`,
    notes ? notes : null
  ].filter(Boolean).join(' | '), '', 1000);
}

async function resolveAccount(db, accountId) {
  const id = clean(accountId);

  if (!id) return { ok: false, status: 400, error: 'account_id required' };

  const cols = await tableColumns(db, 'accounts');

  if (!cols.size || !cols.has('id')) {
    return { ok: false, status: 500, error: 'accounts table missing id column' };
  }

  const where = [];

  if (cols.has('deleted_at')) where.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) where.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) where.push("(status IS NULL OR status = '' OR status = 'active')");

  const sql = `
    SELECT *
      FROM accounts
     WHERE TRIM(id) = TRIM(?)
     ${where.length ? 'AND ' + where.join(' AND ') : ''}
     LIMIT 1
  `;

  const row = await db.prepare(sql).bind(id).first();

  if (row?.id) return { ok: true, account: row };

  return {
    ok: false,
    status: 409,
    error: 'Account not found or inactive',
    diagnostics: {
      received_account_id: id
    }
  };
}

async function findExistingPayment(db, paymentId) {
  const id = clean(paymentId);
  if (!id) return null;

  const exists = await tableExists(db, 'bill_payments');
  if (!exists) return null;

  const cols = await tableColumns(db, 'bill_payments');
  if (!cols.has('id')) return null;

  const select = [
    'id',
    col(cols, 'bill_id'),
    firstExisting(cols, ['transaction_id', 'txn_id', 'ledger_transaction_id'], 'transaction_id')
  ].filter(Boolean);

  return db.prepare(
    `SELECT ${select.join(', ')}
       FROM bill_payments
      WHERE TRIM(id) = TRIM(?)
      LIMIT 1`
  ).bind(id).first();
}

/* ─────────────────────────────
 * DB utilities
 * ───────────────────────────── */

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB is missing.');
  return env.DB;
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
  return (
    url.searchParams.get('dry_run') === '1' ||
    url.searchParams.get('dry_run') === 'true' ||
    body.dry_run === true ||
    body.dry_run === '1' ||
    body.dry_run === 'true'
  );
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
    if (cols.has(name)) return alias && alias !== name ? `${name} AS ${alias}` : name;
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

  if (!keys.length) throw new Error(`${table} has no compatible insert columns.`);

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

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

function clean(value, fallback = '', max = 1000) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
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

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';

  return date.toISOString().slice(0, 10);
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

function normalizeFrequency(value) {
  const text = clean(value || 'monthly').toLowerCase();
  return ['monthly', 'weekly', 'yearly', 'custom'].includes(text) ? text : null;
}

function monthFromDate(value) {
  const date = normalizeDate(value);
  return date ? date.slice(0, 7) : currentMonth();
}

function currentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function todayISO() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function dueDateForMonth(month, dueDay) {
  const normalizedMonth = normalizeMonth(month) || currentMonth();
  const day = normalizeDueDay(dueDay);

  if (!day) return '';

  const [yearText, monthText] = normalizedMonth.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, maxDay);

  return `${normalizedMonth}-${String(safeDay).padStart(2, '0')}`;
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

function makePaymentId(input) {
  return 'billpay_' + stableHash([
    input.bill_id,
    input.bill_month,
    input.amount,
    input.account_id,
    input.date
  ].join('|'));
}

function stableHash(input) {
  let h = 2166136261;
  const text = String(input);

  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(36);
}

function contractError({ action, code, error, extra }) {
  return {
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action,
    code,
    error,
    committed: false,
    writes_performed: false,
    warnings: [],
    ...(extra || {})
  };
}

async function withJsonErrors(method, fn) {
  try {
    return await fn();
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      method,
      code: 'BILLS_TOP_LEVEL_ERROR',
      error: err.message || String(err),
      stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 6).join('\n'),
      committed: false,
      writes_performed: false
    }, 500);
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
