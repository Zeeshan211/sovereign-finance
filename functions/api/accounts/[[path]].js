/* /api/accounts
 * Sovereign Finance · Accounts API
 * v0.2.11-accounts-signed-amount-safe
 *
 * Contract:
 * - GET is read-only.
 * - Balances are ledger-derived from transactions.account_id only.
 * - transfer_to_account_id is NOT counted separately.
 * - If account_delta exists, it is trusted first.
 * - If amount/pkr_amount is already negative, it stays negative.
 * - If amount is positive, type decides direction.
 * - Reversal rows and reversed originals are excluded.
 */

const VERSION = 'v0.3.1-accounts-number-closed';

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

        balance_source: txCols.has('account_delta')
          ? 'transactions.account_delta_preferred'
          : 'transactions.account_id_signed_amount_safe',
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
        balance_source: txCols.has('account_delta')
          ? 'account_delta preferred'
          : 'signed amount safe fallback',
        transfer_to_account_id_counted: false,
        signed_negative_amounts_trusted: true,
        positive_types: ['income', 'salary', 'opening', 'borrow', 'debt_in'],
        negative_types: ['expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment'],
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

export async function onRequestPost(context) {
  try {
    const db = requireDb(context.env);
    const url = new URL(context.request.url);
    const pathParts = (context.params && context.params.path
      ? (Array.isArray(context.params.path) ? context.params.path : [context.params.path])
      : []).filter(Boolean);

    const body = await readJSON(context.request);

    const name = safeText(body.name, '', 160);
    const type = safeText(body.type, '', 40).toLowerCase();
    const kind = safeText(body.kind, '', 80).toLowerCase() || type;

    if (!name) {
      return json({ ok: false, version: VERSION, error: 'name is required' }, 400);
    }

    if (!type || !['asset', 'liability'].includes(type)) {
      return json({ ok: false, version: VERSION, error: 'type must be "asset" or "liability"' }, 400);
    }

    if (!kind) {
      return json({ ok: false, version: VERSION, error: 'kind is required' }, 400);
    }

    const cols = await tableColumns(db, 'accounts');

    const slug = makeAccountSlug(name);
    const existing = await db.prepare(
      `SELECT id FROM accounts WHERE id = ? LIMIT 1`
    ).bind(slug).first();

    const id = existing ? slug + '_' + randomSuffix() : slug;

    const opening_balance = roundMoney(body.opening_balance || 0);
    const currency = safeText(body.currency || 'PKR', 'PKR', 10).toUpperCase();
    const now = new Date().toISOString();

    const row = filterRowToCols(cols, {
      id,
      name,
      type,
      kind,
      currency,
      opening_balance,
      account_number:     safeText(body.account_number, '', 80) || null,
      color:              safeText(body.color, '', 40) || null,
      icon:               safeText(body.icon, '', 40) || null,
      display_order:      Number.isFinite(Number(body.display_order)) ? Number(body.display_order) : 999,
      status:             safeText(body.status, 'active', 40).toLowerCase() || 'active',
      closed_at:          body.closed_at || null,
      credit_limit:       body.credit_limit != null ? roundMoney(body.credit_limit) : null,
      min_payment_amount: body.min_payment_amount != null ? roundMoney(body.min_payment_amount) : null,
      statement_day:      body.statement_day != null ? Math.floor(Number(body.statement_day)) : null,
      payment_due_day:    body.payment_due_day != null ? Math.floor(Number(body.payment_due_day)) : null,
      owner_user_id:      'user_owner',
      household_id:       'hh_owner',
      created_at:         now
    });

    const keys = Object.keys(row);
    await db.prepare(
      `INSERT INTO accounts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).bind(...keys.map(k => row[k])).run();

    const created = await db.prepare(
      `SELECT * FROM accounts WHERE id = ? LIMIT 1`
    ).bind(id).first();

    return json({ ok: true, version: VERSION, account: created }, 201);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPatch(context) {
  try {
    const db = requireDb(context.env);
    const pathParts = (context.params && context.params.path
      ? (Array.isArray(context.params.path) ? context.params.path : [context.params.path])
      : []).filter(Boolean);

    const accountId = pathParts[0];

    if (!accountId) {
      return json({ ok: false, version: VERSION, error: 'account id required in path: /api/accounts/:id' }, 400);
    }

    const existing = await db.prepare(
      `SELECT * FROM accounts WHERE id = ? LIMIT 1`
    ).bind(accountId).first();

    if (!existing) {
      return json({ ok: false, version: VERSION, error: 'Account not found' }, 404);
    }

    const body = await readJSON(context.request);
    const cols = await tableColumns(db, 'accounts');

    const EDITABLE = ['name', 'account_number', 'color', 'icon', 'status', 'closed_at',
      'display_order', 'credit_limit', 'min_payment_amount', 'statement_day', 'payment_due_day'];

    const updates = {};

    for (const field of EDITABLE) {
      if (!(field in body)) continue;
      if (!cols.has(field)) continue;

      if (['credit_limit', 'min_payment_amount'].includes(field)) {
        updates[field] = body[field] != null ? roundMoney(body[field]) : null;
      } else if (['display_order', 'statement_day', 'payment_due_day'].includes(field)) {
        updates[field] = body[field] != null ? Math.floor(Number(body[field])) : null;
      } else {
        updates[field] = safeText(body[field], '', 200) || null;
      }
    }

    if (!Object.keys(updates).length) {
      return json({ ok: false, version: VERSION, error: 'No editable fields supplied' }, 400);
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.prepare(
      `UPDATE accounts SET ${setClauses} WHERE id = ?`
    ).bind(...Object.values(updates), accountId).run();

    const updated = await db.prepare(
      `SELECT * FROM accounts WHERE id = ? LIMIT 1`
    ).bind(accountId).first();

    return json({ ok: true, version: VERSION, account: updated });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = requireDb(context.env);
    const pathParts = (context.params && context.params.path
      ? (Array.isArray(context.params.path) ? context.params.path : [context.params.path])
      : []).filter(Boolean);

    const accountId = pathParts[0];

    if (!accountId) {
      return json({ ok: false, version: VERSION, error: 'account id required in path: /api/accounts/:id' }, 400);
    }

    const existing = await db.prepare(
      `SELECT id, name, status FROM accounts WHERE id = ? LIMIT 1`
    ).bind(accountId).first();

    if (!existing) {
      return json({ ok: false, version: VERSION, error: 'Account not found' }, 404);
    }

    const now = new Date().toISOString();

    await db.prepare(
      `UPDATE accounts SET deleted_at = ?, status = 'deleted' WHERE id = ?`
    ).bind(now, accountId).run();

    return json({
      ok: true,
      version: VERSION,
      deleted: true,
      account_id: accountId,
      deleted_at: now,
      note: 'Soft delete — row retained, transactions preserved. Filter with deleted_at IS NOT NULL to hide.'
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
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
    'account_number',
    'display_order',
    'credit_limit',
    'closed_at',
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
      account_number: row.account_number || null,
      credit_limit: row.credit_limit == null ? null : Number(row.credit_limit),
      closed_at: row.closed_at || null,
      deleted_at: row.deleted_at || null,
      archived_at: row.archived_at || null,
      is_active: row.is_active,
      is_deleted: row.is_deleted,
      is_archived: row.is_archived
    };
  });
}

async function computeTransactionBalances(db, txCols) {
  const map = new Map();

  if (!txCols.has('account_id')) return map;

  const inactiveExpr = inactiveSql(txCols);
  const signedExpr = signedAmountSql(txCols);

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
  }

  return map;
}

function signedAmountSql(txCols) {
  if (txCols.has('account_delta')) {
    return `
      CASE
        WHEN account_delta IS NOT NULL
         AND TRIM(COALESCE(account_delta, '')) != ''
        THEN ROUND(CAST(account_delta AS REAL), 2)
        ELSE ${signedFallbackSql(txCols)}
      END
    `;
  }

  return signedFallbackSql(txCols);
}

function signedFallbackSql(txCols) {
  const amountExpr = amountSql(txCols);
  const typeExpr = normalizedTypeSql(txCols);

  return `
    CASE
      WHEN COALESCE(${amountExpr}, 0) < 0
        THEN ROUND(COALESCE(${amountExpr}, 0), 2)

      WHEN ${typeExpr} IN ('income', 'salary', 'opening', 'borrow', 'debt_in')
        THEN ROUND(COALESCE(${amountExpr}, 0), 2)

      WHEN ${typeExpr} IN ('expense', 'transfer', 'cc_spend', 'repay', 'atm', 'debt_out', 'cc_payment')
        THEN ROUND(-COALESCE(${amountExpr}, 0), 2)

      ELSE ROUND(-COALESCE(${amountExpr}, 0), 2)
    END
  `;
}

function amountSql(txCols) {
  if (txCols.has('pkr_amount') && txCols.has('amount')) {
    return `
      CASE
        WHEN pkr_amount IS NOT NULL
         AND TRIM(COALESCE(pkr_amount, '')) != ''
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

function filterRowToCols(cols, row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

function makeAccountSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'account';
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6);
}

async function readJSON(request) {
  try { return await request.json(); } catch { return {}; }
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