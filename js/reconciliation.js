/* Sovereign Finance Reconciliation API
 * /api/reconciliation
 * v0.1.0-manual-balance-snapshots
 *
 * Purpose:
 * - Compare app account balance vs real bank/wallet balance.
 * - Save reconciliation snapshots.
 * - Does NOT mutate ledger or account balances.
 * - Does NOT create adjustment transactions yet.
 */

const VERSION = 'v0.1.0-manual-balance-snapshots';

export async function onRequestGet(context) {
  return withJsonErrors('GET', async () => {
    const db = context.env.DB;

    await ensureTable(db);

    const accounts = await loadAccounts(db);
    const latestMap = await loadLatestReconciliations(db);

    const rows = accounts.map(account => {
      const latest = latestMap.get(account.id) || null;
      const appBalance = moneyNumber(account.balance, 0);
      const realBalance = latest ? moneyNumber(latest.real_balance, 0) : null;
      const difference = latest ? round2(realBalance - appBalance) : null;

      const status = latest
        ? difference === 0
          ? 'matched'
          : 'needs_review'
        : 'pending_statement';

      return {
        account_id: account.id,
        account_name: account.name,
        account_type: account.type,
        app_balance: appBalance,
        real_balance: realBalance,
        difference,
        status,
        statement_date: latest ? latest.statement_date : null,
        last_checked_at: latest ? latest.created_at : null,
        notes: latest ? latest.notes : '',
        latest_reconciliation_id: latest ? latest.id : null
      };
    });

    const summary = summarize(rows);

    return json({
      ok: true,
      version: VERSION,
      rows,
      exceptions: rows.filter(row => row.status === 'needs_review'),
      summary,
      rules: {
        reconciliation_does_not_change_balances: true,
        real_balance_is_manual_statement_value: true,
        adjustments_are_not_auto_created: true,
        ignored_differences_not_supported_yet: true
      }
    });
  });
}

