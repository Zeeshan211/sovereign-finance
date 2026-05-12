/* /api/transactions — banking-grade ledger engine
 * Sovereign Finance v0.5.0-ledger-engine-hardening
 *
 * Backend owns:
 * - dry-run proof + payload hash
 * - balance projection
 * - asset overdraft block
 * - CC over-limit block
 * - salary-pattern warning
 * - duplicate suspicion warning
 * - append-only writes
 * - transfer pair atomic write
 *
 * Companion files still required:
 * - functions/api/transactions/[id].js must block PUT/DELETE and host reverse/health
 * - functions/api/add/[[path]].js must forward dry_run_payload_hash into commit
 */

import { audit } from './_lib.js';

const VERSION = 'v0.5.0-ledger-engine-hardening';

const FRONTEND_ADD_TYPES = [
  'expense',
  'income',
  'transfer'
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

const ACTIVE_ACCOUNT_CONDITION =
  "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

const SALARY_RULES = {
  account_tokens: ['meezan'],
  types: ['income', 'salary'],
  currency: 'PKR',
  min_amount: 110000,
  max_amount: 200000,
  valid_days: [28, 29, 30, 31, 1, 2, 3, 4, 5],
  category_id: 'salary_income',
  default_employer: 'ABS-Labs (Private) Limited'
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
    const txColumns = await getTableColumns(db, 'transactions');

    const selectCols = selectTransactionColumns(txColumns);

    const result = await db.prepare(
      `SELECT ${selectCols.join(', ')}
       FROM transactions
       ORDER BY date DESC, datetime(created_at) DESC, id DESC
       LIMIT ?`
    ).bind(limit).all();

    const allRows = result.results || [];
    const decorated = allRows.map(row => decorateTransaction(row));
    const visibleRows = includeReversed
      ? decorated
      : decorated.filter(t => !t.is_reversal);

    return jsonResponse({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
      count: visibleRows.length,
      hidden_reversal_count: decorated.length - visibleRows.length,
      contract: {
        frontend_add_types: FRONTEND_ADD_TYPES,
        backend_system_types: SYSTEM_TYPES,
        unsupported_types: ['adjustment'],
        dry_run_required: true,
        commit_requires_payload_hash: true,
        destructive_update_delete: 'blocked in companion [id].js shipment',
        category_aliases: CATEGORY_ALIASES
      },
      transactions: visibleRows
    });
  } catch (err) {
    return jsonResponse({
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
    const dryRun = isDryRunRequest(url, body);

    const validation = await validateTransactionPayload(context, body);

    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    if (dryRun) {
      return jsonResponse({
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
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: hashCheck.error,
        supplied_hash: hashCheck.supplied_hash,
        expected_hash: validation.payload_hash,
        normalized_payload: validation.normalized_payload,
        next_step: 'Run POST /api/transactions?dry_run=1 first, then commit with dry_run_payload_hash.'
      }, hashCheck.status);
    }

    const overrideCheck = checkOverrideToken(body, validation);

    if (!overrideCheck.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: overrideCheck.error,
        requires_override: validation.requires_override,
        override_reason: validation.override_reason,
        override_token_required: true,
        next_step: 'If the override is intentional, commit again with the override_token returned by dry-run.'
      }, overrideCheck.status);
    }

    if (validation.normalized_payload.type === 'transfer') {
      return createTransferPair(context, validation);
    }

    return createSingleTransaction(context, validation);
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

async function validateTransactionPayload(context, body) {
  const db = context.env.DB;
  const warnings = [];

  const amount = roundMoney(Number(body.amount));
  const requestedType = cleanText(body.type || body.transaction_type, '', 40).toLowerCase();
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
        allowed_types: ALLOWED_TYPES,
        frontend_add_types: FRONTEND_ADD_TYPES
      }
    };
  }

  const sourceAccountInput = body.account_id || body.from_account_id;

  if (!sourceAccountInput) {
    return {
      ok: false,
      status: 400,
      error: 'account_id required'
    };
  }

  const sourceAccountResult = await resolveAccount(db, sourceAccountInput);

  if (!sourceAccountResult.ok) {
    return {
      ok: false,
      status: sourceAccountResult.status || 409,
      error: sourceAccountResult.error,
      details: {
        account_input: cleanText(sourceAccountInput, '', 160)
      }
    };
  }

  const sourceAccount = sourceAccountResult.account;

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
            transfer_to_account_input: cleanText(transferTargetInput, '', 160)
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
          category_input: cleanText(categoryInput, '', 160)
        }
      };
    }

    categoryId = categoryResult.category_id;
  }

  const currency = normalizeCurrency(body.currency || body.currency_code || 'PKR');
  const fxRate = normalizeFxRate(body.fx_rate_at_commit || body.fx_rate, currency);
  const pkrAmount = roundMoney(currency === 'PKR' ? amount : amount * fxRate);

  const normalized = {
    date: normalizeDate(body.date) || todayISO(),
    type,
    requested_type: requestedType,
    amount,
    pkr_amount: pkrAmount,
    currency,
    fx_rate_at_commit: fxRate,
    fx_source: cleanText(body.fx_source, currency === 'PKR' ? 'PKR-base' : 'client-supplied', 80),
    account_id: sourceAccount.id,
    account_name: sourceAccount.name || sourceAccount.id,
    transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
    transfer_to_account_name: transferToAccount ? (transferToAccount.name || transferToAccount.id) : null,
    category_id: categoryId,
    notes: cleanNotes(body.notes || body.description || body.memo),
    fee_amount: cleanAmount(body.fee_amount),
    pra_amount: cleanAmount(body.pra_amount),
    created_by: cleanText(body.created_by, 'web-ledger', 80) || 'web-ledger'
  };

  const balanceProof = await buildBalanceProof(db, normalized, sourceAccount, transferToAccount);
  const salaryProof = buildSalaryProof(normalized, sourceAccount);
  const duplicateProof = await buildDuplicateProof(db, normalized);

  if (salaryProof.status === 'warn') {
    warnings.push(salaryProof);
  }

  if (duplicateProof.status === 'warn') {
    warnings.push(duplicateProof);
  }

  if (currency !== 'PKR' && (!Number.isFinite(fxRate) || fxRate <= 0)) {
    warnings.push({
      check: 'fx_rate_snapshot',
      status: 'warn',
      detail: 'Foreign currency row has no positive FX snapshot.'
    });
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

  const proof = buildWriteProof(normalized, {
    balance: balanceProof,
    salary: salaryProof,
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

function buildWriteProof(payload, checks) {
  const isTransfer = payload.type === 'transfer';

  return {
    action: 'transaction.save',
    version: VERSION,
    writes_performed: false,
    validation_status: checks.balance.blocked ? 'blocked' : 'pass',
    write_model: isTransfer ? 'legacy_2_row_transfer_pair' : 'single_transaction_row',
    expected_transaction_rows: isTransfer ? 2 : 1,
    expected_audit_rows: 1,
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
          : 'Destination account not required for this transaction type.'
      },
      {
        check: 'category_valid',
        status: payload.category_id ? 'pass' : 'not_required',
        source: 'categories',
        detail: payload.category_id
          ? 'Category resolved to canonical category_id ' + payload.category_id + '.'
          : 'Category is empty or not required.'
      },
      {
        check: 'fx_rate_snapshot',
        status: payload.currency === 'PKR' || payload.fx_rate_at_commit > 0 ? 'pass' : 'warn',
        source: 'request.currency/request.fx_rate_at_commit',
        detail: payload.currency + ' @ ' + payload.fx_rate_at_commit + ' = ' + payload.pkr_amount + ' PKR.'
      },
      checks.balance,
      checks.salary,
      checks.duplicate
    ],
    warnings: checks.warnings
  };
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
    proof.detail = 'Asset account would go negative: current ' +
      roundMoney(sourceBalance.balance) + ', projected ' + roundMoney(sourceProjection) + '.';
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
      proof.detail = 'Liability account would exceed limit: projected outstanding ' +
        roundMoney(outstanding) + ', limit ' + sourceLimit + '.';
    }
  }

  if (payload.type === 'transfer' && transferToAccount) {
    const targetBalance = await computeAccountBalance(db, payload.transfer_to_account_id);
    const targetProjection = projectBalance(targetBalance.balance, 'income', payload.pkr_amount, 'target');

    proof.transfer_target = {
      account_id: payload.transfer_to_account_id,
      current_balance: roundMoney(targetBalance.balance),
      projected_balance: roundMoney(targetProjection)
    };
  }

  return proof;
}

