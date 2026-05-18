/* ─── /api/nano-loans/[[path]] · Sovereign Finance Nano Loans ───
 * v0.2.0-nano-loans-liability-contract
 *
 * Source reference:
 * - Finance_NanoLoan.gs sheet-side logic
 * - Previous web port v0.1.0
 *
 * Contract:
 * - Nano loan principal received is NOT income.
 * - Principal received creates:
 *     1. nano_loans liability record
 *     2. transactions row with type='borrow' on receiving asset account
 * - Repayment creates:
 *     1. transactions row with type='repay' on paying asset account
 *     2. nano_loans.repaid_amount update
 * - Loan outstanding lives in nano_loans, not account balances.
 * - Account balances remain transactions_canonical.
 * - Reversed rows and reversed originals are excluded from health repayment sums.
 * - Push-to-CC is guarded until Credit Card module contract is hardened.
 *
 * Supported:
 * - GET  /api/nano-loans
 * - GET  /api/nano-loans?action=health
 * - GET  /api/nano-loans/health
 * - POST /api/nano-loans
 * - POST /api/nano-loans/{id}/repay
 * - POST /api/nano-loans/{id}/push-to-cc
 */

import { audit } from '../_lib.js';

const VERSION = 'v0.2.0-nano-loans-liability-contract';
const CONTRACT_VERSION = 'nano-loans-v1';

const DEFAULT_CC_ACCOUNT_ID = 'cc';
const DEFAULT_SOURCE_ACCOUNT_ID = 'easypaisa';

const POSITIVE_LEDGER_TYPE = 'borrow';
const NEGATIVE_LEDGER_TYPE = 'repay';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = cleanText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (action === 'health' || path[0] === 'health') {
      return nanoLoansHealth(db);
    }

    const [accountCols, txCols, loanCols] = await Promise.all([
      tableColumns(db, 'accounts'),
      tableColumns(db, 'transactions'),
      tableColumns(db, 'nano_loans')
    ]);

    const [loans, accounts, ccAccounts] = await Promise.all([
      loadLoans(db, loanCols),
      loadAccounts(db, accountCols, false),
      loadAccounts(db, accountCols, true)
    ]);

    const sourceAccounts = accounts.filter(account => {
      return String(account.type || '').toLowerCase() === 'asset' &&
        String(account.kind || '').toLowerCase() !== 'cc';
    });

    const activeLoans = loans.filter(loan => String(loan.status || '').toLowerCase() === 'active');
    const closedLoans = loans.filter(loan => String(loan.status || '').toLowerCase() === 'closed');

    const summary = summarizeLoans(activeLoans, closedLoans);

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      route: '/api/nano-loans',
      supported_routes: [
        'GET /api/nano-loans',
        'GET /api/nano-loans?action=health',
        'POST /api/nano-loans',
        'POST /api/nano-loans/{id}/repay',
        'POST /api/nano-loans/{id}/push-to-cc'
      ],
      defaults: {
        source_account_id: DEFAULT_SOURCE_ACCOUNT_ID,
        cc_account_id: DEFAULT_CC_ACCOUNT_ID
      },
      accounts,
      source_accounts: sourceAccounts,
      cc_accounts: ccAccounts,
      loans,
      active_loans: activeLoans,
      closed_loans: closedLoans,
      summary,
      liability: {
        source: 'nano_loans',
        outstanding: summary.remaining,
        account_balance_source: 'transactions_canonical',
        principal_received_is_income: false
      },
      rules: {
        loan_origin_ledger_type: POSITIVE_LEDGER_TYPE,
        loan_repayment_ledger_type: NEGATIVE_LEDGER_TYPE,
        principal_received_is_income: false,
        account_balance_source: 'transactions_canonical',
        liability_source: 'nano_loans.remaining_amount',
        reversed_rows_excluded_from_health: true,
        push_to_cc_guarded_until_credit_card_contract: true
      },
      schema: {
        nano_loans_columns: Array.from(loanCols),
        transactions_has_pkr_amount: txCols.has('pkr_amount'),
        transactions_has_source_module: txCols.has('source_module')
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err),
      stage: 'onRequestGet'
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = getPath(context);
    const body = await readJSON(context.request);

    const loanId = cleanText(path[0] || body.loan_id || '', '', 160);
    const action = cleanText(path[1] || body.action || '', '', 80).toLowerCase();

    if (!loanId && !action) {
      return createNanoLoan(context, body);
    }

    if (!loanId && ['create', 'origin', 'loan_create'].includes(action)) {
      return createNanoLoan(context, body);
    }

    if (loanId && ['repay', 'payment', 'loan_repay'].includes(action)) {
      return repayNanoLoan(context, loanId, body);
    }

    if (loanId && ['push-to-cc', 'push_to_cc', 'cc'].includes(action)) {
      return pushNanoLoanToCC(context, loanId, body);
    }

    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'Unsupported nano loan route',
      code: 'UNSUPPORTED_NANO_LOAN_ROUTE',
      supported: [
        'GET /api/nano-loans',
        'GET /api/nano-loans?action=health',
        'POST /api/nano-loans',
        'POST /api/nano-loans/{id}/repay',
        'POST /api/nano-loans/{id}/push-to-cc'
      ]
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err),
      stage: 'onRequestPost'
    }, 500);
  }
}

