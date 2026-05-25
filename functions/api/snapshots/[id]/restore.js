/*  Sovereign Finance  /api/snapshots/:id/restore  v0.3.0  */
/*
 * POST /api/snapshots/:id/restore
 * Body: { confirm: true, idempotency_key: string }
 *
 * 1. Validates session (via middleware context.data.user_id or direct check)
 * 2. Checks idempotency — replays result if key already used
 * 3. Creates safety snapshot
 * 4. Restores all tables from snapshot_data atomically
 * 5. Audits the restore
 */

import { json, audit, snapshot } from '../../_lib.js';
import { getSession } from '../../_lib/auth.js';

const VERSION = 'v0.3.0';

export async function onRequestPost(context) {
  try {
    // Support both middleware-injected user_id and direct session check
    const userId = context.data && context.data.user_id
      ? context.data.user_id
      : null;

    if (!userId) {
      const session = await getSession(context.env, context.request).catch(() => null);
      if (!session) return json({ ok: false, version: VERSION, error: 'Unauthorized' }, 401);
    }

    const snapshotId = context.params.id;
    const body = await readJSON(context.request);

    if (body.confirm !== true) {
      return json({ ok: false, version: VERSION, error: 'confirm:true required' }, 400);
    }

    const idempotencyKey = String(body.idempotency_key || '').trim();
    if (!idempotencyKey) {
      return json({ ok: false, version: VERSION, error: 'idempotency_key required' }, 400);
    }

    // Idempotency check
    const existingRestore = await context.env.DB.prepare(
      `SELECT detail FROM audit_log
       WHERE action = 'SNAPSHOT_RESTORE'
       ORDER BY id DESC LIMIT 50`
    ).all();

    for (const row of (existingRestore.results || [])) {
      try {
        const d = JSON.parse(row.detail || '{}');
        if (d.idempotency_key === idempotencyKey) {
          return json({ ok: true, version: VERSION, ...d, idempotent_replay: true });
        }
      } catch { /* skip */ }
    }

    // Load snapshot
    const snap = await context.env.DB.prepare(
      `SELECT id, label, status, created_at FROM snapshots WHERE id = ?`
    ).bind(snapshotId).first();

    if (!snap) return json({ ok: false, version: VERSION, error: 'Snapshot not found' }, 404);

    const snapData = await context.env.DB.prepare(
      `SELECT table_name, json_data FROM snapshot_data WHERE snapshot_id = ? ORDER BY table_name`
    ).bind(snapshotId).all();

    if (!snapData.results || snapData.results.length === 0) {
      return json({ ok: false, version: VERSION, error: 'Snapshot has no data to restore' }, 400);
    }

    // Safety snapshot first
    const createdBy = userId || 'system';
    const safetyResult = await snapshot(
      context.env,
      `safety-before-restore-${snapshotId}`,
      createdBy
    );

    if (!safetyResult.ok) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Failed to create safety snapshot before restore',
        detail: safetyResult.error
      }, 500);
    }

    // Build batch: DELETE + INSERT per table
    const stmts = [];
    let totalRows = 0;
    const tablesRestored = [];

    for (const { table_name, json_data } of snapData.results) {
      if (!isSafeIdentifier(table_name)) continue;

      let rows;
      try { rows = JSON.parse(json_data || '[]'); } catch { rows = []; }
      if (!Array.isArray(rows) || rows.length === 0) continue;

      stmts.push(context.env.DB.prepare(`DELETE FROM ${table_name}`));

      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const placeholders = cols.map(() => '?').join(', ');
        stmts.push(
          context.env.DB.prepare(
            `INSERT INTO ${table_name} (${cols.join(', ')}) VALUES (${placeholders})`
          ).bind(...cols.map(c => row[c]))
        );
        totalRows++;
      }

      tablesRestored.push(table_name);
    }

    if (stmts.length > 0) await context.env.DB.batch(stmts);

    const result = {
      ok: true,
      version: VERSION,
      restored_from: snapshotId,
      safety_snapshot_id: safetyResult.snapshot_id,
      tables_restored: tablesRestored,
      row_count: totalRows,
      idempotency_key: idempotencyKey,
      restored_at: new Date().toISOString()
    };

    await audit(context.env, {
      action: 'SNAPSHOT_RESTORE',
      entity: 'snapshots',
      entity_id: snapshotId,
      kind: 'mutation',
      detail: result,
      created_by: createdBy
    });

    return json(result);
  } catch (e) {
    return json({ ok: false, version: VERSION, error: e.message || String(e) }, 500);
  }
}

async function readJSON(req) { try { return await req.json(); } catch { return {}; } }

function isSafeIdentifier(name) {
  return /^[a-z_][a-z0-9_]*$/.test(String(name || ''));
}
