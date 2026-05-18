/* /api/add/[[path]]
 * Sovereign Finance · Add Orchestrator
 * v1.3.0-add-context-merchant-contract
 *
 * Contract:
 * - Add context provides accounts, categories, merchants, and merchant-match metadata.
 * - Normal Expense / Income / Transfer writes are forwarded to /api/transactions.
 * - /api/transactions remains canonical owner for direct transaction creation.
 * - International preview/commit remains owned by /api/add.
 * - Merchant rules are classification-only and never mutate money.
 * - Account balances in context are computed inline from transactions with reversal-safe rules.
 */

const VERSION = 'v1.3.0-add-context-merchant-contract';

const TRANSACTIONS_CONTRACT_EXPECTED = 'transactions-add-v1';
const TRANSACTIONS_VERSION_EXPECTED = 'v0.7.0-transactions-add-contract-proof';
const MERCHANT_MATCH_ROUTE = '/api/merchants/match';

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

const DIRECT_TYPES = new Set(['expense', 'income', 'transfer']);
const INTERNATIONAL_TYPES = new Set(['international', 'international_purchase']);

export async function onRequestGet(context) {
  try {
    const parts = pathParts(context);

    if (!parts[0] || parts[0] === 'context') {
      return getContext(context);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported GET route'
    }, 404);
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
    const parts = pathParts(context);
    const route = parts[0] || '';
    const body = await readJSON(context.request);

    if (route === 'preview') return preview(context, body);
    if (route === 'dry-run' || route === 'dry_run') return dryRun(context, body);
    if (route === 'commit' || route === 'save') return commit(context, body);

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported POST route'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

/* ─────────────────────────────
 * Context
 * ───────────────────────────── */

async function getContext(context) {
  const db = context.env.DB;

  const [accounts, categories, merchants, intlConfig, addSchema] = await Promise.all([
    loadAccountsWithInlineBalances(db),
    loadCategoriesDirect(db),
    loadMerchantsDirect(db),
    getIntlConfig(db).catch(() => null),
    loadAddSchema(db)
  ]);

  return json({
    ok: true,
    version: VERSION,
    contract_version: 'add-context-v1',
    can_direct_write: accounts.length > 0 && categories.length > 0,
    source_status: {
      accounts: accounts.length ? 'ok' : 'failed',
      categories: categories.length ? 'ok' : 'failed',
      merchants: merchants.length ? 'ok' : 'optional',
      merchant_match: 'available',
      intl_rates: intlConfig ? 'ok' : 'optional',
      transactions_contract: 'expected'
    },
    accounts,
    categories,
    merchants,
    intl_rate_config: intlConfig,
    merchant_match: {
      available: true,
      route: MERCHANT_MATCH_ROUTE,
      method: 'POST',
      classification_only: true,
      money_mutation_allowed: false,
      usage: 'Send merchant/reference/notes text and receive module/category/account/PRA/review suggestions.'
    },
    transactions_contract: {
      canonical_route: '/api/transactions',
      expected_version: TRANSACTIONS_VERSION_EXPECTED,
      expected_contract_version: TRANSACTIONS_CONTRACT_EXPECTED,
      direct_types: Array.from(DIRECT_TYPES),
      dry_run_route: '/api/transactions?dry_run=1',
      commit_route: '/api/transactions',
      reversal_route: '/api/transactions/reverse'
    },
    add_contract: {
      direct_write_owner: '/api/transactions',
      international_owner: '/api/add',
      merchant_suggestions_owner: '/api/merchants/match',
      account_balance_source: 'inline_transactions',
      frontend_should_not_mutate_balances: true
    },
    schema: addSchema
  });
}

async function loadAddSchema(db) {
  const [accountCols, categoryCols, merchantCols, transactionCols] = await Promise.all([
    tableColumns(db, 'accounts'),
    tableColumns(db, 'categories'),
    tableColumns(db, 'merchants'),
    tableColumns(db, 'transactions')
  ]);

  return {
    accounts_columns: Array.from(accountCols),
    categories_columns: Array.from(categoryCols),
    merchants_columns: Array.from(merchantCols),
    transactions_columns: Array.from(transactionCols),
    transactions_supports: {
      merchant: transactionCols.has('merchant'),
      merchant_id: transactionCols.has('merchant_id'),
      idempotency_key: transactionCols.has('idempotency_key'),
      source_module: transactionCols.has('source_module'),
      source_action: transactionCols.has('source_action')
    },
    merchants_supports: {
      aliases: merchantCols.has('aliases'),
      default_category_id: merchantCols.has('default_category_id'),
      default_account_id: merchantCols.has('default_account_id'),
      is_pra_required: merchantCols.has('is_pra_required'),
      learned_count: merchantCols.has('learned_count')
    }
  };
}

async function loadAccountsWithInlineBalances(db) {
  const cols = await tableColumns(db, 'accounts');
  if (!cols.has('id')) return [];

  const wanted = [
    'id',
    'name',
    'type',
    'kind',
    'currency',
    'color',
    'icon',
    'opening_balance',
    'credit_limit',
    'status',
    'display_order',
    'deleted_at',
    'archived_at'
  ].filter(col => cols.has(col));

  const order = cols.has('display_order')
    ? 'display_order, name, id'
    : (cols.has('name') ? 'name, id' : 'id');

  const where = buildActiveAccountWhere(cols);

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${order}`
  ).all();

  const accounts = rows.results || [];
  const out = [];

  for (const account of accounts) {
    const computed = await computeAccountBalance(db, account.id);
    const opening = Number(account.opening_balance || 0);
    const balance = roundMoney(opening + computed.balance);

    out.push({
      id: account.id,
      name: account.name || account.id,
      type: account.type || account.kind || 'asset',
      kind: account.kind || account.type || 'account',
      currency: account.currency || 'PKR',
      color: account.color || null,
      icon: account.icon || '',
      opening_balance: opening,
      credit_limit: account.credit_limit == null ? null : Number(account.credit_limit),
      balance,
      current_balance: balance,
      status: account.status || 'active',
      display_order: account.display_order == null ? 999 : Number(account.display_order),
      balance_source: 'inline_transactions',
      transaction_count: computed.txn_count,
      skipped_inactive_transaction_count: computed.skipped_inactive_count
    });
  }

  return out;
}

function buildActiveAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) {
    clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  }

  if (cols.has('archived_at')) {
    clauses.push("(archived_at IS NULL OR archived_at = '')");
  }

  if (cols.has('status')) {
    clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");
  }

  return clauses.join(' AND ');
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

  const wanted = [
    'id',
    'type',
    'amount',
    'pkr_amount',
    'notes',
    'reversed_by',
    'reversed_at'
  ].filter(col => txCols.has(col));

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE account_id = ?`
  ).bind(accountId).all();

  let balance = 0;
  let txnCount = 0;
  let skippedInactiveCount = 0;

  for (const row of rows.results || []) {
    if (isInactiveForBalance(row)) {
      skippedInactiveCount += 1;
      continue;
    }

    const amount = Number(row.pkr_amount || row.amount || 0);

    balance += signedAmount(row.type, amount);
    txnCount += 1;
  }

  return {
    balance: roundMoney(balance),
    txn_count: txnCount,
    skipped_inactive_count: skippedInactiveCount
  };
}

