/* /api/accounts
 * Sovereign Finance · Accounts API
<<<<<<< HEAD
 * v0.2.10-accounts-source-only-balance
=======
 * v0.2.9-accounts-active-helper-fix
>>>>>>> 66b22ea93c57fcc4fcebd9ed68cfde0645c36552
 *
<<<<<<< HEAD
 * Contract:
 * - GET is read-only.
 * - Account balances are ledger-derived from transactions.
 * - Balances are computed from transaction.account_id only.
 * - Do NOT add transfer_to_account_id as a synthetic positive row.
 * - Reversal rows and reversed originals are excluded from balances.
 *
 * RCA:
 * - v0.2.9 added destination-side transfer aggregation.
 * - In current ledger data, destination movement is already represented in account_id rows.
 * - Adding transfer_to_account_id caused duplicate +transfer amount, e.g. Cash +2000.
=======
 * Contract:
 * - GET is read-only.
 * - Account balances are ledger-derived from transactions.
 * - Source account movement is signed by transaction type.
 * - Transfer destination account is counted as positive when transfer_to_account_id exists.
 * - Reversal rows and reversed originals are excluded from balances.
>>>>>>> 66b22ea93c57fcc4fcebd9ed68cfde0645c36552
 */

<<<<<<< HEAD
const VERSION = 'v0.2.11-accounts-signed-amount-safe';
=======
const VERSION = 'v0.2.9-accounts-active-helper-fix';
>>>>>>> 66b22ea93c57fcc4fcebd9ed68cfde0645c36552

