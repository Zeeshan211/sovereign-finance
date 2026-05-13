/* Sovereign Finance Debts Collection Route
 * /api/debts
 * v0.6.0-debt-create-ledger-atomic
 *
 * Banking-grade fix:
 * - Debt creation can no longer silently create a debt without the account movement.
 * - "Owed to me" means money leaves selected source account now: ledger type debt_out.
 * - "I owe" means money enters selected destination account now: ledger type debt_in.
 * - If money moved now, account_id is required.
 * - Debt row + ledger row are inserted atomically with db.batch().
 * - Existing debt missing ledger can be repaired with POST /api/debts/repair-ledger.
 */

const VERSION = 'v0.6.0-debt-create-ledger-atomic';

const ACTIVE_CONDITION = "(status IS NULL OR status = 'active')";
const ALLOWED_FREQUENCY = ['monthly', 'weekly', 'yearly', 'custom'];
const DUE_SOON_DAYS = 3;

const DEFAULT_CATEGORY_ID = 'debt_payment';

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

    if (path[0] === 'health') {
      return getHealth(db);
    }

    if (path.length > 0) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Unsupported debts GET route.'
      }, 404);
    }

    const includeInactive = url.searchParams.get('include_inactive') === '1';

    const sql = includeInactive
      ? `SELECT ${DEBT_COLUMNS}
         FROM debts
         ORDER BY kind, snowball_order, name`
      : `SELECT ${DEBT_COLUMNS}
         FROM debts
         WHERE ${ACTIVE_CONDITION}
         ORDER BY kind, snowball_order, name`;

    const res = await db.prepare(sql).all();
    const rawDebts = res.results || [];
    const debtIds = rawDebts.map(row => safeText(row.id, '', 160)).filter(Boolean);
    const txLinks = await loadDebtLedgerLinks(db, debtIds);

    const debts = rawDebts.map(row => normalizeDebtWithLedger(row, txLinks.get(String(row.id)) || []));

    return jsonResponse({
      ok: true,
      version: VERSION,
      count: debts.length,
      total_owe: round2(sumRemaining(debts.filter(d => d.kind === 'owe'))),
      total_owed: round2(sumRemaining(debts.filter(d => d.kind === 'owed'))),
      schedule_missing_count: debts.filter(d => d.schedule_missing && d.status === 'active').length,
      due_soon_count: debts.filter(d => d.due_status === 'due_soon').length,
      overdue_count: debts.filter(d => d.due_status === 'overdue').length,
      ledger_missing_count: debts.filter(d => d.ledger_required && !d.ledger_linked).length,
      contract: {
        money_movement_required_when_movement_now: true,
        owed_to_me_ledger_type: 'debt_out',
        i_owe_ledger_type: 'debt_in',
        atomic_create: true,
        source_account_required_for_owed: true,
        destination_account_required_for_owe: true
      },
      debts
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);

    if (path[0] === 'repair-ledger' || path[0] === 'repair-missing-ledger') {
      return repairMissingLedger(context, body, dryRun);
    }

    if (path.length > 0) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Unsupported debts POST route.'
      }, 404);
    }

    const validation = await buildCreatePayload(db, body);

    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action: 'debt.save',
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    const payload = validation.payload;
    const previewDebt = normalizeDebt({
      ...payload.debt_row,
      status: 'active',
      created_at: nowISO()
    });

    const proof = buildDebtCreateProof(previewDebt, payload);

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.save',
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: payload
      });
    }

    const allowed = await commandAllowsDebtAction(context, 'debt.save');

    if (!allowed) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Command Centre blocked real debt writes',
        action: 'debt.save',
        dry_run: false,
        writes_performed: false,
        audit_performed: false,
        enforcement: {
          action: 'debt.save',
          allowed: false,
          status: 'blocked',
          reason: 'debt.save create blocked by Command Centre.',
          source: 'coverage.write_safety.debts.debt_save_allowed',
          backend_enforced: true
        },
        proof
      }, 423);
    }

    const txCols = await tableColumns(db, 'transactions');
    const debtInsert = buildDebtInsert(db, payload.debt_row);

    const batch = [debtInsert];

    if (payload.ledger_row) {
      batch.push(buildTransactionInsert(db, txCols, payload.ledger_row));
    }

    await db.batch(batch);

    const afterRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(payload.debt_row.id).first();

    const links = payload.ledger_row ? [sanitizeTransaction(payload.ledger_row)] : [];

    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'debt.save',
      id: payload.debt_row.id,
      writes_performed: true,
      audit_performed: false,
      atomic_writes: {
        debt_rows: 1,
        ledger_rows: payload.ledger_row ? 1 : 0
      },
      ledger_transaction_id: payload.ledger_row ? payload.ledger_row.id : null,
      debt: normalizeDebtWithLedger(afterRaw, links),
      proof
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);
    const id = path[0];

    if (!id) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'debt id required'
      }, 400);
    }

    const body = await readJSON(context.request);
    const updates = buildDebtUpdatePayload(body);

    if (!updates.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: updates.error
      }, updates.status || 400);
    }

    const keys = Object.keys(updates.payload);

    if (!keys.length) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'No supported fields supplied'
      }, 400);
    }

    await db.prepare(
      `UPDATE debts
       SET ${keys.map(key => `${key} = ?`).join(', ')}
       WHERE id = ?`
    ).bind(...keys.map(key => updates.payload[key]), id).run();

    const afterRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(id).first();

    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'debt.update',
      id,
      debt: normalizeDebt(afterRaw)
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