async function createNanoLoan(context, body) {
  const db = context.env.DB;

  const [accountCols, txCols, loanCols] = await Promise.all([
    tableColumns(db, 'accounts'),
    tableColumns(db, 'transactions'),
    tableColumns(db, 'nano_loans')
  ]);

  const schemaError = validateCreateSchema(txCols, loanCols);
  if (schemaError) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: schemaError,
      code: 'SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  const date = cleanDate(body.date);
  const appName = cleanText(body.app_name || body.name || body.lender || '', '', 100);
  const appCode = cleanId(body.app_code || appName || 'nano');
  const shape = normalizeShape(body.shape);
  const principalAmount = moneyNumber(body.principal_amount ?? body.amount, 0);
  const coolOffFee = moneyNumber(body.cool_off_fee ?? body.fee ?? 0, 0);
  const totalOwed = moneyNumber(body.total_owed ?? (principalAmount + coolOffFee), 0);
  const sourceAccountId = cleanId(body.source_account_id || body.account_id || DEFAULT_SOURCE_ACCOUNT_ID);
  const coolOffDue = cleanDateOrNull(body.cool_off_due || body.due_date);
  const notes = cleanText(body.notes || '', '', 500);
  const createdBy = cleanText(body.created_by || 'web-nano-loans', '', 100);
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id || '', '', 180);

  if (!appName) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: 'app_name is required',
      code: 'APP_NAME_REQUIRED',
      committed: false
    }, 400);
  }

  if (!(principalAmount > 0)) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: 'principal_amount must be greater than 0',
      code: 'INVALID_PRINCIPAL_AMOUNT',
      committed: false
    }, 400);
  }

  if (coolOffFee < 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: 'cool_off_fee cannot be negative',
      code: 'INVALID_COOL_OFF_FEE',
      committed: false
    }, 400);
  }

  if (totalOwed < principalAmount) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: 'total_owed cannot be less than principal_amount',
      code: 'TOTAL_OWED_BELOW_PRINCIPAL',
      committed: false
    }, 400);
  }

  const source = await loadAccount(db, accountCols, sourceAccountId, false);
  if (!source) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: 'source account not found or inactive',
      code: 'SOURCE_ACCOUNT_NOT_FOUND',
      account_id: sourceAccountId,
      committed: false
    }, 404);
  }

  if (String(source.type || '').toLowerCase() !== 'asset') {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_create',
      error: 'source account must be an asset account',
      code: 'SOURCE_ACCOUNT_MUST_BE_ASSET',
      committed: false
    }, 400);
  }

  if (idempotencyKey && txCols.has('idempotency_key')) {
    const existing = await db.prepare(
      `SELECT id FROM transactions WHERE idempotency_key = ? LIMIT 1`
    ).bind(`${idempotencyKey}:origin`).first();

    if (existing && existing.id) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'nano_loan_create',
        error: 'Duplicate idempotency key',
        code: 'DUPLICATE_IDEMPOTENCY_KEY',
        existing_transaction_id: existing.id,
        committed: false
      }, 409);
    }
  }

  const loanId = makeId('nano');
  const txnInId = makeId('nanoin');
  const createdAt = nowISO();
  const loanNotes = notes || `${appName} nano loan`;
  const txnNotes = `[NANO_LOAN_ORIGIN] loan_id=${loanId} app=${appName} principal=${formatAmount(principalAmount)} liability_created=true ${notes}`.slice(0, 240);

  const txnRow = filterToCols(txCols, {
    id: txnInId,
    date,
    type: POSITIVE_LEDGER_TYPE,
    amount: principalAmount,
    pkr_amount: principalAmount,
    account_id: sourceAccountId,
    transfer_to_account_id: null,
    category_id: null,
    merchant_id: null,
    merchant: appName,
    notes: txnNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    linked_txn_id: loanId,
    source_module: 'nano_loans',
    source_id: loanId,
    source_action: 'loan_origin',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:origin` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const loanRow = filterToCols(loanCols, {
    id: loanId,
    date,
    app_code: appCode,
    app_name: appName,
    status: 'active',
    shape,
    principal_amount: principalAmount,
    cool_off_fee: coolOffFee,
    total_owed: totalOwed,
    repaid_amount: 0,
    source_account_id: sourceAccountId,
    txn_in_id: txnInId,
    repay_txn_id: null,
    pushed_at: null,
    pushed_txn_id: null,
    push_fee_txn_id: null,
    cool_off_due: coolOffDue,
    closed_at: null,
    notes: loanNotes,
    created_at: createdAt,
    updated_at: createdAt
  });

  await db.batch([
    buildInsert(db, 'transactions', txnRow),
    buildInsert(db, 'nano_loans', loanRow)
  ]);

  const auditResult = await safeAudit(context.env, {
    action: 'NANO_LOAN_CREATE',
    entity: 'nano_loan',
    entity_id: loanId,
    kind: 'mutation',
    detail: {
      contract_version: CONTRACT_VERSION,
      loan_id: loanId,
      txn_in_id: txnInId,
      app_code: appCode,
      app_name: appName,
      shape,
      principal_amount: principalAmount,
      cool_off_fee: coolOffFee,
      total_owed: totalOwed,
      source_account_id: sourceAccountId,
      date,
      principal_received_is_income: false
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'nano_loan_create',
    committed: true,
    loan_id: loanId,
    txn_in_id: txnInId,
    status: 'active',
    ledger: {
      row_created: true,
      transaction_id: txnInId,
      type: POSITIVE_LEDGER_TYPE,
      account_id: sourceAccountId,
      amount: round2(principalAmount),
      principal_received_is_income: false
    },
    liability: {
      created: true,
      source: 'nano_loans',
      principal_amount: round2(principalAmount),
      cool_off_fee: round2(coolOffFee),
      total_owed: round2(totalOwed),
      repaid_amount: 0,
      remaining_amount: round2(totalOwed)
    },
    balance_impact: {
      account_id: sourceAccountId,
      delta: round2(principalAmount),
      source: 'transactions_canonical'
    },
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    warnings: []
  });
}

async function repayNanoLoan(context, loanId, body) {
  const db = context.env.DB;

  const [accountCols, txCols, loanCols] = await Promise.all([
    tableColumns(db, 'accounts'),
    tableColumns(db, 'transactions'),
    tableColumns(db, 'nano_loans')
  ]);

  const schemaError = validateRepaySchema(txCols, loanCols);
  if (schemaError) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: schemaError,
      code: 'SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  const loan = await loadLoan(db, loanCols, loanId);

  if (!loan) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: 'nano loan not found',
      code: 'NANO_LOAN_NOT_FOUND',
      loan_id: loanId,
      committed: false
    }, 404);
  }

  if (String(loan.status || '').toLowerCase() !== 'active') {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: 'nano loan is not active',
      code: 'NANO_LOAN_NOT_ACTIVE',
      loan_id: loanId,
      status: loan.status,
      committed: false
    }, 400);
  }

  const remaining = remainingForLoan(loan);
  const amount = body.amount == null || body.amount === ''
    ? remaining
    : moneyNumber(body.amount, 0);

  const accountId = cleanId(body.account_id || body.source_account_id || loan.source_account_id);
  const date = cleanDate(body.date);
  const notes = cleanText(body.notes || '', '', 500);
  const createdBy = cleanText(body.created_by || 'web-nano-repay', '', 100);
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id || '', '', 180);

  if (!(amount > 0)) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: 'repay amount must be greater than 0',
      code: 'INVALID_REPAY_AMOUNT',
      committed: false
    }, 400);
  }

  if (amount > remaining + 0.01) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: 'repay amount cannot exceed remaining balance',
      code: 'REPAY_EXCEEDS_REMAINING',
      remaining: round2(remaining),
      committed: false
    }, 400);
  }

  const account = await loadAccount(db, accountCols, accountId, false);
  if (!account) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: 'repayment account not found or inactive',
      code: 'REPAYMENT_ACCOUNT_NOT_FOUND',
      account_id: accountId,
      committed: false
    }, 404);
  }

  if (String(account.type || '').toLowerCase() !== 'asset') {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loan_repay',
      error: 'repayment account must be an asset account',
      code: 'REPAYMENT_ACCOUNT_MUST_BE_ASSET',
      committed: false
    }, 400);
  }

  if (idempotencyKey && txCols.has('idempotency_key')) {
    const existing = await db.prepare(
      `SELECT id FROM transactions WHERE idempotency_key = ? LIMIT 1`
    ).bind(`${idempotencyKey}:repay`).first();

    if (existing && existing.id) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'nano_loan_repay',
        error: 'Duplicate idempotency key',
        code: 'DUPLICATE_IDEMPOTENCY_KEY',
        existing_transaction_id: existing.id,
        committed: false
      }, 409);
    }
  }

  const repayTxnId = makeId('nanorepay');
  const createdAt = nowISO();
  const previousRepaid = moneyNumber(loan.repaid_amount, 0);
  const totalOwed = moneyNumber(loan.total_owed, 0);
  const newRepaid = round2(previousRepaid + amount);
  const newRemaining = round2(Math.max(0, totalOwed - newRepaid));
  const nextStatus = newRemaining <= 0.01 ? 'closed' : 'active';

  const repayNotes = `[NANO_LOAN_REPAY] loan_id=${loan.id} app=${loan.app_name || loan.app_code || 'nano'} ${nextStatus === 'closed' ? 'closed' : 'partial'} ${notes}`.slice(0, 240);

  const txnRow = filterToCols(txCols, {
    id: repayTxnId,
    date,
    type: NEGATIVE_LEDGER_TYPE,
    amount,
    pkr_amount: amount,
    account_id: accountId,
    transfer_to_account_id: null,
    category_id: null,
    merchant_id: null,
    merchant: loan.app_name || loan.app_code || 'Nano Loan',
    notes: repayNotes,
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    linked_txn_id: loan.id,
    source_module: 'nano_loans',
    source_id: loan.id,
    source_action: 'loan_repay',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:repay` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const update = buildNanoLoanUpdate(db, loanCols, loan.id, {
    repaid_amount: newRepaid,
    repay_txn_id: repayTxnId,
    status: nextStatus,
    closed_at: nextStatus === 'closed' ? createdAt : loan.closed_at,
    updated_at: createdAt
  });

  await db.batch([
    buildInsert(db, 'transactions', txnRow),
    update
  ]);

  const auditResult = await safeAudit(context.env, {
    action: 'NANO_LOAN_REPAY',
    entity: 'nano_loan',
    entity_id: loan.id,
    kind: 'mutation',
    detail: {
      contract_version: CONTRACT_VERSION,
      loan_id: loan.id,
      repay_txn_id: repayTxnId,
      amount,
      account_id: accountId,
      previous_repaid: previousRepaid,
      new_repaid: newRepaid,
      total_owed: totalOwed,
      remaining: newRemaining,
      status: nextStatus,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'nano_loan_repay',
    committed: true,
    loan_id: loan.id,
    repay_txn_id: repayTxnId,
    amount: round2(amount),
    previous_repaid: round2(previousRepaid),
    repaid_amount: round2(newRepaid),
    remaining: round2(newRemaining),
    status: nextStatus,
    ledger: {
      row_created: true,
      transaction_id: repayTxnId,
      type: NEGATIVE_LEDGER_TYPE,
      account_id: accountId,
      amount: round2(amount)
    },
    liability: {
      source: 'nano_loans',
      previous_remaining: round2(remaining),
      remaining_amount: round2(newRemaining),
      reduced_by: round2(amount)
    },
    balance_impact: {
      account_id: accountId,
      delta: round2(-amount),
      source: 'transactions_canonical'
    },
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    warnings: []
  });
}

async function pushNanoLoanToCC(context, loanId, body) {
  const db = context.env.DB;
  const loanCols = await tableColumns(db, 'nano_loans');
  const loan = await loadLoan(db, loanCols, loanId);

  return json({
    ok: false,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'nano_loan_push_to_cc',
    error: 'push-to-cc is guarded until Credit Card module contract is hardened',
    code: 'PUSH_TO_CC_REQUIRES_CC_CONTRACT',
    committed: false,
    loan_id: loanId,
    loan_status: loan ? loan.status : null,
    recommendation: 'Use Nano Loan repayment only until cc module defines liability-increase semantics.'
  }, 409);
}

async function nanoLoansHealth(db) {
  const [loanCols, txCols, accountCols] = await Promise.all([
    tableColumns(db, 'nano_loans'),
    tableColumns(db, 'transactions'),
    tableColumns(db, 'accounts')
  ]);

  if (!loanCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loans.health',
      status: 'fail',
      error: 'nano_loans table missing id column'
    }, 500);
  }

  if (!txCols.has('id') || !txCols.has('account_id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'nano_loans.health',
      status: 'fail',
      error: 'transactions table missing required columns'
    }, 500);
  }

  const [loans, txRows, accounts] = await Promise.all([
    loadLoans(db, loanCols),
    loadNanoTransactions(db, txCols),
    loadAccounts(db, accountCols, true)
  ]);

  const txById = new Map(txRows.map(row => [String(row.id), row]));
  const accountsById = new Map(accounts.map(row => [String(row.id), row]));

  const originMissing = [];
  const originTypeMismatch = [];
  const originAmountMismatch = [];
  const originAccountMismatch = [];
  const repaymentSumMismatch = [];
  const statusMismatch = [];
  const activeMissingRemaining = [];
  const pushedNeedsReview = [];

  for (const loan of loans) {
    const loanId = String(loan.id || '');
    const txnInId = loan.txn_in_id;

    if (!txnInId || !txById.has(String(txnInId))) {
      originMissing.push({
        loan_id: loanId,
        txn_in_id: txnInId || null,
        error: 'origin transaction missing'
      });
    } else {
      const origin = txById.get(String(txnInId));

      if (normalizeType(origin.type) !== POSITIVE_LEDGER_TYPE || isInactiveForBalance(origin)) {
        originTypeMismatch.push({
          loan_id: loanId,
          txn_in_id: txnInId,
          type: origin.type,
          inactive: isInactiveForBalance(origin),
          error: 'origin transaction must be active borrow row'
        });
      }

      if (Math.abs(rowAmount(origin) - moneyNumber(loan.principal_amount, 0)) > 0.01) {
        originAmountMismatch.push({
          loan_id: loanId,
          txn_in_id: txnInId,
          principal_amount: round2(loan.principal_amount),
          txn_amount: rowAmount(origin),
          error: 'origin amount does not match principal'
        });
      }

      if (loan.source_account_id && origin.account_id && String(origin.account_id) !== String(loan.source_account_id)) {
        originAccountMismatch.push({
          loan_id: loanId,
          txn_in_id: txnInId,
          source_account_id: loan.source_account_id,
          txn_account_id: origin.account_id,
          error: 'origin account does not match loan source account'
        });
      }
    }

    if (loan.source_account_id && !accountsById.has(String(loan.source_account_id))) {
      originAccountMismatch.push({
        loan_id: loanId,
        source_account_id: loan.source_account_id,
        error: 'source account missing or inactive'
      });
    }

    const activeRepays = txRows.filter(row => {
      const notes = String(row.notes || '');
      const linked = String(row.linked_txn_id || '');
      return !isInactiveForBalance(row) &&
        normalizeType(row.type) === NEGATIVE_LEDGER_TYPE &&
        (
          linked === loanId ||
          notes.includes(`loan_id=${loanId}`) ||
          notes.includes(`loan ${loanId}`) ||
          notes.includes(loanId)
        );
    });

    const repaySum = round2(activeRepays.reduce((sum, row) => sum + rowAmount(row), 0));
    const loanRepaid = round2(loan.repaid_amount);

    if (Math.abs(repaySum - loanRepaid) > 0.01) {
      repaymentSumMismatch.push({
        loan_id: loanId,
        loan_repaid_amount: loanRepaid,
        active_repay_sum: repaySum,
        difference: round2(loanRepaid - repaySum),
        error: 'loan repaid_amount does not match active repay ledger rows'
      });
    }

    const remaining = remainingForLoan(loan);
    const status = String(loan.status || '').toLowerCase();

    if (status === 'closed' && remaining > 0.01) {
      statusMismatch.push({
        loan_id: loanId,
        status,
        remaining,
        error: 'closed loan still has remaining amount'
      });
    }

    if (status === 'active' && remaining <= 0.01) {
      statusMismatch.push({
        loan_id: loanId,
        status,
        remaining,
        error: 'active loan has no remaining amount'
      });
    }

    if (status === 'active' && remaining > 0.01) {
      activeMissingRemaining.push({
        loan_id: loanId,
        remaining
      });
    }

    if (loan.pushed_at || loan.pushed_txn_id || loan.push_fee_txn_id) {
      pushedNeedsReview.push({
        loan_id: loanId,
        pushed_at: loan.pushed_at || null,
        pushed_txn_id: loan.pushed_txn_id || null,
        push_fee_txn_id: loan.push_fee_txn_id || null,
        warning: 'push-to-cc exists and must be reviewed after Credit Card contract hardening'
      });
    }
  }

  const failures = [
    originMissing.length,
    originTypeMismatch.length,
    originAmountMismatch.length,
    originAccountMismatch.length,
    repaymentSumMismatch.length,
    statusMismatch.length
  ].reduce((sum, value) => sum + value, 0);

  const status = failures ? 'fail' : 'pass';

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'nano_loans.health',
    status,
    counts: {
      loans: loans.length,
      active_loans: loans.filter(loan => String(loan.status || '').toLowerCase() === 'active').length,
      closed_loans: loans.filter(loan => String(loan.status || '').toLowerCase() === 'closed').length,
      nano_transactions_scanned: txRows.length,
      origin_missing: originMissing.length,
      origin_type_mismatch: originTypeMismatch.length,
      origin_amount_mismatch: originAmountMismatch.length,
      origin_account_mismatch: originAccountMismatch.length,
      repayment_sum_mismatch: repaymentSumMismatch.length,
      status_mismatch: statusMismatch.length,
      pushed_needs_review: pushedNeedsReview.length
    },
    checks: {
      origin_rows_exist: originMissing.length === 0,
      origin_rows_are_active_borrow: originTypeMismatch.length === 0,
      origin_amounts_match_principal: originAmountMismatch.length === 0,
      origin_accounts_match_source: originAccountMismatch.length === 0,
      repayment_sums_match: repaymentSumMismatch.length === 0,
      loan_status_consistent_with_remaining: statusMismatch.length === 0,
      reversed_rows_excluded: true,
      push_to_cc_guarded: true,
      health_is_read_only: true
    },
    liability: {
      active_remaining_total: round2(activeMissingRemaining.reduce((sum, row) => sum + row.remaining, 0)),
      source: 'nano_loans'
    },
    origin_missing: originMissing,
    origin_type_mismatch: originTypeMismatch,
    origin_amount_mismatch: originAmountMismatch,
    origin_account_mismatch: originAccountMismatch,
    repayment_sum_mismatch: repaymentSumMismatch,
    status_mismatch: statusMismatch,
    pushed_needs_review: pushedNeedsReview,
    rules: {
      principal_received_is_income: false,
      origin_type: POSITIVE_LEDGER_TYPE,
      repayment_type: NEGATIVE_LEDGER_TYPE,
      account_balance_source: 'transactions_canonical',
      liability_source: 'nano_loans.remaining_amount'
    }
  });
}

