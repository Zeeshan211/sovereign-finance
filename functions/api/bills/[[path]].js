/* /api/bills/[[path]].js
 * Sovereign Finance · Bills Engine
 * v1.0.0-bills-banking-grade
 *
 * Backend owns:
 * - bill config CRUD
 * - bill payment dry-run proof
 * - atomic bill payment + ledger transaction + payment row
 * - partial/full payment state
 * - bill-aware reversal
 * - defer without money movement
 * - health verification
 */

import { audit } from '../_lib.js';

const VERSION = 'v1.0.0-bills-banking-grade';

const DEFAULT_CATEGORY_ID = 'bills_utilities';
const DEFAULT_CREATED_BY = 'web-bills';
const BALANCE_TOLERANCE_PAISA = 1;

const ACTIVE_ACCOUNT_CONDITION =
  "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const parts = getPathParts(context);

    if (parts[0] === 'health') {
      return getHealth(context);
    }

    if (parts[0]) {
      return getOneBill(context, parts[0]);
    }

    return listBills(context);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const parts = getPathParts(context);
    const body = await readJSON(context.request);

    if (!parts[0]) {
      return createBill(context, body);
    }

    if (parts[0] === 'payments' && parts[1] && parts[2] === 'reverse') {
      return reversePayment(context, parts[1], body);
    }

    if (parts[1] === 'pay' && parts[2] === 'dry-run') {
      return payBillDryRun(context, parts[0], body);
    }

    if (parts[1] === 'pay') {
      return payBillCommit(context, parts[0], body);
    }

    if (parts[1] === 'defer') {
      return deferBill(context, parts[0], body);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported POST route'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const parts = getPathParts(context);
    const body = await readJSON(context.request);

    if (!parts[0]) {
      return json({
        ok: false,
        version: VERSION,
        error: 'bill id required'
      }, 400);
    }

    return updateBill(context, parts[0], body);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const parts = getPathParts(context);

    if (!parts[0]) {
      return json({
        ok: false,
        version: VERSION,
        error: 'bill id required'
      }, 400);
    }

    return softDeleteBill(context, parts[0]);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

/* ─────────────────────────────
 * Bills read
 * ───────────────────────────── */

async function listBills(context) {
  const db = context.env.DB;
  const billCols = await cols(db, 'bills');
  const paymentCols = await cols(db, 'bill_payments');

  const rows = await db.prepare(
    `SELECT *
     FROM bills
     WHERE status IS NULL OR status != 'deleted'
     ORDER BY
       CASE WHEN due_day IS NULL THEN 99 ELSE due_day END,
       name`
  ).all();

  const bills = [];

  for (const bill of rows.results || []) {
    bills.push(await decorateBill(db, bill, billCols, paymentCols));
  }

  return json({
    ok: true,
    version: VERSION,
    bills
  });
}

async function getOneBill(context, id) {
  const db = context.env.DB;
  const billCols = await cols(db, 'bills');
  const paymentCols = await cols(db, 'bill_payments');
  const bill = await getBill(db, id);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill not found',
      id
    }, 404);
  }

  return json({
    ok: true,
    version: VERSION,
    bill: await decorateBill(db, bill, billCols, paymentCols)
  });
}

async function decorateBill(db, bill, billCols, paymentCols) {
  const billMonth = currentBillMonth();
  const expectedPaisa = moneyToPaisa(bill.amount || 0);
  const cycle = await getBillCycle(db, bill.id, billMonth, expectedPaisa);

  return {
    id: bill.id,
    name: bill.name,
    amount: paisaToMoney(expectedPaisa),
    due_day: bill.due_day ?? null,
    frequency: bill.frequency || 'monthly',
    category_id: bill.category_id || DEFAULT_CATEGORY_ID,
    default_account_id: bill.default_account_id || bill.account_id || null,
    status: bill.status || 'active',
    notes: bill.notes || '',
    last_paid_date: bill.last_paid_date || null,
    last_paid_account_id: bill.last_paid_account_id || null,
    current_cycle: cycle,
    reverse_eligible: false,
    reverse_block_reason: 'Reverse a specific payment, not the bill config.'
  };
}

