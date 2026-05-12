/* /api/transactions
 * Sovereign Finance · Transactions Engine
 * v0.5.5-read-write-unblock
 *
 * Purpose:
 * - Restore POST writes after recovery route disabled them.
 * - Keep GET returning JSON for Ledger.
 * - Support dry-run + payload hash commit.
 * - Support expense, income, transfer.
 * - Transfer writes 2 linked rows.
 * - Balance projection skips reversal rows and reversed originals.
 */

const VERSION = 'v0.5.5-read-write-unblock';

const FRONTEND_ADD_TYPES = ['expense', 'income', 'transfer'];

const SYSTEM_TYPES = [
  'cc_payment',
  'cc_spend',
  'borrow',
  'repay',
  'atm',
  'salary',
  'opening',
  'debt_in',
  'debt_out'
];

const ALLOWED_TYPES = FRONTEND_ADD_TYPES.concat(SYSTEM_TYPES);

const CATEGORY_ALIASES = {
  grocery: 'groceries',
  groceries: 'groceries',
  food: 'food_dining',
  food_dining: 'food_dining',
  dining: 'food_dining',
  transport: 'transport',
  travel: 'transport',
  bill: 'bills_utilities',
  bills: 'bills_utilities',
  utility: 'bills_utilities',
  utilities: 'bills_utilities',
  bills_utilities: 'bills_utilities',
  health: 'health',
  medical: 'health',
  fee: 'bank_fee',
  bank_fee: 'bank_fee',
  atm: 'atm_fee',
  atm_fee: 'atm_fee',
  cc: 'credit_card',
  card: 'credit_card',
  credit: 'credit_card',
  credit_card: 'credit_card',
  cc_payment: 'credit_card',
  cc_spend: 'credit_card',
  debt: 'debt_payment',
  debt_payment: 'debt_payment',
  repay: 'debt_payment',
  repayment: 'debt_payment',
  salary: 'salary_income',
  salary_income: 'salary_income',
  income: 'manual_income',
  manual_income: 'manual_income',
  manual: 'manual_income',
  transfer: 'transfer',
  misc: 'misc',
  miscellaneous: 'misc',
  other: 'misc',
  general: 'misc',
  intl: 'intl_subscription',
  international: 'intl_subscription',
  international_purchase: 'intl_subscription',
  intl_subscription: 'intl_subscription'
};

const DEFAULT_CC_LIMIT = 100000;
const BALANCE_TOLERANCE = 0.01;
const CC_OVERLIMIT_TOLERANCE = 1.0;

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);

    const includeReversed = url.searchParams.get('include_reversed') === '1';
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);

    const txCols = await tableColumns(db, 'transactions');

    if (!txCols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        error: 'transactions table missing id column'
      }, 500);
    }

    const select = selectTransactionColumns(txCols);
    const fetchLimit = includeReversed
      ? limit
      : Math.min(500, Math.max(limit * 5, limit + 100));

    const result = await db.prepare(
      `SELECT ${select.join(', ')}
       FROM transactions
       ORDER BY ${buildOrderBy(txCols)}
       LIMIT ?`
    ).bind(fetchLimit).all();

    const decorated = (result.results || []).map(decorateTransaction);

    const visible = includeReversed
      ? decorated.slice(0, limit)
      : decorated.filter(row => !row.is_reversal).slice(0, limit);

    return json({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
      count: visible.length,
      fetched_count: decorated.length,
      hidden_reversal_count: includeReversed ? 0 : decorated.filter(row => row.is_reversal).length,
      contract: {
        frontend_add_types: FRONTEND_ADD_TYPES,
        backend_system_types: SYSTEM_TYPES,
        unsupported_types: ['adjustment'],
        dry_run_required: true,
        commit_requires_payload_hash: true,
        category_aliases: CATEGORY_ALIASES
      },
      transactions: visible
    });
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
    const url = new URL(context.request.url);
    const body = await readJSON(context.request);
    const dryRun = isDryRun(url, body);

    const validation = await validatePayload(context, body);

    if (!validation.ok) {
      return json({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        writes_performed: false,
        audit_performed: false,
        payload_hash: validation.payload_hash,
        override_token: validation.override_token,
        requires_override: validation.requires_override,
        override_reason: validation.override_reason,
        warnings: validation.warnings,
        proof: validation.proof,
        normalized_payload: validation.normalized_payload
      });
    }

    const hashCheck = checkCommitHash(body, validation);

    if (!hashCheck.ok) {
      return json({
        ok: false,
        version: VERSION,
        error: hashCheck.error,
        supplied_hash: hashCheck.supplied_hash,
        expected_hash: validation.payload_hash,
        normalized_payload: validation.normalized_payload,
        next_step: 'Run dry-run first, then commit with dry_run_payload_hash.'
      }, hashCheck.status);
    }

    const overrideCheck = checkOverrideToken(body, validation);

    if (!overrideCheck.ok) {
      return json({
        ok: false,
        version: VERSION,
        error: overrideCheck.error,
        requires_override: validation.requires_override,
        override_reason: validation.override_reason,
        override_token_required: true
      }, overrideCheck.status);
    }

    if (validation.normalized_payload.type === 'transfer') {
      return createTransferPair(context, validation);
    }

    return createSingleTransaction(context, validation);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

