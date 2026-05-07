/*  Sovereign Finance  /api/reconciliation/[[path]]  v0.2.2  Stale-vs-drift Truth Logic  */
/*
 * Routes:
 *   GET    /api/reconciliation
 *   GET    /api/reconciliation/account/{account_id}
 *   POST   /api/reconciliation
 *   POST   /api/reconciliation/{id}/note
 *
 * Contract:
 *   - GET is read-only.
 *   - Reconciliation compares app balance vs declared real-world balance.
 *   - Balance computation supports current transaction types:
 *       income, salary, borrow, debt_in, opening,
 *       expense, repay, cc_spend, atm, debt_out,
 *       transfer, cc_payment, fee_amount, pra_amount, transfer target.
 *   - Reversal-safe balance math:
 *       exclude rows with reversed_by
 *       exclude rows with reversed_at
 *       exclude rows with notes containing [REVERSAL OF
 *       exclude rows with notes containing [REVERSED BY
 *   - Stale-vs-drift truth logic:
 *       no declaration -> undeclared
 *       transaction date after declaration date -> stale
 *       declaration older than stale window -> stale
 *       no later transactions and balance mismatch -> drifted
 *       no later transactions and balance matches -> matched
 *   - POST declaration does not mutate ledger transactions.
 *   - Existing account declarations update the same reconciliation row.
 */

import { json, audit, snapshot, uuid } from '../_lib.js';

const VERSION = 'v0.2.2';
const DRIFT_THRESHOLD = 1;
const STALE_DAYS = 7;