/* ─────────────────────────────
 * Create / repair payloads
 * ───────────────────────────── */

async function buildCreatePayload(db, body) {
  const name = safeText(body.name || body.title || body.label, '', 100);
  const kind = normalizeKind(body.kind || body.direction || 'owe');

  const originalAmount = Number(body.original_amount ?? body.amount);
  const paidAmount = Number(body.paid_amount || 0);

  const snowballOrder = body.snowball_order === '' || body.snowball_order == null
    ? null
    : Number(body.snowball_order);

  const dueDate = normalizeDate(body.due_date || body.next_due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const installmentAmount = normalizeNullableAmount(body.installment_amount || body.monthly_payment);
  const frequency = normalizeFrequency(body.frequency || 'custom');
  const lastPaidDate = normalizeDate(body.last_paid_date);

  const movementNow = normalizeMovementNow(body);
  const movementDate = normalizeDate(body.movement_date || body.date) || todayISO();

  const accountInput =
    body.account_id ||
    body.source_account_id ||
    body.from_account_id ||
    body.destination_account_id ||
    body.to_account_id ||
    '';

  const notes = safeText(body.notes, '', 500);
  const id = safeText(body.id, '', 160) || makeId('debt');

  if (!name) return { ok: false, status: 400, error: 'name required' };
  if (!kind) return { ok: false, status: 400, error: 'kind must be owe or owed' };

  if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
    return { ok: false, status: 400, error: 'original_amount must be greater than 0' };
  }

  if (!Number.isFinite(paidAmount) || paidAmount < 0) {
    return { ok: false, status: 400, error: 'paid_amount must be 0 or greater' };
  }

  if (paidAmount > originalAmount) {
    return { ok: false, status: 400, error: 'paid_amount cannot exceed original_amount' };
  }

  if (body.due_day !== undefined && body.due_day !== null && body.due_day !== '' && dueDay == null) {
    return { ok: false, status: 400, error: 'due_day must be 1-31' };
  }

  if (
    body.installment_amount !== undefined &&
    body.installment_amount !== null &&
    body.installment_amount !== '' &&
    installmentAmount == null
  ) {
    return { ok: false, status: 400, error: 'installment_amount must be 0 or greater' };
  }

  if (!frequency) return { ok: false, status: 400, error: 'Invalid frequency' };

  let account = null;

  if (movementNow) {
    if (!accountInput) {
      return {
        ok: false,
        status: 400,
        error: kind === 'owed'
          ? 'source_account_id required when owed-to-me money moved now'
          : 'destination account_id required when I-owe money moved now',
        details: {
          kind,
          movement_now: true,
          rule: kind === 'owed'
            ? 'owed_to_me means money leaves selected account'
            : 'i_owe means money enters selected account'
        }
      };
    }

    const accountResult = await resolveAccount(db, accountInput);

    if (!accountResult.ok) {
      return {
        ok: false,
        status: accountResult.status || 409,
        error: accountResult.error,
        details: {
          account_input: accountInput
        }
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
    status: 'active',
    notes: buildDebtNotes(notes, {
      movement_now: movementNow,
      account_id: account ? account.id : null
    })
  };

  const ledgerRow = movementNow
    ? buildDebtOriginLedgerRow({
      debt: debtRow,
      account,
      date: movementDate,
      created_by: safeText(body.created_by, 'web-debts', 80) || 'web-debts'
    })
    : null;

  return {
    ok: true,
    payload: {
      debt_row: debtRow,
      ledger_row: ledgerRow,
      movement_now: movementNow,
      account: account ? sanitizeAccount(account) : null,
      rules: {
        owed_to_me: 'debt_out decreases selected source account',
        i_owe: 'debt_in increases selected destination account',
        atomic_create: true
      }
    }
  };
}

function buildDebtUpdatePayload(body) {
  const payload = {};

  if (body.due_date !== undefined || body.next_due_date !== undefined) {
    payload.due_date = normalizeDate(body.due_date || body.next_due_date);
  }

  if (body.due_day !== undefined) {
    const dueDay = normalizeDueDay(body.due_day);
    if (body.due_day !== '' && body.due_day != null && dueDay == null) {
      return { ok: false, status: 400, error: 'due_day must be 1-31' };
    }
    payload.due_day = dueDay;
  }

  if (body.installment_amount !== undefined) {
    const amount = normalizeNullableAmount(body.installment_amount);
    if (body.installment_amount !== '' && body.installment_amount != null && amount == null) {
      return { ok: false, status: 400, error: 'installment_amount must be 0 or greater' };
    }
    payload.installment_amount = amount;
  }

  if (body.frequency !== undefined) {
    const frequency = normalizeFrequency(body.frequency || 'custom');
    if (!frequency) return { ok: false, status: 400, error: 'Invalid frequency' };
    payload.frequency = frequency;
  }

  if (body.status !== undefined) {
    payload.status = safeText(body.status, 'active', 40).toLowerCase();
  }

  if (body.notes !== undefined) {
    payload.notes = safeText(body.notes, '', 500);
  }

  return {
    ok: true,
    payload
  };
}

function buildDebtOriginLedgerRow({ debt, account, date, created_by }) {
  const isOwedToMe = debt.kind === 'owed';

  const txType = isOwedToMe ? 'debt_out' : 'debt_in';
  const notePrefix = isOwedToMe ? 'Debt given' : 'Debt received';

  return {
    id: makeId(isOwedToMe ? 'debtout' : 'debtin'),
    date,
    type: txType,
    amount: round2(debt.original_amount),
    account_id: account.id,
    transfer_to_account_id: null,
    linked_txn_id: null,
    category_id: DEFAULT_CATEGORY_ID,
    notes: safeText(
      `${notePrefix}: ${debt.name} | debt_id=${debt.id} | kind=${debt.kind} | [DEBT_ORIGIN]`,
      '',
      240
    ),
    fee_amount: 0,
    pra_amount: 0,
    currency: account.currency || 'PKR',
    pkr_amount: round2(debt.original_amount),
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    created_by,
    created_at: nowISO()
  };
}

async function repairMissingLedger(context, body, dryRun) {
  const db = context.env.DB;

  const debtId = safeText(body.debt_id || body.id, '', 160);
  const accountInput =
    body.account_id ||
    body.source_account_id ||
    body.from_account_id ||
    body.destination_account_id ||
    body.to_account_id ||
    '';

  const date = normalizeDate(body.date || body.movement_date) || todayISO();

  if (!debtId) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'debt_id required'
    }, 400);
  }

  if (!accountInput) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'account_id required for missing debt ledger repair'
    }, 400);
  }

  const debt = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     WHERE id = ?
     LIMIT 1`
  ).bind(debtId).first();

  if (!debt) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'debt not found'
    }, 404);
  }

  const existingLinks = await loadDebtLedgerLinks(db, [debtId]);

  if ((existingLinks.get(debtId) || []).length) {
    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'debt.repair_ledger',
      already_linked: true,
      writes_performed: false,
      debt: normalizeDebtWithLedger(debt, existingLinks.get(debtId))
    });
  }

  const accountResult = await resolveAccount(db, accountInput);

  if (!accountResult.ok) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: accountResult.error
    }, accountResult.status || 409);
  }

  const normalizedDebt = normalizeDebt(debt);

  const ledgerRow = buildDebtOriginLedgerRow({
    debt: normalizedDebt,
    account: accountResult.account,
    date,
    created_by: safeText(body.created_by, 'web-debts-repair', 80) || 'web-debts-repair'
  });

  const proof = {
    action: 'debt.repair_ledger',
    version: VERSION,
    writes_performed: false,
    expected_transaction_rows: 1,
    expected_debt_rows: 0,
    debt_id: debtId,
    ledger_transaction_id: ledgerRow.id,
    rule: normalizedDebt.kind === 'owed'
      ? 'owed_to_me repair writes debt_out and decreases selected source account'
      : 'i_owe repair writes debt_in and increases selected destination account'
  };

  if (dryRun) {
    return jsonResponse({
      ok: true,
      version: VERSION,
      dry_run: true,
      action: 'debt.repair_ledger',
      writes_performed: false,
      proof,
      ledger_row: ledgerRow
    });
  }

  const txCols = await tableColumns(db, 'transactions');
  await buildTransactionInsert(db, txCols, ledgerRow).run();

  return jsonResponse({
    ok: true,
    version: VERSION,
    action: 'debt.repair_ledger',
    writes_performed: true,
    debt_id: debtId,
    ledger_transaction_id: ledgerRow.id,
    proof,
    debt: normalizeDebtWithLedger(debt, [sanitizeTransaction(ledgerRow)])
  });
}

/* ─────────────────────────────
 * Health
 * ───────────────────────────── */

async function getHealth(db) {
  const debtsRes = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     ORDER BY created_at DESC`
  ).all();

  const debts = debtsRes.results || [];
  const ids = debts.map(d => safeText(d.id, '', 160)).filter(Boolean);
  const links = await loadDebtLedgerLinks(db, ids);

  let active = 0;
  let missingLedgerCandidates = 0;
  let ledgerLinked = 0;

  for (const debt of debts) {
    const normalized = normalizeDebt(debt);

    if (normalized.status === 'active') {
      active += 1;
    }

    const debtLinks = links.get(String(debt.id)) || [];

    if (debtLinks.length) {
      ledgerLinked += 1;
    }

    const movedLikely = String(debt.notes || '').includes('movement_now=1') ||
      String(debt.notes || '').includes('[DEBT_ORIGIN]');

    if (normalized.status === 'active' && movedLikely && !debtLinks.length) {
      missingLedgerCandidates += 1;
    }
  }

  return jsonResponse({
    ok: true,
    version: VERSION,
    status: missingLedgerCandidates ? 'warn' : 'ok',
    debt_rows: debts.length,
    active_debts: active,
    ledger_linked,
    missing_ledger_candidates: missingLedgerCandidates,
    rules: {
      owed_to_me_requires_debt_out: true,
      i_owe_requires_debt_in: true,
      atomic_create_when_movement_now: true
    }
  });
}