async function validatePayload(context, body) {
  const db = context.env.DB;
  const warnings = [];

  const amount = roundMoney(Number(body.amount));
  const requestedType = text(body.type || body.transaction_type, '', 40).toLowerCase();
  const type = normalizeType(requestedType);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'Amount must be greater than 0'
    };
  }

  if (!requestedType) {
    return {
      ok: false,
      status: 400,
      error: 'type required'
    };
  }

  if (requestedType === 'adjustment' || type === 'adjustment') {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported transaction type',
      details: {
        rejected_type: requestedType,
        allowed_frontend_types: FRONTEND_ADD_TYPES
      }
    };
  }

  if (!ALLOWED_TYPES.includes(type)) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid type',
      details: {
        rejected_type: requestedType,
        allowed_types: ALLOWED_TYPES
      }
    };
  }

  const sourceInput = body.account_id || body.from_account_id;

  if (!sourceInput) {
    return {
      ok: false,
      status: 400,
      error: 'account_id required'
    };
  }

  const sourceResult = await resolveAccount(db, sourceInput);

  if (!sourceResult.ok) {
    return {
      ok: false,
      status: sourceResult.status || 409,
      error: sourceResult.error,
      details: {
        account_input: text(sourceInput, '', 160)
      }
    };
  }

  const sourceAccount = sourceResult.account;

  let transferToAccount = null;

  const transferTargetInput =
    body.transfer_to_account_id ||
    body.to_account_id ||
    body.destination_account_id;

  if (type === 'transfer' || type === 'cc_payment' || transferTargetInput) {
    if ((type === 'transfer' || type === 'cc_payment') && !transferTargetInput) {
      return {
        ok: false,
        status: 400,
        error: 'transfer_to_account_id required for ' + type
      };
    }

    if (transferTargetInput) {
      const targetResult = await resolveAccount(db, transferTargetInput);

      if (!targetResult.ok) {
        return {
          ok: false,
          status: targetResult.status || 409,
          error: targetResult.error,
          details: {
            transfer_to_account_input: text(transferTargetInput, '', 160)
          }
        };
      }

      transferToAccount = targetResult.account;

      if (sourceAccount.id === transferToAccount.id) {
        return {
          ok: false,
          status: 400,
          error: 'source and destination accounts cannot match'
        };
      }
    }
  }

  let categoryId = null;

  if (type !== 'transfer') {
    const categoryInput = body.category_id || body.category;
    const categoryResult = await resolveCategory(db, categoryInput, type);

    if (!categoryResult.ok) {
      return {
        ok: false,
        status: categoryResult.status || 409,
        error: categoryResult.error,
        details: {
          category_input: text(categoryInput, '', 160)
        }
      };
    }

    categoryId = categoryResult.category_id;
  }

  const currency = normalizeCurrency(body.currency || body.currency_code || 'PKR');
  const fxRate = normalizeFxRate(body.fx_rate_at_commit || body.fx_rate, currency);
  const pkrAmount = roundMoney(currency === 'PKR' ? amount : amount * fxRate);

  const normalized = {
    date: normalizeDate(body.date),
    type,
    requested_type: requestedType,
    amount,
    pkr_amount: pkrAmount,
    currency,
    fx_rate_at_commit: fxRate,
    fx_source: text(body.fx_source, currency === 'PKR' ? 'PKR-base' : 'client-supplied', 80),
    account_id: sourceAccount.id,
    account_name: sourceAccount.name || sourceAccount.id,
    transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
    transfer_to_account_name: transferToAccount ? (transferToAccount.name || transferToAccount.id) : null,
    category_id: categoryId,
    notes: cleanNotes(body.notes || body.description || body.memo),
    fee_amount: cleanAmount(body.fee_amount),
    pra_amount: cleanAmount(body.pra_amount),
    created_by: text(body.created_by, 'web-ledger', 80) || 'web-ledger'
  };

  const balanceProof = await buildBalanceProof(db, normalized, sourceAccount, transferToAccount);
  const duplicateProof = await buildDuplicateProof(db, normalized);

  if (duplicateProof.status === 'warn') {
    warnings.push(duplicateProof);
  }

  const requiresOverride = balanceProof.requires_override === true;
  const overrideReason = requiresOverride ? balanceProof.override_reason : null;

  const payloadHash = await hashPayload({
    route: 'transactions',
    normalized_payload: normalized
  });

  const overrideToken = requiresOverride
    ? await hashPayload({
      route: 'transactions',
      override_reason: overrideReason,
      normalized_payload: normalized
    })
    : null;

  const proof = buildProof(normalized, {
    balance: balanceProof,
    duplicate: duplicateProof,
    warnings
  });

  return {
    ok: true,
    normalized_payload: normalized,
    payload_hash: payloadHash,
    requires_override: requiresOverride,
    override_reason: overrideReason,
    override_token: overrideToken,
    warnings,
    proof
  };
}

