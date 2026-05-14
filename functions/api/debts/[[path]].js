/* Sovereign Finance Debts API
 * /api/debts
 * v0.6.6-root-route-payment-check
 *
 * Critical route rule:
 * - Do NOT depend on /api/debts/payment or /api/debts/payment-check.
 * - Older item route v0.5.0 can shadow those paths.
 * - Payment check must use:
 *   GET /api/debts?action=payment_check&debt_id=...&account_id=...&amount=...
 * - Payment write/dry-run must use:
 *   POST /api/debts with body.action = "payment"
 */

const VERSION = 'v0.6.6-root-route-payment-check';

const ACTIVE_CONDITION = "(status IS NULL OR status = '' OR status = 'active')";
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
  try {
    const db = context.env.DB;
    const path = getPath(context);
    const url = new URL(context.request.url);
    const action = safeText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (path[0] === 'health') return getHealth(db);

    if (path.length > 0) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Unsupported debts GET route. Use root /api/debts with action query params.',
        path
      }, 404);
    }

    if (action === 'payment_check' || action === 'payment-check') {
      return paymentCheck(context);
    }

    const includeInactive = url.searchParams.get('include_inactive') === '1';

    const sql = includeInactive
      ? `SELECT ${DEBT_COLUMNS} FROM debts ORDER BY kind, snowball_order, name`
      : `SELECT ${DEBT_COLUMNS} FROM debts WHERE ${ACTIVE_CONDITION} ORDER BY kind, snowball_order, name`;

    const res = await db.prepare(sql).all();
    const rawDebts = res.results || [];
    const debtIds = rawDebts.map(row => safeText(row.id, '', 160)).filter(Boolean);
    const linkMap = await loadDebtLedgerLinks(db, debtIds);

    const debts = rawDebts.map(row => {
      const base = normalizeDebt(row);
      const links = linkMap.get(String(base.id)) || [];
      return attachLedgerState(base, links);
    });

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
        origin_and_payment_links_are_classified_separately: true,
        new_money_moving_debt_requires_account_id: true,
        new_money_moving_debt_atomic_writes: true,
        payment_writes_are_atomic: true,
        root_route_payment_check_supported: true,
        root_route_payment_post_supported: true,
        owed_to_me_origin_type: 'expense',
        i_owe_origin_type: 'income',
        owed_to_me_payment_type: 'income',
        i_owe_payment_type: 'expense',
        legacy_debts_are_not_auto_repaired: true
      },
      debts
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = getPath(context);
    const body = await readJSON(context.request);
    const dryRun = isDryRun(context.request, body);
    const action = safeText(body.action, '', 80).toLowerCase();

    if (path.length > 0) {
      if (path[0] === 'repair-ledger' || path[0] === 'repair-missing-ledger') {
        return repairLedgerOrigin(context, body, dryRun);
      }

      if (path[0] === 'payment' || path[0] === 'pay') {
        return recordDebtPayment(context, body, dryRun);
      }

      return json({
        ok: false,
        version: VERSION,
        error: 'Unsupported debts POST route. Use POST /api/debts with action in body.',
        path,
        action,
        received_body_keys: Object.keys(body || {})
      }, 404);
    }

    if (action === 'payment' || action === 'pay' || action === 'record_payment') {
      return recordDebtPayment(context, body, dryRun);
    }

    if (action === 'repair_ledger' || action === 'repair-ledger') {
      return repairLedgerOrigin(context, body, dryRun);
    }

    return createDebt(context, body, dryRun);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);
    const id = safeText(path[0], '', 160);

    if (!id) return json({ ok: false, version: VERSION, error: 'debt id required' }, 400);

    const body = await readJSON(context.request);
    const update = buildDebtUpdate(body);

    if (!update.ok) {
      return json({ ok: false, version: VERSION, error: update.error }, update.status || 400);
    }

    const keys = Object.keys(update.payload);

    if (!keys.length) {
      return json({ ok: false, version: VERSION, error: 'No supported fields supplied.' }, 400);
    }

    await db.prepare(
      `UPDATE debts SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE TRIM(id) = TRIM(?)`
    ).bind(...keys.map(key => update.payload[key]), id).run();

    const row = await findDebtById(db, id);
    const linkMap = await loadDebtLedgerLinks(db, [id]);
    const debt = attachLedgerState(normalizeDebt(row), linkMap.get(id) || []);

    return json({
      ok: true,
      version: VERSION,
      action: 'debt.update',
      id,
      debt
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

/* ─────────────────────────────
 * Root-route payment check
 * ───────────────────────────── */

async function paymentCheck(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);

  const debtId = safeText(url.searchParams.get('debt_id'), '', 200);
  const accountId = safeText(url.searchParams.get('account_id'), '', 160);
  const amount = moneyNumber(url.searchParams.get('amount'), null);
  const date = normalizeDate(url.searchParams.get('date')) || todayISO();

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

  const debtRow = await findDebtById(db, debtId);

  if (!debtRow) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: `Debt not found for received_debt_id="${debtId}"`,
      received_debt_id: debtId,
      diagnostics: await debtLookupDiagnostics(db, debtId, { debt_id: debtId, account_id: accountId, amount })
    }, 404);
  }

  const debt = normalizeDebt(debtRow);
  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: accountResult.error,
      received_debt_id: debtId,
      received_account_id: accountId
    }, accountResult.status || 409);
  }

  const remaining = round2(debt.original_amount - debt.paid_amount);

  if (!['active', 'paused'].includes(debt.status)) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: 'Only active or paused debts can record payments.',
      debt_found: true,
      debt_status: debt.status,
      debt
    }, 409);
  }

  if (remaining <= 0) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: 'Debt has no remaining balance.',
      debt_found: true,
      remaining_amount: remaining,
      debt
    }, 409);
  }

  if (amount > remaining) {
    return json({
      ok: false,
      version: VERSION,
      action: 'debt.payment_check',
      error: 'payment amount cannot exceed remaining debt balance',
      debt_found: true,
      amount,
      remaining_amount: remaining,
      debt
    }, 400);
  }

  const txType = debt.kind === 'owed' ? 'income' : 'expense';
  const newPaid = round2(Math.min(debt.original_amount, debt.paid_amount + amount));
  const statusAfter = newPaid >= debt.original_amount ? 'settled' : 'active';

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
      remaining_amount: remaining,
      status: debt.status
    },
    would_write_transaction_type: txType,
    paid_amount_after: newPaid,
    status_after: statusAfter,
    rule: debt.kind === 'owed'
      ? 'owed-to-me payment writes income and increases receiving account'
      : 'i-owe payment writes expense and decreases paying account'
  });
}