async function buildDuplicateProof(db, payload) {
  const rows = await db.prepare(
    `SELECT id, date, type, amount, account_id, category_id, notes
     FROM transactions
     WHERE date = ?
       AND type = ?
       AND account_id = ?
       AND ROUND(amount, 2) = ROUND(?, 2)
     ORDER BY datetime(created_at) DESC
     LIMIT 5`
  ).bind(
    payload.date,
    payload.type,
    payload.account_id,
    payload.amount
  ).all();

  const matches = (rows.results || []).filter(row => {
    if (isReversalRow(row)) return false;
    if (payload.category_id && row.category_id && payload.category_id !== row.category_id) return false;
    return true;
  });

  if (matches.length === 0) {
    return {
      check: 'duplicate_suspicion',
      status: 'pass',
      source: 'transactions',
      detail: 'No same-day same-account same-type same-amount match found.'
    };
  }

  return {
    check: 'duplicate_suspicion',
    status: 'warn',
    source: 'transactions',
    duplicate_count: matches.length,
    possible_duplicate_ids: matches.map(row => row.id),
    detail: 'Possible duplicate transaction exists for same date/account/type/amount.'
  };
}

function buildSalaryProof(payload, sourceAccount) {
  const day = Number(String(payload.date || '').slice(8, 10));
  const accountToken = token((sourceAccount && (sourceAccount.name || sourceAccount.id)) || payload.account_id);
  const categoryToken = token(payload.category_id);

  const matches =
    SALARY_RULES.account_tokens.some(t => accountToken.includes(t)) &&
    SALARY_RULES.types.includes(payload.type) &&
    payload.currency === SALARY_RULES.currency &&
    payload.pkr_amount >= SALARY_RULES.min_amount &&
    payload.pkr_amount <= SALARY_RULES.max_amount &&
    SALARY_RULES.valid_days.includes(day);

  if (!matches) {
    return {
      check: 'salary_pattern',
      status: 'not_required',
      source: 'sheet-salary-rules',
      detail: 'Transaction does not match salary detector.'
    };
  }

  if (categoryToken === token(SALARY_RULES.category_id)) {
    return {
      check: 'salary_pattern',
      status: 'pass',
      source: 'sheet-salary-rules',
      detail: 'Salary-like income already uses salary category.'
    };
  }

  return {
    check: 'salary_pattern',
    status: 'warn',
    source: 'sheet-salary-rules',
    suggested_category_id: SALARY_RULES.category_id,
    suggested_counterparty: SALARY_RULES.default_employer,
    detail: 'Transaction matches salary pattern but category is not salary_income.'
  };
}

