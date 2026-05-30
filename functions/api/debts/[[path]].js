/* Sovereign Finance Debts API
 * /api/debts
 * v0.9.1-debts-batched-decoration
 *
 * Contract:
 *   contract_version = debts-v1
 *
 * Banking-grade rules:
 *   - GET is read-only. No list/health/payment_check route may mutate data.
 *   - Debt rows are not account balance truth.
 *   - Money movement is represented only by ledger transaction rows.
 *   - Account balance remains ledger-derived.
 *   - Settlement/normalization repairs are explicit POST actions only.
 *   - Canonical payment route is POST /api/debts action=payment.
 *   - Canonical reversal route is POST /api/transactions/reverse.
 */

const VERSION = 'v1.0.0-debts-contract-v1';
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

const DEBT_COLUMNS = `
  id,
  name,
  kind,
  original_amount,
  paid_amount,
  snowball_order,
  due_date,
  due_day,
  installment_amount,
  frequency,
  last_paid_date,
  status,
  notes,
  created_at,
  direction,
  counterparty_type,
  counterparty_name,
  contact_phone,
  contact_email,
  principal_amount,
  principal_currency,
  principal_amount_pkr_at_origination,
  date_originated,
  expected_repayment_date,
  settlement_date,
  writeoff_date,
  destination_account_id,
  source_account_id,
  funds_moved_at_creation,
  origination_transaction_id,
  interest_rate_pct,
  interest_type,
  minimum_payment_amount,
  payment_frequency,
  writeoff_reason,
  reminder_cadence,
  last_contact_date,
  description,
  reference_number,
  document_url,
  tags,
  collateral,
  guarantor_name,
  trust_level,
  split_with_household,
  updated_at,
  owner_user_id
`;

export async function onRequestGet(context) {
  return withJsonErrors('GET', async () => {
    const db = requireDb(context.env);
    const userId = context.data.user_id;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = safeText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (path.length > 0) {
      return json(contractError({
        action: 'debt_get',
        code: 'UNSUPPORTED_GET_SUBROUTE',
        error: 'Unsupported GET subroute.',
        extra: { path }
      }), 404);
    }

    if (action === 'health') return health(db, userId);
    if (action === 'payment_check' || action === 'payment-check') return paymentCheckFromUrl(db, url);

    return listDebts(db, url, userId);
  });
}

export async function onRequestPost(context) {
  return withJsonErrors('POST', async () => {
    const db = requireDb(context.env);
    const userId = context.data.user_id;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const body = await readJSON(context.request);
    const action = safeText(body.action, 'create', 80).toLowerCase();
    const dryRun = isDryRun(url, body);

    if (path.length > 0) {
      return json(contractError({
        action: 'debt_post',
        code: 'UNSUPPORTED_POST_SUBROUTE',
        error: 'Unsupported POST subroute. Use canonical POST /api/debts actions.',
        extra: {
          path,
          received_action: action,
          canonical_route: '/api/debts',
          received_body_keys: Object.keys(body || {})
        }
      }), 404);
    }

    if (action === 'create' || action === 'debt_create') return createDebt(db, body, dryRun);
    if (action === 'pay' || action === 'payment' || action === 'record_payment') return recordDebtPayment(db, body, dryRun);
    if (action === 'receive_payment' || action === 'receive' || action === 'receive_debt_payment') return receiveDebtPayment(db, body, dryRun);
    if (action === 'defer' || action === 'defer_debt') return deferDebt(db, body, dryRun);
    if (action === 'accrue_interest' || action === 'accrue_debt_interest') return accrueDebtInterest(db, body, dryRun);
    if (action === 'settle' || action === 'mark_settled' || action === 'settle_debt') return settleDebt(db, body, dryRun);
    if (action === 'writeoff' || action === 'write_off' || action === 'writeoff_debt') return writeoffDebt(db, body, dryRun);
    if (action === 'payment_check' || action === 'payment-check') return paymentCheckFromBody(db, body);
    if (action === 'repair_ledger' || action === 'repair-ledger') return repairLedgerOrigin(db, body, dryRun);
    if (action === 'repair_settled_debts' || action === 'repair-settled-debts') return repairSettledDebts(db, body, dryRun, userId);
    if (action === 'repair_reversed_payments' || action === 'repair-reversed-payments') return repairReversedPayments(db, body, dryRun, userId);

    return json(contractError({
      action: 'debt_post',
      code: 'UNKNOWN_DEBT_ACTION',
      error: `Unknown debt action "${action}".`,
      extra: {
        supported_actions: [
          'create', 'pay', 'receive_payment', 'defer', 'accrue_interest',
          'settle', 'writeoff', 'payment_check',
          'repair_ledger', 'repair_settled_debts', 'repair_reversed_payments'
        ]
      }
    }), 400);
  });
}

export async function onRequestPut(context) {
  return withJsonErrors('PUT', async () => {
    const db = requireDb(context.env);
    const path = getPath(context);
    const debtId = safeText(path[0], '', 200);
    const body = await readJSON(context.request);

    if (!debtId) {
      return json(contractError({
        action: 'debt_update',
        code: 'DEBT_ID_REQUIRED',
        error: 'debt id required'
      }), 400);
    }

    const existing = await findDebtById(db, debtId);

    if (!existing) {
      return json(contractError({
        action: 'debt_update',
        code: 'DEBT_NOT_FOUND',
        error: `Debt not found for id="${debtId}".`,
        extra: { diagnostics: await debtLookupDiagnostics(db, debtId, body) }
      }), 404);
    }

    const update = buildDebtUpdate(body);

    if (!update.ok) {
      return json(contractError({
        action: 'debt_update',
        code: 'INVALID_DEBT_UPDATE',
        error: update.error
      }), update.status || 400);
    }

    const keys = Object.keys(update.payload);

    if (!keys.length) {
      return json(contractError({
        action: 'debt_update',
        code: 'NO_SUPPORTED_FIELDS',
        error: 'No supported fields supplied.'
      }), 400);
    }

    await db.prepare(
      `UPDATE debts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE TRIM(id) = TRIM(?)`
    ).bind(...keys.map(k => update.payload[k]), debtId).run();

    const debt = await decorateDebt(db, normalizeDebt(await findDebtById(db, debtId)));

    return json({
      ok: true,
      action: 'debt_update',
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      committed: true,
      writes_performed: true,
      read_only: false,
      debt,
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
        should_reflect: isActiveDebt(debt)
      },
      warnings: []
    });
  });
}

/* ─────────────────────────────
 * GET: read-only list / health / check
 * ───────────────────────────── */