/* ─────────────────────────────
 * Create debt
 * ───────────────────────────── */

async function createDebt(context, body, dryRun) {
  const db = context.env.DB;
  const payload = await buildCreatePayload(db, body);

  if (!payload.ok) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: dryRun,
      action: 'debt.create',
      error: payload.error,
      details: payload.details || null
    }, payload.status || 400);
  }

  const proof = buildCreateProof(payload);

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      dry_run: true,
      action: 'debt.create',
      writes_performed: false,
      proof,
      normalized_payload: payload
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  const batch = [buildDebtInsert(db, payload.debt_row)];

  if (payload.origin_transaction) {
    batch.push(buildTransactionInsert(db, txCols, payload.origin_transaction));
  }

  await db.batch(batch);

  const row = await findDebtById(db, payload.debt_row.id);
  const links = payload.origin_transaction ? [sanitizeTransaction(payload.origin_transaction)] : [];
  const debt = attachLedgerState(normalizeDebt(row), links);

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.create',
    dry_run: false,
    writes_performed: true,
    atomic_writes: {
      debt_rows: 1,
      origin_ledger_rows: payload.origin_transaction ? 1 : 0
    },
    id: payload.debt_row.id,
    origin_transaction_id: payload.origin_transaction ? payload.origin_transaction.id : null,
    debt,
    proof
  });
}