async function loadLoans(db, loanCols) {
  if (!loanCols.has('id')) return [];

  const wanted = [
    'id',
    'date',
    'app_code',
    'app_name',
    'status',
    'shape',
    'principal_amount',
    'cool_off_fee',
    'total_owed',
    'repaid_amount',
    'source_account_id',
    'txn_in_id',
    'repay_txn_id',
    'pushed_at',
    'pushed_txn_id',
    'push_fee_txn_id',
    'cool_off_due',
    'closed_at',
    'notes',
    'created_at',
    'updated_at'
  ].filter(col => loanCols.has(col));

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM nano_loans
     ORDER BY
       CASE ${loanCols.has('status') ? 'status' : "''"} WHEN 'active' THEN 0 WHEN 'defaulted' THEN 1 ELSE 2 END,
       ${loanCols.has('date') ? 'date DESC,' : ''}
       ${loanCols.has('created_at') ? 'datetime(created_at) DESC,' : ''}
       id DESC`
  ).all();

  return (result.results || []).map(normalizeLoan);
}

async function loadLoan(db, loanCols, id) {
  if (!loanCols.has('id')) return null;

  const wanted = [
    'id',
    'date',
    'app_code',
    'app_name',
    'status',
    'shape',
    'principal_amount',
    'cool_off_fee',
    'total_owed',
    'repaid_amount',
    'source_account_id',
    'txn_in_id',
    'repay_txn_id',
    'pushed_at',
    'pushed_txn_id',
    'push_fee_txn_id',
    'cool_off_due',
    'closed_at',
    'notes',
    'created_at',
    'updated_at'
  ].filter(col => loanCols.has(col));

  const row = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM nano_loans
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();

  return row ? normalizeLoan(row) : null;
}

async function loadNanoTransactions(db, txCols) {
  if (!txCols.has('id')) return [];

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'transfer_to_account_id',
    'category_id',
    'merchant_id',
    'merchant',
    'notes',
    'linked_txn_id',
    'reversed_by',
    'reversed_at',
    'source_module',
    'source_id',
    'source_action',
    'created_at'
  ].filter(col => txCols.has(col));

  const predicates = [
    "notes LIKE '%[NANO_LOAN_ORIGIN]%'",
    "notes LIKE '%[NANO_LOAN_IN]%'",
    "notes LIKE '%[NANO_LOAN_REPAY]%'",
    "notes LIKE '%[NANO_PUSH_TO_CC]%'",
    "notes LIKE '%[NANO_COOL_OFF_FEE]%'"
  ];

  if (txCols.has('source_module')) {
    predicates.unshift("source_module = 'nano_loans'");
  }

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE ${predicates.join(' OR ')}
     ORDER BY ${txCols.has('date') ? 'date DESC,' : ''} ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC
     LIMIT 1000`
  ).all();

  return result.results || [];
}