async function getBillCycle(db, billId, billMonth, expectedPaisa) {
  const rows = await db.prepare(
    `SELECT *
     FROM bill_payments
     WHERE bill_id = ?
       AND bill_month = ?
     ORDER BY datetime(created_at) DESC, id DESC`
  ).bind(billId, billMonth).all();

  const payments = rows.results || [];
  const active = payments.filter(p => String(p.status || 'paid') === 'paid');
  const reversed = payments.filter(p => String(p.status || '') === 'reversed');

  const paidPaisa = active.reduce((sum, p) => {
    return sum + Number(p.amount_paisa || moneyToPaisa(p.amount || 0));
  }, 0);

  const remainingPaisa = Math.max(0, expectedPaisa - paidPaisa);

  return {
    bill_month: billMonth,
    expected_amount: paisaToMoney(expectedPaisa),
    expected_amount_paisa: expectedPaisa,
    paid_total: paisaToMoney(paidPaisa),
    paid_total_paisa: paidPaisa,
    remaining: paisaToMoney(remainingPaisa),
    remaining_paisa: remainingPaisa,
    payment_status: remainingPaisa === 0
      ? 'paid'
      : (paidPaisa > 0 ? 'partial' : 'unpaid'),
    payment_count: active.length,
    reversed_payment_count: reversed.length,
    linked_transaction_ids: active.map(p => p.transaction_id).filter(Boolean),
    payments: payments.map(paymentDTO)
  };
}

function paymentDTO(p) {
  return {
    id: p.id,
    bill_id: p.bill_id,
    bill_month: p.bill_month || p.month,
    amount: Number(p.amount || 0),
    amount_paisa: Number(p.amount_paisa || moneyToPaisa(p.amount || 0)),
    account_id: p.account_id,
    category_id: p.category_id || DEFAULT_CATEGORY_ID,
    paid_date: p.paid_date || p.payment_date,
    transaction_id: p.transaction_id,
    status: p.status || 'paid',
    reversed_at: p.reversed_at || null,
    reversal_transaction_id: p.reversal_transaction_id || null,
    notes: p.notes || '',
    created_at: p.created_at || null
  };
}

/* ─────────────────────────────
 * Bills config writes
 * ───────────────────────────── */

async function createBill(context, body) {
  const db = context.env.DB;
  const billCols = await cols(db, 'bills');

  const name = text(body.name, '', 120);
  const amount = roundMoney(Number(body.amount || 0));
  const dueDay = nullableInt(body.due_day ?? body.day);
  const categoryId = text(body.category_id || body.category, DEFAULT_CATEGORY_ID, 80);
  const defaultAccountId = text(body.default_account_id || body.account_id, '', 80) || null;
  const notes = text(body.notes, '', 240);
  const createdBy = text(body.created_by, DEFAULT_CREATED_BY, 80);

  if (!name) {
    return json({
      ok: false,
      version: VERSION,
      error: 'name required'
    }, 400);
  }

  if (!Number.isFinite(amount) || amount < 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'amount must be >= 0'
    }, 400);
  }

  if (dueDay != null && (dueDay < 0 || dueDay > 31)) {
    return json({
      ok: false,
      version: VERSION,
      error: 'due_day must be 0-31'
    }, 400);
  }

  if (defaultAccountId) {
    const account = await resolveAccount(db, defaultAccountId);

    if (!account.ok) {
      return json(account, 409);
    }
  }

  const id = makeId('bill');

  const row = {
    id,
    name,
    amount,
    due_day: dueDay,
    frequency: body.frequency || 'monthly',
    category_id: categoryId,
    default_account_id: defaultAccountId,
    notes,
    status: 'active',
    created_by: createdBy,
    created_at: nowISO()
  };

  await insertDynamic(db, 'bills', billCols, row);

  await safeAudit(context, {
    action: 'BILL_CREATED',
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: row,
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    bill: row
  });
}