async function buildCreatePayload(db, body) {
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
  const snowballOrder = body.snowball_order === undefined || body.snowball_order === null || body.snowball_order === ''
    ? null
    : Number(body.snowball_order);

  const movementNow = parseMovementNow(body);
  const accountId = safeText(
    body.account_id ||
    body.source_account_id ||
    body.from_account_id ||
    body.destination_account_id ||
    body.to_account_id ||
    '',
    '',
    160
  );

  const movementDate = normalizeDate(body.movement_date || body.date) || todayISO();
  const notes = safeText(body.notes, '', 1000);
  const createdBy = safeText(body.created_by, 'web-debts', 120) || 'web-debts';

  if (!name) return { ok: false, status: 400, error: 'name required' };
  if (!kind) return { ok: false, status: 400, error: 'kind must be owe or owed' };
  if (originalAmount == null || originalAmount <= 0) return { ok: false, status: 400, error: 'original_amount must be greater than 0' };
  if (paidAmount == null || paidAmount < 0) return { ok: false, status: 400, error: 'paid_amount must be 0 or greater' };
  if (paidAmount > originalAmount) return { ok: false, status: 400, error: 'paid_amount cannot exceed original_amount' };
  if (!frequency) return { ok: false, status: 400, error: 'Invalid frequency' };

  let account = null;

  if (movementNow) {
    if (!accountId) {
      return {
        ok: false,
        status: 400,
        error: kind === 'owed'
          ? 'source account_id required for owed-to-me money movement'
          : 'destination account_id required for i-owe money movement',
        details: { kind, movement_now: true }
      };
    }

    const accountResult = await resolveAccount(db, accountId);

    if (!accountResult.ok) {
      return {
        ok: false,
        status: accountResult.status || 409,
        error: accountResult.error,
        details: { account_id: accountId }
      };
    }

    account = accountResult.account;
  }

  const debtRow = {
    id,
    name,
    kind,
    original_amount: round2(originalAmount),
    paid_amount: round2(paidAmount),
    snowball_order: Number.isFinite(snowballOrder) ? snowballOrder : null,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    last_paid_date: lastPaidDate,
    status: paidAmount >= originalAmount ? 'settled' : 'active',
    notes: buildDebtNotes(notes, {
      movement_now: movementNow,
      account_id: account ? account.id : null,
      created_by: createdBy
    })
  };

  const originTransaction = movementNow
    ? buildOriginTransaction({ debt: debtRow, account, date: movementDate, created_by: createdBy })
    : null;

  return {
    ok: true,
    debt_row: debtRow,
    origin_transaction: originTransaction,
    movement_now: movementNow,
    account: account ? sanitizeAccount(account) : null,
    rules: {
      owed_to_me: 'expense from selected source account',
      i_owe: 'income into selected destination account',
      atomic_create: true
    }
  };
}

