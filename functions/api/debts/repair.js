/* functions/api/debts/repair.js
 * v0.1.0-debts-repair-endpoint
 *
 * Standalone endpoint for cleaning up debts that drifted out of sync.
 *
 * URL: /api/debts/repair
 *
 *   GET  /api/debts/repair               → preview (dry run) of every fix that would apply
 *   POST /api/debts/repair               → apply ALL fixes (settle + normalize + archive_orphans)
 *   POST /api/debts/repair?dry_run=1     → preview only (no writes)
 *   POST /api/debts/repair               body { action: 'settle_paid_actives' }
 *                                              { action: 'normalize_terminal_status' }
 *                                              { action: 'archive_orphan_origins' }
 *                                              { action: 'all' }                  ← default
 *
 * Fixes applied:
 *
 *   1. settle_paid_actives
 *      For any debt with original_amount > 0 and paid_amount >= original_amount and
 *      status in {active, '', NULL}: set status='settled'.
 *      Catches: legacy rows, rows updated via PUT without status flip.
 *
 *   2. normalize_terminal_status
 *      For any debt whose status is in {closed, archived, paid, finished, completed, done}
 *      but NOT 'settled': set status='settled'.
 *      Catches: rows like Yusra whose status got set to a non-canonical terminal.
 *
 *   3. archive_orphan_origins
 *      For any debt whose ONLY [DEBT_ORIGIN] transaction is now reversed AND has no
 *      live origin tx: set status='settled' with audit note appended.
 *      Catches: debts where someone reversed the origin from the ledger but
 *      reverse.js never updated the debt row (the bug the user just hit).
 *
 * What this file does NOT do:
 *   - It does not modify [[path]].js
 *   - It does not modify reverse.js
 *   - It does not touch transactions or accounts
 *   - It only writes to the debts table, only status + notes columns
 *
 * Idempotent: running twice in a row is a no-op the second time.
 */

const VERSION = 'v0.1.0-debts-repair-endpoint';

const TERMINAL_STATUSES = new Set([
  'settled', 'archived', 'closed', 'deleted', 'paid', 'finished', 'completed', 'done'
]);
const CANONICAL_TERMINAL = 'settled';

export async function onRequestGet(context) {
  return run(context, /* dryRunForced */ true, /* defaultAction */ 'all');
}

export async function onRequestPost(context) {
  const url = new URL(context.request.url);
  let body = {};
  try { body = await context.request.json(); } catch {}
  const dryRun = url.searchParams.get('dry_run') === '1' || body.dry_run === true || body.dry_run === '1';
  const action = String(body.action || url.searchParams.get('action') || 'all').toLowerCase();
  return run(context, dryRun, action, body);
}