export async function onRequestGet(context) {
  try {
    const db = requireDb(context.env);

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

    const accounts = await loadAccounts(db, accountCols);
    const balanceMap = txCols.has('account_id')
      ? await computeTransactionBalances(db, txCols)
      : new Map();

    const rows = [];
    const byId = {};

    let totalAssets = 0;
    let totalLiabilities = 0;
    let activeCount = 0;

    for (const account of accounts) {
      const id = safeText(account.id, '', 160);
      if (!id) continue;

      const computed = balanceMap.get(id) || emptyBalanceBucket();
      const balance = roundMoney(computed.balance);

      const classified = classifyAccount(account);
      const kind = safeText(account.kind || account.type || classified, classified, 80);
      const type = safeText(account.type || kind || classified, classified, 80);

      const row = {
        ...account,
        id,
        name: safeText(account.name || id, id, 160),
        type,
        kind,
        currency: safeText(account.currency || 'PKR', 'PKR', 20),
        balance,
        current_balance: balance,
        amount: balance,
        transaction_count: computed.transaction_count,
        included_transaction_count: computed.included_transaction_count,
        skipped_inactive_transaction_count: computed.skipped_inactive_transaction_count,
        balance_source: 'transactions_account_id_only',
        balance_version: VERSION
      };

      rows.push(row);
      byId[id] = row;

      if (isActiveAccount(row)) {
        activeCount += 1;

        if (classifyAccount(row) === 'liability') {
          totalLiabilities += balance;
        } else {
          totalAssets += balance;
        }
      }
    }

    totalAssets = roundMoney(totalAssets);
    totalLiabilities = roundMoney(totalLiabilities);

    return json({
      ok: true,
      version: VERSION,
      read_only: true,

      count: rows.length,
      active_count: activeCount,

      accounts: rows,
      accounts_by_id: byId,

      totals: {
        assets: totalAssets,
        liabilities: totalLiabilities,
        net_worth: roundMoney(totalAssets + totalLiabilities),
        liquid: totalAssets
      },

      total_assets: totalAssets,
      total_liquid: totalAssets,
      total_liquid_assets: totalAssets,
      total_liabilities: totalLiabilities,
      net_worth: roundMoney(totalAssets + totalLiabilities),

      rules: {
<<<<<<< HEAD
        balance_source: 'transactions.account_id only',
        transfer_to_account_id_counted: false,
        positive_types: ['income', 'salary', 'opening', 'borrow', 'debt_in'],
        negative_types: ['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment'],
=======
        balance_source: 'transactions',
        source_positive_types: ['income', 'salary', 'opening', 'borrow', 'debt_in'],
        source_negative_types: ['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment'],
        destination_positive_types: ['transfer'],
>>>>>>> 66b22ea93c57fcc4fcebd9ed68cfde0645c36552
        inactive_filters: ['reversed_by', 'reversed_at', '[REVERSAL OF ...]', '[REVERSED BY ...]']
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost() {
  return json({
    ok: false,
    version: VERSION,
    error: 'Account writes are not supported from this endpoint.'
  }, 405);
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
    'archived_at',
    'is_active',
    'is_deleted',
    'is_archived'
  ].filter(col => cols.has(col));

  const orderBy = cols.has('display_order')
    ? 'display_order, name, id'
    : (cols.has('name') ? 'name, id' : 'id');

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
       FROM accounts
      ORDER BY ${orderBy}`
  ).all();

  return (result.results || []).map(row => {
    const classified = classifyAccount(row);

    return {
      id: safeText(row.id, '', 160),
      name: safeText(row.name || row.id, row.id || 'Account', 160),
      type: safeText(row.type || row.kind || classified, classified, 80),
      kind: safeText(row.kind || row.type || classified, classified, 80),
      currency: safeText(row.currency || 'PKR', 'PKR', 20),
      color: row.color || null,
      icon: row.icon || '',
      status: safeText(row.status || 'active', 'active', 80),
      display_order: row.display_order == null ? 999 : Number(row.display_order),
      credit_limit: row.credit_limit == null ? null : Number(row.credit_limit),
      deleted_at: row.deleted_at || null,
      archived_at: row.archived_at || null,
      is_active: row.is_active,
      is_deleted: row.is_deleted,
      is_archived: row.is_archived
    };
  });
}

async function computeTransactionBalances(db, txCols) {
<<<<<<< HEAD
  const map = new Map();

  if (!txCols.has('account_id')) return map;

  const amountExpr = amountSql(txCols);
  const typeExpr = normalizedTypeSql(txCols);
  const inactiveExpr = inactiveSql(txCols);

  const signedExpr = `
    CASE
      /* If amount is already signed, trust it. */
      WHEN COALESCE(${amountExpr}, 0) < 0
        THEN ROUND(COALESCE(${amountExpr}, 0), 2)

      /* Positive money-in types stay positive. */
      WHEN ${typeExpr} IN ('income', 'salary', 'opening', 'borrow', 'debt_in')
        THEN ROUND(COALESCE(${amountExpr}, 0), 2)

      /* Positive money-out types become negative. */
      WHEN ${typeExpr} IN ('expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment')
        THEN ROUND(-COALESCE(${amountExpr}, 0), 2)

      /* Unknown positive rows default to expense for safety. */
      ELSE ROUND(-COALESCE(${amountExpr}, 0), 2)
    END
  `;

  const result = await db.prepare(`
    SELECT
      TRIM(account_id) AS account_id,
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN ${inactiveExpr} THEN 1 ELSE 0 END) AS skipped_inactive_transaction_count,
      SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE 1 END) AS included_transaction_count,
      ROUND(SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE ${signedExpr} END), 2) AS balance
    FROM transactions
    WHERE account_id IS NOT NULL
      AND TRIM(COALESCE(account_id, '')) != ''
    GROUP BY TRIM(account_id)
  `).all();

  for (const row of result.results || []) {
    addBalanceBucket(map, row.account_id, {
      balance: row.balance,
      transaction_count: row.transaction_count,
      included_transaction_count: row.included_transaction_count,
      skipped_inactive_transaction_count: row.skipped_inactive_transaction_count
    });
=======
  const map = new Map();

  if (!txCols.has('account_id')) return map;

  const amountExpr = amountSql(txCols);
  const typeExpr = normalizedTypeSql(txCols);
  const inactiveExpr = inactiveSql(txCols);

  const sourceSignedExpr = `
    CASE
      WHEN ${typeExpr} IN ('income', 'salary', 'opening', 'borrow', 'debt_in')
        THEN ROUND(COALESCE(${amountExpr}, 0), 2)

      WHEN ${typeExpr} IN ('expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment')
        THEN ROUND(-COALESCE(${amountExpr}, 0), 2)

      ELSE ROUND(-COALESCE(${amountExpr}, 0), 2)
    END
  `;

  const sourceResult = await db.prepare(`
    SELECT
      TRIM(account_id) AS account_id,
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN ${inactiveExpr} THEN 1 ELSE 0 END) AS skipped_inactive_transaction_count,
      SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE 1 END) AS included_transaction_count,
      ROUND(SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE ${sourceSignedExpr} END), 2) AS balance
    FROM transactions
    WHERE account_id IS NOT NULL
      AND TRIM(COALESCE(account_id, '')) != ''
    GROUP BY TRIM(account_id)
  `).all();

  for (const row of sourceResult.results || []) {
    addBalanceBucket(map, row.account_id, {
      balance: row.balance,
      transaction_count: row.transaction_count,
      included_transaction_count: row.included_transaction_count,
      skipped_inactive_transaction_count: row.skipped_inactive_transaction_count
    });
>>>>>>> 66b22ea93c57fcc4fcebd9ed68cfde0645c36552
  }

<<<<<<< HEAD
  return map;
}

function amountSql(txCols) {
  if (txCols.has('pkr_amount') && txCols.has('amount')) {
    return `
=======
  if (txCols.has('transfer_to_account_id')) {
    const destinationResult = await db.prepare(`
      SELECT
        TRIM(transfer_to_account_id) AS account_id,
        COUNT(*) AS transaction_count,
        SUM(CASE WHEN ${inactiveExpr} THEN 1 ELSE 0 END) AS skipped_inactive_transaction_count,
        SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE 1 END) AS included_transaction_count,
        ROUND(SUM(CASE
          WHEN ${inactiveExpr} THEN 0
          WHEN ${typeExpr} IN ('transfer') THEN ROUND(COALESCE(${amountExpr}, 0), 2)
          ELSE 0
        END), 2) AS balance
      FROM transactions
      WHERE transfer_to_account_id IS NOT NULL
        AND TRIM(COALESCE(transfer_to_account_id, '')) != ''
      GROUP BY TRIM(transfer_to_account_id)
    `).all();

    for (const row of destinationResult.results || []) {
      addBalanceBucket(map, row.account_id, {
        balance: row.balance,
        transaction_count: row.transaction_count,
        included_transaction_count: row.included_transaction_count,
        skipped_inactive_transaction_count: row.skipped_inactive_transaction_count
      });
    }
  }

  return map;
}

