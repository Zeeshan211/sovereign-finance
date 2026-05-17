/* /api/atm
 * Sovereign Finance · ATM / Cash Movement Engine
 * v0.1.0-atm-contract
 *
 * Contract:
 * - ATM withdrawal is a bank-to-cash movement.
 * - Source account decreases.
 * - Cash account increases.
 * - ATM fee is a separate expense row and is NOT linked to the transfer pair.
 * - No direct balance mutation.
 * - Accounts remain ledger-derived.
 *
 * Canonical write model:
 *   1. source account transfer row
 *   2. cash account income row
 *   3. optional ATM fee expense row
 */

const VERSION = 'v0.1.0-atm-contract';
const CONTRACT_VERSION = 'atm-v1';

const DEFAULT_CASH_ACCOUNT_ID = 'cash';
const DEFAULT_ATM_CATEGORY_ID = 'atm_fee';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const action = cleanText(url.searchParams.get('action'), 'health', 80).toLowerCase();

    if (action === 'health') {
      return atmHealth(db);
    }

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      route: '/api/atm',
      supported_actions: ['withdrawal', 'health'],
      write_model: {
        withdrawal_rows: 2,
        optional_fee_rows: 1,
        source_account_impact: 'negative',
        cash_account_impact: 'positive',
        fee_account_impact: 'negative',
        fee_is_linked_pair: false
      },
      rules: {
        no_direct_balance_mutation: true,
        accounts_balance_source: 'transactions_canonical',
        transfer_pair_amounts_must_match: true,
        atm_fee_must_not_be_linked_to_withdrawal_pair: true
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const body = await readJSON(context.request);
    const action = cleanText(body.action || 'withdrawal', 'withdrawal', 80).toLowerCase();

    if (!['withdrawal', 'atm_withdrawal', 'create'].includes(action)) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'Unsupported ATM action',
        code: 'UNSUPPORTED_ACTION',
        action
      }, 400);
    }

    return createAtmWithdrawal(db, body);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: err.message || String(err),
      committed: false
    }, 500);
  }
}

