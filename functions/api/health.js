/* /api/health
 * Sovereign Finance · Backend Contract Health
 * v0.1.0-backend-contract-health
 *
 * Phase 1 purpose:
 * - Global backend health endpoint.
 * - Confirms DB binding exists.
 * - Confirms core Phase 1 tables exist.
 * - Exposes backend contract versions.
 */

const VERSION = 'v0.1.0-backend-contract-health';

export async function onRequestGet(context) {
  const startedAt = new Date().toISOString();

  try {
    const db = context.env.DB;

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        checked_at: startedAt,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        },
        services: serviceMap(false, 'DB binding missing'),
        invariants: invariantMap(false)
      }, 500);
    }

    const tableChecks = {
      accounts: await tableExists(db, 'accounts'),
      transactions: await tableExists(db, 'transactions'),
      debts: await tableExists(db, 'debts'),
      debt_payments: await tableExists(db, 'debt_payments'),
      salary_contracts: await tableExists(db, 'salary_contracts'),
      reconciliation_snapshots: await tableExists(db, 'reconciliation_snapshots')
    };

    const transactionCols = tableChecks.transactions.exists
      ? await tableColumns(db, 'transactions')
      : new Set();

    const accountCols = tableChecks.accounts.exists
      ? await tableColumns(db, 'accounts')
      : new Set();

    const ledgerOk =
      tableChecks.transactions.exists &&
      transactionCols.has('id') &&
      transactionCols.has('amount') &&
      transactionCols.has('account_id');

    const accountsOk =
      tableChecks.accounts.exists &&
      accountCols.has('id');

    const reversedTransactionsExcluded = transactionCols.has('reversed_by') || transactionCols.has('reversed_at');

    return json({
      ok: ledgerOk && accountsOk,
      version: VERSION,
      checked_at: startedAt,
      phase: 'Phase 1 — Ledger / Accounts / Health backend spine',
      services: {
        ledger: {
          ok: ledgerOk,
          version: 'v0.2.0-linked-reversal-engine',
          endpoint: '/api/ledger',
          table: 'transactions',
          details: {
            transactions_table_exists: tableChecks.transactions.exists,
            required_columns_present: ledgerOk
          }
        },
        accounts: {
          ok: accountsOk,
          version: 'v0.2.0-ledger-balance-source',
          endpoint: '/api/balances',
          table: 'accounts',
          details: {
            accounts_table_exists: tableChecks.accounts.exists,
            required_columns_present: accountsOk,
            balance_source: 'transactions_canonical'
          }
        },
        health: {
          ok: true,
          version: VERSION,
          endpoint: '/api/health'
        },
        debts: {
          ok: tableChecks.debts.exists,
          version: 'pending-phase-2',
          phase: 'Phase 2',
          table: 'debts'
        },
        salary: {
          ok: tableChecks.salary_contracts.exists,
          version: 'pending-phase-3',
          phase: 'Phase 3',
          table: 'salary_contracts'
        },
        forecast: {
          ok: true,
          version: 'pending-phase-4',
          phase: 'Phase 4',
          source: 'aggregate endpoint later'
        },
        reconciliation: {
          ok: tableChecks.reconciliation_snapshots.exists,
          version: 'pending-phase-5',
          phase: 'Phase 5',
          table: 'reconciliation_snapshots'
        }
      },
      invariants: {
        db_available: true,
        ledger_table_available: tableChecks.transactions.exists,
        accounts_table_available: tableChecks.accounts.exists,
        account_balance_source: 'transactions_canonical',
        reversed_transactions_excluded: reversedTransactionsExcluded,
        debt_status_consistent: 'pending-phase-2',
        forecast_matches_accounts: 'pending-phase-4'
      },
      tables: tableChecks
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      checked_at: startedAt,
      error: {
        code: 'HEALTH_CHECK_FAILED',
        message: err.message || String(err)
      },
      services: serviceMap(false, err.message || String(err)),
      invariants: invariantMap(false)
    }, 500);
  }
}

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(tableName).first();

    return {
      exists: Boolean(row && row.name),
      name: tableName
    };
  } catch (err) {
    return {
      exists: false,
      name: tableName,
      error: err.message || String(err)
    };
  }
}

async function tableColumns(db, tableName) {
  const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  const cols = new Set();

  for (const row of result.results || []) {
    if (row.name) cols.add(row.name);
  }

  return cols;
}

function serviceMap(ok, reason) {
  return {
    ledger: { ok, reason },
    accounts: { ok, reason },
    health: { ok, reason },
    debts: { ok: false, reason: 'pending-phase-2' },
    salary: { ok: false, reason: 'pending-phase-3' },
    forecast: { ok: false, reason: 'pending-phase-4' },
    reconciliation: { ok: false, reason: 'pending-phase-5' }
  };
}

function invariantMap(ok) {
  return {
    db_available: ok,
    ledger_table_available: ok,
    accounts_table_available: ok,
    reversed_transactions_excluded: ok,
    debt_status_consistent: 'pending-phase-2',
    forecast_matches_accounts: 'pending-phase-4'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
