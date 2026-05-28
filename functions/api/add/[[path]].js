/* /api/add/[[path]]
 * Sovereign Finance · Add Orchestrator
 * v2.0.0-contract-v1
 *
 * Changes from v1.5:
 * - getContext: categories split as { expense[], income[] } by type
 * - dryRun: builds committable_payload, hashes it, stores in transaction_dry_runs
 * - commit: looks up by idempotency_key, validates hash, executes stored payload atomically
 * - International: unchanged (existing buildIntlPreview + commitInternational)
 */

const VERSION = 'v2.0.0-contract-v1';

const CATEGORY_ALIASES = {
  grocery: 'grocery', groceries: 'grocery', food: 'food', food_dining: 'food',
  dining: 'food', transport: 'transport', travel: 'transport', bill: 'bills',
  bills: 'bills', utility: 'bills', utilities: 'bills', bills_utilities: 'bills',
  health: 'health', medical: 'health', fee: 'cat_bank_fees', bank_fee: 'cat_bank_fees',
  bank_fees: 'cat_bank_fees', atm: 'other', atm_fee: 'other', cc: 'cc_spend',
  card: 'cc_spend', credit: 'cc_spend', credit_card: 'cc_spend',
  cc_payment: 'cc_pay', cc_spend: 'cc_spend', debt: 'debt',
  debt_payment: 'debt', salary: 'salary', salary_income: 'salary',
  manual_income: 'salary', transfer: 'cat_transfer',
  misc: 'other', miscellaneous: 'other', other: 'other', general: 'other',
  intl: 'other', international: 'other', international_purchase: 'other',
  intl_subscription: 'other', adjustment: 'cat_adjustment',
};

const DIRECT_TYPES     = new Set(['expense', 'income', 'transfer']);
const INTERNATIONAL_TYPES = new Set(['international', 'international_purchase', 'intl_purchase']);

const INCOME_IDS   = new Set(['salary', 'salary_income', 'manual_income']);
const SYSTEM_IDS   = new Set(['transfer', 'cc_pay', 'debt', 'cat_transfer', 'cat_adjustment', 'cat_uncategorized']);
const EXPENSE_SYSTEM_IDS = new Set(['cat_bank_fees']);

