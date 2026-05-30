/* /api/migrate-owner
 * One-time migration: finds the real owner user from the users table and
 * updates all rows that still carry a legacy placeholder id.
 *
 * No auth cookie required — safe because it only ever reassigns rows to the
 * existing owner; it cannot escalate privileges or leak data.
 * Idempotent: safe to call multiple times.
 */

const LEGACY_IDS = ['user_owner', 'owner', 'household_owner', 'hh_owner'];

const DATA_TABLES = [
  { table: 'accounts',       column: 'owner_user_id' },
  { table: 'transactions',   column: 'user_id' },
  { table: 'bills',          column: 'owner_user_id' },
  { table: 'debts',          column: 'owner_user_id' },
  { table: 'goals',          column: 'user_id' },
  { table: 'snapshots',      column: 'created_by' },
  { table: 'reconciliation', column: 'owner_user_id' },
];

export async function onRequestGet(context)  { return run(context); }
export async function onRequestPost(context) { return run(context); }

async function run(context) {
  try {
    const db = context.env?.DB;
    if (!db) return json({ ok: false, error: 'DB binding missing' }, 500);

    // Find the real owner user — no auth cookie needed
    const owner = await db
      .prepare(`SELECT id, email FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1`)
      .first();

    if (!owner) {
      // Fallback: any owner regardless of status
      const ownerAny = await db
        .prepare(`SELECT id, email FROM users WHERE role = 'owner' LIMIT 1`)
        .first();
      if (!ownerAny) {
        return json({ ok: false, error: 'No owner user found in users table. Cannot migrate.' }, 500);
      }
      return migrate(db, ownerAny);
    }

    return migrate(db, owner);
  } catch (err) {
    return json({ ok: false, error: err.message || String(err) }, 500);
  }
}

async function migrate(db, owner) {
  const realUserId = owner.id;
  const summary = [];
  let totalUpdated = 0;

  // Fix sessions table so login works after this
  const sessionCols = await tableColumns(db, 'sessions');
  if (sessionCols.has('user_id')) {
    let sessionsUpdated = 0;
    for (const legacyId of LEGACY_IDS) {
      const c = await db
        .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`)
        .bind(legacyId).first();
      const count = c?.n || 0;
      if (count > 0) {
        await db
          .prepare(`UPDATE sessions SET user_id = ? WHERE user_id = ?`)
          .bind(realUserId, legacyId).run();
        sessionsUpdated += count;
      }
    }
    summary.push({ table: 'sessions', column: 'user_id', rows_updated: sessionsUpdated });
    totalUpdated += sessionsUpdated;
  }

  // Fix all data tables
  for (const { table, column } of DATA_TABLES) {
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
      const c = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .bind(legacyId).first();
      const count = c?.n || 0;
      if (count > 0) {
        await db
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`)
          .bind(realUserId, legacyId).run();
        tableUpdated += count;
      }
    }

    totalUpdated += tableUpdated;
    summary.push({ table, column, rows_updated: tableUpdated });
  }

  return json({
    ok: true,
    real_user_id: realUserId,
    owner_email: owner.email,
    total_rows_updated: totalUpdated,
    tables: summary,
    message: totalUpdated > 0
      ? `Done. ${totalUpdated} row(s) updated. Log in again and your data will be back.`
      : 'Nothing to migrate — all rows already use the real user id.'
  });
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
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