const TYPE_PLUS = new Set(['income', 'salary', 'borrow', 'debt_in', 'opening']);
const TYPE_MINUS = new Set(['expense', 'repay', 'cc_spend', 'atm', 'debt_out']);

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = getPath(params);
  const method = request.method;

  try {
    if (path.length === 0) {
      if (method === 'GET') return await handleList(env);
      if (method === 'POST') return await handleCreateOrUpdate(env, request);
      return json({ ok: false, version: VERSION, error: 'Method not allowed' }, 405);
    }

    if (path.length === 2 && path[0] === 'account') {
      if (method === 'GET') return await handleAccountHistory(env, path[1]);
      return json({ ok: false, version: VERSION, error: 'Method not allowed' }, 405);
    }

    if (path.length === 2 && path[1] === 'note') {
      if (method === 'POST') return await handleAddNote(env, path[0], request);
      return json({ ok: false, version: VERSION, error: 'Method not allowed' }, 405);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Not found. Available: GET /, POST /, GET /account/{id}, POST /{recon_id}/note'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function handleList(env) {
  const db = env.DB;

  const [accountsRes, declarationsRes, txnsRes] = await Promise.all([
    db.prepare(
      `SELECT *
       FROM accounts
       WHERE (deleted_at IS NULL OR deleted_at = '')
         AND (archived_at IS NULL OR archived_at = '')
         AND (status IS NULL OR status = '' OR status = 'active')
       ORDER BY display_order, name`
    ).all(),
    db.prepare(
      `SELECT *
       FROM reconciliation
       ORDER BY declared_at DESC`
    ).all(),
    db.prepare(
      `SELECT *
       FROM transactions`
    ).all()
  ]);

  const accounts = accountsRes.results || [];
  const declarations = declarationsRes.results || [];
  const transactions = txnsRes.results || [];

  const ledger = computeLedgerState(accounts, transactions);
  const latestByAccount = latestDeclarationsByAccount(declarations);

  const truthAccounts = accounts.map(account => {
    const latest = latestByAccount[account.id] || null;
    return buildTruthAccount(
      account,
      ledger.balances[account.id] || 0,
      latest,
      ledger.latestTxnDates[account.id] || null,
      ledger.txnDatesByAccount[account.id] || [],
      ledger.includedTxnCounts[account.id] || 0
    );
  });

  const matchedCount = truthAccounts.filter(row => row.truth_status === 'matched').length;
  const driftedCount = truthAccounts.filter(row => row.truth_status === 'drifted').length;
  const undeclaredCount = truthAccounts.filter(row => row.truth_status === 'undeclared').length;
  const staleCount = truthAccounts.filter(row => row.truth_status === 'stale').length;

  const enrichedDeclarations = declarations.map(row => {
    const account = accounts.find(item => item.id === row.account_id) || null;
    const appBalance = ledger.balances[row.account_id] || 0;
    return enrichDeclaration(
      row,
      account,
      appBalance,
      ledger.latestTxnDates[row.account_id] || null,
      ledger.txnDatesByAccount[row.account_id] || [],
      ledger.includedTxnCounts[row.account_id] || 0
    );
  });

  return json({
    ok: true,
    version: VERSION,
    drift_threshold: DRIFT_THRESHOLD,
    stale_days: STALE_DAYS,
    accounts_count: accounts.length,
    declarations_count: declarations.length,
    matched_count: matchedCount,
    clean_count: matchedCount,
    drifted_count: driftedCount,
    undeclared_count: undeclaredCount,
    stale_count: staleCount,
    truth_accounts: truthAccounts,
    accounts_latest: truthAccounts,
    declarations: enrichedDeclarations
  });
}

async function handleAccountHistory(env, accountId) {
  const db = env.DB;

  const account = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?`
  ).bind(accountId).first();

  if (!account) {
    return json({ ok: false, version: VERSION, error: `Account ${accountId} not found` }, 404);
  }

  const [txnsRes, declarationsRes] = await Promise.all([
    db.prepare(
      `SELECT *
       FROM transactions
       WHERE account_id = ?
          OR transfer_to_account_id = ?`
    ).bind(accountId, accountId).all(),
    db.prepare(
      `SELECT *
       FROM reconciliation
       WHERE account_id = ?
       ORDER BY declared_at DESC`
    ).bind(accountId).all()
  ]);

  const ledger = computeLedgerState([account], txnsRes.results || []);
  const appBalance = ledger.balances[account.id] || 0;
  const latestTxnDate = ledger.latestTxnDates[account.id] || null;
  const txnDates = ledger.txnDatesByAccount[account.id] || [];
  const includedTxnCount = ledger.includedTxnCounts[account.id] || 0;

  const declarations = (declarationsRes.results || []).map(row => {
    return enrichDeclaration(row, account, appBalance, latestTxnDate, txnDates, includedTxnCount);
  });

  const latest = declarations[0] || null;

  return json({
    ok: true,
    version: VERSION,
    account_id: accountId,
    account_name: account.name || accountId,
    app_balance: round2(appBalance),
    current_d1_balance: round2(appBalance),
    latest_transaction_date: latestTxnDate,
    included_transaction_count: includedTxnCount,
    truth: buildTruthAccount(account, appBalance, latest, latestTxnDate, txnDates, includedTxnCount),
    declarations,
    declarations_count: declarations.length
  });
}

async function handleCreateOrUpdate(env, request) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));

  const accountId = text(body.account_id);
  const declaredBalance = Number(body.declared_balance);
  const notes = nullableText(body.notes);
  const declaredBy = text(body.declared_by) || 'operator';

  if (!accountId) {
    return json({ ok: false, version: VERSION, error: 'account_id is required' }, 400);
  }

  if (!Number.isFinite(declaredBalance)) {
    return json({ ok: false, version: VERSION, error: 'declared_balance is required and must be a number' }, 400);
  }

  const account = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?`
  ).bind(accountId).first();

  if (!account) {
    return json({ ok: false, version: VERSION, error: `Account ${accountId} not found` }, 400);
  }

  const txnsRes = await db.prepare(
    `SELECT *
     FROM transactions
     WHERE account_id = ?
        OR transfer_to_account_id = ?`
  ).bind(accountId, accountId).all();

  const ledger = computeLedgerState([account], txnsRes.results || []);
  const appBalance = ledger.balances[account.id] || 0;
  const latestTxnDate = ledger.latestTxnDates[account.id] || null;
  const txnDates = ledger.txnDatesByAccount[account.id] || [];
  const diffAmount = round2(declaredBalance - appBalance);
  const now = new Date().toISOString();
  const txnAfterCount = countTransactionsAfterDeclaration(txnDates, now);
  const status = truthStatus(diffAmount, now, latestTxnDate, txnAfterCount);

  const existing = await db.prepare(
    `SELECT *
     FROM reconciliation
     WHERE account_id = ?`
  ).bind(accountId).first();

  if (existing) {
    const snap = await snapshot(env, 'pre-recon-update-' + existing.id + '-' + Date.now(), declaredBy);
    if (!snap.ok) {
      return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);
    }

    await db.prepare(
      `UPDATE reconciliation
       SET declared_balance = ?,
           declared_at = ?,
           declared_by = ?,
           notes = ?,
           diff_amount = ?
       WHERE account_id = ?`
    ).bind(
      declaredBalance,
      now,
      declaredBy,
      notes,
      diffAmount,
      accountId
    ).run();

    const auditResult = await audit(env, {
      action: 'RECON_DECLARE',
      entity: 'reconciliation',
      entity_id: existing.id,
      kind: 'mutation',
      detail: {
        mode: 'update_existing_account_id',
        account_id: accountId,
        account_name: account.name || accountId,
        declared_balance: declaredBalance,
        app_balance: round2(appBalance),
        diff_amount: diffAmount,
        truth_status: status,
        latest_transaction_date: latestTxnDate,
        transactions_after_declaration_count: txnAfterCount,
        previous: rowSummary(existing),
        snapshot_id: snap.snapshot_id || null,
        api_version: VERSION
      },
      created_by: declaredBy
    });

    return json({
      ok: true,
      version: VERSION,
      id: existing.id,
      account_id: accountId,
      account_name: account.name || accountId,
      declared_balance: round2(declaredBalance),
      app_balance: round2(appBalance),
      current_d1_balance: round2(appBalance),
      diff_amount: diffAmount,
      truth_status: status,
      latest_transaction_date: latestTxnDate,
      transactions_after_declaration_count: txnAfterCount,
      declared_at: now,
      mode: 'update_existing_account_id',
      snapshot_id: snap.snapshot_id || null,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  }

  const id = 'recon_' + uuid();

  await db.prepare(
    `INSERT INTO reconciliation
      (id, account_id, declared_balance, declared_at, declared_by, notes, diff_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    accountId,
    declaredBalance,
    now,
    declaredBy,
    notes,
    diffAmount
  ).run();

  const auditResult = await audit(env, {
    action: 'RECON_DECLARE',
    entity: 'reconciliation',
    entity_id: id,
    kind: 'mutation',
    detail: {
      mode: 'create',
      account_id: accountId,
      account_name: account.name || accountId,
      declared_balance: declaredBalance,
      app_balance: round2(appBalance),
      diff_amount: diffAmount,
      truth_status: status,
      latest_transaction_date: latestTxnDate,
      transactions_after_declaration_count: txnAfterCount,
      api_version: VERSION
    },
    created_by: declaredBy
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    account_id: accountId,
    account_name: account.name || accountId,
    declared_balance: round2(declaredBalance),
    app_balance: round2(appBalance),
    current_d1_balance: round2(appBalance),
    diff_amount: diffAmount,
    truth_status: status,
    latest_transaction_date: latestTxnDate,
    transactions_after_declaration_count: txnAfterCount,
    declared_at: now,
    mode: 'create',
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function handleAddNote(env, id, request) {
  const db = env.DB;
  const body = await request.json().catch(() => ({}));
  const newNote = text(body.note);

  if (!newNote) {
    return json({ ok: false, version: VERSION, error: 'note is required' }, 400);
  }

  const existing = await db.prepare(
    `SELECT *
     FROM reconciliation
     WHERE id = ?`
  ).bind(id).first();

  if (!existing) {
    return json({ ok: false, version: VERSION, error: 'Reconciliation declaration not found' }, 404);
  }

  const snap = await snapshot(env, 'pre-recon-note-' + id + '-' + Date.now(), 'web-reconciliation-note');
  if (!snap.ok) {
    return json({ ok: false, version: VERSION, error: 'Snapshot failed: ' + snap.error }, 500);
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const combined = existing.notes
    ? `${existing.notes}\n\n[${stamp}] ${newNote}`
    : `[${stamp}] ${newNote}`;

  await db.prepare(
    `UPDATE reconciliation
     SET notes = ?
     WHERE id = ?`
  ).bind(combined, id).run();

  const auditResult = await audit(env, {
    action: 'RECON_DECLARE',
    entity: 'reconciliation',
    entity_id: id,
    kind: 'mutation',
    detail: {
      mode: 'note_append',
      appended: newNote,
      snapshot_id: snap.snapshot_id || null,
      api_version: VERSION
    },
    created_by: 'web'
  });

  return json({
    ok: true,
    version: VERSION,
    id,
    mode: 'note_append',
    snapshot_id: snap.snapshot_id || null,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

function computeLedgerState(accounts, transactions) {
  const balances = {};
  const activeIds = new Set();
  const latestTxnDates = {};
  const txnDatesByAccount = {};
  const includedTxnCounts = {};

  for (const account of accounts) {
    balances[account.id] = number(account.opening_balance);
    activeIds.add(account.id);
    latestTxnDates[account.id] = null;
    txnDatesByAccount[account.id] = [];
    includedTxnCounts[account.id] = 0;
  }

  for (const txn of transactions) {
    applyTransactionToLedgerState({
      balances,
      activeIds,
      latestTxnDates,
      txnDatesByAccount,
      includedTxnCounts
    }, txn);
  }

  const roundedBalances = {};
  for (const id of Object.keys(balances)) {
    roundedBalances[id] = round2(balances[id]);
  }

  return {
    balances: roundedBalances,
    latestTxnDates,
    txnDatesByAccount,
    includedTxnCounts
  };
}

function applyTransactionToLedgerState(state, txn) {
  if (!txn || isReversalRelated(txn)) return;

  const type = text(txn.type).toLowerCase();
  const amount = number(txn.amount);
  const fee = number(txn.fee_amount);
  const pra = number(txn.pra_amount);
  const origin = text(txn.account_id);
  const target = text(txn.transfer_to_account_id);
  const txnDate = normalizeDate(txn.date);

  if (type === 'transfer' || type === 'cc_payment') {
    if (origin && state.activeIds.has(origin)) {
      state.balances[origin] -= amount;
      state.balances[origin] -= fee;
      state.balances[origin] -= pra;
      registerTxnDate(state, origin, txnDate);
    }

    if (target && state.activeIds.has(target)) {
      state.balances[target] += amount;
      registerTxnDate(state, target, txnDate);
    }

    return;
  }

  if (!origin || !state.activeIds.has(origin)) return;

  if (TYPE_PLUS.has(type)) {
    state.balances[origin] += amount;
    registerTxnDate(state, origin, txnDate);
    return;
  }

  if (TYPE_MINUS.has(type)) {
    state.balances[origin] -= amount;
    state.balances[origin] -= fee;
    state.balances[origin] -= pra;
    registerTxnDate(state, origin, txnDate);
  }
}

function registerTxnDate(state, accountId, txnDate) {
  if (!accountId || !state.activeIds.has(accountId)) return;

  state.includedTxnCounts[accountId] = (state.includedTxnCounts[accountId] || 0) + 1;

  if (!txnDate) return;

  if (!state.txnDatesByAccount[accountId]) state.txnDatesByAccount[accountId] = [];
  state.txnDatesByAccount[accountId].push(txnDate);

  if (!state.latestTxnDates[accountId] || txnDate > state.latestTxnDates[accountId]) {
    state.latestTxnDates[accountId] = txnDate;
  }
}

function isReversalRelated(txn) {
  if (!txn) return false;

  if (txn.reversed_by != null && text(txn.reversed_by)) return true;
  if (txn.reversed_at != null && text(txn.reversed_at)) return true;

  const notes = text(txn.notes).toUpperCase();

  if (notes.includes('[REVERSAL OF ')) return true;
  if (notes.includes('[REVERSED BY ')) return true;

  return false;
}

function latestDeclarationsByAccount(rows) {
  const sorted = (rows || []).slice().sort((a, b) => {
    return text(b.declared_at).localeCompare(text(a.declared_at));
  });

  const out = {};
  for (const row of sorted) {
    const accountId = text(row.account_id);
    if (!accountId) continue;
    if (!out[accountId]) out[accountId] = row;
  }

  return out;
}

function buildTruthAccount(account, appBalance, declaration, latestTxnDate, txnDates, includedTxnCount) {
  const declared = declaration ? number(declaration.declared_balance) : null;
  const drift = declaration ? round2(declared - appBalance) : null;
  const declaredAt = declaration ? text(declaration.declared_at) : null;
  const txnAfterCount = declaration ? countTransactionsAfterDeclaration(txnDates, declaredAt) : 0;
  const status = declaration ? truthStatus(drift, declaredAt, latestTxnDate, txnAfterCount) : 'undeclared';

  return {
    account_id: account.id,
    account_name: account.name || account.id,
    account_kind: account.kind || account.type || null,
    icon: account.icon || '',
    app_balance: round2(appBalance),
    current_d1_balance: round2(appBalance),
    declared_balance: declaration ? round2(declared) : null,
    drift_amount: drift,
    live_diff_vs_current_d1: drift,
    last_declared_at: declaredAt,
    declared_at: declaredAt,
    declared_by: declaration ? declaration.declared_by || null : null,
    notes: declaration ? declaration.notes || null : null,
    latest_transaction_date: latestTxnDate,
    included_transaction_count: includedTxnCount,
    transactions_after_declaration_count: txnAfterCount,
    truth_status: status,
    truth_explanation: truthExplanation(status, txnAfterCount, latestTxnDate, declaredAt),
    is_clean: status === 'matched',
    is_stale: status === 'stale',
    is_declared: !!declaration
  };
}

function enrichDeclaration(row, account, appBalance, latestTxnDate, txnDates, includedTxnCount) {
  const declared = number(row.declared_balance);
  const drift = round2(declared - appBalance);
  const txnAfterCount = countTransactionsAfterDeclaration(txnDates, row.declared_at);
  const status = truthStatus(drift, row.declared_at, latestTxnDate, txnAfterCount);

  return {
    ...row,
    account_name: account ? account.name || row.account_id : row.account_id,
    account_kind: account ? account.kind || account.type || null : null,
    icon: account ? account.icon || '' : '',
    app_balance: round2(appBalance),
    current_d1_balance: round2(appBalance),
    diff_at_declaration: number(row.diff_amount),
    live_diff_vs_current_d1: drift,
    drift_amount: drift,
    latest_transaction_date: latestTxnDate,
    included_transaction_count: includedTxnCount,
    transactions_after_declaration_count: txnAfterCount,
    truth_status: status,
    truth_explanation: truthExplanation(status, txnAfterCount, latestTxnDate, row.declared_at),
    is_clean: status === 'matched',
    is_stale: status === 'stale'
  };
}

function truthStatus(diff, declaredAt, latestTxnDate, txnAfterCount) {
  if (!declaredAt) return 'undeclared';

  if (txnAfterCount > 0) return 'stale';

  const declaredDate = normalizeDate(declaredAt);
  if (latestTxnDate && declaredDate && latestTxnDate > declaredDate) return 'stale';

  const age = declarationAgeDays(declaredAt);
  if (age != null && age > STALE_DAYS) return 'stale';

  if (Math.abs(number(diff)) >= DRIFT_THRESHOLD) return 'drifted';

  return 'matched';
}

function truthExplanation(status, txnAfterCount, latestTxnDate, declaredAt) {
  if (status === 'undeclared') {
    return 'No real-world balance has been declared yet.';
  }

  if (status === 'stale') {
    if (txnAfterCount > 0) {
      return `${txnAfterCount} ledger transaction(s) happened after the last declaration. Declare again to verify current truth.`;
    }

    return 'The last declaration is older than the freshness window. Declare again to verify current truth.';
  }

  if (status === 'drifted') {
    return 'Declared real balance and app balance differ at the current cutoff.';
  }

  if (status === 'matched') {
    return 'Declared real balance matches the app balance at the current cutoff.';
  }

  return `Latest transaction date: ${latestTxnDate || 'none'} · declared at: ${declaredAt || 'none'}`;
}

function countTransactionsAfterDeclaration(txnDates, declaredAt) {
  const declaredDate = normalizeDate(declaredAt);
  if (!declaredDate) return 0;

  return (txnDates || []).filter(txnDate => txnDate && txnDate > declaredDate).length;
}

function declarationAgeDays(value) {
  const raw = text(value);
  if (!raw) return null;

  const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return null;

  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function rowSummary(row) {
  if (!row) return null;

  return {
    id: row.id,
    account_id: row.account_id,
    declared_balance: number(row.declared_balance),
    declared_at: row.declared_at || null,
    declared_by: row.declared_by || null,
    notes: row.notes || null,
    diff_amount: number(row.diff_amount)
  };
}

function getPath(params) {
  const raw = params && params.path;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(item => text(item));
  return String(raw).split('/').filter(Boolean).map(item => text(item));
}

function normalizeDate(value) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function nullableText(value) {
  const out = text(value);
  return out ? out : null;
}