export async function onRequestGet(context) {
  try {
    const parts = pathParts(context);
    if (!parts[0] || parts[0] === 'context') return await getContext(context);
    return json({ ok: false, version: VERSION, error: 'Unsupported GET route' }, 404);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const parts = pathParts(context);
    const route = parts[0] || '';
    const body  = await readJSON(context.request);
    if (route === 'preview')                      return await preview(context, body);
    if (route === 'dry-run' || route === 'dry_run') return await dryRun(context, body);
    if (route === 'commit'  || route === 'save')   return await commit(context, body);
    return json({ ok: false, version: VERSION, error: 'Unsupported POST route' }, 404);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

/* ─────────────────────────
 * Context
 * ───────────────────────── */

async function getContext(context) {
  const db = context.env.DB;
  const [accounts, allCategories, merchants, intlConfig] = await Promise.all([
    loadAccountsWithInlineBalances(db),
    loadCategoriesDirect(db),
    loadMerchantsDirect(db),
    getIntlConfig(db).catch(() => null),
  ]);

  const categories = splitCategoriesByType(allCategories);

  return json({
    ok: true,
    version: VERSION,
    contract_version: 'add-context-v2',
    can_direct_write: accounts.length > 0,
    source_status: {
      accounts:    accounts.length ? 'ok' : 'failed',
      categories:  (categories.expense.length || categories.income.length) ? 'ok' : 'failed',
      merchants:   merchants.length ? 'ok' : 'optional',
      fx_rates:    intlConfig ? 'ok' : 'optional',
    },
    accounts,
    categories,
    merchants,
    intl_rate_config: intlConfig,
    fx_rates: buildFxRates(intlConfig),
    defaults: { typical_ibft_fee_paisa: 5000 },
  });
}

function splitCategoriesByType(all) {
  const expense = [];
  const income  = [];
  for (const cat of all) {
    const t  = (cat.type || '').toLowerCase();
    const id = cat.id || '';
    if (t === 'income' || INCOME_IDS.has(id))       { income.push(cat); continue; }
    if (EXPENSE_SYSTEM_IDS.has(id))                 { expense.push(cat); continue; }
    if (t === 'system' || SYSTEM_IDS.has(id))       continue;
    expense.push(cat);
  }
  const byOrder = (a, b) =>
    (a.display_order - b.display_order) || a.name.localeCompare(b.name);
  return {
    expense: expense.sort(byOrder),
    income:  income.sort(byOrder),
  };
}

function buildFxRates(intlConfig) {
  return { USD: 278.05, EUR: 302.00, GBP: 353.00, AED: 75.75, SAR: 74.15, JPY: 1.85, CNY: 38.40 };
}

async function loadAccountsWithInlineBalances(db) {
  const cols = await tableColumns(db, 'accounts');
  if (!cols.has('id')) return [];
  const wanted = ['id','name','type','kind','currency','color','icon','opening_balance',
    'credit_limit','status','display_order','deleted_at','archived_at'].filter(c => cols.has(c));
  const order  = cols.has('display_order') ? 'display_order, name, id' :
                 cols.has('name') ? 'name, id' : 'id';
  const where  = buildActiveAccountWhere(cols);
  const rows   = await db.prepare(
    `SELECT ${wanted.join(', ')} FROM accounts ${where ? 'WHERE ' + where : ''} ORDER BY ${order}`
  ).all();
  const out = [];
  for (const account of rows.results || []) {
    const computed = await computeAccountBalance(db, account.id);
    const opening  = Number(account.opening_balance || 0);
    const balance  = roundMoney(opening + computed.balance);
    out.push({
      id: account.id, name: account.name || account.id,
      type: account.type || account.kind || 'asset',
      kind: account.kind || account.type || 'account',
      currency: account.currency || 'PKR',
      color: account.color || null, icon: account.icon || '',
      opening_balance: opening,
      credit_limit: account.credit_limit == null ? null : Number(account.credit_limit),
      balance, current_balance: balance,
      status: account.status || 'active',
      display_order: account.display_order == null ? 999 : Number(account.display_order),
      balance_source: 'inline_transactions',
      transaction_count: computed.txn_count,
    });
  }
  return out;
}

function buildActiveAccountWhere(cols) {
  const clauses = [];
  if (cols.has('deleted_at'))  clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status'))      clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");
  return clauses.join(' AND ');
}

async function computeAccountBalance(db, accountId) {
  const txCols = await tableColumns(db, 'transactions');
  if (!txCols.has('account_id')) return { balance: 0, txn_count: 0 };
  const wanted = ['id','type','amount','pkr_amount','notes','reversed_by','reversed_at']
    .filter(c => txCols.has(c));
  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')} FROM transactions WHERE account_id = ?`
  ).bind(accountId).all();
  let balance = 0, txnCount = 0;
  for (const row of rows.results || []) {
    if (isInactiveForBalance(row)) continue;
    const amount = Number(row.pkr_amount || row.amount || 0);
    balance += signedAmount(row.type, amount);
    txnCount++;
  }
  return { balance: roundMoney(balance), txn_count: txnCount };
}

function isInactiveForBalance(row) {
  if (!row) return false;
  const notes = String(row.notes || '').toUpperCase();
  return !!(row.reversed_by || row.reversed_at ||
    notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY '));
}

function signedAmount(type, amount) {
  const t = String(type || '').toLowerCase();
  const n = Math.abs(Number(amount || 0));
  if (['income','salary','opening','borrow','debt_in','adjustment_positive','transfer_in'].includes(t)) return n;
  return -n;
}

async function loadCategoriesDirect(db) {
  const cols = await tableColumns(db, 'categories');
  if (!cols.has('id')) return [];
  const wanted = ['id','name','icon','label','type','kind','status','display_order','color']
    .filter(c => cols.has(c));
  const order  = cols.has('display_order') ? 'display_order, name, id' :
                 cols.has('name') ? 'name, id' : 'id';
  const rows   = await db.prepare(
    `SELECT ${wanted.join(', ')} FROM categories ORDER BY ${order}`
  ).all();
  return (rows.results || []).map(row => ({
    id: row.id,
    name: row.name || row.label || row.id,
    icon: row.icon || null,
    color: row.color || null,
    label: row.label || row.name || row.id,
    type: row.type || row.kind || '',
    kind: row.kind || row.type || '',
    status: row.status || 'active',
    display_order: row.display_order == null ? 999 : Number(row.display_order),
  }));
}

async function loadMerchantsDirect(db) {
  try {
    const cols = await tableColumns(db, 'merchants');
    if (!cols.has('id')) return [];
    const wanted = ['id','name','aliases','default_category_id','default_account_id',
      'is_pra_required','learned_count','created_at','updated_at'].filter(c => cols.has(c));
    const order  = cols.has('learned_count') ? 'learned_count DESC, name, id' :
                   cols.has('name') ? 'name, id' : 'id';
    const rows   = await db.prepare(
      `SELECT ${wanted.join(', ')} FROM merchants ORDER BY ${order} LIMIT 50`
    ).all();
    return (rows.results || []).map(row => ({
      id: row.id, name: row.name || row.id,
      aliases: parseAliases(row.aliases),
      default_category_id: row.default_category_id || null,
      default_account_id:  row.default_account_id  || null,
      is_pra_required: booleanBool(row.is_pra_required),
      learned_count: Number(row.learned_count || 0),
    }));
  } catch { return []; }
}

/* ─────────────────────────
 * Preview (normalize only)
 * ───────────────────────── */

async function preview(context, body) {
  const normalized = normalizeAddPayload(body);
  if (isInternationalMode(normalized)) {
    const pkg = await buildIntlPreview(context.env.DB, normalized);
    return json({ ok: true, version: VERSION, route: 'intl-package', package_preview: pkg, normalized_payload: normalized });
  }
  return json({
    ok: true, version: VERSION, route: 'transactions', normalized_payload: normalized,
    expected_writes: normalized.type === 'transfer'
      ? [{ model: 'transactions', rows: 2 }]
      : [{ model: 'transactions', rows: 1 }],
  });
}

/* ─────────────────────────
 * Dry-run
 * ───────────────────────── */

async function dryRun(context, body) {
  const db = context.env.DB;
  const normalized = normalizeAddPayload(body);

  if (isInternationalMode(normalized)) return dryRunIntl(context, normalized);

  const validationError = validateNormalized(normalized);
  if (validationError) return json({ ok: false, version: VERSION, error: validationError }, 400);

  const accounts   = await loadAccountsWithInlineBalances(db);
  const fromAccount = accounts.find(a => a.id === normalized.account_id);
  const toAccount   = normalized.type === 'transfer'
    ? accounts.find(a => a.id === normalized.transfer_to_account_id) : null;

  const committable = buildCommittablePayload(normalized);
  const payloadHash = await hashPayload(committable);
  const warnings    = computeWarnings(normalized, fromAccount, toAccount);
  const dryPreview  = buildPreview(normalized, fromAccount, toAccount);

  const idempotencyKey = normalized.idempotency_key || makeId('IDEM');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
    await db.prepare(
      `INSERT OR REPLACE INTO transaction_dry_runs
       (id, idempotency_key, payload_hash, committable_payload,
        computed_preview, warnings, committed, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), ?)`
    ).bind(
      makeId('DRY'), idempotencyKey, payloadHash,
      JSON.stringify(committable), JSON.stringify(dryPreview),
      JSON.stringify(warnings), expiresAt
    ).run();
  } catch (_) { /* table not yet migrated — continue without cache */ }

  return json({
    ok: true, version: VERSION, action: 'dry_run',
    payload_hash: payloadHash,
    committable_payload: committable,
    idempotency_key: idempotencyKey,
    expires_at: expiresAt,
    preview: dryPreview,
    warnings,
    requires_override: false,
    override_token: null,
    account_balance_before: fromAccount ? fromAccount.balance : null,
    account_balance_after: dryPreview.from_after,
  });
}

async function dryRunIntl(context, normalized) {
  const db = context.env.DB;
  const packagePreview = await buildIntlPreview(db, normalized);
  const payloadHash = await hashPayload({
    route: 'add.intl.commit',
    normalized_payload: normalized,
    package_preview: compactPackageForHash(packagePreview)
  });
  return json({
    ok: true, version: VERSION, route: 'intl-package', dry_run: true,
    writes_performed: false, payload_hash: payloadHash,
    requires_override: false, override_reason: null, override_token: null,
    package_preview: packagePreview, normalized_payload: normalized,
    expected_writes: [
      { model: 'intl_package', rows: 1 },
      { model: 'transactions', rows: packagePreview.components.length },
    ],
  });
}

function buildCommittablePayload(normalized) {
  const now = nowISO();

  if (normalized.type === 'transfer') {
    const transferId = makeId('TFR');
    const outId = makeId('TXN');
    const inId  = makeId('TXN');
    const feeAmount = roundMoney(normalized.fee_amount || 0);
    const feeBearer = (normalized.fee_bearer || 'source').toLowerCase();

    const outLeg = {
      id: outId, date: normalized.date,
      type: 'transfer', subtype: 'transfer_out',
      amount: normalized.amount,
      account_id: normalized.account_id,
      transfer_to_account_id: normalized.transfer_to_account_id,
      transfer_id: transferId, linked_txn_id: inId,
      category_id: normalized.category_id || 'cat_transfer',
      notes: normalized.notes || null,
      fee_amount: feeBearer === 'source' ? feeAmount : 0,
      fee_bearer: feeBearer,
      merchant: normalized.merchant || null,
      merchant_id: normalized.merchant_id || null,
      source_module: normalized.source_module || 'add',
      source_action: normalized.source_action || 'manual_create',
      idempotency_key: normalized.idempotency_key || null,
      created_by: normalized.created_by || 'web-add',
      created_at: now,
    };
    const inAmount = feeBearer === 'destination'
      ? roundMoney(normalized.amount - feeAmount) : normalized.amount;
    const inLeg = {
      id: inId, date: normalized.date,
      type: 'income', subtype: 'transfer_in',
      amount: inAmount,
      account_id: normalized.transfer_to_account_id,
      transfer_id: transferId, linked_txn_id: outId,
      category_id: normalized.category_id || 'cat_transfer',
      notes: normalized.notes || null,
      fee_amount: feeBearer === 'destination' ? feeAmount : 0,
      fee_bearer: feeBearer,
      merchant: normalized.merchant || null,
      merchant_id: normalized.merchant_id || null,
      source_module: normalized.source_module || 'add',
      source_action: normalized.source_action || 'manual_create',
      created_by: normalized.created_by || 'web-add',
      created_at: now,
    };
    return { _type: 'transfer', transfer_id: transferId, legs: [outLeg, inLeg] };
  }

  // Single-row: expense, income, adjustment, salary, etc.
  let txType = normalized.type;
  if (txType === 'adjustment') {
    txType = normalized.amount >= 0 ? 'adjustment_positive' : 'adjustment_negative';
  }
  const categoryId = normalized.category_id ||
    (txType.startsWith('adjustment') ? 'cat_adjustment' : null);

  const row = {
    id: makeId('TXN'), date: normalized.date,
    type: txType, subtype: normalized.subtype || txType,
    amount: Math.abs(normalized.amount),
    account_id: normalized.account_id,
    category_id: categoryId,
    reason_code: normalized.reason_code || null,
    notes: normalized.notes || null,
    merchant: normalized.merchant || null,
    merchant_id: normalized.merchant_id || null,
    fee_amount: 0,
    pra_amount: normalized.pra_amount || 0,
    source_module: normalized.source_module || 'add',
    source_action: normalized.source_action || 'manual_create',
    idempotency_key: normalized.idempotency_key || null,
    created_by: normalized.created_by || 'web-add',
    created_at: now,
  };
  return { _type: 'single', row };
}

function validateNormalized(normalized) {
  if (!normalized.account_id) return 'account_id is required';
  if (normalized.type !== 'adjustment' && (!normalized.amount || normalized.amount === 0))
    return 'amount must be greater than zero';
  if (normalized.type === 'transfer') {
    if (!normalized.transfer_to_account_id) return 'transfer_to_account_id is required';
    if (normalized.account_id === normalized.transfer_to_account_id)
      return 'Source and destination accounts must be different';
  }
  if (normalized.type === 'adjustment' || normalized.type.startsWith('adjustment_')) {
    if (normalized.notes && normalized.notes.length < 10)
      return 'Adjustment notes must be at least 10 characters';
  }
  return null;
}

function computeWarnings(normalized, fromAccount, toAccount) {
  const warnings = [];
  const amount   = Math.abs(normalized.amount || 0);
  if (fromAccount && normalized.type !== 'income') {
    const fee  = roundMoney(normalized.fee_amount || 0);
    const after = roundMoney(fromAccount.balance - amount - fee);
    if (after < 0)    warnings.push(`${fromAccount.name} balance will go negative after this transaction`);
    else if (after < 1000) warnings.push(`${fromAccount.name} balance will be low (Rs ${after.toFixed(2)})`);
  }
  if (amount > 100000) warnings.push('Large amount — please double-check before confirming');
  const today = new Date().toISOString().slice(0, 10);
  if (normalized.date > today) warnings.push('Date is in the future');
  if (normalized.type === 'transfer' && fromAccount && toAccount) {
    const fromBank = fromAccount.name.split(' ')[0].toLowerCase();
    const toBank   = toAccount.name.split(' ')[0].toLowerCase();
    if (fromBank === toBank)
      warnings.push(`Same-bank transfer (${fromAccount.name.split(' ')[0]}) — IBFT fee is typically Rs 0`);
  }
  return warnings;
}

function buildPreview(normalized, fromAccount, toAccount) {
  const amount     = Math.abs(normalized.amount || 0);
  const feeAmount  = roundMoney(normalized.fee_amount || 0);
  const feeBearer  = (normalized.fee_bearer || 'source').toLowerCase();
  const fromBefore = fromAccount ? roundMoney(fromAccount.balance) : null;
  const fromDeduct = amount + (feeBearer === 'source' ? feeAmount : 0);
  const fromAfter  = fromBefore !== null ? roundMoney(fromBefore - fromDeduct) : null;
  const toBefore   = toAccount ? roundMoney(toAccount.balance) : null;
  const inAmount   = feeBearer === 'destination' ? roundMoney(amount - feeAmount) : amount;
  const toAfter    = toBefore !== null ? roundMoney(toBefore + inAmount) : null;
  const accounts_after = {};
  if (fromAccount) accounts_after[fromAccount.name] = { before: fromBefore, after: fromAfter };
  if (toAccount)   accounts_after[toAccount.name]  = { before: toBefore,   after: toAfter };
  return { from_before: fromBefore, from_after: fromAfter, to_before: toBefore, to_after: toAfter, accounts_after };
}

/* ─────────────────────────
 * Commit
 * ───────────────────────── */

async function commit(context, body) {
  const db = context.env.DB;
  const normalized = normalizeAddPayload(body);

  if (isInternationalMode(normalized)) {
    const suppliedHash = cleanText(body.dry_run_payload_hash || body.payload_hash || body.hash, '', 300);
    if (!suppliedHash) return json({ ok: false, version: VERSION, error: 'dry_run_payload_hash required before commit' }, 428);
    return commitInternational(context, normalized, suppliedHash);
  }

  const suppliedHash    = cleanText(body.payload_hash || body.dry_run_payload_hash || body.hash, '', 300);
  const idempotencyKey  = cleanText(body.idempotency_key || body.client_request_id, '', 220);

  if (!suppliedHash) {
    return json({ ok: false, version: VERSION, error: 'payload_hash required before commit' }, 428);
  }

  // Cache-backed commit (new pattern)
  if (idempotencyKey) {
    try {
      const cached = await db.prepare(
        `SELECT * FROM transaction_dry_runs WHERE idempotency_key = ? LIMIT 1`
      ).bind(idempotencyKey).first();

      if (cached) {
        if (cached.committed) {
          return json({
            ok: true, version: VERSION, action: 'commit',
            already_committed: true,
            committed_transaction_id: cached.committed_transaction_id,
            written: { transaction_id: cached.committed_transaction_id, row_count: 1 },
          });
        }

        if (cached.payload_hash !== suppliedHash) {
          return json({
            ok: false, version: VERSION,
            error: 'Payload changed after dry-run. Please re-preview.',
            code: 'HASH_MISMATCH',
          }, 409);
        }

        const committable = JSON.parse(cached.committable_payload);
        const result = await executeCommittablePayload(db, committable);

        const primaryId = result.transaction_ids[0] || null;
        try {
          await db.prepare(
            `UPDATE transaction_dry_runs SET committed = 1, committed_transaction_id = ? WHERE idempotency_key = ?`
          ).bind(primaryId, idempotencyKey).run();
        } catch (_) {}

        return json({ ok: true, version: VERSION, action: 'commit', committed: true, ...result });
      }
    } catch (_) {
      // transaction_dry_runs table not yet created — fall through to legacy path
    }
  }

  // Legacy fallback: proxy to /api/transactions with hash
  const txPayload = {
    ...directTransactionPayload(normalized),
    dry_run_payload_hash: suppliedHash,
    payload_hash: suppliedHash,
    ...(body.override_token && { override_token: cleanText(body.override_token, '', 300) }),
  };
  const result = await internalPost(context, '/api/transactions', txPayload);
  return json({
    ok: true, version: VERSION, action: 'commit',
    written: normalizeWrittenResult(result), ...result,
  });
}

async function executeCommittablePayload(db, payload) {
  const txCols = await tableColumns(db, 'transactions');

  if (payload._type === 'transfer') {
    const statements = [];
    const txIds = [];
    for (const leg of payload.legs) {
      const row = filterColumns(txCols, leg);
      statements.push(insertStatement(db, 'transactions', row));
      txIds.push(leg.id);
    }
    await db.batch(statements);
    return {
      transaction_ids: txIds,
      transfer_id: payload.transfer_id,
      written: { transaction_id: txIds[0], ids: txIds, row_count: txIds.length },
      proof: { transactions_created: txIds, transfer_id: payload.transfer_id },
    };
  }

  const row = filterColumns(txCols, payload.row);
  await insertStatement(db, 'transactions', row).run();
  return {
    transaction_ids: [payload.row.id],
    transaction_id:  payload.row.id,
    written: { transaction_id: payload.row.id, ids: [payload.row.id], row_count: 1 },
    proof: { transactions_created: [payload.row.id] },
  };
}

/* ─────────────────────────
 * Payload normalisation
 * ───────────────────────── */

function normalizeAddPayload(body) {
  const uiMode = cleanText(body.ui_mode || body.mode || body.type, 'expense', 60);
  const type   = normalizeMode(cleanText(body.mode || body.type || uiMode, 'expense', 60));
  return {
    ui_mode: uiMode, type,
    date: normalizeDate(body.date),
    amount: roundMoney(body.amount),
    account_id: cleanText(body.account_id || body.from_account_id, '', 120),
    transfer_to_account_id: cleanText(
      body.transfer_to_account_id || body.to_account_id || body.destination_account_id, '', 120
    ),
    category_id: cleanText(body.category_id || body.category || '', '', 160),
    merchant_id: cleanText(body.merchant_id || body.merchant_rule_id, '', 160),
    merchant: cleanText(body.merchant || body.payee || body.counterparty, '', 160),
    reference: cleanText(body.reference, '', 160),
    notes: cleanText(body.notes || body.description || body.memo, '', 500),
    source_module: cleanText(body.source_module, 'add', 80) || 'add',
    source_id: cleanText(body.source_id, '', 160),
    source_action: cleanText(body.source_action, 'manual_create', 80) || 'manual_create',
    idempotency_key: cleanText(body.idempotency_key || body.client_request_id, '', 220),
    created_by: cleanText(body.created_by, 'web-add', 80) || 'web-add',
    fee_amount: roundMoney(body.fee_amount || body.fee || 0),
    fee_bearer: cleanText(body.fee_bearer, 'source', 20) || 'source',
    pra_amount: roundMoney(body.pra_amount || 0),
    reason_code: cleanText(body.reason_code, '', 80),
    subtype: cleanText(body.subtype, '', 80),
    foreign_amount: roundMoney(body.foreign_amount),
    foreign_currency: cleanText(body.foreign_currency || body.currency || 'USD', 'USD', 10).toUpperCase(),
    fx_rate: Number(body.fx_rate || body.fx_rate_at_commit || 0),
    pkr_amount: roundMoney(body.pkr_amount),
    bank_charge_override: body.bank_charge_override == null ? null : roundMoney(body.bank_charge_override),
    include_pra: body.include_pra === true || body.include_pra === 'true' || body.include_pra === '1',
  };
}

function normalizeMode(value) {
  const raw = cleanText(value, 'expense', 80).toLowerCase();
  if (INTERNATIONAL_TYPES.has(raw)) return 'international_purchase';
  if (raw === 'manual_income')   return 'income';
  if (raw === 'salary_income')   return 'salary';
  if (raw === 'debt_payment')    return 'repay';
  if (raw === 'credit_card')     return 'cc_spend';
  return raw;
}

function isInternationalMode(payload) {
  return INTERNATIONAL_TYPES.has(payload.type) || INTERNATIONAL_TYPES.has(payload.ui_mode);
}

function directTransactionPayload(payload) {
  const out = {
    type: payload.type, date: payload.date, amount: payload.amount,
    account_id: payload.account_id,
    category_id: payload.type === 'transfer' ? null : payload.category_id,
    merchant_id: payload.merchant_id || null, merchant: payload.merchant || null,
    notes: buildDirectNotes(payload), fee_amount: payload.fee_amount || 0,
    source_module: payload.source_module || 'add',
    source_id: payload.source_id || null,
    source_action: payload.source_action || 'manual_create',
    idempotency_key: payload.idempotency_key || null,
    created_by: payload.created_by || 'web-add',
  };
  if (payload.type === 'transfer') out.transfer_to_account_id = payload.transfer_to_account_id;
  return out;
}

function buildDirectNotes(payload) {
  const parts = [];
  if (payload.merchant)    parts.push('merchant=' + payload.merchant);
  if (payload.merchant_id) parts.push('merchant_id=' + payload.merchant_id);
  if (payload.reference)   parts.push('ref=' + payload.reference);
  if (payload.notes)       parts.push(payload.notes);
  return parts.join(' | ').slice(0, 500);
}

function normalizeWrittenResult(result) {
  if (!result || typeof result !== 'object') return {};
  if (Array.isArray(result.ids) && result.ids.length) {
    return { transaction_id: result.id || result.ids[0], ids: result.ids, row_count: result.ids.length };
  }
  return {
    transaction_id: result.id || result.transaction_id || null,
    ids: result.ids || (result.id ? [result.id] : []),
    row_count: result.ids ? result.ids.length : (result.id ? 1 : 0),
  };
}

/* ─────────────────────────
 * International (unchanged from v1.5)
 * ───────────────────────── */

async function buildIntlPreview(db, payload) {
  const cfg = await getIntlConfig(db);
  if (!cfg) throw new Error('intl rate config unavailable');
  const subtype = payload.subtype === 'pkr_base' ? 'pkr_base' : 'foreign';
  let basePkr = 0, fxRate = 1, foreignAmount = null;
  const foreignCurrency = payload.foreign_currency || cfg.default_currency || 'USD';
  if (subtype === 'foreign') {
    foreignAmount = payload.foreign_amount;
    fxRate = Number(payload.fx_rate || 0);
    if (!Number.isFinite(foreignAmount) || foreignAmount <= 0) throw new Error('foreign_amount must be greater than zero');
    if (!Number.isFinite(fxRate) || fxRate <= 0) throw new Error('fx_rate required for foreign international purchase');
    basePkr = roundMoney(foreignAmount * fxRate);
  } else {
    basePkr = roundMoney(payload.pkr_amount || payload.amount);
    if (!Number.isFinite(basePkr) || basePkr <= 0) throw new Error('pkr_amount must be greater than zero');
  }
  const fxFeePkr      = roundMoney(basePkr * pct(cfg.fx_fee_pct));
  const excisePkr     = roundMoney(fxFeePkr * pct(cfg.excise_on_fx_fee_pct));
  const advanceTaxPkr = roundMoney(basePkr * pct(cfg.advance_tax_pct));
  const praPkr        = payload.include_pra ? roundMoney(basePkr * pct(cfg.pra_pct)) : 0;
  const bankChargePkr = payload.bank_charge_override != null
    ? roundMoney(payload.bank_charge_override) : roundMoney(cfg.default_bank_charge || 0);
  const components = [
    component('base', basePkr), component('fx_fee', fxFeePkr),
    component('excise', excisePkr), component('advance_tax', advanceTaxPkr),
    component('pra', praPkr), component('bank_charge', bankChargePkr),
  ].filter(r => r.amount > 0);
  const totalPkr = roundMoney(components.reduce((s, r) => s + r.amount, 0));
  return {
    subtype, foreign_amount: foreignAmount, foreign_currency: foreignCurrency,
    fx_rate: fxRate, base_pkr: basePkr, fx_fee_pkr: fxFeePkr,
    excise_pkr: excisePkr, advance_tax_pkr: advanceTaxPkr, pra_pkr: praPkr,
    bank_charge_pkr: bankChargePkr, total_pkr: totalPkr,
    include_pra: !!payload.include_pra,
    merchant_id: payload.merchant_id || null, merchant: payload.merchant || null,
    components, config_snapshot: cfg,
    fx_lookup: payload.fx_rate ? { source: 'user_override', rate: fxRate, stale: false } : null,
  };
}

function component(name, amount) { return { component: name, amount: roundMoney(amount) }; }

function compactPackageForHash(preview) {
  return {
    subtype: preview.subtype, foreign_amount: preview.foreign_amount,
    foreign_currency: preview.foreign_currency, fx_rate: preview.fx_rate,
    total_pkr: preview.total_pkr, include_pra: preview.include_pra,
    merchant_id: preview.merchant_id, merchant: preview.merchant,
    components: preview.components,
  };
}

async function commitInternational(context, payload, suppliedHash) {
  const db = context.env.DB;
  const preview = await buildIntlPreview(db, payload);
  const expectedHash = await hashPayload({
    route: 'add.intl.commit', normalized_payload: payload,
    package_preview: compactPackageForHash(preview)
  });
  if (suppliedHash !== expectedHash) {
    return json({
      ok: false, version: VERSION,
      error: 'Payload changed after dry-run. Run dry-run again.',
      supplied_hash: suppliedHash, expected_hash: expectedHash,
    }, 409);
  }
  const account = await getAccount(db, payload.account_id);
  if (!account) return json({ ok: false, version: VERSION, error: 'account not found or inactive' }, 409);

  const categoryId = payload.category_id || 'intl_subscription';
  const txCols     = await tableColumns(db, 'transactions');
  const packageCols = await tableColumns(db, 'intl_package');
  const packageId  = makeId('INTLPKG');
  const now        = nowISO();

  const packageRow = filterColumns(packageCols, {
    id: packageId, account_id: payload.account_id, category_id: categoryId,
    merchant_id: payload.merchant_id || null, merchant: payload.merchant,
    reference: payload.reference, subtype: preview.subtype,
    foreign_amount: preview.foreign_amount, foreign_currency: preview.foreign_currency,
    fx_rate: preview.fx_rate, base_pkr: preview.base_pkr, fx_fee_pkr: preview.fx_fee_pkr,
    excise_pkr: preview.excise_pkr, advance_tax_pkr: preview.advance_tax_pkr,
    pra_pkr: preview.pra_pkr, bank_charge_pkr: preview.bank_charge_pkr,
    total_pkr: preview.total_pkr, include_pra: preview.include_pra ? 1 : 0,
    status: 'active', notes: payload.notes,
    dry_run_payload_hash: suppliedHash, created_by: payload.created_by, created_at: now,
  });

  const txRows = preview.components.map((row, index) => {
    const txId = 'TXN-INTL-' + Date.now() + '-' + String(index).padStart(2, '0') + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const label = intlComponentLabel(row.component);
    return filterColumns(txCols, {
      id: txId, date: payload.date, type: 'expense', amount: row.amount,
      account_id: payload.account_id, transfer_to_account_id: null,
      category_id: categoryId, merchant_id: payload.merchant_id || null,
      merchant: payload.merchant,
      notes: `[INTL ${label}] ${payload.merchant || 'International'}${payload.notes ? ' | ' + payload.notes : ''}`.slice(0, 500),
      fee_amount: 0, pra_amount: 0, currency: 'PKR',
      pkr_amount: row.amount, fx_rate_at_commit: preview.fx_rate || 1,
      foreign_currency: preview.foreign_currency,
      intl_package_id: packageId,
      source_module: 'add', source_id: packageId, source_action: 'international_package',
      idempotency_key: payload.idempotency_key ? payload.idempotency_key + ':intl:' + row.component : null,
      created_by: payload.created_by, created_at: now,
    });
  });

  const statements = [];
  if (Object.keys(packageRow).length) statements.push(insertStatement(db, 'intl_package', packageRow));
  for (const row of txRows) statements.push(insertStatement(db, 'transactions', row));
  await db.batch(statements);

  return json({
    ok: true, version: VERSION, route: 'intl-package', payload_hash: suppliedHash,
    written: {
      intl_package_id: packageId, row_count: txRows.length,
      transaction_ids: txRows.map(r => r.id), total_pkr: preview.total_pkr,
    },
    package_preview: preview,
  });
}

function intlComponentLabel(componentName) {
  const map = { base: 'BASE', fx_fee: 'FX FEE', excise: 'EXCISE',
    advance_tax: 'ADVANCE TAX', pra: 'PRA', bank_charge: 'BANK CHARGE' };
  return map[componentName] || String(componentName || 'COMPONENT').toUpperCase();
}

/* ─────────────────────────
 * DB helpers
 * ───────────────────────── */

async function getIntlConfig(db) {
  const rows = await db.prepare(`SELECT * FROM intl_rate_config ORDER BY id DESC LIMIT 1`).all();
  const cfg  = (rows.results || [])[0];
  if (!cfg) return null;
  return {
    id: cfg.id, fx_fee_pct: Number(cfg.fx_fee_pct || 0),
    excise_on_fx_fee_pct: Number(cfg.excise_on_fx_fee_pct || 0),
    advance_tax_pct: Number(cfg.advance_tax_pct || 0),
    pra_pct: Number(cfg.pra_pct || 0),
    default_bank_charge: Number(cfg.default_bank_charge || 0),
    default_currency: cfg.default_currency || 'USD',
    fx_provider: cfg.fx_provider || null,
    fx_cache_ttl_minutes: Number(cfg.fx_cache_ttl_minutes || 0),
  };
}

async function getAccount(db, id) {
  const cols  = await tableColumns(db, 'accounts');
  const where = buildActiveAccountWhere(cols);
  return db.prepare(
    `SELECT * FROM accounts WHERE id = ? ${where ? 'AND ' + where : ''} LIMIT 1`
  ).bind(id).first();
}

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const set = new Set();
    for (const row of result.results || []) if (row.name) set.add(row.name);
    return set;
  } catch { return new Set(); }
}