function buildOriginTransaction({ debt, account, date, created_by }) {
  const isOwedToMe = debt.kind === 'owed';

  return {
    id: makeId(isOwedToMe ? 'tx_debt_origin_out' : 'tx_debt_origin_in'),
    date,
    type: isOwedToMe ? 'expense' : 'income',
    amount: round2(debt.original_amount),
    account_id: account.id,
    transfer_to_account_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant_id: null,
    notes: safeText(
      `${isOwedToMe ? 'Debt given' : 'Debt received'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | [DEBT_ORIGIN]`,
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
 * Repair origin ledger
 * ───────────────────────────── */

async function repairLedgerOrigin(context, body, dryRun) {
  const db = context.env.DB;
  const debtId = safeText(body.debt_id || body.id, '', 160);
  const accountId = safeText(
    body.account_id ||
    body.source_account_id ||
    body.from_account_id ||
    body.destination_account_id ||
    body.to_account_id ||
    '',
    '',
    160
  );
  const date = normalizeDate(body.date || body.movement_date) || todayISO();
  const createdBy = safeText(body.created_by, 'debt-origin-repair', 120) || 'debt-origin-repair';

  if (!debtId) return json({ ok: false, version: VERSION, error: 'debt_id required' }, 400);
  if (!accountId) return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);

  const row = await findDebtById(db, debtId);

  if (!row) {
    return json({
      ok: false,
      version: VERSION,
      error: `Debt not found for repair: received_debt_id="${debtId}"`,
      diagnostics: await debtLookupDiagnostics(db, debtId, body)
    }, 404);
  }

  const debt = normalizeDebt(row);
  const linkMap = await loadDebtLedgerLinks(db, [debtId]);
  const current = attachLedgerState(debt, linkMap.get(debtId) || []);

  if (current.origin_linked) {
    return json({
      ok: true,
      version: VERSION,
      action: 'debt.repair_origin',
      already_linked: true,
      writes_performed: false,
      debt: current
    });
  }

  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json({ ok: false, version: VERSION, error: accountResult.error }, accountResult.status || 409);
  }

  const originTx = buildOriginTransaction({
    debt,
    account: accountResult.account,
    date,
    created_by: createdBy
  });

  originTx.notes = originTx.notes.replace('[DEBT_ORIGIN]', '[DEBT_ORIGIN_REPAIR]');

  const proof = {
    action: 'debt.repair_origin',
    version: VERSION,
    expected_transaction_rows: 1,
    expected_debt_rows: 0,
    origin_transaction_id: originTx.id,
    rule: debt.kind === 'owed'
      ? 'owed-to-me repair writes expense and reduces selected source account'
      : 'i-owe repair writes income and increases selected destination account'
  };

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      dry_run: true,
      action: 'debt.repair_origin',
      writes_performed: false,
      proof,
      origin_transaction: originTx
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  await buildTransactionInsert(db, txCols, originTx).run();

  const afterMap = await loadDebtLedgerLinks(db, [debtId]);
  const after = attachLedgerState(debt, afterMap.get(debtId) || [sanitizeTransaction(originTx)]);

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.repair_origin',
    writes_performed: true,
    origin_transaction_id: originTx.id,
    debt: after,
    proof
  });
}

/* ─────────────────────────────
 * Record debt payment
 * ───────────────────────────── */

