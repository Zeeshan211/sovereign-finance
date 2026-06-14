/* /api/balances
 * Sovereign Finance · Canonical Balance Engine
 * v0.6.0-balances-contract
 *
 * Contract:
 * - This is the canonical balance summary endpoint.
 * - Account metadata comes from accounts.
 * - Money truth comes from active transactions only.
 * - Reversal rows are excluded.
 * - Reversed originals are excluded.
 * - Frontend must not recalculate authoritative balances.
 */

import { getUserId } from './_lib.js';

const VERSION = 'v0.6.0-balances-contract';
const CONTRACT_VERSION = 'accounts-v1';

const POSITIVE_TYPES = [
  'income',
  'salary',
  'opening',
  'borrow',
  'debt_in',
  'adjustment_positive'
];

const NEGATIVE_TYPES = [
  'expense',
  'transfer',
  'cc_payment',
  'cc_spend',
  'repay',
  'atm',
  'debt_out',
  'adjustment_negative'
];

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    const userId = getUserId(context);
    if (!userId) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'Unauthorized'
      }, 401);
    }

    const [accountCols, txCols] = await Promise.all([
      tableColumns(db, 'accounts'),
      tableColumns(db, 'transactions')
    ]);

    if (!accountCols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'accounts table missing id column'
      }, 500);
    }

    if (!txCols.has('account_id')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'transactions table missing account_id column'
      }, 500);
    }

    const accounts = await loadAccounts(db, accountCols, userId);
    const balanceMap = await computeBalances(db, txCols, userId);

    const accountsById = {};
    const accountList = [];

    let activeAccountCount = 0;
    let archivedAccountCount = 0;

    let assetTotal = 0;
    let liabilitySignedTotal = 0;
    let liabilityOutstandingTotal = 0;
    let liquidTotal = 0;

    let transactionCount = 0;
    let includedTransactionCount = 0;
    let skippedInactiveTransactionCount = 0;

    for (const account of accounts) {
      const id = account.id;
      const computed = balanceMap.get(id) || emptyBalanceBucket();

      const rawBalance = roundMoney(computed.balance);
      const accountClass = classifyAccount(account);
      const active = isActiveAccount(account);

      const outstanding = accountClass === 'liability'
        ? liabilityOutstanding(rawBalance)
        : 0;

      const availableCredit = accountClass === 'liability' && account.credit_limit != null
        ? roundMoney(Number(account.credit_limit || 0) - outstanding)
        : null;

      const utilizationPct = accountClass === 'liability' && Number(account.credit_limit || 0) > 0
        ? roundMoney((outstanding / Number(account.credit_limit || 0)) * 100)
        : null;

      const row = {
        ...account,

        id,
        name: account.name || id,
        type: account.type || accountClass,
        kind: account.kind || account.type || accountClass,
        currency: account.currency || 'PKR',

        balance: rawBalance,
        current_balance: rawBalance,
        amount: rawBalance,

        raw_balance: rawBalance,
        display_balance: accountClass === 'liability' ? outstanding : rawBalance,
        liability_outstanding: outstanding,
        cc_outstanding: accountClass === 'liability' ? outstanding : 0,
        available_credit: availableCredit,
        cc_utilization_pct: utilizationPct,

        transaction_count: computed.transaction_count,
        included_transaction_count: computed.included_transaction_count,
        skipped_inactive_transaction_count: computed.skipped_inactive_transaction_count,

        balance_source: 'transactions_canonical',
        balance_version: VERSION,
        contract_version: CONTRACT_VERSION,

        reversed_rows_excluded: true,
        reversed_originals_excluded: true
      };

      accountsById[id] = row;
      accountList.push(row);

      transactionCount += computed.transaction_count;
      includedTransactionCount += computed.included_transaction_count;
      skippedInactiveTransactionCount += computed.skipped_inactive_transaction_count;

      if (!active) {
        archivedAccountCount += 1;
        continue;
      }

      activeAccountCount += 1;

      if (accountClass === 'liability') {
        liabilitySignedTotal += rawBalance;
        liabilityOutstandingTotal += outstanding;
      } else {
        assetTotal += rawBalance;
        liquidTotal += rawBalance;
      }
    }

    assetTotal = roundMoney(assetTotal);
    liquidTotal = roundMoney(liquidTotal);
    liabilitySignedTotal = roundMoney(liabilitySignedTotal);
    liabilityOutstandingTotal = roundMoney(liabilityOutstandingTotal);

    const netWorth = roundMoney(assetTotal - liabilityOutstandingTotal);
    const trueBurden = roundMoney(liquidTotal - liabilityOutstandingTotal);

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,

      source: 'transactions_canonical',
      balance_source: 'transactions_canonical',
      account_balance_source: 'transactions_canonical',

      account_count: accountList.length,
      active_account_count: activeAccountCount,
      archived_account_count: archivedAccountCount,

      transaction_count: transactionCount,
      included_transaction_count: includedTransactionCount,
      skipped_inactive_transaction_count: skippedInactiveTransactionCount,

      accounts: accountsById,
      account_list: accountList,

      summary: {
        asset_total: assetTotal,
        liquid_total: liquidTotal,
        liability_total: liabilityOutstandingTotal,
        liability_signed_total: liabilitySignedTotal,
        cc_outstanding: liabilityOutstandingTotal,
        net_worth: netWorth,
        true_burden: trueBurden,
        account_count: accountList.length,
        active_account_count: activeAccountCount,
        archived_account_count: archivedAccountCount
      },

      totals: {
        assets: assetTotal,
        liquid: liquidTotal,
        liabilities: liabilitySignedTotal,
        liability_outstanding: liabilityOutstandingTotal,
        cc_outstanding: liabilityOutstandingTotal,
        net_worth: netWorth,
        true_burden: trueBurden
      },

      total_assets: assetTotal,
      total_liquid: liquidTotal,
      total_liquid_assets: liquidTotal,

      liabilities_total: liabilitySignedTotal,
      total_liabilities: liabilitySignedTotal,
      liability_outstanding_total: liabilityOutstandingTotal,

      cc_outstanding: liabilityOutstandingTotal,
      credit_card_outstanding: liabilityOutstandingTotal,

      net_worth: netWorth,
      true_burden: trueBurden,

      rules: {
        positive_types: POSITIVE_TYPES,
        negative_types: NEGATIVE_TYPES,
        inactive_filters: [
          'reversed_by',
          'reversed_at',
          '[REVERSAL OF ...]',
          '[REVERSED BY ...]'
        ],
        reversed_rows_excluded: true,
        reversed_originals_excluded: true,
        account_metadata_source: 'accounts',
        money_truth_source: 'transactions'
      },

      contract: {
        name: 'accounts-v1',
        frontend_authoritative_balance_math_allowed: false,
        accounts_are_metadata: true,
        balances_are_ledger_derived: true,
        forecast_should_read_accounts_or_balances: true
      },

      warnings: []
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