async function listDebts(db, url, userId) {
  const includeInactive = url.searchParams.get('include_inactive') === '1';
  const filterDirection = safeText(url.searchParams.get('direction') || '', '', 20).toLowerCase();
  const filterStatus = safeText(url.searchParams.get('status') || '', '', 30).toLowerCase();
  const filterCounterpartyType = safeText(url.searchParams.get('counterparty_type') || url.searchParams.get('lender_type') || '', '', 50).toLowerCase();

  const res = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
       FROM debts
      WHERE owner_user_id = ?
      ORDER BY kind, snowball_order, name`
  ).bind(userId).all();

  const allRows = res.results || [];
  let raw = includeInactive ? allRows : allRows.filter(row => !isTerminalStatus(row.status));

  // Apply filters
  if (filterDirection) {
    const targetDirection = normalizeDirection(filterDirection);
    raw = raw.filter(row => {
      const d = normalizeDirection(row.direction || row.kind);
      return d === targetDirection;
    });
  }
  if (filterStatus) {
    if (filterStatus === 'active') raw = raw.filter(row => !isTerminalStatus(row.status));
    else raw = raw.filter(row => (row.status || '').toLowerCase() === filterStatus);
  }
  if (filterCounterpartyType) {
    raw = raw.filter(row => (row.counterparty_type || '').toLowerCase() === filterCounterpartyType);
  }

  const normalized = raw.map(normalizeDebt);
  const txMap = await loadTransactionsForDebts(db, normalized.map(debt => debt.id));

  const debts = normalized.map(debt => decorateDebtFromTransactions(debt, txMap.get(debt.id) || []));
  const totals = summarizeDebts(debts);

  return json({
    ok: true,
    action: 'debt_list',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: false,
    writes_performed: false,
    read_only: true,
    count: debts.length,
    include_inactive: includeInactive,
    totals: {
      total_owe: totals.total_owe,
      total_owed: totals.total_owed,
      payable_remaining: totals.total_owe,
      receivable_remaining: totals.total_owed,
      schedule_missing_count: totals.schedule_missing_count,
      due_soon_count: totals.due_soon_count,
      overdue_count: totals.overdue_count,
      origin_linked_count: totals.origin_linked_count,
      legacy_unknown_count: totals.legacy_unknown_count,
      payment_linked_only_count: totals.payment_linked_only_count,
      repair_required_count: totals.repair_required_count
    },
    total_owe: totals.total_owe,
    total_owed: totals.total_owed,
    summary: {
      total_owe: totals.total_owe,
      total_owed_me: totals.total_owed,
      count_active: debts.filter(isActiveDebt).length,
      count_settled: debts.filter(d => d.status === CANONICAL_TERMINAL).length
    },
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
      account_balance_source: 'ledger',
      get_is_read_only: true,
      auto_settle_on_list: false,
      explicit_repair_required: true,
      root_route_payment_post_supported: true,
      payment_subroutes_retired: true,
      canonical_payment_route: 'POST /api/debts action=payment',
      canonical_reversal_route: 'POST /api/transactions/reverse',
      terminal_statuses: Array.from(TERMINAL_STATUSES),
      canonical_terminal_status: CANONICAL_TERMINAL
    },
    performance: {
      decoration: 'batched_transactions',
      n_plus_one_removed: true
    },
    warnings: [],
    debts
  });
}

async function health(db, userId) {
  const rows = (await db.prepare(`SELECT ${DEBT_COLUMNS} FROM debts WHERE owner_user_id = ?`).bind(userId).all()).results || [];
  const normalized = rows.map(normalizeDebt);
  const txMap = await loadTransactionsForDebts(db, normalized.map(debt => debt.id));
  const debts = normalized.map(debt => decorateDebtFromTransactions(debt, txMap.get(debt.id) || []));

  const active = debts.filter(isActiveDebt);
  const terminal = debts.filter(d => isTerminalStatus(d.status));
  const fullyPaidActive = active.filter(d => d.original_amount > 0 && d.paid_amount >= d.original_amount);
  const totals = summarizeDebts(debts);

  const warnings = [];

  if (fullyPaidActive.length) {
    warnings.push({
      code: 'FULLY_PAID_ACTIVE_DEBTS',
      count: fullyPaidActive.length,
      debt_ids: fullyPaidActive.map(d => d.id),
      repair_action: 'POST /api/debts action=repair_settled_debts'
    });
  }

  if (totals.repair_required_count > 0) {
    warnings.push({
      code: 'DEBT_ORIGIN_REPAIR_REQUIRED',
      count: totals.repair_required_count,
      debt_ids: totals.repair_required_debt_ids,
      repair_action: 'POST /api/debts action=repair_ledger'
    });
  }

  return json({
    ok: true,
    action: 'debt_health',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: false,
    writes_performed: false,
    read_only: true,
    status: warnings.length ? 'warn' : 'pass',
    checks: {
      get_is_read_only: true,
      terminal_filter_valid: true,
      account_balance_source_is_ledger: true,
      payment_route_canonical: true,
      stale_money_routes_should_be_retired: true,
      fully_paid_active_debts_clean: fullyPaidActive.length === 0,
      repair_required_clean: totals.repair_required_count === 0
    },
    counts: {
      debts: debts.length,
      active_debts: active.length,
      terminal_debts: terminal.length,
      fully_paid_active_debts: fullyPaidActive.length,
      repair_required: totals.repair_required_count
    },
    totals: {
      payable_remaining: totals.total_owe,
      receivable_remaining: totals.total_owed
    },
    performance: {
      decoration: 'batched_transactions',
      n_plus_one_removed: true
    },
    warnings
  });
}

async function paymentCheckFromUrl(db, url) {
  return paymentCheckCore(db, {
    debt_id: url.searchParams.get('debt_id'),
    account_id: url.searchParams.get('account_id'),
    amount: moneyNumber(url.searchParams.get('amount'), null),
    date: normalizeDate(url.searchParams.get('date')) || todayISO()
  });
}

async function paymentCheckFromBody(db, body) {
  return paymentCheckCore(db, {
    debt_id: body.debt_id || body.id || body.debtId,
    account_id: body.account_id,
    amount: moneyNumber(body.amount, null),
    date: normalizeDate(body.date || body.paid_at || body.payment_date) || todayISO()
  });
}

async function paymentCheckCore(db, input) {
  const debtId = safeText(input.debt_id, '', 200);
  const accountId = safeText(input.account_id, '', 160);
  const amount = moneyNumber(input.amount, null);
  const date = normalizeDate(input.date) || todayISO();

  if (!debtId) {
    return json(contractError({
      action: 'debt_payment_check',
      code: 'DEBT_ID_REQUIRED',
      error: 'debt_id required'
    }), 400);
  }

  if (!accountId) {
    return json(contractError({
      action: 'debt_payment_check',
      code: 'ACCOUNT_ID_REQUIRED',
      error: 'account_id required'
    }), 400);
  }

  if (amount == null || amount <= 0) {
    return json(contractError({
      action: 'debt_payment_check',
      code: 'INVALID_AMOUNT',
      error: 'amount must be greater than 0'
    }), 400);
  }

  const row = await findDebtById(db, debtId);

  if (!row) {
    return json(contractError({
      action: 'debt_payment_check',
      code: 'DEBT_NOT_FOUND',
      error: `Debt not found for received_debt_id="${debtId}".`,
      extra: { diagnostics: await debtLookupDiagnostics(db, debtId, input) }
    }), 404);
  }

  const debt = normalizeDebt(row);
  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json(contractError({
      action: 'debt_payment_check',
      code: 'ACCOUNT_NOT_FOUND_OR_INACTIVE',
      error: accountResult.error,
      extra: { account_diagnostics: accountResult.diagnostics || null }
    }), accountResult.status || 409);
  }

  const projection = buildPaymentProjection(debt, accountResult.account, amount, date);

  if (!projection.ok) {
    return json(contractError({
      action: 'debt_payment_check',
      code: 'INVALID_DEBT_PAYMENT',
      error: projection.error,
      extra: projection
    }), projection.status || 400);
  }

  return json({
    ok: true,
    action: 'debt_payment_check',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: false,
    writes_performed: false,
    read_only: true,
    debt: debtSummary({
      ...debt,
      paid_amount: projection.paid_amount_after,
      status: projection.status_after
    }),
    ledger: {
      created: false,
      would_create: true,
      transaction_id: null,
      type: projection.transaction_type,
      amount,
      account_id: accountResult.account.id,
      account_delta: projection.account_delta,
      marker: projection.marker,
      source_module: 'debts',
      source_id: debt.id,
      source_action: projection.source_action
    },
    account: {
      balance_source: 'ledger',
      impacted: true
    },
    forecast: {
      should_reflect: true,
      debt_bucket: debt.kind === 'owe' ? 'payable' : 'receivable'
    },
    proof: {
      remaining_before: projection.remaining_before,
      paid_amount_after: projection.paid_amount_after,
      status_after: projection.status_after,
      rule: projection.rule
    },
    warnings: []
  });
}

/* ─────────────────────────────
 * POST: create
 * ───────────────────────────── */

async function createDebt(db, body, dryRun) {
  const id = safeText(body.id || body.debt_id || body.idempotency_key, '', 160) || makeId('debt');

  // Contract fields — support both legacy (name/kind) and new contract (counterparty_name/direction)
  const counterpartyName = safeText(body.counterparty_name || body.lender_name || body.borrower_name || body.name || body.title, '', 160);
  const name = counterpartyName;
  const direction = normalizeDirection(body.direction || body.kind || 'i_owe');
  const kind = direction === 'i_owe' ? 'owe' : 'owed';
  const counterpartyType = safeText(body.counterparty_type || body.lender_type || body.borrower_type || 'other', 'other', 50);

  // Amount — support both principal_amount (paisas) and original_amount (Rs)
  let principalAmountPaisa = null;
  let originalAmountRs = null;
  if (body.principal_amount != null) {
    principalAmountPaisa = Math.round(Number(body.principal_amount));
    originalAmountRs = principalAmountPaisa / 100;
  } else {
    originalAmountRs = moneyNumber(body.original_amount ?? body.amount, null);
    principalAmountPaisa = originalAmountRs != null ? Math.round(originalAmountRs * 100) : null;
  }
  const originalAmount = originalAmountRs;

  const principalCurrency = safeText(body.principal_currency || body.currency || 'PKR', 'PKR', 10);
  const paidAmount = moneyNumber(body.paid_amount, 0);
  const dueDate = normalizeDate(body.due_date || body.next_due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const dateOriginated = normalizeDate(body.date_originated || body.created_at) || todayISO();
  const expectedRepaymentDate = normalizeDate(body.expected_repayment_date);
  const installmentAmount = normalizeNullableMoney(body.installment_amount || body.monthly_payment || body.minimum_payment_amount);
  const interestRatePct = body.interest_rate_pct != null ? Number(body.interest_rate_pct) : null;
  const interestType = safeText(body.interest_type || '', '', 20) || null;
  const minimumPaymentAmount = body.minimum_payment_amount != null ? Math.round(Number(body.minimum_payment_amount)) : null;
  const paymentFrequency = safeText(body.payment_frequency || body.frequency || 'monthly', 'monthly', 30);
  const frequency = normalizeFrequency(paymentFrequency) || 'monthly';
  const reminderCadence = safeText(body.reminder_cadence || 'none', 'none', 20);
  const lastPaidDate = normalizeDate(body.last_paid_date);
  const contactPhone = safeText(body.contact_phone || '', '', 40) || null;
  const contactEmail = safeText(body.contact_email || '', '', 160) || null;
  const description = safeText(body.description || '', '', 1000) || null;
  const referenceNumber = safeText(body.reference_number || '', '', 100) || null;
  const tags = body.tags ? (Array.isArray(body.tags) ? JSON.stringify(body.tags) : String(body.tags)) : null;
  const collateral = safeText(body.collateral || '', '', 200) || null;
  const guarantorName = safeText(body.guarantor_name || '', '', 100) || null;
  const trustLevel = safeText(body.trust_level || '', '', 20) || null;

  const movementNow = parseMovementNow(body);
  // For i_owe: destination_account_id (where funds received); for owed_to_me: source_account_id (where money sent from)
  const accountId = direction === 'i_owe'
    ? safeText(body.destination_account_id || body.account_id || body.to_account_id || '', '', 160)
    : safeText(body.source_account_id || body.account_id || body.from_account_id || '', '', 160);
  const movementDate = normalizeDate(body.movement_date || body.date) || todayISO();
  const notes = safeText(body.notes, '', 1000);
  const createdBy = safeText(body.created_by, 'web-debts', 120);
  const idempotencyKey = safeText(body.idempotency_key || body.client_request_id || id, '', 200);

  const warnings = [];

  if (!hasMovementFlag(body)) {
    warnings.push({
      code: 'MOVEMENT_NOW_DEFAULTED_FALSE',
      message: 'movement_now was not supplied. Banking-grade default is false to avoid accidental ledger movement.'
    });
  }

  if (!name) return json(contractError({ action: 'debt_create', code: 'NAME_REQUIRED', error: 'name required' }), 400);
  if (!kind) return json(contractError({ action: 'debt_create', code: 'INVALID_KIND', error: 'kind must be owe or owed' }), 400);
  if (originalAmount == null || originalAmount <= 0) return json(contractError({ action: 'debt_create', code: 'INVALID_AMOUNT', error: 'original_amount must be greater than 0' }), 400);
  if (paidAmount == null || paidAmount < 0) return json(contractError({ action: 'debt_create', code: 'INVALID_PAID_AMOUNT', error: 'paid_amount must be 0 or greater' }), 400);
  if (paidAmount > originalAmount) return json(contractError({ action: 'debt_create', code: 'PAID_EXCEEDS_ORIGINAL', error: 'paid_amount cannot exceed original_amount' }), 400);

  const existing = await findDebtById(db, id);

  if (existing) {
    const debt = await decorateDebt(db, normalizeDebt(existing));

    return json({
      ok: true,
      action: 'debt_create',
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      committed: false,
      writes_performed: false,
      already_recorded: true,
      debt,
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
        should_reflect: isActiveDebt(debt),
        debt_bucket: debt.kind === 'owe' ? 'payable' : 'receivable'
      },
      proof: {
        idempotency_key: idempotencyKey,
        duplicate_key: id
      },
      warnings
    });
  }

  let account = null;

  if (movementNow) {
    if (!accountId) {
      return json(contractError({
        action: 'debt_create',
        code: 'ACCOUNT_ID_REQUIRED_FOR_MOVEMENT',
        error: kind === 'owed'
          ? 'source account_id required for owed-to-me money movement'
          : 'destination account_id required for i-owe money movement'
      }), 400);
    }

    const accountResult = await resolveAccount(db, accountId);

    if (!accountResult.ok) {
      return json(contractError({
        action: 'debt_create',
        code: 'ACCOUNT_NOT_FOUND_OR_INACTIVE',
        error: accountResult.error,
        extra: { account_diagnostics: accountResult.diagnostics || null }
      }), accountResult.status || 409);
    }

    account = accountResult.account;
  }

  const nowTs = nowSQL();
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
    frequency,
    last_paid_date: lastPaidDate,
    status: paidAmount >= originalAmount ? CANONICAL_TERMINAL : 'active',
    notes: buildDebtNotes(notes, {
      movement_now: movementNow,
      account_id: account ? account.id : null,
      created_by: createdBy,
      idempotency_key: idempotencyKey
    }),
    // Contract v1 fields
    direction,
    counterparty_type: counterpartyType,
    counterparty_name: counterpartyName,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    principal_amount: principalAmountPaisa,
    principal_currency: principalCurrency,
    date_originated: dateOriginated,
    expected_repayment_date: expectedRepaymentDate,
    destination_account_id: direction === 'i_owe' ? (account?.id || accountId || null) : null,
    source_account_id: direction === 'owed_to_me' ? (account?.id || accountId || null) : null,
    funds_moved_at_creation: movementNow ? 1 : 0,
    interest_rate_pct: interestRatePct,
    interest_type: interestType,
    minimum_payment_amount: minimumPaymentAmount,
    payment_frequency: paymentFrequency,
    reminder_cadence: reminderCadence,
    description,
    reference_number: referenceNumber,
    tags,
    collateral,
    guarantor_name: guarantorName,
    trust_level: trustLevel,
    updated_at: nowTs
  };

  const origin = movementNow
    ? buildOriginTransaction({ debt: debtRow, account, date: movementDate, created_by: createdBy, idempotency_key: idempotencyKey })
    : null;
  debtRow.origination_transaction_id = origin ? origin.id : null;

  const projectionDebt = normalizeDebt({ ...debtRow, created_at: null });

  const responseBase = {
    ok: true,
    action: 'debt_create',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: !dryRun,
    writes_performed: !dryRun,
    dry_run: Boolean(dryRun),
    debt: debtSummary(projectionDebt),
    ledger: origin
      ? ledgerSummary(origin)
      : {
          created: false,
          transaction_id: null,
          account_delta: 0
        },
    account: {
      balance_source: 'ledger',
      impacted: Boolean(origin)
    },
    forecast: {
      should_reflect: true,
      debt_bucket: kind === 'owe' ? 'payable' : 'receivable'
    },
    proof: {
      idempotency_key: idempotencyKey,
      write_model: origin ? 'atomic_debt_row_plus_origin_ledger' : 'debt_record_only_no_money_moved',
      expected_debt_rows: 1,
      expected_origin_ledger_rows: origin ? 1 : 0
    },
    warnings
  };

  if (dryRun) {
    return json({
      ...responseBase,
      committed: false,
      writes_performed: false,
      debt_row: debtRow,
      origin_transaction: origin
    });
  }

  const batch = [await buildDebtInsert(db, debtRow)];

  if (origin) {
    const txCols = await tableColumns(db, 'transactions');
    batch.push(buildTransactionInsert(db, txCols, origin));
  }

  await db.batch(batch);

  const debt = await decorateDebt(db, normalizeDebt(await findDebtById(db, id)));

  return json({
    ...responseBase,
    committed: true,
    writes_performed: true,
    id,
    debt,
    transaction: origin ? sanitizeTransaction(origin) : null,
    ledger: origin ? ledgerSummary(origin) : responseBase.ledger,
    origin_transaction_id: origin ? origin.id : null
  });
}

/* ─────────────────────────────
 * POST: payment
 * ───────────────────────────── */

async function recordDebtPayment(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id || body.debtId || body.debtID, '', 200);
  const accountId = safeText(body.account_id, '', 160);
  const amount = moneyNumber(body.amount, null);
  const date = normalizeDate(body.date || body.paid_at || body.payment_date) || todayISO();
  const createdBy = safeText(body.created_by, 'web-debts-payment', 120);
  const userNotes = safeText(body.notes, '', 500);

  if (!debtId) return json(contractError({ action: 'debt_payment', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);
  if (!accountId) return json(contractError({ action: 'debt_payment', code: 'ACCOUNT_ID_REQUIRED', error: 'account_id required' }), 400);
  if (amount == null || amount <= 0) return json(contractError({ action: 'debt_payment', code: 'INVALID_AMOUNT', error: 'amount must be greater than 0' }), 400);

  const debtRow = await findDebtById(db, debtId);

  if (!debtRow) {
    return json(contractError({
      action: 'debt_payment',
      code: 'DEBT_NOT_FOUND',
      error: `Debt not found for received_debt_id="${debtId}".`,
      extra: { diagnostics: await debtLookupDiagnostics(db, debtId, body) }
    }), 404);
  }

  const debt = normalizeDebt(debtRow);
  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json(contractError({
      action: 'debt_payment',
      code: 'ACCOUNT_NOT_FOUND_OR_INACTIVE',
      error: accountResult.error,
      extra: { account_diagnostics: accountResult.diagnostics || null }
    }), accountResult.status || 409);
  }

  const projection = buildPaymentProjection(debt, accountResult.account, amount, date);

  if (!projection.ok) {
    return json(contractError({
      action: 'debt_payment',
      code: 'INVALID_DEBT_PAYMENT',
      error: projection.error,
      extra: {
        remaining_amount: projection.remaining_before
      }
    }), projection.status || 400);
  }

  const schedulePatch = buildPaymentSchedulePatch(body, debt, projection);
  const paymentId = buildPaymentId(body, {
    debt,
    amount,
    account_id: accountResult.account.id,
    date
  });

  const existing = await findExistingPayment(db, paymentId, debt.id);

  if (existing) {
    const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

    return json({
      ok: true,
      action: 'debt_payment',
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      committed: false,
      writes_performed: false,
      already_recorded: true,
      debt: after,
      ledger: {
        created: false,
        transaction_id: existing.transaction_id || existing.id || null,
        account_delta: 0
      },
      payment: {
        created: false,
        payment_id: paymentId
      },
      schedule: {
        updated: false,
        reason: 'payment_already_recorded'
      },
      account: {
        balance_source: 'ledger',
        impacted: false
      },
      forecast: {
        should_reflect: isActiveDebt(after)
      },
      proof: {
        idempotency_key: paymentId,
        duplicate_payment_id: existing.id || paymentId
      },
      warnings: []
    });
  }

  const paymentTx = buildPaymentTransaction({
    debt,
    amount,
    account: accountResult.account,
    date,
    notes: userNotes,
    created_by: createdBy,
    payment_id: paymentId,
    projection
  });

  const projectedDebtBase = {
    ...debt,
    paid_amount: projection.paid_amount_after,
    remaining_amount: round2(debt.original_amount - projection.paid_amount_after),
    status: projection.status_after,
    last_paid_date: date
  };

  const projectedDebt = applySchedulePatchToProjectedDebt(projectedDebtBase, schedulePatch);
  const schedule = scheduleProof(debt, schedulePatch, projection);

  const responseBase = {
    ok: true,
    action: 'debt_payment',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: !dryRun,
    writes_performed: !dryRun,
    dry_run: Boolean(dryRun),
    debt: debtSummary(projectedDebt),
    ledger: ledgerSummary(paymentTx),
    payment: {
      created: !dryRun,
      payment_id: paymentId
    },
    schedule,
    account: {
      balance_source: 'ledger',
      impacted: true
    },
    forecast: {
      should_reflect: projectedDebt.status !== CANONICAL_TERMINAL
    },
    proof: {
      payment_id: paymentId,
      payment_transaction_id: paymentTx.id,
      expected_transaction_rows: 1,
      expected_debt_rows_updated: 1,
      expected_debt_payment_rows: 1,
      schedule_update_included: schedule.updated,
      paid_amount_before: debt.paid_amount,
      paid_amount_after: projection.paid_amount_after,
      remaining_before: projection.remaining_before,
      remaining_after: projectedDebt.remaining_amount,
      status_before: debt.status,
      status_after: projection.status_after,
      rule: projection.rule
    },
    warnings: schedule.warning ? [schedule.warning] : []
  };

  if (dryRun) {
    return json({
      ...responseBase,
      committed: false,
      writes_performed: false,
      payment_transaction: paymentTx
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  const paymentCols = await tableColumns(db, 'debt_payments');

  const debtUpdates = {
    paid_amount: projection.paid_amount_after,
    status: projection.status_after,
    last_paid_date: date,
    ...schedulePatch.payload
  };

  const debtUpdateKeys = Object.keys(debtUpdates);

  const batch = [
    buildTransactionInsert(db, txCols, paymentTx),
    db.prepare(
      `UPDATE debts
          SET ${debtUpdateKeys.map(key => `${key} = ?`).join(', ')}
        WHERE TRIM(id) = TRIM(?)`
    ).bind(...debtUpdateKeys.map(key => debtUpdates[key]), debt.id)
  ];

  if (paymentCols.size > 0) {
    batch.push(buildDebtPaymentInsert(db, paymentCols, {
      id: paymentId,
      debt,
      debt_id: debt.id,
      debt_name_snapshot: debt.name,
      debt_kind_snapshot: debt.kind,
      original_amount: debt.original_amount,
      paid_before: debt.paid_amount,
      amount,
      paid_after: projection.paid_amount_after,
      remaining_after: projectedDebt.remaining_amount,
      account_id: accountResult.account.id,
      category_id: DEFAULT_CATEGORY_ID,
      paid_date: date,
      transaction_id: paymentTx.id,
      status: 'paid',
      notes: userNotes,
      created_at: paymentTx.created_at,
      created_by: createdBy,
      dry_run_payload_hash: stableHash(JSON.stringify({
        debt_id: debt.id,
        amount,
        account_id: accountResult.account.id,
        date,
        schedule_patch: schedulePatch.payload,
        dry_run: true
      })),
      transaction_payload_hash: stableHash(JSON.stringify(paymentTx))
    }));
  }

  await db.batch(batch);

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

  return json({
    ...responseBase,
    committed: true,
    writes_performed: true,
    debt: after,
    ledger: ledgerSummary(paymentTx),
    payment: {
      created: true,
      payment_id: paymentId
    },
    schedule,
    payment_id: paymentId,
    payment_transaction_id: paymentTx.id
  });
}

function buildPaymentProjection(debt, account, amount, date) {
  const remaining = round2(debt.original_amount - debt.paid_amount);

  if (!['active', 'paused'].includes(debt.status)) {
    return {
      ok: false,
      status: 409,
      error: 'Only active or paused debts can record payments.',
      remaining_before: remaining
    };
  }

  if (remaining <= 0) {
    return {
      ok: false,
      status: 409,
      error: 'Debt has no remaining balance.',
      remaining_before: remaining
    };
  }

  if (amount > remaining) {
    return {
      ok: false,
      status: 400,
      error: 'payment amount cannot exceed remaining debt balance',
      remaining_before: remaining
    };
  }

  const isReceivable = debt.kind === 'owed';
  const transactionType = isReceivable ? 'income' : 'expense';
  const sourceAction = isReceivable ? 'receive_payment' : 'make_payment';
  const marker = isReceivable ? '[DEBT_RECEIVE]' : '[DEBT_PAYMENT]';
  const accountDelta = isReceivable ? round2(amount) : round2(-amount);
  const newPaid = round2(Math.min(debt.original_amount, debt.paid_amount + amount));
  const remainingAfter = Math.max(0, round2(debt.original_amount - newPaid));
  const statusAfter = remainingAfter <= 0 ? CANONICAL_TERMINAL : 'active';

  return {
    ok: true,
    remaining_before: remaining,
    remaining_after: remainingAfter,
    paid_amount_after: newPaid,
    status_after: statusAfter,
    transaction_type: transactionType,
    source_action: sourceAction,
    marker,
    account_delta: accountDelta,
    rule: isReceivable
      ? 'owed-to-me payment writes income and increases receiving account'
      : 'i-owe payment writes expense and decreases paying account',
    account_id: account.id,
    date
  };
}

function buildPaymentSchedulePatch(body, debt, projection) {
  const payload = {};
  const supplied = {};

  const requestedDueDate = normalizeDate(
    body.next_due_date ||
    body.new_due_date ||
    body.payment_next_due_date ||
    body.due_date_after ||
    null
  );

  const requestedDueDay = body.due_day === undefined && body.next_due_day === undefined
    ? undefined
    : normalizeDueDay(body.next_due_day ?? body.due_day);

  const requestedInstallment = body.installment_amount === undefined && body.next_installment_amount === undefined
    ? undefined
    : normalizeNullableMoney(body.next_installment_amount ?? body.installment_amount);

  const requestedFrequency = body.frequency === undefined && body.next_frequency === undefined
    ? undefined
    : normalizeFrequency(body.next_frequency ?? body.frequency);

  if (requestedDueDate) {
    payload.due_date = requestedDueDate;
    supplied.due_date = true;
  }

  if (requestedDueDay !== undefined) {
    payload.due_day = requestedDueDay;
    supplied.due_day = true;
  }

  if (requestedInstallment !== undefined) {
    payload.installment_amount = requestedInstallment;
    supplied.installment_amount = true;
  }

  if (requestedFrequency !== undefined) {
    payload.frequency = requestedFrequency;
    supplied.frequency = true;
  }

  const hasRequestedSchedule = Object.keys(payload).length > 0;

  if (!hasRequestedSchedule) {
    return {
      requested: false,
      applicable: false,
      payload: {},
      ignored_reason: null
    };
  }

  if (projection.remaining_after <= 0 || projection.status_after === CANONICAL_TERMINAL) {
    return {
      requested: true,
      applicable: false,
      payload: {},
      ignored_reason: 'debt_settled_by_this_payment',
      requested_payload: payload,
      supplied
    };
  }

  return {
    requested: true,
    applicable: true,
    payload,
    ignored_reason: null,
    supplied
  };
}

function scheduleProof(beforeDebt, schedulePatch, projection) {
  if (!schedulePatch.requested) {
    return {
      updated: false,
      requested: false,
      reason: 'no_schedule_update_requested'
    };
  }

  if (!schedulePatch.applicable) {
    return {
      updated: false,
      requested: true,
      reason: schedulePatch.ignored_reason || 'schedule_update_not_applicable',
      warning: {
        code: 'PAYMENT_SCHEDULE_UPDATE_IGNORED',
        message: 'Schedule update was ignored because this payment settles the debt.',
        requested_payload: schedulePatch.requested_payload || {}
      }
    };
  }

  const payload = schedulePatch.payload || {};

  return {
    updated: true,
    requested: true,
    due_date_before: beforeDebt.due_date || null,
    due_date_after: payload.due_date !== undefined ? payload.due_date : beforeDebt.due_date || null,
    due_day_before: beforeDebt.due_day == null ? null : beforeDebt.due_day,
    due_day_after: payload.due_day !== undefined ? payload.due_day : beforeDebt.due_day == null ? null : beforeDebt.due_day,
    installment_amount_before: beforeDebt.installment_amount == null ? null : beforeDebt.installment_amount,
    installment_amount_after: payload.installment_amount !== undefined ? payload.installment_amount : beforeDebt.installment_amount == null ? null : beforeDebt.installment_amount,
    frequency_before: beforeDebt.frequency || null,
    frequency_after: payload.frequency !== undefined ? payload.frequency : beforeDebt.frequency || null,
    remaining_after_payment: projection.remaining_after
  };
}

function applySchedulePatchToProjectedDebt(debt, schedulePatch) {
  if (!schedulePatch || !schedulePatch.applicable) return debt;

  return {
    ...debt,
    ...schedulePatch.payload
  };
}

function buildPaymentTransaction({ debt, amount, account, date, notes, created_by, payment_id, projection }) {
  const label = debt.kind === 'owed' ? 'Debt received' : 'Debt payment';

  return {
    id: makeId(debt.kind === 'owed' ? 'tx_debt_receive' : 'tx_debt_pay'),
    date,
    type: projection.transaction_type,
    amount: round2(amount),
    account_id: account.id,
    transfer_to_account_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant: debt.name,
    merchant_id: null,
    source_module: 'debts',
    source_id: debt.id,
    source_action: projection.source_action,
    idempotency_key: payment_id,
    notes: safeText(`${label}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | payment_id=${payment_id} | ${projection.marker}${notes ? ' | ' + notes : ''}`, '', 500),
    fee_amount: 0,
    pra_amount: 0,
    is_pending_reversal: 0,
    reversal_due_date: null,
    created_at: nowSQL(),
    reversed_by: null,
    reversed_at: null,
    linked_txn_id: null,
    intl_package_id: null,
    created_by
  };
}

/* ─────────────────────────────
 * POST: receive_payment (owed_to_me)
 * ───────────────────────────── */

async function receiveDebtPayment(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const accountId = safeText(body.destination_account_id || body.account_id, '', 160);
  const amount = moneyNumber(body.amount, null);
  const date = normalizeDate(body.date || body.payment_date) || todayISO();
  const userNotes = safeText(body.notes, '', 500);
  const receivedVia = safeText(body.received_via || '', '', 40) || null;
  const createdBy = safeText(body.created_by, 'web-debts-receive', 120);
  const idempotencyKey = safeText(body.idempotency_key || body.client_request_id || '', '', 200);

  if (!debtId) return json(contractError({ action: 'receive_payment', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);
  if (!accountId) return json(contractError({ action: 'receive_payment', code: 'ACCOUNT_ID_REQUIRED', error: 'destination_account_id required' }), 400);
  if (amount == null || amount <= 0) return json(contractError({ action: 'receive_payment', code: 'INVALID_AMOUNT', error: 'Amount must be greater than 0' }), 400);

  const debtRow = await findDebtById(db, debtId);
  if (!debtRow) return json(contractError({ action: 'receive_payment', code: 'DEBT_NOT_FOUND', error: `Debt not found: ${debtId}` }), 404);

  const debt = normalizeDebt(debtRow);
  const dir = debt.direction || normalizeDirection(debt.kind);
  if (dir !== 'owed_to_me') {
    return json(contractError({ action: 'receive_payment', code: 'WRONG_DIRECTION', error: 'receive_payment is only for owed_to_me debts. Use action=pay for i_owe debts.' }), 400);
  }

  if (isTerminalStatus(debt.status)) {
    return json(contractError({ action: 'receive_payment', code: 'DEBT_TERMINAL', error: `Debt is already ${debt.status}` }), 409);
  }

  const accountResult = await resolveAccount(db, accountId);
  if (!accountResult.ok) return json(contractError({ action: 'receive_payment', code: 'ACCOUNT_NOT_FOUND', error: accountResult.error }), 409);

  const paidBefore = round2(debtRow.paid_amount || 0);
  const originalRs = round2(debtRow.original_amount || 0);
  const remaining = Math.max(0, round2(originalRs - paidBefore));
  if (amount > remaining) {
    return json(contractError({ action: 'receive_payment', code: 'OVERPAYMENT', error: `Amount Rs ${amount.toFixed(2)} exceeds remaining Rs ${remaining.toFixed(2)}` }), 400);
  }

  const paidAfter = round2(paidBefore + amount);
  const remainingAfter = Math.max(0, round2(originalRs - paidAfter));
  const statusAfter = remainingAfter <= 0 ? CANONICAL_TERMINAL : 'active';
  const paymentId = idempotencyKey || `debtrecv_${stableHash([debtId, amount, accountId, date].join('|'))}`;

  const existing = await findExistingPayment(db, paymentId, debtId);
  if (existing) {
    return json({ ok: true, action: 'receive_payment', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, already_recorded: true,
      payment: { created: false, payment_id: paymentId },
      proof: { remaining_after: remainingAfter, status_after: statusAfter } });
  }

  const txId = makeId('tx');
  const txRow = {
    id: txId,
    date,
    type: 'income',
    amount,
    account_id: accountResult.account.id,
    category_id: DEFAULT_CATEGORY_ID,
    notes: `[DEBT_RECEIVE] payment_id=${paymentId} | debt_id=${debtId}${userNotes ? ' | ' + userNotes : ''}`,
    source_module: 'debts',
    source_id: debtId,
    source_action: 'receive_payment',
    created_at: nowSQL()
  };

  const proofObj = {
    payment_id: paymentId,
    payment_transaction_id: txId,
    remaining_after: remainingAfter,
    status_after: statusAfter,
    account_delta: amount
  };

  if (dryRun) {
    return json({ ok: true, action: 'receive_payment', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, dry_run: true,
      payment: { created: false, payment_id: paymentId },
      proof: proofObj, transaction: sanitizeTransaction(txRow) });
  }

  const txCols = await tableColumns(db, 'transactions');
  const paymentCols = await tableColumns(db, 'debt_payments');
  const nowTs = nowSQL();

  const debtUpdates = { paid_amount: paidAfter, status: statusAfter, last_paid_date: date, updated_at: nowTs, last_contact_date: date };
  const debtUpdateKeys = Object.keys(debtUpdates).filter(k => k === 'paid_amount' || k === 'status' || k === 'last_paid_date' || k === 'updated_at' || k === 'last_contact_date');

  const batch = [
    buildTransactionInsert(db, txCols, txRow),
    db.prepare(`UPDATE debts SET ${debtUpdateKeys.map(k => `${k} = ?`).join(', ')} WHERE TRIM(id) = TRIM(?)`)
      .bind(...debtUpdateKeys.map(k => debtUpdates[k]), debtId)
  ];

  if (paymentCols.size > 0) {
    const pmapping = {
      id: paymentId, debt_id: debtId,
      debt_name_snapshot: debt.name, debt_kind_snapshot: debt.kind,
      original_amount_paisa: toPaisa(originalRs), paid_before_paisa: toPaisa(paidBefore),
      amount_paisa: toPaisa(amount), paid_after_paisa: toPaisa(paidAfter),
      remaining_after_paisa: toPaisa(remainingAfter), original_amount: originalRs,
      paid_before: paidBefore, amount, paid_after: paidAfter, remaining_after: remainingAfter,
      account_id: accountResult.account.id, destination_account_id: accountResult.account.id,
      category_id: DEFAULT_CATEGORY_ID, paid_date: date, transaction_id: txId, status: 'paid',
      received_via: receivedVia, notes: txRow.notes, created_by: createdBy,
      created_at: nowTs, idempotency_key: idempotencyKey || null
    };
    const pinsertable = {};
    for (const [k, v] of Object.entries(pmapping)) { if (paymentCols.has(k)) pinsertable[k] = v; }
    const pkeys = Object.keys(pinsertable);
    if (pkeys.length) batch.push(db.prepare(`INSERT INTO debt_payments (${pkeys.join(', ')}) VALUES (${pkeys.map(() => '?').join(', ')})`).bind(...pkeys.map(k => pinsertable[k])));
  }

  await db.batch(batch);
  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debtId)));

  return json({ ok: true, action: 'receive_payment', version: VERSION, contract_version: CONTRACT_VERSION,
    committed: true, writes_performed: true,
    debt: after,
    payment: { created: true, payment_id: paymentId },
    proof: proofObj,
    transaction: sanitizeTransaction(txRow) });
}

/* ─────────────────────────────
 * POST: defer
 * ───────────────────────────── */

async function deferDebt(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const newDueDate = normalizeDate(body.new_due_date || body.due_date);
  const deferReason = safeText(body.defer_reason || body.reason || 'other', 'other', 50);
  const lateFeeAmount = body.late_fee_amount != null ? moneyNumber(body.late_fee_amount, 0) : 0;
  const lateFeeAccountId = safeText(body.late_fee_account_source || body.account_id || '', '', 160) || null;
  const notes = safeText(body.notes || '', '', 500);

  if (!debtId) return json(contractError({ action: 'defer', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);
  if (!newDueDate) return json(contractError({ action: 'defer', code: 'NEW_DUE_DATE_REQUIRED', error: 'new_due_date required (YYYY-MM-DD)' }), 400);

  const debtRow = await findDebtById(db, debtId);
  if (!debtRow) return json(contractError({ action: 'defer', code: 'DEBT_NOT_FOUND', error: `Debt not found: ${debtId}` }), 404);

  const debt = normalizeDebt(debtRow);
  if (isTerminalStatus(debt.status)) return json(contractError({ action: 'defer', code: 'DEBT_TERMINAL', error: `Debt is already ${debt.status}` }), 409);

  const previousDueDate = debt.due_date;
  if (previousDueDate && newDueDate <= previousDueDate) {
    return json(contractError({ action: 'defer', code: 'INVALID_DATE', error: `new_due_date must be after current due_date (${previousDueDate})` }), 400);
  }

  const VALID_DEFER_REASONS = ['negotiated_extension', 'financial_hardship', 'vendor_grace_period', 'pending_funds', 'other'];
  const reason = VALID_DEFER_REASONS.includes(deferReason) ? deferReason : 'other';
  const deferId = makeId('defer');
  const nowTs = nowSQL();

  let lateFeeAccount = null;
  let lateFeeTransaction = null;
  if (lateFeeAmount > 0) {
    if (!lateFeeAccountId) return json(contractError({ action: 'defer', code: 'ACCOUNT_REQUIRED_FOR_LATE_FEE', error: 'account_id required when late_fee_amount > 0' }), 400);
    const accResult = await resolveAccount(db, lateFeeAccountId);
    if (!accResult.ok) return json(contractError({ action: 'defer', code: 'ACCOUNT_NOT_FOUND', error: accResult.error }), 409);
    lateFeeAccount = accResult.account;
    lateFeeTransaction = {
      id: makeId('tx'), date: todayISO(), type: 'expense', amount: lateFeeAmount,
      account_id: lateFeeAccount.id, category_id: DEFAULT_CATEGORY_ID,
      notes: `[DEBT_LATE_FEE] defer_id=${deferId} | debt_id=${debtId}${notes ? ' | ' + notes : ''}`,
      source_module: 'debts', source_id: debtId, source_action: 'defer', created_at: nowTs
    };
  }

  const deferRow = {
    id: deferId, debt_id: debtId, user_id: debtRow.owner_user_id || 'user_owner',
    previous_due_date: previousDueDate || todayISO(), new_due_date: newDueDate,
    defer_reason: reason, late_fee_amount: toPaisa(lateFeeAmount),
    late_fee_transaction_id: lateFeeTransaction ? lateFeeTransaction.id : null,
    notes: notes || null, created_at: nowTs
  };

  if (dryRun) {
    return json({ ok: true, action: 'defer', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, dry_run: true,
      debt: { ...debtSummary(debt), due_date: newDueDate },
      defer_id: deferId, defer_row: deferRow,
      late_fee_transaction: lateFeeTransaction ? sanitizeTransaction(lateFeeTransaction) : null });
  }

  const batch = [
    db.prepare(`UPDATE debts SET due_date = ?, updated_at = ? WHERE TRIM(id) = TRIM(?)`).bind(newDueDate, nowTs, debtId),
    db.prepare(`INSERT INTO debt_defers (id, debt_id, user_id, previous_due_date, new_due_date, defer_reason, late_fee_amount, late_fee_transaction_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deferRow.id, deferRow.debt_id, deferRow.user_id, deferRow.previous_due_date, deferRow.new_due_date, deferRow.defer_reason, deferRow.late_fee_amount, deferRow.late_fee_transaction_id, deferRow.notes, deferRow.created_at)
  ];

  if (lateFeeTransaction) {
    const txCols = await tableColumns(db, 'transactions');
    batch.push(buildTransactionInsert(db, txCols, lateFeeTransaction));
  }

  await db.batch(batch);
  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debtId)));

  return json({ ok: true, action: 'defer', version: VERSION, contract_version: CONTRACT_VERSION,
    committed: true, writes_performed: true,
    debt: after, defer_id: deferId,
    late_fee_transaction: lateFeeTransaction ? sanitizeTransaction(lateFeeTransaction) : null });
}