async function createSingleTransaction(context, validation) {
  const db = context.env.DB;
  const payload = validation.normalized_payload;
  const txColumns = await getTableColumns(db, 'transactions');
  const id = makeTxnId('tx');

  const row = {
    id,
    date: payload.date,
    type: payload.type,
    amount: payload.amount,
    account_id: payload.account_id,
    transfer_to_account_id: payload.transfer_to_account_id,
    category_id: payload.category_id,
    notes: payload.notes,
    fee_amount: payload.fee_amount,
    pra_amount: payload.pra_amount,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    created_by: payload.created_by
  };

  try {
    await insertDynamic(db, 'transactions', txColumns, row);
  } catch (err) {
    if (isForeignKeyError(err)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Transaction failed account/category foreign-key guard. Refresh accounts/categories and retry.',
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  const auditResult = await safeAudit(context, {
    action: payload.type === 'cc_payment' ? 'CC_PAYMENT' : 'TXN_ADD',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      type: payload.type,
      requested_type: payload.requested_type,
      amount: payload.amount,
      pkr_amount: payload.pkr_amount,
      currency: payload.currency,
      fx_rate_at_commit: payload.fx_rate_at_commit,
      account_id: payload.account_id,
      account_name: payload.account_name,
      transfer_to_account_id: payload.transfer_to_account_id,
      transfer_to_account_name: payload.transfer_to_account_name,
      category_id: payload.category_id,
      date: payload.date,
      payload_hash: validation.payload_hash,
      override_reason: validation.override_reason,
      notes: payload.notes.slice(0, 80)
    },
    created_by: payload.created_by
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id,
    account_id: payload.account_id,
    account_name: payload.account_name,
    transfer_to_account_id: payload.transfer_to_account_id,
    transfer_to_account_name: payload.transfer_to_account_name,
    category_id: payload.category_id,
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    payload_hash: validation.payload_hash,
    proof: validation.proof
  });
}

async function createTransferPair(context, validation) {
  const db = context.env.DB;
  const payload = validation.normalized_payload;
  const txColumns = await getTableColumns(db, 'transactions');

  const outId = makeTxnId('txout');
  const inId = makeTxnId('txin');
  const baseNotes = cleanNotes(payload.notes || 'Transfer');

  const outNotes = `To: ${payload.transfer_to_account_name || payload.transfer_to_account_id} ${baseNotes} (OUT) [linked: ${inId}]`.slice(0, 200);
  const inNotes = `From: ${payload.account_name || payload.account_id} ${baseNotes} (IN) [linked: ${outId}]`.slice(0, 200);

  const outRow = filterInsertable(txColumns, {
    id: outId,
    date: payload.date,
    type: 'transfer',
    amount: payload.amount,
    account_id: payload.account_id,
    transfer_to_account_id: null,
    linked_txn_id: inId,
    category_id: null,
    notes: outNotes,
    fee_amount: payload.fee_amount,
    pra_amount: payload.pra_amount,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    created_by: payload.created_by
  });

  const inRow = filterInsertable(txColumns, {
    id: inId,
    date: payload.date,
    type: 'income',
    amount: payload.amount,
    account_id: payload.transfer_to_account_id,
    transfer_to_account_id: null,
    linked_txn_id: outId,
    category_id: null,
    notes: inNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: payload.currency,
    pkr_amount: payload.pkr_amount,
    fx_rate_at_commit: payload.fx_rate_at_commit,
    fx_source: payload.fx_source,
    created_by: payload.created_by
  });

  try {
    await db.batch([
      buildInsertStatement(db, 'transactions', outRow),
      buildInsertStatement(db, 'transactions', inRow)
    ]);
  } catch (err) {
    if (isForeignKeyError(err)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Transfer failed account foreign-key guard. Refresh accounts and retry.',
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  const auditResult = await safeAudit(context, {
    action: 'TRANSFER',
    entity: 'transaction',
    entity_id: outId,
    kind: 'mutation',
    detail: {
      type: 'transfer',
      amount: payload.amount,
      pkr_amount: payload.pkr_amount,
      currency: payload.currency,
      from_account_id: payload.account_id,
      from_account_name: payload.account_name,
      to_account_id: payload.transfer_to_account_id,
      to_account_name: payload.transfer_to_account_name,
      out_id: outId,
      in_id: inId,
      category_id: null,
      date: payload.date,
      payload_hash: validation.payload_hash,
      override_reason: validation.override_reason,
      notes: baseNotes.slice(0, 80)
    },
    created_by: payload.created_by
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id: outId,
    linked_id: inId,
    ids: [outId, inId],
    from_account_id: payload.account_id,
    from_account_name: payload.account_name,
    to_account_id: payload.transfer_to_account_id,
    to_account_name: payload.transfer_to_account_name,
    transfer_model: 'legacy_2_row',
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    payload_hash: validation.payload_hash,
    proof: validation.proof
  });
}

async function computeAccountBalance(db, accountId) {
  const rows = await db.prepare(
    `SELECT id, type, amount, account_id, notes, reversed_by, reversed_at
     FROM transactions
     WHERE account_id = ?`
  ).bind(accountId).all();

  let balance = 0;
  let txnCount = 0;

  for (const row of rows.results || []) {
    if (isReversalRow(row)) continue;

    const amount = Number(row.amount) || 0;

    balance += signedAmount(row.type, amount);
    txnCount++;
  }

  return {
    balance,
    txn_count: txnCount
  };
}

function projectBalance(current, type, amount, side) {
  if (side === 'target') {
    return current + amount;
  }

  return current + signedAmount(type, amount);
}

function signedAmount(type, amount) {
  const t = normalizeType(type);

  if (['income', 'salary', 'opening', 'borrow', 'debt_in'].includes(t)) {
    return amount;
  }

  if (['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out'].includes(t)) {
    return -amount;
  }

  if (t === 'cc_payment') {
    return -amount;
  }

  return -amount;
}

async function resolveAccount(db, input) {
  const raw = cleanText(input, '', 160);

  if (!raw) {
    return {
      ok: false,
      status: 400,
      error: 'account_id required'
    };
  }

  const exact = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?
       AND ${ACTIVE_ACCOUNT_CONDITION}`
  ).bind(raw).first();

  if (exact && exact.id) {
    return {
      ok: true,
      account: exact
    };
  }

  const accountsResult = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE ${ACTIVE_ACCOUNT_CONDITION}
     ORDER BY display_order, name`
  ).all();

  const accounts = accountsResult.results || [];
  const wanted = token(raw);

  const matched = accounts.find(account => {
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
    error: 'Account not found or inactive. Refresh accounts and retry.'
  };
}

async function resolveCategory(db, input, type) {
  const raw = cleanText(input, '', 160);

  if (!raw) {
    if (type === 'income' || type === 'salary') {
      return resolveCategory(db, type === 'salary' ? 'salary_income' : 'manual_income', type);
    }

    return resolveCategory(db, 'misc', type);
  }

  const canonicalInput = canonicalCategory(raw);

  try {
    const exact = await db.prepare(
      `SELECT id
       FROM categories
       WHERE id = ?`
    ).bind(canonicalInput).first();

    if (exact && exact.id) {
      return {
        ok: true,
        category_id: exact.id
      };
    }

    const categoriesResult = await db.prepare(
      `SELECT id, name
       FROM categories
       ORDER BY name, id`
    ).all();

    const categories = categoriesResult.results || [];
    const wanted = token(canonicalInput);

    const matched = categories.find(category => {
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
      error: 'Category not found. Use a category from /api/categories.'
    };
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: 'Category validation failed. Use a category from /api/categories.'
    };
  }
}

function checkCommitHash(body, validation) {
  const suppliedHash = cleanText(
    body.dry_run_payload_hash || body.payload_hash,
    '',
    200
  );

  if (!suppliedHash) {
    return {
      ok: false,
      status: 428,
      error: 'dry_run_payload_hash required before commit',
      supplied_hash: ''
    };
  }

  if (suppliedHash !== validation.payload_hash) {
    return {
      ok: false,
      status: 409,
      error: 'Payload changed after dry-run. Run dry-run again.',
      supplied_hash: suppliedHash
    };
  }

  return {
    ok: true
  };
}

function checkOverrideToken(body, validation) {
  if (!validation.requires_override) {
    return {
      ok: true
    };
  }

  const suppliedToken = cleanText(body.override_token, '', 200);

  if (!suppliedToken) {
    return {
      ok: false,
      status: 428,
      error: 'override_token required for blocked balance projection'
    };
  }

  if (suppliedToken !== validation.override_token) {
    return {
      ok: false,
      status: 409,
      error: 'Invalid override_token. Re-run dry-run and confirm override again.'
    };
  }

  return {
    ok: true
  };
}

function normalizeType(type) {
  const raw = cleanText(type, '', 40).toLowerCase();

  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';
  if (raw === 'international' || raw === 'international_purchase') return 'expense';

  return raw;
}

function canonicalCategory(value) {
  const key = token(value);

  return CATEGORY_ALIASES[key] || cleanText(value, '', 160);
}

function decorateTransaction(row) {
  const notes = String(row.notes || '');
  const isReversal = isReversalRow(row);
  const isReversed = !!(row.reversed_by || row.reversed_at || notes.includes('[REVERSED BY '));
  const linkedFromNote = extractLinkedId(notes);
  const groupId = row.intl_package_id ||
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

function isReversalRow(t) {
  if (!t) return false;
  if (t.reversed_by || t.reversed_at) return true;

  const notes = String(t.notes || '').toUpperCase();

  return notes.includes('[REVERSAL OF ');
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);

  return match ? match[1].trim() : null;
}

function classifyAccount(account) {
  const joined = [
    account.kind,
    account.type,
    account.account_type,
    account.name,
    account.id
  ].map(v => String(v || '').toLowerCase()).join(' ');

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

    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }

  return DEFAULT_CC_LIMIT;
}

async function getTableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const columns = new Set();

  for (const row of result.results || []) {
    if (row.name) {
      columns.add(row.name);
    }
  }

  return columns;
}

function selectTransactionColumns(columns) {
  const wanted = [
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
  ];

  return wanted
    .filter(col => columns.has(col))
    .map(col => col);
}

function filterInsertable(columns, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (columns.has(key)) {
      out[key] = value;
    }
  }

  return out;
}

