/* /api/accounts
 * Sovereign Finance · Accounts API
 * v0.2.7-accounts-canonical-transfer-sign-fix
 *
 * RCA fixed:
 * - Accounts page was stale/wrong while Add page showed correct balances.
 * - Accounts endpoint was not applying transfer source rows as negative.
 *
 * Balance rules:
 * - income / salary / opening / borrow / debt_in = +
 * - expense / transfer / cc_spend / repay / atm / debt_out / cc_payment = -
 * - skip reversal rows and reversed originals
 */

const VERSION = 'v0.2.8-accounts-sql-balance-aggregation';

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
      const id = account.id;
      const computed = balanceMap.get(id) || emptyBalanceBucket();
      const balance = roundMoney(computed.balance);

      const kind = account.kind || account.type || classifyAccount(account);
      const type = account.type || kind || classifyAccount(account);

      const row = {
        ...account,
        id,
        name: account.name || id,
        type,
        kind,
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
        positive_types: ['income', 'salary', 'opening', 'borrow', 'debt_in'],
        negative_types: ['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment'],
        inactive_filters: ['reversed_by', 'reversed_at', '[REVERSAL OF ...]', '[REVERSED BY ...]']
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

async function computeTransactionBalances(db, txCols) {
  if (!txCols.has('account_id')) {
    return new Map();
  }

  const amountExpr = txCols.has('pkr_amount')
    ? `
      CASE
        WHEN pkr_amount IS NOT NULL
         AND CAST(pkr_amount AS REAL) != 0
        THEN CAST(pkr_amount AS REAL)
        ELSE CAST(amount AS REAL)
      END
    `
    : `CAST(amount AS REAL)`;

  const typeExpr = txCols.has('type')
    ? `LOWER(TRIM(COALESCE(type, ''))) `
    : `''`;

  const notesExpr = txCols.has('notes')
    ? `UPPER(COALESCE(notes, ''))`
    : `''`;

  const inactiveParts = [];

  if (txCols.has('reversed_by')) {
    inactiveParts.push(`reversed_by IS NOT NULL AND TRIM(COALESCE(reversed_by, '')) != ''`);
  }

  if (txCols.has('reversed_at')) {
    inactiveParts.push(`reversed_at IS NOT NULL AND TRIM(COALESCE(reversed_at, '')) != ''`);
  }

  if (txCols.has('notes')) {
    inactiveParts.push(`${notesExpr} LIKE '%[REVERSAL OF %'`);
    inactiveParts.push(`${notesExpr} LIKE '%[REVERSED BY %'`);
  }

  const inactiveExpr = inactiveParts.length
    ? `(${inactiveParts.map(part => `(${part})`).join(' OR ')})`
    : `0`;

  const normalizedTypeExpr = `
    CASE
      WHEN ${typeExpr} = 'manual_income' THEN 'income'
      WHEN ${typeExpr} = 'salary_income' THEN 'salary'
      WHEN ${typeExpr} = 'debt_payment' THEN 'repay'
      WHEN ${typeExpr} = 'credit_card' THEN 'cc_spend'
      WHEN ${typeExpr} = 'international' THEN 'expense'
      WHEN ${typeExpr} = 'international_purchase' THEN 'expense'
      ELSE ${typeExpr}
    END
  `;

  const signedExpr = `
    CASE
      WHEN ${normalizedTypeExpr} IN ('income', 'salary', 'opening', 'borrow', 'debt_in')
        THEN ROUND(COALESCE(${amountExpr}, 0), 2)

      WHEN ${normalizedTypeExpr} IN ('expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment')
        THEN ROUND(-COALESCE(${amountExpr}, 0), 2)

      ELSE ROUND(-COALESCE(${amountExpr}, 0), 2)
    END
  `;

  const result = await db.prepare(`
    SELECT
      account_id,
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN ${inactiveExpr} THEN 1 ELSE 0 END) AS skipped_inactive_transaction_count,
      SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE 1 END) AS included_transaction_count,
      ROUND(SUM(CASE WHEN ${inactiveExpr} THEN 0 ELSE ${signedExpr} END), 2) AS balance
    FROM transactions
    WHERE account_id IS NOT NULL
      AND TRIM(COALESCE(account_id, '')) != ''
    GROUP BY account_id
  `).all();

  const map = new Map();

  for (const row of result.results || []) {
    map.set(row.account_id, {
      balance: roundMoney(row.balance || 0),
      transaction_count: Number(row.transaction_count || 0),
      included_transaction_count: Number(row.included_transaction_count || 0),
      skipped_inactive_transaction_count: Number(row.skipped_inactive_transaction_count || 0)
    });
  }

  return map;
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
