/*  Sovereign Finance  /api/snapshots  v0.2.1  Snapshot Detail Honesty  */
/*
* Handles:
*   GET  /api/snapshots
*   GET  /api/snapshots?id=<snapshot_id>
*   POST /api/snapshots
*
* v0.2.1:
*   - Snapshot detail now exposes snapshot_scope.
*   - Snapshot detail now exposes included_tables, excluded_tables, missing_tables.
*   - Snapshot detail now exposes row_count_by_table.
*   - Works for old snapshots too by deriving coverage from snapshot_data + live sqlite_master tables.
*
* Safety:
*   - GET is read-only.
*   - POST only writes snapshots + snapshot_data + audit_log through snapshot().
*   - Does not mutate finance business tables.
*/

import { json, snapshot } from './_lib.js';

const VERSION = 'v0.2.1';

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

const SYSTEM_TABLES = new Set([
  '_cf_KV',
  'sqlite_sequence'
]);

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const id = cleanText(url.searchParams.get('id'), '', 160);

    if (id) {
      const detail = await getSnapshotDetailPayload(db, id);

      if (!detail.ok) {
        return json(detail, detail.status || 404);
      }

      return json(detail);
    }

    const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);

    const result = await db.prepare(
      `SELECT id, label, status, row_count_total, created_by, created_at
       FROM snapshots
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
    ).bind(limit).all();

    return json({
      ok: true,
      version: VERSION,
      count: (result.results || []).length,
      snapshots: result.results || []
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
    const body = await readJSON(context.request);
    const label = cleanText(
      body.label || body.name || body.reason,
      '',
      120
    );
    const createdBy = cleanText(
      body.created_by || body.createdBy || 'manual-snapshot',
      'manual-snapshot',
      80
    );

    if (!label) {
      return json({
        ok: false,
        version: VERSION,
        error: 'label required'
      }, 400);
    }

    const safeLabel = makeSafeLabel(label);
    const result = await snapshot(context.env, safeLabel, createdBy);

    if (!result || !result.ok) {
      return json({
        ok: false,
        version: VERSION,
        error: result && result.error ? result.error : 'snapshot failed',
        snapshot_result: result || null
      }, 500);
    }

    const snapshotId = result.snapshot_id || result.id;

    if (snapshotId) {
      const detail = await getSnapshotDetailPayload(context.env.DB, snapshotId);

      if (detail.ok) {
        return json({
          ok: true,
          version: VERSION,
          snapshot: {
            ...result,
            snapshot_scope: detail.snapshot_scope,
            included_tables: detail.included_tables,
            excluded_tables: detail.excluded_tables,
            missing_tables: detail.missing_tables,
            row_count_by_table: detail.row_count_by_table,
            table_count: detail.table_count,
            live_table_count: detail.live_table_count,
            coverage_note: detail.coverage_note
          }
        });
      }
    }

    return json({
      ok: true,
      version: VERSION,
      snapshot: result
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function getSnapshotDetailPayload(db, id) {
  const snap = await db.prepare(
    `SELECT id, label, status, row_count_total, created_by, created_at
     FROM snapshots
     WHERE id = ?`
  ).bind(id).first();

  if (!snap) {
    return {
      ok: false,
      version: VERSION,
      status: 404,
      error: 'Snapshot not found'
    };
  }

  const data = await db.prepare(
    `SELECT table_name, row_count
     FROM snapshot_data
     WHERE snapshot_id = ?
     ORDER BY table_name`
  ).bind(id).all();

  const tables = data.results || [];
  const rowCountByTable = {};

  tables.forEach(row => {
    rowCountByTable[row.table_name] = Number(row.row_count) || 0;
  });

  const includedTables = tables
    .map(row => row.table_name)
    .filter(Boolean)
    .sort();

  const liveTables = await getLiveTables(db);
  const liveUserTables = liveTables
    .filter(table => !isSystemTable(table))
    .sort();

  const includedSet = new Set(includedTables);
  const liveUserSet = new Set(liveUserTables);

  const excludedTables = liveUserTables
    .filter(table => !includedSet.has(table));

  const missingCoreTables = CORE_SNAPSHOT_TABLES
    .filter(table => !includedSet.has(table) || !liveUserSet.has(table));

  const capturedMissingLiveTables = includedTables
    .filter(table => !liveUserSet.has(table));

  const missingTables = uniqueSorted([
    ...missingCoreTables,
    ...capturedMissingLiveTables
  ]);

  const snapshotScope = excludedTables.length === 0 && missingTables.length === 0
    ? 'full'
    : 'partial';

  return {
    ok: true,
    version: VERSION,
    snapshot: snap,
    snapshot_scope: snapshotScope,
    coverage_note: snapshotScope === 'full'
      ? 'Snapshot includes every live non-system table.'
      : 'Snapshot is partial. It includes captured tables only and reports excluded live tables explicitly.',
    table_count: tables.length,
    live_table_count: liveUserTables.length,
    included_tables: includedTables,
    excluded_tables: excludedTables,
    missing_tables: missingTables,
    tables,
    row_count_by_table: rowCountByTable
  };
}

async function getLiveTables(db) {
  try {
    const result = await db.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
       ORDER BY name`
    ).all();

    return (result.results || [])
      .map(row => row.name)
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

function isSystemTable(table) {
  const name = String(table || '');

  if (!name) return true;
  if (SYSTEM_TABLES.has(name)) return true;
  if (name.startsWith('sqlite_')) return true;

  return false;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw)
    .trim()
    .slice(0, maxLen || 500);
}

function makeSafeLabel(label) {
  const cleaned = cleanText(label, 'manual-snapshot', 120)
    .replace(/[^\w\s:.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned || 'manual-snapshot';
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort();
}