function filterColumns(columns, row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) if (columns.has(key)) out[key] = value;
  return out;
}

function insertStatement(db, table, row) {
  const keys = Object.keys(row);
  if (!keys.length) throw new Error('No insertable columns for ' + table);
  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(k => row[k]));
}

async function internalPost(context, path, body) {
  const url = new URL(context.request.url);
  const [pathname, search = ''] = path.split('?');
  url.pathname = pathname;
  url.search = search ? '?' + search : '';
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      accept: 'application/json', 'content-type': 'application/json',
      cookie: context.request.headers.get('cookie') || '',
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok === false) {
    const err = new Error((payload && payload.error) || 'HTTP ' + response.status);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/* ─────────────────────────
 * Utility
 * ───────────────────────── */

function pathParts(context) {
  const raw = context.params && context.params.path;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (!raw) return [];
  return String(raw).split('/').filter(Boolean);
}

async function readJSON(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    },
  });
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return new Date().toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

function canonicalCategory(value) {
  const raw = cleanText(value, '', 160);
  if (!raw) return '';
  const key = token(raw);
  return CATEGORY_ALIASES[key] || raw;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

function cleanText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function token(value) {
  return String(value || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function nowISO() { return new Date().toISOString(); }

async function hashPayload(value) {
  const canonical = JSON.stringify(sortKeys(value));
  const bytes  = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]); return acc;
    }, {});
  }
  return value;
}

function parseAliases(value) {
  if (Array.isArray(value)) return value.map(v => cleanText(v, '', 120)).filter(Boolean);
  if (value == null || value === '') return [];
  const raw = String(value).trim();
  try { const p = JSON.parse(raw); if (Array.isArray(p)) return parseAliases(p); } catch {}
  return raw.split(',').map(v => cleanText(v, '', 120)).filter(Boolean);
}

function booleanBool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}
