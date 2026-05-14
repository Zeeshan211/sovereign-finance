/* Sovereign Finance Debts API
 * /api/debts
 * v0.6.7-post-json-payment-fixed
 *
 * Rules:
 * - Do not rely on /api/debts/payment because old item routes can shadow it.
 * - Payment uses POST /api/debts with body.action = "payment".
 * - Payment check uses GET /api/debts?action=payment_check.
 * - POST always returns JSON, including diagnostics on failure.
 */

const VERSION = 'v0.6.7-post-json-payment-fixed';

const DEFAULT_CATEGORY_ID = 'debt_payment';
const DUE_SOON_DAYS = 3;

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
  created_at
`;

export async function onRequestGet(context) {
  return withJsonErrors('GET', async () => {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = safeText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (path.length > 0) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Unsupported GET subroute. Use root /api/debts with action query params.',
        path
      }, 404);
    }

    if (action === 'payment_check' || action === 'payment-check') {
      return paymentCheck(db, url);
    }

    if (action === 'health') {
      return health(db);
    }

    return listDebts(db, url);
  });
}

export async function onRequestPost(context) {
  return withJsonErrors('POST', async () => {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const body = await readJSON(context.request);
    const action = safeText(body.action, '', 80).toLowerCase();
    const dryRun = isDryRun(url, body);

    if (path.length > 0) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Unsupported POST subroute. Use POST /api/debts with action in body.',
        path,
        action,
        received_body_keys: Object.keys(body || {})
      }, 404);
    }

    if (action === 'payment' || action === 'pay' || action === 'record_payment') {
      return recordDebtPayment(db, body, dryRun);
    }

    if (action === 'payment_check' || action === 'payment-check') {
      return paymentCheckFromBody(db, body);
    }

    if (action === 'repair_ledger' || action === 'repair-ledger') {
      return repairLedgerOrigin(db, body, dryRun);
    }

    return createDebt(db, body, dryRun);
  });
}

export async function onRequestPut(context) {
  return withJsonErrors('PUT', async () => {
    const db = context.env.DB;
    const path = getPath(context);
    const debtId = safeText(path[0], '', 200);
    const body = await readJSON(context.request);

    if (!debtId) {
      return json({ ok: false, version: VERSION, error: 'debt id required' }, 400);
    }

    const existing = await findDebtById(db, debtId);
    if (!existing) {
      return json({
        ok: false,
        version: VERSION,
        error: `Debt not found for id="${debtId}"`,
        diagnostics: await debtLookupDiagnostics(db, debtId, body)
      }, 404);
    }

    const update = buildDebtUpdate(body);
    if (!update.ok) {
      return json({ ok: false, version: VERSION, error: update.error }, update.status || 400);
    }

    const keys = Object.keys(update.payload);
    if (!keys.length) {
      return json({ ok: false, version: VERSION, error: 'No supported fields supplied.' }, 400);
    }

    await db.prepare(
      `UPDATE debts
       SET ${keys.map(key => `${key} = ?`).join(', ')}
       WHERE TRIM(id) = TRIM(?)`
    ).bind(...keys.map(key => update.payload[key]), debtId).run();

    const row = await findDebtById(db, debtId);
    const debt = await decorateDebt(db, normalizeDebt(row));

    return json({
      ok: true,
      version: VERSION,
      action: 'debt.update',
      id: debtId,
      debt
    });
  });
}

/* ─────────────────────────────
 * GET list / health / payment_check
 * ───────────────────────────── */

async function listDebts(db, url) {
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  const sql = includeInactive
    ? `SELECT ${DEBT_COLUMNS}
       FROM debts
       ORDER BY kind, snowball_order, name`
    : `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE status IS NULL OR status = '' OR status = 'active'
       ORDER BY kind, snowball_order, name`;

  const res = await db.prepare(sql).all();
  const raw = res.results || [];
  const debts = [];

  for (const row of raw) {
    debts.push(await decorateDebt(db, normalizeDebt(row)));
  }

  const totals = summarizeDebts(debts);

  return json({
    ok: true,
    version: VERSION,
    count: debts.length,
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
      root_route_payment_post_supported: true,
      root_route_payment_check_supported: true,
      payment_subroutes_not_required: true,
      owed_to_me_payment_type: 'income',
      i_owe_payment_type: 'expense'
    },
    debts
  });
}

async function health(db) {
  const res = await db.prepare(`SELECT ${DEBT_COLUMNS} FROM debts`).all();
  const rows = res.results || [];
  const debts = [];

  for (const row of rows) {
    debts.push(await decorateDebt(db, normalizeDebt(row)));
  }

  const totals = summarizeDebts(debts);
  const status = totals.repair_required_count > 0 ? 'warn' : 'ok';

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.health',
    status,
    debt_count: debts.length,
    active_debt_count: debts.filter(d => d.status === 'active').length,
    origin_linked_count: totals.origin_linked_count,
    legacy_unknown_count: totals.legacy_unknown_count,
    payment_linked_only_count: totals.payment_linked_only_count,
    repair_required_count: totals.repair_required_count,
    repair_required_debt_ids: totals.repair_required_debt_ids,
    rules: {
      root_route_payment_post_supported: true,
      root_route_payment_check_supported: true,
      post_returns_json_on_errors: true
    }
  });
}

async function paymentCheck(db, url) {
  const debtId = safeText(url.searchParams.get('debt_id'), '', 200);
  const accountId = safeText(url.searchParams.get('account_id'), '', 160);
  const amount = moneyNumber(url.searchParams.get('amount'), null);
  const date = normalizeDate(url.searchParams.get('date')) || todayISO();

  return paymentCheckCore(db, {
    debt_id: debtId,
    account_id: accountId,
    amount,
    date
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
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: 'debt_id required'
    }, 400);
  }

  if (!accountId) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: 'account_id required',
      received_debt_id: debtId
    }, 400);
  }

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: 'amount must be greater than 0',
      received_debt_id: debtId
    }, 400);
  }

  const row = await findDebtById(db, debtId);

  if (!row) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: `Debt not found for received_debt_id="${debtId}"`,
      received_debt_id: debtId,
      diagnostics: await debtLookupDiagnostics(db, debtId, input)
    }, 404);
  }

  const debt = normalizeDebt(row);
  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: accountResult.error,
      received_debt_id: debtId,
      received_account_id: accountId,
      account_diagnostics: accountResult.diagnostics || null
    }, accountResult.status || 409);
  }

  const check = buildPaymentProjection(debt, accountResult.account, amount, date);

  if (!check.ok) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      received_debt_id: debtId,
      resolved_debt_id: debt.id,
      received_account_id: accountId,
      resolved_account_id: accountResult.account.id,
      ...check
    }, check.status || 400);
  }

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.payment_check',
    writes_performed: false,
    debt_found: true,
    account_found: true,
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
      remaining_amount: check.remaining_before,
      status: debt.status
    },
    would_write_transaction_type: check.transaction_type,
    paid_amount_after: check.paid_amount_after,
    status_after: check.status_after,
    rule: check.rule
  });
}

/* ─────────────────────────────
 * POST payment
 * ───────────────────────────── */

async function recordDebtPayment(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id || body.debtId || body.debtID, '', 200);
  const accountId = safeText(body.account_id, '', 160);
  const amount = moneyNumber(body.amount, null);
  const date = normalizeDate(body.date || body.paid_at || body.payment_date) || todayISO();
  const createdBy = safeText(body.created_by, 'web-debts-payment', 120);
  const userNotes = safeText(body.notes, '', 500);

  const baseDiagnostic = {
    version: VERSION,
    action: 'debt.payment',
    dry_run: Boolean(dryRun),
    received_debt_id: debtId,
    received_account_id: accountId,
    received_amount: amount,
    received_body_keys: Object.keys(body || {})
  };

  try {
    if (!debtId) {
      return json({ ok: false, ...baseDiagnostic, error: 'debt_id required' }, 400);
    }

    if (!accountId) {
      return json({ ok: false, ...baseDiagnostic, error: 'account_id required' }, 400);
    }

    if (amount == null || amount <= 0) {
      return json({ ok: false, ...baseDiagnostic, error: 'amount must be greater than 0' }, 400);
    }

    const debtRow = await findDebtById(db, debtId);

    if (!debtRow) {
      return json({
        ok: false,
        ...baseDiagnostic,
        error: `Debt not found for received_debt_id="${debtId}"`,
        diagnostics: await debtLookupDiagnostics(db, debtId, body)
      }, 404);
    }

    const debt = normalizeDebt(debtRow);
    const accountResult = await resolveAccount(db, accountId);

    if (!accountResult.ok) {
      return json({
        ok: false,
        ...baseDiagnostic,
        error: accountResult.error,
        account_diagnostics: accountResult.diagnostics || null
      }, accountResult.status || 409);
    }

    const projection = buildPaymentProjection(debt, accountResult.account, amount, date);

    if (!projection.ok) {
      return json({
        ok: false,
        ...baseDiagnostic,
        resolved_debt_id: debt.id,
        resolved_account_id: accountResult.account.id,
        error: projection.error,
        remaining_amount: projection.remaining_before
      }, projection.status || 400);
    }

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
        ...baseDiagnostic,
        already_recorded: true,
        writes_performed: false,
        resolved_debt_id: debt.id,
        resolved_account_id: accountResult.account.id,
        payment_id: paymentId,
        payment_transaction_id: existing.transaction_id || existing.id || null,
        debt: after
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
      transaction_type: projection.transaction_type
    });

    const proof = {
      action: 'debt.payment',
      version: VERSION,
      payment_id: paymentId,
      payment_transaction_id: paymentTx.id,
      expected_transaction_rows: 1,
      expected_debt_rows_updated: 1,
      expected_debt_payment_rows: 1,
      paid_amount_before: debt.paid_amount,
      paid_amount_after: projection.paid_amount_after,
      status_after: projection.status_after,
      rule: projection.rule
    };

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.payment',
        writes_performed: false,
        received_debt_id: debtId,
        resolved_debt_id: debt.id,
        received_account_id: accountId,
        resolved_account_id: accountResult.account.id,
        payment_id: paymentId,
        payment_transaction: paymentTx,
        proof
      });
    }

    const txCols = await tableColumns(db, 'transactions');
    const paymentCols = await tableColumns(db, 'debt_payments');

    const batch = [
      buildTransactionInsert(db, txCols, paymentTx),
      db.prepare(
        `UPDATE debts
         SET paid_amount = ?, status = ?, last_paid_date = ?
         WHERE TRIM(id) = TRIM(?)`
      ).bind(projection.paid_amount_after, projection.status_after, date, debt.id)
    ];

    if (paymentCols.size > 0) {
      batch.push(buildDebtPaymentInsert(db, paymentCols, {
        id: paymentId,
        debt_id: debt.id,
        transaction_id: paymentTx.id,
        amount,
        account_id: accountResult.account.id,
        date,
        notes: userNotes,
        created_at: paymentTx.created_at,
        created_by: createdBy
      }));
    }

    await db.batch(batch);

    const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

    return json({
      ok: true,
      version: VERSION,
      action: 'debt.payment',
      writes_performed: true,
      received_debt_id: debtId,
      resolved_debt_id: debt.id,
      received_account_id: accountId,
      resolved_account_id: accountResult.account.id,
      payment_id: paymentId,
      payment_transaction_id: paymentTx.id,
      debt: after,
      proof
    });
  } catch (err) {
    return json({
      ok: false,
      ...baseDiagnostic,
      stage: 'recordDebtPayment.catch',
      error: err.message || String(err),
      stack: shortStack(err)
    }, 500);
  }
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

  const transactionType = debt.kind === 'owed' ? 'income' : 'expense';
  const newPaid = round2(Math.min(debt.original_amount, debt.paid_amount + amount));
  const statusAfter = newPaid >= debt.original_amount ? 'settled' : 'active';

  return {
    ok: true,
    remaining_before: remaining,
    paid_amount_after: newPaid,
    status_after: statusAfter,
    transaction_type: transactionType,
    rule: debt.kind === 'owed'
      ? 'owed-to-me payment writes income and increases receiving account'
      : 'i-owe payment writes expense and decreases paying account',
    account_id: account.id,
    date
  };
}

function buildPaymentTransaction({ debt, amount, account, date, notes, created_by, payment_id, transaction_type }) {
  return {
    id: makeId(transaction_type === 'income' ? 'tx_debt_receive' : 'tx_debt_pay'),
    date,
    type: transaction_type,
    amount: round2(amount),
    account_id: account.id,
    transfer_to_account_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant_id: null,
    notes: safeText(
      `${transaction_type === 'income' ? 'Debt received' : 'Debt payment'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | payment_id=${payment_id} | [DEBT_PAYMENT]${notes ? ' | ' + notes : ''}`,
      '',
      500
    ),
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
 * Create debt
 * ───────────────────────────── */

async function createDebt(db, body, dryRun) {
  const id = safeText(body.id, '', 160) || makeId('debt');
  const name = safeText(body.name || body.title || body.label, '', 160);
  const kind = normalizeKind(body.kind || body.direction || 'owed');
  const originalAmount = moneyNumber(body.original_amount ?? body.amount, null);
  const paidAmount = moneyNumber(body.paid_amount, 0);
  const dueDate = normalizeDate(body.due_date || body.next_due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const installmentAmount = normalizeNullableMoney(body.installment_amount || body.monthly_payment);
  const frequency = normalizeFrequency(body.frequency || 'monthly');
  const lastPaidDate = normalizeDate(body.last_paid_date);
  const movementNow = parseMovementNow(body);
  const accountId = safeText(body.account_id || body.source_account_id || body.from_account_id || body.destination_account_id || body.to_account_id, '', 160);
  const movementDate = normalizeDate(body.movement_date || body.date) || todayISO();
  const notes = safeText(body.notes, '', 1000);
  const createdBy = safeText(body.created_by, 'web-debts', 120);

  if (!name) return json({ ok: false, version: VERSION, action: 'debt.create', error: 'name required' }, 400);
  if (!kind) return json({ ok: false, version: VERSION, action: 'debt.create', error: 'kind must be owe or owed' }, 400);
  if (originalAmount == null || originalAmount <= 0) return json({ ok: false, version: VERSION, action: 'debt.create', error: 'original_amount must be greater than 0' }, 400);
  if (paidAmount == null || paidAmount < 0) return json({ ok: false, version: VERSION, action: 'debt.create', error: 'paid_amount must be 0 or greater' }, 400);
  if (paidAmount > originalAmount) return json({ ok: false, version: VERSION, action: 'debt.create', error: 'paid_amount cannot exceed original_amount' }, 400);

  let account = null;

  if (movementNow) {
    if (!accountId) {
      return json({
        ok: false,
        version: VERSION,
        action: 'debt.create',
        error: kind === 'owed'
          ? 'source account_id required for owed-to-me money movement'
          : 'destination account_id required for i-owe money movement'
      }, 400);
    }

    const accountResult = await resolveAccount(db, accountId);
    if (!accountResult.ok) {
      return json({
        ok: false,
        version: VERSION,
        action: 'debt.create',
        error: accountResult.error,
        account_diagnostics: accountResult.diagnostics || null
      }, accountResult.status || 409);
    }

    account = accountResult.account;
  }

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
    status: paidAmount >= originalAmount ? 'settled' : 'active',
    notes: buildDebtNotes(notes, {
      movement_now: movementNow,
      account_id: account ? account.id : null,
      created_by: createdBy
    })
  };

  const originTx = movementNow
    ? buildOriginTransaction({
      debt: debtRow,
      account,
      date: movementDate,
      created_by: createdBy
    })
    : null;

  const proof = {
    action: 'debt.create',
    write_model: originTx ? 'atomic_debt_row_plus_origin_ledger' : 'debt_record_only_no_money_moved',
    expected_debt_rows: 1,
    expected_origin_ledger_rows: originTx ? 1 : 0
  };

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'debt.create',
      dry_run: true,
      writes_performed: false,
      debt_row: debtRow,
      origin_transaction: originTx,
      proof
    });
  }

  const batch = [buildDebtInsert(db, debtRow)];

  if (originTx) {
    const txCols = await tableColumns(db, 'transactions');
    batch.push(buildTransactionInsert(db, txCols, originTx));
  }

  await db.batch(batch);

  const debt = await decorateDebt(db, normalizeDebt(await findDebtById(db, id)));

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.create',
    writes_performed: true,
    id,
    origin_transaction_id: originTx ? originTx.id : null,
    debt,
    proof
  });
}

function buildOriginTransaction({ debt, account, date, created_by }) {
  const type = debt.kind === 'owed' ? 'expense' : 'income';

  return {
    id: makeId(type === 'expense' ? 'tx_debt_origin_out' : 'tx_debt_origin_in'),
    date,
    type,
    amount: round2(debt.original_amount),
    account_id: account.id,
    transfer_to_account_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant_id: null,
    notes: safeText(
      `${type === 'expense' ? 'Debt given' : 'Debt received'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | [DEBT_ORIGIN]`,
      '',
      500
    ),
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
 * Repair origin
 * ───────────────────────────── */

async function repairLedgerOrigin(db, body, dryRun) {
  const debtId = safeText(body.debt_id || body.id, '', 200);
  const accountId = safeText(body.account_id, '', 160);
  const date = normalizeDate(body.date || body.movement_date) || todayISO();
  const createdBy = safeText(body.created_by, 'debt-origin-repair', 120);

  if (!debtId) return json({ ok: false, version: VERSION, action: 'debt.repair_origin', error: 'debt_id required' }, 400);
  if (!accountId) return json({ ok: false, version: VERSION, action: 'debt.repair_origin', error: 'account_id required' }, 400);

  const row = await findDebtById(db, debtId);
  if (!row) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.repair_origin',
      error: `Debt not found for received_debt_id="${debtId}"`,
      diagnostics: await debtLookupDiagnostics(db, debtId, body)
    }, 404);
  }

  const debt = normalizeDebt(row);
  const decorated = await decorateDebt(db, debt);

  if (decorated.origin_linked) {
    return json({
      ok: true,
      version: VERSION,
      action: 'debt.repair_origin',
      already_linked: true,
      writes_performed: false,
      debt: decorated
    });
  }

  const accountResult = await resolveAccount(db, accountId);
  if (!accountResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.repair_origin',
      error: accountResult.error,
      account_diagnostics: accountResult.diagnostics || null
    }, accountResult.status || 409);
  }

  const originTx = buildOriginTransaction({
    debt,
    account: accountResult.account,
    date,
    created_by: createdBy
  });

  originTx.notes = originTx.notes.replace('[DEBT_ORIGIN]', '[DEBT_ORIGIN_REPAIR]');

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      action: 'debt.repair_origin',
      dry_run: true,
      writes_performed: false,
      origin_transaction: originTx
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  await buildTransactionInsert(db, txCols, originTx).run();

  const after = await decorateDebt(db, normalizeDebt(await findDebtById(db, debt.id)));

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.repair_origin',
    writes_performed: true,
    origin_transaction_id: originTx.id,
    debt: after
  });
}

/* ─────────────────────────────
 * Debt decoration / classifiers
 * ───────────────────────────── */

async function decorateDebt(db, debt) {
  const txs = await loadTransactionsForDebt(db, debt.id);
  const activeTxs = txs.filter(tx => !isReversedTransaction(tx));
  const originTxs = activeTxs.filter(tx => isOriginTransactionForDebt(debt, tx));
  const paymentTxs = activeTxs.filter(tx => isPaymentTransactionForDebt(debt, tx));

  const explicitMovementNow =
    String(debt.notes || '').toLowerCase().includes('movement_now=1') ||
    originTxs.length > 0;

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

async function loadTransactionsForDebt(db, debtId) {
  const cols = await tableColumns(db, 'transactions');
  if (!cols.has('notes')) return [];

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
    'reversed_at'
  ].filter(col => cols.has(col));

  const res = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE notes LIKE ?
     ORDER BY ${cols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
  ).bind(`%debt_id=${debtId}%`).all();

  return (res.results || []).map(sanitizeTransaction);
}

function isOriginTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const type = String(tx.type || '').toLowerCase();
  const amountMatches = Math.abs(Number(tx.amount || 0) - Number(debt.original_amount || 0)) < 0.01;

  if (notes.includes('[DEBT_ORIGIN]')) return true;
  if (notes.includes('[DEBT_ORIGIN_REPAIR]')) return true;
  if (!amountMatches) return false;

  if (debt.kind === 'owed') return ['expense', 'debt_out'].includes(type);
  if (debt.kind === 'owe') return ['income', 'borrow', 'debt_in'].includes(type);
  return false;
}

function isPaymentTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const type = String(tx.type || '').toLowerCase();

  if (notes.includes('[DEBT_PAYMENT]')) return true;
  if (notes.includes('[DEBT_RECEIVE]')) return true;

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
 * DB helpers
 * ───────────────────────────── */

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
       WHERE LOWER(name) LIKE '%yusra%'
          OR LOWER(name) LIKE '%test%'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20`
    ).all()).results || [];
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

