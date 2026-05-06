/* ─── /api/insights · v0.2.0 · Layer 2 formula-spec analytics contract ─── */
/*
 * Purpose:
 *   Provide clean analytics data for Insights UI without presentation assumptions.
 *
 * Layer 2 contract:
 *   - Exclude D1-native reversals: reversed_by / reversed_at.
 *   - Exclude Sheet-imported reversal markers in notes:
 *       [REVERSED BY ...]
 *       [REVERSAL OF ...]
 *   - Exclude transfers from income/expense analytics:
 *       transfer OUT rows are movement, not spending
 *       legacy transfer IN rows are income rows with "From: ... [linked: ...]"
 *   - Never return null category labels.
 *   - Never return NaN.
 *   - Keep response stable for UI:
 *       totals
 *       net
 *       by_category
 *       by_account
 *       daily_trend
 *       debug
 */

const VERSION = 'v0.2.0';

const INCOME_TYPES = new Set(['income', 'borrow', 'salary']);
const EXPENSE_TYPES = new Set(['expense', 'repay', 'cc_spend', 'atm']);

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const since = dateDaysAgo(days);
  const debug = url.searchParams.get('debug') === '1';

  try {
    const txnsResult = await env.DB.prepare(
      `SELECT id, date, type, amount, account_id, category_id, notes,
              reversed_by, reversed_at, linked_txn_id, created_at
       FROM transactions
       WHERE date >= ?
       ORDER BY date ASC, datetime(created_at) ASC, id ASC`
    ).bind(since).all();

    const accountResult = await env.DB.prepare(
      `SELECT id, name, icon, kind, type
       FROM accounts
       WHERE status = 'active'
          OR status IS NULL
       ORDER BY display_order, name`
    ).all();

    const categoryResult = await safeAll(env.DB,
      `SELECT id, name, icon
       FROM categories`
    );

    const accountMap = toAccountMap(accountResult.results || []);
    const categoryMap = toCategoryMap(categoryResult.results || []);

    const allRows = txnsResult.results || [];
    const activeRows = allRows.filter(row => !isReversalRow(row));

    const analyticRows = activeRows
      .map(row => classifyRow(row))
      .filter(row => row.classification !== 'ignore');

    const incomeRows = analyticRows.filter(row => row.classification === 'income');
    const expenseRows = analyticRows.filter(row => row.classification === 'expense');

    const incomeTotal = round2(sumAmounts(incomeRows));
    const expenseTotal = round2(sumAmounts(expenseRows));
    const net = round2(incomeTotal - expenseTotal);

    const byCategory = buildCategoryBreakdown(expenseRows, categoryMap);
    const byAccount = buildAccountBreakdown(expenseRows, accountMap);
    const dailyTrend = buildDailyTrend(expenseRows, since, days);

    const body = {
      ok: true,
      version: VERSION,
      days,
      since,

      totals: {
        income: incomeTotal,
        expense: expenseTotal
      },

      net,

      by_category: byCategory,
      by_account: byAccount,
      daily_trend: dailyTrend,

      top_category: byCategory.length ? byCategory[0] : {
        id: 'uncategorized',
        name: 'Uncategorized',
        icon: '📌',
        total: 0,
        count: 0
      },

      generated_at: new Date().toISOString()
    };

    if (debug) {
      body.debug = {
        total_rows_scanned: allRows.length,
        active_rows: activeRows.length,
        hidden_reversal_rows: allRows.length - activeRows.length,
        analytic_rows: analyticRows.length,
        income_rows: incomeRows.length,
        expense_rows: expenseRows.length,
        ignored_rows: activeRows.length - analyticRows.length,
        category_rows_loaded: (categoryResult.results || []).length,
        account_rows_loaded: (accountResult.results || []).length,
        reversal_bridge: 'reversed_by/reversed_at plus Sheet notes markers',
        transfer_rule: 'exclude transfer OUT rows and legacy transfer IN rows from income/expense analytics'
      };
    }

    return json(body);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

function classifyRow(row) {
  const type = String(row.type || '').toLowerCase();

  if (isLegacyTransferIn(row)) {
    return {
      ...row,
      classification: 'ignore',
      ignored_reason: 'legacy_transfer_in'
    };
  }

  if (type === 'transfer' || type === 'cc_payment') {
    return {
      ...row,
      classification: 'ignore',
      ignored_reason: 'transfer_movement'
    };
  }

  if (INCOME_TYPES.has(type)) {
    return {
      ...row,
      classification: 'income'
    };
  }

  if (EXPENSE_TYPES.has(type)) {
    return {
      ...row,
      classification: 'expense'
    };
  }

  return {
    ...row,
    classification: 'ignore',
    ignored_reason: 'unknown_or_non_analytic_type'
  };
}

function isReversalRow(row) {
  if (!row) return false;

  if (row.reversed_by || row.reversed_at) return true;

  const notes = String(row.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function isLegacyTransferIn(row) {
  const type = String(row.type || '').toLowerCase();
  const notes = String(row.notes || '');

  return type === 'income' && /^From:/i.test(notes) && /\[linked:/i.test(notes);
}

function buildCategoryBreakdown(rows, categoryMap) {
  const map = {};

  for (const row of rows) {
    const category = getCategory(row.category_id, categoryMap);
    const key = category.id;

    if (!map[key]) {
      map[key] = {
        id: category.id,
        name: category.name,
        icon: category.icon,
        total: 0,
        count: 0
      };
    }

    map[key].total += Number(row.amount) || 0;
    map[key].count += 1;
  }

  return Object.values(map)
    .map(row => ({
      ...row,
      total: round2(row.total)
    }))
    .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));
}

function buildAccountBreakdown(rows, accountMap) {
  const map = {};

  for (const row of rows) {
    const account = getAccount(row.account_id, accountMap);
    const key = account.id;

    if (!map[key]) {
      map[key] = {
        id: account.id,
        name: account.name,
        icon: account.icon,
        total: 0,
        count: 0
      };
    }

    map[key].total += Number(row.amount) || 0;
    map[key].count += 1;
  }

  return Object.values(map)
    .map(row => ({
      ...row,
      total: round2(row.total)
    }))
    .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));
}