/* ─────────────────────────────
 * Inserts / loaders
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
    'active',
    row.notes
  );
}

function buildTransactionInsert(db, txCols, row) {
  const insertable = {};

  for (const [key, value] of Object.entries(row)) {
    if (txCols.has(key)) {
      insertable[key] = value;
    }
  }

  const keys = Object.keys(insertable);

  if (!keys.length) {
    throw new Error('transactions table has no insertable columns for debt ledger row');
  }

  return db.prepare(
    `INSERT INTO transactions (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => insertable[key]));
}

async function loadDebtLedgerLinks(db, debtIds) {
  const map = new Map();

  for (const id of debtIds || []) {
    map.set(String(id), []);
  }

  if (!debtIds || !debtIds.length) return map;

  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('notes')) return map;

  const select = [
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
  ].filter(col => txCols.has(col));

  for (const chunk of chunks(debtIds, 40)) {
    const conditions = chunk.map(() => 'notes LIKE ?').join(' OR ');
    const args = chunk.map(id => `%debt_id=${id}%`);

    const res = await db.prepare(
      `SELECT ${select.join(', ')}
       FROM transactions
       WHERE ${conditions}
       ORDER BY ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
    ).bind(...args).all();

    for (const tx of res.results || []) {
      const matched = extractDebtId(tx.notes);

      if (matched) {
        if (!map.has(matched)) map.set(matched, []);
        map.get(matched).push(sanitizeTransaction(tx));
      }
    }
  }

  return map;
}

async function resolveAccount(db, input) {
  const raw = safeText(input, '', 160);

  if (!raw) {
    return {
      ok: false,
      status: 400,
      error: 'account_id required'
    };
  }

  const cols = await tableColumns(db, 'accounts');

  if (!cols.has('id')) {
    return {
      ok: false,
      status: 500,
      error: 'accounts table missing id column'
    };
  }

  const where = activeAccountWhere(cols);

  const exact = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?
     ${where ? 'AND ' + where : ''}
     LIMIT 1`
  ).bind(raw).first();

  if (exact && exact.id) {
    return {
      ok: true,
      account: normalizeAccount(exact)
    };
  }

  const order = cols.has('display_order') && cols.has('name')
    ? 'display_order, name'
    : (cols.has('name') ? 'name' : 'id');

  const rows = await db.prepare(
    `SELECT *
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${order}`
  ).all();

  const wanted = token(raw);

  const matched = (rows.results || []).find(account => {
    const idToken = token(account.id);
    const nameToken = token(account.name);
    const labelToken = token(((account.icon || '') + ' ' + (account.name || '')).trim());

    return wanted === idToken ||
      wanted === nameToken ||
      wanted === labelToken ||
      raw.toLowerCase() === String(account.name || '').trim().toLowerCase();
  });

  if (matched && matched.id) {
    return {
      ok: true,
      account: normalizeAccount(matched)
    };
  }

  return {
    ok: false,
    status: 409,
    error: 'Account not found or inactive.'
  };
}

function activeAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR status = 'active')");

  return clauses.join(' AND ');
}

function normalizeAccount(account) {
  return {
    ...account,
    id: safeText(account.id, '', 160),
    name: safeText(account.name || account.id, '', 160),
    currency: safeText(account.currency || 'PKR', 'PKR', 10).toUpperCase()
  };
}

function sanitizeAccount(account) {
  return {
    id: account.id,
    name: account.name,
    currency: account.currency || 'PKR'
  };
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
    notes: tx.notes || '',
    reversed_by: tx.reversed_by || null,
    reversed_at: tx.reversed_at || null,
    created_at: tx.created_at || null
  };
}

/* ─────────────────────────────
 * Normalize / proof
 * ───────────────────────────── */