function isInactiveForBalance(row) {
  if (!row) return false;

  const notes = String(row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function signedAmount(type, amount) {
  const t = normalizeMode(type);
  const n = Math.abs(Number(amount || 0));

  if (['income', 'salary', 'opening', 'borrow', 'debt_in', 'adjustment_positive'].includes(t)) {
    return n;
  }

  if (['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'adjustment_negative'].includes(t)) {
    return -n;
  }

  if (t === 'cc_payment') {
    return -n;
  }

  return -n;
}

async function loadCategoriesDirect(db) {
  const cols = await tableColumns(db, 'categories');
  if (!cols.has('id')) return [];

  const wanted = [
    'id',
    'name',
    'label',
    'type',
    'kind',
    'status',
    'display_order'
  ].filter(col => cols.has(col));

  const order = cols.has('display_order')
    ? 'display_order, name, id'
    : (cols.has('name') ? 'name, id' : 'id');

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM categories
     ORDER BY ${order}`
  ).all();

  return (rows.results || []).map(row => ({
    id: row.id,
    name: row.name || row.label || row.id,
    label: row.label || row.name || row.id,
    type: row.type || row.kind || '',
    kind: row.kind || row.type || '',
    status: row.status || 'active',
    display_order: row.display_order == null ? 999 : Number(row.display_order)
  }));
}

async function loadMerchantsDirect(db) {
  try {
    const cols = await tableColumns(db, 'merchants');
    if (!cols.has('id')) return [];

    const wanted = [
      'id',
      'name',
      'aliases',
      'default_category_id',
      'default_account_id',
      'default_intl_pra',
      'is_pra_required',
      'learned_count',
      'created_at',
      'updated_at'
    ].filter(col => cols.has(col));

    const order = cols.has('learned_count')
      ? 'learned_count DESC, name, id'
      : (cols.has('name') ? 'name, id' : 'id');

    const rows = await db.prepare(
      `SELECT ${wanted.join(', ')}
       FROM merchants
       ORDER BY ${order}
       LIMIT 750`
    ).all();

    return (rows.results || []).map(row => ({
      id: row.id,
      name: row.name || row.id,
      aliases: parseAliases(row.aliases),
      default_category_id: row.default_category_id || null,
      default_account_id: row.default_account_id || null,
      default_intl_pra: booleanBool(row.default_intl_pra),
      is_pra_required: booleanBool(row.is_pra_required ?? row.default_intl_pra),
      learned_count: Number(row.learned_count || 0),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null
    }));
  } catch {
    return [];
  }
}

function parseAliases(value) {
  if (Array.isArray(value)) {
    return value.map(v => cleanText(v, '', 120)).filter(Boolean);
  }

  if (value == null || value === '') return [];

  const raw = String(value).trim();

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parseAliases(parsed);
  } catch {
    /* fall back */
  }

  return raw.split(',').map(v => cleanText(v, '', 120)).filter(Boolean);
}

function booleanBool(value) {
  return value === true ||
    value === 1 ||
    value === '1' ||
    String(value || '').toLowerCase() === 'true';
}

/* ─────────────────────────────
 * Preview / Dry-run / Commit
 * ───────────────────────────── */

async function preview(context, body) {
  const normalized = normalizeAddPayload(body);

  if (isInternationalMode(normalized)) {
    const packagePreview = await buildIntlPreview(context.env.DB, normalized);

    return json({
      ok: true,
      version: VERSION,
      route: 'intl-package',
      package_preview: packagePreview,
      fx_lookup: packagePreview.fx_lookup || null,
      normalized_payload: normalized,
      merchant_match: {
        available: true,
        route: MERCHANT_MATCH_ROUTE,
        classification_only: true
      }
    });
  }

  return json({
    ok: true,
    version: VERSION,
    route: 'transactions',
    normalized_payload: normalized,
    merchant_match: {
      available: true,
      route: MERCHANT_MATCH_ROUTE,
      classification_only: true
    },
    expected_writes: normalized.type === 'transfer'
      ? [{ model: 'transactions', rows: 2 }, { model: 'audit', rows: 0 }]
      : [{ model: 'transactions', rows: 1 }, { model: 'audit', rows: 0 }]
  });
}

async function dryRun(context, body) {
  const normalized = normalizeAddPayload(body);

  if (isInternationalMode(normalized)) {
    const packagePreview = await buildIntlPreview(context.env.DB, normalized);
    const payloadHash = await hashPayload({
      route: 'add.intl.commit',
      normalized_payload: normalized,
      package_preview: compactPackageForHash(packagePreview)
    });

    return json({
      ok: true,
      version: VERSION,
      route: 'intl-package',
      dry_run: true,
      writes_performed: false,
      audit_performed: false,
      payload_hash: payloadHash,
      requires_override: false,
      override_reason: null,
      override_token: null,
      merchant_match: {
        available: true,
        route: MERCHANT_MATCH_ROUTE,
        classification_only: true
      },
      expected_writes: [
        { model: 'intl_package', rows: 1 },
        { model: 'transactions', rows: packagePreview.components.length },
        { model: 'audit', rows: 0 }
      ],
      package_preview: packagePreview,
      normalized_payload: normalized
    });
  }

  return internalPost(context, '/api/transactions?dry_run=1', directTransactionPayload(normalized));
}

async function commit(context, body) {
  const normalized = normalizeAddPayload(body);

  const suppliedHash = cleanText(
    body.dry_run_payload_hash ||
    body.payload_hash ||
    body.hash,
    '',
    300
  );

  if (!suppliedHash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'dry_run_payload_hash required before commit'
    }, 428);
  }

  if (isInternationalMode(normalized)) {
    return commitInternational(context, normalized, suppliedHash);
  }

  const txPayload = {
    ...directTransactionPayload(normalized),
    dry_run_payload_hash: suppliedHash,
    payload_hash: suppliedHash
  };

  if (body.override_token) {
    txPayload.override_token = cleanText(body.override_token, '', 300);
  }

  const result = await internalPost(context, '/api/transactions', txPayload);

  return json({
    ok: true,
    version: VERSION,
    route: 'transactions',
    written: normalizeWrittenResult(result),
    merchant_match: {
      available: true,
      route: MERCHANT_MATCH_ROUTE,
      classification_only: true
    },
    ...result
  });
}

function normalizeWrittenResult(result) {
  if (!result || typeof result !== 'object') return {};

  if (Array.isArray(result.ids) && result.ids.length) {
    return {
      transaction_id: result.id || result.ids[0],
      linked_transaction_id: result.linked_id || result.ids[1] || null,
      transaction_ids: result.ids,
      row_count: result.ids.length,
      transfer_model: result.transfer_model || 'linked_pair'
    };
  }

  return {
    transaction_id: result.id || result.transaction_id || null,
    linked_transaction_id: result.linked_id || null,
    transaction_ids: result.ids || (result.id ? [result.id] : []),
    row_count: result.ids ? result.ids.length : (result.id ? 1 : 0)
  };
}

/* ─────────────────────────────
 * Payload
 * ───────────────────────────── */

function normalizeAddPayload(body) {
  const uiMode = cleanText(body.ui_mode || body.mode || body.type, 'expense', 60);
  const type = normalizeMode(cleanText(body.mode || body.type || uiMode, 'expense', 60));

  return {
    ui_mode: uiMode,
    type,
    date: normalizeDate(body.date),
    amount: roundMoney(body.amount),
    account_id: cleanText(body.account_id || body.from_account_id, '', 120),
    transfer_to_account_id: cleanText(
      body.transfer_to_account_id ||
      body.to_account_id ||
      body.destination_account_id,
      '',
      120
    ),
    category_id: canonicalCategory(body.category_id || body.category || ''),
    merchant_id: cleanText(body.merchant_id || body.merchant_rule_id, '', 160),
    merchant: cleanText(body.merchant || body.payee || body.counterparty, '', 160),
    reference: cleanText(body.reference, '', 160),
    notes: cleanText(body.notes || body.description || body.memo, '', 240),
    source_module: cleanText(body.source_module, 'manual', 80) || 'manual',
    source_id: cleanText(body.source_id, '', 160),
    source_action: cleanText(body.source_action, 'manual_create', 80) || 'manual_create',
    idempotency_key: cleanText(body.idempotency_key || body.client_request_id, '', 220),
    created_by: cleanText(body.created_by, 'web-add', 80) || 'web-add',

    subtype: cleanText(body.subtype, 'foreign', 40),
    foreign_amount: roundMoney(body.foreign_amount),
    foreign_currency: cleanText(body.foreign_currency || body.currency || 'USD', 'USD', 10).toUpperCase(),
    fx_rate: Number(body.fx_rate || body.fx_rate_at_commit || 0),
    pkr_amount: roundMoney(body.pkr_amount),
    bank_charge_override: body.bank_charge_override == null ? null : roundMoney(body.bank_charge_override),
    include_pra: body.include_pra === true || body.include_pra === 'true' || body.include_pra === '1'
  };
}

function normalizeMode(value) {
  const raw = cleanText(value, 'expense', 80).toLowerCase();

  if (raw === 'international' || raw === 'international_purchase') return 'international_purchase';
  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';

  if (DIRECT_TYPES.has(raw)) return raw;

  return raw;
}

function isInternationalMode(payload) {
  return INTERNATIONAL_TYPES.has(payload.type) || INTERNATIONAL_TYPES.has(payload.ui_mode);
}

function directTransactionPayload(payload) {
  const out = {
    type: payload.type,
    date: payload.date,
    amount: payload.amount,
    account_id: payload.account_id,
    category_id: payload.type === 'transfer' ? null : payload.category_id,
    merchant_id: payload.merchant_id || null,
    merchant: payload.merchant || null,
    notes: buildDirectNotes(payload),
    source_module: payload.source_module || 'manual',
    source_id: payload.source_id || null,
    source_action: payload.source_action || 'manual_create',
    idempotency_key: payload.idempotency_key || null,
    created_by: payload.created_by || 'web-add'
  };

  if (payload.type === 'transfer') {
    out.transfer_to_account_id = payload.transfer_to_account_id;
  }

  return out;
}

function buildDirectNotes(payload) {
  const parts = [];

  if (payload.merchant) parts.push('merchant=' + payload.merchant);
  if (payload.merchant_id) parts.push('merchant_id=' + payload.merchant_id);
  if (payload.reference) parts.push('ref=' + payload.reference);
  if (payload.notes) parts.push(payload.notes);

  return parts.join(' | ').slice(0, 240);
}

/* ─────────────────────────────
 * International
 * ───────────────────────────── */

async function buildIntlPreview(db, payload) {
  const cfg = await getIntlConfig(db);
  if (!cfg) throw new Error('intl rate config unavailable');

  const subtype = payload.subtype === 'pkr_base' ? 'pkr_base' : 'foreign';

  let basePkr = 0;
  let fxRate = 1;
  let foreignAmount = null;
  let foreignCurrency = payload.foreign_currency || cfg.default_currency || 'USD';

  if (subtype === 'foreign') {
    foreignAmount = payload.foreign_amount;
    fxRate = Number(payload.fx_rate || 0);

    if (!Number.isFinite(foreignAmount) || foreignAmount <= 0) {
      throw new Error('foreign_amount must be greater than zero');
    }

    if (!Number.isFinite(fxRate) || fxRate <= 0) {
      throw new Error('fx_rate required for foreign international purchase');
    }

    basePkr = roundMoney(foreignAmount * fxRate);
  } else {
    basePkr = roundMoney(payload.pkr_amount || payload.amount);

    if (!Number.isFinite(basePkr) || basePkr <= 0) {
      throw new Error('pkr_amount must be greater than zero');
    }

    fxRate = 1;
    foreignCurrency = 'PKR';
  }

  const fxFeePkr = roundMoney(basePkr * pct(cfg.fx_fee_pct));
  const excisePkr = roundMoney(fxFeePkr * pct(cfg.excise_on_fx_fee_pct));
  const advanceTaxPkr = roundMoney(basePkr * pct(cfg.advance_tax_pct));
  const praPkr = payload.include_pra ? roundMoney(basePkr * pct(cfg.pra_pct)) : 0;

  const bankChargePkr = payload.bank_charge_override != null
    ? roundMoney(payload.bank_charge_override)
    : roundMoney(cfg.default_bank_charge || 0);

  const components = [
    component('base', basePkr),
    component('fx_fee', fxFeePkr),
    component('excise', excisePkr),
    component('advance_tax', advanceTaxPkr),
    component('pra', praPkr),
    component('bank_charge', bankChargePkr)
  ].filter(row => row.amount > 0);

  const totalPkr = roundMoney(components.reduce((sum, row) => sum + row.amount, 0));

  return {
    subtype,
    foreign_amount: foreignAmount,
    foreign_currency: foreignCurrency,
    fx_rate: fxRate,
    base_pkr: basePkr,
    fx_fee_pkr: fxFeePkr,
    excise_pkr: excisePkr,
    advance_tax_pkr: advanceTaxPkr,
    pra_pkr: praPkr,
    bank_charge_pkr: bankChargePkr,
    total_pkr: totalPkr,
    include_pra: !!payload.include_pra,
    merchant_id: payload.merchant_id || null,
    merchant: payload.merchant || null,
    components,
    config_snapshot: cfg,
    fx_lookup: payload.fx_rate
      ? {
        source: 'user_override',
        rate: fxRate,
        stale: false
      }
      : null
  };
}

function component(name, amount) {
  return {
    component: name,
    amount: roundMoney(amount)
  };
}

function compactPackageForHash(preview) {
  return {
    subtype: preview.subtype,
    foreign_amount: preview.foreign_amount,
    foreign_currency: preview.foreign_currency,
    fx_rate: preview.fx_rate,
    total_pkr: preview.total_pkr,
    include_pra: preview.include_pra,
    merchant_id: preview.merchant_id,
    merchant: preview.merchant,
    components: preview.components
  };
}

async function commitInternational(context, payload, suppliedHash) {
  const db = context.env.DB;
  const preview = await buildIntlPreview(db, payload);
  const expectedHash = await hashPayload({
    route: 'add.intl.commit',
    normalized_payload: payload,
    package_preview: compactPackageForHash(preview)
  });

  if (suppliedHash !== expectedHash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Payload changed after dry-run. Run dry-run again.',
      supplied_hash: suppliedHash,
      expected_hash: expectedHash
    }, 409);
  }

  const account = await getAccount(db, payload.account_id);
  if (!account) {
    return json({
      ok: false,
      version: VERSION,
      error: 'account not found or inactive'
    }, 409);
  }

  const categoryId = payload.category_id || 'intl_subscription';
  const txCols = await tableColumns(db, 'transactions');
  const packageCols = await tableColumns(db, 'intl_package');

  const packageId = makeId('INTLPKG');
  const now = nowISO();

  const packageRow = filterColumns(packageCols, {
    id: packageId,
    account_id: payload.account_id,
    category_id: categoryId,
    merchant_id: payload.merchant_id || null,
    merchant: payload.merchant,
    reference: payload.reference,
    subtype: preview.subtype,
    foreign_amount: preview.foreign_amount,
    foreign_currency: preview.foreign_currency,
    fx_rate: preview.fx_rate,
    base_pkr: preview.base_pkr,
    fx_fee_pkr: preview.fx_fee_pkr,
    excise_pkr: preview.excise_pkr,
    advance_tax_pkr: preview.advance_tax_pkr,
    pra_pkr: preview.pra_pkr,
    bank_charge_pkr: preview.bank_charge_pkr,
    total_pkr: preview.total_pkr,
    include_pra: preview.include_pra ? 1 : 0,
    status: 'active',
    notes: payload.notes,
    dry_run_payload_hash: suppliedHash,
    created_by: payload.created_by,
    created_at: now
  });

  const txRows = preview.components.map((row, index) => {
    const txId = 'TXN-INTL-' + Date.now() + '-' + String(index).padStart(2, '0') + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const label = intlComponentLabel(row.component);

    return filterColumns(txCols, {
      id: txId,
      date: payload.date,
      type: 'expense',
      amount: row.amount,
      account_id: payload.account_id,
      transfer_to_account_id: null,
      category_id: categoryId,
      merchant_id: payload.merchant_id || null,
      merchant: payload.merchant,
      notes: `[INTL ${label}] ${payload.merchant || 'International'}${payload.notes ? ' | ' + payload.notes : ''}`.slice(0, 240),
      fee_amount: 0,
      pra_amount: 0,
      currency: 'PKR',
      pkr_amount: row.amount,
      fx_rate_at_commit: preview.fx_rate || 1,
      fx_source: preview.subtype === 'foreign' ? 'intl-package' : 'PKR-base',
      intl_package_id: packageId,
      source_module: 'add',
      source_id: packageId,
      source_action: 'international_package',
      idempotency_key: payload.idempotency_key ? payload.idempotency_key + ':intl:' + row.component : null,
      created_by: payload.created_by,
      created_at: now
    });
  });

  const statements = [];

  if (Object.keys(packageRow).length) {
    statements.push(insertStatement(db, 'intl_package', packageRow));
  }

  for (const row of txRows) {
    statements.push(insertStatement(db, 'transactions', row));
  }

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    route: 'intl-package',
    payload_hash: suppliedHash,
    written: {
      intl_package_id: packageId,
      row_count: txRows.length,
      transaction_ids: txRows.map(row => row.id),
      total_pkr: preview.total_pkr
    },
    package_preview: preview
  });
}

function intlComponentLabel(componentName) {
  if (componentName === 'base') return 'BASE';
  if (componentName === 'fx_fee') return 'FX FEE';
  if (componentName === 'excise') return 'EXCISE';
  if (componentName === 'advance_tax') return 'ADVANCE TAX';
  if (componentName === 'pra') return 'PRA';
  if (componentName === 'bank_charge') return 'BANK CHARGE';

  return String(componentName || 'COMPONENT').toUpperCase();
}

/* ─────────────────────────────
 * DB / internal helpers
 * ───────────────────────────── */

async function getIntlConfig(db) {
  const rows = await db.prepare(
    `SELECT *
     FROM intl_rate_config
     ORDER BY id DESC
     LIMIT 1`
  ).all();

  const cfg = (rows.results || [])[0];
  if (!cfg) return null;

  return {
    id: cfg.id,
    fx_fee_pct: Number(cfg.fx_fee_pct || 0),
    excise_on_fx_fee_pct: Number(cfg.excise_on_fx_fee_pct || 0),
    advance_tax_pct: Number(cfg.advance_tax_pct || 0),
    pra_pct: Number(cfg.pra_pct || 0),
    default_bank_charge: Number(cfg.default_bank_charge || 0),
    default_currency: cfg.default_currency || 'USD',
    fx_provider: cfg.fx_provider || null,
    fx_cache_ttl_minutes: Number(cfg.fx_cache_ttl_minutes || 0)
  };
}

async function getAccount(db, id) {
  const cols = await tableColumns(db, 'accounts');
  const where = buildActiveAccountWhere(cols);

  return db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?
     ${where ? 'AND ' + where : ''}
     LIMIT 1`
  ).bind(id).first();
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

function filterColumns(columns, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (columns.has(key)) out[key] = value;
  }

  return out;
}

function insertStatement(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('No insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

async function internalPost(context, path, body) {
  const url = new URL(context.request.url);
  const [pathname, search = ''] = path.split('?');

  url.pathname = pathname;
  url.search = search ? '?' + search : '';

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body || {})
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

/* ─────────────────────────────
 * Utility
 * ───────────────────────────── */

function pathParts(context) {
  const raw = context.params && context.params.path;

  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (!raw) return [];

  return String(raw).split('/').filter(Boolean);
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
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function nowISO() {
  return new Date().toISOString();
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
