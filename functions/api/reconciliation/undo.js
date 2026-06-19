/* Sovereign Finance — Reconciliation Batch Undo
 * POST /api/reconciliation/undo
 * contract_version: reconciliation-v0.3
 *
 * Reverses every ledger transaction a single commit created, grouped by
 * plan_id (source_module='reconciliation', source_id=<plan_id>). Append-only:
 * each undo writes a reversing entry via /api/transactions/reverse — it never
 * deletes. After undoing, the plan's committed_at is cleared so it can be
 * re-reviewed and re-committed cleanly (the Phase 0 content-keys make any
 * re-commit of still-valid rows a no-op).
 *
 * Multi-tenancy: scoped to the authenticated household.
 */

import { householdOf } from '../_lib.js';

const VERSION = 'reconciliation-v0.3';

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return json(errBody('DB binding missing', 'DB_BINDING_MISSING'), 500);

    const hh = householdOf(context);
    if (!hh) return json(errBody('Unauthorized', 'UNAUTHORIZED'), 401);

    const body      = await readJson(context.request);
    const planId    = clean(body.plan_id);
    const confirmed = body.confirm === true;
    const reason    = clean(body.reason) || `Reconciliation batch undo (plan ${planId})`;

    if (!planId)    return json(errBody('plan_id is required',  'PLAN_ID_REQUIRED'), 400);
    if (!confirmed) return json(errBody('confirm must be true', 'CONFIRM_REQUIRED'), 400);

    const hhClause = await colExists(db, 'transactions', 'user_id');

    // Active (non-reversed) transactions this plan created.
    const res = await db.prepare(
      `SELECT id, type, amount, reversed_by, reversed_at, notes
       FROM transactions
       WHERE source_module = 'reconciliation' AND source_id = ?${hhClause ? ' AND user_id = ?' : ''}`
    ).bind(...(hhClause ? [planId, hh] : [planId])).all().catch(() => ({ results: [] }));

    const origin = new URL(context.request.url).origin;
    const reversed = [];
    const failed   = [];

    for (const tx of (res.results || [])) {
      if (tx.reversed_by || tx.reversed_at) continue; // already reversed
      const notes = String(tx.notes || '').toUpperCase();
      if (notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY ')) continue;

      const r = await reverseOne(origin, tx.id, reason);
      if (r.ok) reversed.push(tx.id);
      else      failed.push({ transaction_id: tx.id, reason: r.error || r.code || 'reverse failed' });
    }

    // Clear committed_at so the plan can be re-reviewed/re-committed.
    if (failed.length === 0) {
      await db.prepare(
        `UPDATE reconciliation_plans SET committed_at = NULL WHERE id = ?`
      ).bind(planId).run().catch(() => {});
    }

    return json({
      ok:             failed.length === 0,
      version:        VERSION,
      plan_id:        planId,
      reversed_count: reversed.length,
      reversed_ids:   reversed,
      failed_count:   failed.length,
      failed,
      plan_reopened:  failed.length === 0,
      warnings:       failed.length
        ? ['Some transactions could not be reversed — plan left committed; review failures.']
        : []
    });

  } catch (e) {
    return json(errBody(e.message || String(e), 'UNDO_FAILED'), 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/* ─── Reverse self-call ─── */

async function reverseOne(origin, transactionId, reason) {
  try {
    const r = await fetch(`${origin}/api/transactions/reverse`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ transaction_id: transactionId, reason })
    });
    const data = await r.json().catch(() => ({}));
    if (data.ok || data.reversed || data.idempotent_replay) return { ok: true };
    return { ok: false, error: data.error, code: data.code };
  } catch (e) {
    return { ok: false, error: e.message || 'fetch error', code: 'FETCH_ERROR' };
  }
}

/* ─── Helpers ─── */

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

function errBody(message, code) {
  return { ok: false, version: VERSION, error: message, code };
}

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

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