function buildProof(payload, checks) {
  const isTransfer = payload.type === 'transfer';

  return {
    action: 'transaction.save',
    version: VERSION,
    writes_performed: false,
    validation_status: checks.balance.blocked ? 'blocked' : 'pass',
    write_model: isTransfer ? 'linked_transfer_pair' : 'single_transaction_row',
    expected_transaction_rows: isTransfer ? 2 : 1,
    expected_audit_rows: 0,
    contract: {
      frontend_add_types: FRONTEND_ADD_TYPES,
      unsupported_types: ['adjustment'],
      requested_type: payload.requested_type,
      normalized_type: payload.type,
      canonical_category_id: payload.category_id,
      dry_run_required: true,
      commit_requires_payload_hash: true
    },
    checks: [
      {
        check: 'amount_valid',
        status: 'pass',
        source: 'request.amount',
        detail: 'Amount is finite and greater than zero.'
      },
      {
        check: 'type_allowed',
        status: 'pass',
        source: 'request.type',
        detail: 'Type normalized to ' + payload.type + '.'
      },
      {
        check: 'source_account_active',
        status: 'pass',
        source: 'accounts',
        detail: 'Source account resolved to active account_id ' + payload.account_id + '.'
      },
      {
        check: 'destination_account_valid',
        status: payload.type === 'transfer' || payload.type === 'cc_payment' ? 'pass' : 'not_required',
        source: 'accounts',
        detail: payload.transfer_to_account_id
          ? 'Destination account resolved to active account_id ' + payload.transfer_to_account_id + '.'
          : 'Destination account not required.'
      },
      {
        check: 'category_valid',
        status: payload.category_id ? 'pass' : 'not_required',
        source: 'categories',
        detail: payload.category_id
          ? 'Category resolved to canonical category_id ' + payload.category_id + '.'
          : 'Category is empty or not required.'
      },
      checks.balance,
      checks.duplicate
    ],
    warnings: checks.warnings
  };
}

