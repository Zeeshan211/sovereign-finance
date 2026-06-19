/* Sovereign Finance — Reconciliation Commit
 * POST /api/reconciliation/commit
 * contract_version: reconciliation-v0.3
 *
 * Commits a saved dry-run plan, importing only safe classifications:
 *   MISSING_SAFE_TO_IMPORT   → create expense or income transaction
 *   TRANSFER_PAIR_FOUND      → create the missing side (expense or income)
 *
 * Never auto-commits: POSSIBLE_DUPLICATE, PENDING_UNPOSTED, NEEDS_REVIEW,
 *                     TRANSFER_PAIR_MISSING, DO_NOT_IMPORT
 *
 * All ledger writes go through POST /api/transactions (self-call).
 * Idempotency: re-running the same plan_id returns 0 new writes.
 *
 * Multi-tenancy: every SELECT/INSERT is scoped to the authenticated household.
 */

import { householdOf } from '../_lib.js';

const VERSION = 'reconciliation-v0.3';

const COMMIT_SAFE = new Set(['MISSING_SAFE_TO_IMPORT', 'TRANSFER_PAIR_FOUND']);

const EXCEPTION_TYPE_MAP = {
  POSSIBLE_DUPLICATE:    'DUPLICATE_RISK',
  TRANSFER_PAIR_MISSING: 'MISSING_COUNTERPARTY',
  PENDING_UNPOSTED:      'PENDING_UNPOSTED',
  NEEDS_REVIEW:          'WEAK_TRAIL',
};

const EXCEPTION_SEVERITY = {
  POSSIBLE_DUPLICATE:    'high',
  TRANSFER_PAIR_MISSING: 'medium',
  PENDING_UNPOSTED:      'low',
  NEEDS_REVIEW:          'medium',
};

