/* Sovereign Finance Debts API
 * /api/debts
 * v0.9.0-debts-contract-owner
 *
 * Contract:
 * - Canonical Debts write owner.
 * - GET is read-only. No auto-settle/normalization writes during list.
 * - POST /api/debts action=create creates debt rows.
 * - POST /api/debts action=payment records debt payments/receives.
 * - POST /api/debts action=repair_ledger explicitly creates missing origin rows.
 * - POST /api/debts action=repair_reversed_payments explicitly repairs reversed debt payments.
 * - POST /api/debts action=repair_settled_debts explicitly normalizes fully paid/terminal debts.
 * - PUT /api/debts/:id is schedule/status/notes only. No money movement.
 * - Reversal remains canonical at /api/transactions/reverse.
 */

const VERSION = 'v0.9.0-debts-contract-owner';
const CONTRACT_VERSION = 'debts-v1';

const DEFAULT_CATEGORY_ID = 'debt_payment';
const DUE_SOON_DAYS = 3;
const CANONICAL_TERMINAL = 'settled';

const TERMINAL_STATUSES = new Set([
  'settled',
  'archived',
  'closed',
  'deleted',
  'paid',
  'finished',
  'completed',
  'done'
]);

const DEBT_COLUMNS_BASE = [
  'id',
  'name',
  'kind',
  'original_amount',
  'paid_amount',
  'snowball_order',
  'due_date',
  'due_day',
  'installment_amount',
  'frequency',
  'last_paid_date',
  'status',
  'notes',
  'created_at',
  'updated_at',
  'settled_at'
];

const TRANSACTION_COLUMNS_BASE = [
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
  'idempotency_key',
  'created_by',
  'created_at',
  'updated_at'
];

export async function onRequestGet(context) {
  return withJsonErrors('GET', async () => {
    const db = requireDb(context);
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = cleanText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (path[0] === 'health' || action === 'health') {
      return health(db);
    }

    if (action === 'payment_check' || action === 'payment-check') {
      return paymentCheck(db, {
        debt_id: url.searchParams.get('debt_id'),
        account_id: url.searchParams.get('account_id'),
        amount: url.searchParams.get('amount'),
        date: url.searchParams.get('date')
      });
    }

    if (path.length === 1) {
      return getDebtById(db, path[0]);
    }

    if (path.length > 1) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'Unsupported GET subroute.',
        path
      }, 404);
    }

    return listDebts(db, url);
  });
}

export async function onRequestPost(context) {
  return withJsonErrors('POST', async () => {
    const db = requireDb(context);
    const url = new URL(context.request.url);
    const path = getPath(context);
    const body = await readJSON(context.request);
    const action = cleanText(body.action || url.searchParams.get('action') || 'create', 'create', 80).toLowerCase();
    const dryRun = isDryRun(url, body);

    if (path.length > 0) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'Unsupported POST subroute. Use canonical POST /api/debts with an action.',
        path,
        canonical_route: '/api/debts',
        supported_actions: [
          'create',
          'payment',
          'payment_check',
          'repair_ledger',
          'repair_reversed_payments',
          'repair_settled_debts'
        ],
        stale_route_policy: {
          payment: 'POST /api/debts action=payment',
          receive: 'POST /api/debts action=payment',
          reverse: 'POST /api/transactions/reverse'
        }
      }, 404);
    }

    if (action === 'payment' || action === 'pay' || action === 'record_payment' || action === 'receive') {
      return recordDebtPayment(db, body, dryRun);
    }

    if (action === 'payment_check' || action === 'payment-check') {
      return paymentCheck(db, body);
    }

    if (action === 'repair_ledger' || action === 'repair-ledger' || action === 'repair_origin') {
      return repairLedgerOrigin(db, body, dryRun);
    }

    if (action === 'repair_reversed_payments' || action === 'repair-reversed-payments') {
      return repairReversedPayments(db, body, dryRun);
    }

    if (action === 'repair_settled_debts' || action === 'repair-settled-debts') {
      return repairSettledDebts(db, body, dryRun);
    }

    return createDebt(db, body, dryRun);
  });
}

export async function onRequestPut(context) {
  return withJsonErrors('PUT', async () => {
    const db = requireDb(context);
    const path = getPath(context);
    const debtId = cleanText(path[0], '', 200);
    const body = await readJSON(context.request);

    if (!debtId) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_update',
        error: 'debt id required',
        code: 'DEBT_ID_REQUIRED'
      }, 400);
    }

    return updateDebtSchedule(db, debtId, body);
  });
}

/* ─────────────────────────────
 * List / Read / Health
 * ───────────────────────────── */