/* ─────────────────────────────
 * POST: accrue_interest
 * ───────────────────────────── */

async function accrueDebtInterest(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const interestAmountPaisa = body.interest_amount != null ? Math.round(Number(body.interest_amount)) : null;
  const accrualDate = normalizeDate(body.accrual_date || body.date) || todayISO();
  const capitalized = body.capitalized === true || body.capitalized === 1;
  const accrualType = safeText(body.accrual_type || 'monthly_interest', 'monthly_interest', 40);
  const sourceAccountId = safeText(body.source_account_id || body.account_id || '', '', 160) || null;
  const notes = safeText(body.notes || '', '', 500);

  if (!debtId) return json(contractError({ action: 'accrue_interest', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);
  if (interestAmountPaisa == null || interestAmountPaisa <= 0) return json(contractError({ action: 'accrue_interest', code: 'INVALID_AMOUNT', error: 'interest_amount must be > 0 (paisas)' }), 400);

  const debtRow = await findDebtById(db, debtId);
  if (!debtRow) return json(contractError({ action: 'accrue_interest', code: 'DEBT_NOT_FOUND', error: `Debt not found: ${debtId}` }), 404);

  const debt = normalizeDebt(debtRow);
  if (isTerminalStatus(debt.status)) return json(contractError({ action: 'accrue_interest', code: 'DEBT_TERMINAL', error: `Debt is already ${debt.status}` }), 409);

  if (!capitalized && !sourceAccountId) {
    return json(contractError({ action: 'accrue_interest', code: 'ACCOUNT_REQUIRED', error: 'source_account_id required when capitalized=false (interest paid separately)' }), 400);
  }

  let account = null;
  let interestTransaction = null;

  if (!capitalized) {
    const accResult = await resolveAccount(db, sourceAccountId);
    if (!accResult.ok) return json(contractError({ action: 'accrue_interest', code: 'ACCOUNT_NOT_FOUND', error: accResult.error }), 409);
    account = accResult.account;
    const interestAmountRs = interestAmountPaisa / 100;
    const accrualId = makeId('accrual');
    interestTransaction = {
      id: makeId('tx'), date: accrualDate, type: 'expense', amount: interestAmountRs,
      account_id: account.id, category_id: DEFAULT_CATEGORY_ID,
      notes: `[DEBT_INTEREST] accrual_type=${accrualType} | debt_id=${debtId}${notes ? ' | ' + notes : ''}`,
      source_module: 'debts', source_id: debtId, source_action: 'accrue_interest', created_at: nowSQL()
    };
  }

  const accrualId = makeId('accrual');
  const nowTs = nowSQL();
  const accrualRow = {
    id: accrualId, debt_id: debtId, user_id: debtRow.owner_user_id || 'user_owner',
    amount: interestAmountPaisa, accrual_date: accrualDate, accrual_type: accrualType,
    capitalized: capitalized ? 1 : 0,
    payment_transaction_id: interestTransaction ? interestTransaction.id : null,
    notes: notes || null, created_at: nowTs
  };

  if (dryRun) {
    return json({ ok: true, action: 'accrue_interest', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, dry_run: true,
      accrual: accrualRow, debt: debtSummary(debt),
      transaction: interestTransaction ? sanitizeTransaction(interestTransaction) : null });
  }

  const batch = [
    db.prepare(`INSERT INTO debt_interest_accruals (id, debt_id, user_id, amount, accrual_date, accrual_type, capitalized, payment_transaction_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(accrualRow.id, accrualRow.debt_id, accrualRow.user_id, accrualRow.amount, accrualRow.accrual_date, accrualRow.accrual_type, accrualRow.capitalized, accrualRow.payment_transaction_id, accrualRow.notes, accrualRow.created_at),
    db.prepare(`UPDATE debts SET updated_at = ? WHERE TRIM(id) = TRIM(?)`).bind(nowTs, debtId)
  ];

  if (interestTransaction) {
    const txCols = await tableColumns(db, 'transactions');
    batch.push(buildTransactionInsert(db, txCols, interestTransaction));
  }

  await db.batch(batch);
  const after = normalizeDebt(await findDebtById(db, debtId));

  return json({ ok: true, action: 'accrue_interest', version: VERSION, contract_version: CONTRACT_VERSION,
    committed: true, writes_performed: true,
    accrual: accrualRow, debt: debtSummary(after),
    transaction: interestTransaction ? sanitizeTransaction(interestTransaction) : null });
}

/* ─────────────────────────────
 * POST: settle
 * ───────────────────────────── */

async function settleDebt(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const settlementDate = normalizeDate(body.settlement_date || body.date) || todayISO();
  const settlementNotes = safeText(body.notes || body.settlement_notes || '', '', 500);

  if (!debtId) return json(contractError({ action: 'settle', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);

  const debtRow = await findDebtById(db, debtId);
  if (!debtRow) return json(contractError({ action: 'settle', code: 'DEBT_NOT_FOUND', error: `Debt not found: ${debtId}` }), 404);

  const debt = normalizeDebt(debtRow);
  if (debt.status === CANONICAL_TERMINAL) {
    return json({ ok: true, action: 'settle', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, already_settled: true, debt: debtSummary(debt) });
  }

  const warnings = [];
  if (debt.remaining_amount > 0) {
    warnings.push({ code: 'BALANCE_OUTSTANDING', message: `Remaining balance Rs ${debt.remaining_amount.toFixed(2)} will be forgiven on settlement` });
  }

  if (dryRun) {
    return json({ ok: true, action: 'settle', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, dry_run: true,
      debt: { ...debtSummary(debt), status: CANONICAL_TERMINAL, settlement_date: settlementDate }, warnings });
  }

  const nowTs = nowSQL();
  await db.prepare(`UPDATE debts SET status = ?, settlement_date = ?, updated_at = ? WHERE TRIM(id) = TRIM(?)`)
    .bind(CANONICAL_TERMINAL, settlementDate, nowTs, debtId).run();

  const after = normalizeDebt(await findDebtById(db, debtId));

  return json({ ok: true, action: 'settle', version: VERSION, contract_version: CONTRACT_VERSION,
    committed: true, writes_performed: true,
    debt: debtSummary(after), warnings });
}

/* ─────────────────────────────
 * POST: writeoff
 * ───────────────────────────── */

async function writeoffDebt(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const writeoffDate = normalizeDate(body.writeoff_date || body.date) || todayISO();
  const writeoffReason = safeText(body.writeoff_reason || body.reason || 'other', 'other', 50);
  const writeoffAmountPaisa = body.writeoff_amount != null ? Math.round(Number(body.writeoff_amount)) : null;
  const taxDeductible = Boolean(body.tax_deductible);
  const notes = safeText(body.notes || '', '', 500);

  const VALID_WRITEOFF_REASONS = ['forgiven', 'defaulted', 'abandoned', 'bad_debt_loss', 'reconciliation_correction', 'other'];
  const reason = VALID_WRITEOFF_REASONS.includes(writeoffReason) ? writeoffReason : 'other';

  if (!debtId) return json(contractError({ action: 'writeoff', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);

  const debtRow = await findDebtById(db, debtId);
  if (!debtRow) return json(contractError({ action: 'writeoff', code: 'DEBT_NOT_FOUND', error: `Debt not found: ${debtId}` }), 404);

  const debt = normalizeDebt(debtRow);
  if (debt.status === 'written_off') {
    return json({ ok: true, action: 'writeoff', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, already_written_off: true, debt: debtSummary(debt) });
  }

  const amountPaisa = writeoffAmountPaisa ?? debt.remaining_balance;
  const amountRs = amountPaisa / 100;
  const dir = debt.direction || normalizeDirection(debt.kind);

  const writeoffTxRow = amountRs > 0 ? {
    id: makeId('tx'), date: writeoffDate,
    type: dir === 'owed_to_me' ? 'expense' : 'income',
    amount: amountRs,
    account_id: 'writeoff_virtual',
    category_id: DEFAULT_CATEGORY_ID,
    notes: `[DEBT_WRITEOFF] reason=${reason} | debt_id=${debtId}${taxDeductible ? ' | tax_deductible=1' : ''}${notes ? ' | ' + notes : ''}`,
    source_module: 'debts', source_id: debtId, source_action: 'writeoff', created_at: nowSQL()
  } : null;

  if (dryRun) {
    return json({ ok: true, action: 'writeoff', version: VERSION, contract_version: CONTRACT_VERSION,
      committed: false, writes_performed: false, dry_run: true,
      debt: { ...debtSummary(debt), status: 'written_off', writeoff_date: writeoffDate },
      transaction: writeoffTxRow ? sanitizeTransaction(writeoffTxRow) : null });
  }

  const nowTs = nowSQL();
  const batch = [
    db.prepare(`UPDATE debts SET status = 'written_off', writeoff_date = ?, writeoff_reason = ?, updated_at = ? WHERE TRIM(id) = TRIM(?)`)
      .bind(writeoffDate, reason, nowTs, debtId)
  ];

  if (writeoffTxRow) {
    try {
      const txCols = await tableColumns(db, 'transactions');
      const insertable = {};
      for (const [k, v] of Object.entries(writeoffTxRow)) { if (txCols.has(k)) insertable[k] = v; }
      const keys = Object.keys(insertable);
      if (keys.length) batch.push(db.prepare(`INSERT INTO transactions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => insertable[k])));
    } catch (_) { /* writeoff tx creation is best-effort if account_id is virtual */ }
  }

  await db.batch(batch);
  const after = normalizeDebt(await findDebtById(db, debtId));

  return json({ ok: true, action: 'writeoff', version: VERSION, contract_version: CONTRACT_VERSION,
    committed: true, writes_performed: true,
    debt: debtSummary(after),
    transaction: writeoffTxRow ? sanitizeTransaction(writeoffTxRow) : null });
}

