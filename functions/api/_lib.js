// ════════════════════════════════════════════════════════════════════
// _lib.js — shared helpers for all /api/* endpoints
// LOCKED · Sub-1D-2b · Self-contained · No external deps
//
// Exports:
//   json(obj, status)      — JSON response helper
//   uuid()                 — short timestamp-based id
//   audit(env, fields)     — write 1 row to audit_log
//   snapshot(env, label)   — full DB backup → snapshots + snapshot_data
// ════════════════════════════════════════════════════════════════════

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function uuid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ─── AUDIT WRITE ────────────────────────────────────────────────────
// fields: { action (REQ), entity, entity_id, kind, detail, created_by, ip }
// action whitelist: TXN_ADD, TXN_EDIT, TXN_REVERSE, TRANSFER, BILL_PAY,
//   DEBT_PAY, GOAL_ALLOC, CC_PAYMENT, SNAPSHOT_CREATE, SNAPSHOT_RESTORE,
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
      fields.detail ? (typeof fields.detail === 'string' ? fields.detail : JSON.stringify(fields.detail)) : null,
      fields.created_by || 'web',
      fields.ip || null
    ).run();
    return { ok: true };
  } catch (e) {
    // Never let audit failure break a mutation
    return { ok: false, error: e.message || String(e) };
  }
}

// ─── SNAPSHOT CREATE ────────────────────────────────────────────────
// Full backup of accounts, transactions, debts, bills, goals, budgets,
// categories, reconciliation. Stores as JSON blobs in snapshot_data.
// Returns { ok, snapshot_id, total_rows } or { ok:false, error }
export async function snapshot(env, label, createdBy = 'system') {
  if (!label) return { ok: false, error: 'snapshot: label required' };

  const snapId = 'snap-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tables = ['accounts', 'transactions', 'debts', 'bills', 'goals', 'budgets', 'categories', 'reconciliation'];

  let totalRows = 0;
  const dataRows = [];

  try {
    // 1. read all 8 tables
    for (const t of tables) {
      try {
        const res = await env.DB.prepare(`SELECT * FROM ${t}`).all();
        const rows = res?.results || [];
        totalRows += rows.length;
        dataRows.push({ table: t, count: rows.length, json: JSON.stringify(rows) });
      } catch (e) {
        // Table may not exist (e.g. reconciliation empty) — skip silently
        dataRows.push({ table: t, count: 0, json: '[]' });
      }
    }

    // 2. write parent record
    await env.DB.prepare(
      `INSERT INTO snapshots (id, label, status, row_count_total, created_by)
       VALUES (?, ?, 'complete', ?, ?)`
    ).bind(snapId, label, totalRows, createdBy).run();

    // 3. write child records (one per table)
    const stmts = dataRows.map(d =>
      env.DB.prepare(
        `INSERT INTO snapshot_data (snapshot_id, table_name, row_count, json_data)
         VALUES (?, ?, ?, ?)`
      ).bind(snapId, d.table, d.count, d.json)
    );
    await env.DB.batch(stmts);

    // 4. audit-log the snapshot itself
    await audit(env, {
      action: 'SNAPSHOT_CREATE',
      entity: 'system',
      entity_id: snapId,
      kind: 'snapshot',
      detail: { label, total_rows: totalRows, tables: dataRows.map(d => ({ t: d.table, n: d.count })) },
      created_by: createdBy
    });

    return { ok: true, snapshot_id: snapId, total_rows: totalRows };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