async function listDebts(db, url) {
  const includeInactive = url.searchParams.get('include_inactive') === '1';
  const debtCols = await tableColumns(db, 'debts');

  if (!debtCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'debts table missing id column',
      code: 'DEBTS_SCHEMA_INVALID'
    }, 500);
  }

  const select = selectDebtColumns(debtCols);
  const rows = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM debts
     ORDER BY ${buildDebtOrderBy(debtCols)}`
  ).all();

  const rawRows = rows.results || [];
  const normalized = rawRows.map(normalizeDebt);
  const visible = includeInactive
    ? normalized
    : normalized.filter(debt => !isTerminalStatus(debt.status));

  const debts = [];

  for (const debt of visible) {
    debts.push(await decorateDebt(db, debt));
  }

  const totals = summarizeDebts(debts);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debts.list',
    read_only: true,
    writes_performed: false,
    include_inactive: includeInactive,
    count: debts.length,
    totals,
    total_owe: totals.total_owe,
    total_owed: totals.total_owed,
    schedule_missing_count: totals.schedule_missing_count,
    due_soon_count: totals.due_soon_count,
    overdue_count: totals.overdue_count,
    origin_linked_count: totals.origin_linked_count,
    legacy_unknown_count: totals.legacy_unknown_count,
    payment_linked_only_count: totals.payment_linked_only_count,
    repair_required_count: totals.repair_required_count,
    repair_required_debt_ids: totals.repair_required_debt_ids,
    contract: {
      debt_table_is_not_money_truth: true,
      get_is_read_only: true,
      root_route_payment_post_supported: true,
      root_route_payment_check_supported: true,
      payment_subroutes_retired: true,
      debt_payments_snapshot_insert_supported: true,
      owe_payment_type: 'expense',
      owed_payment_type: 'income',
      owe_origin_type: 'income',
      owed_origin_type: 'expense',
      terminal_statuses: Array.from(TERMINAL_STATUSES),
      canonical_terminal_status: CANONICAL_TERMINAL,
      canonical_reversal_route: '/api/transactions/reverse'
    },
    debts
  });
}

async function getDebtById(db, debtId) {
  const row = await findDebtById(db, debtId);

  if (!row) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt.read',
      error: 'Debt not found.',
      code: 'DEBT_NOT_FOUND',
      debt_id: debtId
    }, 404);
  }

  const debt = await decorateDebt(db, normalizeDebt(row));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt.read',
    debt
  });
}

async function health(db) {
  const debtCols = await tableColumns(db, 'debts');

  if (!debtCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt.health',
      error: 'debts table missing id column',
      code: 'DEBTS_SCHEMA_INVALID'
    }, 500);
  }

  const select = selectDebtColumns(debtCols);
  const debtRows = (await db.prepare(
    `SELECT ${select.join(', ')}
     FROM debts
     ORDER BY ${buildDebtOrderBy(debtCols)}`
  ).all()).results || [];

  const debts = [];
  for (const row of debtRows) {
    debts.push(await decorateDebt(db, normalizeDebt(row)));
  }

  const payments = await loadDebtPayments(db);
  const txCols = await tableColumns(db, 'transactions');

  const amountErrors = [];
  const fullyPaidActive = [];
  const terminalDebts = [];
  const activeDebts = [];
  const orphanOriginTransactions = [];
  const orphanPaymentTransactions = [];
  const reversedPaymentMismatches = [];

  for (const debt of debts) {
    if (debt.original_amount <= 0) {
      amountErrors.push({
        debt_id: debt.id,
        code: 'DEBT_ORIGINAL_AMOUNT_INVALID',
        original_amount: debt.original_amount
      });
    }

    if (debt.paid_amount < 0) {
      amountErrors.push({
        debt_id: debt.id,
        code: 'DEBT_PAID_AMOUNT_NEGATIVE',
        paid_amount: debt.paid_amount
      });
    }

    if (debt.paid_amount > debt.original_amount + 0.01) {
      amountErrors.push({
        debt_id: debt.id,
        code: 'DEBT_PAID_EXCEEDS_ORIGINAL',
        original_amount: debt.original_amount,
        paid_amount: debt.paid_amount
      });
    }

    if (isTerminalStatus(debt.status)) {
      terminalDebts.push(debt);
    } else {
      activeDebts.push(debt);
    }

    if (!isTerminalStatus(debt.status) && debt.original_amount > 0 && debt.paid_amount >= debt.original_amount) {
      fullyPaidActive.push({
        debt_id: debt.id,
        name: debt.name,
        original_amount: debt.original_amount,
        paid_amount: debt.paid_amount,
        status: debt.status
      });
    }

    if (debt.repair_required) {
      orphanOriginTransactions.push({
        debt_id: debt.id,
        name: debt.name,
        kind: debt.kind,
        origin_state: debt.origin_state
      });
    }
  }

  for (const payment of payments) {
    if (!payment.transaction_id) {
      orphanPaymentTransactions.push({
        debt_payment_id: payment.id,
        debt_id: payment.debt_id,
        code: 'DEBT_PAYMENT_TRANSACTION_ID_MISSING'
      });
      continue;
    }

    const tx = await findTransactionById(db, txCols, payment.transaction_id);

    if (!tx) {
      orphanPaymentTransactions.push({
        debt_payment_id: payment.id,
        debt_id: payment.debt_id,
        transaction_id: payment.transaction_id,
        code: 'DEBT_PAYMENT_TRANSACTION_MISSING'
      });
      continue;
    }

    const paymentStatus = String(payment.status || 'paid').toLowerCase();
    const txReversed = isReversedTransaction(tx);

    if ((paymentStatus === 'paid' || paymentStatus === 'active' || paymentStatus === '') && txReversed) {
      reversedPaymentMismatches.push({
        debt_payment_id: payment.id,
        debt_id: payment.debt_id,
        transaction_id: payment.transaction_id,
        code: 'ACTIVE_PAYMENT_LINKED_TO_REVERSED_TRANSACTION'
      });
    }
  }

  const totals = summarizeDebts(activeDebts);
  const warnings = [];
  const critical = [];

  if (fullyPaidActive.length) {
    warnings.push({
      code: 'FULLY_PAID_ACTIVE_DEBTS',
      count: fullyPaidActive.length,
      repair_action: 'POST /api/debts action=repair_settled_debts'
    });
  }

  if (orphanOriginTransactions.length) {
    warnings.push({
      code: 'DEBT_ORIGIN_REPAIR_REQUIRED',
      count: orphanOriginTransactions.length
    });
  }

  if (reversedPaymentMismatches.length) {
    critical.push({
      code: 'REVERSED_PAYMENT_MISMATCH',
      count: reversedPaymentMismatches.length,
      repair_action: 'POST /api/debts action=repair_reversed_payments'
    });
  }

  if (amountErrors.length) {
    critical.push({
      code: 'DEBT_AMOUNT_ERRORS',
      count: amountErrors.length
    });
  }

  const status = critical.length ? 'fail' : (warnings.length ? 'warn' : 'pass');

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt.health',
    status,
    checks: {
      amounts_valid: amountErrors.length === 0,
      terminal_filter_valid: true,
      payments_linked_to_ledger: orphanPaymentTransactions.length === 0,
      origins_linked_to_ledger: orphanOriginTransactions.length === 0,
      reversal_repairs_valid: reversedPaymentMismatches.length === 0,
      forecast_totals_match: true
    },
    counts: {
      total_debts: debts.length,
      active_debts: activeDebts.length,
      terminal_debts: terminalDebts.length,
      fully_paid_active_debts: fullyPaidActive.length,
      orphan_payment_transactions: orphanPaymentTransactions.length,
      orphan_origin_transactions: orphanOriginTransactions.length,
      reversal_mismatches: reversedPaymentMismatches.length
    },
    totals: {
      payable_remaining: totals.total_owe,
      receivable_remaining: totals.total_owed
    },
    details: {
      amount_errors: amountErrors,
      fully_paid_active: fullyPaidActive,
      orphan_payment_transactions: orphanPaymentTransactions,
      orphan_origin_transactions: orphanOriginTransactions,
      reversed_payment_mismatches: reversedPaymentMismatches
    },
    warnings,
    critical_errors: critical,
    policy: {
      get_is_read_only: true,
      canonical_payment_route: 'POST /api/debts action=payment',
      canonical_reversal_route: '/api/transactions/reverse',
      repair_settled_route: 'POST /api/debts action=repair_settled_debts',
      repair_reversed_payments_route: 'POST /api/debts action=repair_reversed_payments'
    }
  });
}

/* ─────────────────────────────
 * Create Debt
 * ───────────────────────────── */

async function createDebt(db, body, dryRun) {
  const now = nowISO();
  const id = cleanText(body.id, '', 160) || makeId('debt');
  const name = cleanText(body.name || body.title || body.label, '', 160);
  const kind = normalizeKind(body.kind || body.direction || 'owed');
  const originalAmount = moneyNumber(body.original_amount ?? body.amount, null);
  const paidAmount = moneyNumber(body.paid_amount, 0);
  const dueDate = normalizeDate(body.due_date || body.next_due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const installmentAmount = normalizeNullableMoney(body.installment_amount || body.monthly_payment);
  const frequency = normalizeFrequency(body.frequency || 'monthly');
  const lastPaidDate = normalizeDate(body.last_paid_date);
  const movementNow = parseMovementNow(body);
  const accountId = cleanText(
    body.account_id ||
      body.source_account_id ||
      body.from_account_id ||
      body.destination_account_id ||
      body.to_account_id,
    '',
    160
  );
  const movementDate = normalizeDate(body.movement_date || body.date) || todayISO();
  const notes = cleanText(body.notes, '', 1000);
  const createdBy = cleanText(body.created_by, 'web-debts', 120) || 'web-debts';
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id, '', 220) || null;

  const validationErrors = [];

  if (!name) validationErrors.push('name required');
  if (!kind) validationErrors.push('kind must be owe or owed');
  if (originalAmount == null || originalAmount <= 0) validationErrors.push('original_amount must be greater than 0');
  if (paidAmount == null || paidAmount < 0) validationErrors.push('paid_amount must be 0 or greater');
  if (paidAmount != null && originalAmount != null && paidAmount > originalAmount) validationErrors.push('paid_amount cannot exceed original_amount');
  if (movementNow && !accountId) validationErrors.push(kind === 'owed'
    ? 'source account_id required for owed-to-me money movement'
    : 'destination account_id required for i-owe money movement');

  if (validationErrors.length) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_create',
      error: validationErrors.join(' · '),
      code: 'VALIDATION_FAILED',
      committed: false,
      warnings: []
    }, 400);
  }

  const existingDebt = await findDebtById(db, id);

  if (existingDebt) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_create',
      error: 'Debt id already exists.',
      code: 'DEBT_ID_CONFLICT',
      debt_id: id,
      committed: false
    }, 409);
  }

  let account = null;

  if (movementNow) {
    const accountResult = await resolveAccount(db, accountId);

    if (!accountResult.ok) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'debt_create',
        error: accountResult.error,
        code: accountResult.code || 'ACCOUNT_NOT_FOUND',
        account_diagnostics: accountResult.diagnostics || null,
        committed: false
      }, accountResult.status || 409);
    }

    account = accountResult.account;
  }

  const status = paidAmount >= originalAmount ? CANONICAL_TERMINAL : 'active';

  const debtRow = {
    id,
    name,
    kind,
    original_amount: round2(originalAmount),
    paid_amount: round2(paidAmount),
    snowball_order: body.snowball_order == null || body.snowball_order === '' ? null : Number(body.snowball_order),
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency: frequency || 'monthly',
    last_paid_date: lastPaidDate,
    status,
    notes: buildDebtNotes(notes, {
      movement_now: movementNow,
      account_id: account ? account.id : null,
      created_by: createdBy
    }),
    created_at: now,
    updated_at: now,
    settled_at: status === CANONICAL_TERMINAL ? now : null
  };

  const originTx = movementNow
    ? buildOriginTransaction({
      debt: debtRow,
      account,
      date: movementDate,
      created_by: createdBy,
      idempotency_key: idempotencyKey
    })
    : null;

  const normalizedDebt = normalizeDebt(debtRow);
  const proof = {
    action: 'debt_create',
    contract_version: CONTRACT_VERSION,
    dry_run: Boolean(dryRun),
    writes_performed: false,
    write_model: originTx ? 'atomic_debt_row_plus_origin_ledger' : 'debt_record_only_no_money_moved',
    expected_debt_rows: 1,
    expected_origin_ledger_rows: originTx ? 1 : 0,
    debt: {
      id,
      kind,
      original_amount: normalizedDebt.original_amount,
      paid_amount: normalizedDebt.paid_amount,
      remaining_amount: normalizedDebt.remaining_amount,
      status
    },
    ledger: originTx
      ? ledgerProofFromTransaction(originTx, 'origin')
      : {
        created: false,
        transaction_id: null,
        account_delta: 0,
        marker: null
      },
    account: {
      balance_source: 'ledger',
      impacted: !!originTx,
      account_id: originTx ? originTx.account_id : null,
      account_delta: originTx ? transactionDelta(originTx.type, originTx.amount) : 0
    },
    forecast: {
      should_reflect: true,
      debt_bucket: kind === 'owe' ? 'payable' : 'receivable'
    }
  };

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_create',
      dry_run: true,
      writes_performed: false,
      debt_row: debtRow,
      origin_transaction: originTx,
      proof,
      warnings: []
    });
  }

  const debtCols = await tableColumns(db, 'debts');
  const statements = [insertStatement(db, 'debts', filterToColumns(debtCols, debtRow))];

  if (originTx) {
    const txCols = await tableColumns(db, 'transactions');
    statements.push(insertStatement(db, 'transactions', filterToColumns(txCols, originTx)));
  }

  await db.batch(statements);

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, id)));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_create',
    committed: true,
    writes_performed: true,
    id,
    origin_transaction_id: originTx ? originTx.id : null,
    debt: after,
    ledger: proof.ledger,
    account: proof.account,
    forecast: proof.forecast,
    proof: {
      ...proof,
      writes_performed: true
    },
    warnings: []
  });
}

function buildOriginTransaction({ debt, account, date, created_by, idempotency_key }) {
  const type = debt.kind === 'owed' ? 'expense' : 'income';
  const marker = '[DEBT_ORIGIN]';
  const sourceAction = debt.kind === 'owed' ? 'origin_lent_out' : 'origin_borrowed_in';

  return {
    id: makeId(type === 'expense' ? 'tx_debt_origin_out' : 'tx_debt_origin_in'),
    date,
    type,
    amount: round2(debt.original_amount),
    account_id: account.id,
    transfer_to_account_id: null,
    linked_txn_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant_id: null,
    merchant: debt.name,
    notes: cleanText(
      `${type === 'expense' ? 'Debt given' : 'Debt received'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | ${marker}`,
      '',
      240
    ),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    pkr_amount: round2(debt.original_amount),
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    intl_package_id: null,
    reversed_by: null,
    reversed_at: null,
    source_module: 'debts',
    source_id: debt.id,
    source_action: sourceAction,
    idempotency_key: idempotency_key ? `${idempotency_key}:origin` : null,
    created_by,
    created_at: nowISO(),
    updated_at: nowISO()
  };
}

/* ─────────────────────────────
 * Payment
 * ───────────────────────────── */

async function paymentCheck(db, input) {
  const check = await buildPaymentPlan(db, input, true);

  if (!check.ok) {
    return json(check, check.status || 400);
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_payment_check',
    dry_run: true,
    writes_performed: false,
    ...check.response
  });
}

async function recordDebtPayment(db, body, dryRun) {
  const plan = await buildPaymentPlan(db, body, dryRun);

  if (!plan.ok) {
    return json(plan, plan.status || 400);
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_payment',
      dry_run: true,
      writes_performed: false,
      ...plan.response
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  const paymentCols = await tableColumns(db, 'debt_payments');
  const debtCols = await tableColumns(db, 'debts');

  const statements = [
    insertStatement(db, 'transactions', filterToColumns(txCols, plan.transaction))
  ];

  const debtPatch = {
    paid_amount: plan.projected_debt.paid_amount,
    status: plan.projected_debt.status,
    last_paid_date: plan.normalized.date,
    updated_at: nowISO(),
    settled_at: plan.projected_debt.status === CANONICAL_TERMINAL ? nowISO() : null
  };

  statements.push(updateStatement(db, 'debts', debtCols, debtPatch, 'TRIM(id) = TRIM(?)', [plan.normalized.debt_id]));

  if (paymentCols.size > 0 && paymentCols.has('id')) {
    statements.push(insertStatement(db, 'debt_payments', filterToColumns(paymentCols, plan.payment_row)));
  }

  await db.batch(statements);

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, plan.normalized.debt_id)));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_payment',
    committed: true,
    writes_performed: true,
    debt_id: plan.normalized.debt_id,
    payment_id: plan.payment_row.id,
    payment_transaction_id: plan.transaction.id,
    transaction_id: plan.transaction.id,
    debt: after,
    ledger: plan.response.ledger,
    payment: {
      created: true,
      payment_id: plan.payment_row.id
    },
    account: plan.response.account,
    forecast: plan.response.forecast,
    proof: {
      ...plan.response.proof,
      writes_performed: true
    },
    warnings: plan.response.warnings
  });
}

async function buildPaymentPlan(db, input, dryRun) {
  const debtId = cleanText(input.debt_id || input.id || input.debtId || input.debtID, '', 200);
  const accountId = cleanText(input.account_id, '', 160);
  const amount = moneyNumber(input.amount, null);
  const date = normalizeDate(input.date || input.paid_at || input.payment_date) || todayISO();
  const createdBy = cleanText(input.created_by, 'web-debts-payment', 120) || 'web-debts-payment';
  const userNotes = cleanText(input.notes, '', 500);
  const idempotencyKey = cleanText(input.idempotency_key || input.client_payment_id || input.payment_id, '', 220) || null;

  if (!debtId) {
    return errorResult('DEBT_ID_REQUIRED', 'debt_id required', 400);
  }

  if (!accountId) {
    return errorResult('ACCOUNT_REQUIRED', 'account_id required', 400, { received_debt_id: debtId });
  }

  if (amount == null || amount <= 0) {
    return errorResult('INVALID_AMOUNT', 'amount must be greater than 0', 400, { received_debt_id: debtId });
  }

  const debtRow = await findDebtById(db, debtId);

  if (!debtRow) {
    return errorResult('DEBT_NOT_FOUND', `Debt not found for received_debt_id="${debtId}"`, 404, {
      received_debt_id: debtId,
      diagnostics: await debtLookupDiagnostics(db, debtId, input)
    });
  }

  const debt = normalizeDebt(debtRow);

  if (isTerminalStatus(debt.status)) {
    return errorResult('DEBT_TERMINAL', 'Terminal debts cannot record payments unless reopened explicitly.', 409, {
      debt_id: debt.id,
      status: debt.status
    });
  }

  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return {
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_payment',
      code: accountResult.code || 'ACCOUNT_NOT_FOUND',
      error: accountResult.error,
      status: accountResult.status || 409,
      received_debt_id: debtId,
      received_account_id: accountId,
      account_diagnostics: accountResult.diagnostics || null,
      committed: false,
      warnings: []
    };
  }

  const remainingBefore = round2(debt.original_amount - debt.paid_amount);

  if (remainingBefore <= 0) {
    return errorResult('DEBT_HAS_NO_REMAINING_BALANCE', 'Debt has no remaining balance.', 409, {
      debt_id: debt.id,
      remaining_before: remainingBefore
    });
  }

  if (amount > remainingBefore + 0.01) {
    return errorResult('PAYMENT_EXCEEDS_REMAINING', 'payment amount cannot exceed remaining debt balance', 400, {
      debt_id: debt.id,
      remaining_before: remainingBefore,
      attempted_amount: amount
    });
  }

  const transactionType = debt.kind === 'owed' ? 'income' : 'expense';
  const marker = debt.kind === 'owed' ? '[DEBT_RECEIVE]' : '[DEBT_PAYMENT]';
  const sourceAction = debt.kind === 'owed' ? 'receive_payment' : 'make_payment';
  const paymentId = idempotencyKey || buildPaymentId(input, {
    debt,
    amount,
    account_id: accountResult.account.id,
    date
  });

  const existingPayment = await findExistingPayment(db, paymentId, debt.id);

  if (existingPayment) {
    const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

    return {
      ok: true,
      response: {
        already_recorded: true,
        writes_performed: false,
        received_debt_id: debtId,
        resolved_debt_id: debt.id,
        received_account_id: accountId,
        resolved_account_id: accountResult.account.id,
        payment_id: paymentId,
        payment_transaction_id: existingPayment.transaction_id || existingPayment.id || null,
        debt: after,
        ledger: {
          created: false,
          transaction_id: existingPayment.transaction_id || existingPayment.id || null,
          replayed_existing_payment: true
        },
        account: {
          balance_source: 'ledger',
          impacted: false,
          reason: 'existing payment returned'
        },
        forecast: {
          should_reflect: false,
          reason: 'no new write performed'
        },
        proof: {
          action: 'debt_payment',
          idempotent_replay: true,
          payment_id: paymentId
        },
        warnings: []
      }
    };
  }

  const paidAfter = round2(Math.min(debt.original_amount, debt.paid_amount + amount));
  const remainingAfter = round2(Math.max(0, debt.original_amount - paidAfter));
  const statusAfter = remainingAfter <= 0 ? CANONICAL_TERMINAL : 'active';

  const transaction = {
    id: makeId(transactionType === 'income' ? 'tx_debt_receive' : 'tx_debt_pay'),
    date,
    type: transactionType,
    amount: round2(amount),
    account_id: accountResult.account.id,
    transfer_to_account_id: null,
    linked_txn_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant_id: null,
    merchant: debt.name,
    notes: cleanText(
      `${transactionType === 'income' ? 'Debt received' : 'Debt payment'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${accountResult.account.id} | payment_id=${paymentId} | ${marker}${userNotes ? ' | ' + userNotes : ''}`,
      '',
      240
    ),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    pkr_amount: round2(amount),
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    intl_package_id: null,
    reversed_by: null,
    reversed_at: null,
    source_module: 'debts',
    source_id: debt.id,
    source_action: sourceAction,
    idempotency_key: paymentId,
    created_by: createdBy,
    created_at: nowISO(),
    updated_at: nowISO()
  };

  const paymentRow = buildDebtPaymentRow({
    payment_id: paymentId,
    debt,
    amount,
    paid_after: paidAfter,
    remaining_after: remainingAfter,
    account_id: accountResult.account.id,
    date,
    transaction_id: transaction.id,
    notes: userNotes,
    created_by: createdBy
  });

  const normalized = {
    debt_id: debt.id,
    debt_name: debt.name,
    debt_kind: debt.kind,
    amount,
    account_id: accountResult.account.id,
    date,
    payment_id: paymentId,
    transaction_type: transactionType,
    marker,
    status_after: statusAfter
  };

  const proof = {
    action: 'debt_payment',
    contract_version: CONTRACT_VERSION,
    dry_run: Boolean(dryRun),
    writes_performed: false,
    expected_transaction_rows: 1,
    expected_debt_rows_updated: 1,
    expected_debt_payment_rows: 1,
    paid_amount_before: debt.paid_amount,
    paid_amount_after: paidAfter,
    remaining_before: remainingBefore,
    remaining_after: remainingAfter,
    status_after: statusAfter,
    rule: debt.kind === 'owed'
      ? 'owed-to-me payment writes income and increases receiving account'
      : 'i-owe payment writes expense and decreases paying account',
    marker,
    normalized_payload: normalized
  };

  return {
    ok: true,
    normalized,
    projected_debt: {
      ...debt,
      paid_amount: paidAfter,
      remaining_amount: remainingAfter,
      status: statusAfter,
      last_paid_date: date
    },
    transaction,
    payment_row: paymentRow,
    response: {
      received_debt_id: debtId,
      resolved_debt_id: debt.id,
      received_account_id: accountId,
      resolved_account_id: accountResult.account.id,
      amount,
      date,
      debt: {
        id: debt.id,
        name: debt.name,
        kind: debt.kind,
        original_amount: debt.original_amount,
        paid_amount: debt.paid_amount,
        remaining_amount: remainingBefore,
        status: debt.status
      },
      projected_debt: {
        id: debt.id,
        paid_amount: paidAfter,
        remaining_amount: remainingAfter,
        status: statusAfter
      },
      payment_transaction: transaction,
      ledger: ledgerProofFromTransaction(transaction, 'payment'),
      account: {
        balance_source: 'ledger',
        impacted: true,
        account_id: transaction.account_id,
        account_delta: transactionDelta(transaction.type, transaction.amount)
      },
      forecast: {
        should_reflect: true
      },
      payment: {
        created: false,
        payment_id: paymentId
      },
      proof,
      warnings: []
    }
  };
}

function buildDebtPaymentRow(input) {
  const debt = input.debt;
  const amount = round2(input.amount);
  const paidBefore = round2(debt.paid_amount);
  const paidAfter = round2(input.paid_after);
  const remainingAfter = round2(input.remaining_after);

  return {
    id: input.payment_id,
    debt_id: debt.id,
    debt_name_snapshot: debt.name,
    debt_kind_snapshot: debt.kind,
    original_amount_paisa: toPaisa(debt.original_amount),
    paid_before_paisa: toPaisa(paidBefore),
    amount_paisa: toPaisa(amount),
    paid_after_paisa: toPaisa(paidAfter),
    remaining_after_paisa: toPaisa(remainingAfter),
    original_amount: round2(debt.original_amount),
    paid_before: paidBefore,
    amount,
    paid_after: paidAfter,
    remaining_after: remainingAfter,
    account_id: input.account_id,
    category_id: DEFAULT_CATEGORY_ID,
    paid_date: input.date,
    transaction_id: input.transaction_id,
    status: 'paid',
    reversed_at: null,
    reversal_transaction_id: null,
    reason: null,
    notes: cleanText(`payment_id=${input.payment_id} | debt_id=${debt.id} | transaction_id=${input.transaction_id}${input.notes ? ' | ' + input.notes : ''}`, '', 1000),
    dry_run_payload_hash: stableHash(JSON.stringify({
      debt_id: debt.id,
      amount,
      account_id: input.account_id,
      date: input.date,
      dry_run: true
    })),
    transaction_payload_hash: stableHash(JSON.stringify({
      transaction_id: input.transaction_id,
      amount,
      debt_id: debt.id
    })),
    created_by: input.created_by,
    created_at: nowISO()
  };
}

/* ─────────────────────────────
 * Repair Actions
 * ───────────────────────────── */

async function repairLedgerOrigin(db, body, dryRun) {
  const debtId = cleanText(body.debt_id || body.id, '', 200);
  const accountId = cleanText(body.account_id, '', 160);
  const date = normalizeDate(body.date || body.movement_date) || todayISO();
  const createdBy = cleanText(body.created_by, 'debt-origin-repair', 120) || 'debt-origin-repair';
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id, '', 220) || null;

  if (!debtId) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_origin',
      error: 'debt_id required',
      code: 'DEBT_ID_REQUIRED'
    }, 400);
  }

  if (!accountId) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_origin',
      error: 'account_id required',
      code: 'ACCOUNT_REQUIRED'
    }, 400);
  }

  const row = await findDebtById(db, debtId);

  if (!row) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_origin',
      error: `Debt not found for received_debt_id="${debtId}"`,
      code: 'DEBT_NOT_FOUND',
      diagnostics: await debtLookupDiagnostics(db, debtId, body)
    }, 404);
  }

  const debt = normalizeDebt(row);
  const decorated = await decorateDebt(db, debt);

  if (decorated.origin_linked) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_origin',
      already_linked: true,
      writes_performed: false,
      debt: decorated,
      ledger: {
        created: false,
        transaction_id: decorated.origin_transaction_ids[0] || null
      }
    });
  }

  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_origin',
      error: accountResult.error,
      code: accountResult.code || 'ACCOUNT_NOT_FOUND',
      account_diagnostics: accountResult.diagnostics || null
    }, accountResult.status || 409);
  }

  const originTx = buildOriginTransaction({
    debt,
    account: accountResult.account,
    date,
    created_by: createdBy,
    idempotency_key: idempotencyKey
  });

  originTx.notes = originTx.notes.replace('[DEBT_ORIGIN]', '[DEBT_ORIGIN_REPAIR]');
  originTx.source_action = debt.kind === 'owed' ? 'repair_origin_lent_out' : 'repair_origin_borrowed_in';

  const proof = {
    action: 'debt_repair_origin',
    contract_version: CONTRACT_VERSION,
    dry_run: Boolean(dryRun),
    writes_performed: false,
    expected_origin_ledger_rows: 1,
    ledger: ledgerProofFromTransaction(originTx, 'repair_origin'),
    account: {
      balance_source: 'ledger',
      impacted: true,
      account_id: originTx.account_id,
      account_delta: transactionDelta(originTx.type, originTx.amount)
    }
  };

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_origin',
      dry_run: true,
      writes_performed: false,
      origin_transaction: originTx,
      proof
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  await insertStatement(db, 'transactions', filterToColumns(txCols, originTx)).run();

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_repair_origin',
    writes_performed: true,
    origin_transaction_id: originTx.id,
    debt: after,
    ledger: proof.ledger,
    account: proof.account,
    proof: {
      ...proof,
      writes_performed: true
    }
  });
}

async function repairSettledDebts(db, body, dryRun) {
  const debtCols = await tableColumns(db, 'debts');
  const select = selectDebtColumns(debtCols);
  const rows = (await db.prepare(`SELECT ${select.join(', ')} FROM debts`).all()).results || [];

  const fullyPaidCandidates = [];
  const normalizeCandidates = [];

  for (const row of rows) {
    const status = cleanText(row.status || '', '', 80).toLowerCase();
    const original = Number(row.original_amount || 0);
    const paid = Number(row.paid_amount || 0);

    if ((status === 'active' || status === '') && original > 0 && paid >= original) {
      fullyPaidCandidates.push(row);
      continue;
    }

    if (TERMINAL_STATUSES.has(status) && status !== CANONICAL_TERMINAL) {
      normalizeCandidates.push(row);
    }
  }

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_settled_debts',
      dry_run: true,
      writes_performed: false,
      fully_paid_candidates: fullyPaidCandidates.length,
      fully_paid: fullyPaidCandidates.map(candidatePreview),
      normalize_candidates: normalizeCandidates.length,
      normalize: normalizeCandidates.map(candidatePreview)
    });
  }

  const now = nowISO();
  const statements = [];

  for (const row of fullyPaidCandidates) {
    statements.push(updateStatement(
      db,
      'debts',
      debtCols,
      {
        status: CANONICAL_TERMINAL,
        settled_at: now,
        updated_at: now
      },
      "TRIM(id) = TRIM(?) AND (status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')",
      [row.id]
    ));
  }

  for (const row of normalizeCandidates) {
    statements.push(updateStatement(
      db,
      'debts',
      debtCols,
      {
        status: CANONICAL_TERMINAL,
        settled_at: row.settled_at || now,
        updated_at: now
      },
      'TRIM(id) = TRIM(?)',
      [row.id]
    ));
  }

  if (statements.length) await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_repair_settled_debts',
    writes_performed: statements.length > 0,
    fully_paid_repaired: fullyPaidCandidates.length,
    fully_paid_ids: fullyPaidCandidates.map(row => cleanText(row.id, '', 200)),
    normalize_repaired: normalizeCandidates.length,
    normalize_ids: normalizeCandidates.map(row => cleanText(row.id, '', 200)),
    health_check_recommended: '/api/debts?action=health'
  });
}

async function repairReversedPayments(db, body, dryRun) {
  const paymentCols = await tableColumns(db, 'debt_payments');

  if (!paymentCols.size || !paymentCols.has('transaction_id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_reversed_payments',
      error: 'debt_payments table is missing or unreadable',
      code: 'DEBT_PAYMENTS_TABLE_MISSING'
    }, 500);
  }

  const txCols = await tableColumns(db, 'transactions');
  const selectTxReversedBy = txCols.has('reversed_by') ? 't.reversed_by' : 'NULL AS reversed_by';
  const selectTxReversedAt = txCols.has('reversed_at') ? 't.reversed_at' : 'NULL AS reversed_at';
  const selectTxNotes = txCols.has('notes') ? 't.notes' : "'' AS notes";

  const result = await db.prepare(
    `SELECT dp.*,
            ${selectTxReversedBy},
            ${selectTxReversedAt},
            ${selectTxNotes}
     FROM debt_payments dp
     INNER JOIN transactions t
       ON TRIM(t.id) = TRIM(dp.transaction_id)
     WHERE (dp.status IS NULL OR dp.status = '' OR dp.status = 'paid' OR dp.status = 'active')
       AND (
         ${txCols.has('reversed_by') ? "t.reversed_by IS NOT NULL OR t.reversed_by != '' OR" : ''}
         ${txCols.has('reversed_at') ? "t.reversed_at IS NOT NULL OR t.reversed_at != '' OR" : ''}
         ${txCols.has('notes') ? "UPPER(t.notes) LIKE '%[REVERSED BY %'" : '0'}
       )
     ORDER BY dp.debt_id, dp.id`
  ).all();

  const badPayments = result.results || [];
  const affectedDebtIds = [...new Set(badPayments.map(row => row.debt_id).filter(Boolean))];

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_repair_reversed_payments',
      dry_run: true,
      writes_performed: false,
      bad_payments_found: badPayments.length,
      affected_debts_count: affectedDebtIds.length,
      affected_debt_ids: affectedDebtIds,
      bad_payments: badPayments
    });
  }

  const statements = [];
  const now = nowISO();

  for (const payment of badPayments) {
    const updates = {
      status: 'reversed',
      reversed_at: payment.reversed_at || now,
      reversal_transaction_id: payment.reversed_by || null,
      reason: 'linked transaction already reversed',
      notes: appendNote(payment.notes, `Auto-repaired by debt.repair_reversed_payments | original_transaction_id=${payment.transaction_id} | reversal_transaction_id=${payment.reversed_by || ''}`)
    };

    statements.push(updateStatement(db, 'debt_payments', paymentCols, updates, 'TRIM(id) = TRIM(?)', [payment.id]));
  }

  const debtCols = await tableColumns(db, 'debts');

  for (const debtId of affectedDebtIds) {
    const recalc = await recalculateDebtPaidAmount(db, debtId);

    statements.push(updateStatement(db, 'debts', debtCols, {
      paid_amount: recalc.paid_amount,
      status: recalc.status,
      last_paid_date: recalc.last_paid_date,
      updated_at: now,
      settled_at: recalc.status === CANONICAL_TERMINAL ? now : null
    }, 'TRIM(id) = TRIM(?)', [debtId]));
  }

  if (statements.length) await db.batch(statements);

  const debts = [];
  for (const debtId of affectedDebtIds) {
    const row = await findDebtById(db, debtId);
    if (row) debts.push(await decorateDebt(db, normalizeDebt(row)));
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_repair_reversed_payments',
    writes_performed: statements.length > 0,
    bad_payments_found: badPayments.length,
    bad_payments_repaired: badPayments.length,
    affected_debts_count: affectedDebtIds.length,
    affected_debt_ids: affectedDebtIds,
    debts
  });
}

/* ─────────────────────────────
 * Schedule Update
 * ───────────────────────────── */

async function updateDebtSchedule(db, debtId, body) {
  const existing = await findDebtById(db, debtId);

  if (!existing) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_update',
      error: `Debt not found for id="${debtId}"`,
      code: 'DEBT_NOT_FOUND',
      diagnostics: await debtLookupDiagnostics(db, debtId, body)
    }, 404);
  }

  const update = buildDebtUpdate(body);

  if (!update.ok) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_update',
      error: update.error,
      code: update.code || 'VALIDATION_FAILED'
    }, update.status || 400);
  }

  const keys = Object.keys(update.payload);

  if (!keys.length) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'debt_update',
      error: 'No supported fields supplied.',
      code: 'NO_SUPPORTED_FIELDS'
    }, 400);
  }

  const debtCols = await tableColumns(db, 'debts');
  await updateStatement(db, 'debts', debtCols, update.payload, 'TRIM(id) = TRIM(?)', [debtId]).run();

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debtId)));

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_update',
    writes_performed: true,
    money_movement: false,
    id: debtId,
    debt: after,
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
      action: 'debt_update',
      updated_fields: keys,
      money_movement: false
    }
  });
}

function buildDebtUpdate(body) {
  const payload = {
    updated_at: nowISO()
  };

  if (body.due_date !== undefined || body.next_due_date !== undefined) {
    payload.due_date = normalizeDate(body.due_date || body.next_due_date);
  }

  if (body.due_day !== undefined) {
    const day = normalizeDueDay(body.due_day);
    if (body.due_day !== null && body.due_day !== '' && day == null) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_DUE_DAY',
        error: 'due_day must be 1-31'
      };
    }
    payload.due_day = day;
  }

  if (body.installment_amount !== undefined) {
    const amount = normalizeNullableMoney(body.installment_amount);
    if (body.installment_amount !== null && body.installment_amount !== '' && amount == null) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_INSTALLMENT_AMOUNT',
        error: 'installment_amount must be 0 or greater'
      };
    }
    payload.installment_amount = amount;
  }

  if (body.frequency !== undefined) {
    const frequency = normalizeFrequency(body.frequency || 'monthly');
    if (!frequency) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_FREQUENCY',
        error: 'Invalid frequency'
      };
    }
    payload.frequency = frequency;
  }

  if (body.status !== undefined) {
    payload.status = normalizeStatus(body.status);
    if (isTerminalStatus(payload.status)) payload.settled_at = nowISO();
  }

  if (body.notes !== undefined) {
    payload.notes = cleanText(body.notes, '', 1000);
  }

  return {
    ok: true,
    payload
  };
}

/* ─────────────────────────────
 * Decorators / Link Classification
 * ───────────────────────────── */

async function decorateDebt(db, debt) {
  const transactions = await loadTransactionsForDebt(db, debt.id);
  const activeTransactions = transactions.filter(tx => !isReversedTransaction(tx));
  const originTransactions = activeTransactions.filter(tx => isOriginTransactionForDebt(debt, tx));
  const paymentTransactions = activeTransactions.filter(tx => isPaymentTransactionForDebt(debt, tx));

  const explicitMovementNow =
    String(debt.notes || '').toLowerCase().includes('movement_now=1') ||
    originTransactions.length > 0;

  let originState = 'legacy_unknown';
  let repairRequired = false;

  if (originTransactions.length > 0) {
    originState = 'ledger_linked';
  } else if (explicitMovementNow) {
    originState = 'ledger_missing';
    repairRequired = true;
  } else if (paymentTransactions.length > 0) {
    originState = 'payment_linked_only';
  }

  return {
    ...debt,
    origin_state: originState,
    origin_required: explicitMovementNow || originTransactions.length > 0,
    origin_linked: originTransactions.length > 0,
    origin_transaction_ids: originTransactions.map(tx => tx.id),
    origin_transactions: originTransactions,
    payment_linked: paymentTransactions.length > 0,
    payment_transaction_ids: paymentTransactions.map(tx => tx.id),
    payment_transactions: paymentTransactions,
    all_linked_transaction_ids: activeTransactions.map(tx => tx.id),
    repair_required: repairRequired,
    ledger_linked: originTransactions.length > 0,
    ledger_required: explicitMovementNow || originTransactions.length > 0,
    ledger_transaction_ids: originTransactions.map(tx => tx.id),
    ledger_transactions: originTransactions
  };
}

async function loadTransactionsForDebt(db, debtId) {
  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('notes') && !txCols.has('source_id')) return [];

  const wanted = TRANSACTION_COLUMNS_BASE.filter(col => txCols.has(col));

  const clauses = [];
  const binds = [];

  if (txCols.has('notes')) {
    clauses.push('notes LIKE ?');
    binds.push(`%debt_id=${debtId}%`);
  }

  if (txCols.has('source_module') && txCols.has('source_id')) {
    clauses.push("(source_module = 'debts' AND TRIM(source_id) = TRIM(?))");
    binds.push(debtId);
  }

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE ${clauses.join(' OR ')}
     ORDER BY ${buildTransactionOrderBy(txCols)}`
  ).bind(...binds).all();

  const seen = new Set();
  const rows = [];

  for (const row of result.results || []) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(sanitizeTransaction(row));
  }

  return rows;
}

function isOriginTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const type = String(tx.type || '').toLowerCase();
  const sourceAction = String(tx.source_action || '').toLowerCase();
  const amountMatches = Math.abs(Number(tx.amount || tx.pkr_amount || 0) - Number(debt.original_amount || 0)) < 0.01;

  if (notes.includes('[DEBT_ORIGIN]')) return true;
  if (notes.includes('[DEBT_ORIGIN_REPAIR]')) return true;
  if (sourceAction.includes('origin')) return true;

  if (!amountMatches) return false;

  if (debt.kind === 'owed') return ['expense', 'debt_out'].includes(type);
  if (debt.kind === 'owe') return ['income', 'borrow', 'debt_in'].includes(type);

  return false;
}

function isPaymentTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const type = String(tx.type || '').toLowerCase();
  const sourceAction = String(tx.source_action || '').toLowerCase();

  if (notes.includes('[DEBT_PAYMENT]')) return true;
  if (notes.includes('[DEBT_RECEIVE]')) return true;
  if (sourceAction.includes('payment') || sourceAction.includes('receive')) return true;

  if (debt.kind === 'owed') return ['income', 'debt_in'].includes(type);
  if (debt.kind === 'owe') return ['expense', 'repay', 'debt_out'].includes(type);

  return false;
}