async function loadAccounts(db, accountCols, includeLiabilities) {
  if (!accountCols.has('id')) return [];

  const wanted = [
    'id',
    'name',
    'icon',
    'type',
    'kind',
    'status',
    'display_order',
    'deleted_at',
    'archived_at'
  ].filter(col => accountCols.has(col));

  const where = activeAccountWhere(accountCols);

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${accountCols.has('display_order') ? 'display_order, ' : ''} ${accountCols.has('name') ? 'name, ' : ''} id`
  ).all();

  return (result.results || [])
    .filter(row => includeLiabilities || String(row.type || '').toLowerCase() === 'asset')
    .map(row => ({
      id: row.id,
      name: row.name || row.id,
      icon: row.icon || '',
      type: row.type || 'asset',
      kind: row.kind || row.type || 'asset',
      display_order: row.display_order == null ? 999 : Number(row.display_order)
    }));
}

async function loadAccount(db, accountCols, id, allowLiability) {
  if (!accountCols.has('id')) return null;

  const wanted = [
    'id',
    'name',
    'icon',
    'type',
    'kind',
    'status',
    'deleted_at',
    'archived_at'
  ].filter(col => accountCols.has(col));

  const where = activeAccountWhere(accountCols);

  const row = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM accounts
     WHERE id = ?
     ${where ? 'AND ' + where : ''}
     LIMIT 1`
  ).bind(id).first();

  if (!row) return null;
  if (!allowLiability && String(row.type || '').toLowerCase() !== 'asset') return null;

  return row;
}

