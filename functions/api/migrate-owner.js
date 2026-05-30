/* /api/migrate-owner
 * One-time migration: updates all DB rows that still carry the legacy
 * placeholder user id ('user_owner') to the real authenticated user's id.
 *
 * Protected by _middleware.js — only the owner session can call this.
 * Safe to call multiple times (idempotent — rows already on real UUID are untouched).
 *
 * Usage: POST /api/migrate-owner
 * Returns: JSON summary of rows updated per table.
 */

const LEGACY_IDS = ['user_owner', 'owner', 'household_owner', 'hh_owner'];

const TABLES = [
  { table: 'accounts',       column: 'owner_user_id' },
  { table: 'transactions',   column: 'user_id' },
  { table: 'bills',          column: 'owner_user_id' },
  { table: 'debts',          column: 'owner_user_id' },
  { table: 'goals',          column: 'user_id' },
  { table: 'snapshots',      column: 'created_by' },
  { table: 'reconciliation', column: 'owner_user_id' },
];

export async function onRequestPost(context) {
  try {
    const db = context.env?.DB;
    if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);

    const realUserId = context.data?.user_id;
    if (!realUserId) return json({ ok: false, error: 'No authenticated user_id' }, 401);

    const summary = [];
    let totalUpdated = 0;

    for (const { table, column } of TABLES) {
      // Skip tables that don't exist
      const cols = await tableColumns(db, table);
      if (!cols.size) {
        summary.push({ table, column, skipped: true, reason: 'table not found' });
        continue;
      }
      if (!cols.has(column)) {
        summary.push({ table, column, skipped: true, reason: 'column not found' });
        continue;
      }

      let tableUpdated = 0;
      for (const legacyId of LEGACY_IDS) {
        // Count first so we can report accurately
        const countRow = await db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
          .bind(legacyId)
          .first();
        const count = countRow?.n || 0;

        if (count > 0) {
          await db
            .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
            .bind(realUserId, legacyId)
            .run();
          tableUpdated += count;
        }
      }

      totalUpdated += tableUpdated;
      summary.push({ table, column, rows_updated: tableUpdated });
    }

    return json({
      ok: true,
      real_user_id: realUserId,
      total_rows_updated: totalUpdated,
      tables: summary,
      message: totalUpdated > 0
        ? `Migration complete. ${totalUpdated} row(s) updated to real user id.`
        : 'Nothing to migrate — all rows already use the real user id (or tables are empty).'
    });
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, 500);
  }
}

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const set = new Set();
    for (const row of result.results || []) {
      if (row.name) set.add(row.name);
    }
    return set;
  } catch {
    return new Set();
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