async function resolveAccount(db, input) {
  const id = safeText(input, '', 160);
  if (!id) return { ok: false, status: 400, error: 'account_id required' };

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
  const found = (res.results || []).find(account => {
    return token(account.id) === target ||
      token(account.name) === target ||
      String(account.name || '').trim().toLowerCase() === id.toLowerCase();
  });

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

function buildDebtInsert(db, row) {
  return db.prepare(
    `INSERT INTO debts
     (id, name, kind, original_amount, paid_amount, snowball_order, due_date, due_day, installment_amount, frequency, last_paid_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id,
    row.name,
    row.kind,
    row.original_amount,
    row.paid_amount,
    row.snowball_order,
    row.due_date,
    row.due_day,
    row.installment_amount,
    row.frequency,
    row.last_paid_date,
    row.status,
    row.notes
  );
}

function buildTransactionInsert(db, txCols, row) {
  const insertable = {};

  for (const [key, value] of Object.entries(row)) {
    if (txCols.has(key)) insertable[key] = value;
  }

  const keys = Object.keys(insertable);
  if (!keys.length) throw new Error('transactions table has no compatible columns for insert');

  return db.prepare(
    `INSERT INTO transactions (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => insertable[key]));
}

function buildDebtPaymentInsert(db, cols, row) {
  const insertable = {};

  const mapping = {
    id: row.id,
    debt_id: row.debt_id,
    transaction_id: row.transaction_id,
    tx_id: row.transaction_id,
    amount: row.amount,
    amount_paisa: Math.round(Number(row.amount || 0) * 100),
    paid_amount: row.amount,
    payment_amount: row.amount,
    account_id: row.account_id,
    date: row.date,
    paid_at: row.date,
    payment_date: row.date,
    notes: buildPaymentNotes(row),
    created_at: row.created_at,
    created_by: row.created_by,
    reversed_at: null,
    reversed_by: null
  };

  for (const [key, value] of Object.entries(mapping)) {
    if (cols.has(key)) insertable[key] = value;
  }

  const keys = Object.keys(insertable);
  if (!keys.length) throw new Error('debt_payments table has no compatible columns for insert');

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

    if (row) return { id: row.id, transaction_id: row.id };
  }

  return null;
}