function summarizeLoans(activeLoans, closedLoans) {
  const totalPrincipal = activeLoans.reduce((sum, loan) => sum + moneyNumber(loan.principal_amount, 0), 0);
  const totalOwed = activeLoans.reduce((sum, loan) => sum + moneyNumber(loan.total_owed, 0), 0);
  const totalRepaid = activeLoans.reduce((sum, loan) => sum + moneyNumber(loan.repaid_amount, 0), 0);
  const remaining = activeLoans.reduce((sum, loan) => sum + remainingForLoan(loan), 0);
  const coolOffFees = activeLoans.reduce((sum, loan) => sum + moneyNumber(loan.cool_off_fee, 0), 0);
  const pushedCount = activeLoans.filter(loan => loan.pushed_at || loan.pushed_txn_id).length;

  return {
    active_count: activeLoans.length,
    closed_count: closedLoans.length,
    total_principal: round2(totalPrincipal),
    total_owed: round2(totalOwed),
    total_repaid: round2(totalRepaid),
    remaining: round2(remaining),
    active_remaining: round2(remaining),
    nano_loan_outstanding: round2(remaining),
    cool_off_fees: round2(coolOffFees),
    pushed_count: pushedCount,
    unpushed_count: Math.max(0, activeLoans.length - pushedCount)
  };
}

