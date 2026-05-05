/* ─── /api/transactions/reverse — POST ─── */
/* Cloudflare Pages Function v0.1.0 · Layer 2 formula-spec reversal contract */
/*
 * Ground rule:
 *   Active formula APIs exclude:
 *   - originals marked with reversed_by / reversed_at
 *   - reversal machinery rows with notes containing [REVERSAL OF ...]
 *
 * Therefore this endpoint:
 *   1. Inserts audit-visible reversal rows.
 *   2. Marks original active rows as reversed.
 *   3. Uses bracketed [REVERSAL OF ...] notes so reversal rows are excluded from formula math.
 *   4. Detects linked transfer pairs from either:
 *      - linked_txn_id column
 *      - Sheet-style notes marker: [linked: TXN-...]
 *   5. Writes category_id as NULL to avoid category/FK drift.
 */

import { audit } from '../_lib.js';

const VERSION = 'v0.1.0';

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    if (!body.id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'id required' }, 400);
    }

    const db = context.env.DB;
    const createdBy = body.created_by || 'web-reverse';
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    const orig = await db.prepare(
      'SELECT * FROM transactions WHERE id = ?'
    ).bind(body.id).first();

    if (!orig) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Original transaction not found' }, 404);
    }

    if (isReversalRow(orig)) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Cannot reverse a reversal row' }, 400);
    }

    if (orig.reversed_by || orig.reversed_at) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Already reversed' }, 400);
    }

    const linked = await findLinkedRow(db, orig);

    if (linked) {
      if (isReversalRow(linked)) {
        return jsonResponse({ ok: false, version: VERSION, error: 'Linked row is already reversal machinery' }, 400);
      }

      if (linked.reversed_by || linked.reversed_at) {
        return jsonResponse({ ok: false, version: VERSION, error: 'Linked leg already reversed' }, 400);
      }

      return reverseLinkedPair(context, orig, linked, today, now, createdBy);
    }

    return reverseSingleRow(context, orig, today, now, createdBy);
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function reverseSingleRow(context, orig, today, now, createdBy) {
  const db = context.env.DB;
  const reversalId = makeTxnId('rev');

  const reversalType = mapReversalType(orig.type);
  const reversalNotes = makeReversalNotes(orig);

  await db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reversalId,
    today,
    reversalType,
    Number(orig.amount) || 0,
    orig.account_id,
    null,
    null,
    reversalNotes,
    0,
    0,
    orig.id
  ).run();

  await db.prepare(
    'UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?'
  ).bind(reversalId, now, orig.id).run();

  const auditResult = await safeAudit(context, {
    action: 'TXN_REVERSE',
    entity: 'transaction',
    entity_id: orig.id,
    kind: 'mutation',
    detail: {
      original_id: orig.id,
      reversal_id: reversalId,
      original_type: orig.type,
      reversal_type: reversalType,
      amount: Number(orig.amount) || 0,
      account_id: orig.account_id,
      paired: false,
      formula_excluded: true
    },
    created_by: createdBy
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    original_id: orig.id,
    reversal_id: reversalId,
    paired: false,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function reverseLinkedPair(context, a, b, today, now, createdBy) {
  const db = context.env.DB;

  const pair = normalizeTransferPair(a, b);

  if (!pair) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Linked rows are not a recognized transfer pair'
    }, 400);
  }

  const revOutId = makeTxnId('revout');
  const revInId = makeTxnId('revin');

  const outNotes = `To: ${pair.sourceAccount} · [REVERSAL OF ${pair.outRow.id}] [linked: ${revInId}]`.slice(0, 200);
  const inNotes = `From: ${pair.destAccount} · [REVERSAL OF ${pair.inRow.id}] [linked: ${revOutId}]`.slice(0, 200);

  const revOutStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    revOutId,
    today,
    'transfer',
    Number(pair.amount) || 0,
    pair.destAccount,
    null,
    null,
    outNotes,
    0,
    0,
    revInId
  );

  const revInStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    revInId,
    today,
    'income',
    Number(pair.amount) || 0,
    pair.sourceAccount,
    null,
    null,
    inNotes,
    0,
    0,
    revOutId
  );

  const markOutStmt = db.prepare(
    'UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?'
  ).bind(revOutId, now, pair.outRow.id);

  const markInStmt = db.prepare(
    'UPDATE transactions SET reversed_by = ?, reversed_at = ? WHERE id = ?'
  ).bind(revInId, now, pair.inRow.id);

  await db.batch([revOutStmt, revInStmt, markOutStmt, markInStmt]);

  const auditResult = await safeAudit(context, {
    action: 'TXN_REVERSE',
    entity: 'transaction',
    entity_id: pair.outRow.id,
    kind: 'mutation',
    detail: {
      original_out_id: pair.outRow.id,
      original_in_id: pair.inRow.id,
      reversal_out_id: revOutId,
      reversal_in_id: revInId,
      amount: Number(pair.amount) || 0,
      source_account: pair.sourceAccount,
      destination_account: pair.destAccount,
      paired: true,
      formula_excluded: true
    },
    created_by: createdBy
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    original_id: pair.outRow.id,
    linked_original_id: pair.inRow.id,
    reversal_id: revOutId,
    linked_reversal_id: revInId,
    paired: true,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function findLinkedRow(db, row) {
  const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

  if (!linkedId) return null;

  if (linkedId === row.id) return null;

  try {
    return await db.prepare(
      'SELECT * FROM transactions WHERE id = ?'
    ).bind(linkedId).first();
  } catch (e) {
    return null;
  }
}

function normalizeTransferPair(a, b) {
  const aType = String(a.type || '').toLowerCase();
  const bType = String(b.type || '').toLowerCase();

  if (aType === 'transfer' && bType === 'income') {
    return {
      outRow: a,
      inRow: b,
      sourceAccount: a.account_id,
      destAccount: b.account_id,
      amount: Number(a.amount) || 0
    };
  }

  if (bType === 'transfer' && aType === 'income') {
    return {
      outRow: b,
      inRow: a,
      sourceAccount: b.account_id,
      destAccount: a.account_id,
      amount: Number(b.amount) || 0
    };
  }

  return null;
}

function extractLinkedId(notes) {
  const text = String(notes || '');
  const match = text.match(/\[linked:\s*([^\]\s]+)\]/i);
  return match ? match[1] : null;
}

function isReversalRow(t) {
  if (!t) return false;

  if (t.reversed_by || t.reversed_at) return true;

  const notes = String(t.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

function makeReversalNotes(orig) {
  const base = `[REVERSAL OF ${orig.id}]`;
  const old = orig.notes ? ` ${String(orig.notes)}` : '';
  return (base + old).slice(0, 200);
}

function mapReversalType(originalType) {
  const map = {
    expense: 'income',
    income: 'expense',
    transfer: 'income',
    cc_payment: 'cc_spend',
    cc_spend: 'cc_payment',
    borrow: 'repay',
    repay: 'borrow',
    atm: 'income'
  };

  return map[String(originalType || '').toLowerCase()] || originalType;
}

async function safeAudit(context, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail || {})
    };

    const result = await audit(context.env, payload);

    return {
      ok: !!(result && result.ok),
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