function amountSql(txCols) {
  if (txCols.has('pkr_amount') && txCols.has('amount')) {
    return `
>>>>>>> 66b22ea93c57fcc4fcebd9ed68cfde0645c36552
      CASE
        WHEN pkr_amount IS NOT NULL
         AND CAST(pkr_amount AS REAL) != 0
        THEN CAST(pkr_amount AS REAL)
        ELSE CAST(amount AS REAL)
      END
    `;
  }

  if (txCols.has('pkr_amount')) return `CAST(pkr_amount AS REAL)`;
  if (txCols.has('amount')) return `CAST(amount AS REAL)`;

  return `0`;
}

function normalizedTypeSql(txCols) {
  const rawType = txCols.has('type')
    ? `LOWER(TRIM(COALESCE(type, '')))`
    : `''`;

  return `
    CASE
      WHEN ${rawType} = 'manual_income' THEN 'income'
      WHEN ${rawType} = 'salary_income' THEN 'salary'
      WHEN ${rawType} = 'debt_payment' THEN 'repay'
      WHEN ${rawType} = 'credit_card' THEN 'cc_spend'
      WHEN ${rawType} = 'international' THEN 'expense'
      WHEN ${rawType} = 'international_purchase' THEN 'expense'
      ELSE ${rawType}
    END
  `;
}

function inactiveSql(txCols) {
  const parts = [];

  if (txCols.has('reversed_by')) {
    parts.push(`reversed_by IS NOT NULL AND TRIM(COALESCE(reversed_by, '')) != ''`);
  }

  if (txCols.has('reversed_at')) {
    parts.push(`reversed_at IS NOT NULL AND TRIM(COALESCE(reversed_at, '')) != ''`);
  }

  if (txCols.has('notes')) {
    const notesExpr = `UPPER(COALESCE(notes, ''))`;
    parts.push(`${notesExpr} LIKE '%[REVERSAL OF %'`);
    parts.push(`${notesExpr} LIKE '%[REVERSED BY %'`);
  }

  return parts.length
    ? `(${parts.map(part => `(${part})`).join(' OR ')})`
    : `0`;
}

function addBalanceBucket(map, accountId, values) {
  const id = safeText(accountId, '', 160);
  if (!id) return;

  const existing = map.get(id) || emptyBalanceBucket();

  map.set(id, {
    balance: roundMoney(existing.balance + roundMoney(values.balance || 0)),
    transaction_count: existing.transaction_count + Number(values.transaction_count || 0),
    included_transaction_count: existing.included_transaction_count + Number(values.included_transaction_count || 0),
    skipped_inactive_transaction_count: existing.skipped_inactive_transaction_count + Number(values.skipped_inactive_transaction_count || 0)
  });
}

function emptyBalanceBucket() {
  return {
    balance: 0,
    transaction_count: 0,
    included_transaction_count: 0,
    skipped_inactive_transaction_count: 0
  };
}

function classifyAccount(account) {
  const text = [
    account?.type,
    account?.kind,
    account?.name,
    account?.id
  ].map(value => String(value || '').toLowerCase()).join(' ');

  if (
    text.includes('liability') ||
    text.includes('credit') ||
    text.includes('card') ||
    text.includes('loan') ||
    text.includes('debt') ||
    text.includes('payable')
  ) {
    return 'liability';
  }

  return 'asset';
}

function isActiveAccount(account) {
  if (!account) return false;

  const status = String(account.status || '').trim().toLowerCase();

  if (status && ['archived', 'closed', 'deleted', 'inactive', 'disabled'].includes(status)) {
    return false;
  }

  if (account.deleted_at != null && String(account.deleted_at).trim() !== '') return false;
  if (account.archived_at != null && String(account.archived_at).trim() !== '') return false;

  if (isTruthy(account.is_deleted)) return false;
  if (isTruthy(account.is_archived)) return false;
  if (isExplicitFalse(account.is_active)) return false;

  return true;
}

function isTruthy(value) {
  return value === true ||
    value === 1 ||
    value === '1' ||
    String(value).trim().toLowerCase() === 'true' ||
    String(value).trim().toLowerCase() === 'yes';
}

function isExplicitFalse(value) {
  return value === false ||
    value === 0 ||
    value === '0' ||
    String(value).trim().toLowerCase() === 'false' ||
    String(value).trim().toLowerCase() === 'no';
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

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function safeText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function requireDb(env) {
  if (!env?.DB) throw new Error('D1 binding DB is missing.');
  return env.DB;
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