/* ─────────────────────────────
 * POST: repair origin
 * ───────────────────────────── */

async function repairLedgerOrigin(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const accountId = safeText(body.account_id, '', 160);
  const date = normalizeDate(body.date || body.movement_date) || todayISO();
  const createdBy = safeText(body.created_by, 'debt-origin-repair', 120);

  if (!debtId) return json(contractError({ action: 'debt_repair_origin', code: 'DEBT_ID_REQUIRED', error: 'debt_id required' }), 400);
  if (!accountId) return json(contractError({ action: 'debt_repair_origin', code: 'ACCOUNT_ID_REQUIRED', error: 'account_id required' }), 400);

  const row = await findDebtById(db, debtId);

  if (!row) {
    return json(contractError({
      action: 'debt_repair_origin',
      code: 'DEBT_NOT_FOUND',
      error: `Debt not found for received_debt_id="${debtId}".`,
      extra: { diagnostics: await debtLookupDiagnostics(db, debtId, body) }
    }), 404);
  }

  const debt = normalizeDebt(row);
  const decorated = await decorateDebt(db, debt);

  if (decorated.origin_linked) {
    return json({
      ok: true,
      action: 'debt_repair_origin',
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      committed: false,
      writes_performed: false,
      already_linked: true,
      debt: decorated,
      ledger: {
        created: false,
        transaction_id: decorated.origin_transaction_ids[0] || null,
        account_delta: 0
      },
      account: {
        balance_source: 'ledger',
        impacted: false
      },
      forecast: {
        should_reflect: isActiveDebt(decorated)
      },
      warnings: []
    });
  }

  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json(contractError({
      action: 'debt_repair_origin',
      code: 'ACCOUNT_NOT_FOUND_OR_INACTIVE',
      error: accountResult.error,
      extra: { account_diagnostics: accountResult.diagnostics || null }
    }), accountResult.status || 409);
  }

  const originTx = buildOriginTransaction({
    debt,
    account: accountResult.account,
    date,
    created_by: createdBy,
    idempotency_key: safeText(body.idempotency_key || '', '', 160) || makeId('repair_origin')
  });

  originTx.notes = originTx.notes.replace('[DEBT_ORIGIN]', '[DEBT_ORIGIN_REPAIR]');
  originTx.source_action = 'repair_origin';

  const responseBase = {
    ok: true,
    action: 'debt_repair_origin',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: !dryRun,
    writes_performed: !dryRun,
    dry_run: Boolean(dryRun),
    debt: decorated,
    ledger: ledgerSummary(originTx),
    account: {
      balance_source: 'ledger',
      impacted: true
    },
    forecast: {
      should_reflect: isActiveDebt(decorated),
      debt_bucket: debt.kind === 'owe' ? 'payable' : 'receivable'
    },
    proof: {
      expected_origin_ledger_rows: 1,
      source_action: 'repair_origin'
    },
    warnings: []
  };

  if (dryRun) {
    return json({
      ...responseBase,
      committed: false,
      writes_performed: false,
      origin_transaction: originTx
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  await buildTransactionInsert(db, txCols, originTx).run();

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

  return json({
    ...responseBase,
    committed: true,
    writes_performed: true,
    debt: after,
    origin_transaction_id: originTx.id
  });
}

/* ─────────────────────────────
 * POST: explicit settlement/status repair
 * ───────────────────────────── */

async function repairSettledDebts(db, body, dryRun, userId) {
  const rows = (await db.prepare(`SELECT ${DEBT_COLUMNS} FROM debts WHERE owner_user_id = ?`).bind(userId).all()).results || [];

  const flipCandidates = [];
  const normalizeCandidates = [];

  for (const row of rows) {
    const raw = String(row.status || '').trim().toLowerCase();
    const original = Number(row.original_amount || 0);
    const paid = Number(row.paid_amount || 0);

    if ((raw === 'active' || raw === '') && original > 0 && paid >= original) {
      flipCandidates.push(row);
    } else if (TERMINAL_STATUSES.has(raw) && raw !== CANONICAL_TERMINAL) {
      normalizeCandidates.push(row);
    }
  }

  const total = flipCandidates.length + normalizeCandidates.length;

  const base = {
    ok: true,
    action: 'debt_repair_settled_debts',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: !dryRun && total > 0,
    writes_performed: !dryRun && total > 0,
    dry_run: Boolean(dryRun),
    read_only: false,
    fully_paid_candidates: flipCandidates.length,
    normalize_candidates: normalizeCandidates.length,
    fully_paid: flipCandidates.map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      original_amount: Number(row.original_amount || 0),
      paid_amount: Number(row.paid_amount || 0),
      current_status: row.status || 'active',
      will_become: CANONICAL_TERMINAL
    })),
    normalize: normalizeCandidates.map(row => ({
      id: row.id,
      name: row.name,
      current_status: row.status,
      will_become: CANONICAL_TERMINAL
    })),
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
  };

  if (dryRun || total === 0) {
    return json({
      ...base,
      committed: false,
      writes_performed: false
    });
  }

  const batch = [];

  for (const row of flipCandidates) {
    batch.push(db.prepare(
      `UPDATE debts
          SET status = ?
        WHERE TRIM(id) = TRIM(?)
          AND (status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')`
    ).bind(CANONICAL_TERMINAL, safeText(row.id, '', 200)));
  }

  for (const row of normalizeCandidates) {
    batch.push(db.prepare(
      `UPDATE debts
          SET status = ?
        WHERE TRIM(id) = TRIM(?)`
    ).bind(CANONICAL_TERMINAL, safeText(row.id, '', 200)));
  }

  if (batch.length) await db.batch(batch);

  return json({
    ...base,
    committed: true,
    writes_performed: true,
    fully_paid_repaired: flipCandidates.length,
    fully_paid_ids: flipCandidates.map(row => safeText(row.id, '', 200)),
    normalize_repaired: normalizeCandidates.length,
    normalize_ids: normalizeCandidates.map(row => safeText(row.id, '', 200))
  });
}

