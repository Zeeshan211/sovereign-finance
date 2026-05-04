/* ─── Sovereign Finance · Reconciliation Catch-All API · v0.1.0 ───
 * Sub-1D-5d Ship 3 of arc.
 *
 * Manual-verify reconciliation: operator declares "as of NOW, real bank balance
 * for account X is Y", system stores it + computes diff vs D1 computed balance.
 * No PDF parsing, no auto-matching — that's full reconciler (multi-session work).
 *
 * Routes:
 *   GET    /api/reconciliation                       → list all declarations (newest first) + summary
 *   GET    /api/reconciliation/account/{account_id}  → declarations history for one account
 *   POST   /api/reconciliation                       → declare a balance (audit + snapshot)
 *   POST   /api/reconciliation/{id}/note             → append note (no balance change)
 *
 * Banking-grade per Active Principle #2.
 */

import { json, audit, snapshot } from '../_lib.js';

/* ─── Helpers ─── */
function reconciliationId() {
  return 'recon_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function computeBalance(db, accountId) {
  const acc = await db.prepare(`SELECT opening_balance FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!acc) return null;
  const r = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount
                           WHEN type = 'transfer_in' THEN amount
                           ELSE 0 END), 0) AS credits,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount
                           WHEN type = 'transfer_out' THEN amount
                           ELSE 0 END), 0) AS debits
       FROM transactions
       WHERE account_id = ?
         AND (reversed_by IS NULL OR reversed_by = '')`
    )
    .bind(accountId)
    .first();
  const credits = Number(r?.credits || 0);
  const debits = Number(r?.debits || 0);
  return Number(acc.opening_balance || 0) + credits - debits;
}

async function enrichDeclaration(db, row) {
  const currentBalance = await computeBalance(db, row.account_id);
  const acc = await db.prepare(`SELECT name, kind FROM accounts WHERE id = ?`).bind(row.account_id).first();
  const declared = Number(row.declared_balance || 0);
  const stored_diff = Number(row.diff_amount || 0);
  // Live diff vs CURRENT (may differ from stored_diff if txns added since declaration)
  const live_diff = currentBalance != null ? (declared - currentBalance) : null;

  return {
    ...row,
    account_name: acc?.name || row.account_id,
    account_kind: acc?.kind || null,
    current_d1_balance: currentBalance,
    diff_at_declaration: stored_diff,
    live_diff_vs_current_d1: live_diff,
    is_clean: live_diff != null && Math.abs(live_diff) < 1, // tolerance ±Rs 1 for rounding
  };
}