const RECOMMENDED_ACTION = {
  POSSIBLE_DUPLICATE:    'Verify this is not a duplicate before importing',
  TRANSFER_PAIR_MISSING: 'Create matching transfer entry in the other account',
  PENDING_UNPOSTED:      'Wait for the transaction to post, then re-reconcile',
  NEEDS_REVIEW:          'Review and manually match or import',
};

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return json(errBody('DB binding missing', 'DB_BINDING_MISSING'), 500);

    const hh = householdOf(context);
    if (!hh) return json(errBody('Unauthorized', 'UNAUTHORIZED'), 401);

    const body      = await readJson(context.request);
    const planId    = clean(body.plan_id);
    const idemKey   = clean(body.idempotency_key);
    const confirmed = body.confirm === true;

    const rawCls = Array.isArray(body.selected_classifications)
      ? body.selected_classifications
      : null;
    const selectedCls = rawCls
      ? new Set(rawCls.filter(c => COMMIT_SAFE.has(c)))
      : COMMIT_SAFE;

    if (!planId)    return json(errBody('plan_id is required',         'PLAN_ID_REQUIRED'),         400);
    if (!confirmed) return json(errBody('confirm must be true',        'CONFIRM_REQUIRED'),         400);
    if (!idemKey)   return json(errBody('idempotency_key is required', 'IDEMPOTENCY_KEY_REQUIRED'), 400);

    await ensureExceptionsTable(db);

    // Scope reconciliation_plans SELECT by household_id when column exists
    const plansHhClause = await colExists(db, 'reconciliation_plans', 'user_id');
    const planRow = await db.prepare(
      `SELECT id, account_id, plan_json, committed_at
       FROM reconciliation_plans
       WHERE id = ?${plansHhClause ? ' AND user_id = ?' : ''}
       LIMIT 1`
    ).bind(...(plansHhClause ? [planId, hh] : [planId])).first().catch(() => null);

    if (!planRow) return json(errBody(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND'), 404);

    // Idempotent re-run: plan already committed
    if (planRow.committed_at) {
      return json({
        ok:                        true,
        version:                   VERSION,
        plan_id:                   planId,
        committed_count:           0,
        committed_transaction_ids: [],
        skipped_count:             0,
        skipped_to_exceptions:     [],
        projected_balance_before:  null,
        projected_balance_after:   null,
        warnings:                  ['Plan already committed — idempotent re-run returns no new writes.'],
        is_idempotent:             true
      });
    }

    let planData;
    try   { planData = JSON.parse(planRow.plan_json || '{}'); }
    catch (_) { planData = {}; }

    const planItems = Array.isArray(planData.plan) ? planData.plan : [];
    const origin    = new URL(context.request.url).origin;
    const now       = nowSql();

    const balanceBefore = await computeAppBalance(db, planRow.account_id, hh);

    const committedIds = [];
    const exceptionIds = [];

    // Check household_id column existence once for exceptions table
    const excHhClause = await colExists(db, 'reconciliation_exceptions', 'user_id');

    for (const item of planItems) {
      const cls = item.classification;

      // Non-safe items: write exceptions for items that need attention
      if (!selectedCls.has(cls) || !COMMIT_SAFE.has(cls)) {
        if (EXCEPTION_TYPE_MAP[cls]) {
          const stmt = item.statement_row;
          const excId = `exc_${Date.now()}_${rand()}`;
          await writeException(db, {
            id:           excId,
            plan_id:      planId,
            account_id:   planRow.account_id,
            user_id: excHhClause ? hh : undefined,
            stmt_tx_id:   stmt?.id || null,
            ledger_tx_id: item.matched_ledger_id || null,
            type:         EXCEPTION_TYPE_MAP[cls],
            severity:     EXCEPTION_SEVERITY[cls] || 'medium',
            amount:       stmt != null ? Math.abs(stmt.debit ?? stmt.credit ?? 0) : null,
            description:  stmt?.description || item.matched_ledger?.notes || null,
            reason:       item.reason || cls,
            action:       RECOMMENDED_ACTION[cls] || 'Review manually',
            now
          });
          exceptionIds.push(excId);
        }
        continue;
      }

      // Safe items: commit via /api/transactions
      const stmt = item.statement_row;
      if (!stmt) continue;

      const isDebit  = stmt.debit != null;
      const amount   = isDebit
        ? Math.abs(stmt.debit ?? 0)
        : Math.abs(stmt.credit ?? 0);
      if (amount <= 0) continue;

      const txType  = isDebit ? 'expense' : 'income';
      // Content-based idempotency key (Phase 0 — no-flaw guard).
      // Keyed on the transaction's own identity (account + date + signed
      // amount + running balance), NOT the plan_id. This makes re-pasting the
      // same statement a guaranteed no-op even though it produces a new
      // plan_id, while the running balance disambiguates genuinely-distinct
      // same-day/same-amount transactions (they cannot share one balance).
      const rowIdem = await contentIdemKey(planRow.account_id, stmt, isDebit, amount);

      const txPayload = {
        type:            txType,
        amount,
        account_id:      planRow.account_id,
        date:            stmt.posted_date,
        notes:           stmt.description || null,
        idempotency_key: rowIdem,
        source_module:   'reconciliation',
        source_id:       planId,
        source_action:   'commit',
        created_by:      'reconciliation-commit-v0.3'
      };

      const result = await commitOneTransaction(origin, txPayload);

      if (result.ok || result.idempotent_replay) {
        const txId = result.id || result.transaction_id
          || (Array.isArray(result.ids) ? result.ids[0] : null)
          || rowIdem;
        committedIds.push(txId);
      } else {
        const excId = `exc_${Date.now()}_${rand()}`;
        await writeException(db, {
          id:           excId,
          plan_id:      planId,
          account_id:   planRow.account_id,
          user_id: excHhClause ? hh : undefined,
          stmt_tx_id:   stmt.id || null,
          ledger_tx_id: null,
          type:         'NO_STATEMENT_PROOF',
          severity:     'high',
          amount,
          description:  stmt.description || null,
          reason:       result.error || result.code || 'Transaction creation failed',
          action:       'Review and create the transaction manually',
          now
        });
        exceptionIds.push(excId);
      }
    }

    // Mark plan as committed
    await db.prepare(
      `UPDATE reconciliation_plans SET committed_at = ? WHERE id = ?`
    ).bind(now, planId).run().catch(() => {});

    const balanceAfter = await computeAppBalance(db, planRow.account_id, hh);

    return json({
      ok:                        true,
      version:                   VERSION,
      plan_id:                   planId,
      committed_count:           committedIds.length,
      committed_transaction_ids: committedIds,
      skipped_count:             exceptionIds.length,
      skipped_to_exceptions:     exceptionIds,
      projected_balance_before:  balanceBefore,
      projected_balance_after:   balanceAfter,
      warnings:                  []
    });

  } catch (e) {
    return json(errBody(e.message || String(e), 'COMMIT_FAILED'), 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

/* ─── Transaction self-call ─── */

async function commitOneTransaction(origin, payload) {
  try {
    // Step 1: dry-run to detect if balance override is needed
    let overrideToken = null;
    const dryRes = await fetch(`${origin}/api/transactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...payload, dry_run: true })
    });
    const dryData = await dryRes.json().catch(() => ({}));

    if (dryData.ok === false && !dryData.override_token) {
      // Hard failure (e.g. account not found, bad type)
      return { ok: false, error: dryData.error || 'Dry run validation failed', code: dryData.code };
    }
    if (dryData.override_token) {
      overrideToken = dryData.override_token;
    }

    // Step 2: actual commit
    const commitPayload = { ...payload };
    if (overrideToken) commitPayload.override_token = overrideToken;

    const commitRes = await fetch(`${origin}/api/transactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(commitPayload)
    });
    return await commitRes.json().catch(() => ({ ok: false, error: 'Invalid JSON response', code: 'BAD_RESPONSE' }));
  } catch (e) {
    return { ok: false, error: e.message || 'fetch error', code: 'FETCH_ERROR' };
  }
}

/* ─── Exceptions table ─── */

async function writeException(db, { id, plan_id, account_id, user_id, stmt_tx_id, ledger_tx_id,
  type, severity, amount, description, reason, action, now }) {
  if (user_id !== undefined) {
    await db.prepare(
      `INSERT INTO reconciliation_exceptions
         (id, plan_id, account_id, user_id, statement_transaction_id, ledger_transaction_id,
          type, severity, amount, description, reason, recommended_action, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).bind(id, plan_id, account_id, user_id, stmt_tx_id, ledger_tx_id,
      type, severity, amount, description, reason, action, now).run();
  } else {
    await db.prepare(
      `INSERT INTO reconciliation_exceptions
         (id, plan_id, account_id, statement_transaction_id, ledger_transaction_id,
          type, severity, amount, description, reason, recommended_action, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).bind(id, plan_id, account_id, stmt_tx_id, ledger_tx_id,
      type, severity, amount, description, reason, action, now).run();
  }
}

async function ensureExceptionsTable(db) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
       id TEXT PRIMARY KEY,
       plan_id TEXT,
       account_id TEXT,
       user_id TEXT,
       statement_transaction_id TEXT,
       ledger_transaction_id TEXT,
       type TEXT,
       severity TEXT,
       amount REAL,
       description TEXT,
       reason TEXT,
       recommended_action TEXT,
       status TEXT DEFAULT 'open',
       created_at TEXT,
       resolved_at TEXT,
       resolution_note TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_status    ON reconciliation_exceptions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_account   ON reconciliation_exceptions(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_plan      ON reconciliation_exceptions(plan_id)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_user ON reconciliation_exceptions(user_id)`
  ];
  for (const sql of ddl) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

/* ─── Balance helper ─── */

async function computeAppBalance(db, accountId, hh) {
  try {
    const POSITIVE = new Set(['income','salary','opening','borrow','debt_in','adjustment_positive']);
    const NEGATIVE = new Set(['expense','transfer','cc_spend','repay','atm','debt_out','cc_payment','adjustment_negative']);
    const hhClause = await colExists(db, 'transactions', 'user_id');
    const res = await db.prepare(
      `SELECT type, amount, reversed_by, reversed_at, notes
       FROM transactions
       WHERE account_id = ?${hhClause ? ' AND user_id = ?' : ''}`
    ).bind(...(hhClause ? [accountId, hh] : [accountId])).all();
    let balance = 0;
    for (const tx of res.results || []) {
      if (tx.reversed_by || tx.reversed_at) continue;
      const notes = String(tx.notes || '').toUpperCase();
      if (notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY ')) continue;
      const t = (tx.type || '').toLowerCase();
      const a = Math.abs(tx.amount || 0);
      if (POSITIVE.has(t))      balance += a;
      else if (NEGATIVE.has(t)) balance -= a;
    }
    return round2(balance);
  } catch (_) { return 0; }
}

/* ─── PRAGMA column-existence cache ─── */

const _colCache = new Map();

async function colExists(db, table, column) {
  const key = `${table}.${column}`;
  if (_colCache.has(key)) return _colCache.get(key);
  try {
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
    const cols = new Set((rows.results || []).map(r => r.name));
    const result = cols.has(column);
    _colCache.set(key, result);
    return result;
  } catch (_) {
    _colCache.set(key, false);
    return false;
  }
}

/* ─── Content-based idempotency key (Phase 0) ─── */

// Deterministic, plan-independent key for a statement row's ledger write.
// sha256(account_id | posted_date | signed_amount_paisa | running_balance_paisa)
// Re-pasting the same statement yields identical keys → the /api/transactions
// hard guard replays instead of writing a duplicate. When the running balance
// is absent (CSV fallback without a balance column), we fall back to
// account+date+signed-amount, which still de-dupes re-pastes for the common
// case but loses same-day/same-amount disambiguation.
async function contentIdemKey(accountId, stmt, isDebit, amount) {
  const signedPaisa  = Math.round((isDebit ? -amount : amount) * 100);
  const balancePaisa = (stmt && stmt.balance != null)
    ? String(Math.round(stmt.balance * 100))
    : 'nobal';
  const basis = `${accountId}|${stmt.posted_date}|${signedPaisa}|${balancePaisa}`;
  const hash  = await sha256Hex(basis);
  return `recon:v2:${hash}`;
}

async function sha256Hex(text) {
  const data   = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ─── Generic helpers ─── */

function errBody(message, code) {
  return { ok: false, version: VERSION, error: message, code };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function rand() { return Math.random().toString(36).slice(2, 8); }

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      ...corsHeaders()
    }
  });
}