async function createSingleTransaction(context, validation) {
  const db = context.env.DB;
  const payload = validation.normalized_payload;
  const txCols = await tableColumns(db, 'transactions');
  const id = makeTxnId('tx');

  const row = filterToCols(txCols, {
    id,
    date: payload.date,
    type: payload.type,
    amount: payload.amount,
    account_id: payload.account_id,
    transfer_to_account_id: payload.transfer_to_account_id,
    linked_txn_id: null,
    category_id: payload.category_id,
    notes: payload.notes,
    fee_amount: payload.fee_amount,
    pra_amount: payload.pra_amount,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    created_by: payload.created_by,
    created_at: nowISO()
  });

  try {
    await buildInsert(db, 'transactions', row).run();
  } catch (err) {
    if (isForeignKeyError(err)) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Transaction failed account/category foreign-key guard.',
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  return json({
    ok: true,
    version: VERSION,
    id,
    account_id: payload.account_id,
    account_name: payload.account_name,
    transfer_to_account_id: payload.transfer_to_account_id,
    transfer_to_account_name: payload.transfer_to_account_name,
    category_id: payload.category_id,
    audited: false,
    audit_error: null,
    payload_hash: validation.payload_hash,
    proof: validation.proof
  });
}

async function createTransferPair(context, validation) {
  const db = context.env.DB;
  const payload = validation.normalized_payload;
  const txCols = await tableColumns(db, 'transactions');

  const outId = makeTxnId('txout');
  const inId = makeTxnId('txin');
  const baseNotes = cleanNotes(payload.notes || 'Transfer');

  const outNotes = `To: ${payload.transfer_to_account_name || payload.transfer_to_account_id} ${baseNotes} (OUT) [linked: ${inId}]`.slice(0, 240);
  const inNotes = `From: ${payload.account_name || payload.account_id} ${baseNotes} (IN) [linked: ${outId}]`.slice(0, 240);

  const outRow = filterToCols(txCols, {
    id: outId,
    date: payload.date,
    type: 'transfer',
    amount: payload.amount,
    account_id: payload.account_id,
    transfer_to_account_id: payload.transfer_to_account_id,
    linked_txn_id: inId,
    category_id: null,
    notes: outNotes,
    fee_amount: payload.fee_amount,
    pra_amount: payload.pra_amount,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    created_by: payload.created_by,
    created_at: nowISO()
  });

  const inRow = filterToCols(txCols, {
    id: inId,
    date: payload.date,
    type: 'income',
    amount: payload.amount,
    account_id: payload.transfer_to_account_id,
    transfer_to_account_id: payload.account_id,
    linked_txn_id: outId,
    category_id: null,
    notes: inNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    created_by: payload.created_by,
    created_at: nowISO()
  });

  try {
    await db.batch([
      buildInsert(db, 'transactions', outRow),
      buildInsert(db, 'transactions', inRow)
    ]);
  } catch (err) {
    if (isForeignKeyError(err)) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Transfer failed account foreign-key guard.',
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  return json({
    ok: true,
    version: VERSION,
    id: outId,
    linked_id: inId,
    ids: [outId, inId],
    from_account_id: payload.account_id,
    from_account_name: payload.account_name,
    to_account_id: payload.transfer_to_account_id,
    to_account_name: payload.transfer_to_account_name,
    transfer_model: 'linked_pair',
    audited: false,
    audit_error: null,
    payload_hash: validation.payload_hash,
    proof: validation.proof
  });
}

async function buildBalanceProof(db, payload, sourceAccount, transferToAccount) {
  const sourceBalance = await computeAccountBalance(db, payload.account_id);
  const sourceProjection = projectBalance(sourceBalance.balance, payload.type, payload.pkr_amount, 'source');

  const sourceKind = classifyAccount(sourceAccount);
  const sourceLimit = accountCreditLimit(sourceAccount);

  const proof = {
    check: 'balance_projection',
    status: 'pass',
    source: 'transactions',
    account_id: payload.account_id,
    account_kind: sourceKind,
    current_balance: roundMoney(sourceBalance.balance),
    projected_balance: roundMoney(sourceProjection),
    transaction_count: sourceBalance.txn_count,
    skipped_inactive_transaction_count: sourceBalance.skipped_inactive_count,
    requires_override: false,
    override_reason: null,
    blocked: false,
    detail: 'Projected source account balance is within constraints.'
  };

  if (sourceKind === 'asset' && sourceProjection < -BALANCE_TOLERANCE) {
    proof.status = 'blocked';
    proof.requires_override = true;
    proof.blocked = true;
    proof.override_reason = 'asset_overdraft';
    proof.detail = 'Asset account would go negative.';
  }

  if (sourceKind === 'liability') {
    const outstanding = Math.max(0, -sourceProjection);

    proof.projected_outstanding = roundMoney(outstanding);
    proof.credit_limit = sourceLimit;

    if (outstanding > sourceLimit + CC_OVERLIMIT_TOLERANCE) {
      proof.status = 'blocked';
      proof.requires_override = true;
      proof.blocked = true;
      proof.override_reason = 'cc_overlimit';
      proof.detail = 'Liability account would exceed limit.';
    }
  }

  if (payload.type === 'transfer' && transferToAccount) {
    const targetBalance = await computeAccountBalance(db, payload.transfer_to_account_id);
    const targetProjection = projectBalance(targetBalance.balance, 'income', payload.pkr_amount, 'target');

    proof.transfer_target = {
      account_id: payload.transfer_to_account_id,
      current_balance: roundMoney(targetBalance.balance),
      projected_balance: roundMoney(targetProjection),
      transaction_count: targetBalance.txn_count,
      skipped_inactive_transaction_count: targetBalance.skipped_inactive_count
    };
  }

  return proof;
}

async function computeAccountBalance(db, accountId) {
  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('account_id')) {
    return {
      balance: 0,
      txn_count: 0,
      skipped_inactive_count: 0
    };
  }

  const select = [
    'id',
    'type',
    'amount',
    'pkr_amount',
    'notes',
    'reversed_by',
    'reversed_at'
  ].filter(col => txCols.has(col));

  const rows = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE account_id = ?`
  ).bind(accountId).all();

  let balance = 0;
  let txnCount = 0;
  let skipped = 0;

  for (const row of rows.results || []) {
    if (isInactiveForBalance(row)) {
      skipped += 1;
      continue;
    }

    const amount = Number(row.pkr_amount || row.amount || 0);
    balance += signedAmount(row.type, amount);
    txnCount += 1;
  }

  return {
    balance,
    txn_count: txnCount,
    skipped_inactive_count: skipped
  };
}

async function buildDuplicateProof(db, payload) {
  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('date') || !txCols.has('type') || !txCols.has('account_id') || !txCols.has('amount')) {
    return {
      check: 'duplicate_suspicion',
      status: 'not_available',
      source: 'transactions',
      detail: 'Required columns missing.'
    };
  }

  const select = [
    'id',
    'date',
    'type',
    'amount',
    'account_id',
    'category_id',
    'notes',
    'reversed_by',
    'reversed_at'
  ].filter(col => txCols.has(col));

  const rows = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE date = ?
       AND type = ?
       AND account_id = ?
       AND ROUND(amount, 2) = ROUND(?, 2)
     ORDER BY ${buildOrderBy(txCols)}
     LIMIT 5`
  ).bind(payload.date, payload.type, payload.account_id, payload.amount).all();

  const matches = (rows.results || []).filter(row => {
    if (isInactiveForBalance(row)) return false;
    if (payload.category_id && row.category_id && payload.category_id !== row.category_id) return false;
    return true;
  });

  if (!matches.length) {
    return {
      check: 'duplicate_suspicion',
      status: 'pass',
      source: 'transactions',
      detail: 'No duplicate found.'
    };
  }

  return {
    check: 'duplicate_suspicion',
    status: 'warn',
    source: 'transactions',
    duplicate_count: matches.length,
    possible_duplicate_ids: matches.map(row => row.id),
    detail: 'Possible duplicate transaction.'
  };
}