async function createAtmWithdrawal(db, body) {
  const amount = moneyNumber(body.amount, null);
  const feeAmount = moneyNumber(body.fee_amount ?? body.fee ?? 0, 0);
  const sourceAccountInput = cleanText(
    body.source_account_id ||
      body.from_account_id ||
      body.account_id,
    '',
    160
  );
  const cashAccountInput = cleanText(
    body.cash_account_id ||
      body.to_account_id ||
      DEFAULT_CASH_ACCOUNT_ID,
    DEFAULT_CASH_ACCOUNT_ID,
    160
  );
  const date = normalizeDate(body.date || body.withdrawal_date) || todayISO();
  const notes = cleanText(body.notes, '', 500);
  const createdBy = cleanText(body.created_by, 'web-atm', 100);
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id, '', 200);

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'amount must be greater than 0',
      code: 'INVALID_AMOUNT',
      committed: false
    }, 400);
  }

  if (feeAmount < 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'fee_amount cannot be negative',
      code: 'INVALID_FEE_AMOUNT',
      committed: false
    }, 400);
  }

  if (!sourceAccountInput) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source account required',
      code: 'SOURCE_ACCOUNT_REQUIRED',
      committed: false
    }, 400);
  }

  const accountCols = await tableColumns(db, 'accounts');
  const txCols = await tableColumns(db, 'transactions');

  if (!accountCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'accounts table missing id column',
      code: 'ACCOUNTS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  if (!txCols.has('id') || !txCols.has('account_id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'transactions table missing required columns',
      code: 'TRANSACTIONS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  const sourceAccount = await resolveAccount(db, accountCols, sourceAccountInput);
  const cashAccount = await resolveAccount(db, accountCols, cashAccountInput);

  if (!sourceAccount.ok) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: sourceAccount.error,
      code: 'SOURCE_ACCOUNT_NOT_FOUND',
      committed: false
    }, sourceAccount.status || 409);
  }

  if (!cashAccount.ok) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: cashAccount.error,
      code: 'CASH_ACCOUNT_NOT_FOUND',
      committed: false
    }, cashAccount.status || 409);
  }

  if (sourceAccount.account.id === cashAccount.account.id) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source account and cash account cannot be same',
      code: 'SAME_SOURCE_AND_CASH_ACCOUNT',
      committed: false
    }, 400);
  }

  const atmId = makeId('atm');
  const outId = makeId('atmout');
  const inId = makeId('atmin');
  const feeId = feeAmount > 0 ? makeId('atmfee') : null;
  const createdAt = nowISO();

  const cleanBaseNotes = notes || 'ATM withdrawal';

  const sourceOutRow = filterToCols(txCols, {
    id: outId,
    date,
    type: 'transfer',
    amount,
    pkr_amount: amount,
    account_id: sourceAccount.account.id,
    transfer_to_account_id: cashAccount.account.id,
    linked_txn_id: inId,
    category_id: null,
    merchant_id: null,
    merchant: 'ATM',
    notes: `[ATM_WITHDRAWAL] atm_id=${atmId} side=source cash_account_id=${cashAccount.account.id} ${cleanBaseNotes} [linked: ${inId}]`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: atmId,
    source_action: 'withdrawal_source',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:source` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const cashInRow = filterToCols(txCols, {
    id: inId,
    date,
    type: 'income',
    amount,
    pkr_amount: amount,
    account_id: cashAccount.account.id,
    transfer_to_account_id: sourceAccount.account.id,
    linked_txn_id: outId,
    category_id: null,
    merchant_id: null,
    merchant: 'ATM',
    notes: `[ATM_WITHDRAWAL] atm_id=${atmId} side=cash source_account_id=${sourceAccount.account.id} ${cleanBaseNotes} [linked: ${outId}]`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: atmId,
    source_action: 'withdrawal_cash',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:cash` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const statements = [
    buildInsert(db, 'transactions', sourceOutRow),
    buildInsert(db, 'transactions', cashInRow)
  ];

  let feeRow = null;

  if (feeAmount > 0) {
    const feeCategoryId = await resolveCategoryId(db, DEFAULT_ATM_CATEGORY_ID);

    feeRow = filterToCols(txCols, {
      id: feeId,
      date,
      type: 'expense',
      amount: feeAmount,
      pkr_amount: feeAmount,
      account_id: sourceAccount.account.id,
      transfer_to_account_id: null,
      linked_txn_id: null,
      category_id: feeCategoryId,
      merchant_id: null,
      merchant: 'ATM',
      notes: `[ATM_FEE] atm_id=${atmId} source_account_id=${sourceAccount.account.id} ${cleanBaseNotes}`.slice(0, 240),
      fee_amount: 0,
      pra_amount: 0,
      currency: 'PKR',
      fx_rate_at_commit: 1,
      fx_source: 'PKR-base',
      source_module: 'atm',
      source_id: atmId,
      source_action: 'withdrawal_fee',
      idempotency_key: idempotencyKey ? `${idempotencyKey}:fee` : null,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: createdAt
    });

    statements.push(buildInsert(db, 'transactions', feeRow));
  }

  try {
    await db.batch(statements);
  } catch (err) {
    if (isForeignKeyError(err)) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'atm_withdrawal',
        error: 'ATM write failed foreign-key guard',
        code: 'FOREIGN_KEY_GUARD',
        committed: false,
        d1_error: err.message || String(err)
      }, 409);
    }

    throw err;
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm_withdrawal',
    committed: true,
    atm_id: atmId,
    transaction_ids: feeRow ? [outId, inId, feeId] : [outId, inId],
    transfer_pair: {
      source_transaction_id: outId,
      cash_transaction_id: inId,
      linked: true,
      amount
    },
    fee_transaction: feeRow
      ? {
        id: feeId,
        amount: feeAmount,
        linked_to_transfer_pair: false
      }
      : null,
    account_impact: {
      balance_source: 'transactions_canonical',
      source_account_id: sourceAccount.account.id,
      source_account_delta: roundMoney(-amount - feeAmount),
      cash_account_id: cashAccount.account.id,
      cash_account_delta: amount
    },
    ledger: {
      rows_created: feeRow ? 3 : 2,
      withdrawal_pair_created: true,
      fee_row_created: !!feeRow,
      fee_row_linked_to_pair: false
    },
    forecast: {
      should_reflect: true,
      source: 'accounts-ledger-derived'
    },
    warnings: []
  });
}