async function insertDynamic(db, table, columns, row) {
  const filtered = filterInsertable(columns, row);
  const stmt = buildInsertStatement(db, table, filtered);

  return stmt.run();
}

function buildInsertStatement(db, table, row) {
  const keys = Object.keys(row);
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map(key => row[key]);

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
  ).bind(...values);
}

function normalizeCurrency(value) {
  const raw = cleanText(value, 'PKR', 10).toUpperCase();

  if (/^[A-Z]{3}$/.test(raw)) {
    return raw;
  }

  return 'PKR';
}

function normalizeFxRate(value, currency) {
  if (currency === 'PKR') {
    return 1;
  }

  const n = Number(value);

  if (Number.isFinite(n) && n > 0) {
    return roundMoney(n);
  }

  return 0;
}

function isDryRunRequest(url, body) {
  if (url.searchParams.get('dry_run') === '1') return true;
  if (url.searchParams.get('dry_run') === 'true') return true;
  if (body && body.dry_run === true) return true;
  if (body && body.dry_run === '1') return true;
  if (body && body.dry_run === 'true') return true;

  return false;
}

async function safeAudit(context, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail || {})
    };

    const result = await audit(context.env, payload);

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

async function hashPayload(value) {
  const canonical = canonicalJSONString(value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJSONString(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeys(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);

  if (!raw) return todayISO();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return todayISO();

  return raw.slice(0, 10);
}

function cleanAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) return 0;

  return roundMoney(amount);
}

function roundMoney(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function cleanNotes(notes) {
  return String(notes || '').trim().slice(0, 200);
}

function cleanText(value, fallback, maxLen) {
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
  } catch (err) {
    return {};
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}