async function resolveAccount(db, input) {
  const raw = text(input, '', 160);

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
      account: exact
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
      account: matched
    };
  }

  return {
    ok: false,
    status: 409,
    error: 'Account not found or inactive.'
  };
}

async function resolveCategory(db, input, type) {
  const raw = text(input, '', 160);

  if (!raw) {
    if (type === 'income' || type === 'salary') {
      return resolveCategory(db, type === 'salary' ? 'salary_income' : 'manual_income', type);
    }

    return resolveCategory(db, 'misc', type);
  }

  const cols = await tableColumns(db, 'categories');

  if (!cols.has('id')) {
    return {
      ok: false,
      status: 409,
      error: 'categories table missing id column'
    };
  }

  const canonical = canonicalCategory(raw);

  const exact = await db.prepare(
    `SELECT id
     FROM categories
     WHERE id = ?
     LIMIT 1`
  ).bind(canonical).first();

  if (exact && exact.id) {
    return {
      ok: true,
      category_id: exact.id
    };
  }

  const rows = await db.prepare(
    `SELECT *
     FROM categories
     ORDER BY ${cols.has('name') ? 'name, id' : 'id'}`
  ).all();

  const wanted = token(canonical);

  const matched = (rows.results || []).find(category => {
    return wanted === token(category.id) ||
      wanted === token(category.name) ||
      raw.toLowerCase() === String(category.name || '').trim().toLowerCase();
  });

  if (matched && matched.id) {
    return {
      ok: true,
      category_id: matched.id
    };
  }

  return {
    ok: false,
    status: 409,
    error: 'Category not found.'
  };
}