async function updateBill(context, id, body) {
  const db = context.env.DB;
  const bill = await getBill(db, id);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill not found',
      id
    }, 404);
  }

  const allowed = {};
  const map = {
    name: 'name',
    amount: 'amount',
    due_day: 'due_day',
    day: 'due_day',
    frequency: 'frequency',
    category_id: 'category_id',
    category: 'category_id',
    default_account_id: 'default_account_id',
    account_id: 'default_account_id',
    status: 'status',
    notes: 'notes'
  };

  for (const [inputKey, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(body, inputKey)) {
      allowed[column] = body[inputKey];
    }
  }

  if (allowed.amount != null) {
    allowed.amount = roundMoney(Number(allowed.amount));

    if (!Number.isFinite(allowed.amount) || allowed.amount < 0) {
      return json({
        ok: false,
        version: VERSION,
        error: 'amount must be >= 0'
      }, 400);
    }
  }

  if (allowed.due_day != null) {
    allowed.due_day = nullableInt(allowed.due_day);

    if (allowed.due_day != null && (allowed.due_day < 0 || allowed.due_day > 31)) {
      return json({
        ok: false,
        version: VERSION,
        error: 'due_day must be 0-31'
      }, 400);
    }
  }

  if (allowed.default_account_id) {
    const account = await resolveAccount(db, allowed.default_account_id);

    if (!account.ok) {
      return json(account, 409);
    }
  }

  if (!Object.keys(allowed).length) {
    return json({
      ok: false,
      version: VERSION,
      error: 'no editable fields supplied'
    }, 400);
  }

  const billCols = await cols(db, 'bills');
  await updateDynamic(db, 'bills', billCols, id, allowed);

  await safeAudit(context, {
    action: 'BILL_UPDATED',
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: allowed,
    created_by: text(body.created_by, DEFAULT_CREATED_BY, 80)
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    updated: allowed
  });
}

async function softDeleteBill(context, id) {
  const db = context.env.DB;
  const bill = await getBill(db, id);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill not found',
      id
    }, 404);
  }

  const billCols = await cols(db, 'bills');

  await updateDynamic(db, 'bills', billCols, id, {
    status: 'deleted',
    deleted_at: nowISO()
  });

  await safeAudit(context, {
    action: 'BILL_DELETED',
    entity: 'bill',
    entity_id: id,
    kind: 'mutation',
    detail: { status: 'deleted' },
    created_by: DEFAULT_CREATED_BY
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    deleted: true
  });
}

/* ─────────────────────────────
 * Pay dry-run + commit
 * ───────────────────────────── */

async function payBillDryRun(context, billId, body) {
  const validation = await validateBillPayment(context, billId, body);

  if (!validation.ok) {
    return json(validation, validation.status || 400);
  }

  return json({
    ok: true,
    version: VERSION,
    dry_run: true,
    writes_performed: false,
    payload_hash: validation.payload_hash,
    transaction_payload_hash: validation.transaction_payload_hash,
    requires_override: validation.requires_override,
    override_reason: validation.override_reason,
    override_token: validation.override_token,
    projected_bill_state: validation.projected_bill_state,
    transaction_proof: validation.transaction_proof,
    warnings: validation.warnings,
    normalized_payload: validation.normalized_payload
  });
}