async function recordDebtPayment(context, body, dryRun) {
  const db = context.env.DB;

  const rawDebtId = body.debt_id ?? body.id ?? body.debtId ?? body.debtID ?? '';
  const debtId = safeText(rawDebtId, '', 200);
  const amount = moneyNumber(body.amount, null);
  const accountId = safeText(body.account_id, '', 160);
  const date = normalizeDate(body.date || body.paid_at || body.payment_date) || todayISO();
  const createdBy = safeText(body.created_by, 'web-debts-payment', 120) || 'web-debts-payment';
  const userNotes = safeText(body.notes, '', 500);

  if (!debtId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'debt_id required',
      diagnostics: {
        received_body_keys: Object.keys(body || {}),
        received_body: redactBody(body)
      }
    }, 400);
  }

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'amount must be greater than 0',
      received_debt_id: debtId
    }, 400);
  }

  if (!accountId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'account_id required',
      received_debt_id: debtId
    }, 400);
  }

  const row = await findDebtById(db, debtId);

  if (!row) {
    const diagnostics = await debtLookupDiagnostics(db, debtId, body);
    return json({
      ok: false,
      version: VERSION,
      error: `Debt not found for received_debt_id="${debtId}"`,
      received_debt_id: debtId,
      lookup_mode: 'TRIM(id) = TRIM(?)',
      diagnostics
    }, 404);
  }

  const debt = normalizeDebt(row);

  if (!['active', 'paused'].includes(debt.status)) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Only active or paused debts can record payments.',
      received_debt_id: debtId,
      debt_status: debt.status
    }, 409);
  }

  const remaining = round2(debt.original_amount - debt.paid_amount);

  if (remaining <= 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Debt has no remaining balance.',
      received_debt_id: debtId,
      remaining_amount: remaining
    }, 409);
  }

  if (amount > remaining) {
    return json({
      ok: false,
      version: VERSION,
      error: 'payment amount cannot exceed remaining debt balance',
      received_debt_id: debtId,
      remaining_amount: remaining,
      amount
    }, 400);
  }

  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      error: accountResult.error,
      received_debt_id: debtId,
      received_account_id: accountId
    }, accountResult.status || 409);
  }

  const paymentId = buildPaymentId(body, {
    debt,
    amount,
    account_id: accountResult.account.id,
    date
  });

  const existing = await findExistingPayment(db, paymentId, debtId);

  if (existing) {
    const afterRow = await findDebtById(db, debtId);
    const linkMap = await loadDebtLedgerLinks(db, [debtId]);
    const after = attachLedgerState(normalizeDebt(afterRow), linkMap.get(debtId) || []);

    return json({
      ok: true,
      version: VERSION,
      action: 'debt.payment',
      already_recorded: true,
      writes_performed: false,
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
    payment_id: paymentId
  });

  const newPaid = round2(Math.min(debt.original_amount, debt.paid_amount + amount));
  const newStatus = newPaid >= debt.original_amount ? 'settled' : 'active';

  const proof = {
    action: 'debt.payment',
    version: VERSION,
    payment_id: paymentId,
    expected_transaction_rows: 1,
    expected_debt_rows_updated: 1,
    expected_debt_payment_rows: 1,
    payment_transaction_id: paymentTx.id,
    paid_amount_before: debt.paid_amount,
    paid_amount_after: newPaid,
    status_after: newStatus,
    rule: debt.kind === 'owed'
      ? 'owed-to-me payment writes income and increases receiving account'
      : 'i-owe payment writes expense and decreases paying account'
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
    ).bind(newPaid, newStatus, date, debtId)
  ];

  if (paymentCols.size > 0) {
    batch.push(buildDebtPaymentInsert(db, paymentCols, {
      id: paymentId,
      debt_id: debtId,
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

  const afterRow = await findDebtById(db, debtId);
  const linkMap = await loadDebtLedgerLinks(db, [debtId]);
  const after = attachLedgerState(normalizeDebt(afterRow), linkMap.get(debtId) || []);

  return json({
    ok: true,
    version: VERSION,
    action: 'debt.payment',
    writes_performed: true,
    received_debt_id: debtId,
    resolved_debt_id: debt.id,
    payment_id: paymentId,
    payment_transaction_id: paymentTx.id,
    debt: after,
    proof
  });
}

async function findDebtById(db, debtId) {
  const cleanId = safeText(debtId, '', 200);
  if (!cleanId) return null;

  return db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     WHERE TRIM(id) = TRIM(?)
     LIMIT 1`
  ).bind(cleanId).first();
}

async function debtLookupDiagnostics(db, debtId, body) {
  const cleanId = safeText(debtId, '', 200);
  const lower = cleanId.toLowerCase();
  const tokenPart = lower.includes('_') ? lower.split('_').slice(-1)[0] : lower;

  let exactCount = null;
  let trimCount = null;
  let totalDebtCount = null;
  let matchingYusraDebts = [];
  let matchingIdDebts = [];

  try {
    const exact = await db.prepare(`SELECT COUNT(*) AS c FROM debts WHERE id = ?`).bind(cleanId).first();
    exactCount = exact?.c ?? null;
  } catch {}

  try {
    const trim = await db.prepare(`SELECT COUNT(*) AS c FROM debts WHERE TRIM(id) = TRIM(?)`).bind(cleanId).first();
    trimCount = trim?.c ?? null;
  } catch {}

  try {
    const total = await db.prepare(`SELECT COUNT(*) AS c FROM debts`).first();
    totalDebtCount = total?.c ?? null;
  } catch {}

  try {
    const res = await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, status, due_date, created_at
       FROM debts
       WHERE LOWER(name) LIKE '%yusra%'
          OR LOWER(COALESCE(notes, '')) LIKE '%yusra%'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20`
    ).all();

    matchingYusraDebts = res.results || [];
  } catch {}

  try {
    const likeValue = `%${tokenPart || lower}%`;
    const res = await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, status, due_date, created_at
       FROM debts
       WHERE LOWER(id) LIKE ?
          OR LOWER(name) LIKE ?
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 20`
    ).bind(likeValue, likeValue).all();

    matchingIdDebts = res.results || [];
  } catch {}

  return {
    received_debt_id: cleanId,
    received_debt_id_length: cleanId.length,
    received_debt_id_json: JSON.stringify(cleanId),
    received_body_keys: Object.keys(body || {}),
    received_body: redactBody(body),
    lookup_mode: 'TRIM(id) = TRIM(?)',
    exact_count: exactCount,
    trim_count: trimCount,
    total_debt_count: totalDebtCount,
    matching_yusra_debts: matchingYusraDebts,
    matching_id_debts: matchingIdDebts
  };
}

function buildPaymentTransaction({ debt, amount, account, date, notes, created_by, payment_id }) {
  const isReceivableCollection = debt.kind === 'owed';

  return {
    id: makeId(isReceivableCollection ? 'tx_debt_receive' : 'tx_debt_pay'),
    date,
    type: isReceivableCollection ? 'income' : 'expense',
    amount: round2(amount),
    account_id: account.id,
    transfer_to_account_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    merchant_id: null,
    notes: safeText(
      `${isReceivableCollection ? 'Debt received' : 'Debt payment'}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | account_id=${account.id} | payment_id=${payment_id} | [DEBT_PAYMENT]${notes ? ' | ' + notes : ''}`,
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
 * Health
 * ───────────────────────────── */

async function getHealth(db) {
  const res = await db.prepare(
    `SELECT ${DEBT_COLUMNS} FROM debts ORDER BY datetime(created_at) DESC, id DESC`
  ).all();

  const rawDebts = res.results || [];
  const debtIds = rawDebts.map(row => safeText(row.id, '', 160)).filter(Boolean);
  const linkMap = await loadDebtLedgerLinks(db, debtIds);

  const debts = rawDebts.map(row => {
    const base = normalizeDebt(row);
    const links = linkMap.get(String(base.id)) || [];
    return attachLedgerState(base, links);
  });

  const totals = summarizeDebts(debts);
  const active = debts.filter(debt => debt.status === 'active');
  const status = totals.repair_required_count > 0 ? 'blocked' : 'ok';

  return json({
    ok: true,
    version: VERSION,
    status,
    debt_rows: debts.length,
    active_debts: active.length,
    origin_linked_count: totals.origin_linked_count,
    legacy_unknown_count: totals.legacy_unknown_count,
    payment_linked_only_count: totals.payment_linked_only_count,
    repair_required_count: totals.repair_required_count,
    repair_required_debt_ids: totals.repair_required_debt_ids,
    due_soon_count: totals.due_soon_count,
    overdue_count: totals.overdue_count,
    schedule_missing_count: totals.schedule_missing_count,
    rules: {
      only_explicit_movement_now_can_be_repair_required: true,
      legacy_unknown_is_not_auto_repaired: true,
      payment_transactions_do_not_count_as_origin: true,
      new_money_moving_create_requires_account_id: true,
      new_money_moving_create_is_atomic: true,
      payment_writes_transaction_debt_update_and_debt_payment_row: true,
      payment_lookup_uses_trimmed_debt_id: true,
      payment_diagnostics_enabled: true,
      root_route_payment_check_supported: true,
      root_route_payment_post_supported: true
    },
    debts: debts.map(debt => ({
      id: debt.id,
      name: debt.name,
      kind: debt.kind,
      status: debt.status,
      original_amount: debt.original_amount,
      paid_amount: debt.paid_amount,
      remaining_amount: debt.remaining_amount,
      origin_state: debt.origin_state,
      origin_required: debt.origin_required,
      origin_linked: debt.origin_linked,
      origin_transaction_ids: debt.origin_transaction_ids,
      payment_transaction_ids: debt.payment_transaction_ids,
      repair_required: debt.repair_required
    }))
  });
}

/* ─────────────────────────────
 * Classifier
 * ───────────────────────────── */

function attachLedgerState(debt, linkedTransactions) {
  const state = classifyDebtLedgerState(debt, linkedTransactions);

  return {
    ...debt,
    origin_state: state.origin_state,
    origin_required: state.origin_required,
    origin_linked: state.origin_linked,
    origin_transaction_ids: state.origin_transaction_ids,
    origin_transactions: state.origin_transactions,
    payment_linked: state.payment_transaction_ids.length > 0,
    payment_transaction_ids: state.payment_transaction_ids,
    payment_transactions: state.payment_transactions,
    all_linked_transaction_ids: state.all_linked_transaction_ids,
    repair_required: state.repair_required,
    ledger_linked: state.origin_linked,
    ledger_required: state.origin_required,
    ledger_transaction_ids: state.origin_transaction_ids,
    ledger_transactions: state.origin_transactions
  };
}

function classifyDebtLedgerState(debt, linkedTransactions) {
  const txs = Array.isArray(linkedTransactions) ? linkedTransactions : [];
  const activeTxs = txs.filter(tx => !isReversedTransaction(tx));
  const originTxs = activeTxs.filter(tx => isOriginTransactionForDebt(debt, tx));
  const paymentTxs = activeTxs.filter(tx => isPaymentTransactionForDebt(debt, tx));

  const debtNotes = String(debt.notes || '').toLowerCase();

  const explicitMovementNow =
    debtNotes.includes('movement_now=1') ||
    debtNotes.includes('[debt_origin]') ||
    debtNotes.includes('[debt_origin_repair]') ||
    originTxs.some(tx => {
      const notes = String(tx.notes || '').toLowerCase();
      return notes.includes('[debt_origin]') || notes.includes('[debt_origin_repair]');
    });

  let originState = 'legacy_unknown';
  let repairRequired = false;

  if (originTxs.length > 0) {
    originState = 'ledger_linked';
  } else if (explicitMovementNow) {
    originState = 'ledger_missing';
    repairRequired = true;
  } else if (paymentTxs.length > 0) {
    originState = 'payment_linked_only';
  } else {
    originState = 'legacy_unknown';
  }

  return {
    origin_state: originState,
    origin_required: explicitMovementNow || originTxs.length > 0,
    origin_linked: originTxs.length > 0,
    origin_transaction_ids: originTxs.map(tx => tx.id),
    origin_transactions: originTxs,
    payment_transaction_ids: paymentTxs.map(tx => tx.id),
    payment_transactions: paymentTxs,
    all_linked_transaction_ids: activeTxs.map(tx => tx.id),
    repair_required: repairRequired
  };
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
 * Load ledger links
 * ───────────────────────────── */

async function loadDebtLedgerLinks(db, debtIds) {
  const map = new Map();

  for (const id of debtIds || []) map.set(String(id), []);

  if (!debtIds || !debtIds.length) return map;

  const txCols = await tableColumns(db, 'transactions');
  if (!txCols.has('notes')) return map;

  const select = [
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
  ].filter(col => txCols.has(col));

  for (const chunk of chunks(debtIds, 40)) {
    const where = chunk.map(() => 'notes LIKE ?').join(' OR ');
    const args = chunk.map(id => `%debt_id=${id}%`);

    const res = await db.prepare(
      `SELECT ${select.join(', ')}
       FROM transactions
       WHERE ${where}
       ORDER BY ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
    ).bind(...args).all();

    for (const tx of res.results || []) {
      const id = extractDebtId(tx.notes);
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(sanitizeTransaction(tx));
    }
  }

  return map;
}