export async function onRequestPost(context) {
  return withJsonErrors('POST', async () => {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const dryRun = url.searchParams.get('dry_run') === '1' || url.searchParams.get('dry_run') === 'true';

    await ensureTable(db);

    const body = await readJSON(context.request);

    const accountId = safeText(body.account_id, '', 160);
    const statementDate = normalizeDate(body.statement_date || body.date) || todayISO();
    const realBalance = moneyNumber(body.real_balance, null);
    const notes = safeText(body.notes, '', 1000);
    const createdBy = safeText(body.created_by, 'web-reconciliation', 120);

    if (!accountId) {
      return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);
    }

    if (realBalance == null) {
      return json({ ok: false, version: VERSION, error: 'real_balance required' }, 400);
    }

    const account = await findAccount(db, accountId);

    if (!account) {
      return json({
        ok: false,
        version: VERSION,
        error: `Account not found: ${accountId}`
      }, 404);
    }

    const appBalance = moneyNumber(account.balance, 0);
    const difference = round2(realBalance - appBalance);
    const status = difference === 0 ? 'matched' : 'needs_review';

    const snapshot = {
      id: makeId('recon'),
      account_id: account.id,
      account_name_snapshot: account.name,
      statement_date: statementDate,
      app_balance: appBalance,
      real_balance: realBalance,
      difference,
      status,
      notes,
      created_by: createdBy
    };

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        action: 'reconciliation.dry_run',
        dry_run: true,
        writes_performed: false,
        snapshot,
        recommendation: recommendationForDifference(difference)
      });
    }

    await db.prepare(
      `INSERT INTO account_reconciliations (
        id,
        account_id,
        account_name_snapshot,
        statement_date,
        app_balance,
        real_balance,
        difference,
        status,
        notes,
        created_by,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(
      snapshot.id,
      snapshot.account_id,
      snapshot.account_name_snapshot,
      snapshot.statement_date,
      snapshot.app_balance,
      snapshot.real_balance,
      snapshot.difference,
      snapshot.status,
      snapshot.notes,
      snapshot.created_by
    ).run();

    return json({
      ok: true,
      version: VERSION,
      action: 'reconciliation.save',
      writes_performed: true,
      snapshot,
      recommendation: recommendationForDifference(difference)
    });
  });
}

/* -----------------------------
 * Table
 * ----------------------------- */

async function ensureTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS account_reconciliations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_name_snapshot TEXT,
      statement_date TEXT NOT NULL,
      app_balance REAL NOT NULL,
      real_balance REAL NOT NULL,
      difference REAL NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  ).run();
}

/* -----------------------------
 * Data loaders
 * ----------------------------- */

async function loadAccounts(db) {
  const cols = await tableColumns(db, 'accounts');
  if (!cols.size || !cols.has('id')) return [];

  const selected = [
    'id',
    cols.has('name') ? 'name' : null,
    cols.has('type') ? 'type' : null,
    cols.has('kind') ? 'kind' : null,
    cols.has('balance') ? 'balance' : null,
    cols.has('current_balance') ? 'current_balance' : null,
    cols.has('amount') ? 'amount' : null,
    cols.has('status') ? 'status' : null,
    cols.has('deleted_at') ? 'deleted_at' : null,
    cols.has('archived_at') ? 'archived_at' : null,
    cols.has('display_order') ? 'display_order' : null
  ].filter(Boolean);

  const order = cols.has('display_order') ? 'display_order, name, id' : cols.has('name') ? 'name, id' : 'id';

  const res = await db.prepare(
    `SELECT ${selected.join(', ')}
     FROM accounts
     ORDER BY ${order}`
  ).all();

  return (res.results || [])
    .map(row => normalizeAccount(row))
    .filter(row => {
      const status = String(row.status || 'active').toLowerCase();
      if (['inactive', 'deleted', 'archived'].includes(status)) return false;
      if (row.deleted_at || row.archived_at) return false;

      const type = String(row.type || '').toLowerCase();
      if (['liability', 'credit_card', 'loan', 'debt'].includes(type)) return false;

      return true;
    });
}

async function findAccount(db, accountId) {
  const accounts = await loadAccounts(db);
  const target = token(accountId);

  return accounts.find(account =>
    token(account.id) === target ||
    token(account.name) === target
  ) || null;
}

async function loadLatestReconciliations(db) {
  const map = new Map();

  const res = await db.prepare(
    `SELECT *
     FROM account_reconciliations
     ORDER BY datetime(created_at) DESC, id DESC`
  ).all();

  for (const row of res.results || []) {
    if (!map.has(row.account_id)) {
      map.set(row.account_id, row);
    }
  }

  return map;
}

/* -----------------------------
 * Helpers
 * ----------------------------- */

function summarize(rows) {
  const appBalance = round2(rows.reduce((sum, row) => sum + moneyNumber(row.app_balance, 0), 0));
  const realBalance = round2(rows.reduce((sum, row) => {
    return sum + (row.real_balance == null ? moneyNumber(row.app_balance, 0) : moneyNumber(row.real_balance, 0));
  }, 0));

  const difference = round2(realBalance - appBalance);
  const matched = rows.filter(row => row.status === 'matched').length;
  const needsReview = rows.filter(row => row.status === 'needs_review').length;
  const pending = rows.filter(row => row.status === 'pending_statement').length;

  return {
    app_balance: appBalance,
    real_balance: realBalance,
    difference,
    matched_count: matched,
    needs_review_count: needsReview,
    pending_statement_count: pending,
    account_count: rows.length
  };
}

function recommendationForDifference(difference) {
  const diff = moneyNumber(difference, 0);

  if (diff === 0) {
    return 'Balances match. No action needed.';
  }

  if (diff < 0) {
    return 'Real balance is lower than app balance. Possible missing expense, fee, withdrawal, transfer out, or duplicate income.';
  }

  return 'Real balance is higher than app balance. Possible missing income, refund, reversal, transfer in, or duplicate expense.';
}

function normalizeAccount(row) {
  return {
    id: safeText(row.id, '', 160),
    name: safeText(row.name || row.id, '', 160),
    type: safeText(row.type || row.kind || 'asset', 'asset', 80),
    status: safeText(row.status || 'active', 'active', 80),
    balance: moneyNumber(row.balance ?? row.current_balance ?? row.amount, 0),
    deleted_at: row.deleted_at || null,
    archived_at: row.archived_at || null
  };
}

async function tableColumns(db, table) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function withJsonErrors(method, fn) {
  try {
    return await fn();
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      method,
      error: err.message || String(err),
      stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 6).join('\n')
    }, 500);
  }
}

function normalizeDate(value) {
  const raw = safeText(value, '', 40);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return '';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function safeText(value, fallback = '', max = 500) {
  const raw = value == null || value === '' ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function moneyNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? round2(n) : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
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