async function payBillCommit(context, billId, body) {
  const validation = await validateBillPayment(context, billId, body);

  if (!validation.ok) {
    return json(validation, validation.status || 400);
  }

  const suppliedHash = text(body.payload_hash || body.dry_run_payload_hash, '', 200);

  if (!suppliedHash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'payload_hash required. Run dry-run first.'
    }, 428);
  }

  if (suppliedHash !== validation.payload_hash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'payload changed after dry-run. Run dry-run again.',
      expected: validation.payload_hash,
      supplied: suppliedHash
    }, 409);
  }

  if (validation.requires_override) {
    const suppliedOverride = text(body.override_token, '', 200);

    if (!suppliedOverride || suppliedOverride !== validation.override_token) {
      return json({
        ok: false,
        version: VERSION,
        error: 'valid override_token required',
        override_reason: validation.override_reason
      }, 428);
    }
  }

  const db = context.env.DB;
  const txCols = await cols(db, 'transactions');
  const paymentCols = await cols(db, 'bill_payments');
  const billCols = await cols(db, 'bills');

  const p = validation.normalized_payload;
  const transactionId = makeId('tx_bill');
  const paymentId = makeId('billpay');

  const txRow = {
    id: transactionId,
    date: p.paid_date,
    type: 'expense',
    amount: p.amount,
    account_id: p.account_id,
    transfer_to_account_id: null,
    category_id: p.category_id,
    notes: `Bill payment: ${p.bill_name} | bill_id=${p.bill_id} | bill_payment_id=${paymentId} | bill_month=${p.bill_month}${p.notes ? ' | notes=' + p.notes : ''}`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    pkr_amount: p.amount,
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    created_by: p.created_by,
    created_at: nowISO()
  };

  const payRow = {
    id: paymentId,
    bill_id: p.bill_id,
    bill_month: p.bill_month,
    month: p.bill_month,
    bill_name_snapshot: p.bill_name,
    expected_amount_paisa: p.expected_amount_paisa,
    amount_paisa: p.amount_paisa,
    expected_amount: paisaToMoney(p.expected_amount_paisa),
    amount: p.amount,
    account_id: p.account_id,
    category_id: p.category_id,
    paid_date: p.paid_date,
    payment_date: p.paid_date,
    transaction_id: transactionId,
    status: 'paid',
    notes: p.notes,
    dry_run_payload_hash: validation.payload_hash,
    transaction_payload_hash: validation.transaction_payload_hash,
    created_by: p.created_by,
    created_at: nowISO()
  };

  const billPatch = {
    last_paid_date: p.paid_date,
    last_paid_account_id: p.account_id,
    status: validation.projected_bill_state.remaining_paisa === 0 ? 'paid' : 'active'
  };

  await db.batch([
    buildInsert(db, 'transactions', filterToCols(txCols, txRow)),
    buildInsert(db, 'bill_payments', filterToCols(paymentCols, payRow)),
    buildUpdate(db, 'bills', billCols, p.bill_id, billPatch)
  ]);

  await safeAudit(context, {
    action: 'BILL_PAID',
    entity: 'bill',
    entity_id: p.bill_id,
    kind: 'mutation',
    detail: {
      bill_payment_id: paymentId,
      transaction_id: transactionId,
      bill_month: p.bill_month,
      amount: p.amount,
      amount_paisa: p.amount_paisa,
      account_id: p.account_id,
      category_id: p.category_id,
      payload_hash: validation.payload_hash
    },
    created_by: p.created_by
  });

  return json({
    ok: true,
    version: VERSION,
    bill_id: p.bill_id,
    bill_payment_id: paymentId,
    transaction_id: transactionId,
    projected_bill_state: validation.projected_bill_state,
    payload_hash: validation.payload_hash
  });
}