async function run(context, dryRun, action, body = {}) {
  try {
    const db = context.env.DB;
    if (!db) return json({ ok: false, version: VERSION, error: { code: 'DB_BINDING_MISSING' } }, 500);

    const allRows = (await db.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, status, notes FROM debts`
    ).all()).results || [];

    const plan = {
      version: VERSION,
      action,
      dry_run: Boolean(dryRun),
      debts_scanned: allRows.length,
      fixes: {}
    };

    if (action === 'settle_paid_actives' || action === 'all') {
      plan.fixes.settle_paid_actives = await settlePaidActives(db, allRows, dryRun);
    }
    if (action === 'normalize_terminal_status' || action === 'all') {
      plan.fixes.normalize_terminal_status = await normalizeTerminalStatus(db, allRows, dryRun);
    }
    if (action === 'archive_orphan_origins' || action === 'all') {
      plan.fixes.archive_orphan_origins = await archiveOrphanOrigins(db, allRows, dryRun);
    }

    if (!plan.fixes || Object.keys(plan.fixes).length === 0) {
      return json({
        ok: false, ...plan,
        error: { code: 'UNKNOWN_ACTION', message: `Unknown action "${action}". Valid: settle_paid_actives, normalize_terminal_status, archive_orphan_origins, all` }
      }, 400);
    }

    const totalChanges = Object.values(plan.fixes).reduce((s, f) => s + (f.candidates_count || 0), 0);
    plan.total_changes = totalChanges;
    plan.writes_performed = !dryRun && totalChanges > 0;

    return json({ ok: true, ...plan });
  } catch (err) {
    return json({
      ok: false, version: VERSION,
      error: {
        code: 'REPAIR_FAILED',
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : null
      }
    }, 500);
  }
}

/* ─── Fix 1: settle paid actives ──────────────────────────────── */
async function settlePaidActives(db, allRows, dryRun) {
  const candidates = allRows.filter(r => {
    const status = String(r.status || '').trim().toLowerCase();
    if (status !== 'active' && status !== '') return false;
    const original = Number(r.original_amount || 0);
    const paid = Number(r.paid_amount || 0);
    return original > 0 && paid >= original;
  });
  if (!candidates.length) return { candidates_count: 0, candidates: [] };
  const preview = candidates.map(r => ({
    id: r.id, name: r.name, original: Number(r.original_amount || 0),
    paid: Number(r.paid_amount || 0), status_before: r.status || 'active',
    status_after: CANONICAL_TERMINAL
  }));
  if (dryRun) return { candidates_count: candidates.length, candidates: preview, writes_performed: false };
  const batch = candidates.map(r =>
    db.prepare(
      `UPDATE debts SET status = ?, notes = COALESCE(notes,'') || ? WHERE TRIM(id) = TRIM(?) AND (status IS NULL OR status = '' OR status = 'active')`
    ).bind(CANONICAL_TERMINAL, ` | auto-settled by repair endpoint ${nowIso()}: paid_amount>=original_amount`, String(r.id || ''))
  );
  await db.batch(batch);
  return { candidates_count: candidates.length, candidates: preview, writes_performed: true };
}

/* ─── Fix 2: normalize terminal status vocabulary ─────────────── */
async function normalizeTerminalStatus(db, allRows, dryRun) {
  const candidates = allRows.filter(r => {
    const status = String(r.status || '').trim().toLowerCase();
    return TERMINAL_STATUSES.has(status) && status !== CANONICAL_TERMINAL;
  });
  if (!candidates.length) return { candidates_count: 0, candidates: [] };
  const preview = candidates.map(r => ({
    id: r.id, name: r.name, status_before: r.status, status_after: CANONICAL_TERMINAL
  }));
  if (dryRun) return { candidates_count: candidates.length, candidates: preview, writes_performed: false };
  const batch = candidates.map(r =>
    db.prepare(
      `UPDATE debts SET status = ?, notes = COALESCE(notes,'') || ? WHERE TRIM(id) = TRIM(?)`
    ).bind(CANONICAL_TERMINAL, ` | normalized status from "${r.status}" to "${CANONICAL_TERMINAL}" by repair endpoint ${nowIso()}`, String(r.id || ''))
  );
  await db.batch(batch);
  return { candidates_count: candidates.length, candidates: preview, writes_performed: true };
}

/* ─── Fix 3: archive debts whose origin tx was reversed ───────── */
async function archiveOrphanOrigins(db, allRows, dryRun) {
  // Only consider debts that are still "active" (not yet settled/closed/etc.)
  const activeDebts = allRows.filter(r => {
    const s = String(r.status || '').trim().toLowerCase();
    return s === 'active' || s === '';
  });
  if (!activeDebts.length) return { candidates_count: 0, candidates: [] };

  // Load all transactions whose notes mention any debt_id, with their reversal state.
  const txCols = (await db.prepare(`PRAGMA table_info(transactions)`).all()).results || [];
  const hasNotes = txCols.some(c => c.name === 'notes');
  const hasReversedBy = txCols.some(c => c.name === 'reversed_by');
  const hasReversedAt = txCols.some(c => c.name === 'reversed_at');
  if (!hasNotes) return { candidates_count: 0, candidates: [], reason: 'transactions.notes column missing' };

  // Pull every tx with [DEBT_ORIGIN] or [DEBT_ORIGIN_REPAIR] marker.
  const originRes = await db.prepare(
    `SELECT id, notes, ${hasReversedBy ? 'reversed_by' : 'NULL AS reversed_by'}, ${hasReversedAt ? 'reversed_at' : 'NULL AS reversed_at'}
       FROM transactions
      WHERE notes LIKE '%[DEBT_ORIGIN%'`
  ).all();
  const originTxs = originRes.results || [];

  const originByDebtId = new Map();
  for (const tx of originTxs) {
    const m = String(tx.notes || '').match(/debt_id=([A-Za-z0-9_\-]+)/);
    if (!m) continue;
    const did = m[1];
    if (!originByDebtId.has(did)) originByDebtId.set(did, []);
    originByDebtId.get(did).push(tx);
  }

  const isReversed = tx => Boolean(tx.reversed_by) || Boolean(tx.reversed_at);

  const candidates = [];
  for (const debt of activeDebts) {
    const origins = originByDebtId.get(String(debt.id)) || [];
    if (origins.length === 0) continue;
    const live = origins.filter(t => !isReversed(t));
    const reversed = origins.filter(isReversed);
    if (live.length === 0 && reversed.length > 0) {
      candidates.push({
        id: debt.id, name: debt.name,
        original: Number(debt.original_amount || 0),
        paid: Number(debt.paid_amount || 0),
        status_before: debt.status || 'active',
        reversed_origin_tx_ids: reversed.map(t => t.id),
        status_after: CANONICAL_TERMINAL
      });
    }
  }

  if (!candidates.length) return { candidates_count: 0, candidates: [] };
  if (dryRun) return { candidates_count: candidates.length, candidates, writes_performed: false };

  const batch = candidates.map(c =>
    db.prepare(
      `UPDATE debts SET status = ?, notes = COALESCE(notes,'') || ? WHERE TRIM(id) = TRIM(?) AND (status IS NULL OR status = '' OR status = 'active')`
    ).bind(
      CANONICAL_TERMINAL,
      ` | auto-archived by repair endpoint ${nowIso()}: origin tx${c.reversed_origin_tx_ids.length > 1 ? 's' : ''} reversed (${c.reversed_origin_tx_ids.join(', ')})`,
      String(c.id || '')
    )
  );
  await db.batch(batch);
  return { candidates_count: candidates.length, candidates, writes_performed: true };
}

function nowIso() { return new Date().toISOString(); }

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
