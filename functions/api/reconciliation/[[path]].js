/* Sovereign Finance Reconciliation API
 * /api/reconciliation
 * v0.2.0-statement-reconciliation (Phase 2 additive: dashboard)
 *
 * GET  /api/reconciliation   — dashboard summary (additive v0.3 fields)
 * POST /api/reconciliation   — dry_run | save_snapshot (unchanged from v0.1.0)
 *
 * Phase 2 additions (additive, no contract breaks):
 *   - GET response includes dashboard { accounts, transfer_pairs_last_30d, exception_summary }
 *   - GET response exceptions updated to include Phase 2 columns
 *   - New sub-routes (separate files):
 *       POST /api/reconciliation/commit
 *       POST /api/reconciliation/exceptions/:id/resolve
 */

import { getUserId } from '../_lib.js';

const VERSION = 'v0.2.0-statement-reconciliation';

const POSITIVE_TYPES = new Set([
  'income',
  'salary',
  'opening',
  'borrow',
  'debt_in'
]);

const NEGATIVE_TYPES = new Set([
  'expense',
  'transfer',
  'cc_spend',
  'repay',
  'atm',
  'debt_out',
  'cc_payment'
]);

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        }
      }, 500);
    }

    const userId = getUserId(context);
    if (!userId) {
      return json({ ok: false, version: VERSION, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
    }
    const hh = userId;
    const rows          = await buildRows(db, hh);
    const exceptions    = await loadOpenExceptions(db, hh);
    const importSummary = await loadImportSummary(db, hh);
    const dashboard     = await loadDashboard(db, rows, hh);

    return json({
      ok: true,
      version: VERSION,
      source: 'manual_balance_snapshots',
      summary: summarizeRows(rows, exceptions),
      rows,
      exceptions,
      import_summary: importSummary,
      dashboard,
      contract: {
        reconciliation_is_manual:        true,
        app_balance_source:              'transactions_canonical',
        real_balance_source:             'manual_statement_entry',
        mutates_ledger:                  false,
        mutates_accounts:                false,
        auto_adjusts_balances:           false,
        save_snapshot_supported:         true,
        dry_run_supported:               true,
        statement_import_supported:      true,
        dry_run_statement_supported:     true,
        commit_supported:                true,
        exception_resolve_supported:     true
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'RECONCILIATION_GET_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db   = context.env.DB;
    const body = await readJson(context.request);
    const action = clean(body.action || 'dry_run').toLowerCase();

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        }
      }, 500);
    }

    const userId = getUserId(context);
    if (!userId) {
      return json({ ok: false, version: VERSION, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
    }
    const hh = userId;

    if (action === 'dry_run' || action === 'dry-run') {
      return dryRunReconciliation(db, body, hh);
    }

    if (
      action === 'save_snapshot' ||
      action === 'save-snapshot' ||
      action === 'save' ||
      action === 'reconcile'
    ) {
      return saveSnapshot(db, body, hh);
    }

    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'UNSUPPORTED_ACTION',
        message: `Unsupported reconciliation action: ${action}`
      },
      supported_actions: ['dry_run', 'save_snapshot']
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'RECONCILIATION_POST_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

/* ───────────────────────────
 * GET rows
 * ─────────────────────────── */

async function buildRows(db, hh) {
  const accounts        = await loadAccountsWithBalances(db, hh);
  const latestSnapshots = await loadLatestSnapshotsByAccount(db, hh);

  return accounts.map(account => {
    const snapshot    = latestSnapshots.get(account.id) || null;
    const realBalance = snapshot && snapshot.real_balance != null
      ? round2(snapshot.real_balance)
      : null;

    const difference = realBalance == null
      ? null
      : round2(realBalance - account.app_balance);

    return {
      account_id:           account.id,
      account_name:         account.name,
      account_type:         account.type,
      account_kind:         account.kind,
      currency:             account.currency,
      status:               statusForDifference(realBalance, difference),
      app_balance:          account.app_balance,
      app_balance_source:   'transactions_canonical',
      real_balance:         realBalance,
      difference,
      last_snapshot_id:     snapshot ? snapshot.id         : null,
      last_snapshot_at:     snapshot ? snapshot.created_at : null,
      last_statement_date:  snapshot ? snapshot.statement_date : null,
      needs_review:         realBalance != null && Math.abs(difference) > 0.009,
      rule: 'Manual reconciliation compares app balance to statement balance and does not mutate ledger/accounts.'
    };
  });
}

async function loadAccountsWithBalances(db, hh) {
  const accountCols = await tableColumns(db, 'accounts');
  const txCols      = await tableColumns(db, 'transactions');

  if (!accountCols.size || !accountCols.has('id')) return [];

  const accountSelect = [
    'id',
    accountCols.has('name')          ? 'name'          : null,
    accountCols.has('type')          ? 'type'          : null,
    accountCols.has('kind')          ? 'kind'          : null,
    accountCols.has('currency')      ? 'currency'      : null,
    accountCols.has('status')        ? 'status'        : null,
    accountCols.has('display_order') ? 'display_order' : null,
    accountCols.has('deleted_at')    ? 'deleted_at'    : null,
    accountCols.has('archived_at')   ? 'archived_at'   : null
  ].filter(Boolean);

  const acctHhWhere = (hh && accountCols.has('user_id')) ? 'WHERE user_id = ?' : '';
  const accountRows = await db.prepare(
    `SELECT ${accountSelect.join(', ')}
     FROM accounts
     ${acctHhWhere}
     ORDER BY ${accountCols.has('display_order') ? 'display_order,' : ''} id`
  ).bind(...(acctHhWhere ? [hh] : [])).all();

  const accounts = (accountRows.results || []).map(row => ({
    id:          clean(row.id),
    name:        clean(row.name || row.id),
    type:        clean(row.type || 'asset'),
    kind:        clean(row.kind || row.type || 'account'),
    currency:    clean(row.currency || 'PKR'),
    status:      clean(row.status || 'active'),
    deleted_at:  row.deleted_at  || null,
    archived_at: row.archived_at || null,
    app_balance:                       0,
    transaction_count:                 0,
    included_transaction_count:        0,
    skipped_inactive_transaction_count: 0
  })).filter(account => isActiveAccount(account));

  if (!txCols.size || !txCols.has('account_id') || !txCols.has('amount')) {
    return accounts;
  }

  const txSelect = [
    'id',
    txCols.has('type')             ? 'type'             : null,
    txCols.has('transaction_type') ? 'transaction_type' : null,
    'amount',
    'account_id',
    txCols.has('notes')       ? 'notes'       : null,
    txCols.has('reversed_by') ? 'reversed_by' : null,
    txCols.has('reversed_at') ? 'reversed_at' : null
  ].filter(Boolean);

  const txHhWhere = (hh && txCols.has('user_id')) ? 'WHERE user_id = ?' : '';
  const txRows = await db.prepare(
    `SELECT ${txSelect.join(', ')} FROM transactions ${txHhWhere}`
  ).bind(...(txHhWhere ? [hh] : [])).all();

  const byId = new Map(accounts.map(account => [account.id, account]));

  for (const tx of txRows.results || []) {
    const account = byId.get(clean(tx.account_id));
    if (!account) continue;

    account.transaction_count += 1;

    if (isInactiveTransaction(tx)) {
      account.skipped_inactive_transaction_count += 1;
      continue;
    }

    account.app_balance = round2(account.app_balance + signedAmount(tx));
    account.included_transaction_count += 1;
  }

  return accounts.map(account => ({
    ...account,
    app_balance: round2(account.app_balance)
  }));
}

async function loadLatestSnapshotsByAccount(db, hh) {
  const snapshotsExist = await tableExists(db, 'reconciliation_snapshots');
  const map = new Map();

  if (!snapshotsExist) return map;

  const cols = await tableColumns(db, 'reconciliation_snapshots');

  if (!cols.has('account_id')) return map;

  const realCol = cols.has('real_balance')
    ? 'real_balance'
    : cols.has('statement_balance')
      ? 'statement_balance AS real_balance'
      : null;

  if (!realCol) return map;

  const select = [
    cols.has('id') ? 'id' : 'rowid AS id',
    'account_id',
    realCol,
    cols.has('app_balance')    ? 'app_balance'    : 'NULL AS app_balance',
    cols.has('difference')     ? 'difference'     : 'NULL AS difference',
    cols.has('statement_date') ? 'statement_date' : 'NULL AS statement_date',
    cols.has('created_at')     ? 'created_at'     : 'NULL AS created_at'
  ];

  const orderCol = cols.has('created_at') ? 'datetime(created_at)' : 'rowid';

  const hhWhere = (hh && cols.has('user_id')) ? 'WHERE user_id = ?' : '';
  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM reconciliation_snapshots
     ${hhWhere}
     ORDER BY ${orderCol} DESC`
  ).bind(...(hhWhere ? [hh] : [])).all();

  for (const row of res.results || []) {
    const accountId = clean(row.account_id);
    if (!accountId || map.has(accountId)) continue;

    map.set(accountId, {
      id:             row.id,
      account_id:     accountId,
      real_balance:   row.real_balance   == null ? null : number(row.real_balance),
      app_balance:    row.app_balance    == null ? null : number(row.app_balance),
      difference:     row.difference     == null ? null : number(row.difference),
      statement_date: row.statement_date || null,
      created_at:     row.created_at     || null
    });
  }

  return map;
}

async function loadOpenExceptions(db, hh) {
  const exists = await tableExists(db, 'reconciliation_exceptions');
  if (!exists) return [];

  const cols = await tableColumns(db, 'reconciliation_exceptions');
  if (!cols.has('id')) return [];

  const select = [
    'id',
    cols.has('account_id')               ? 'account_id'               : 'NULL AS account_id',
    cols.has('plan_id')                  ? 'plan_id'                  : 'NULL AS plan_id',
    cols.has('type')                     ? 'type'                     : 'NULL AS type',
    cols.has('severity')                 ? 'severity'                 : 'NULL AS severity',
    cols.has('amount')                   ? 'amount'                   : 'NULL AS amount',
    cols.has('description')              ? 'description'              : 'NULL AS description',
    cols.has('reason')                   ? 'reason'                   : 'NULL AS reason',
    cols.has('recommended_action')       ? 'recommended_action'       : 'NULL AS recommended_action',
    cols.has('status')                   ? 'status'                   : "'open' AS status",
    cols.has('created_at')               ? 'created_at'               : 'NULL AS created_at',
    cols.has('resolved_at')              ? 'resolved_at'              : 'NULL AS resolved_at',
    cols.has('resolution_note')          ? 'resolution_note'          : 'NULL AS resolution_note',
    cols.has('account_name')             ? 'account_name'             : 'NULL AS account_name',
    cols.has('app_balance')              ? 'app_balance'              : 'NULL AS app_balance',
    cols.has('real_balance')             ? 'real_balance'             : 'NULL AS real_balance',
    cols.has('difference')               ? 'difference'               : 'NULL AS difference'
  ];

  const statusWhere = cols.has('status')
    ? "(status IS NULL OR status = '' OR status = 'open' OR status = 'needs_review')"
    : '';
  const hhClause = (hh && cols.has('user_id')) ? 'AND user_id = ?' : '';
  const where = [statusWhere, hhClause ? hhClause.replace('AND ', '') : ''].filter(Boolean).join(' AND ');

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM reconciliation_exceptions
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${cols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC
     LIMIT 200`
  ).bind(...(hhClause ? [hh] : [])).all();

  return (res.results || []).map(row => ({
    id:                 row.id,
    account_id:         clean(row.account_id || ''),
    plan_id:            row.plan_id            || null,
    type:               row.type               || null,
    severity:           row.severity           || null,
    amount:             row.amount    == null  ? null : round2(row.amount),
    description:        row.description        || null,
    reason:             row.reason             || null,
    recommended_action: row.recommended_action || null,
    status:             row.status             || 'open',
    created_at:         row.created_at         || null,
    resolved_at:        row.resolved_at        || null,
    resolution_note:    row.resolution_note    || null,
    account_name:       row.account_name       || null,
    app_balance:        row.app_balance  == null ? null : round2(row.app_balance),
    real_balance:       row.real_balance == null ? null : round2(row.real_balance),
    difference:         row.difference   == null ? null : round2(row.difference)
  }));
}

async function loadImportSummary(db, hh) {
  try {
    const exists = await tableExists(db, 'statement_imports');
    if (!exists) return { total_imports: 0, last_import_at: null, last_import_account: null };

    const siCols = await tableColumns(db, 'statement_imports').catch(() => new Set());
    const siHh = (hh && siCols.has('user_id')) ? 'WHERE user_id = ?' : '';
    const totals = await db.prepare(
      `SELECT COUNT(*) AS total, MAX(created_at) AS last_at FROM statement_imports ${siHh}`
    ).bind(...(siHh ? [hh] : [])).first();
    const lastRow = await db.prepare(
      `SELECT account_id FROM statement_imports ${siHh} ORDER BY created_at DESC LIMIT 1`
    ).bind(...(siHh ? [hh] : [])).first();

    return {
      total_imports:       totals?.total    || 0,
      last_import_at:      totals?.last_at  || null,
      last_import_account: lastRow?.account_id || null
    };
  } catch (_) {
    return { total_imports: 0, last_import_at: null, last_import_account: null };
  }
}

async function loadDashboard(db, rows, hh) {
  try {
    const accounts = [];

    const stmtImportsExist = await tableExists(db, 'statement_imports');
    const plansExist       = await tableExists(db, 'reconciliation_plans');
    const excExist         = await tableExists(db, 'reconciliation_exceptions');

    // Detect columns once before the loop
    const siCols  = stmtImportsExist ? await tableColumns(db, 'statement_imports').catch(() => new Set())  : new Set();
    const plCols  = plansExist       ? await tableColumns(db, 'reconciliation_plans').catch(() => new Set()) : new Set();
    const excCols = excExist         ? await tableColumns(db, 'reconciliation_exceptions').catch(() => new Set()) : new Set();

    const siHhAnd  = (hh && siCols.has('user_id'))  ? ' AND user_id = ?' : '';
    const plHhAnd  = (hh && plCols.has('user_id'))  ? ' AND user_id = ?' : '';
    const excHhAnd = (hh && excCols.has('user_id')) ? ' AND user_id = ?' : '';

    for (const row of rows) {
      const acctId = row.account_id;

      let lastStatementDate    = null;
      let lastStatementClosing = null;
      if (stmtImportsExist) {
        const si = await db.prepare(
          `SELECT date_to, statement_closing_balance
           FROM statement_imports WHERE account_id = ?${siHhAnd}
           ORDER BY created_at DESC LIMIT 1`
        ).bind(...[acctId, ...(siHhAnd ? [hh] : [])]).first().catch(() => null);
        if (si) {
          lastStatementDate    = si.date_to || null;
          lastStatementClosing = si.statement_closing_balance != null
            ? round2(si.statement_closing_balance)
            : null;
        }
      }

      let lastReconciledAt = null;
      if (plansExist) {
        const p = await db.prepare(
          `SELECT committed_at FROM reconciliation_plans
           WHERE account_id = ?${plHhAnd} AND committed_at IS NOT NULL
           ORDER BY committed_at DESC LIMIT 1`
        ).bind(...[acctId, ...(plHhAnd ? [hh] : [])]).first().catch(() => null);
        if (p) lastReconciledAt = p.committed_at;
      }

      let openExceptionsCount = 0;
      if (excExist) {
        const e = await db.prepare(
          `SELECT COUNT(*) AS n FROM reconciliation_exceptions
           WHERE account_id = ?${excHhAnd} AND (status IS NULL OR status = '' OR status = 'open')`
        ).bind(...[acctId, ...(excHhAnd ? [hh] : [])]).first().catch(() => null);
        if (e) openExceptionsCount = e.n || 0;
      }

      const drift = lastStatementClosing != null
        ? round2(row.app_balance - lastStatementClosing)
        : null;

      const status = lastStatementClosing == null
        ? 'no_statement'
        : Math.abs(drift) < 0.01
          ? 'reconciled'
          : Math.abs(drift) < 10
            ? 'drift_minor'
            : 'drift_major';

      accounts.push({
        account_id:            acctId,
        name:                  row.account_name,
        app_balance:           row.app_balance,
        last_statement_date:   lastStatementDate,
        last_statement_closing: lastStatementClosing,
        drift,
        status,
        last_reconciled_at:    lastReconciledAt,
        open_exceptions_count: openExceptionsCount
      });
    }

    // Transfer pairs from reconciliation_plans last 30 days
    const transferPairs = [];
    if (plansExist) {
      const cutoff = addDays(todayISO(), -30) + ' 00:00:00';
      const plHhWhere = (hh && plCols.has('user_id'))
        ? 'WHERE created_at >= ? AND user_id = ?'
        : 'WHERE created_at >= ?';
      const plans  = await db.prepare(
        `SELECT account_id, plan_json
         FROM reconciliation_plans
         ${plHhWhere}
         ORDER BY created_at DESC LIMIT 100`
      ).bind(...(plHhWhere.includes('user_id') ? [cutoff, hh] : [cutoff])).all().catch(() => ({ results: [] }));

      for (const p of plans.results || []) {
        try {
          const pd = JSON.parse(p.plan_json || '{}');
          for (const item of pd.plan || []) {
            if (item.classification !== 'TRANSFER_PAIR_FOUND') continue;
            const stmt = item.statement_row;
            if (!stmt) continue;
            const amount = stmt.debit != null
              ? Math.abs(stmt.debit)
              : Math.abs(stmt.credit ?? 0);
            transferPairs.push({
              date:              stmt.posted_date,
              source_account_id: p.account_id,
              dest_account_id:   item.other_account_id || null,
              amount,
              both_sides_found:  true,
              source_tx_id:      null,
              dest_tx_id:        item.matched_ledger_id || null
            });
          }
        } catch (_) {}
      }
    }

    // Exception summary
    const exceptionSummary = { open: 0, resolved: 0, by_type: {} };
    if (excExist) {
      if (excCols.has('status')) {
        const excHhWhere = (hh && excCols.has('user_id')) ? 'WHERE user_id = ?' : '';
        const allExc = await db.prepare(
          `SELECT type, status FROM reconciliation_exceptions ${excHhWhere} LIMIT 2000`
        ).bind(...(excHhWhere ? [hh] : [])).all().catch(() => ({ results: [] }));
        for (const e of allExc.results || []) {
          if (e.status === 'resolved') exceptionSummary.resolved++;
          else exceptionSummary.open++;
          if (e.type) {
            exceptionSummary.by_type[e.type] =
              (exceptionSummary.by_type[e.type] || 0) + 1;
          }
        }
      }
    }

    return { accounts, transfer_pairs_last_30d: transferPairs, exception_summary: exceptionSummary };
  } catch (_) {
    return { accounts: [], transfer_pairs_last_30d: [], exception_summary: { open: 0, resolved: 0, by_type: {} } };
  }
}

/* ───────────────────────────
 * POST dry-run / save
 * ─────────────────────────── */

async function dryRunReconciliation(db, body, hh) {
  const input   = normalizeSnapshotInput(body);
  const rows    = await buildRows(db, hh);
  const account = rows.find(row => row.account_id === input.account_id);

  if (!account) {
    return json({
      ok: false,
      version: VERSION,
      action: 'reconciliation.dry_run',
      error: {
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account not found: ${input.account_id}`
      }
    }, 404);
  }

  if (input.real_balance == null) {
    return json({
      ok: false,
      version: VERSION,
      action: 'reconciliation.dry_run',
      error: {
        code: 'REAL_BALANCE_REQUIRED',
        message: 'real_balance is required.'
      }
    }, 400);
  }

  const result = buildComparison(account, input);

  return json({
    ok: true,
    version: VERSION,
    action: 'reconciliation.dry_run',
    writes_performed: false,
    row: result,
    contract: {
      mutates_ledger:           false,
      mutates_accounts:         false,
      save_required_for_snapshot: true
    }
  });
}

async function saveSnapshot(db, body, hh) {
  await ensureReconciliationTables(db);

  const input   = normalizeSnapshotInput(body);
  const rows    = await buildRows(db, hh);
  const account = rows.find(row => row.account_id === input.account_id);

  if (!account) {
    return json({
      ok: false,
      version: VERSION,
      action: 'reconciliation.save_snapshot',
      error: {
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account not found: ${input.account_id}`
      }
    }, 404);
  }

  if (input.real_balance == null) {
    return json({
      ok: false,
      version: VERSION,
      action: 'reconciliation.save_snapshot',
      error: {
        code: 'REAL_BALANCE_REQUIRED',
        message: 'real_balance is required.'
      }
    }, 400);
  }

  const result     = buildComparison(account, input);
  const now        = nowSql();
  const snapshotId = `recon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const snCols = await tableColumns(db, 'reconciliation_snapshots').catch(() => new Set());
  const snHhCol = snCols.has('user_id') ? ', user_id' : '';
  const snHhVal = snCols.has('user_id') ? ', ?' : '';

  const batch = [
    db.prepare(
      `INSERT INTO reconciliation_snapshots
       (id, account_id, account_name, app_balance, real_balance, difference, statement_date, status, notes, created_at${snHhCol})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${snHhVal})`
    ).bind(
      ...[snapshotId,
      result.account_id,
      result.account_name,
      result.app_balance,
      result.real_balance,
      result.difference,
      input.statement_date,
      result.status,
      input.notes,
      now,
      ...(snHhVal ? [hh] : [])]
    )
  ];

  if (result.needs_review) {
    const exceptionId = `recon_exc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const excSnCols = await tableColumns(db, 'reconciliation_exceptions').catch(() => new Set());
    const excHhCol2 = excSnCols.has('user_id') ? ', user_id' : '';
    const excHhVal2 = excSnCols.has('user_id') ? ', ?' : '';
    batch.push(
      db.prepare(
        `INSERT INTO reconciliation_exceptions
         (id, snapshot_id, account_id, account_name, app_balance, real_balance, difference, status, notes, created_at${excHhCol2})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${excHhVal2})`
      ).bind(
        ...[exceptionId,
        snapshotId,
        result.account_id,
        result.account_name,
        result.app_balance,
        result.real_balance,
        result.difference,
        'needs_review',
        input.notes || 'Manual balance mismatch',
        now,
        ...(excHhVal2 ? [hh] : [])]
      )
    );
  }

  await db.batch(batch);

  const updatedRows  = await buildRows(db, hh);
  const exceptions   = await loadOpenExceptions(db, hh);
  const importSummary = await loadImportSummary(db, hh);

  return json({
    ok: true,
    version: VERSION,
    action: 'reconciliation.save_snapshot',
    writes_performed: true,
    snapshot_id: snapshotId,
    row: {
      ...result,
      last_snapshot_id: snapshotId,
      last_snapshot_at: now
    },
    summary:        summarizeRows(updatedRows, exceptions),
    rows:           updatedRows,
    exceptions,
    import_summary: importSummary,
    contract: {
      mutates_ledger:    false,
      mutates_accounts:  false,
      snapshot_saved:    true,
      exception_created: result.needs_review
    }
  });
}

