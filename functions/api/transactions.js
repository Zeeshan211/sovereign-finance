/* /api/transactions
 * Sovereign Finance · Transactions Engine
 * v0.6.0-transactions-add-contract
 *
 * Contract:
 * - Backend owns transaction truth.
 * - Accounts are ledger-derived.
 * - Frontend may submit income, expense, transfer, and catch-up entries.
 * - Direct edit/delete is not supported here.
 * - Reversal lives in /api/transactions/reverse.
 * - Dry-run + payload hash is supported.
 * - Direct commit is also supported for daily ledger recovery.
 */

const VERSION = 'v0.6.0-transactions-add-contract';
const CONTRACT_VERSION = 'transactions-add-v1';

const FRONTEND_ADD_TYPES = [
  'expense',
  'income',
  'transfer',
  'adjustment_positive',
  'adjustment_negative'
];

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

const IN_TYPES = new Set([
  'income',
  'salary',
  'opening',
  'borrow',
  'debt_in',
  'adjustment_positive'
]);

const OUT_TYPES = new Set([
  'expense',
  'transfer',
  'cc_payment',
  'cc_spend',
  'repay',
  'atm',
  'debt_out',
  'adjustment_negative'
]);

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
  adjustment: 'misc',
  adjustment_positive: 'misc',
  adjustment_negative: 'misc',
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
        contract_version: CONTRACT_VERSION,
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
      contract_version: CONTRACT_VERSION,
      include_reversed: includeReversed,
      count: visible.length,
      fetched_count: decorated.length,
      hidden_reversal_count: includeReversed ? 0 : decorated.filter(row => row.is_reversal).length,
      contract: {
        frontend_add_types: FRONTEND_ADD_TYPES,
        backend_system_types: SYSTEM_TYPES,
        dry_run_supported: true,
        direct_commit_supported: true,
        commit_hash_supported: true,
        account_balance_source: 'ledger',
        reversal_route: '/api/transactions/reverse'
      },
      transactions: visible
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
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
        contract_version: CONTRACT_VERSION,
        dry_run: dryRun,
        action: 'transaction_create',
        error: validation.error,
        code: validation.code || 'VALIDATION_FAILED',
        committed: false,
        details: validation.details || null,
        warnings: validation.warnings || []
      }, validation.status || 400);
    }

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'transaction_create',
        dry_run: true,
        writes_performed: false,
        committed: false,
        payload_hash: validation.payload_hash,
        override_token: validation.override_token,
        requires_override: validation.requires_override,
        override_reason: validation.override_reason,
        warnings: validation.warnings,
        proof: validation.proof,
        normalized_payload: validation.normalized_payload
      });
    }

    const hashCheck = checkCommitHashIfSupplied(body, validation);

    if (!hashCheck.ok) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'transaction_create',
        error: hashCheck.error,
        code: hashCheck.code,
        committed: false,
        supplied_hash: hashCheck.supplied_hash,
        expected_hash: validation.payload_hash,
        normalized_payload: validation.normalized_payload,
        next_step: 'Run dry-run again or submit without stale dry_run_payload_hash.'
      }, hashCheck.status);
    }

    const overrideCheck = checkOverrideToken(body, validation);

    if (!overrideCheck.ok) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'transaction_create',
        error: overrideCheck.error,
        code: overrideCheck.code,
        committed: false,
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
      contract_version: CONTRACT_VERSION,
      action: 'transaction_create',
      error: err.message,
      committed: false
    }, 500);
  }
}