async function loadAccounts(db, cols, userId) {
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
     WHERE user_id = ?
     ORDER BY ${orderBy}`
  ).bind(userId).all();

  return (result.results || []).map(row => {
    const accountClass = classifyAccount(row);

    return {
      id: row.id,
      name: row.name || row.id,
      type: row.type || row.kind || accountClass,
      kind: row.kind || row.type || accountClass,
      currency: row.currency || 'PKR',
      color: row.color || null,
      icon: row.icon || '',
      status: row.status || 'active',
      display_order: row.display_order == null ? 999 : Number(row.display_order),
      credit_limit: row.credit_limit == null ? null : Number(row.credit_limit),
      deleted_at: row.deleted_at || null,
      archived_at: row.archived_at || null
    };
  });
}

async function computeBalances(db, txCols, userId) {
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
    'intl_package_id',
    'created_at'
  ].filter(col => txCols.has(col));

  const orderBy = txCols.has('date')
    ? 'date ASC'
    : (txCols.has('created_at') ? 'datetime(created_at) ASC' : 'rowid ASC');

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE user_id = ?
     ORDER BY ${orderBy}`
  ).bind(userId).all();

  const map = new Map();

  for (const row of result.results || []) {
    const accountId = row.account_id;
    if (!accountId) continue;

    if (!map.has(accountId)) {
      map.set(accountId, emptyBalanceBucket());
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

function emptyBalanceBucket() {
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

  if (Number.isFinite(pkr) && pkr !== 0) {
    return roundMoney(Math.abs(pkr));
  }

  const amount = Number(row.amount);

  if (Number.isFinite(amount)) {
    return roundMoney(Math.abs(amount));
  }

  return 0;
}

function signedAmount(type, amount) {
  const t = normalizeType(type);
  const n = roundMoney(Math.abs(amount));

  if (POSITIVE_TYPES.includes(t)) {
    return n;
  }

  if (NEGATIVE_TYPES.includes(t)) {
    return -n;
  }

  return -n;
}

function normalizeType(type) {
  const raw = String(type || '').trim().toLowerCase();

  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';
  if (raw === 'international' || raw === 'international_purchase') return 'expense';
  if (raw === 'adjustment') return 'adjustment_positive';

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

function liabilityOutstanding(balance) {
  const n = Number(balance);

  if (!Number.isFinite(n)) return 0;

  if (n < 0) return roundMoney(Math.abs(n));

  return 0;
}

function isActiveAccount(account) {
  if (account.deleted_at) return false;
  if (account.archived_at) return false;

  const status = String(account.status || 'active').trim().toLowerCase();

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
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