function normalizeLoan(row) {
  const loan = {
    ...row,
    id: row.id,
    date: row.date || null,
    app_code: row.app_code || '',
    app_name: row.app_name || row.app_code || 'Nano Loan',
    status: row.status || 'active',
    shape: row.shape || 'A',
    principal_amount: round2(row.principal_amount),
    cool_off_fee: round2(row.cool_off_fee),
    total_owed: round2(row.total_owed),
    repaid_amount: round2(row.repaid_amount),
    source_account_id: row.source_account_id || '',
    txn_in_id: row.txn_in_id || null,
    repay_txn_id: row.repay_txn_id || null,
    pushed_at: row.pushed_at || null,
    pushed_txn_id: row.pushed_txn_id || null,
    push_fee_txn_id: row.push_fee_txn_id || null,
    cool_off_due: row.cool_off_due || null,
    closed_at: row.closed_at || null,
    notes: row.notes || '',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };

  loan.remaining_amount = round2(remainingForLoan(loan));
  loan.progress_pct = progressPct(loan);
  loan.liability_active = String(loan.status || '').toLowerCase() === 'active' && loan.remaining_amount > 0.01;

  return loan;
}

function remainingForLoan(loan) {
  return round2(Math.max(0, moneyNumber(loan.total_owed, 0) - moneyNumber(loan.repaid_amount, 0)));
}