function buildDailyTrend(rows, since, days) {
  const map = {};

  for (let i = days - 1; i >= 0; i--) {
    const d = dateDaysAgo(i);
    map[d] = 0;
  }

  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;

    if (!(date in map)) map[date] = 0;

    map[date] += Number(row.amount) || 0;
  }

  return Object.keys(map)
    .sort()
    .map(date => ({
      date,
      total: round2(map[date])
    }))
    .filter(row => row.date >= since);
}

function getCategory(categoryId, categoryMap) {
  const id = categoryId == null || categoryId === ''
    ? 'uncategorized'
    : String(categoryId);

  if (categoryMap[id]) return categoryMap[id];

  if (id === 'uncategorized') {
    return {
      id: 'uncategorized',
      name: 'Uncategorized',
      icon: '📌'
    };
  }

  return {
    id,
    name: humanizeId(id),
    icon: '📌'
  };
}

function getAccount(accountId, accountMap) {
  const id = accountId == null || accountId === ''
    ? 'unknown'
    : String(accountId);

  if (accountMap[id]) return accountMap[id];

  return {
    id,
    name: humanizeId(id),
    icon: '🏦'
  };
}

function toAccountMap(rows) {
  const map = {};

  for (const row of rows || []) {
    if (!row || !row.id) continue;

    map[row.id] = {
      id: row.id,
      name: row.name || humanizeId(row.id),
      icon: row.icon || iconForAccount(row)
    };
  }

  return map;
}

function toCategoryMap(rows) {
  const map = {};

  for (const row of rows || []) {
    if (!row || !row.id) continue;

    map[row.id] = {
      id: row.id,
      name: row.name || humanizeId(row.id),
      icon: row.icon || '📌'
    };
  }

  return map;
}

async function safeAll(db, sql) {
  try {
    return await db.prepare(sql).all();
  } catch (err) {
    return {
      results: [],
      error: err.message
    };
  }
}

function iconForAccount(row) {
  const kind = String(row.kind || row.type || '').toLowerCase();

  if (kind === 'cash') return '💵';
  if (kind === 'wallet') return '📲';
  if (kind === 'cc') return '🪪';
  if (kind === 'prepaid') return '💳';

  return '🏦';
}

function humanizeId(id) {
  return String(id || 'Unknown')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
}

function sumAmounts(rows) {
  return rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

function dateDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(daysAgo || 0));

  return d.toISOString().slice(0, 10);
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, n));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