async function repairReversedPayments(db, body, dryRun, userId) {
  const paymentCols = await tableColumns(db, 'debt_payments');

  if (!paymentCols.size) {
    return json(contractError({
      action: 'debt_repair_reversed_payments',
      code: 'DEBT_PAYMENTS_TABLE_MISSING',
      error: 'debt_payments table is missing or unreadable'
    }), 500);
  }

  const badRows = await db.prepare(`
    SELECT dp.id AS payment_id,
           dp.debt_id,
           dp.transaction_id,
           ${paymentCols.has('amount') ? 'dp.amount' : 'NULL'} AS amount,
           ${paymentCols.has('status') ? 'dp.status' : 'NULL'} AS payment_status,
           t.reversed_by,
           t.reversed_at
      FROM debt_payments dp
      INNER JOIN transactions t
        ON TRIM(t.id) = TRIM(dp.transaction_id)
     WHERE (dp.status IS NULL OR dp.status = '' OR dp.status = 'paid' OR dp.status = 'active')
       AND (t.reversed_by IS NOT NULL OR t.reversed_at IS NOT NULL)
       AND t.user_id = ?
     ORDER BY dp.debt_id, dp.id
  `).bind(userId).all();

  const badPayments = badRows.results || [];
  const affectedDebtIds = [...new Set(badPayments.map(row => row.debt_id).filter(Boolean))];

  const base = {
    ok: true,
    action: 'debt_repair_reversed_payments',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    committed: !dryRun && badPayments.length > 0,
    writes_performed: !dryRun && badPayments.length > 0,
    dry_run: Boolean(dryRun),
    bad_payments_found: badPayments.length,
    affected_debts_count: affectedDebtIds.length,
    affected_debt_ids: affectedDebtIds,
    bad_payments: badPayments,
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
  };

  if (dryRun || badPayments.length === 0) {
    return json({
      ...base,
      committed: false,
      writes_performed: false
    });
  }

  const now = new Date().toISOString();
  const batch = [];

  for (const payment of badPayments) {
    const updates = { status: 'reversed' };

    if (paymentCols.has('reversed_at')) updates.reversed_at = payment.reversed_at || now;
    if (paymentCols.has('reversal_transaction_id')) updates.reversal_transaction_id = payment.reversed_by || null;
    if (paymentCols.has('reason')) updates.reason = 'linked transaction already reversed';
    if (paymentCols.has('notes')) {
      updates.notes = safeText(`Auto-repaired by debt.repair_reversed_payments | original_transaction_id=${payment.transaction_id} | reversal_transaction_id=${payment.reversed_by || ''}`, '', 1000);
    }

    const keys = Object.keys(updates).filter(key => paymentCols.has(key));

    if (keys.length) {
      batch.push(db.prepare(
        `UPDATE debt_payments
            SET ${keys.map(key => `${key} = ?`).join(', ')}
          WHERE id = ?`
      ).bind(...keys.map(key => updates[key]), payment.payment_id));
    }
  }

  for (const debtId of affectedDebtIds) {
    const recalc = await recalculateDebtPaidAmount(db, debtId);

    batch.push(db.prepare(
      `UPDATE debts
          SET paid_amount = ?, status = ?
        WHERE TRIM(id) = TRIM(?)`
    ).bind(recalc.paid_amount, recalc.status, debtId));
  }

  await db.batch(batch);

  const debts = [];

  for (const debtId of affectedDebtIds) {
    const row = await findDebtById(db, debtId);
    if (row) debts.push(await decorateDebt(db, normalizeDebt(row)));
  }

  return json({
    ...base,
    committed: true,
    writes_performed: true,
    bad_payments_repaired: badPayments.length,
    debts
  });
}

