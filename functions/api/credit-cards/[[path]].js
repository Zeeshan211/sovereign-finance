/*
 * Sovereign Finance — /api/credit-cards
 * v1.0.0-cc-contract-v1
 *
 * Contract version : credit-cards-v1
 * Route            : POST /api/credit-cards  (action in body — NEVER subroutes)
 *                    GET  /api/credit-cards
 *                    GET  /api/credit-cards?id=<card_id>
 *
 * 19 POST actions:
 *   create | update | record_purchase | record_cash_advance | record_intl_purchase
 *   record_payment | record_interest | record_fee | record_refund
 *   upload_statement | reconcile_statement | close_card
 *   convert_to_emi | record_balance_transfer | file_dispute | resolve_dispute
 *   detect_subscriptions | record_nsf_fee | configure_auto_pay
 *
 * Rules:
 *   - Auth via middleware — context.data.user_id is guaranteed present.
 *   - Every mutation checks idempotency_key via idempotency_keys table.
 *   - All amounts stored as INTEGER paisa; REAL amount = paisa / 100 for legacy.
 *   - D1 batch for every multi-row atomic write.
 *   - Canonical response: { ok, action, contract_version, ...payload, committed }
 *   - Canonical error: { ok:false, error, code, action, committed:false }
 *   - Existing /api/cc routes and accounts table are NOT modified here.
 */

import { json, uuid, audit } from '../_lib.js';

const VERSION           = 'v1.0.0-cc-contract-v1';
const CONTRACT_VERSION  = 'credit-cards-v1';

// ─── Interest / IFD defaults ─────────────────────────────────────────────────
const DEFAULT_STATEMENT_DAY   = 12;
const DEFAULT_IFD             = 55;    // interest-free days
const DEFAULT_APR             = 42.0;  // % annual
const DEFAULT_MIN_PAYMENT_PCT = 5.0;

// ─── Transaction types (must satisfy D1 CHECK constraint) ────────────────────
const TX_CC_SPEND   = 'cc_spend';   // liability increases
const TX_CC_PAYMENT = 'cc_payment'; // liability decreases (transfer leg)
const TX_EXPENSE    = 'expense';    // interest / fee on card account
const TX_INCOME     = 'income';     // refund / dispute credit / cash advance receipt

// ─── Supported card statuses ─────────────────────────────────────────────────
const ACTIVE_STATUSES = new Set(['active', 'paused']);

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

export async function onRequest(context) {
  try {
    const { request } = context;
    const method = request.method;

    if (method === 'GET')  return await handleGet(context);
    if (method === 'POST') return await handlePost(context);

    return errResp('n/a', 'METHOD_NOT_ALLOWED', `${method} not supported`, 405);
  } catch (e) {
    if (e.status === 401) return errResp('n/a', 'UNAUTHORIZED', e.message || 'Session required', 401);
    console.error('[credit-cards]', e);
    return errResp('n/a', 'INTERNAL_ERROR', e.message || String(e), 500);
  }
}

// ─── GET: list cards or single card ──────────────────────────────────────────

async function handleGet(context) {
  const db     = requireDb(context.env);
  const userId = requireUserId(context);
  const url    = new URL(context.request.url);
  const cardId = url.searchParams.get('id');
  const includeInactive = url.searchParams.get('include_inactive') === '1';

  if (cardId) {
    const card = await db.prepare(
      `SELECT cc.*, a.name AS account_name, a.kind AS account_kind,
              a.status AS account_status
       FROM credit_cards cc
       JOIN accounts a ON a.id = cc.account_id
       WHERE cc.id = ? AND cc.user_id = ?`
    ).bind(cardId, userId).first();

    if (!card) return errResp('list', 'CARD_NOT_FOUND', `Card ${cardId} not found`, 404);

    const balance = await computeCardOutstanding(db, card.account_id);
    const statements = await getLatestStatements(db, card.id, 3);

    return json({
      ok: true, version: VERSION, contract_version: CONTRACT_VERSION,
      card: enrichCard(card, balance),
      current_cycle: statements[0] ?? null,
      recent_statements: statements
    });
  }

  const statusFilter = includeInactive
    ? ''
    : `AND cc.status NOT IN ('deleted', 'closed')`;

  const result = await db.prepare(
    `SELECT cc.*, a.name AS account_name, a.kind AS account_kind
     FROM credit_cards cc
     LEFT JOIN accounts a ON a.id = cc.account_id
     WHERE cc.user_id = ? ${statusFilter}
     ORDER BY cc.created_at ASC`
  ).bind(userId).all();

  const cards = result.results || [];
  const enriched = await Promise.all(cards.map(async c => {
    const balance = await computeCardOutstanding(db, c.account_id);
    return enrichCard(c, balance);
  }));

  const totalOutstanding = enriched.reduce((s, c) => s + (c.outstanding_paisa || 0), 0);
  const totalLimit       = enriched.reduce((s, c) => s + (c.credit_limit_paisa || 0), 0);

  return json({
    ok: true, version: VERSION, contract_version: CONTRACT_VERSION,
    count: enriched.length,
    portfolio_summary: {
      total_outstanding_paisa: totalOutstanding,
      total_credit_limit_paisa: totalLimit,
      utilization_pct: totalLimit > 0 ? round1((totalOutstanding / totalLimit) * 100) : null,
    },
    cards: enriched
  });
}

// ─── POST: dispatch actions ───────────────────────────────────────────────────