function isReversedTransaction(tx) {
  const notes = String(tx.notes || '').toUpperCase();

  return !!(
    tx.reversed_by ||
    tx.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

/* ─────────────────────────────
 * Find / Resolve / Recalculate
 * ───────────────────────────── */

async function findDebtById(db, debtId) {
  const id = cleanText(debtId, '', 200);
  if (!id) return null;

  const debtCols = await tableColumns(db, 'debts');
  const select = selectDebtColumns(debtCols);

  return db.prepare(
    `SELECT ${select.join(', ')}
     FROM debts
     WHERE TRIM(id) = TRIM(?)
     LIMIT 1`
  ).bind(id).first();
}

async function findTransactionById(db, txCols, id) {
  if (!id || !txCols.has('id')) return null;

  const select = TRANSACTION_COLUMNS_BASE.filter(col => txCols.has(col));

  return db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE TRIM(id) = TRIM(?)
     LIMIT 1`
  ).bind(id).first();
}

async function findExistingPayment(db, paymentId, debtId) {
  const paymentCols = await tableColumns(db, 'debt_payments');

  if (paymentCols.size > 0 && paymentCols.has('id')) {
    const select = [
      'id',
      'debt_id',
      paymentCols.has('transaction_id') ? 'transaction_id' : null,
      paymentCols.has('tx_id') ? 'tx_id AS transaction_id' : null
    ].filter(Boolean).join(', ');

    const row = await db.prepare(
      `SELECT ${select}
       FROM debt_payments
       WHERE id = ?
       LIMIT 1`
    ).bind(paymentId).first();

    if (row) return row;
  }

  const txCols = await tableColumns(db, 'transactions');

  if (txCols.has('notes')) {
    const row = await db.prepare(
      `SELECT id, notes
       FROM transactions
       WHERE notes LIKE ?
         AND notes LIKE ?
       LIMIT 1`
    ).bind(`%payment_id=${paymentId}%`, `%debt_id=${debtId}%`).first();

    if (row) {
      return {
        id: row.id,
        transaction_id: row.id
      };
    }
  }

  if (txCols.has('idempotency_key')) {
    const row = await db.prepare(
      `SELECT id, idempotency_key
       FROM transactions
       WHERE idempotency_key = ?
       LIMIT 1`
    ).bind(paymentId).first();

    if (row) {
      return {
        id: row.id,
        transaction_id: row.id
      };
    }
  }

  return null;
}

async function loadDebtPayments(db) {
  const paymentCols = await tableColumns(db, 'debt_payments');

  if (!paymentCols.size || !paymentCols.has('id')) return [];

  const result = await db.prepare(
    `SELECT *
     FROM debt_payments
     ORDER BY ${paymentCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC
     LIMIT 5000`
  ).all();

  return result.results || [];
}

async function recalculateDebtPaidAmount(db, debtId) {
  const paymentCols = await tableColumns(db, 'debt_payments');
  const debtRow = await findDebtById(db, debtId);

  if (!debtRow) {
    return {
      paid_amount: 0,
      remaining_amount: 0,
      status: 'active',
      last_paid_date: null
    };
  }

  if (!paymentCols.size || !paymentCols.has('debt_id')) {
    const debt = normalizeDebt(debtRow);

    return {
      paid_amount: debt.paid_amount,
      remaining_amount: debt.remaining_amount,
      status: debt.remaining_amount > 0 ? 'active' : CANONICAL_TERMINAL,
      last_paid_date: debt.last_paid_date
    };
  }

  const result = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS active_paid_amount,
            MAX(paid_date) AS last_paid_date
     FROM debt_payments
     WHERE TRIM(debt_id) = TRIM(?)
       AND (status IS NULL OR status = '' OR status = 'paid' OR status = 'active')`
  ).bind(debtId).first();

  const originalAmount = round2(debtRow.original_amount || 0);
  const paidAmount = round2(result?.active_paid_amount || 0);
  const remainingAmount = Math.max(0, round2(originalAmount - paidAmount));

  return {
    paid_amount: paidAmount,
    remaining_amount: remainingAmount,
    status: remainingAmount > 0 ? 'active' : CANONICAL_TERMINAL,
    last_paid_date: result?.last_paid_date || null
  };
}

async function resolveAccount(db, input) {
  const id = cleanText(input, '', 160);

  if (!id) {
    return {
      ok: false,
      status: 400,
      code: 'ACCOUNT_REQUIRED',
      error: 'account_id required'
    };
  }

  const cols = await tableColumns(db, 'accounts');

  if (!cols.has('id')) {
    return {
      ok: false,
      status: 500,
      code: 'ACCOUNTS_SCHEMA_INVALID',
      error: 'accounts table missing id column'
    };
  }

  const where = activeAccountWhere(cols);

  const exact = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE TRIM(id) = TRIM(?)
     ${where ? 'AND ' + where : ''}
     LIMIT 1`
  ).bind(id).first();

  if (exact?.id) {
    return {
      ok: true,
      account: normalizeAccount(exact)
    };
  }

  const result = await db.prepare(
    `SELECT *
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${cols.has('display_order') ? 'display_order,' : ''} ${cols.has('name') ? 'name,' : ''} id`
  ).all();

  const target = token(id);
  const found = (result.results || []).find(account => {
    return token(account.id) === target ||
      token(account.name) === target ||
      String(account.name || '').trim().toLowerCase() === id.toLowerCase();
  });

  if (found?.id) {
    return {
      ok: true,
      account: normalizeAccount(found)
    };
  }

  return {
    ok: false,
    status: 409,
    code: 'ACCOUNT_NOT_FOUND',
    error: 'Account not found or inactive',
    diagnostics: {
      received_account_id: id,
      available_accounts: (result.results || []).map(row => ({
        id: row.id,
        name: row.name,
        type: row.type || row.kind || null,
        status: row.status || null
      }))
    }
  };
}

async function debtLookupDiagnostics(db, debtId, body) {
  const id = cleanText(debtId, '', 200);
  const tokenPart = id.includes('_') ? id.split('_').slice(-1)[0].toLowerCase() : id.toLowerCase();

  let exact_count = null;
  let trim_count = null;
  let total_debt_count = null;
  let matching_id_debts = [];
  let matching_name_debts = [];

  try {
    exact_count = (await db.prepare(`SELECT COUNT(*) AS c FROM debts WHERE id = ?`).bind(id).first())?.c ?? null;
  } catch {}

  try {
    trim_count = (await db.prepare(`SELECT COUNT(*) AS c FROM debts WHERE TRIM(id) = TRIM(?)`).bind(id).first())?.c ?? null;
  } catch {}

  try {
    total_debt_count = (await db.prepare(`SELECT COUNT(*) AS c FROM debts`).first())?.c ?? null;
  } catch {}

  try {
    matching_id_debts = (await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, status, due_date, created_at
       FROM debts
       WHERE LOWER(id) LIKE ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20`
    ).bind(`%${tokenPart}%`).all()).results || [];
  } catch {}

  try {
    matching_name_debts = (await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, status, due_date, created_at
       FROM debts
       WHERE LOWER(name) LIKE ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20`
    ).bind(`%${tokenPart}%`).all()).results || [];
  } catch {}

  return {
    received_debt_id: id,
    received_debt_id_json: JSON.stringify(id),
    received_debt_id_length: id.length,
    received_body_keys: Object.keys(body || {}),
    received_body: redactBody(body),
    exact_count,
    trim_count,
    total_debt_count,
    matching_id_debts,
    matching_name_debts
  };
}

/* ─────────────────────────────
 * Normalize / Summaries
 * ───────────────────────────── */

function normalizeDebt(row) {
  const original = Number(row?.original_amount || 0);
  const paid = Number(row?.paid_amount || 0);
  const remaining = Math.max(0, original - paid);
  const dueDate = normalizeDate(row?.due_date);
  const dueDay = normalizeDueDay(row?.due_day);
  const installmentAmount = normalizeNullableMoney(row?.installment_amount);
  const frequency = normalizeFrequency(row?.frequency || 'monthly') || 'monthly';
  const lastPaidDate = normalizeDate(row?.last_paid_date);
  const schedule = computeSchedule({
    remaining,
    due_date: dueDate,
    due_day: dueDay,
    last_paid_date: lastPaidDate
  });

  let status = cleanText(row?.status || 'active', 'active', 80).toLowerCase();

  if (!status) status = 'active';

  return {
    id: cleanText(row?.id, '', 160),
    name: cleanText(row?.name || row?.id, '', 160),
    kind: normalizeKind(row?.kind) || 'owe',
    original_amount: round2(original),
    paid_amount: round2(paid),
    remaining_amount: round2(remaining),
    snowball_order: row?.snowball_order == null ? null : Number(row.snowball_order),
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    last_paid_date: lastPaidDate,
    next_due_date: schedule.next_due_date,
    days_until_due: schedule.days_until_due,
    days_overdue: schedule.days_overdue,
    due_status: schedule.due_status,
    schedule_missing: schedule.schedule_missing,
    status,
    notes: cleanText(row?.notes, '', 1000),
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
    settled_at: row?.settled_at || null
  };
}

function summarizeDebts(debts) {
  const active = debts.filter(debt => !isTerminalStatus(debt.status));

  const out = {
    total_owe: 0,
    total_owed: 0,
    schedule_missing_count: 0,
    due_soon_count: 0,
    overdue_count: 0,
    origin_linked_count: 0,
    legacy_unknown_count: 0,
    payment_linked_only_count: 0,
    repair_required_count: 0,
    repair_required_debt_ids: []
  };

  for (const debt of active) {
    if (debt.kind === 'owe') out.total_owe += debt.remaining_amount;
    if (debt.kind === 'owed') out.total_owed += debt.remaining_amount;
    if (debt.schedule_missing) out.schedule_missing_count += 1;
    if (debt.due_status === 'due_soon') out.due_soon_count += 1;
    if (debt.due_status === 'overdue') out.overdue_count += 1;
    if (debt.origin_state === 'ledger_linked') out.origin_linked_count += 1;
    if (debt.origin_state === 'legacy_unknown') out.legacy_unknown_count += 1;
    if (debt.origin_state === 'payment_linked_only') out.payment_linked_only_count += 1;

    if (debt.repair_required) {
      out.repair_required_count += 1;
      out.repair_required_debt_ids.push(debt.id);
    }
  }

  out.total_owe = round2(out.total_owe);
  out.total_owed = round2(out.total_owed);

  return out;
}

function computeSchedule(input) {
  const remaining = Number(input.remaining || 0);

  if (remaining <= 0) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'paid_off',
      schedule_missing: false
    };
  }

  let nextDue = null;

  if (input.due_date) {
    nextDue = parseDate(input.due_date);
  } else if (input.due_day != null) {
    nextDue = nextDueFromDay(input.due_day, input.last_paid_date);
  }

  if (!nextDue) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'no_schedule',
      schedule_missing: true
    };
  }

  const today = startOfDay(new Date());
  const days = daysBetween(today, nextDue);

  if (days < 0) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: 0,
      days_overdue: Math.abs(days),
      due_status: 'overdue',
      schedule_missing: false
    };
  }

  if (days === 0) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: 0,
      days_overdue: 0,
      due_status: 'due_today',
      schedule_missing: false
    };
  }

  if (days <= DUE_SOON_DAYS) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: days,
      days_overdue: 0,
      due_status: 'due_soon',
      schedule_missing: false
    };
  }

  return {
    next_due_date: dateOnly(nextDue),
    days_until_due: days,
    days_overdue: 0,
    due_status: 'scheduled',
    schedule_missing: false
  };
}

/* ─────────────────────────────
 * DB Helpers
 * ───────────────────────────── */

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((result.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function selectDebtColumns(cols) {
  const select = DEBT_COLUMNS_BASE.filter(col => cols.has(col));

  if (!select.length) {
    throw new Error('debts table has no readable columns');
  }

  return select;
}

function buildDebtOrderBy(cols) {
  const parts = [];

  if (cols.has('kind')) parts.push('kind');
  if (cols.has('snowball_order')) parts.push('snowball_order');
  if (cols.has('name')) parts.push('name');
  if (cols.has('created_at')) parts.push('datetime(created_at) DESC');
  if (cols.has('id')) parts.push('id');

  return parts.length ? parts.join(', ') : 'rowid DESC';
}

function buildTransactionOrderBy(cols) {
  const parts = [];

  if (cols.has('created_at')) parts.push('datetime(created_at) DESC');
  if (cols.has('date')) parts.push('date DESC');
  if (cols.has('id')) parts.push('id DESC');

  return parts.length ? parts.join(', ') : 'rowid DESC';
}

function activeAccountWhere(cols) {
  const parts = [];

  if (cols.has('deleted_at')) parts.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) parts.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) parts.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");

  return parts.join(' AND ');
}

function filterToColumns(cols, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function insertStatement(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error(`${table} insert has no compatible columns`);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

function updateStatement(db, table, cols, patch, whereSql, whereValues) {
  const keys = Object.keys(patch).filter(key => cols.has(key));

  if (!keys.length) {
    return db.prepare('SELECT 1').bind();
  }

  return db.prepare(
    `UPDATE ${table}
     SET ${keys.map(key => `${key} = ?`).join(', ')}
     WHERE ${whereSql}`
  ).bind(...keys.map(key => patch[key]), ...(whereValues || []));
}

/* ─────────────────────────────
 * Utility
 * ───────────────────────────── */

function ledgerProofFromTransaction(tx, purpose) {
  return {
    created: true,
    purpose,
    transaction_id: tx.id,
    type: tx.type,
    amount: Number(tx.amount || 0),
    account_id: tx.account_id,
    account_delta: transactionDelta(tx.type, tx.amount),
    marker: extractDebtMarker(tx.notes),
    source_module: tx.source_module || null,
    source_id: tx.source_id || null,
    source_action: tx.source_action || null
  };
}

function transactionDelta(type, amount) {
  const t = String(type || '').toLowerCase();
  const n = Math.abs(Number(amount || 0));

  if (['income', 'salary', 'opening', 'borrow', 'debt_in', 'adjustment_positive'].includes(t)) return n;

  return -n;
}

function extractDebtMarker(notes) {
  const text = String(notes || '');

  if (text.includes('[DEBT_ORIGIN_REPAIR]')) return '[DEBT_ORIGIN_REPAIR]';
  if (text.includes('[DEBT_ORIGIN]')) return '[DEBT_ORIGIN]';
  if (text.includes('[DEBT_PAYMENT]')) return '[DEBT_PAYMENT]';
  if (text.includes('[DEBT_RECEIVE]')) return '[DEBT_RECEIVE]';

  return null;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

function normalizeStatus(value) {
  const raw = cleanText(value || 'active', 'active', 80).toLowerCase();

  if (!raw) return 'active';
  if (raw === 'cancelled' || raw === 'canceled') return 'archived';
  if (TERMINAL_STATUSES.has(raw)) return raw;
  if (raw === 'active' || raw === 'paused') return raw;

  return 'active';
}

function normalizeKind(value) {
  const raw = String(value || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'borrowed', 'i owe'].includes(raw)) return 'owe';
  if (['owed', 'owed_to_me', 'owed_me', 'to_me', 'receivable', 'owed to me'].includes(raw)) return 'owed';

  return null;
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);

  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;

  return raw.slice(0, 10);
}

function parseDate(value) {
  const raw = normalizeDate(value);
  if (!raw) return null;

  const d = new Date(raw + 'T00:00:00.000Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  if (!Number.isFinite(n) || n < 1 || n > 31) return null;

  return Math.floor(n);
}

function normalizeNullableMoney(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = moneyNumber(value, null);

  if (n == null || n < 0) return null;

  return n;
}

function normalizeFrequency(value) {
  const raw = cleanText(value, 'monthly', 30).toLowerCase();

  return ['monthly', 'weekly', 'yearly', 'custom'].includes(raw) ? raw : null;
}

function parseMovementNow(body) {
  if (
    body.movement_now === undefined &&
    body.money_moved_now === undefined &&
    body.ledger_movement_now === undefined &&
    body.create_ledger === undefined
  ) {
    return true;
  }

  const value = body.movement_now ?? body.money_moved_now ?? body.ledger_movement_now ?? body.create_ledger;

  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;

  return ['1', 'true', 'yes', 'y', 'on', 'moved'].includes(String(value).trim().toLowerCase());
}

function buildDebtNotes(notes, meta) {
  const parts = [];

  if (notes) parts.push(notes);

  parts.push(meta.movement_now ? 'movement_now=1' : 'movement_now=0');

  if (meta.account_id) parts.push('account_id=' + meta.account_id);
  if (meta.created_by) parts.push('created_by=' + meta.created_by);

  return cleanText(parts.join(' | '), '', 1000);
}

function candidatePreview(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    original_amount: Number(row.original_amount || 0),
    paid_amount: Number(row.paid_amount || 0),
    current_status: row.status || 'active',
    will_become: CANONICAL_TERMINAL
  };
}

function normalizeAccount(row) {
  return {
    ...row,
    id: cleanText(row.id, '', 160),
    name: cleanText(row.name || row.id, '', 160)
  };
}

function sanitizeTransaction(row) {
  return {
    id: row.id,
    date: row.date || null,
    type: row.type || null,
    amount: row.amount == null ? null : Number(row.amount),
    pkr_amount: row.pkr_amount == null ? null : Number(row.pkr_amount),
    account_id: row.account_id || null,
    category_id: row.category_id || null,
    merchant_id: row.merchant_id || null,
    merchant: row.merchant || null,
    notes: row.notes || '',
    source_module: row.source_module || null,
    source_id: row.source_id || null,
    source_action: row.source_action || null,
    idempotency_key: row.idempotency_key || null,
    created_at: row.created_at || null,
    reversed_by: row.reversed_by || null,
    reversed_at: row.reversed_at || null
  };
}

function buildPaymentId(body, input) {
  const supplied = cleanText(
    body.payment_id ||
      body.debt_payment_id ||
      body.idempotency_key ||
      body.client_payment_id ||
      '',
    '',
    160
  );

  if (supplied) return supplied;

  return 'debtpay_' + stableHash([
    input.debt.id,
    input.amount,
    input.account_id,
    input.date
  ].join('|'));
}

function moneyNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? round2(n) : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function toPaisa(value) {
  return Math.round(Number(value || 0) * 100);
}

function cleanText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function token(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function nextDueFromDay(day, lastPaidDate) {
  const today = startOfDay(new Date());
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), day);

  if (lastPaidDate && String(lastPaidDate).slice(0, 7) === today.toISOString().slice(0, 7)) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  } else if (candidate < today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  }

  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, max)));
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000);
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
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

function appendNote(existing, addition) {
  const base = cleanText(existing, '', 1000);
  const next = cleanText(addition, '', 1000);

  if (!base) return next;
  if (!next) return base;

  return `${base} | ${next}`.slice(0, 1000);
}

function redactBody(body) {
  const out = { ...(body || {}) };
  delete out.password;
  delete out.token;
  delete out.secret;
  return out;
}

function errorResult(code, error, status, extra) {
  return {
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'debt_payment',
    code,
    error,
    status,
    committed: false,
    warnings: [],
    ...(extra || {})
  };
}

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

  return String(raw).split('/').filter(Boolean);
}

async function readJSON(request) {
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

function requireDb(context) {
  if (!context.env || !context.env.DB) {
    throw new Error('D1 binding DB is missing.');
  }

  return context.env.DB;
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
      stage: 'top_level_catch',
      error: err && err.message ? err.message : String(err),
      stack: shortStack(err)
    }, 500);
  }
}

function shortStack(err) {
  return String(err && err.stack ? err.stack : '')
    .split('\n')
    .slice(0, 6)
    .join('\n');
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