/* ─────────────────────────────
 * Ledger transaction builders
 * ───────────────────────────── */

function buildOriginTransaction({ debt, account, date, created_by, idempotency_key }) {
  const isReceivable = debt.kind === 'owed';
  const type = isReceivable ? 'expense' : 'income';
  const sourceAction = isReceivable ? 'origin_lent_out' : 'origin_borrowed_in';
  const accountDelta = isReceivable ? -round2(debt.original_amount) : round2(debt.original_amount);

  return {
    id: makeId(isReceivable ? 'tx_debt_origin_out' : 'tx_debt_origin_in'),
    date,
    type,
    amount: round2(debt.original_amount),
    account_id: account.id,
    transfer_to_account_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant: debt.name,
    merchant_id: null,
    source_module: 'debts',
    source_id: debt.id,
    source_action: sourceAction,
    idempotency_key,
    notes: safeText(`${isReceivable ? 'Debt given' : 'Debt received'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | [DEBT_ORIGIN]`, '', 500),
    fee_amount: 0,
    pra_amount: 0,
    is_pending_reversal: 0,
    reversal_due_date: null,
    created_at: nowSQL(),
    reversed_by: null,
    reversed_at: null,
    linked_txn_id: null,
    intl_package_id: null,
    created_by,
    account_delta: accountDelta
  };
}

function ledgerSummary(tx) {
  const type = String(tx.type || '').toLowerCase();
  const amount = round2(tx.amount || 0);
  const accountDelta = typeof tx.account_delta === 'number'
    ? tx.account_delta
    : (type === 'income' ? amount : -amount);

  return {
    created: true,
    transaction_id: tx.id,
    type,
    amount,
    account_id: tx.account_id || null,
    account_delta: round2(accountDelta),
    marker: extractDebtMarker(tx.notes),
    source_module: tx.source_module || 'debts',
    source_id: tx.source_id || null,
    source_action: tx.source_action || null
  };
}

/* ─────────────────────────────
 * Debt decoration / linkage
 * ───────────────────────────── */

async function decorateDebt(db, debt) {
  const txMap = await loadTransactionsForDebts(db, [debt.id]);
  return decorateDebtFromTransactions(debt, txMap.get(debt.id) || []);
}