async function validateBillPayment(context, billId, body) {
  const db = context.env.DB;
  const bill = await getBill(db, billId);

  if (!bill) {
    return {
      ok: false,
      version: VERSION,
      status: 404,
      error: 'bill not found',
      bill_id: billId
    };
  }

  if (String(bill.status || 'active') === 'deleted') {
    return {
      ok: false,
      version: VERSION,
      status: 409,
      error: 'bill is deleted'
    };
  }

  const amount = roundMoney(Number(body.amount));
  const amountPaisa = moneyToPaisa(amount);

  if (!Number.isFinite(amount) || amount <= 0 || amountPaisa <= 0) {
    return {
      ok: false,
      version: VERSION,
      status: 400,
      error: 'amount must be greater than 0'
    };
  }

  const paidDate = normalizeDate(body.paid_date || body.date) || todayISO();
  const billMonth = text(body.bill_month || body.month, paidDate.slice(0, 7), 7);
  const accountId = text(body.account_id || bill.default_account_id || bill.account_id, '', 80);
  const categoryId = text(body.category_id || bill.category_id, DEFAULT_CATEGORY_ID, 80);
  const notes = text(body.notes, '', 220);
  const createdBy = text(body.created_by, DEFAULT_CREATED_BY, 80);

  if (!accountId) {
    return {
      ok: false,
      version: VERSION,
      status: 400,
      error: 'account_id required'
    };
  }

  const account = await resolveAccount(db, accountId);

  if (!account.ok) {
    return {
      ...account,
      version: VERSION,
      status: account.status || 409
    };
  }

  const expectedPaisa = moneyToPaisa(bill.amount || 0);
  const cycle = await getBillCycle(db, bill.id, billMonth, expectedPaisa);

  const remainingBefore = Number(cycle.remaining_paisa || 0);

  if (amountPaisa > remainingBefore && remainingBefore > 0 && body.allow_overpay !== true) {
    return {
      ok: false,
      version: VERSION,
      status: 409,
      error: 'payment exceeds remaining bill amount',
      remaining: paisaToMoney(remainingBefore),
      attempted: amount
    };
  }

  const balanceProof = await buildBalanceProof(db, account.account, amountPaisa);

  const warnings = [];
  const duplicate = await duplicatePaymentWarning(db, bill.id, billMonth, amountPaisa);

  if (duplicate.status === 'warn') {
    warnings.push(duplicate);
  }

  const normalized = {
    bill_id: bill.id,
    bill_name: bill.name,
    bill_month: billMonth,
    expected_amount_paisa: expectedPaisa,
    amount,
    amount_paisa: amountPaisa,
    account_id: account.account.id,
    category_id: categoryId,
    paid_date: paidDate,
    notes,
    created_by: createdBy
  };

  const projectedPaidPaisa = Number(cycle.paid_total_paisa || 0) + amountPaisa;
  const projectedRemaining = Math.max(0, expectedPaisa - projectedPaidPaisa);

  const projectedBillState = {
    bill_month: billMonth,
    expected_amount: paisaToMoney(expectedPaisa),
    expected_amount_paisa: expectedPaisa,
    paid_total_after: paisaToMoney(projectedPaidPaisa),
    paid_total_after_paisa: projectedPaidPaisa,
    remaining: paisaToMoney(projectedRemaining),
    remaining_paisa: projectedRemaining,
    payment_status: projectedRemaining === 0 ? 'paid' : 'partial'
  };

  const transactionPayload = {
    route: 'bills.pay.transaction',
    type: 'expense',
    amount,
    account_id: account.account.id,
    category_id: categoryId,
    date: paidDate,
    bill_id: bill.id,
    bill_month: billMonth
  };

  const transactionHash = await hash(transactionPayload);

  const payloadHash = await hash({
    route: 'bills.pay',
    normalized
  });

  const requiresOverride = balanceProof.requires_override === true;
  const overrideReason = requiresOverride ? balanceProof.override_reason : null;
  const overrideToken = requiresOverride
    ? await hash({
      route: 'bills.pay.override',
      reason: overrideReason,
      normalized
    })
    : null;

  return {
    ok: true,
    normalized_payload: normalized,
    payload_hash: payloadHash,
    transaction_payload_hash: transactionHash,
    requires_override: requiresOverride,
    override_reason: overrideReason,
    override_token: overrideToken,
    projected_bill_state: projectedBillState,
    transaction_proof: {
      action: 'bill_payment',
      writes_performed: false,
      expected_writes: {
        transactions: 1,
        bill_payments: 1,
        bills_update: 1,
        audit: 1
      },
      balance_projection: balanceProof,
      duplicate_payment: duplicate
    },
    warnings
  };
}

/* ─────────────────────────────
 * Reverse payment
 * ───────────────────────────── */