function progressPct(loan) {
  const total = moneyNumber(loan.total_owed, 0);
  if (total <= 0) return 0;
  return round2(Math.max(0, Math.min(100, (moneyNumber(loan.repaid_amount, 0) / total) * 100)));
}

function validateCreateSchema(txCols, loanCols) {
  if (!loanCols.has('id')) return 'nano_loans table missing id column';
  if (!loanCols.has('principal_amount')) return 'nano_loans table missing principal_amount column';
  if (!loanCols.has('total_owed')) return 'nano_loans table missing total_owed column';
  if (!loanCols.has('repaid_amount')) return 'nano_loans table missing repaid_amount column';
  if (!loanCols.has('source_account_id')) return 'nano_loans table missing source_account_id column';
  if (!loanCols.has('txn_in_id')) return 'nano_loans table missing txn_in_id column';
  if (!txCols.has('id')) return 'transactions table missing id column';
  if (!txCols.has('type')) return 'transactions table missing type column';
  if (!txCols.has('amount')) return 'transactions table missing amount column';
  if (!txCols.has('account_id')) return 'transactions table missing account_id column';
  return '';
}

function validateRepaySchema(txCols, loanCols) {
  if (!loanCols.has('id')) return 'nano_loans table missing id column';
  if (!loanCols.has('repaid_amount')) return 'nano_loans table missing repaid_amount column';
  if (!loanCols.has('total_owed')) return 'nano_loans table missing total_owed column';
  if (!txCols.has('id')) return 'transactions table missing id column';
  if (!txCols.has('type')) return 'transactions table missing type column';
  if (!txCols.has('amount')) return 'transactions table missing amount column';
  if (!txCols.has('account_id')) return 'transactions table missing account_id column';
  return '';
}