function normalizeDebtWithLedger(row, links) {
  const debt = normalizeDebt(row);
  const activeLinks = (links || []).filter(tx => !isReversedTransaction(tx));

  return {
    ...debt,
    ledger_linked: activeLinks.length > 0,
    ledger_transaction_ids: activeLinks.map(tx => tx.id),
    ledger_transactions: activeLinks,
    ledger_required: String(debt.notes || '').includes('movement_now=1') ||
      String(debt.notes || '').includes('[DEBT_ORIGIN]')
  };
}

function normalizeDebt(row) {
  const original = Number(row && row.original_amount) || 0;
  const paid = Number(row && row.paid_amount) || 0;
  const remaining = Math.max(0, original - paid);

  const dueDate = row && row.due_date ? normalizeDate(row.due_date) : null;
  const dueDay = row && row.due_day == null ? null : normalizeDueDay(row.due_day);
  const installmentAmount = row && row.installment_amount == null
    ? null
    : normalizeNullableAmount(row.installment_amount);

  const frequency = normalizeFrequency(row && row.frequency ? row.frequency : 'monthly') || 'monthly';
  const lastPaidDate = row && row.last_paid_date ? normalizeDate(row.last_paid_date) : null;

  const schedule = computeDebtSchedule({
    remaining,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    last_paid_date: lastPaidDate
  });

  return {
    id: safeText(row && row.id, '', 160),
    name: safeText(row && row.name, '', 120),
    kind: normalizeKind(row && row.kind) || 'owe',
    original_amount: round2(original),
    paid_amount: round2(paid),
    remaining_amount: round2(remaining),
    snowball_order: row && row.snowball_order == null ? null : Number(row.snowball_order),
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount == null ? null : round2(installmentAmount),
    frequency,
    last_paid_date: lastPaidDate,
    next_due_date: schedule.next_due_date,
    days_until_due: schedule.days_until_due,
    days_overdue: schedule.days_overdue,
    due_status: schedule.due_status,
    schedule_missing: schedule.schedule_missing,
    status: safeText(row && row.status, 'active', 40).toLowerCase(),
    notes: safeText(row && row.notes, '', 500),
    created_at: row && row.created_at ? safeText(row.created_at, '', 40) : null
  };
}