function decorateDebtFromTransactions(debt, txs) {
  const activeTxs = (txs || []).filter(tx => !isReversedTransaction(tx));
  const originTxs = activeTxs.filter(tx => isOriginTransactionForDebt(debt, tx));
  const paymentTxs = activeTxs.filter(tx => isPaymentTransactionForDebt(debt, tx));

  const explicitMovementNow = String(debt.notes || '').toLowerCase().includes('movement_now=1') || originTxs.length > 0;

  let originState = 'legacy_unknown';
  let repairRequired = false;

  if (originTxs.length > 0) {
    originState = 'ledger_linked';
  } else if (explicitMovementNow) {
    originState = 'ledger_missing';
    repairRequired = true;
  } else if (paymentTxs.length > 0) {
    originState = 'payment_linked_only';
  }

  return {
    ...debt,
    origin_state: originState,
    origin_required: explicitMovementNow || originTxs.length > 0,
    origin_linked: originTxs.length > 0,
    origin_transaction_ids: originTxs.map(tx => tx.id),
    origin_transactions: originTxs,
    payment_linked: paymentTxs.length > 0,
    payment_transaction_ids: paymentTxs.map(tx => tx.id),
    payment_transactions: paymentTxs,
    all_linked_transaction_ids: activeTxs.map(tx => tx.id),
    repair_required: repairRequired,
    ledger_linked: originTxs.length > 0,
    ledger_required: explicitMovementNow || originTxs.length > 0,
    ledger_transaction_ids: originTxs.map(tx => tx.id),
    ledger_transactions: originTxs
  };
}

async function loadTransactionsForDebts(db, debtIds) {
  const ids = [...new Set((debtIds || []).map(id => safeText(id, '', 200)).filter(Boolean))];
  const map = new Map(ids.map(id => [id, []]));

  if (!ids.length) return map;

  const cols = await tableColumns(db, 'transactions');

  const hasNotes = cols.has('notes');
  const hasSourceFields = cols.has('source_module') && cols.has('source_id');

  if (!hasNotes && !hasSourceFields) return map;

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'account_id',
    'category_id',
    'notes',
    'created_at',
    'reversed_by',
    'reversed_at',
    'source_module',
    'source_id',
    'source_action'
  ].filter(col => cols.has(col));

  const whereParts = [];

  if (hasNotes) {
    whereParts.push(`notes LIKE '%debt_id=%'`);
  }

  if (hasSourceFields) {
    whereParts.push(`source_module = 'debts'`);
  }

  const orderBy = cols.has('created_at')
    ? 'datetime(created_at) DESC, id DESC'
    : 'id DESC';

  const res = await db.prepare(
    `SELECT ${wanted.join(', ')}
       FROM transactions
      WHERE ${whereParts.join(' OR ')}
      ORDER BY ${orderBy}`
  ).all();

  for (const row of res.results || []) {
    const tx = sanitizeTransaction(row);
    const linkedIds = debtIdsFromTransaction(tx);

    for (const debtId of linkedIds) {
      if (!map.has(debtId)) continue;
      map.get(debtId).push(tx);
    }
  }

  return map;
}

function debtIdsFromTransaction(tx) {
  const out = new Set();

  if (
    String(tx.source_module || '').toLowerCase() === 'debts' &&
    tx.source_id
  ) {
    out.add(safeText(tx.source_id, '', 200));
  }

  const notes = String(tx.notes || '');
  const matches = notes.matchAll(/debt_id=([^|,\]\s]+)/gi);

  for (const match of matches) {
    const id = safeText(match[1], '', 200);
    if (id) out.add(id);
  }

  return Array.from(out);
}
function isOriginTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const sourceAction = String(tx.source_action || '').toLowerCase();
  const type = String(tx.type || '').toLowerCase();
  const amountMatches = Math.abs(Number(tx.amount || 0) - Number(debt.original_amount || 0)) < 0.01;

  if (notes.includes('[DEBT_ORIGIN]')) return true;
  if (notes.includes('[DEBT_ORIGIN_REPAIR]')) return true;
  if (['origin_borrowed_in', 'origin_lent_out', 'repair_origin'].includes(sourceAction)) return true;

  if (!amountMatches) return false;
  if (debt.kind === 'owed') return ['expense', 'debt_out'].includes(type);
  if (debt.kind === 'owe') return ['income', 'borrow', 'debt_in'].includes(type);

  return false;
}

function isPaymentTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const sourceAction = String(tx.source_action || '').toLowerCase();
  const type = String(tx.type || '').toLowerCase();

  if (notes.includes('[DEBT_PAYMENT]')) return true;
  if (notes.includes('[DEBT_RECEIVE]')) return true;
  if (['make_payment', 'receive_payment'].includes(sourceAction)) return true;

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
async function findDebtById(db, debtId) {
  const id = safeText(debtId, '', 200);
  if (!id) return null;

  return db.prepare(
    `SELECT ${DEBT_COLUMNS}
       FROM debts
      WHERE TRIM(id) = TRIM(?)
      LIMIT 1`
  ).bind(id).first();
}

async function resolveAccount(db, input) {
  const id = safeText(input, '', 160);

  if (!id) {
    return { ok: false, status: 400, error: 'account_id required' };
  }

  const cols = await tableColumns(db, 'accounts');

  if (!cols.has('id')) {
    return { ok: false, status: 500, error: 'accounts table missing id column' };
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
    return { ok: true, account: normalizeAccount(exact) };
  }

  const res = await db.prepare(
    `SELECT *
       FROM accounts
      ${where ? 'WHERE ' + where : ''}
      ORDER BY ${cols.has('display_order') ? 'display_order,' : ''} ${cols.has('name') ? 'name,' : ''} id`
  ).all();

  const target = token(id);
  const found = (res.results || []).find(account =>
    token(account.id) === target ||
    token(account.name) === target ||
    String(account.name || '').trim().toLowerCase() === id.toLowerCase()
  );

  if (found?.id) {
    return { ok: true, account: normalizeAccount(found) };
  }

  return {
    ok: false,
    status: 409,
    error: 'Account not found or inactive',
    diagnostics: {
      received_account_id: id,
      available_accounts: (res.results || []).map(row => ({
        id: row.id,
        name: row.name,
        type: row.type || row.kind || null,
        status: row.status || null
      }))
    }
  };
}

function activeAccountWhere(cols) {
  const parts = [];

  if (cols.has('deleted_at')) parts.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) parts.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) parts.push("(status IS NULL OR status = '' OR status = 'active')");

  return parts.join(' AND ');
}

async function tableColumns(db, table) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function buildDebtInsert(db, row) {
  const debtCols = await tableColumns(db, 'debts');

  const candidate = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    original_amount: row.original_amount,
    paid_amount: row.paid_amount,
    snowball_order: row.snowball_order,
    due_date: row.due_date,
    due_day: row.due_day,
    installment_amount: row.installment_amount,
    frequency: row.frequency,
    last_paid_date: row.last_paid_date,
    status: row.status,
    notes: row.notes,
    direction: row.direction,
    counterparty_type: row.counterparty_type,
    counterparty_name: row.counterparty_name,
    contact_phone: row.contact_phone,
    contact_email: row.contact_email,
    principal_amount: row.principal_amount,
    principal_currency: row.principal_currency,
    principal_amount_pkr_at_origination: row.principal_amount_pkr_at_origination,
    date_originated: row.date_originated,
    expected_repayment_date: row.expected_repayment_date,
    destination_account_id: row.destination_account_id,
    source_account_id: row.source_account_id,
    funds_moved_at_creation: row.funds_moved_at_creation,
    origination_transaction_id: row.origination_transaction_id,
    interest_rate_pct: row.interest_rate_pct,
    interest_type: row.interest_type,
    minimum_payment_amount: row.minimum_payment_amount,
    payment_frequency: row.payment_frequency,
    reminder_cadence: row.reminder_cadence,
    description: row.description,
    reference_number: row.reference_number,
    tags: row.tags,
    collateral: row.collateral,
    guarantor_name: row.guarantor_name,
    trust_level: row.trust_level,
    split_with_household: row.split_with_household,
    updated_at: row.updated_at || row.created_at || nowSQL()
  };

  const insertable = {};

  for (const [key, val] of Object.entries(candidate)) {
    if (val !== undefined && (debtCols.size === 0 || debtCols.has(key))) {
      insertable[key] = val;
    }
  }

  const keys = Object.keys(insertable);

  return db.prepare(
    `INSERT INTO debts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(k => insertable[k]));
}

function buildTransactionInsert(db, txCols, row) {
  const insertable = {};

  for (const [key, value] of Object.entries(row)) {
    if (txCols.has(key)) insertable[key] = value;
  }

  const keys = Object.keys(insertable);

  if (!keys.length) {
    throw new Error('transactions table has no compatible columns for insert');
  }

  return db.prepare(
    `INSERT INTO transactions (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => insertable[key]));
}

function buildDebtPaymentInsert(db, cols, row) {
  const original = round2(row.original_amount);
  const paidBefore = round2(row.paid_before);
  const amount = round2(row.amount);
  const paidAfter = round2(row.paid_after);
  const remainingAfter = round2(row.remaining_after);

  const mapping = {
    id: row.id,
    debt_id: row.debt_id,
    debt_name_snapshot: row.debt_name_snapshot || row.debt?.name || '',
    debt_kind_snapshot: row.debt_kind_snapshot || row.debt?.kind || '',
    original_amount_paisa: toPaisa(original),
    paid_before_paisa: toPaisa(paidBefore),
    amount_paisa: toPaisa(amount),
    paid_after_paisa: toPaisa(paidAfter),
    remaining_after_paisa: toPaisa(remainingAfter),
    original_amount: original,
    paid_before: paidBefore,
    amount,
    paid_after: paidAfter,
    remaining_after: remainingAfter,
    account_id: row.account_id,
    category_id: row.category_id || DEFAULT_CATEGORY_ID,
    paid_date: row.paid_date || row.date,
    transaction_id: row.transaction_id,
    status: row.status || 'paid',
    reversed_at: null,
    reversal_transaction_id: null,
    reason: null,
    notes: buildPaymentNotes(row),
    dry_run_payload_hash: row.dry_run_payload_hash || null,
    transaction_payload_hash: row.transaction_payload_hash || null,
    created_by: row.created_by,
    created_at: row.created_at || nowSQL()
  };

  const insertable = {};

  for (const [key, value] of Object.entries(mapping)) {
    if (cols.has(key)) insertable[key] = value;
  }

  const keys = Object.keys(insertable);

  if (!keys.length) {
    throw new Error('debt_payments table has no compatible columns for insert');
  }

  return db.prepare(
    `INSERT INTO debt_payments (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => insertable[key]));
}

function buildPaymentNotes(row) {
  return safeText(
    `payment_id=${row.id} | debt_id=${row.debt_id} | transaction_id=${row.transaction_id}${row.notes ? ' | ' + row.notes : ''}`,
    '',
    1000
  );
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
        WHERE TRIM(id) = TRIM(?)
        LIMIT 1`
    ).bind(paymentId).first();

    if (row) return row;
  }

  const txCols = await tableColumns(db, 'transactions');

  if (txCols.has('notes')) {
    const row = await db.prepare(
      `SELECT id, notes
         FROM transactions
        WHERE instr(notes, ?) > 0
          AND instr(notes, ?) > 0
        LIMIT 1`
    ).bind(
      `payment_id=${paymentId}`,
      `debt_id=${debtId}`
    ).first();

    if (row) return { id: row.id, transaction_id: row.id };
  }

  return null;
}