function selectTransactionColumns(cols) {
  return [
    'id',
    'date',
    'type',
    'amount',
    'account_id',
    'transfer_to_account_id',
    'category_id',
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
    'linked_txn_id',
    'created_by',
    'created_at'
  ].filter(col => cols.has(col));
}

function decorateTransaction(row) {
  const notes = String(row.notes || '');
  const upper = notes.toUpperCase();

  const isReversal = upper.includes('[REVERSAL OF ');
  const isReversed = !!(
    row.reversed_by ||
    row.reversed_at ||
    upper.includes('[REVERSED BY ')
  );

  const linkedFromNote = extractLinkedId(notes);

  const groupId =
    row.intl_package_id ||
    row.linked_txn_id ||
    linkedFromNote ||
    null;

  return {
    ...row,
    display_amount: Number(row.pkr_amount || row.amount || 0),
    is_reversal: isReversal,
    is_reversed: isReversed,
    reverse_eligible: !isReversal && !isReversed,
    reverse_block_reason: isReversal
      ? 'reversal_row'
      : (isReversed ? 'already_reversed' : null),
    group_id: groupId,
    group_type: row.intl_package_id
      ? 'intl_package'
      : (groupId ? 'linked_pair' : 'single')
  };
}

function isInactiveForBalance(row) {
  const notes = String(row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function projectBalance(current, type, amount, side) {
  if (side === 'target') return current + amount;
  return current + signedAmount(type, amount);
}

function signedAmount(type, amount) {
  const normalized = normalizeType(type);

  if (['income', 'salary', 'opening', 'borrow', 'debt_in'].includes(normalized)) return amount;
  return -amount;
}

function classifyAccount(account) {
  const joined = [
    account.kind,
    account.type,
    account.account_type,
    account.name,
    account.id
  ].map(value => String(value || '').toLowerCase()).join(' ');

  if (
    joined.includes('liability') ||
    joined.includes('credit') ||
    joined.includes('cc') ||
    joined.includes('card')
  ) {
    return 'liability';
  }

  return 'asset';
}

function accountCreditLimit(account) {
  const candidates = [
    account.credit_limit,
    account.limit_amount,
    account.account_limit,
    account.balance_limit
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return DEFAULT_CC_LIMIT;
}

function checkCommitHash(body, validation) {
  const supplied = text(body.dry_run_payload_hash || body.payload_hash, '', 200);

  if (!supplied) {
    return {
      ok: false,
      status: 428,
      error: 'dry_run_payload_hash required before commit',
      supplied_hash: ''
    };
  }

  if (supplied !== validation.payload_hash) {
    return {
      ok: false,
      status: 409,
      error: 'Payload changed after dry-run. Run dry-run again.',
      supplied_hash: supplied
    };
  }

  return {
    ok: true
  };
}

function checkOverrideToken(body, validation) {
  if (!validation.requires_override) return { ok: true };

  const supplied = text(body.override_token, '', 200);

  if (!supplied) {
    return {
      ok: false,
      status: 428,
      error: 'override_token required for blocked balance projection'
    };
  }

  if (supplied !== validation.override_token) {
    return {
      ok: false,
      status: 409,
      error: 'Invalid override_token.'
    };
  }

  return {
    ok: true
  };
}

function normalizeType(type) {
  const raw = text(type, '', 40).toLowerCase();

  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';
  if (raw === 'international' || raw === 'international_purchase') return 'expense';

  return raw;
}

function canonicalCategory(value) {
  const key = token(value);
  return CATEGORY_ALIASES[key] || text(value, '', 160);
}

function normalizeCurrency(value) {
  const raw = text(value, 'PKR', 10).toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : 'PKR';
}

function normalizeFxRate(value, currency) {
  if (currency === 'PKR') return 1;

  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : 0;
}

function normalizeDate(value) {
  const raw = text(value, '', 40);
  if (!raw) return todayISO();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return todayISO();
  return raw.slice(0, 10);
}

function cleanAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

function cleanNotes(value) {
  return String(value || '').trim().slice(0, 240);
}

async function tableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const set = new Set();

  for (const row of result.results || []) {
    if (row.name) set.add(row.name);
  }

  return set;
}

function activeAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR status = 'active')");

  return clauses.join(' AND ');
}

function buildOrderBy(cols) {
  const parts = [];

  if (cols.has('date')) parts.push('date DESC');
  if (cols.has('created_at')) parts.push('datetime(created_at) DESC');
  if (cols.has('id')) parts.push('id DESC');

  return parts.length ? parts.join(', ') : 'rowid DESC';
}

function filterToCols(cols, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function buildInsert(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('No insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

async function hashPayload(value) {
  const canonical = JSON.stringify(sortKeys(value));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
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

function isDryRun(url, body) {
  if (url.searchParams.get('dry_run') === '1') return true;
  if (url.searchParams.get('dry_run') === 'true') return true;
  if (body && body.dry_run === true) return true;
  if (body && body.dry_run === '1') return true;
  if (body && body.dry_run === 'true') return true;
  return false;
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function text(value, fallback = '', max = 500) {
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

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isForeignKeyError(err) {
  return String((err && err.message) || '').toLowerCase().includes('foreign key');
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