function buildDebtCreateProof(debt, payload) {
  const hasMovement = Boolean(payload.ledger_row);

  return {
    action: 'debt.save',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: hasMovement
      ? 'atomic_debt_create_plus_ledger_origin'
      : 'debt_record_only_no_money_moved',
    expected_debt_rows: 1,
    expected_transaction_rows: hasMovement ? 1 : 0,
    expected_ledger_rows: hasMovement ? 1 : 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: debt.id,
      name: debt.name,
      kind: debt.kind,
      original_amount: debt.original_amount,
      paid_amount: debt.paid_amount,
      remaining_amount: debt.remaining_amount,
      movement_now: payload.movement_now,
      account_id: payload.account ? payload.account.id : null,
      ledger_type: payload.ledger_row ? payload.ledger_row.type : null
    },
    checks: [
      proofCheck('name_valid', 'pass', 'request.name', 'Debt name exists.'),
      proofCheck('kind_valid', 'pass', 'request.kind', 'Debt kind is owe or owed.'),
      proofCheck('amount_valid', 'pass', 'request.original_amount', 'Original amount is greater than 0.'),
      proofCheck('paid_amount_valid', 'pass', 'request.paid_amount', 'Paid amount is safe.'),
      proofCheck(
        'money_movement_account_rule',
        'pass',
        'request.account_id',
        hasMovement
          ? 'Money moved now and account was resolved.'
          : 'Debt record only; no account movement requested.'
      ),
      proofCheck(
        'ledger_origin_rule',
        'pass',
        'transactions',
        hasMovement
          ? (debt.kind === 'owed'
            ? 'owed_to_me writes debt_out and decreases selected account.'
            : 'i_owe writes debt_in and increases selected account.')
          : 'No ledger row expected because money_moved_now is false.'
      ),
      proofCheck('atomic_write_required', 'pass', 'D1.batch', 'Debt row and ledger row commit in one batch when movement exists.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before INSERT.')
    ]
  };
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