function extractDebtId(notes) {
  const match = String(notes || '').match(/debt_id=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/* ─────────────────────────────
 * Normalize debts
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

/* ─────────────────────────────
 * Update helper
 * ───────────────────────────── */

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
 * Inserts
 * ───────────────────────────── */

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

/* ─────────────────────────────
 * Payment idempotency
 * ───────────────────────────── */

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
 * Account resolver
 * ───────────────────────────── */

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

  if (exact?.id) return { ok: true, account: normalizeAccount(exact) };

  const rows = await db.prepare(
    `SELECT *
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${cols.has('display_order') ? 'display_order,' : ''} ${cols.has('name') ? 'name,' : ''} id`
  ).all();

  const target = token(id);

  const found = (rows.results || []).find(account => {
    return token(account.id) === target ||
      token(account.name) === target ||
      String(account.name || '').trim().toLowerCase() === id.toLowerCase();
  });

  if (found?.id) return { ok: true, account: normalizeAccount(found) };

  return { ok: false, status: 409, error: 'Account not found or inactive' };
}

function activeAccountWhere(cols) {
  const parts = [];

  if (cols.has('deleted_at')) parts.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) parts.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) parts.push("(status IS NULL OR status = '' OR status = 'active')");

  return parts.join(' AND ');
}