async function handlePost(context) {
  const db     = requireDb(context.env);
  const userId = requireUserId(context);
  const body   = await readJSON(context.request);
  const action = safeStr(body.action, '').toLowerCase();

  if (!action) {
    return errResp('post', 'MISSING_ACTION', 'action field required in request body', 400);
  }

  switch (action) {
    case 'create':
      return actionCreate(db, body, userId);
    case 'update':
      return actionUpdate(db, body, userId);
    case 'record_purchase':
      return actionRecordPurchase(db, body, userId);
    case 'record_cash_advance':
      return actionRecordCashAdvance(db, body, userId);
    case 'record_intl_purchase':
      return actionRecordIntlPurchase(db, body, userId);
    case 'record_payment':
      return actionRecordPayment(db, body, userId);
    case 'record_interest':
      return actionRecordInterest(db, body, userId);
    case 'record_fee':
      return actionRecordFee(db, body, userId);
    case 'record_refund':
      return actionRecordRefund(db, body, userId);
    case 'upload_statement':
      return actionUploadStatement(db, body, userId);
    case 'reconcile_statement':
      return actionReconcileStatement(db, body, userId);
    case 'close_card':
      return actionCloseCard(db, body, userId);
    case 'convert_to_emi':
      return actionConvertToEmi(db, body, userId);
    case 'record_balance_transfer':
      return actionRecordBalanceTransfer(db, body, userId);
    case 'file_dispute':
      return actionFileDispute(db, body, userId);
    case 'resolve_dispute':
      return actionResolveDispute(db, body, userId);
    case 'detect_subscriptions':
      return actionDetectSubscriptions(db, body, userId);
    case 'record_nsf_fee':
      return actionRecordNsfFee(db, body, userId);
    case 'configure_auto_pay':
      return actionConfigureAutoPay(db, body, userId);
    case 'delete_statement':
      return actionDeleteStatement(db, body, userId);
    case 'get_cycle_info':
      return actionGetCycleInfo(db, body, userId);
    case 'register_trip':
      return actionRegisterTrip(db, body, userId);
    case 'log_benefit_usage':
      return actionLogBenefitUsage(db, body, userId);
    case 'add_household_member':
      return actionAddHouseholdMember(db, body, userId);
    case 'settle_household':
      return actionSettleHousehold(db, body, userId);
    case 'list_trips':
      return actionListTrips(db, body, userId);
    case 'list_benefits':
      return actionListBenefits(db, body, userId);
    case 'parse_statement_pdf':
      return actionParseStatementPdf(db, body, userId, context.env);
    case 'run_reconciliation':
      return actionRunReconciliation(db, body, userId);
    case 'import_statement_transaction':
      return actionImportStatementTransaction(db, body, userId);
    case 'mark_statement_txn_disputed':
      return actionMarkStatementTxnDisputed(db, body, userId);
    case 'get_reconciliation_view':
      return actionGetReconciliationView(db, body, userId);
    default:
      return errResp(action, 'UNKNOWN_ACTION',
        `Unknown action "${action}". Supported: create, update, record_purchase, record_cash_advance, ` +
        `record_intl_purchase, record_payment, record_interest, record_fee, record_refund, ` +
        `upload_statement, reconcile_statement, close_card, convert_to_emi, record_balance_transfer, ` +
        `file_dispute, resolve_dispute, detect_subscriptions, record_nsf_fee, configure_auto_pay, ` +
        `parse_statement_pdf, run_reconciliation, import_statement_transaction, ` +
        `mark_statement_txn_disputed, get_reconciliation_view`, 400);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 1: create — new card with auto-fill from bank_card_defaults
// ═════════════════════════════════════════════════════════════════════════════

async function actionCreate(db, body, userId) {
  const { account_id, bank_id, card_name, card_nickname, card_number_last4,
          card_network, credit_limit_paisa, idempotency_key } = body;

  if (!account_id) return errResp('create', 'MISSING_FIELDS', 'account_id required', 400);
  if (!credit_limit_paisa || credit_limit_paisa <= 0) {
    return errResp('create', 'INVALID_LIMIT', 'credit_limit_paisa must be a positive integer', 400);
  }

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'create');
  if (idem) return idem;

  const account = await db.prepare(
    `SELECT id, name, kind, status, statement_day, payment_due_day, credit_limit, credit_limit_paisa, owner_user_id
     FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')`
  ).bind(account_id).first();

  if (!account) return errResp('create', 'ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, 404);
  if (account.kind !== 'cc') {
    return errResp('create', 'ACCOUNT_NOT_CC', `Account ${account_id} is kind="${account.kind}", expected "cc"`, 400);
  }

  const existing = await db.prepare(
    `SELECT id FROM credit_cards WHERE account_id = ? AND user_id = ? AND status != 'deleted'`
  ).bind(account_id, userId).first();
  if (existing) {
    return errResp('create', 'DUPLICATE_CARD', `Credit card for account ${account_id} already exists (id=${existing.id})`, 409);
  }

  const defaults = bank_id
    ? await db.prepare(`SELECT * FROM bank_card_defaults WHERE bank_id = ?`).bind(bank_id).first()
    : null;

  const now   = new Date().toISOString();
  const cardId = 'cc_' + uuid();

  const row = {
    id:                         cardId,
    account_id,
    user_id:                    userId,
    household_id:               'hh_owner',
    bank_id:                    bank_id || null,
    card_name:                  card_name || account.name,
    card_nickname:              card_nickname || null,
    card_number_last4:          card_number_last4 || null,
    card_network:               card_network || 'visa',
    credit_limit_paisa:         Math.round(credit_limit_paisa),
    statement_day:              body.statement_day || account.statement_day || (defaults?.default_statement_day) || DEFAULT_STATEMENT_DAY,
    payment_due_day:            body.payment_due_day || account.payment_due_day || (defaults?.default_payment_due_day) || 25,
    interest_free_days:         body.interest_free_days || (defaults?.interest_free_days) || DEFAULT_IFD,
    apr_pct:                    body.apr_pct ?? (defaults?.apr_pct) ?? DEFAULT_APR,
    cash_advance_apr_pct:       body.cash_advance_apr_pct ?? (defaults?.cash_advance_apr_pct) ?? DEFAULT_APR,
    cash_advance_fee_pct:       body.cash_advance_fee_pct ?? (defaults?.cash_advance_fee_pct) ?? 3.0,
    cash_advance_fee_min_paisa: body.cash_advance_fee_min_paisa ?? (defaults?.cash_advance_fee_min_paisa) ?? 50000,
    fx_markup_pct:              body.fx_markup_pct ?? (defaults?.fx_markup_pct) ?? 3.5,
    reward_type:                body.reward_type || (defaults?.reward_type) || 'none',
    reward_rate_pct:            body.reward_rate_pct ?? (defaults?.reward_rate_pct) ?? 0.0,
    minimum_payment_pct:        body.minimum_payment_pct ?? (defaults?.minimum_payment_pct) ?? DEFAULT_MIN_PAYMENT_PCT,
    late_payment_fee_paisa:     body.late_payment_fee_paisa ?? (defaults?.late_payment_fee_paisa) ?? 150000,
    over_limit_fee_paisa:       body.over_limit_fee_paisa ?? (defaults?.over_limit_fee_paisa) ?? 150000,
    status:                     'active',
    backfill_status:            'confirmed',
    created_at:                 now,
    updated_at:                 now,
    notes:                      body.notes || null,
    pdf_password_strategy:      body.pdf_password_strategy || 'manual_unlock',
    payment_allocation_order:   body.payment_allocation_order || 'bank_standard',
    auto_pay_fallback_to_minimum: 1,
    auto_pay_max_retries:       3,
    credit_balance_handling:    'apply_next_month',
    waiver_threshold_period_months: 12,
    multi_currency_billing:     0
  };

  await db.prepare(
    `INSERT INTO credit_cards (id, account_id, user_id, household_id, bank_id, card_name, card_nickname,
      card_number_last4, card_network, credit_limit_paisa, statement_day, payment_due_day, interest_free_days,
      apr_pct, cash_advance_apr_pct, cash_advance_fee_pct, cash_advance_fee_min_paisa, fx_markup_pct,
      reward_type, reward_rate_pct, minimum_payment_pct, late_payment_fee_paisa, over_limit_fee_paisa,
      status, backfill_status, created_at, updated_at, notes, pdf_password_strategy,
      payment_allocation_order, auto_pay_fallback_to_minimum, auto_pay_max_retries,
      credit_balance_handling, waiver_threshold_period_months, multi_currency_billing)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    row.id, row.account_id, row.user_id, row.household_id, row.bank_id, row.card_name, row.card_nickname,
    row.card_number_last4, row.card_network, row.credit_limit_paisa, row.statement_day, row.payment_due_day,
    row.interest_free_days, row.apr_pct, row.cash_advance_apr_pct, row.cash_advance_fee_pct,
    row.cash_advance_fee_min_paisa, row.fx_markup_pct, row.reward_type, row.reward_rate_pct,
    row.minimum_payment_pct, row.late_payment_fee_paisa, row.over_limit_fee_paisa,
    row.status, row.backfill_status, row.created_at, row.updated_at, row.notes,
    row.pdf_password_strategy, row.payment_allocation_order, row.auto_pay_fallback_to_minimum,
    row.auto_pay_max_retries, row.credit_balance_handling, row.waiver_threshold_period_months,
    row.multi_currency_billing
  ).run();

  await saveIdempotency(db, idempotency_key, userId, 'create', cardId);
  await audit(db.env || db, { action: 'CC_CREATE', entity: 'credit_card', entity_id: cardId, created_by: userId,
    detail: { card_id: cardId, account_id, bank_id } });

  return json({ ok: true, action: 'create', contract_version: CONTRACT_VERSION,
    card_id: cardId, card: row, committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 2: update — config changes (non-structural fields only)
// ═════════════════════════════════════════════════════════════════════════════

async function actionUpdate(db, body, userId) {
  const { card_id } = body;
  if (!card_id) return errResp('update', 'MISSING_FIELDS', 'card_id required', 400);

  const card = await requireCard(db, card_id, userId);

  const MUTABLE = ['card_name', 'card_nickname', 'card_number_last4', 'card_network', 'card_tier',
    'credit_limit_paisa', 'statement_day', 'payment_due_day', 'interest_free_days',
    'apr_pct', 'cash_advance_apr_pct', 'cash_advance_fee_pct', 'cash_advance_fee_min_paisa',
    'fx_markup_pct', 'reward_type', 'reward_rate_pct', 'reward_cap_monthly_paisa',
    'minimum_payment_pct', 'minimum_payment_fixed_paisa', 'annual_fee_paisa', 'annual_fee_month',
    'late_payment_fee_paisa', 'over_limit_fee_paisa', 'notes', 'opened_date',
    'pdf_password_strategy', 'pdf_password_encrypted', 'pdf_password_pattern', 'email_forward_address',
    'payment_allocation_order', 'credit_balance_handling', 'waiver_threshold_period_months',
    'multi_currency_billing', 'bank_id', 'predecessor_card_id', 'successor_card_id'];

  const updates = {};
  for (const field of MUTABLE) {
    if (body[field] !== undefined) updates[field] = body[field];
  }
  if (Object.keys(updates).length === 0) {
    return errResp('update', 'NO_FIELDS', 'No updatable fields provided', 400);
  }

  updates.updated_at = new Date().toISOString();
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values     = [...Object.values(updates), card_id];

  await db.prepare(`UPDATE credit_cards SET ${setClauses} WHERE id = ?`).bind(...values).run();

  return json({ ok: true, action: 'update', contract_version: CONTRACT_VERSION,
    card_id, updated_fields: Object.keys(updates).filter(k => k !== 'updated_at'), committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 3: record_purchase — single cc_spend + reward calc + IFD calc
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordPurchase(db, body, userId) {
  const { card_id, amount_paisa, date, merchant, category_id, notes, idempotency_key,
          household_member_id, trip_id, benefit_usage_id, tax_deductible_business, tax_category } = body;

  if (!card_id || !amount_paisa || !date) {
    return errResp('record_purchase', 'MISSING_FIELDS', 'card_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_purchase', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_purchase');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);
  const ifd  = calculateIfd(card, date);
  const reward = calculateReward(card, amount_paisa);

  const txnId = 'cctx_' + uuid();
  const now   = new Date().toISOString();
  const marker = `[CC_SPEND] card_id=${card_id}`;
  const txnNotes = notes ? `${marker} | ${notes}` : marker;

  const openStmt = await getOpenStatement(db, card_id);

  const stmts = [
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id, notes,
        source_module, source_action, cc_subtype, cc_statement_id, cc_reconciliation_status,
        reward_earned_paisa, reward_earned_points, reward_earned_miles,
        household_member_id, trip_id, benefit_usage_id, tax_deductible_business, tax_category,
        idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, date, TX_CC_SPEND, amount_paisa / 100, amount_paisa, card.account_id,
      category_id || 'cc_spend', txnNotes, 'credit_cards', 'record_purchase', 'purchase',
      openStmt?.id || null, 'unreconciled',
      reward.paisa, reward.points, reward.miles,
      household_member_id || null, trip_id || null, benefit_usage_id || null,
      tax_deductible_business ? 1 : 0, tax_category || null,
      idempotency_key || null, userId, 'hh_owner', now
    )
  ];

  if (openStmt) {
    stmts.push(db.prepare(
      `UPDATE card_statements SET total_spend_paisa = total_spend_paisa + ?, updated_at = ?
       WHERE id = ?`
    ).bind(amount_paisa, now, openStmt.id));
  }

  await db.batch(stmts);

  const outstanding = await computeCardOutstanding(db, card.account_id);
  const warnings = [];
  if (outstanding.paisa > card.credit_limit_paisa) {
    warnings.push({ severity: 'warning', code: 'CARD_OVER_LIMIT',
      message: 'Credit card outstanding exceeds configured limit.' });
  }

  await saveIdempotency(db, idempotency_key, userId, 'record_purchase', txnId);

  return json({ ok: true, action: 'record_purchase', contract_version: CONTRACT_VERSION,
    transaction_id: txnId,
    card: { id: card_id, outstanding_delta_paisa: amount_paisa },
    ifd, reward,
    ledger: { created: true, transaction_id: txnId, marker,
              type: TX_CC_SPEND, amount_paisa,
              cc_subtype: 'purchase' },
    warnings, committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 4: record_cash_advance — 3-leg atomic batch
//   Leg 1: cc_spend on CC account (outstanding increases by principal)
//   Leg 2: income on cash account (user receives cash)
//   Leg 3: cc_spend on CC account for cash-advance fee (outstanding increases by fee)
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordCashAdvance(db, body, userId) {
  const { card_id, to_account_id, amount_paisa, date, notes, idempotency_key } = body;

  if (!card_id || !to_account_id || !amount_paisa || !date) {
    return errResp('record_cash_advance', 'MISSING_FIELDS', 'card_id, to_account_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_cash_advance', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_cash_advance');
  if (idem) return idem;

  const card      = await requireCard(db, card_id, userId);
  const toAccount = await db.prepare(
    `SELECT id, name FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')`
  ).bind(to_account_id).first();
  if (!toAccount) return errResp('record_cash_advance', 'ACCOUNT_NOT_FOUND', `Account ${to_account_id} not found`, 404);

  const feeRate = card.cash_advance_fee_pct || 3.0;
  const feeMin  = card.cash_advance_fee_min_paisa || 50000;
  const calculatedFee = Math.round(amount_paisa * feeRate / 100);
  const fee_paisa = Math.max(calculatedFee, feeMin);

  const txnPrincipal = 'cctx_' + uuid();
  const txnCash      = 'cctx_' + uuid();
  const txnFee       = 'cctx_' + uuid();
  const now = new Date().toISOString();
  const marker = `[CC_CASH_ADVANCE] card_id=${card_id}`;

  await db.batch([
    // Leg 1: outstanding increases (cc_spend)
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
        idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(txnPrincipal, date, TX_CC_SPEND, amount_paisa / 100, amount_paisa, card.account_id,
      'cc_spend', `${marker} principal | ${notes || ''}`, 'credit_cards', 'record_cash_advance',
      'cash_advance', 'unreconciled', null, userId, 'hh_owner', now),

    // Leg 2: cash account receives funds (income)
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
        created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(txnCash, date, TX_INCOME, amount_paisa / 100, amount_paisa, to_account_id,
      'other', `${marker} cash_received | card=${card_id}`, 'credit_cards', 'record_cash_advance',
      'cash_advance', 'unreconciled', userId, 'hh_owner', now),

    // Leg 3: fee increases outstanding (cc_spend)
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
        created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(txnFee, date, TX_CC_SPEND, fee_paisa / 100, fee_paisa, card.account_id,
      'cc_spend', `[CC_FEE] card_id=${card_id} fee_type=cash_advance_fee`, 'credit_cards',
      'record_cash_advance', 'fee', 'unreconciled', userId, 'hh_owner', now)
  ]);

  await db.prepare(
    `INSERT OR IGNORE INTO card_fees (id, card_id, user_id, transaction_id, fee_type, amount_paisa, fee_date)
     VALUES (?,?,?,?,?,?,?)`
  ).bind('cf_' + uuid(), card_id, userId, txnFee, 'cash_advance', fee_paisa, date).run();

  await saveIdempotency(db, idempotency_key, userId, 'record_cash_advance', txnPrincipal);

  return json({ ok: true, action: 'record_cash_advance', contract_version: CONTRACT_VERSION,
    transaction_ids: { principal: txnPrincipal, cash_received: txnCash, fee: txnFee },
    principal_paisa: amount_paisa, fee_paisa,
    total_outstanding_increase_paisa: amount_paisa + fee_paisa,
    note: 'Cash advances accrue interest from day 1 (zero IFD). No cashback/reward on cash advances.',
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 5: record_intl_purchase — single txn with foreign_amount + FX markup
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordIntlPurchase(db, body, userId) {
  const { card_id, amount_paisa, date, foreign_amount, foreign_currency, fx_rate,
          merchant, category_id, notes, idempotency_key, trip_id } = body;

  if (!card_id || !amount_paisa || !date) {
    return errResp('record_intl_purchase', 'MISSING_FIELDS', 'card_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_intl_purchase', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_intl_purchase');
  if (idem) return idem;

  const card   = await requireCard(db, card_id, userId);
  const ifd    = calculateIfd(card, date);
  const reward = calculateReward(card, amount_paisa);

  const fxMarkupPct = card.fx_markup_pct || 3.5;
  const baseAmount  = foreign_amount && fx_rate
    ? Math.round(foreign_amount * fx_rate * 100)
    : amount_paisa;
  const fxMarkupPaisa = Math.round(baseAmount * fxMarkupPct / 100);

  const txnId  = 'cctx_' + uuid();
  const now    = new Date().toISOString();
  const marker = `[CC_SPEND] card_id=${card_id} intl=1`;
  const txnNotes = [marker, foreign_currency ? `${foreign_amount} ${foreign_currency}` : '', notes].filter(Boolean).join(' | ');

  await db.prepare(
    `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id, notes,
      source_module, source_action, cc_subtype, cc_reconciliation_status,
      foreign_currency, foreign_amount_minor, fx_rate_at_commit, fx_markup_paisa,
      reward_earned_paisa, reward_earned_points, reward_earned_miles,
      trip_id, idempotency_key, created_by_user_id, household_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    txnId, date, TX_CC_SPEND, amount_paisa / 100, amount_paisa, card.account_id,
    category_id || 'cc_spend', txnNotes, 'credit_cards', 'record_intl_purchase', 'intl',
    'unreconciled',
    foreign_currency || null,
    foreign_amount ? Math.round(foreign_amount * 100) : null,
    fx_rate || null,
    fxMarkupPaisa,
    reward.paisa, reward.points, reward.miles,
    trip_id || null, idempotency_key || null, userId, 'hh_owner', now
  ).run();

  await saveIdempotency(db, idempotency_key, userId, 'record_intl_purchase', txnId);

  return json({ ok: true, action: 'record_intl_purchase', contract_version: CONTRACT_VERSION,
    transaction_id: txnId,
    breakdown: { base_paisa: baseAmount, fx_markup_paisa: fxMarkupPaisa, total_paisa: amount_paisa },
    ifd, reward,
    ledger: { created: true, transaction_id: txnId, marker, type: TX_CC_SPEND, amount_paisa, cc_subtype: 'intl' },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 6: record_payment — 2-leg atomic + payment allocation engine
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordPayment(db, body, userId) {
  const { card_id, from_account_id, amount_paisa, date, notes, idempotency_key } = body;

  if (!card_id || !from_account_id || !amount_paisa || !date) {
    return errResp('record_payment', 'MISSING_FIELDS', 'card_id, from_account_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_payment', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_payment');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);

  const fromAccount = await db.prepare(
    `SELECT id, name, type, kind FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')`
  ).bind(from_account_id).first();
  if (!fromAccount) {
    return errResp('record_payment', 'ACCOUNT_NOT_FOUND', `Source account ${from_account_id} not found`, 404);
  }

  const marker  = `[CC_PAYMENT] card_id=${card_id} from_account_id=${from_account_id}`;
  const txnNotes = notes ? `${marker} | ${notes}` : marker;
  const txnId   = 'cctx_' + uuid();
  const now     = new Date().toISOString();

  // The cc_payment type with transfer_to_account_id is the canonical 2-leg model:
  // - On from_account: balance decreases (cash out)
  // - On card account: balance increases (liability decreases)
  const stmts = [
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, transfer_to_account_id,
        category_id, notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
        payment_allocation, idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, date, TX_CC_PAYMENT, amount_paisa / 100, amount_paisa,
      from_account_id, card.account_id, 'cc_pay', txnNotes,
      'credit_cards', 'record_payment', 'payment', 'unreconciled',
      null, idempotency_key || null, userId, 'hh_owner', now
    )
  ];

  // Run payment allocation across outstanding statements (oldest due first)
  const statements = await db.prepare(
    `SELECT id, due_date, statement_balance_paisa, balance_remaining_paisa,
            minimum_payment_paisa, payment_status
     FROM card_statements
     WHERE card_id = ? AND user_id = ?
       AND payment_status NOT IN ('paid_full')
     ORDER BY due_date ASC`
  ).bind(card_id, userId).all();

  const allocation = runPaymentAllocation(statements.results || [], amount_paisa, date);

  for (const alloc of allocation.allocations) {
    stmts.push(db.prepare(
      `UPDATE card_statements
       SET balance_remaining_paisa   = ?,
           total_allocations_paisa   = COALESCE(total_allocations_paisa, 0) + ?,
           paid_amount_paisa         = COALESCE(paid_amount_paisa, 0) + ?,
           payment_status            = ?,
           late_payment_flagged      = ?,
           late_payment_date         = CASE WHEN ? = 1 THEN ? ELSE late_payment_date END,
           updated_at                = ?
       WHERE id = ?`
    ).bind(
      alloc.new_balance_paisa, alloc.applied_paisa, alloc.applied_paisa,
      alloc.payment_status, alloc.late_payment_flagged ? 1 : 0,
      alloc.late_payment_flagged ? 1 : 0, date,
      now, alloc.statement_id
    ));
  }

  await db.batch(stmts);

  await db.prepare(
    `UPDATE transactions SET payment_allocation = ? WHERE id = ?`
  ).bind(JSON.stringify(allocation.allocations), txnId).run();

  await saveIdempotency(db, idempotency_key, userId, 'record_payment', txnId);
  await audit(db.env || db, { action: 'CC_PAYMENT', entity: 'credit_card', entity_id: card_id,
    created_by: userId, detail: { txn_id: txnId, amount_paisa, from_account_id } });

  return json({ ok: true, action: 'record_payment', contract_version: CONTRACT_VERSION,
    transaction_id: txnId, amount_paisa,
    card: { id: card_id, outstanding_delta_paisa: -amount_paisa },
    payment_allocation: allocation,
    ledger: { created: true, transaction_id: txnId, marker, type: TX_CC_PAYMENT,
              amount_paisa, account_id: from_account_id, account_delta_paisa: -amount_paisa },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 7: record_interest — single txn linked to statement period
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordInterest(db, body, userId) {
  const { card_id, amount_paisa, date, statement_id, period_start, period_end,
          average_daily_balance_paisa, notes, idempotency_key } = body;

  if (!card_id || !amount_paisa || !date) {
    return errResp('record_interest', 'MISSING_FIELDS', 'card_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_interest', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_interest');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);

  if (statement_id) {
    const stmt = await db.prepare(
      `SELECT id FROM card_statements WHERE id = ? AND card_id = ? AND user_id = ?`
    ).bind(statement_id, card_id, userId).first();
    if (!stmt) return errResp('record_interest', 'STATEMENT_NOT_FOUND', `Statement ${statement_id} not found`, 404);
  }

  const txnId = 'cctx_' + uuid();
  const now   = new Date().toISOString();
  const marker = `[CC_INTEREST] card_id=${card_id}`;
  const statementNote = statement_id ? ` stmt=${statement_id}` : '';

  const batchStmts = [
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_statement_id, cc_reconciliation_status,
        idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, date, TX_EXPENSE, amount_paisa / 100, amount_paisa, card.account_id,
      'cc_spend', `${marker}${statementNote}${notes ? ' | ' + notes : ''}`,
      'credit_cards', 'record_interest', 'interest',
      statement_id || null, 'unreconciled',
      idempotency_key || null, userId, 'hh_owner', now
    ),
    db.prepare(
      `INSERT INTO card_interest_accruals (id, card_id, user_id, statement_id, transaction_id,
        accrual_date, accrual_type, period_start, period_end, average_daily_balance_paisa, amount_paisa, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      'cia_' + uuid(), card_id, userId, statement_id || null, txnId,
      date, 'purchase_interest', period_start || null, period_end || null,
      average_daily_balance_paisa || null, amount_paisa, now
    )
  ];

  if (statement_id) {
    batchStmts.push(db.prepare(
      `UPDATE card_statements SET total_interest_paisa = total_interest_paisa + ?,
        balance_remaining_paisa = COALESCE(balance_remaining_paisa, statement_balance_paisa, 0) + ?,
        updated_at = ? WHERE id = ?`
    ).bind(amount_paisa, amount_paisa, now, statement_id));
  }

  await db.batch(batchStmts);
  await saveIdempotency(db, idempotency_key, userId, 'record_interest', txnId);

  return json({ ok: true, action: 'record_interest', contract_version: CONTRACT_VERSION,
    transaction_id: txnId,
    ledger: { created: true, marker, type: TX_EXPENSE, cc_subtype: 'interest', amount_paisa },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 8: record_fee — single txn with fee_type
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordFee(db, body, userId) {
  const { card_id, amount_paisa, date, fee_type, statement_id, notes, idempotency_key } = body;

  if (!card_id || !amount_paisa || !date || !fee_type) {
    return errResp('record_fee', 'MISSING_FIELDS', 'card_id, amount_paisa, date, fee_type required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_fee', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const VALID_FEE_TYPES = new Set(['annual_fee','late_payment','over_limit','cash_advance',
    'foreign_transaction','nsf','statement_fee','replacement_fee','other']);
  if (!VALID_FEE_TYPES.has(fee_type)) {
    return errResp('record_fee', 'INVALID_FEE_TYPE',
      `fee_type "${fee_type}" not valid. Use: ${[...VALID_FEE_TYPES].join(', ')}`, 400);
  }

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_fee');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);
  const txnId = 'cctx_' + uuid();
  const now   = new Date().toISOString();
  const marker = `[CC_FEE] card_id=${card_id} fee_type=${fee_type}`;

  const batchStmts = [
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_statement_id, cc_reconciliation_status,
        idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, date, TX_EXPENSE, amount_paisa / 100, amount_paisa, card.account_id,
      'cc_spend', `${marker}${notes ? ' | ' + notes : ''}`,
      'credit_cards', 'record_fee', 'fee',
      statement_id || null, 'unreconciled',
      idempotency_key || null, userId, 'hh_owner', now
    ),
    db.prepare(
      `INSERT OR IGNORE INTO card_fees (id, card_id, user_id, transaction_id, fee_type, amount_paisa, fee_date, statement_id, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      'cf_' + uuid(), card_id, userId, txnId, fee_type, amount_paisa, date, statement_id || null, notes || null
    )
  ];

  if (statement_id) {
    batchStmts.push(db.prepare(
      `UPDATE card_statements SET total_fees_paisa = total_fees_paisa + ?,
        balance_remaining_paisa = COALESCE(balance_remaining_paisa, statement_balance_paisa, 0) + ?,
        updated_at = ? WHERE id = ?`
    ).bind(amount_paisa, amount_paisa, now, statement_id));
  }

  await db.batch(batchStmts);
  await saveIdempotency(db, idempotency_key, userId, 'record_fee', txnId);

  return json({ ok: true, action: 'record_fee', contract_version: CONTRACT_VERSION,
    transaction_id: txnId,
    ledger: { created: true, marker, type: TX_EXPENSE, cc_subtype: 'fee', fee_type, amount_paisa },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 9: record_refund — single txn, optional reward reversal
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordRefund(db, body, userId) {
  const { card_id, amount_paisa, date, original_txn_id, merchant, category_id,
          reverse_reward, notes, idempotency_key } = body;

  if (!card_id || !amount_paisa || !date) {
    return errResp('record_refund', 'MISSING_FIELDS', 'card_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_refund', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_refund');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);

  let originalTxn = null;
  if (original_txn_id) {
    originalTxn = await db.prepare(
      `SELECT id, reward_earned_paisa, reward_earned_points, reward_earned_miles, amount_paisa
       FROM transactions WHERE id = ? AND account_id = ?`
    ).bind(original_txn_id, card.account_id).first();
  }

  const txnId  = 'cctx_' + uuid();
  const now    = new Date().toISOString();
  const marker = `[CC_REFUND] card_id=${card_id}`;
  const origNote = original_txn_id ? ` original_txn=${original_txn_id}` : '';
  const txnNotes = `${marker}${origNote}${notes ? ' | ' + notes : ''}`;

  const rewardReversal = (reverse_reward && originalTxn)
    ? { paisa: -(originalTxn.reward_earned_paisa || 0),
        points: -(originalTxn.reward_earned_points || 0),
        miles: -(originalTxn.reward_earned_miles || 0) }
    : { paisa: 0, points: 0, miles: 0 };

  await db.prepare(
    `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
      notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
      reward_earned_paisa, reward_earned_points, reward_earned_miles,
      idempotency_key, created_by_user_id, household_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    txnId, date, TX_INCOME, amount_paisa / 100, amount_paisa, card.account_id,
    category_id || 'cc_spend', txnNotes, 'credit_cards', 'record_refund', 'refund',
    'unreconciled',
    rewardReversal.paisa, rewardReversal.points, rewardReversal.miles,
    idempotency_key || null, userId, 'hh_owner', now
  ).run();

  await saveIdempotency(db, idempotency_key, userId, 'record_refund', txnId);

  return json({ ok: true, action: 'record_refund', contract_version: CONTRACT_VERSION,
    transaction_id: txnId,
    card: { id: card_id, outstanding_delta_paisa: -amount_paisa },
    reward_reversal: rewardReversal,
    ledger: { created: true, marker, type: TX_INCOME, cc_subtype: 'refund', amount_paisa },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 10: upload_statement — insert card_statements row with parsing_status='pending'
// ═════════════════════════════════════════════════════════════════════════════

async function actionUploadStatement(db, body, userId) {
  const { card_id, statement_month, statement_start, statement_end, due_date,
          file_url, statement_balance_paisa, minimum_payment_paisa, idempotency_key } = body;

  if (!card_id || !statement_month || !statement_end || !due_date) {
    return errResp('upload_statement', 'MISSING_FIELDS',
      'card_id, statement_month, statement_end, due_date required', 400);
  }

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'upload_statement');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);

  const existing = await db.prepare(
    `SELECT id FROM card_statements WHERE card_id = ? AND statement_month = ? AND user_id = ?`
  ).bind(card_id, statement_month, userId).first();
  if (existing) {
    return errResp('upload_statement', 'STATEMENT_EXISTS',
      `Statement for ${statement_month} already exists (id=${existing.id})`, 409);
  }

  const stmtId = 'cs_' + uuid();
  const now    = new Date().toISOString();
  const cycleStart = statement_start || computeCycleStart(statement_month, card.statement_day);
  const balancePaisa = statement_balance_paisa || 0;
  const minPay = minimum_payment_paisa ||
    Math.round(balancePaisa * (card.minimum_payment_pct || DEFAULT_MIN_PAYMENT_PCT) / 100);

  await db.prepare(
    `INSERT INTO card_statements (id, card_id, user_id, statement_month, statement_start,
      statement_end, due_date, statement_balance_paisa, balance_remaining_paisa,
      minimum_payment_paisa, payment_status, file_url, parsing_status, source,
      reconciliation_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    stmtId, card_id, userId, statement_month, cycleStart,
    statement_end, due_date, balancePaisa, balancePaisa,
    minPay, 'unpaid', file_url || null, file_url ? 'pending' : 'none', 'upload',
    'unreconciled', now, now
  ).run();

  await saveIdempotency(db, idempotency_key, userId, 'upload_statement', stmtId);

  return json({ ok: true, action: 'upload_statement', contract_version: CONTRACT_VERSION,
    statement_id: stmtId, card_id, statement_month, due_date,
    parsing_status: file_url ? 'pending' : 'none',
    note: file_url
      ? 'Statement file URL saved. Run reconcile_statement to match transactions.'
      : 'Statement created without file. Add transactions manually.',
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 11: reconcile_statement — match statement entries against ledger
// ═════════════════════════════════════════════════════════════════════════════

async function actionReconcileStatement(db, body, userId) {
  const { card_id, statement_id, entries, idempotency_key } = body;

  if (!card_id || !statement_id) {
    return errResp('reconcile_statement', 'MISSING_FIELDS', 'card_id, statement_id required', 400);
  }

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'reconcile_statement');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);
  const stmt = await db.prepare(
    `SELECT * FROM card_statements WHERE id = ? AND card_id = ? AND user_id = ?`
  ).bind(statement_id, card_id, userId).first();
  if (!stmt) return errResp('reconcile_statement', 'STATEMENT_NOT_FOUND', `Statement ${statement_id} not found`, 404);

  const statementEntries = entries || [];
  const now = new Date().toISOString();

  // Get existing transactions on this card account in the statement period
  const existingTxns = await db.prepare(
    `SELECT id, date, type, amount_paisa, amount, notes, cc_subtype, cc_reconciliation_status
     FROM transactions
     WHERE account_id = ?
       AND date >= ? AND date <= ?
       AND (reversed_by IS NULL AND reversed_at IS NULL)
     ORDER BY date ASC`
  ).bind(card.account_id, stmt.statement_start, stmt.statement_end).all();

  const ledgerTxns   = existingTxns.results || [];
  const matched      = [];
  const unmatched    = [];
  const newTxns      = [];
  const sessionId    = 'recon_' + uuid();

  for (const entry of statementEntries) {
    const entryPaisa = Math.round((entry.amount || 0) * 100);
    const entryDate  = entry.date || '';

    // Find best ledger match: same approximate amount (±5%) AND date within 3 days
    const match = ledgerTxns.find(txn => {
      const txnPaisa = txn.amount_paisa || Math.round((txn.amount || 0) * 100);
      const amountDiff = Math.abs(txnPaisa - entryPaisa) / Math.max(entryPaisa, 1);
      const dateDiff   = Math.abs(daysBetweenDates(txn.date, entryDate));
      return amountDiff <= 0.05 && dateDiff <= 3 && txn.cc_reconciliation_status !== 'reconciled';
    });

    if (match) {
      matched.push({ statement_entry: entry, transaction_id: match.id, confidence: 0.9 });
    } else {
      const isPayment = (entry.type || '').toLowerCase().includes('payment') ||
                        (entry.description || '').toLowerCase().includes('payment');
      unmatched.push({ entry, created_txn: null });

      const newTxnId = 'cctx_' + uuid();
      const txnType  = isPayment ? TX_CC_PAYMENT : TX_CC_SPEND;
      newTxns.push({
        id: newTxnId, entry,
        stmt: db.prepare(
          `INSERT OR IGNORE INTO transactions (id, date, type, amount, amount_paisa, account_id,
            category_id, notes, source_module, source_action, cc_subtype, cc_statement_id,
            cc_reconciliation_status, created_by_user_id, household_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          newTxnId, entryDate, txnType, entryPaisa / 100, entryPaisa, card.account_id,
          'cc_spend', `[RECON] ${entry.description || ''} stmt=${statement_id}`,
          'credit_cards', 'reconcile_statement', isPayment ? 'payment' : 'purchase',
          statement_id, 'reconciled', userId, 'hh_owner', now
        )
      });
    }
  }

  const batchStmts = [];

  // Mark matched transactions as reconciled
  for (const m of matched) {
    batchStmts.push(db.prepare(
      `UPDATE transactions SET cc_reconciliation_status='reconciled', cc_statement_id=? WHERE id=?`
    ).bind(statement_id, m.transaction_id));
    batchStmts.push(db.prepare(
      `INSERT OR IGNORE INTO card_statement_transactions (id, statement_id, transaction_id, card_id, user_id, match_type, match_confidence, matched_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind('cst_' + uuid(), statement_id, m.transaction_id, card_id, userId, 'auto', m.confidence, now));
  }

  // Insert new transactions for unmatched entries
  for (const n of newTxns) {
    batchStmts.push(n.stmt);
    batchStmts.push(db.prepare(
      `INSERT OR IGNORE INTO card_statement_transactions (id, statement_id, transaction_id, card_id, user_id, match_type, match_confidence, matched_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind('cst_' + uuid(), statement_id, n.id, card_id, userId, 'auto_new', 0.5, now));
  }

  // Create reconciliation session record
  batchStmts.push(db.prepare(
    `INSERT INTO card_reconciliation_sessions (id, card_id, user_id, statement_id, status,
      total_statement_txns, matched_count, unmatched_count, new_txns_created, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(sessionId, card_id, userId, statement_id, 'complete',
    statementEntries.length, matched.length, unmatched.length, newTxns.length, now, now));

  // Update statement reconciliation status
  batchStmts.push(db.prepare(
    `UPDATE card_statements SET reconciliation_status='reconciled', parsing_status='complete', updated_at=? WHERE id=?`
  ).bind(now, statement_id));

  if (batchStmts.length > 0) await db.batch(batchStmts);

  await saveIdempotency(db, idempotency_key, userId, 'reconcile_statement', sessionId);

  return json({ ok: true, action: 'reconcile_statement', contract_version: CONTRACT_VERSION,
    session_id: sessionId, statement_id,
    summary: { total_entries: statementEntries.length, matched: matched.length,
               unmatched: unmatched.length, new_transactions_created: newTxns.length },
    matched: matched.map(m => ({ statement_entry: m.statement_entry, transaction_id: m.transaction_id })),
    new_transactions: newTxns.map(n => ({ id: n.id, entry: n.entry })),
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 12: close_card — pre-closure checks + status transitions
// ═════════════════════════════════════════════════════════════════════════════

async function actionCloseCard(db, body, userId) {
  const { card_id, force, notes } = body;
  if (!card_id) return errResp('close_card', 'MISSING_FIELDS', 'card_id required', 400);

  const card = await requireCard(db, card_id, userId);

  if (card.status === 'closed') {
    return errResp('close_card', 'ALREADY_CLOSED', `Card ${card_id} is already closed`, 409);
  }

  // Pre-closure checks
  const warnings = [];
  const outstanding = await computeCardOutstanding(db, card.account_id);
  if (outstanding.paisa > 0) {
    if (!force) {
      return errResp('close_card', 'OUTSTANDING_BALANCE',
        `Cannot close card with outstanding balance of ${outstanding.paisa} paisa. Pay off first or use force=true.`, 400);
    }
    warnings.push({ code: 'FORCED_CLOSE_WITH_BALANCE',
      message: `Card closed with outstanding balance of ${outstanding.paisa} paisa.` });
  }

  const openDisputes = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM card_disputes WHERE card_id = ? AND status IN ('filed', 'under_review')`
  ).bind(card_id).first();
  if (openDisputes?.cnt > 0) {
    warnings.push({ code: 'OPEN_DISPUTES', message: `${openDisputes.cnt} open dispute(s) on this card.` });
  }

  const activeInstallments = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM installment_plans WHERE card_id = ? AND status = 'active'`
  ).bind(card_id).first();
  if (activeInstallments?.cnt > 0) {
    warnings.push({ code: 'ACTIVE_INSTALLMENTS', message: `${activeInstallments.cnt} active installment plan(s) remain.` });
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  await db.prepare(
    `UPDATE credit_cards SET status='closed', closed_date=?, updated_at=?,
      notes = CASE WHEN notes IS NULL THEN ? ELSE notes || ' | ' || ? END
     WHERE id=?`
  ).bind(today, now, notes || 'Card closed', notes || 'Card closed', card_id).run();

  await audit(db.env || db, { action: 'CC_CLOSE', entity: 'credit_card', entity_id: card_id,
    created_by: userId, detail: { card_id, forced: !!force, outstanding_paisa: outstanding.paisa } });

  return json({ ok: true, action: 'close_card', contract_version: CONTRACT_VERSION,
    card_id, previous_status: card.status, new_status: 'closed',
    closed_date: today, warnings, committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 13: convert_to_emi (Appendix A2)
// ═════════════════════════════════════════════════════════════════════════════

async function actionConvertToEmi(db, body, userId) {
  const { card_id, transaction_id, installment_count, processing_fee_paisa,
          apr_pct, bank_reference, start_date, idempotency_key } = body;

  if (!card_id || !transaction_id || !installment_count) {
    return errResp('convert_to_emi', 'MISSING_FIELDS', 'card_id, transaction_id, installment_count required', 400);
  }
  if (installment_count < 2 || installment_count > 60) {
    return errResp('convert_to_emi', 'INVALID_COUNT', 'installment_count must be between 2 and 60', 400);
  }

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'convert_to_emi');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);

  const origTxn = await db.prepare(
    `SELECT id, amount, amount_paisa, date, notes FROM transactions
     WHERE id = ? AND account_id = ? AND type = 'cc_spend'`
  ).bind(transaction_id, card.account_id).first();
  if (!origTxn) {
    return errResp('convert_to_emi', 'TRANSACTION_NOT_FOUND',
      `cc_spend transaction ${transaction_id} not found on card`, 404);
  }

  const existing = await db.prepare(
    `SELECT id FROM installment_plans WHERE original_transaction_id = ? AND status = 'active'`
  ).bind(transaction_id).first();
  if (existing) {
    return errResp('convert_to_emi', 'ALREADY_EMI', `Transaction ${transaction_id} is already on an EMI plan`, 409);
  }

  const totalPaisa = origTxn.amount_paisa || Math.round(origTxn.amount * 100);
  const feesPaisa  = processing_fee_paisa || 0;
  const totalWithFees = totalPaisa + feesPaisa;
  const installmentPaisa = Math.ceil(totalWithFees / installment_count);
  const emiStart  = start_date || new Date().toISOString().slice(0, 10);

  const endDate = addMonths(emiStart, installment_count);
  const nextInstallment = addMonths(emiStart, 1);

  const planId = 'emi_' + uuid();
  const now    = new Date().toISOString();

  await db.batch([
    db.prepare(
      `INSERT INTO installment_plans (id, card_id, user_id, original_transaction_id, total_amount_paisa,
        installment_count, installment_amount_paisa, processing_fee_paisa, apr_pct, start_date, end_date,
        status, bank_reference, next_installment_date, installments_paid, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      planId, card_id, userId, transaction_id, totalPaisa,
      installment_count, installmentPaisa, feesPaisa, apr_pct || 0, emiStart, endDate,
      'active', bank_reference || null, nextInstallment, 0, now, now
    ),
    db.prepare(
      `UPDATE transactions SET cc_subtype='emi_installment', notes = notes || ' [EMI_PLAN:' || ? || ']'
       WHERE id = ?`
    ).bind(planId, transaction_id)
  ]);

  await saveIdempotency(db, idempotency_key, userId, 'convert_to_emi', planId);

  return json({ ok: true, action: 'convert_to_emi', contract_version: CONTRACT_VERSION,
    plan_id: planId, card_id, original_transaction_id: transaction_id,
    total_amount_paisa: totalPaisa, installment_count,
    installment_amount_paisa: installmentPaisa, processing_fee_paisa: feesPaisa,
    start_date: emiStart, end_date: endDate, next_installment_date: nextInstallment,
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 14: record_balance_transfer
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordBalanceTransfer(db, body, userId) {
  const { card_id, amount_paisa, date, from_card_id, processing_fee_paisa,
          bank_reference, notes, idempotency_key } = body;

  if (!card_id || !amount_paisa || !date) {
    return errResp('record_balance_transfer', 'MISSING_FIELDS', 'card_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_balance_transfer', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_balance_transfer');
  if (idem) return idem;

  const card    = await requireCard(db, card_id, userId);
  const feePaisa = processing_fee_paisa || 0;
  const now      = new Date().toISOString();
  const txnId    = 'cctx_' + uuid();
  const marker   = `[CC_BALANCE_TRANSFER] card_id=${card_id}` + (from_card_id ? ` from=${from_card_id}` : '');

  const batchStmts = [
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
        idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, date, TX_CC_SPEND, amount_paisa / 100, amount_paisa, card.account_id,
      'cc_spend', `${marker}${bank_reference ? ' ref=' + bank_reference : ''}${notes ? ' | ' + notes : ''}`,
      'credit_cards', 'record_balance_transfer', 'balance_transfer', 'unreconciled',
      idempotency_key || null, userId, 'hh_owner', now
    )
  ];

  if (feePaisa > 0) {
    const feeTxnId = 'cctx_' + uuid();
    batchStmts.push(db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      feeTxnId, date, TX_EXPENSE, feePaisa / 100, feePaisa, card.account_id,
      'cc_spend', `[CC_FEE] card_id=${card_id} fee_type=balance_transfer_fee`,
      'credit_cards', 'record_balance_transfer', 'fee', userId, 'hh_owner', now
    ));
    batchStmts.push(db.prepare(
      `INSERT OR IGNORE INTO card_fees (id, card_id, user_id, transaction_id, fee_type, amount_paisa, fee_date)
       VALUES (?,?,?,?,?,?,?)`
    ).bind('cf_' + uuid(), card_id, userId, feeTxnId, 'balance_transfer', feePaisa, date));
  }

  await db.batch(batchStmts);
  await saveIdempotency(db, idempotency_key, userId, 'record_balance_transfer', txnId);

  return json({ ok: true, action: 'record_balance_transfer', contract_version: CONTRACT_VERSION,
    transaction_id: txnId, card_id, amount_paisa, processing_fee_paisa: feePaisa,
    ledger: { created: true, marker, type: TX_CC_SPEND, cc_subtype: 'balance_transfer', amount_paisa },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 15: file_dispute (Appendix A14)
// ═════════════════════════════════════════════════════════════════════════════

async function actionFileDispute(db, body, userId) {
  const { card_id, transaction_id, statement_id, dispute_type, amount_paisa,
          filed_date, bank_reference, provisional_credit, provisional_credit_paisa,
          notes, idempotency_key } = body;

  if (!card_id || !amount_paisa || !filed_date) {
    return errResp('file_dispute', 'MISSING_FIELDS', 'card_id, amount_paisa, filed_date required', 400);
  }
  if (amount_paisa <= 0) return errResp('file_dispute', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'file_dispute');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);

  const disputeId = 'disp_' + uuid();
  const now       = new Date().toISOString();
  const provCredit = provisional_credit ? 1 : 0;
  const provPaisa  = provCredit ? (provisional_credit_paisa || amount_paisa) : 0;

  const batchStmts = [
    db.prepare(
      `INSERT INTO card_disputes (id, card_id, user_id, transaction_id, statement_id,
        dispute_type, amount_paisa, filed_date, status, bank_reference,
        provisional_credit_issued, provisional_credit_paisa, provisional_credit_date, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      disputeId, card_id, userId, transaction_id || null, statement_id || null,
      dispute_type || 'unauthorized', amount_paisa, filed_date, 'filed', bank_reference || null,
      provCredit, provPaisa, provCredit ? filed_date : null, notes || null, now, now
    )
  ];

  if (provCredit && provPaisa > 0) {
    const creditTxnId = 'cctx_' + uuid();
    batchStmts.push(db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      creditTxnId, filed_date, TX_INCOME, provPaisa / 100, provPaisa, card.account_id,
      'cc_spend', `[CC_DISPUTE_CREDIT] card_id=${card_id} dispute_id=${disputeId}`,
      'credit_cards', 'file_dispute', 'dispute_credit', userId, 'hh_owner', now
    ));
  }

  if (statement_id) {
    batchStmts.push(db.prepare(
      `UPDATE card_statements SET dispute_status='filed', dispute_amount_paisa=COALESCE(dispute_amount_paisa,0)+?,
        dispute_filed_date=?, dispute_notes=?, updated_at=? WHERE id=? AND card_id=?`
    ).bind(amount_paisa, filed_date, notes || null, now, statement_id, card_id));
  }

  await db.batch(batchStmts);
  await saveIdempotency(db, idempotency_key, userId, 'file_dispute', disputeId);

  return json({ ok: true, action: 'file_dispute', contract_version: CONTRACT_VERSION,
    dispute_id: disputeId, card_id, status: 'filed', amount_paisa,
    provisional_credit_issued: provCredit === 1,
    provisional_credit_paisa: provPaisa,
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 16: resolve_dispute (Appendix A14)
// ═════════════════════════════════════════════════════════════════════════════

async function actionResolveDispute(db, body, userId) {
  const { dispute_id, outcome, resolution_notes, resolution_date, reverse_provisional_credit,
          idempotency_key } = body;

  if (!dispute_id || !outcome) {
    return errResp('resolve_dispute', 'MISSING_FIELDS', 'dispute_id, outcome required', 400);
  }

  const VALID_OUTCOMES = new Set(['resolved_credit', 'resolved_rejected', 'withdrawn', 'under_review']);
  if (!VALID_OUTCOMES.has(outcome)) {
    return errResp('resolve_dispute', 'INVALID_OUTCOME',
      `outcome must be one of: ${[...VALID_OUTCOMES].join(', ')}`, 400);
  }

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'resolve_dispute');
  if (idem) return idem;

  const dispute = await db.prepare(
    `SELECT * FROM card_disputes WHERE id = ? AND user_id = ?`
  ).bind(dispute_id, userId).first();
  if (!dispute) return errResp('resolve_dispute', 'DISPUTE_NOT_FOUND', `Dispute ${dispute_id} not found`, 404);

  const card = await requireCard(db, dispute.card_id, userId);
  const now  = new Date().toISOString();
  const today = now.slice(0, 10);
  const resDate = resolution_date || today;

  const batchStmts = [
    db.prepare(
      `UPDATE card_disputes SET status=?, resolution_outcome=?, resolution_date=?, resolution_notes=?, updated_at=?
       WHERE id=?`
    ).bind(outcome, outcome, resDate, resolution_notes || null, now, dispute_id)
  ];

  if (outcome === 'resolved_rejected' && reverse_provisional_credit && dispute.provisional_credit_issued) {
    const reversalPaisa = dispute.provisional_credit_paisa;
    const revTxnId = 'cctx_' + uuid();
    batchStmts.push(db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      revTxnId, resDate, TX_CC_SPEND, reversalPaisa / 100, reversalPaisa, card.account_id,
      'cc_spend', `[CC_DISPUTE_REVERSAL] dispute=${dispute_id} provisional_credit_reversed`,
      'credit_cards', 'resolve_dispute', 'purchase', userId, 'hh_owner', now
    ));
  }

  if (dispute.statement_id) {
    batchStmts.push(db.prepare(
      `UPDATE card_statements SET dispute_status=?, updated_at=? WHERE id=? AND card_id=?`
    ).bind(outcome, now, dispute.statement_id, dispute.card_id));
  }

  await db.batch(batchStmts);
  await saveIdempotency(db, idempotency_key, userId, 'resolve_dispute', dispute_id);

  return json({ ok: true, action: 'resolve_dispute', contract_version: CONTRACT_VERSION,
    dispute_id, card_id: dispute.card_id, previous_status: dispute.status,
    new_status: outcome, resolution_date: resDate,
    provisional_credit_reversed: (outcome === 'resolved_rejected' && !!reverse_provisional_credit),
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 17: detect_subscriptions (Appendix A6) — pattern-detection cron
// ═════════════════════════════════════════════════════════════════════════════

async function actionDetectSubscriptions(db, body, userId) {
  const { card_id, lookback_days, min_occurrences } = body;
  if (!card_id) return errResp('detect_subscriptions', 'MISSING_FIELDS', 'card_id required', 400);

  const card     = await requireCard(db, card_id, userId);
  const lookback = Math.min(lookback_days || 90, 365);
  const minOccur = Math.max(min_occurrences || 2, 2);
  const cutoff   = new Date(Date.now() - lookback * 86400000).toISOString().slice(0, 10);
  const now      = new Date().toISOString();

  const txns = await db.prepare(
    `SELECT id, date, amount_paisa, amount, notes, merchant
     FROM transactions
     WHERE account_id = ? AND date >= ? AND type = 'cc_spend'
       AND (reversed_by IS NULL AND reversed_at IS NULL)
     ORDER BY date ASC`
  ).bind(card.account_id, cutoff).all();

  const rows = txns.results || [];

  // Group by merchant name (from notes via [CC_SPEND] or merchant field)
  const merchantMap = {};
  for (const txn of rows) {
    const merchantKey = extractMerchant(txn.notes || txn.merchant || '');
    if (!merchantKey) continue;
    const paisa = txn.amount_paisa || Math.round((txn.amount || 0) * 100);
    if (!merchantMap[merchantKey]) merchantMap[merchantKey] = [];
    merchantMap[merchantKey].push({ date: txn.date, paisa });
  }

  const detected = [];
  const insertStmts = [];

  for (const [merchant, charges] of Object.entries(merchantMap)) {
    if (charges.length < minOccur) continue;

    // Check approximate regularity (intervals)
    const dates   = charges.map(c => new Date(c.date).getTime()).sort();
    const intervals = [];
    for (let i = 1; i < dates.length; i++) intervals.push((dates[i] - dates[i - 1]) / 86400000);
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

    let frequency = 'unknown';
    if (avgInterval >= 25 && avgInterval <= 35) frequency = 'monthly';
    else if (avgInterval >= 6 && avgInterval <= 8) frequency = 'weekly';
    else if (avgInterval >= 340 && avgInterval <= 395) frequency = 'yearly';
    else if (avgInterval >= 85 && avgInterval <= 95) frequency = 'quarterly';
    else continue; // not a recognized subscription pattern

    const amounts   = charges.map(c => c.paisa);
    const avgAmount = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    const firstSeen = charges[0].date;
    const lastSeen  = charges[charges.length - 1].date;

    const existingSub = await db.prepare(
      `SELECT id FROM card_subscriptions WHERE card_id=? AND merchant_pattern=? AND user_id=?`
    ).bind(card_id, merchant, userId).first();

    if (!existingSub) {
      const subId = 'csub_' + uuid();
      insertStmts.push(db.prepare(
        `INSERT OR IGNORE INTO card_subscriptions (id, card_id, user_id, merchant_pattern, merchant_name,
          amount_paisa, amount_tolerance_paisa, frequency, first_seen_date, last_seen_date, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(subId, card_id, userId, merchant, merchant, avgAmount, Math.round(avgAmount * 0.15),
        frequency, firstSeen, lastSeen, 'active', now, now));

      detected.push({ id: subId, merchant, frequency, amount_paisa: avgAmount,
        occurrences: charges.length, first_seen: firstSeen, last_seen: lastSeen });
    } else {
      detected.push({ id: existingSub.id, merchant, frequency, amount_paisa: avgAmount,
        occurrences: charges.length, status: 'already_tracked' });
    }
  }

  if (insertStmts.length > 0) await db.batch(insertStmts);

  await emitNotification(db, userId, card_id, 'subscription_detected', 'Subscriptions Detected',
    `${detected.filter(d => !d.status).length} new subscription(s) found on card`, { detected });

  return json({ ok: true, action: 'detect_subscriptions', contract_version: CONTRACT_VERSION,
    card_id, new_subscriptions: detected.filter(d => !d.status).length,
    subscriptions: detected, lookback_days: lookback, committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 18: record_nsf_fee (Appendix A11) — linked to failed auto-pay
// ═════════════════════════════════════════════════════════════════════════════

async function actionRecordNsfFee(db, body, userId) {
  const { card_id, amount_paisa, date, failed_payment_id, notes, idempotency_key } = body;

  if (!card_id || !amount_paisa || !date) {
    return errResp('record_nsf_fee', 'MISSING_FIELDS', 'card_id, amount_paisa, date required', 400);
  }
  if (amount_paisa <= 0) return errResp('record_nsf_fee', 'INVALID_AMOUNT', 'amount_paisa must be positive', 400);

  const idem = await checkAndReturnIdempotency(db, idempotency_key, userId, 'record_nsf_fee');
  if (idem) return idem;

  const card = await requireCard(db, card_id, userId);
  const txnId = 'cctx_' + uuid();
  const now   = new Date().toISOString();
  const marker = `[CC_FEE] card_id=${card_id} fee_type=nsf`;
  const failedNote = failed_payment_id ? ` failed_payment=${failed_payment_id}` : '';

  await db.batch([
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
        notes, source_module, source_action, cc_subtype, cc_reconciliation_status,
        idempotency_key, created_by_user_id, household_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, date, TX_EXPENSE, amount_paisa / 100, amount_paisa, card.account_id,
      'cc_spend', `${marker}${failedNote}${notes ? ' | ' + notes : ''}`,
      'credit_cards', 'record_nsf_fee', 'fee', 'unreconciled',
      idempotency_key || null, userId, 'hh_owner', now
    ),
    db.prepare(
      `INSERT OR IGNORE INTO card_fees (id, card_id, user_id, transaction_id, fee_type, amount_paisa, fee_date, notes)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      'cf_' + uuid(), card_id, userId, txnId, 'nsf', amount_paisa, date,
      failed_payment_id ? `NSF due to failed auto-pay ${failed_payment_id}` : 'NSF fee'
    )
  ]);

  await emitNotification(db, userId, card_id, 'nsf_fee', 'NSF Fee Charged',
    `NSF fee of PKR ${(amount_paisa / 100).toFixed(0)} charged on auto-pay failure`, {});

  await saveIdempotency(db, idempotency_key, userId, 'record_nsf_fee', txnId);

  return json({ ok: true, action: 'record_nsf_fee', contract_version: CONTRACT_VERSION,
    transaction_id: txnId, card_id, fee_type: 'nsf', amount_paisa,
    failed_payment_id: failed_payment_id || null,
    ledger: { created: true, marker, type: TX_EXPENSE, cc_subtype: 'fee', amount_paisa },
    committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION 19: configure_auto_pay (Appendix A3)
// ═════════════════════════════════════════════════════════════════════════════

async function actionConfigureAutoPay(db, body, userId) {
  const { card_id, auto_pay_enabled, auto_pay_amount_type, auto_pay_fixed_amount_paisa,
          auto_pay_account_id, auto_pay_backup_account_id, auto_pay_fallback_to_minimum,
          auto_pay_max_retries } = body;

  if (!card_id) return errResp('configure_auto_pay', 'MISSING_FIELDS', 'card_id required', 400);

  const card = await requireCard(db, card_id, userId);

  if (auto_pay_account_id) {
    const acct = await db.prepare(
      `SELECT id FROM accounts WHERE id=? AND (deleted_at IS NULL OR deleted_at='')`
    ).bind(auto_pay_account_id).first();
    if (!acct) {
      return errResp('configure_auto_pay', 'ACCOUNT_NOT_FOUND',
        `Auto-pay account ${auto_pay_account_id} not found`, 404);
    }
  }

  if (auto_pay_backup_account_id) {
    const backupAcct = await db.prepare(
      `SELECT id FROM accounts WHERE id=? AND (deleted_at IS NULL OR deleted_at='')`
    ).bind(auto_pay_backup_account_id).first();
    if (!backupAcct) {
      return errResp('configure_auto_pay', 'ACCOUNT_NOT_FOUND',
        `Auto-pay backup account ${auto_pay_backup_account_id} not found`, 404);
    }
  }

  if (auto_pay_amount_type && !['minimum', 'full', 'fixed'].includes(auto_pay_amount_type)) {
    return errResp('configure_auto_pay', 'INVALID_TYPE',
      'auto_pay_amount_type must be: minimum | full | fixed', 400);
  }

  if (auto_pay_amount_type === 'fixed' && (!auto_pay_fixed_amount_paisa || auto_pay_fixed_amount_paisa <= 0)) {
    return errResp('configure_auto_pay', 'MISSING_AMOUNT',
      'auto_pay_fixed_amount_paisa required when amount_type=fixed', 400);
  }

  const now = new Date().toISOString();
  const updates = {
    updated_at: now,
    ...(auto_pay_enabled !== undefined && { auto_pay_enabled: auto_pay_enabled ? 1 : 0 }),
    ...(auto_pay_amount_type !== undefined && { auto_pay_amount_type }),
    ...(auto_pay_fixed_amount_paisa !== undefined && { auto_pay_fixed_amount_paisa }),
    ...(auto_pay_account_id !== undefined && { auto_pay_account_id }),
    ...(auto_pay_backup_account_id !== undefined && { auto_pay_backup_account_id }),
    ...(auto_pay_fallback_to_minimum !== undefined && { auto_pay_fallback_to_minimum: auto_pay_fallback_to_minimum ? 1 : 0 }),
    ...(auto_pay_max_retries !== undefined && { auto_pay_max_retries: Math.min(Math.max(auto_pay_max_retries, 1), 5) })
  };

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values     = [...Object.values(updates), card_id];

  await db.prepare(`UPDATE credit_cards SET ${setClauses} WHERE id = ?`).bind(...values).run();

  const updatedCard = await db.prepare(`SELECT auto_pay_enabled, auto_pay_amount_type, auto_pay_account_id,
    auto_pay_fallback_to_minimum, auto_pay_backup_account_id, auto_pay_max_retries
    FROM credit_cards WHERE id = ?`).bind(card_id).first();

  return json({ ok: true, action: 'configure_auto_pay', contract_version: CONTRACT_VERSION,
    card_id, auto_pay: updatedCard, committed: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENT ALLOCATION ENGINE
// Distributes payment across outstanding statements (oldest due first).
// Order: fees → interest → cash_advance → previous_statement → current_cycle
// Returns allocation ledger per statement.
// ═════════════════════════════════════════════════════════════════════════════

function runPaymentAllocation(statements, paymentPaisa, paymentDate) {
  let remaining = paymentPaisa;
  const allocations = [];
  const today = paymentDate || new Date().toISOString().slice(0, 10);

  for (const stmt of statements) {
    if (remaining <= 0) break;

    const stmtBalance = stmt.balance_remaining_paisa != null
      ? stmt.balance_remaining_paisa
      : (stmt.statement_balance_paisa || 0);

    if (stmtBalance <= 0) continue;

    const applied        = Math.min(remaining, stmtBalance);
    remaining           -= applied;
    const newBalance     = stmtBalance - applied;
    const minPay         = stmt.minimum_payment_paisa || 0;
    const isLate         = today > stmt.due_date && newBalance > 0;

    const paymentStatus =
      newBalance === 0                                  ? 'paid_full'    :
      minPay > 0 && (stmtBalance - newBalance) >= minPay ? 'paid_minimum' :
      applied > 0                                       ? 'partial'      :
                                                          'unpaid';

    allocations.push({
      statement_id:         stmt.id,
      due_date:             stmt.due_date,
      applied_paisa:        applied,
      new_balance_paisa:    newBalance,
      payment_status:       paymentStatus,
      late_payment_flagged: isLate ? 1 : 0
    });
  }

  return { allocations, unallocated_paisa: remaining, total_allocated_paisa: paymentPaisa - remaining };
}

// ═════════════════════════════════════════════════════════════════════════════
// INTEREST-FREE DAYS CALCULATION ENGINE
// Returns IFD data for a given transaction date and card config.
// Cash advances have zero IFD (interest accrues from day 1).
// ═════════════════════════════════════════════════════════════════════════════

function calculateIfd(card, txnDate) {
  const ifd          = card.interest_free_days || DEFAULT_IFD;
  const statDay      = card.statement_day || DEFAULT_STATEMENT_DAY;
  const txn          = new Date(txnDate);
  const year         = txn.getUTCFullYear();
  const month        = txn.getUTCMonth();
  const dayOfMonth   = txn.getUTCDate();

  // Cycle end = next statement day after txnDate
  let cycleEndYear  = year;
  let cycleEndMonth = month;
  if (dayOfMonth > statDay) {
    cycleEndMonth++;
    if (cycleEndMonth > 11) { cycleEndMonth = 0; cycleEndYear++; }
  }
  const maxDay     = new Date(Date.UTC(cycleEndYear, cycleEndMonth + 1, 0)).getUTCDate();
  const safeStatDay = Math.min(statDay, maxDay);
  const cycleEnd   = new Date(Date.UTC(cycleEndYear, cycleEndMonth, safeStatDay));
  const dueDate    = new Date(cycleEnd.getTime() + ifd * 86400000);
  const ifdDays    = Math.max(0, Math.ceil((dueDate.getTime() - txn.getTime()) / 86400000));

  return {
    ifd_days:                ifdDays,
    cycle_end_date:          cycleEnd.toISOString().slice(0, 10),
    payment_due_date:        dueDate.toISOString().slice(0, 10),
    zero_interest_if_paid_by: dueDate.toISOString().slice(0, 10),
    interest_free_days_config: ifd
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// REWARD CALCULATION ENGINE
// ═════════════════════════════════════════════════════════════════════════════

function calculateReward(card, amountPaisa) {
  const rewardType = card.reward_type || 'none';
  const rate       = (card.reward_rate_pct || 0) / 100;
  const cap        = card.reward_cap_monthly_paisa;

  if (rewardType === 'none' || rate === 0) {
    return { paisa: 0, points: 0, miles: 0, type: 'none' };
  }

  let rewardPaisa  = Math.floor(amountPaisa * rate);
  let rewardPoints = 0;
  let rewardMiles  = 0;

  if (cap && rewardPaisa > cap) rewardPaisa = cap;

  if (rewardType === 'cashback') {
    rewardPaisa = rewardPaisa;
  } else if (rewardType === 'points') {
    rewardPoints = Math.floor(amountPaisa / 100);
    rewardPaisa  = 0;
  } else if (rewardType === 'miles') {
    rewardMiles  = Math.floor(amountPaisa / 100 * rate * 100) / 100;
    rewardPaisa  = 0;
  }

  return { paisa: rewardPaisa, points: rewardPoints, miles: rewardMiles, type: rewardType };
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS — balance, card lookup, statements
// ═════════════════════════════════════════════════════════════════════════════

async function computeCardOutstanding(db, accountId) {
  const sql = `
    SELECT ROUND(SUM(
      CASE WHEN (reversed_by IS NOT NULL AND TRIM(COALESCE(reversed_by, '')) != '')
                OR (reversed_at IS NOT NULL AND TRIM(COALESCE(reversed_at, '')) != '')
                OR UPPER(COALESCE(notes, '')) LIKE '%[REVERSAL OF %'
                OR UPPER(COALESCE(notes, '')) LIKE '%[REVERSED BY %'
           THEN 0
           ELSE
             CASE
               WHEN account_delta IS NOT NULL AND TRIM(COALESCE(account_delta, '')) != ''
                 THEN ROUND(CAST(account_delta AS REAL), 2)
               WHEN COALESCE(CAST(amount AS REAL), 0) < 0
                 THEN ROUND(COALESCE(CAST(amount AS REAL), 0), 2)
               WHEN LOWER(TRIM(COALESCE(type, ''))) IN ('income', 'salary', 'opening', 'borrow', 'debt_in', 'manual_income', 'salary_income')
                 THEN ROUND(COALESCE(CAST(amount AS REAL), 0), 2)
               WHEN LOWER(TRIM(COALESCE(type, ''))) IN ('expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment', 'debt_payment', 'credit_card', 'international', 'international_purchase')
                 THEN ROUND(-COALESCE(CAST(amount AS REAL), 0), 2)
               ELSE ROUND(-COALESCE(CAST(amount AS REAL), 0), 2)
             END
      END
    ), 2) AS signed_balance_rupees
    FROM transactions
    WHERE account_id = ?
  `;
  const result = await db.prepare(sql).bind(accountId).first();
  const signedRupees = Number(result?.signed_balance_rupees ?? 0);
  // CC is a liability: /accounts returns a negative signed value (debt owed). Convert to positive paisa.
  const outstanding_paisa = Math.round(Math.abs(signedRupees) * 100);
  return { balance: -outstanding_paisa, paisa: outstanding_paisa, pkr: outstanding_paisa / 100 };
}

function isReversalRow(txn) {
  if (!txn) return false;
  if (txn.reversed_by || txn.reversed_at) return true;
  const n = String(txn.notes || '').toUpperCase();
  return n.includes('[REVERSAL OF ') || n.includes('[REVERSED BY ');
}

async function requireCard(db, cardId, userId) {
  const card = await db.prepare(
    `SELECT cc.*, a.kind AS account_kind
     FROM credit_cards cc
     JOIN accounts a ON a.id = cc.account_id
     WHERE cc.id = ? AND cc.user_id = ? AND cc.status != 'deleted'`
  ).bind(cardId, userId).first();

  if (!card) {
    const e = new Error(`Credit card ${cardId} not found or not authorized`);
    e.status = 404; e.code = 'CARD_NOT_FOUND';
    throw e;
  }
  return card;
}

async function getOpenStatement(db, cardId) {
  return db.prepare(
    `SELECT id, statement_month, statement_end, due_date, statement_balance_paisa
     FROM card_statements WHERE card_id = ? AND payment_status IN ('unpaid','partial')
     ORDER BY due_date DESC LIMIT 1`
  ).bind(cardId).first();
}

async function getLatestStatements(db, cardId, limit) {
  const r = await db.prepare(
    `SELECT id, statement_month, statement_start, statement_end, due_date,
            statement_balance_paisa, balance_remaining_paisa, payment_status, parsing_status
     FROM card_statements WHERE card_id = ?
     ORDER BY statement_month DESC LIMIT ?`
  ).bind(cardId, limit).all();
  return r.results || [];
}

function computeDueOffset(statDay, dueDay) {
  if (!statDay || !dueDay) return 21;
  return dueDay > statDay ? dueDay - statDay : 30 - statDay + dueDay;
}

function enrichCard(card, outstanding) {
  const limit = card.credit_limit_paisa || 0;
  const avail  = limit > 0 ? Math.max(0, limit - outstanding.paisa) : null;
  return {
    ...card,
    contract_version:         CONTRACT_VERSION,
    outstanding_paisa:        outstanding.paisa,
    outstanding_pkr:          outstanding.pkr,
    available_credit_paisa:   avail,
    utilization_pct:          limit > 0 ? round1((outstanding.paisa / limit) * 100) : null,
    warnings:                 outstanding.paisa > limit && limit > 0
      ? [{ code: 'CARD_OVER_LIMIT', message: 'Outstanding exceeds credit limit.' }]
      : [],
    last4:                    card.card_number_last4 || null,
    statement_cycle_day:      card.statement_day || null,
    payment_due_offset_days:  computeDueOffset(card.statement_day, card.payment_due_day),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY HELPERS
// Uses idempotency_keys table (schema: key, user_id, endpoint, response_body, expires_at)
// ═════════════════════════════════════════════════════════════════════════════

async function checkAndReturnIdempotency(db, key, userId, endpoint) {
  if (!key) return null;
  try {
    const existing = await db.prepare(
      `SELECT response_body FROM idempotency_keys
       WHERE key = ? AND user_id = ? AND endpoint = ?
         AND expires_at > datetime('now')`
    ).bind(key, userId, endpoint).first();
    if (existing?.response_body) {
      return new Response(existing.response_body, {
        status: 200, headers: { 'Content-Type': 'application/json', 'X-Idempotent-Replay': '1' }
      });
    }
  } catch (_) {}
  return null;
}

async function saveIdempotency(db, key, userId, endpoint, entityId) {
  if (!key) return;
  try {
    await db.prepare(
      `INSERT OR REPLACE INTO idempotency_keys (key, user_id, endpoint, request_body_hash, response_body, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))`
    ).bind(key, userId, endpoint, entityId, JSON.stringify({ ok: true, entity_id: entityId })).run();
  } catch (_) {}
}

// ═════════════════════════════════════════════════════════════════════════════
// NOTIFICATION EMIT (lightweight — logs to notification_log for Session 3 dispatch)
// ═════════════════════════════════════════════════════════════════════════════

async function emitNotification(db, userId, cardId, notificationType, title, body, data) {
  try {
    await db.prepare(
      `INSERT OR IGNORE INTO notification_log (id, user_id, card_id, notification_type, title, body, data, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      'notif_' + uuid(), userId, cardId || null, notificationType,
      title || null, body || null, data ? JSON.stringify(data) : null,
      'pending', new Date().toISOString()
    ).run();
  } catch (_) {}
}

// ═════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB not found');
  return env.DB;
}

function requireUserId(context) {
  const userId = context.data?.user_id;
  if (!userId) {
    const e = new Error('Session required'); e.status = 401;
    throw e;
  }
  return userId;
}

async function readJSON(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch (_) { return {}; }
}

function errResp(action, code, message, status = 400) {
  return json({ ok: false, error: message, code, action, contract_version: CONTRACT_VERSION, committed: false }, status);
}

function safeStr(val, fallback = '') {
  return typeof val === 'string' ? val.trim() : fallback;
}

function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }

function extractMerchant(notes) {
  const stripped = notes.replace(/\[CC_SPEND\]\s*card_id=[^\s|]+\s*[|]?\s*/i, '').trim();
  return stripped.slice(0, 40).trim() || null;
}

function computeCycleStart(statementMonth, statementDay) {
  const [year, month] = statementMonth.split('-').map(Number);
  const prevMonth     = month === 1 ? 12 : month - 1;
  const prevYear      = month === 1 ? year - 1 : year;
  const day           = statementDay || DEFAULT_STATEMENT_DAY;
  return `${String(prevYear).padStart(4,'0')}-${String(prevMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function daysBetweenDates(a, b) {
  if (!a || !b) return 999;
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION 4 ACTIONS: Trip / Benefits / Household
// ═════════════════════════════════════════════════════════════════════════════

async function actionRegisterTrip(db, body, userId) {
  const { card_id, trip_name, destination, departure_date, return_date, budget_paisa, notes } = body;
  if (!departure_date || !return_date) return errResp('register_trip', 'MISSING_FIELDS', 'departure_date and return_date required', 400);
  const id = 'trip_' + uuid();
  await db.prepare(
    `INSERT INTO card_trips (id, card_id, user_id, trip_name, destination, departure_date, return_date, budget_paisa, spent_paisa, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'planned', ?, datetime('now'), datetime('now'))`
  ).bind(id, card_id || null, userId, trip_name || 'Trip', destination || '', departure_date, return_date, budget_paisa || 0, notes || null).run();
  return json({ ok: true, action: 'register_trip', contract_version: CONTRACT_VERSION, trip: { id }, committed: true });
}

async function actionLogBenefitUsage(db, body, userId) {
  const { card_id, benefit_type, amount_paisa, value_paisa, usage_date, date_used, description, notes } = body;
  if (!card_id || !benefit_type) return errResp('log_benefit_usage', 'MISSING_FIELDS', 'card_id and benefit_type required', 400);
  const id = 'ben_' + uuid();
  const amount = amount_paisa || value_paisa || 0;
  const useDate = usage_date || date_used || new Date().toISOString().split('T')[0];
  const desc = description || notes || null;
  await db.prepare(
    `INSERT INTO card_benefit_usage (id, card_id, user_id, benefit_type, amount_paisa, usage_date, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'used', datetime('now'))`
  ).bind(id, card_id, userId, benefit_type, amount, useDate, desc).run();
  return json({ ok: true, action: 'log_benefit_usage', contract_version: CONTRACT_VERSION, usage: { id }, committed: true });
}

async function actionAddHouseholdMember(db, body, userId) {
  const { card_id, member_name, relationship, spending_limit_paisa, credit_limit_paisa, card_number_last4, notes } = body;
  if (!card_id || !member_name) return errResp('add_household_member', 'MISSING_FIELDS', 'card_id and member_name required', 400);
  const id = 'hm_' + uuid();
  const limit = spending_limit_paisa || credit_limit_paisa || 0;
  await db.prepare(
    `INSERT INTO household_members (id, card_id, user_id, member_name, relationship, card_number_last4, spending_limit_paisa, status, added_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', date('now'), ?)`
  ).bind(id, card_id, userId, member_name, relationship || null, card_number_last4 || null, limit, notes || null).run();
  return json({ ok: true, action: 'add_household_member', contract_version: CONTRACT_VERSION, member: { id, member_name }, committed: true });
}

async function actionSettleHousehold(db, body, userId) {
  const { household_member_id, month, owed_amount_paisa, settlement_method, notes } = body;
  if (!household_member_id || !month) return errResp('settle_household', 'MISSING_FIELDS', 'household_member_id and month required', 400);
  const id = 'set_' + uuid();
  try {
    await db.prepare(
      `INSERT INTO household_settlements (id, household_member_id, user_id, month, owed_amount_paisa, settlement_method, notes, settled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(id, household_member_id, userId, month, owed_amount_paisa || 0, settlement_method || 'cash', notes || null).run();
  } catch (e) {
    return errResp('settle_household', 'DB_ERROR', String(e?.message || e), 500);
  }
  return json({ ok: true, action: 'settle_household', contract_version: CONTRACT_VERSION, settlement: { id }, committed: true });
}

async function actionListTrips(db, body, userId) {
  const result = await db.prepare(`SELECT * FROM card_trips WHERE user_id = ? ORDER BY departure_date DESC LIMIT 50`).bind(userId).all();
  return json({ ok: true, action: 'list_trips', contract_version: CONTRACT_VERSION, trips: result.results || [], committed: true });
}

async function actionListBenefits(db, body, userId) {
  const result = await db.prepare(`SELECT * FROM card_benefit_usage WHERE user_id = ? ORDER BY usage_date DESC LIMIT 100`).bind(userId).all();
  return json({ ok: true, action: 'list_benefits', contract_version: CONTRACT_VERSION, benefits: result.results || [], committed: true });
}


async function actionGetCycleInfo(db, body, userId) {
  const { card_id } = body;
  if (!card_id) return errResp('get_cycle_info', 'MISSING_FIELDS', 'card_id required', 400);
  const card = await requireCard(db, card_id, userId);

  const today = new Date();
  const stmtDay = card.statement_day || 12;
  const dueDay = card.payment_due_day || 1;

  // Last statement close date
  let stmtClose = new Date(today.getFullYear(), today.getMonth(), stmtDay);
  if (stmtClose > today) stmtClose.setMonth(stmtClose.getMonth() - 1);

  // Next due date (dueDay of month AFTER statement close)
  const dueDate = new Date(stmtClose.getFullYear(), stmtClose.getMonth() + 1, dueDay);
  const daysToDue = Math.ceil((dueDate - today) / 86400000);

  const stmtCloseStr = stmtClose.toISOString().split('T')[0];

  // PREFER uploaded statement if exists, fallback to ledger calc
  const stmtMonth = stmtCloseStr.slice(0, 7);
  const uploadedStmt = await db.prepare(
    `SELECT statement_balance_paisa, minimum_payment_paisa, due_date FROM card_statements WHERE card_id = ? AND statement_month = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(card.id, stmtMonth).first();

  let statement_balance_paisa;
  let uploadedDueDate = null;
  let uploadedMinPaisa = null;
  if (uploadedStmt) {
    statement_balance_paisa = uploadedStmt.statement_balance_paisa;
    uploadedDueDate = uploadedStmt.due_date;
    uploadedMinPaisa = uploadedStmt.minimum_payment_paisa;
  } else {
    const stmtBalQuery = await db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type IN ('expense','cc_spend','transfer') THEN amount_paisa WHEN type IN ('income','cc_payment') THEN -amount_paisa ELSE 0 END), 0) AS bal
       FROM transactions WHERE account_id = ? AND date <= ?`
    ).bind(card.account_id, stmtCloseStr).first();
    statement_balance_paisa = Math.abs(stmtBalQuery.bal || 0);
  }

  // Payments since statement close
  const paymentsQuery = await db.prepare(
    `SELECT COALESCE(SUM(amount_paisa), 0) AS pay FROM transactions WHERE account_id = ? AND date > ? AND type IN ('income','cc_payment')`
  ).bind(card.account_id, stmtCloseStr).first();
  const payments_since_paisa = paymentsQuery.pay || 0;

  const pay_by_paisa = Math.max(0, statement_balance_paisa - payments_since_paisa);
  const min_due_paisa = uploadedMinPaisa || Math.round(statement_balance_paisa * (card.minimum_payment_pct || 5) / 100);
  const finalDueDate = uploadedDueDate || dueDate.toISOString().split('T')[0];

  return json({
    ok: true, action: 'get_cycle_info', contract_version: CONTRACT_VERSION,
    cycle: {
      statement_close_date: stmtCloseStr,
      due_date: finalDueDate,
      days_to_due: daysToDue,
      statement_balance_paisa,
      payments_since_paisa,
      pay_by_paisa,
      min_due_paisa,
      in_grace_period: daysToDue > 0 && pay_by_paisa > 0
    },
    committed: true
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILIATION V2 ACTIONS: parse / reconcile / import / dispute / view
// ═════════════════════════════════════════════════════════════════════════════

function adjustDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function actionParseStatementPdf(db, body, userId, env) {
  const { statement_id, file_url } = body;
  if (!statement_id) return errResp('parse_statement_pdf', 'MISSING_FIELDS', 'statement_id required', 400);

  const stmt = await db.prepare(
    `SELECT cs.*, cc.account_id FROM card_statements cs
     JOIN credit_cards cc ON cc.id = cs.card_id
     WHERE cs.id = ? AND cs.user_id = ?`
  ).bind(statement_id, userId).first();
  if (!stmt) return errResp('parse_statement_pdf', 'NOT_FOUND', 'Statement not found', 404);

  const url = file_url || stmt.file_url;
  if (!url) return errResp('parse_statement_pdf', 'MISSING_FILE', 'No file_url on statement', 400);

  const existing = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM card_statement_transactions WHERE statement_id = ?`
  ).bind(statement_id).first();
  if (existing.cnt > 0) {
    return json({ ok: true, action: 'parse_statement_pdf', contract_version: CONTRACT_VERSION,
      statement_id, rows_inserted: 0, rows_existing: existing.cnt,
      note: 'Already parsed. Delete existing rows to re-parse.',
      committed: false, writes_performed: false });
  }

  let imageBase64;
  try {
    const fileResp = await fetch(url);
    if (!fileResp.ok) return errResp('parse_statement_pdf', 'FETCH_FAILED', `Could not fetch file: ${fileResp.status}`, 502);
    const buffer = await fileResp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    imageBase64 = btoa(binary);
  } catch (e) {
    return errResp('parse_statement_pdf', 'FETCH_ERROR', `File fetch failed: ${e.message}`, 502);
  }

  const now = new Date().toISOString();
  let parsed;
  try {
    const aiResp = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:application/pdf;base64,${imageBase64}` } },
          { type: 'text', text:
            'Extract all transactions from this Pakistani credit card statement as a JSON array. ' +
            'Return ONLY valid JSON with no explanation. Each item: ' +
            '{"date":"YYYY-MM-DD","description":"string","amount_paisa":integer,"txn_type":"debit|credit"}. ' +
            'amount_paisa is the absolute value in Pakistani paisas (1 PKR = 100 paisas). ' +
            'txn_type is "debit" for purchases/charges, "credit" for payments/refunds.'
          }
        ]
      }]
    });
    const text = aiResp?.response || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      await db.prepare(`UPDATE card_statements SET parsing_status='failed', updated_at=? WHERE id=?`).bind(now, statement_id).run();
      return errResp('parse_statement_pdf', 'AI_PARSE_FAILED', 'AI could not extract transactions', 422);
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    await db.prepare(`UPDATE card_statements SET parsing_status='failed', updated_at=? WHERE id=?`).bind(now, statement_id).run();
    return errResp('parse_statement_pdf', 'AI_ERROR', `AI call failed: ${e.message}`, 502);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    await db.prepare(`UPDATE card_statements SET parsing_status='failed', updated_at=? WHERE id=?`).bind(now, statement_id).run();
    return errResp('parse_statement_pdf', 'NO_TRANSACTIONS', 'AI returned no transactions', 422);
  }

  const inserts = parsed.map(txn => {
    const rowId = 'cst_' + uuid();
    const amtPaisa = Math.abs(parseInt(txn.amount_paisa) || 0);
    return db.prepare(
      `INSERT OR IGNORE INTO card_statement_transactions
       (id, statement_id, card_id, user_id, transaction_date, description, amount_paisa,
        txn_type, raw_text, match_status, extraction_provider, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      rowId, statement_id, stmt.card_id, userId,
      txn.date || null,
      txn.description || '',
      amtPaisa,
      txn.txn_type === 'credit' ? 'credit' : 'debit',
      JSON.stringify(txn),
      'unmatched',
      'llama-3.2-11b-vision-instruct',
      now, now
    );
  });

  await db.batch(inserts);
  await db.prepare(`UPDATE card_statements SET parsing_status='complete', updated_at=? WHERE id=?`).bind(now, statement_id).run();

  return json({ ok: true, action: 'parse_statement_pdf', contract_version: CONTRACT_VERSION,
    statement_id, rows_inserted: inserts.length, rows_existing: 0,
    committed: true, writes_performed: true });
}

async function actionRunReconciliation(db, body, userId) {
  const { statement_id } = body;
  if (!statement_id) return errResp('run_reconciliation', 'MISSING_FIELDS', 'statement_id required', 400);

  const stmt = await db.prepare(
    `SELECT cs.*, cc.account_id FROM card_statements cs
     JOIN credit_cards cc ON cc.id = cs.card_id
     WHERE cs.id = ? AND cs.user_id = ?`
  ).bind(statement_id, userId).first();
  if (!stmt) return errResp('run_reconciliation', 'NOT_FOUND', 'Statement not found', 404);

  const stmtTxns = (await db.prepare(
    `SELECT * FROM card_statement_transactions WHERE statement_id = ? AND match_status = 'unmatched'`
  ).bind(statement_id).all()).results || [];

  if (stmtTxns.length === 0) {
    return json({ ok: true, action: 'run_reconciliation', contract_version: CONTRACT_VERSION,
      statement_id, matched: 0, unmatched: 0, committed: false, writes_performed: false,
      note: 'No unmatched statement transactions. Run parse_statement_pdf first.' });
  }

  const periodStart = stmt.statement_start
    ? adjustDate(stmt.statement_start, -3)
    : adjustDate(stmt.statement_end || new Date().toISOString().split('T')[0], -38);
  const periodEnd = stmt.statement_end
    ? adjustDate(stmt.statement_end, 3)
    : adjustDate(new Date().toISOString().split('T')[0], 3);

  const ledgerTxns = (await db.prepare(
    `SELECT id, date, amount_paisa, type, notes FROM transactions
     WHERE account_id = ? AND date BETWEEN ? AND ?
     AND type IN ('cc_spend','expense','income','cc_payment')`
  ).bind(stmt.account_id, periodStart, periodEnd).all()).results || [];

  const AMOUNT_TOL = 500;
  const DATE_TOL = 3;
  const updates = [];
  const usedLedgerIds = new Set();
  const now = new Date().toISOString();

  for (const stxn of stmtTxns) {
    let best = null;
    for (const ltxn of ledgerTxns) {
      if (usedLedgerIds.has(ltxn.id)) continue;
      const amtDiff = Math.abs((ltxn.amount_paisa || 0) - stxn.amount_paisa);
      const dateDiff = daysBetweenDates(ltxn.date, stxn.transaction_date);
      let confidence = 0, method = null;
      if (amtDiff <= AMOUNT_TOL && dateDiff === 0) {
        confidence = 1.0; method = 'exact';
      } else if (amtDiff <= AMOUNT_TOL && dateDiff <= DATE_TOL) {
        confidence = 0.8; method = 'fuzzy_date';
      } else if (dateDiff <= DATE_TOL && stxn.amount_paisa > 0 && amtDiff <= stxn.amount_paisa * 0.1) {
        confidence = 0.6; method = 'fuzzy_amount';
      }
      if (confidence > 0 && (!best || confidence > best.confidence)) {
        best = { ltxn, confidence, method };
      }
    }
    if (best) {
      usedLedgerIds.add(best.ltxn.id);
      updates.push(db.prepare(
        `UPDATE card_statement_transactions
         SET match_status='matched', matched_ledger_txn_id=?, match_confidence=?, match_method=?, updated_at=?
         WHERE id=?`
      ).bind(best.ltxn.id, best.confidence, best.method, now, stxn.id));
    }
  }

  if (updates.length > 0) await db.batch(updates);

  const counts = (await db.prepare(
    `SELECT match_status, COUNT(*) AS cnt FROM card_statement_transactions WHERE statement_id=? GROUP BY match_status`
  ).bind(statement_id).all()).results || [];

  const summary = {};
  for (const row of counts) summary[row.match_status] = row.cnt;

  return json({ ok: true, action: 'run_reconciliation', contract_version: CONTRACT_VERSION,
    statement_id, matched: updates.length, unmatched: stmtTxns.length - updates.length,
    summary, committed: true, writes_performed: updates.length > 0 });
}

async function actionImportStatementTransaction(db, body, userId) {
  const { statement_txn_id } = body;
  if (!statement_txn_id) return errResp('import_statement_transaction', 'MISSING_FIELDS', 'statement_txn_id required', 400);

  const stxn = await db.prepare(
    `SELECT cst.*, cc.account_id
     FROM card_statement_transactions cst
     JOIN card_statements cs ON cs.id = cst.statement_id
     JOIN credit_cards cc ON cc.id = cs.card_id
     WHERE cst.id = ? AND cst.user_id = ?`
  ).bind(statement_txn_id, userId).first();
  if (!stxn) return errResp('import_statement_transaction', 'NOT_FOUND', 'Statement transaction not found', 404);

  if (stxn.match_status === 'imported') {
    return json({ ok: true, action: 'import_statement_transaction', contract_version: CONTRACT_VERSION,
      statement_txn_id, note: 'Already imported', committed: false, writes_performed: false });
  }

  const now = new Date().toISOString();
  const txnId = 'txn_' + uuid();
  const type = stxn.txn_type === 'credit' ? TX_CC_PAYMENT : TX_CC_SPEND;
  const notes = `[from statement] ${stxn.description}`;

  await db.batch([
    db.prepare(
      `INSERT INTO transactions (id, date, type, amount, amount_paisa, account_id, category_id,
       notes, source_module, source_action, cc_reconciliation_status, created_by_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      txnId, stxn.transaction_date, type,
      stxn.amount_paisa / 100, stxn.amount_paisa,
      stxn.account_id,
      type === TX_CC_PAYMENT ? 'cc_payment' : 'cc_spend',
      notes, 'credit_cards', 'statement_reconciliation',
      'reconciled', userId, now
    ),
    db.prepare(
      `UPDATE card_statement_transactions SET match_status='imported', matched_ledger_txn_id=?, updated_at=? WHERE id=?`
    ).bind(txnId, now, statement_txn_id)
  ]);

  return json({ ok: true, action: 'import_statement_transaction', contract_version: CONTRACT_VERSION,
    statement_txn_id, transaction_id: txnId, committed: true, writes_performed: true });
}

async function actionMarkStatementTxnDisputed(db, body, userId) {
  const { statement_txn_id, reason } = body;
  if (!statement_txn_id) return errResp('mark_statement_txn_disputed', 'MISSING_FIELDS', 'statement_txn_id required', 400);

  const stxn = await db.prepare(
    `SELECT id FROM card_statement_transactions WHERE id = ? AND user_id = ?`
  ).bind(statement_txn_id, userId).first();
  if (!stxn) return errResp('mark_statement_txn_disputed', 'NOT_FOUND', 'Statement transaction not found', 404);

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE card_statement_transactions SET match_status='disputed', updated_at=? WHERE id=?`
  ).bind(now, statement_txn_id).run();

  return json({ ok: true, action: 'mark_statement_txn_disputed', contract_version: CONTRACT_VERSION,
    statement_txn_id, reason: reason || null, committed: true, writes_performed: true });
}

async function actionGetReconciliationView(db, body, userId) {
  const { statement_id } = body;
  if (!statement_id) return errResp('get_reconciliation_view', 'MISSING_FIELDS', 'statement_id required', 400);

  const stmt = await db.prepare(
    `SELECT cs.*, cc.account_id FROM card_statements cs
     JOIN credit_cards cc ON cc.id = cs.card_id
     WHERE cs.id = ? AND cs.user_id = ?`
  ).bind(statement_id, userId).first();
  if (!stmt) return errResp('get_reconciliation_view', 'NOT_FOUND', 'Statement not found', 404);

  const stmtTxns = (await db.prepare(
    `SELECT cst.*, t.date AS ledger_date, t.amount_paisa AS ledger_amount_paisa,
            t.notes AS ledger_notes, t.type AS ledger_type
     FROM card_statement_transactions cst
     LEFT JOIN transactions t ON t.id = cst.matched_ledger_txn_id
     WHERE cst.statement_id = ? ORDER BY cst.transaction_date`
  ).bind(statement_id).all()).results || [];

  const periodStart = stmt.statement_start || '2000-01-01';
  const periodEnd   = stmt.statement_end   || new Date().toISOString().split('T')[0];

  const matchedLedgerIds = stmtTxns
    .filter(s => s.matched_ledger_txn_id)
    .map(s => s.matched_ledger_txn_id);

  let ledgerOnly = [];
  if (matchedLedgerIds.length > 0) {
    const placeholders = matchedLedgerIds.map(() => '?').join(',');
    ledgerOnly = (await db.prepare(
      `SELECT id, date, amount_paisa, type, notes FROM transactions
       WHERE account_id = ? AND date BETWEEN ? AND ?
       AND type IN ('cc_spend','expense') AND id NOT IN (${placeholders})`
    ).bind(stmt.account_id, periodStart, periodEnd, ...matchedLedgerIds).all()).results || [];
  } else {
    ledgerOnly = (await db.prepare(
      `SELECT id, date, amount_paisa, type, notes FROM transactions
       WHERE account_id = ? AND date BETWEEN ? AND ? AND type IN ('cc_spend','expense')`
    ).bind(stmt.account_id, periodStart, periodEnd).all()).results || [];
  }

  const matched      = stmtTxns.filter(s => s.match_status === 'matched' && s.match_confidence >= 1.0);
  const mismatches   = stmtTxns.filter(s => s.match_status === 'matched' && s.match_confidence < 1.0);
  const stmtOnly     = stmtTxns.filter(s => s.match_status === 'unmatched' || s.match_status === 'pending');
  const disputed     = stmtTxns.filter(s => s.match_status === 'disputed');
  const imported     = stmtTxns.filter(s => s.match_status === 'imported');

  const sum = arr => arr.reduce((a, b) => a + (b.amount_paisa || 0), 0);

  return json({ ok: true, action: 'get_reconciliation_view', contract_version: CONTRACT_VERSION,
    statement_id,
    matched,
    mismatches,
    statement_only: [...stmtOnly, ...disputed],
    ledger_only: ledgerOnly,
    imported,
    totals: {
      matched_paisa:       sum(matched),
      mismatches_paisa:    sum(mismatches),
      statement_only_paisa: sum(stmtOnly),
      ledger_only_paisa:   sum(ledgerOnly),
    },
    committed: false, writes_performed: false });
}


async function actionDeleteStatement(db, body, userId) {
  const { statement_id } = body;
  const stmt = await db.prepare('SELECT id FROM card_statements WHERE id = ? AND user_id = ?').bind(statement_id, userId).first();
  await db.prepare('DELETE FROM card_statement_transactions WHERE statement_id = ?').bind(statement_id).run();
  await db.prepare('DELETE FROM card_statements WHERE id = ? AND user_id = ?').bind(statement_id, userId).run();
  return json({ ok: true, action: 'delete_statement', contract_version: CONTRACT_VERSION, deleted_id: statement_id, committed: true });
}