function normalizeSnapshotInput(body) {
  return {
    account_id:   clean(body.account_id || body.id),
    real_balance: body.real_balance === undefined || body.real_balance === null || body.real_balance === ''
      ? null
      : round2(body.real_balance),
    statement_date: normalizeDate(body.statement_date || body.date) || todayISO(),
    notes:          clean(body.notes || '')
  };
}

function buildComparison(account, input) {
  const realBalance = round2(input.real_balance);
  const appBalance  = round2(account.app_balance);
  const difference  = round2(realBalance - appBalance);
  const needsReview = Math.abs(difference) > 0.009;

  return {
    account_id:          account.account_id,
    account_name:        account.account_name,
    account_type:        account.account_type,
    account_kind:        account.account_kind,
    currency:            account.currency,
    app_balance:         appBalance,
    app_balance_source:  'transactions_canonical',
    real_balance:        realBalance,
    difference,
    statement_date:      input.statement_date,
    status:              needsReview ? 'needs_review' : 'matched',
    needs_review:        needsReview,
    rule: 'Difference = real statement balance - app ledger balance. No automatic ledger adjustment is made.'
  };
}

/* ───────────────────────────
 * Table setup for snapshots
 * ─────────────────────────── */

async function ensureReconciliationTables(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS reconciliation_snapshots (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_name TEXT,
      app_balance REAL NOT NULL,
      real_balance REAL NOT NULL,
      difference REAL NOT NULL,
      statement_date TEXT,
      status TEXT,
      notes TEXT,
      created_at TEXT
    )`
  ).run();

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT,
      account_id TEXT NOT NULL,
      account_name TEXT,
      app_balance REAL,
      real_balance REAL,
      difference REAL,
      status TEXT,
      notes TEXT,
      created_at TEXT
    )`
  ).run();
}