async function reversePayment(context, paymentId, body) {
  const db = context.env.DB;
  const reason = text(body.reason, '', 500);
  const createdBy = text(body.created_by, DEFAULT_CREATED_BY, 80);

  if (!reason) {
    return json({
      ok: false,
      version: VERSION,
      error: 'reason required'
    }, 400);
  }

  const payment = await db.prepare(
    `SELECT *
     FROM bill_payments
     WHERE id = ?
     LIMIT 1`
  ).bind(paymentId).first();

  if (!payment) {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill payment not found',
      payment_id: paymentId
    }, 404);
  }

  if (String(payment.status || 'paid') === 'reversed') {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill payment already reversed',
      payment_id: paymentId
    }, 409);
  }

  const txCols = await cols(db, 'transactions');
  const paymentCols = await cols(db, 'bill_payments');
  const originalTxn = await getTransaction(db, txCols, payment.transaction_id);

  if (!originalTxn) {
    return json({
      ok: false,
      version: VERSION,
      error: 'linked ledger transaction not found',
      transaction_id: payment.transaction_id
    }, 409);
  }

  if (isReversed(originalTxn)) {
    return json({
      ok: false,
      version: VERSION,
      error: 'linked ledger transaction already reversed',
      transaction_id: payment.transaction_id
    }, 409);
  }

  const reversalId = makeId('rev_bill');

  const reversalRow = {
    id: reversalId,
    date: todayISO(),
    type: 'income',
    amount: Math.abs(Number(originalTxn.amount || payment.amount || 0)),
    account_id: originalTxn.account_id,
    transfer_to_account_id: null,
    category_id: originalTxn.category_id || payment.category_id || DEFAULT_CATEGORY_ID,
    notes: `[REVERSAL OF ${originalTxn.id}] Bill payment reversal: ${payment.bill_name_snapshot || payment.bill_id} | bill_payment_id=${payment.id} | reason=${reason}`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    pkr_amount: Math.abs(Number(originalTxn.pkr_amount || originalTxn.amount || payment.amount || 0)),
    fx_rate_at_commit: 1,
    fx_source: 'bill-reversal',
    linked_txn_id: originalTxn.id,
    created_by: createdBy,
    created_at: nowISO()
  };

  await db.batch([
    buildInsert(db, 'transactions', filterToCols(txCols, reversalRow)),
    buildMarkTxnReversed(db, txCols, originalTxn.id, reversalId, reason),
    buildUpdate(db, 'bill_payments', paymentCols, payment.id, {
      status: 'reversed',
      reversed_at: nowISO(),
      reversal_transaction_id: reversalId,
      reason
    })
  ]);

  await safeAudit(context, {
    action: 'BILL_PAYMENT_REVERSED',
    entity: 'bill_payment',
    entity_id: payment.id,
    kind: 'mutation',
    detail: {
      bill_id: payment.bill_id,
      transaction_id: originalTxn.id,
      reversal_transaction_id: reversalId,
      reason
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    bill_payment_id: payment.id,
    original_transaction_id: originalTxn.id,
    reversal_transaction_id: reversalId,
    status: 'reversed'
  });
}

/* ─────────────────────────────
 * Defer
 * ───────────────────────────── */