/* ─────────────────────────────
 * Command Centre
 * ───────────────────────────── */

async function commandAllowsDebtAction(context, action) {
  try {
    const origin = new URL(context.request.url).origin;

    const res = await fetch(
      origin + '/api/finance-command-center?gate=' + encodeURIComponent(action) + '&cb=' + Date.now(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-sovereign-debt-gate': action
        }
      }
    );

    const data = await res.json().catch(() => null);

    const found = data && data.enforcement && Array.isArray(data.enforcement.actions)
      ? data.enforcement.actions.find(item => item.action === action)
      : null;

    return Boolean(found && found.allowed);
  } catch {
    return false;
  }
}

/* ─────────────────────────────
 * Debt schedule
 * ───────────────────────────── */

function computeDebtSchedule(input) {
  const remaining = Number(input.remaining) || 0;
  const dueDate = input.due_date || null;
  const dueDay = input.due_day == null ? null : Number(input.due_day);
  const lastPaidDate = input.last_paid_date || null;

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

  if (dueDate) {
    nextDue = parseDate(dueDate);
  } else if (dueDay != null) {
    nextDue = nextDueFromDay(dueDay, lastPaidDate);
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

function nextDueFromDay(dueDay, lastPaidDate) {
  const now = new Date();
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), dueDay);

  if (lastPaidDate && lastPaidDate.slice(0, 7) === today.toISOString().slice(0, 7)) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, dueDay);
  } else if (candidate < today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, dueDay);
  }

  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, max);
  return new Date(Date.UTC(year, monthIndex, safeDay));
}

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

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

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(x => safeText(x, '', 180));

  return String(raw).split('/').filter(Boolean).map(x => safeText(x, '', 180));
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isDryRunRequest(context, body) {
  const url = new URL(context.request.url);

  return url.searchParams.get('dry_run') === '1' ||
    url.searchParams.get('dry_run') === 'true' ||
    body.dry_run === true ||
    body.dry_run === '1' ||
    body.dry_run === 'true';
}