/* ─────────────────────────────
 * Normalizers / summaries
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

  return {
    id: safeText(row?.id, '', 160),
    name: safeText(row?.name, '', 160),
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
    status: safeText(row?.status || 'active', 'active', 80).toLowerCase(),
    notes: safeText(row?.notes, '', 1000),
    created_at: row?.created_at || null
  };
}

function summarizeDebts(debts) {
  const active = debts.filter(debt => debt.status === 'active');

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
    if (!frequency) return { ok: false, status: 400, error: 'Invalid frequency' };
    payload.frequency = frequency;
  }

  if (body.status !== undefined) {
    payload.status = safeText(body.status, 'active', 80).toLowerCase();
  }

  if (body.notes !== undefined) {
    payload.notes = safeText(body.notes, '', 1000);
  }

  return { ok: true, payload };
}

/* ─────────────────────────────
 * Schedule
 * ───────────────────────────── */

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

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

async function withJsonErrors(method, fn) {
  try {
    return await fn();
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      method,
      stage: 'top_level_catch',
      error: err.message || String(err),
      stack: shortStack(err)
    }, 500);
  }
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

function parseMovementNow(body) {
  if (
    body.movement_now === undefined &&
    body.money_moved_now === undefined &&
    body.ledger_movement_now === undefined &&
    body.create_ledger === undefined
  ) {
    return true;
  }

  const value = body.movement_now ??
    body.money_moved_now ??
    body.ledger_movement_now ??
    body.create_ledger;

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

function normalizeDate(value) {
  const raw = safeText(value, '', 40);
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
  const raw = safeText(value, 'monthly', 30).toLowerCase();
  return ['monthly', 'weekly', 'yearly', 'custom'].includes(raw) ? raw : null;
}

function buildDebtNotes(notes, meta) {
  const parts = [];
  if (notes) parts.push(notes);
  parts.push(meta.movement_now ? 'movement_now=1' : 'movement_now=0');
  if (meta.account_id) parts.push('account_id=' + meta.account_id);
  if (meta.created_by) parts.push('created_by=' + meta.created_by);
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
    reversed_at: row.reversed_at || null
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

function redactBody(body) {
  const out = { ...(body || {}) };
  delete out.password;
  delete out.token;
  delete out.secret;
  return out;
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