async function deferBill(context, billId, body) {
  const db = context.env.DB;
  const bill = await getBill(db, billId);

  if (!bill) {
    return json({
      ok: false,
      version: VERSION,
      error: 'bill not found',
      bill_id: billId
    }, 404);
  }

  const newDueDate = normalizeDate(body.new_due_date || body.due_date);
  const reason = text(body.reason || body.notes, '', 300);
  const createdBy = text(body.created_by, DEFAULT_CREATED_BY, 80);

  if (!newDueDate) {
    return json({
      ok: false,
      version: VERSION,
      error: 'new_due_date required'
    }, 400);
  }

  const billCols = await cols(db, 'bills');

  await updateDynamic(db, 'bills', billCols, bill.id, {
    deferred_until: newDueDate,
    defer_reason: reason,
    status: 'deferred'
  });

  await safeAudit(context, {
    action: 'BILL_DEFERRED',
    entity: 'bill',
    entity_id: bill.id,
    kind: 'mutation',
    detail: {
      new_due_date: newDueDate,
      reason
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    bill_id: bill.id,
    deferred_until: newDueDate
  });
}

/* ─────────────────────────────
 * Health
 * ───────────────────────────── */

async function getHealth(context) {
  const db = context.env.DB;
  const txCols = await cols(db, 'transactions');

  const payments = await db.prepare(
    `SELECT *
     FROM bill_payments
     ORDER BY datetime(created_at) DESC, id DESC
     LIMIT 5000`
  ).all();

  const rows = payments.results || [];

  const orphanPayments = [];
  const reversedTxnActivePayment = [];
  const reversedPaymentsMissingReversal = [];
  const amountMismatches = [];

  for (const p of rows) {
    const tx = await getTransaction(db, txCols, p.transaction_id);

    if (!tx) {
      orphanPayments.push(p.id);
      continue;
    }

    const paymentPaisa = Number(p.amount_paisa || moneyToPaisa(p.amount || 0));
    const txPaisa = moneyToPaisa(tx.amount || 0);

    if (Math.abs(paymentPaisa - txPaisa) > BALANCE_TOLERANCE_PAISA) {
      amountMismatches.push({
        bill_payment_id: p.id,
        transaction_id: tx.id,
        payment_paisa: paymentPaisa,
        transaction_paisa: txPaisa
      });
    }

    if (isReversed(tx) && String(p.status || 'paid') === 'paid') {
      reversedTxnActivePayment.push({
        bill_payment_id: p.id,
        transaction_id: tx.id
      });
    }

    if (String(p.status || '') === 'reversed' && !p.reversal_transaction_id) {
      reversedPaymentsMissingReversal.push(p.id);
    }
  }

  const duplicateRows = await db.prepare(
    `SELECT bill_id, bill_month, amount_paisa, COUNT(*) AS c
     FROM bill_payments
     WHERE status = 'paid'
     GROUP BY bill_id, bill_month, amount_paisa
     HAVING COUNT(*) > 1`
  ).all();

  const status =
    orphanPayments.length ||
    reversedTxnActivePayment.length ||
    reversedPaymentsMissingReversal.length ||
    amountMismatches.length
      ? 'warn'
      : 'pass';

  return json({
    ok: true,
    version: VERSION,
    health: {
      status,
      payment_count: rows.length,
      orphan_payments_without_transaction: orphanPayments,
      payments_with_reversed_transaction_but_active_payment: reversedTxnActivePayment,
      reversed_payments_without_reversal_transaction: reversedPaymentsMissingReversal,
      duplicate_payments_same_month: duplicateRows.results || [],
      payment_amount_mismatches: amountMismatches
    }
  });
}

/* ─────────────────────────────
 * Helpers
 * ───────────────────────────── */

async function getBill(db, id) {
  return db.prepare(
    `SELECT *
     FROM bills
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

async function getTransaction(db, txCols, id) {
  const select = [
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
  ].filter(c => txCols.has(c));

  if (!select.length) return null;

  return db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

async function resolveAccount(db, accountId) {
  const row = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?
       AND ${ACTIVE_ACCOUNT_CONDITION}
     LIMIT 1`
  ).bind(accountId).first();

  if (!row) {
    return {
      ok: false,
      status: 409,
      error: 'account not found or inactive',
      account_id: accountId
    };
  }

  return {
    ok: true,
    account: row
  };
}

async function buildBalanceProof(db, account, amountPaisa) {
  const balance = await computeAccountBalancePaisa(db, account.id);
  const projected = balance - amountPaisa;

  const proof = {
    check: 'bill_payment_balance_projection',
    account_id: account.id,
    current_balance: paisaToMoney(balance),
    current_balance_paisa: balance,
    payment_amount: paisaToMoney(amountPaisa),
    payment_amount_paisa: amountPaisa,
    projected_balance: paisaToMoney(projected),
    projected_balance_paisa: projected,
    requires_override: false,
    override_reason: null,
    status: 'pass'
  };

  const kind = classifyAccount(account);

  if (kind === 'asset' && projected < -BALANCE_TOLERANCE_PAISA) {
    proof.status = 'blocked';
    proof.requires_override = true;
    proof.override_reason = 'asset_overdraft';
  }

  return proof;
}

async function computeAccountBalancePaisa(db, accountId) {
  const rows = await db.prepare(
    `SELECT type, amount, notes, reversed_by, reversed_at
     FROM transactions
     WHERE account_id = ?`
  ).bind(accountId).all();

  let balance = 0;

  for (const row of rows.results || []) {
    if (isReversal(row)) continue;

    const amount = moneyToPaisa(row.amount || 0);
    const type = String(row.type || '').toLowerCase();

    if (['income', 'borrow', 'salary', 'opening', 'debt_in'].includes(type)) {
      balance += amount;
    } else {
      balance -= amount;
    }
  }

  return balance;
}

async function duplicatePaymentWarning(db, billId, billMonth, amountPaisa) {
  const rows = await db.prepare(
    `SELECT id
     FROM bill_payments
     WHERE bill_id = ?
       AND bill_month = ?
       AND amount_paisa = ?
       AND status = 'paid'
     LIMIT 5`
  ).bind(billId, billMonth, amountPaisa).all();

  const matches = rows.results || [];

  if (!matches.length) {
    return {
      check: 'duplicate_payment',
      status: 'pass',
      detail: 'No same bill/month/amount active payment found.'
    };
  }

  return {
    check: 'duplicate_payment',
    status: 'warn',
    possible_duplicate_payment_ids: matches.map(r => r.id),
    detail: 'Possible duplicate bill payment.'
  };
}

function classifyAccount(account) {
  const textValue = [
    account.kind,
    account.type,
    account.account_type,
    account.name,
    account.id
  ].map(v => String(v || '').toLowerCase()).join(' ');

  if (
    textValue.includes('credit') ||
    textValue.includes('liability') ||
    textValue.includes('cc')
  ) {
    return 'liability';
  }

  return 'asset';
}

function isReversal(row) {
  const notes = String(row.notes || '').toUpperCase();
  return notes.includes('[REVERSAL OF ');
}

function isReversed(row) {
  const notes = String(row.notes || '').toUpperCase();
  return !!(row.reversed_by || row.reversed_at || notes.includes('[REVERSED BY '));
}

function buildMarkTxnReversed(db, txCols, id, reversalId, reason) {
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

  values.push(id);

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
    if (colSet.has(key)) out[key] = value;
  }

  return out;
}

