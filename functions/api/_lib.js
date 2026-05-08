// _lib.js  shared helpers for all /api/* endpoints
// v0.2.0  Snapshot honesty / scope reporting
//
// LOCKED  Sub-1D-2b  Self-contained  No external deps
//
// Exports:
//   json(obj, status)       JSON response helper
//   uuid()                  short timestamp-based id
//   audit(env, fields)      write 1 row to audit_log
//   snapshot(env, label)    scoped DB backup into snapshots + snapshot_data
//
// Snapshot honesty contract:
//   - snapshot() does NOT claim full DB coverage unless every live non-system table is included.
//   - It reports included_tables, excluded_tables, missing_tables, row_count_by_table,
//     table_count, total_rows, and snapshot_scope.
//   - Current default is finance-core snapshot coverage, not whole-database coverage.

const LIB_VERSION = 'v0.2.0';

const CORE_SNAPSHOT_TABLES = [
  'accounts',
  'transactions',
  'debts',
  'bills',
  'goals',
  'budgets',
  'categories',
  'reconciliation'
];

const ALWAYS_EXCLUDED_TABLES = new Set([
  '_cf_KV',
  'sqlite_sequence'
]);

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function uuid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

//  AUDIT WRITE
// fields: { action (REQ), entity, entity_id, kind, detail, created_by, ip }
// action examples:
//   TXN_ADD, TXN_EDIT, TXN_REVERSE, TRANSFER, BILL_PAY,
//   DEBT_PAY, DEBT_RECEIVE, GOAL_ALLOC, CC_PAYMENT,
//   SNAPSHOT_CREATE, SNAPSHOT_RESTORE,
//   RECON_DECLARE, MIGRATION_FROM_SHEET, SCHEMA_MIGRATION
export async function audit(env, fields) {
  if (!fields || !fields.action) return { ok: false, error: 'audit: action required' };

  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, action, entity, entity_id, kind, detail, created_by, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      uuid(),
      fields.action,
      fields.entity || null,
      fields.entity_id || null,
      fields.kind || 'mutation',
      fields.detail
        ? (typeof fields.detail === 'string'
          ? fields.detail
          : JSON.stringify(fields.detail))
        : null,
      fields.created_by || 'web',
      fields.ip || null
    ).run();

    return { ok: true };
  } catch (e) {
    // Never let audit failure break a mutation.
    return { ok: false, error: e.message || String(e) };
  }
}

//  SNAPSHOT CREATE
// Scoped backup of finance-core tables into snapshots + snapshot_data.
//
// Current included tables:
//   accounts, transactions, debts, bills, goals, budgets, categories, reconciliation
//
// Current behavior:
//   - Included tables are backed up as JSON blobs in snapshot_data.
//   - Missing included tables are recorded as missing_tables and stored as [] for compatibility.
//   - Live tables outside CORE_SNAPSHOT_TABLES are reported as excluded_tables.
//   - snapshot_scope is:
//       "full"    only if no live non-system table is excluded and no included table is missing
//       "partial" otherwise
//
// Returns:
//   {
//     ok,
//     version,
//     snapshot_id,
//     snapshot_scope,
//     total_rows,
//     table_count,
//     included_tables,
//     excluded_tables,
//     missing_tables,
//     row_count_by_table
//   }
export async function snapshot(env, label, createdBy = 'system') {
  if (!label) return { ok: false, version: LIB_VERSION, error: 'snapshot: label required' };

  const snapId = 'snap-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const includedTables = [...CORE_SNAPSHOT_TABLES];
  const rowCountByTable = {};
  const dataRows = [];
  let totalRows = 0;

  try {
    const liveTables = await getLiveTables(env);
    const liveUserTables = liveTables.filter(t => !isSystemTable(t));
    const liveUserSet = new Set(liveUserTables);
    const includedSet = new Set(includedTables);

    const missingTables = includedTables.filter(t => !liveUserSet.has(t));
    const excludedTables = liveUserTables.filter(t => !includedSet.has(t));
    const snapshotScope = (missingTables.length === 0 && excludedTables.length === 0)
      ? 'full'
      : 'partial';

    for (const table of includedTables) {
      try {
        const res = await env.DB.prepare(`SELECT * FROM ${safeIdentifier(table)}`).all();
        const rows = res && res.results ? res.results : [];
        const count = rows.length;

        rowCountByTable[table] = count;
        totalRows += count;
        dataRows.push({
          table,
          count,
          json: JSON.stringify(rows),
          status: 'included'
        });
      } catch (e) {
        rowCountByTable[table] = 0;
        dataRows.push({
          table,
          count: 0,
          json: '[]',
          status: 'missing_or_unreadable',
          error: e.message || String(e)
        });

        if (!missingTables.includes(table)) {
          missingTables.push(table);
        }
      }
    }

    await env.DB.prepare(
      `INSERT INTO snapshots (id, label, status, row_count_total, created_by)
       VALUES (?, ?, 'complete', ?, ?)`
    ).bind(snapId, label, totalRows, createdBy).run();

    const stmts = dataRows.map(d =>
      env.DB.prepare(
        `INSERT INTO snapshot_data (snapshot_id, table_name, row_count, json_data)
         VALUES (?, ?, ?, ?)`
      ).bind(snapId, d.table, d.count, d.json)
    );

    if (stmts.length) {
      await env.DB.batch(stmts);
    }

    const summary = {
      version: LIB_VERSION,
      label,
      snapshot_id: snapId,
      snapshot_scope: snapshotScope,
      coverage_note: snapshotScope === 'full'
        ? 'Snapshot includes every live non-system table.'
        : 'Snapshot is partial. It includes finance-core tables only and reports excluded live tables explicitly.',
      total_rows: totalRows,
      table_count: includedTables.length,
      live_table_count: liveUserTables.length,
      included_tables: includedTables,
      excluded_tables: excludedTables,
      missing_tables: missingTables,
      row_count_by_table: rowCountByTable,
      tables: dataRows.map(d => ({
        t: d.table,
        n: d.count,
        status: d.status
      }))
    };

    await audit(env, {
      action: 'SNAPSHOT_CREATE',
      entity: 'system',
      entity_id: snapId,
      kind: 'snapshot',
      detail: summary,
      created_by: createdBy
    });

    return {
      ok: true,
      ...summary
    };
  } catch (e) {
    return { ok: false, version: LIB_VERSION, error: e.message || String(e) };
  }
}

async function getLiveTables(env) {
  try {
    const res = await env.DB.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
       ORDER BY name`
    ).all();

    return (res.results || [])
      .map(row => row.name)
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function isSystemTable(table) {
  const name = String(table || '');

  if (!name) return true;
  if (ALWAYS_EXCLUDED_TABLES.has(name)) return true;
  if (name.startsWith('sqlite_')) return true;

  return false;
}

function safeIdentifier(identifier) {
  const value = String(identifier || '');

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Unsafe SQL identifier: ' + value);
  }

  return value;
}