async function atmHealth(db) {
  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm.health',
      error: 'transactions table missing id column'
    }, 500);
  }

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'transfer_to_account_id',
    'linked_txn_id',
    'category_id',
    'notes',
    'reversed_by',
    'reversed_at',
    'source_module',
    'source_id',
    'source_action',
    'created_at'
  ].filter(col => txCols.has(col));

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE notes LIKE '%[ATM_WITHDRAWAL]%'
        OR notes LIKE '%[ATM_FEE]%'
        OR source_module = 'atm'
     ORDER BY ${txCols.has('date') ? 'date DESC,' : ''} ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC
     LIMIT 500`
  ).all();

  const rows = result.results || [];
  const byId = new Map(rows.map(row => [String(row.id), row]));

  const withdrawalRows = rows.filter(row => String(row.notes || '').includes('[ATM_WITHDRAWAL]'));
  const feeRows = rows.filter(row => String(row.notes || '').includes('[ATM_FEE]'));

  const orphanPairs = [];
  const amountMismatches = [];
  const badFeeLinks = [];

  for (const row of withdrawalRows) {
    if (isInactive(row)) continue;

    const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

    if (!linkedId) {
      orphanPairs.push({
        id: row.id,
        error: 'ATM withdrawal row missing linked id'
      });
      continue;
    }

    const linked = byId.get(String(linkedId));

    if (!linked) {
      orphanPairs.push({
        id: row.id,
        linked_id: linkedId,
        error: 'Linked ATM row not found in ATM scan'
      });
      continue;
    }

    const amount = rowAmount(row);
    const linkedAmount = rowAmount(linked);

    if (amount !== linkedAmount) {
      amountMismatches.push({
        id: row.id,
        linked_id: linkedId,
        amount,
        linked_amount: linkedAmount,
        error: 'ATM withdrawal pair amount mismatch'
      });
    }
  }

  for (const row of feeRows) {
    if (row.linked_txn_id || extractLinkedId(row.notes)) {
      badFeeLinks.push({
        id: row.id,
        linked_id: row.linked_txn_id || extractLinkedId(row.notes),
        error: 'ATM fee must not be linked to withdrawal pair'
      });
    }
  }

  const status = orphanPairs.length || amountMismatches.length || badFeeLinks.length
    ? 'fail'
    : 'pass';

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm.health',
    status,
    counts: {
      scanned_rows: rows.length,
      withdrawal_rows: withdrawalRows.length,
      fee_rows: feeRows.length,
      orphan_pairs: orphanPairs.length,
      amount_mismatches: amountMismatches.length,
      bad_fee_links: badFeeLinks.length
    },
    checks: {
      withdrawal_pairs_complete: orphanPairs.length === 0,
      withdrawal_pair_amounts_match: amountMismatches.length === 0,
      fee_rows_not_linked_to_pairs: badFeeLinks.length === 0,
      health_is_read_only: true
    },
    orphan_pairs: orphanPairs,
    amount_mismatches: amountMismatches,
    bad_fee_links: badFeeLinks,
    rules: {
      withdrawal_source_type: 'transfer',
      withdrawal_cash_type: 'income',
      fee_type: 'expense',
      fee_link_policy: 'not_linked_to_withdrawal_pair'
    }
  });
}

async function resolveAccount(db, cols, input) {
  const raw = cleanText(input, '', 160);

  if (!raw) {
    return {
      ok: false,
      status: 400,
      error: 'account id required'
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

  const result = await db.prepare(
    `SELECT *
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${cols.has('display_order') ? 'display_order,' : ''} ${cols.has('name') ? 'name,' : ''} id`
  ).all();

  const wanted = token(raw);

  const matched = (result.results || []).find(account => {
    return token(account.id) === wanted ||
      token(account.name) === wanted ||
      String(account.name || '').trim().toLowerCase() === raw.toLowerCase();
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
    error: 'Account not found or inactive'
  };
}

async function resolveCategoryId(db, preferredId) {
  const cols = await tableColumns(db, 'categories');

  if (!cols.has('id')) return null;

  const exact = await db.prepare(
    `SELECT id FROM categories WHERE id = ? LIMIT 1`
  ).bind(preferredId).first();

  if (exact && exact.id) return exact.id;

  const fallback = await db.prepare(
    `SELECT id
     FROM categories
     WHERE LOWER(id) IN ('atm_fee', 'bank_fee', 'misc')
        OR LOWER(name) LIKE '%atm%'
        OR LOWER(name) LIKE '%fee%'
     ORDER BY id
     LIMIT 1`
  ).first();

  return fallback && fallback.id ? fallback.id : null;
}

function activeAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");

  return clauses.join(' AND ');
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

function rowAmount(row) {
  const pkr = Number(row.pkr_amount);
  if (Number.isFinite(pkr) && pkr !== 0) return roundMoney(Math.abs(pkr));

  const amount = Number(row.amount);
  if (Number.isFinite(amount)) return roundMoney(Math.abs(amount));

  return 0;
}

function isInactive(row) {
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

function moneyNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? roundMoney(n) : fallback;
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
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

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
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