function normalizeAccount(row) {
  return {
    ...row,
    id: safeText(row.id, '', 160),
    name: safeText(row.name || row.id, '', 160)
  };
}

function sanitizeAccount(row) {
  return { id: row.id, name: row.name || row.id };
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
 * Proof
 * ───────────────────────────── */

function buildCreateProof(payload) {
  const hasOrigin = Boolean(payload.origin_transaction);

  return {
    action: 'debt.create',
    version: VERSION,
    writes_performed: false,
    write_model: hasOrigin ? 'atomic_debt_row_plus_origin_ledger' : 'debt_record_only_no_money_moved',
    expected_debt_rows: 1,
    expected_origin_ledger_rows: hasOrigin ? 1 : 0,
    expected_payment_ledger_rows: 0,
    checks: [
      { check: 'debt_amount_valid', status: 'pass', detail: 'original_amount > 0' },
      {
        check: 'movement_account_rule',
        status: payload.movement_now && payload.account ? 'pass' : payload.movement_now ? 'fail' : 'pass',
        detail: payload.movement_now ? 'money moved now requires account_id' : 'money_moved_now=false; no origin ledger expected'
      },
      {
        check: 'origin_type_rule',
        status: 'pass',
        detail: payload.origin_transaction ? `${payload.debt_row.kind} creates ${payload.origin_transaction.type}` : 'no origin transaction'
      },
      {
        check: 'atomicity',
        status: hasOrigin ? 'pass' : 'not_applicable',
        detail: hasOrigin ? 'debt row and origin ledger row batch together' : 'single debt row only'
      }
    ]
  };
}

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

async function tableColumns(db, table) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
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

function isDryRun(request, body) {
  const url = new URL(request.url);

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

function chunks(values, size) {
  const out = [];

  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }

  return out;
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

  for (let i = 0; i < String(input).length; i += 1) {
    h ^= String(input).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(36);
}

function redactBody(body) {
  const out = { ...(body || {}) };
  delete out.password;
  delete out.token;
  delete out.secret;
  return out;
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