/* ───────────────────────────
 * Summary / rules
 * ─────────────────────────── */

function summarizeRows(rows, exceptions) {
  const accountCount         = rows.length;
  const needsReviewCount     = rows.filter(row => row.needs_review).length;
  const matchedCount         = rows.filter(row => row.status === 'matched').length;
  const pendingStatementCount = rows.filter(row => row.status === 'pending_statement').length;

  return {
    account_count:          accountCount,
    needs_review_count:     needsReviewCount,
    matched_count:          matchedCount,
    pending_statement_count: pendingStatementCount,
    exception_count:        exceptions.length,
    app_balance_total:      round2(rows.reduce((sum, row) => sum + number(row.app_balance, 0), 0)),
    real_balance_total:     rows.some(row => row.real_balance != null)
      ? round2(rows.reduce((sum, row) => sum + number(row.real_balance, 0), 0))
      : null,
    difference_total:       rows.some(row => row.difference != null)
      ? round2(rows.reduce((sum, row) => sum + number(row.difference, 0), 0))
      : null
  };
}

function statusForDifference(realBalance, difference) {
  if (realBalance == null) return 'pending_statement';
  if (Math.abs(number(difference, 0)) <= 0.009) return 'matched';
  return 'needs_review';
}

/* ───────────────────────────
 * Money / transaction helpers
 * ─────────────────────────── */

function signedAmount(tx) {
  const type   = clean(tx.type || tx.transaction_type).toLowerCase();
  const amount = Math.abs(number(tx.amount, 0));

  if (POSITIVE_TYPES.has(type)) return  amount;
  if (NEGATIVE_TYPES.has(type)) return -amount;
  return -amount;
}

function isInactiveTransaction(tx) {
  const notes = String(tx.notes || '').toUpperCase();
  return Boolean(
    tx.reversed_by ||
    tx.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function isActiveAccount(account) {
  const status = clean(account.status || 'active').toLowerCase();
  if (['inactive', 'deleted', 'archived'].includes(status)) return false;
  if (account.deleted_at || account.archived_at) return false;
  return true;
}

/* ───────────────────────────
 * Generic helpers
 * ─────────────────────────── */

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(tableName).first();
    return Boolean(row && row.name);
  } catch {
    return false;
  }
}

async function tableColumns(db, tableName) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function number(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  const n = number(value, 0);
  return Math.round(n * 100) / 100;
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return '';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date((dateStr || todayISO()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
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
