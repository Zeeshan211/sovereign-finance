/*  Sovereign Finance  /api/snapshots  v0.2.0  Manual Snapshot Endpoint  */
/*
* Handles:
*   GET  /api/snapshots
*   GET  /api/snapshots?id=<snapshot_id>
*   POST /api/snapshots
*
* Purpose:
*   - Let operator manually create a snapshot before risky finance work.
*   - List recent snapshots.
*   - Inspect one snapshot's table coverage.
*
* Safety:
*   - Read/write only to snapshots + snapshot_data + audit_log through snapshot().
*   - Does not mutate finance business tables.
*   - Snapshot coverage depends on _lib.snapshot().
*/

import { json, snapshot } from './_lib.js';

const VERSION = 'v0.2.0';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const id = cleanText(url.searchParams.get('id'), '', 160);

    if (id) {
      return getSnapshotDetail(db, id);
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

async function getSnapshotDetail(db, id) {
  const snap = await db.prepare(
    `SELECT id, label, status, row_count_total, created_by, created_at
     FROM snapshots
     WHERE id = ?`
  ).bind(id).first();

  if (!snap) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Snapshot not found'
    }, 404);
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

  return json({
    ok: true,
    version: VERSION,
    snapshot: snap,
    table_count: tables.length,
    tables,
    row_count_by_table: rowCountByTable
  });
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