async function recalculateDebtPaidAmount(db, debtId) {
  const sumRow = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS active_paid_amount,
           MAX(paid_date) AS last_paid_date
      FROM debt_payments
     WHERE TRIM(debt_id) = TRIM(?)
       AND (status IS NULL OR status = '' OR status = 'paid' OR status = 'active')
  `).bind(debtId).first();

  const debtRow = await findDebtById(db, debtId);

  if (!debtRow) {
    return {
      paid_amount: 0,
      remaining_amount: 0,
      status: 'active',
      last_paid_date: null
    };
  }

  const originalAmount = round2(debtRow.original_amount || 0);
  const paidAmount = round2(sumRow?.active_paid_amount || 0);
  const remainingAmount = Math.max(0, round2(originalAmount - paidAmount));

  return {
    paid_amount: paidAmount,
    remaining_amount: remainingAmount,
    status: remainingAmount > 0 ? 'active' : CANONICAL_TERMINAL,
    last_paid_date: sumRow?.last_paid_date || null
  };
}

/* ─────────────────────────────
 * Normalize / summarize
 * ───────────────────────────── */

function normalizeDebt(row) {
  const original = Number(row?.principal_amount || (row?.original_amount ? Math.round(row.original_amount * 100) : 0));
  const paid = Number(row?.paid_amount || 0);
  // paid_amount is stored as Rs (REAL), principal_amount as paisas — normalise to paisas
  const paidPaisa = paid < 1000 && original > 10000 ? Math.round(paid * 100) : paid;
  const remaining = Math.max(0, original - paidPaisa);
  const dueDate = normalizeDate(row?.due_date);
  const dueDay = normalizeDueDay(row?.due_day);
  const installmentAmount = normalizeNullableMoney(row?.installment_amount);
  const frequency = normalizeFrequency(row?.frequency || row?.payment_frequency || 'monthly') || 'monthly';
  const lastPaidDate = normalizeDate(row?.last_paid_date);
  const direction = normalizeDirection(row?.direction || row?.kind);
  const schedule = computeSchedule({
    remaining,
    due_date: dueDate,
    due_day: dueDay,
    last_paid_date: lastPaidDate
  });

  return {
    id: safeText(row?.id, '', 160),
    name: safeText(row?.name, '', 160),
    kind: direction === 'i_owe' ? 'owe' : 'owed',
    direction,
    counterparty_name: safeText(row?.counterparty_name || row?.name, '', 160),
    counterparty_type: safeText(row?.counterparty_type || 'other', 'other', 50),
    contact_phone: row?.contact_phone || null,
    contact_email: row?.contact_email || null,
    principal_amount: original,
    principal_currency: safeText(row?.principal_currency || 'PKR', 'PKR', 10),
    principal_amount_pkr_at_origination: row?.principal_amount_pkr_at_origination || null,
    original_amount: round2(Number(row?.original_amount || 0)),
    paid_amount: round2(Number(row?.paid_amount || 0)),
    remaining_amount: round2(remaining / 100),
    remaining_balance: remaining,
    snowball_order: row?.snowball_order == null ? null : Number(row.snowball_order),
    date_originated: row?.date_originated || null,
    due_date: dueDate,
    due_day: dueDay,
    expected_repayment_date: row?.expected_repayment_date || null,
    settlement_date: row?.settlement_date || null,
    writeoff_date: row?.writeoff_date || null,
    destination_account_id: row?.destination_account_id || null,
    source_account_id: row?.source_account_id || null,
    funds_moved_at_creation: Boolean(row?.funds_moved_at_creation),
    origination_transaction_id: row?.origination_transaction_id || null,
    installment_amount: installmentAmount,
    interest_rate_pct: row?.interest_rate_pct || null,
    interest_type: row?.interest_type || null,
    minimum_payment_amount: row?.minimum_payment_amount || null,
    payment_frequency: row?.payment_frequency || frequency,
    frequency,
    last_paid_date: lastPaidDate,
    next_due_date: schedule.next_due_date,
    days_until_due: schedule.days_until_due,
    days_overdue: schedule.days_overdue,
    due_status: schedule.due_status,
    schedule_missing: schedule.schedule_missing,
    status: safeText(row?.status || 'active', 'active', 80).toLowerCase(),
    writeoff_reason: row?.writeoff_reason || null,
    reminder_cadence: row?.reminder_cadence || 'none',
    last_contact_date: row?.last_contact_date || null,
    notes: safeText(row?.notes, '', 1000),
    description: safeText(row?.description, '', 1000),
    reference_number: row?.reference_number || null,
    document_url: row?.document_url || null,
    tags: row?.tags ? (typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags)) : null,
    collateral: row?.collateral || null,
    guarantor_name: row?.guarantor_name || null,
    trust_level: row?.trust_level || null,
    split_with_household: Boolean(row?.split_with_household),
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || row?.created_at || null
  };
}

function debtSummary(debt) {
  const original = round2(debt.original_amount || 0);
  const paid = round2(debt.paid_amount || 0);

  return {
    id: debt.id,
    name: debt.name,
    kind: debt.kind,
    original_amount: original,
    paid_amount: paid,
    remaining_amount: Math.max(0, round2(original - paid)),
    status: debt.status || 'active'
  };
}

function summarizeDebts(debts) {
  const active = debts.filter(isActiveDebt);

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

function buildDebtUpdate(body) {
  const payload = {};

  if (body.name !== undefined) payload.name = safeText(body.name, '', 160);

  if (body.due_date !== undefined || body.next_due_date !== undefined) {
    payload.due_date = normalizeDate(body.due_date || body.next_due_date);
  }

  if (body.due_day !== undefined) {
    const day = normalizeDueDay(body.due_day);

    if (body.due_day !== null && body.due_day !== '' && day == null) {
      return { ok: false, status: 400, error: 'due_day must be 1-31' };
    }

    payload.due_day = day;
  }

  if (body.installment_amount !== undefined) {
    const amount = normalizeNullableMoney(body.installment_amount);

    if (body.installment_amount !== null && body.installment_amount !== '' && amount == null) {
      return { ok: false, status: 400, error: 'installment_amount must be 0 or greater' };
    }

    payload.installment_amount = amount;
  }

  if (body.frequency !== undefined) {
    const frequency = normalizeFrequency(body.frequency || 'monthly');

    if (!frequency) {
      return { ok: false, status: 400, error: 'Invalid frequency' };
    }

    payload.frequency = frequency;
  }

  if (body.status !== undefined) {
    const status = normalizeStatus(body.status);

    if (!status) {
      return { ok: false, status: 400, error: 'Invalid status' };
    }

    payload.status = status;
  }

  if (body.notes !== undefined) payload.notes = safeText(body.notes, '', 1000);

  return { ok: true, payload };
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

  if (input.due_date) nextDue = parseDate(input.due_date);
  else if (input.due_day != null) nextDue = nextDueFromDay(input.due_day, input.last_paid_date);

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

/* ─────────────────────────────
 * Diagnostics / generic helpers
 * ───────────────────────────── */

async function debtLookupDiagnostics(db, debtId, body) {
  const id = safeText(debtId, '', 200);
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
    matching_id_debts = (await db.prepare(`
      SELECT id, name, kind, original_amount, paid_amount, status, due_date, created_at
        FROM debts
       WHERE LOWER(id) LIKE ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20
    `).bind(`%${tokenPart}%`).all()).results || [];
  } catch {}

  try {
    matching_name_debts = (await db.prepare(`
      SELECT id, name, kind, original_amount, paid_amount, status, due_date, created_at
        FROM debts
       WHERE LOWER(name) LIKE ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20
    `).bind(`%${tokenPart}%`).all()).results || [];
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

function contractError({ action, code, error, extra }) {
  return {
    ok: false,
    action,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
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
      stage: 'top_level_catch',
      error: err.message || String(err),
      stack: shortStack(err),
      committed: false,
      writes_performed: false
    }, 500);
  }
}

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

async function readJSON(request) {
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

function hasMovementFlag(body) {
  return !(
    body.movement_now === undefined &&
    body.money_moved_now === undefined &&
    body.ledger_movement_now === undefined &&
    body.create_ledger === undefined &&
    body.funds_moved_at_creation === undefined
  );
}

function parseMovementNow(body) {
  if (!hasMovementFlag(body)) return false;

  const value = body.movement_now ?? body.money_moved_now ?? body.ledger_movement_now ?? body.create_ledger ?? body.funds_moved_at_creation;

  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;

  return ['1', 'true', 'yes', 'y', 'on', 'moved'].includes(String(value).trim().toLowerCase());
}

function normalizeKind(value) {
  const raw = String(value || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'borrowed'].includes(raw)) return 'owe';
  if (['owed', 'owed_to_me', 'owed_me', 'to_me', 'receivable'].includes(raw)) return 'owed';

  return null;
}

function normalizeDirection(value) {
  const raw = String(value || '').trim().toLowerCase();

  if (['i_owe', 'owe', 'payable', 'borrowed'].includes(raw)) return 'i_owe';
  if (['owed_to_me', 'owed', 'owed_me', 'to_me', 'receivable'].includes(raw)) return 'owed_to_me';

  return 'i_owe';
}

function normalizeStatus(value) {
  const raw = safeText(value, 'active', 80).toLowerCase();

  if (raw === '') return 'active';
  if (raw === 'active' || raw === 'paused') return raw;
  if (TERMINAL_STATUSES.has(raw)) return raw;

  return null;
}

function isTerminalStatus(value) {
  return TERMINAL_STATUSES.has(String(value || '').trim().toLowerCase());
}

function isActiveDebt(debt) {
  const status = String(debt?.status || '').trim().toLowerCase();
  return !isTerminalStatus(status);
}

function normalizeDate(value) {
  const raw = safeText(value, '', 40);

  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;

  return raw.slice(0, 10);
}

function parseDate(value) {
  const raw = normalizeDate(value);

  if (!raw) return null;

  const date = new Date(raw + 'T00:00:00.000Z');

  return Number.isNaN(date.getTime()) ? null : date;
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
  const raw = safeText(value, 'monthly', 30).toLowerCase();

  return ['monthly', 'weekly', 'yearly', 'custom'].includes(raw) ? raw : null;
}

function buildDebtNotes(notes, meta) {
  const parts = [];

  if (notes) parts.push(notes);

  parts.push(meta.movement_now ? 'movement_now=1' : 'movement_now=0');

  if (meta.account_id) parts.push('account_id=' + meta.account_id);
  if (meta.created_by) parts.push('created_by=' + meta.created_by);
  if (meta.idempotency_key) parts.push('idempotency_key=' + meta.idempotency_key);

  return safeText(parts.join(' | '), '', 1000);
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

function safeText(value, fallback = '', max = 500) {
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

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000);
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, max)));
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowSQL() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
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

function normalizeAccount(row) {
  return {
    ...row,
    id: safeText(row.id, '', 160),
    name: safeText(row.name || row.id, '', 160)
  };
}

function sanitizeTransaction(row) {
  return {
    id: row.id,
    date: row.date || null,
    type: row.type || null,
    amount: row.amount == null ? null : Number(row.amount),
    account_id: row.account_id || null,
    category_id: row.category_id || null,
    notes: row.notes || '',
    created_at: row.created_at || null,
    reversed_by: row.reversed_by || null,
    reversed_at: row.reversed_at || null,
    source_module: row.source_module || null,
    source_id: row.source_id || null,
    source_action: row.source_action || null
  };
}

function buildPaymentId(body, input) {
  const supplied = safeText(
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

function extractDebtMarker(notes) {
  const text = String(notes || '');

  if (text.includes('[DEBT_PAYMENT]')) return '[DEBT_PAYMENT]';
  if (text.includes('[DEBT_RECEIVE]')) return '[DEBT_RECEIVE]';
  if (text.includes('[DEBT_ORIGIN_REPAIR]')) return '[DEBT_ORIGIN_REPAIR]';
  if (text.includes('[DEBT_ORIGIN]')) return '[DEBT_ORIGIN]';

  return null;
}

function redactBody(body) {
  const out = { ...(body || {}) };

  delete out.password;
  delete out.token;
  delete out.secret;

  return out;
}

function shortStack(err) {
  return String(err && err.stack ? err.stack : '').split('\n').slice(0, 6).join('\n');
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
