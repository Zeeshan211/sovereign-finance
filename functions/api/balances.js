/* /api/balances
 * Sovereign Finance · Canonical Balance Engine
 * v0.5.4-transfer-source-sign-fix
 *
 * Purpose:
 * - Single canonical account-balance source for Accounts/Add.
 * - Fixes transfer source rows not reducing balances.
 * - Counts active transaction rows only.
 * - Skips reversal rows and reversed originals.
 */

const VERSION = 'v0.5.4-transfer-source-sign-fix';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    const [accountCols, txCols] = await Promise.all([
      tableColumns(db, 'accounts'),
      tableColumns(db, 'transactions')
    ]);

    if (!accountCols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        error: 'accounts table missing id column'
      }, 500);
    }

    if (!txCols.has('account_id')) {
      return json({
        ok: false,
        version: VERSION,
        error: 'transactions table missing account_id column'
      }, 500);
    }

    const accounts = await loadAccounts(db, accountCols);
    const balances = await computeBalances(db, txCols);

    const accountMap = {};
    const accountList = [];

    let assetTotal = 0;
    let liabilityTotal = 0;
    let activeCount = 0;

    for (const account of accounts) {
      const id = account.id;
      const computed = balances.get(id) || emptyBalance();

      const balance = roundMoney(computed.balance);
      const kind = account.kind || account.type || classifyAccount(account);

      const row = {
        ...account,
        id,
        name: account.name || id,
        type: account.type || kind || 'asset',
        kind: kind || account.type || 'asset',
        currency: account.currency || 'PKR',
        balance,
        current_balance: balance,
        amount: balance,
        transaction_count: computed.transaction_count,
        included_transaction_count: computed.included_transaction_count,
        skipped_inactive_transaction_count: computed.skipped_inactive_transaction_count,
        balance_source: 'transactions_canonical',
        balance_version: VERSION
      };

      accountMap[id] = row;
      accountList.push(row);

      if (isActiveAccount(account)) {
        activeCount += 1;

        if (classifyAccount(row) === 'liability') {
          liabilityTotal += balance;
        } else {
          assetTotal += balance;
        }
      }
    }

    assetTotal = roundMoney(assetTotal);
    liabilityTotal = roundMoney(liabilityTotal);

    return json({
      ok: true,
      version: VERSION,
      source: 'transactions',
      account_count: accountList.length,
      active_account_count: activeCount,

      accounts: accountMap,
      account_list: accountList,

      totals: {
        assets: assetTotal,
        liabilities: liabilityTotal,
        net_worth: roundMoney(assetTotal + liabilityTotal),
        liquid: assetTotal
      },

      total_assets: assetTotal,
      total_liquid: assetTotal,
      liabilities_total: liabilityTotal,
      net_worth: roundMoney(assetTotal + liabilityTotal),

      rules: {
        income_types_positive: ['income', 'salary', 'opening', 'borrow', 'debt_in'],
        expense_types_negative: ['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment'],
        inactive_filters: [
          'reversed_by',
          'reversed_at',
          '[REVERSAL OF ...]',
          '[REVERSED BY ...]'
        ]
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

async function loadAccounts(db, cols) {
  const wanted = [
    'id',
    'name',
    'type',
    'kind',
    'currency',
    'color',
    'icon',
    'status',
    'display_order',
    'credit_limit',
    'deleted_at',
    'archived_at'
  ].filter(col => cols.has(col));

  const orderBy = cols.has('display_order')
    ? 'display_order, name, id'
    : (cols.has('name') ? 'name, id' : 'id');

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM accounts
     ORDER BY ${orderBy}`
  ).all();

  return (result.results || []).map(row => ({
    id: row.id,
    name: row.name || row.id,
    type: row.type || row.kind || classifyAccount(row),
    kind: row.kind || row.type || classifyAccount(row),
    currency: row.currency || 'PKR',
    color: row.color || null,
    icon: row.icon || '',
    status: row.status || 'active',
    display_order: row.display_order == null ? 999 : Number(row.display_order),
    credit_limit: row.credit_limit == null ? null : Number(row.credit_limit),
    deleted_at: row.deleted_at || null,
    archived_at: row.archived_at || null
  }));
}

async function computeBalances(db, txCols) {
  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'notes',
    'reversed_by',
    'reversed_at',
    'linked_txn_id',
    'intl_package_id'
  ].filter(col => txCols.has(col));

  const orderBy = txCols.has('date')
    ? 'date ASC'
    : (txCols.has('created_at') ? 'datetime(created_at) ASC' : 'rowid ASC');

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     ORDER BY ${orderBy}`
  ).all();

  const map = new Map();

  for (const row of result.results || []) {
    const accountId = row.account_id;
    if (!accountId) continue;

    if (!map.has(accountId)) {
      map.set(accountId, emptyBalance());
    }

    const bucket = map.get(accountId);
    bucket.transaction_count += 1;

    if (isInactiveForBalance(row)) {
      bucket.skipped_inactive_transaction_count += 1;
      bucket.skipped_ids.push(row.id);
      continue;
    }

    const amount = rowAmount(row);
    const signed = signedAmount(row.type, amount);

    bucket.balance = roundMoney(bucket.balance + signed);
    bucket.included_transaction_count += 1;

    bucket.included_ids.push(row.id);
  }

  return map;
}

function emptyBalance() {
  return {
    balance: 0,
    transaction_count: 0,
    included_transaction_count: 0,
    skipped_inactive_transaction_count: 0,
    included_ids: [],
    skipped_ids: []
  };
}

function rowAmount(row) {
  const pkr = Number(row.pkr_amount);
  if (Number.isFinite(pkr) && pkr !== 0) return roundMoney(pkr);

  const amount = Number(row.amount);
  if (Number.isFinite(amount)) return roundMoney(amount);

  return 0;
}

function signedAmount(type, amount) {
  const t = normalizeType(type);

  if ([
    'income',
    'salary',
    'opening',
    'borrow',
    'debt_in'
  ].includes(t)) {
    return roundMoney(amount);
  }

  if ([
    'expense',
    'transfer',
    'cc_spend',
    'repay',
    'atm',
    'debt_out',
    'cc_payment'
  ].includes(t)) {
    return roundMoney(-amount);
  }

  return roundMoney(-amount);
}

function normalizeType(type) {
  const raw = String(type || '').trim().toLowerCase();

  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';
  if (raw === 'international' || raw === 'international_purchase') return 'expense';

  return raw;
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

function classifyAccount(account) {
  const joined = [
    account.kind,
    account.type,
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

function isActiveAccount(account) {
  if (account.deleted_at) return false;
  if (account.archived_at) return false;

  const status = String(account.status || 'active').toLowerCase();

  return !status || status === 'active';
}

async function tableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const set = new Set();

  for (const row of result.results || []) {
    if (row.name) set.add(row.name);
  }

  return set;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache'
    }
  });
}