async function validatePayload(context, body) {
  const db = context.env.DB;
  const warnings = [];

  const amount = roundMoney(Number(body.amount));
  const requestedType = text(body.type || body.transaction_type, '', 60).toLowerCase();
  const type = normalizeType(requestedType);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_AMOUNT',
      error: 'Amount must be greater than 0'
    };
  }

  if (!requestedType) {
    return {
      ok: false,
      status: 400,
      code: 'TYPE_REQUIRED',
      error: 'type required'
    };
  }

  if (!ALLOWED_TYPES.includes(type)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_TYPE',
      error: 'Invalid type',
      details: {
        rejected_type: requestedType,
        normalized_type: type,
        allowed_types: ALLOWED_TYPES
      }
    };
  }

  const sourceInput = body.account_id || body.from_account_id;

  if (!sourceInput) {
    return {
      ok: false,
      status: 400,
      code: 'ACCOUNT_REQUIRED',
      error: 'account_id required'
    };
  }

  const sourceResult = await resolveAccount(db, sourceInput);

  if (!sourceResult.ok) {
    return {
      ok: false,
      status: sourceResult.status || 409,
      code: 'ACCOUNT_NOT_FOUND',
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

  if (type === 'transfer' || transferTargetInput) {
    if (!transferTargetInput) {
      return {
        ok: false,
        status: 400,
        code: 'TRANSFER_TARGET_REQUIRED',
        error: 'transfer_to_account_id required for transfer'
      };
    }

    const targetResult = await resolveAccount(db, transferTargetInput);

    if (!targetResult.ok) {
      return {
        ok: false,
        status: targetResult.status || 409,
        code: 'TRANSFER_TARGET_NOT_FOUND',
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
        code: 'TRANSFER_SAME_ACCOUNT',
        error: 'source and destination accounts cannot match'
      };
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
        code: 'CATEGORY_NOT_FOUND',
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

  if (currency !== 'PKR' && fxRate <= 0) {
    return {
      ok: false,
      status: 400,
      code: 'FX_RATE_REQUIRED',
      error: 'fx_rate required for non-PKR transaction'
    };
  }

  const pkrAmount = roundMoney(currency === 'PKR' ? amount : amount * fxRate);
  const date = normalizeDate(body.date);

  const normalized = {
    date,
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
    merchant_id: text(body.merchant_id, '', 160) || null,
    merchant: text(body.merchant || body.payee, '', 160) || null,
    notes: cleanNotes(body.notes || body.description || body.memo),
    fee_amount: cleanAmount(body.fee_amount),
    pra_amount: cleanAmount(body.pra_amount),
    source_module: text(body.source_module, 'manual', 80) || 'manual',
    source_id: text(body.source_id, '', 160) || null,
    source_action: text(body.source_action, 'manual_create', 80) || 'manual_create',
    idempotency_key: text(body.idempotency_key || body.client_request_id, '', 200) || null,
    created_by: text(body.created_by, 'web-ledger', 80) || 'web-ledger'
  };

  if (normalized.notes.includes('[CATCHUP]')) {
    warnings.push({
      code: 'CATCHUP_ENTRY',
      severity: 'info',
      message: 'Catch-up transaction will be inserted using the supplied transaction date.'
    });
  }

  const balanceProof = await buildBalanceProof(db, normalized, sourceAccount, transferToAccount);
  const duplicateProof = await buildDuplicateProof(db, normalized);

  if (duplicateProof.status === 'warn') {
    warnings.push(duplicateProof);
  }

  const requiresOverride = balanceProof.requires_override === true;
  const overrideReason = requiresOverride ? balanceProof.override_reason : null;

  const payloadHash = await hashPayload({
    route: 'transactions',
    contract_version: CONTRACT_VERSION,
    normalized_payload: normalized
  });

  const overrideToken = requiresOverride
    ? await hashPayload({
      route: 'transactions',
      contract_version: CONTRACT_VERSION,
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
  const delta = accountDelta(payload.type, payload.pkr_amount, 'source');

  return {
    action: 'transaction_create',
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    writes_performed: false,
    validation_status: checks.balance.blocked ? 'blocked' : 'pass',
    write_model: isTransfer ? 'linked_transfer_pair' : 'single_transaction_row',
    expected_transaction_rows: isTransfer ? 2 : 1,
    expected_audit_rows: 0,
    transaction: {
      type: payload.type,
      amount: payload.amount,
      pkr_amount: payload.pkr_amount,
      account_id: payload.account_id,
      account_delta: delta,
      date: payload.date,
      source_module: payload.source_module,
      source_action: payload.source_action
    },
    contract: {
      frontend_add_types: FRONTEND_ADD_TYPES,
      requested_type: payload.requested_type,
      normalized_type: payload.type,
      canonical_category_id: payload.category_id,
      dry_run_supported: true,
      direct_commit_supported: true,
      commit_hash_supported: true
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
        status: payload.type === 'transfer' ? 'pass' : 'not_required',
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
  const delta = accountDelta(payload.type, payload.pkr_amount, 'source');

  const row = filterToCols(txCols, {
    id,
    date: payload.date,
    type: payload.type,
    amount: payload.amount,
    account_id: payload.account_id,
    transfer_to_account_id: payload.transfer_to_account_id,
    linked_txn_id: null,
    category_id: payload.category_id,
    merchant_id: payload.merchant_id,
    merchant: payload.merchant,
    notes: payload.notes,
    fee_amount: payload.fee_amount,
    pra_amount: payload.pra_amount,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    source_module: payload.source_module,
    source_id: payload.source_id,
    source_action: payload.source_action,
    idempotency_key: payload.idempotency_key,
    created_by: payload.created_by,
    created_at: nowISO(),
    updated_at: nowISO()
  });

  try {
    await buildInsert(db, 'transactions', row).run();
  } catch (err) {
    if (isForeignKeyError(err)) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'transaction_create',
        error: 'Transaction failed account/category foreign-key guard.',
        code: 'FOREIGN_KEY_GUARD',
        committed: false,
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'transaction_create',
    committed: true,
    writes_performed: true,
    id,
    transaction: {
      created: true,
      id,
      type: payload.type,
      amount: payload.amount,
      pkr_amount: payload.pkr_amount,
      account_id: payload.account_id,
      account_delta: delta,
      date: payload.date,
      source_module: payload.source_module,
      source_action: payload.source_action
    },
    ledger: {
      visible: true,
      reversed: false,
      reversal_route: '/api/transactions/reverse'
    },
    account: {
      balance_source: 'ledger',
      impacted: true,
      account_id: payload.account_id,
      account_delta: delta
    },
    forecast: {
      should_reflect: true,
      source: 'accounts-ledger-derived'
    },
    category_id: payload.category_id,
    audited: false,
    audit_error: null,
    payload_hash: validation.payload_hash,
    proof: validation.proof,
    warnings: validation.warnings
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

  const createdAt = nowISO();

  const outRow = filterToCols(txCols, {
    id: outId,
    date: payload.date,
    type: 'transfer',
    amount: payload.amount,
    account_id: payload.account_id,
    transfer_to_account_id: payload.transfer_to_account_id,
    linked_txn_id: inId,
    category_id: null,
    merchant_id: payload.merchant_id,
    merchant: payload.merchant,
    notes: outNotes,
    fee_amount: payload.fee_amount,
    pra_amount: payload.pra_amount,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    source_module: payload.source_module,
    source_id: payload.source_id,
    source_action: 'transfer_out',
    idempotency_key: payload.idempotency_key,
    created_by: payload.created_by,
    created_at: createdAt,
    updated_at: createdAt
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
    merchant_id: payload.merchant_id,
    merchant: payload.merchant,
    notes: inNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    source_module: payload.source_module,
    source_id: payload.source_id,
    source_action: 'transfer_in',
    idempotency_key: payload.idempotency_key ? payload.idempotency_key + ':in' : null,
    created_by: payload.created_by,
    created_at: createdAt,
    updated_at: createdAt
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
        contract_version: CONTRACT_VERSION,
        action: 'transaction_create',
        error: 'Transfer failed account foreign-key guard.',
        code: 'FOREIGN_KEY_GUARD',
        committed: false,
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'transaction_create',
    committed: true,
    writes_performed: true,
    id: outId,
    linked_id: inId,
    ids: [outId, inId],
    transaction: {
      created: true,
      id: outId,
      linked_id: inId,
      type: 'transfer',
      amount: payload.amount,
      pkr_amount: payload.pkr_amount,
      account_id: payload.account_id,
      account_delta: -Math.abs(payload.pkr_amount),
      date: payload.date,
      source_module: payload.source_module,
      source_action: 'transfer_pair'
    },
    ledger: {
      visible: true,
      reversed: false,
      transfer_model: 'linked_pair',
      row_count: 2
    },
    account: {
      balance_source: 'ledger',
      impacted: true,
      from_account_id: payload.account_id,
      from_account_delta: -Math.abs(payload.pkr_amount),
      to_account_id: payload.transfer_to_account_id,
      to_account_delta: Math.abs(payload.pkr_amount)
    },
    forecast: {
      should_reflect: true,
      source: 'accounts-ledger-derived'
    },
    audited: false,
    audit_error: null,
    payload_hash: validation.payload_hash,
    proof: validation.proof,
    warnings: validation.warnings
  });
}

async function buildBalanceProof(db, payload, sourceAccount, transferToAccount) {
  const sourceBalance = await computeAccountBalance(db, payload.account_id);
  const sourceProjection = sourceBalance.balance + accountDelta(payload.type, payload.pkr_amount, 'source');

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
    const targetProjection = targetBalance.balance + Math.abs(payload.pkr_amount);

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

    const amount = Math.abs(Number(row.pkr_amount || row.amount || 0));
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
    'reversed_at',
    'created_at'
  ].filter(col => txCols.has(col));

  const rows = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE date = ?
       AND type = ?
       AND account_id = ?
       AND ROUND(ABS(amount), 2) = ROUND(ABS(?), 2)
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
     WHERE TRIM(id) = TRIM(?)
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

    if (type === 'adjustment_positive' || type === 'adjustment_negative') {
      return resolveCategory(db, 'misc', type);
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
    'linked_txn_id',
    'source_module',
    'source_id',
    'source_action',
    'idempotency_key',
    'created_by',
    'created_at',
    'updated_at'
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

function accountDelta(type, amount, side) {
  if (side === 'target') return Math.abs(amount);

  const normalized = normalizeType(type);
  const n = Math.abs(Number(amount) || 0);

  if (IN_TYPES.has(normalized)) return n;
  if (OUT_TYPES.has(normalized)) return -n;

  return n;
}

function signedAmount(type, amount) {
  const normalized = normalizeType(type);
  const n = Math.abs(Number(amount) || 0);

  if (IN_TYPES.has(normalized)) return n;
  if (OUT_TYPES.has(normalized)) return -n;

  return n;
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

function checkCommitHashIfSupplied(body, validation) {
  const supplied = text(body.dry_run_payload_hash || body.payload_hash, '', 200);

  if (!supplied) {
    return {
      ok: true
    };
  }

  if (supplied !== validation.payload_hash) {
    return {
      ok: false,
      status: 409,
      code: 'PAYLOAD_HASH_MISMATCH',
      error: 'Payload changed after dry-run.',
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
      code: 'OVERRIDE_TOKEN_REQUIRED',
      error: 'override_token required for blocked balance projection'
    };
  }

  if (supplied !== validation.override_token) {
    return {
      ok: false,
      status: 409,
      code: 'INVALID_OVERRIDE_TOKEN',
      error: 'Invalid override_token.'
    };
  }

  return {
    ok: true
  };
}

function normalizeType(type) {
  const raw = text(type, '', 60).toLowerCase();

  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';
  if (raw === 'international' || raw === 'international_purchase') return 'expense';
  if (raw === 'adjustment') return 'adjustment_positive';

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
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");

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
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