function buildNanoLoanUpdate(db, loanCols, id, values) {
  const entries = Object.entries(values).filter(([key]) => loanCols.has(key));

  if (!entries.length) {
    throw new Error('No updateable nano_loans columns');
  }

  const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
  const bindValues = entries.map(([, value]) => value);

  return db.prepare(
    `UPDATE nano_loans
     SET ${setSql}
     WHERE id = ?`
  ).bind(...bindValues, id);
}

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

function activeAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");

  return clauses.join(' AND ');
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

function normalizeType(type) {
  const raw = String(type || '').trim().toLowerCase();

  if (raw === 'debt_in') return 'borrow';
  if (raw === 'debt_out') return 'repay';
  if (raw === 'debt_payment') return 'repay';

  return raw;
}

function rowAmount(row) {
  const pkr = Number(row.pkr_amount);

  if (Number.isFinite(pkr) && pkr !== 0) {
    return round2(Math.abs(pkr));
  }

  const amount = Number(row.amount);

  if (Number.isFinite(amount)) {
    return round2(Math.abs(amount));
  }

  return 0;
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

function normalizeShape(value) {
  const shape = String(value || 'A').trim().toUpperCase();
  return shape === 'B' ? 'B' : 'A';
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function cleanText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function cleanDate(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return new Date().toISOString().slice(0, 10);
}

function cleanDateOrNull(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return null;
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

function formatAmount(value) {
  return String(round2(value));
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function nowISO() {
  return new Date().toISOString();
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

async function safeAudit(env, event) {
  try {
    const result = await audit(env, {
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
      error: err.message || String(err)
    };
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
