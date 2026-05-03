// ════════════════════════════════════════════════════════════════════
// /api/snapshots — list, create, restore (read-only restore in next phase)
// LOCKED · Sub-1D-2b
//
// GET  /api/snapshots             → list latest 20 snapshots
// GET  /api/snapshots?id=snap-X   → fetch full detail (parent + per-table counts)
// POST /api/snapshots             → create new snapshot {label, created_by?}
// ════════════════════════════════════════════════════════════════════

import { json, snapshot } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id  = url.searchParams.get('id');

  try {
    if (id) {
      // Single snapshot detail
      const parent = await env.DB.prepare(
        `SELECT id, created_at, label, status, row_count_total, created_by, notes
         FROM snapshots WHERE id = ?`
      ).bind(id).first();

      if (!parent) return json({ ok: false, error: 'Snapshot not found' }, 404);

      const children = await env.DB.prepare(
        `SELECT table_name, row_count
         FROM snapshot_data WHERE snapshot_id = ?
         ORDER BY table_name`
      ).bind(id).all();

      return json({
        ok: true,
        snapshot: parent,
        tables: children?.results || []
      });
    }

    // List latest 20
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const list = await env.DB.prepare(
      `SELECT id, created_at, label, status, row_count_total, created_by
       FROM snapshots
       ORDER BY created_at DESC
       LIMIT ?`
    ).bind(limit).all();

    return json({
      ok: true,
      count: list?.results?.length || 0,
      snapshots: list?.results || []
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const label     = (body.label || '').trim();
  const createdBy = body.created_by || 'web-manual';

  if (!label) return json({ ok: false, error: 'label required' }, 400);
  if (label.length > 100) return json({ ok: false, error: 'label too long (max 100)' }, 400);

  const result = await snapshot(env, label, createdBy);
  if (!result.ok) return json(result, 500);
  return json(result);
}