/* ─── Cloudflare Pages Function entry ─── */
export async function onRequest(context) {
  const { request, env, params } = context;
  const path = params.path;
  const segments = !path ? [] : (Array.isArray(path) ? path : [path]);
  const method = request.method;
  const db = env.DB;

  try {
    if (segments.length === 0) {
      if (method === 'GET') return await handleList(db);
      if (method === 'POST') return await handleCreate(db, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 2 && segments[0] === 'account') {
      if (method === 'GET') return await handleAccountHistory(db, segments[1]);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 2 && segments[1] === 'note') {
      if (method === 'POST') return await handleAddNote(db, segments[0], request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return json({ ok: false, error: 'Not found. Available: GET /, POST /, GET /account/{id}, POST /{recon_id}/note' }, 404);
  } catch (e) {
    console.error('[reconciliation api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

/* ─── GET /api/reconciliation ─── */
async function handleList(db) {
  const rs = await db
    .prepare(`SELECT * FROM reconciliation ORDER BY declared_at DESC LIMIT 50`)
    .all();
  const rows = rs.results || [];

  const enriched = await Promise.all(rows.map(r => enrichDeclaration(db, r)));

  // Latest declaration per account → "current state" view
  const latestByAccount = {};
  for (const e of enriched) {
    if (!latestByAccount[e.account_id]) {
      latestByAccount[e.account_id] = e;
    }
  }
  const accountsLatest = Object.values(latestByAccount);
  const clean_count = accountsLatest.filter(a => a.is_clean).length;
  const drifted_count = accountsLatest.filter(a => !a.is_clean && a.live_diff_vs_current_d1 != null).length;

  return json({
    ok: true,
    declarations: enriched,
    accounts_latest: accountsLatest,
    declarations_count: enriched.length,
    accounts_with_declarations: accountsLatest.length,
    clean_count,
    drifted_count,
  });
}

/* ─── GET /api/reconciliation/account/{account_id} ─── */
async function handleAccountHistory(db, accountId) {
  const acc = await db.prepare(`SELECT id, name FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!acc) return json({ ok: false, error: `Account ${accountId} not found` }, 404);

  const rs = await db
    .prepare(`SELECT * FROM reconciliation WHERE account_id = ? ORDER BY declared_at DESC`)
    .bind(accountId)
    .all();
  const rows = rs.results || [];
  const enriched = await Promise.all(rows.map(r => enrichDeclaration(db, r)));
  const currentBalance = await computeBalance(db, accountId);

  return json({
    ok: true,
    account_id: accountId,
    account_name: acc.name,
    current_d1_balance: currentBalance,
    declarations: enriched,
    declarations_count: enriched.length,
  });
}

/* ─── POST /api/reconciliation ─── */
async function handleCreate(db, request) {
  const body = await request.json().catch(() => ({}));
  const account_id = (body.account_id || '').trim();
  const declared_balance = Number(body.declared_balance);
  const notes = body.notes || null;
  const declared_by = body.declared_by || 'operator';

  if (!account_id) return json({ ok: false, error: 'account_id is required' }, 400);
  if (isNaN(declared_balance)) return json({ ok: false, error: 'declared_balance is required and must be a number' }, 400);

  const acc = await db.prepare(`SELECT id, name FROM accounts WHERE id = ?`).bind(account_id).first();
  if (!acc) return json({ ok: false, error: `Account ${account_id} not found` }, 400);

  // Compute current D1 balance for diff snapshot
  const d1Balance = await computeBalance(db, account_id);
  const diff_amount = declared_balance - (d1Balance || 0);

  const id = reconciliationId();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO reconciliation
        (id, account_id, declared_balance, declared_at, declared_by, notes, diff_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, account_id, declared_balance, now, declared_by, notes, diff_amount)
    .run();

  await audit(db, {
    action: 'RECONCILIATION_DECLARE',
    entity_type: 'reconciliation',
    entity_id: id,
    details: {
      account_id,
      account_name: acc.name,
      declared_balance,
      d1_balance_at_declaration: d1Balance,
      diff_amount,
      is_clean: Math.abs(diff_amount) < 1,
      notes,
    },
    created_by: declared_by,
  });

  return json({
    ok: true,
    id,
    account_id,
    declared_balance,
    d1_balance_at_declaration: d1Balance,
    diff_amount,
    is_clean: Math.abs(diff_amount) < 1,
    declared_at: now,
    action: 'RECONCILIATION_DECLARE',
  });
}

/* ─── POST /api/reconciliation/{id}/note ─── */
async function handleAddNote(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const newNote = (body.note || '').trim();
  if (!newNote) return json({ ok: false, error: 'note is required' }, 400);

  const existing = await db.prepare(`SELECT * FROM reconciliation WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Reconciliation declaration not found' }, 404);

  // Append to notes (preserves history)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const combined = existing.notes
    ? `${existing.notes}\n\n[${stamp}] ${newNote}`
    : `[${stamp}] ${newNote}`;

  // Snapshot before mutation
  const snapId = await snapshot(db, {
    label: `recon_note_${id}_${Date.now()}`,
    tables: ['reconciliation'],
    where: `id = '${id}'`,
  });

  await db
    .prepare(`UPDATE reconciliation SET notes = ? WHERE id = ?`)
    .bind(combined, id)
    .run();

  await audit(db, {
    action: 'RECONCILIATION_NOTE_APPEND',
    entity_type: 'reconciliation',
    entity_id: id,
    details: { previous_notes: existing.notes, appended: newNote, snapshot_id: snapId },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'RECONCILIATION_NOTE_APPEND', snapshot_id: snapId });
}