async function insertDynamic(db, table, colSet, row) {
  return buildInsert(db, table, filterToCols(colSet, row)).run();
}

function buildInsert(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('no insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(k => row[k]));
}

async function updateDynamic(db, table, colSet, id, patch) {
  return buildUpdate(db, table, colSet, id, patch).run();
}

function buildUpdate(db, table, colSet, id, patch) {
  const keys = Object.keys(patch).filter(k => colSet.has(k));

  if (!keys.length) {
    return db.prepare(`SELECT 1`).bind();
  }

  return db.prepare(
    `UPDATE ${table}
     SET ${keys.map(k => `${k} = ?`).join(', ')}
     WHERE id = ?`
  ).bind(...keys.map(k => patch[k]), id);
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

function getPathParts(context) {
  const raw = context.params && context.params.path;

  if (Array.isArray(raw)) {
    return raw.map(String).filter(Boolean);
  }

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
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

function currentBillMonth() {
  return todayISO().slice(0, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeDate(value) {
  const raw = text(value, '', 40);

  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;

  return raw.slice(0, 10);
}

function nullableInt(value) {
  if (value === null || value === undefined || value === '') return null;

  const n = Number(value);

  if (!Number.isFinite(n)) return null;

  return Math.floor(n);
}

function text(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function hash(value) {
  const canonical = JSON.stringify(sortKeys(value));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);

  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }

  return value;
}