function normalizeMovementNow(body) {
  const value =
    body.movement_now ??
    body.money_moved_now ??
    body.ledger_movement_now ??
    body.create_ledger ??
    body.ledger_now ??
    false;

  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;

  const raw = String(value).trim().toLowerCase();

  return ['1', 'true', 'yes', 'y', 'on', 'moved'].includes(raw);
}

function normalizeKind(kind) {
  const text = String(kind || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'debt'].includes(text)) return 'owe';
  if (['owed', 'owed_me', 'to_me', 'receivable', 'owed_to_me'].includes(text)) return 'owed';

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

  const date = new Date(raw + 'T00:00:00.000Z');

  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const day = Number(value);

  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  return Math.floor(day);
}

function normalizeNullableAmount(value) {
  if (value === undefined || value === null || value === '') return null;

  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) return null;

  return round2(amount);
}

function normalizeFrequency(value) {
  const frequency = safeText(value, 'monthly', 20).toLowerCase();

  if (ALLOWED_FREQUENCY.includes(frequency)) return frequency;

  return null;
}

function buildDebtNotes(notes, meta) {
  const pieces = [];

  if (notes) pieces.push(notes);

  pieces.push(meta.movement_now ? 'movement_now=1' : 'movement_now=0');

  if (meta.account_id) pieces.push('account_id=' + meta.account_id);

  return safeText(pieces.join(' | '), '', 500);
}

function extractDebtId(notes) {
  const match = String(notes || '').match(/debt_id=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function isReversedTransaction(tx) {
  const notes = String(tx?.notes || '').toUpperCase();

  return !!(
    tx?.reversed_by ||
    tx?.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function sumRemaining(rows) {
  return rows.reduce((sum, debt) => sum + Math.max(0, Number(debt.remaining_amount) || 0), 0);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.round(ms / 86400000);
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

function chunks(values, size) {
  const out = [];

  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }

  return out;
}

function safeText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function token(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}