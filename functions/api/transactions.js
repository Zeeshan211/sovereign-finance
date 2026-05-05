/* ─── /api/transactions — GET list, POST create ─── */
/* Cloudflare Pages Function v0.1.3 · Layer 2 POST category contract fix */
/*
 * Changes vs v0.1.2:
 *   - Keeps GET active/audit split.
 *   - Keeps datewise ordering.
 *   - Keeps transfer POST as Sheet-compatible 2-row pair:
 *       OUT row: type=transfer, source account
 *       IN row:  type=income, destination account
 *   - Writes category_id as NULL for new rows.
 *     Reason: migrated working rows already use category_id:null, and FK/category drift can break POST.
 *   - Keeps audit safe-wrapped so audit failure cannot break transaction insert.
 */

import { audit } from './_lib.js';

const VERSION = 'v0.1.3';

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const includeReversed = url.searchParams.get('include_reversed') === '1';

    const stmt = context.env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, fee_amount, pra_amount, created_at,
              reversed_by, reversed_at, linked_txn_id
       FROM transactions
       ORDER BY date DESC, datetime(created_at) DESC, id DESC
       LIMIT 200`
    );

    const result = await stmt.all();
    const allRows = result.results || [];

    const visibleRows = includeReversed
      ? allRows
      : allRows.filter(t => !isReversalRow(t));

    return jsonResponse({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
      count: visibleRows.length,
      hidden_reversal_count: allRows.length - visibleRows.length,
      transactions: visibleRows
    });
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    const amount = parseFloat(body.amount);
    if (isNaN(amount) || amount <= 0) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Amount must be greater than 0' }, 400);
    }

    if (!body.account_id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'account_id required' }, 400);
    }

    if (!body.type) {
      return jsonResponse({ ok: false, version: VERSION, error: 'type required' }, 400);
    }

    const allowedTypes = ['expense', 'income', 'transfer', 'cc_payment', 'cc_spend', 'borrow', 'repay', 'atm'];

    if (!allowedTypes.includes(body.type)) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Invalid type' }, 400);
    }

    if (body.type === 'transfer') {
      return createTransferPair(context, body, amount);
    }

    return createSingleTransaction(context, body, amount);
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createSingleTransaction(context, body, amount) {
  const db = context.env.DB;
  const id = makeTxnId('tx');
  const date = body.date || todayISO();
  const notes = cleanNotes(body.notes);

  await db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    date,
    body.type,
    amount,
    body.account_id,
    body.transfer_to_account_id || null,
    null,
    notes,
    Number(body.fee_amount) || 0,
    Number(body.pra_amount) || 0
  ).run();

  const auditResult = await safeAudit(context, {
    action: body.type === 'cc_payment' ? 'CC_PAYMENT' : 'TXN_ADD',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      type: body.type,
      amount,
      account_id: body.account_id,
      transfer_to_account_id: body.transfer_to_account_id || null,
      category_id: null,
      date,
      notes: notes.slice(0, 80)
    },
    created_by: body.created_by || 'web-add'
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function createTransferPair(context, body, amount) {
  const db = context.env.DB;
  const date = body.date || todayISO();
  const fromId = body.account_id;
  const toId = body.transfer_to_account_id;

  if (!toId) {
    return jsonResponse({ ok: false, version: VERSION, error: 'transfer_to_account_id required for transfer' }, 400);
  }

  if (fromId === toId) {
    return jsonResponse({ ok: false, version: VERSION, error: 'source and destination accounts cannot match' }, 400);
  }

  const accounts = await loadAccountNames(db, [fromId, toId]);
  const fromName = accounts[fromId] || fromId;
  const toName = accounts[toId] || toId;

  const outId = makeTxnId('txout');
  const inId = makeTxnId('txin');
  const baseNotes = cleanNotes(body.notes || 'Transfer');

  const outNotes = `To: ${toName} · ${baseNotes} (OUT) [linked: ${inId}]`.slice(0, 200);
  const inNotes = `From: ${fromName} · ${baseNotes} (IN) [linked: ${outId}]`.slice(0, 200);

  const outStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    outId,
    date,
    'transfer',
    amount,
    fromId,
    null,
    null,
    outNotes,
    Number(body.fee_amount) || 0,
    Number(body.pra_amount) || 0
  );

  const inStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    inId,
    date,
    'income',
    amount,
    toId,
    null,
    null,
    inNotes,
    0,
    0
  );

  await db.batch([outStmt, inStmt]);

  const auditResult = await safeAudit(context, {
    action: 'TRANSFER',
    entity: 'transaction',
    entity_id: outId,
    kind: 'mutation',
    detail: {
      type: 'transfer',
      amount,
      from_account_id: fromId,
      to_account_id: toId,
      out_id: outId,
      in_id: inId,
      category_id: null,
      date,
      notes: baseNotes.slice(0, 80)
    },
    created_by: body.created_by || 'web-add'
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id: outId,
    linked_id: inId,
    ids: [outId, inId],
    transfer_model: 'legacy_2_row',
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

function isReversalRow(t) {
  if (!t) return false;

  if (t.reversed_by || t.reversed_at) return true;

  const notes = String(t.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

async function loadAccountNames(db, ids) {
  const out = {};

  for (const id of ids) {
    if (!id) continue;

    try {
      const row = await db.prepare(
        `SELECT id, name FROM accounts WHERE id = ?`
      ).bind(id).first();

      if (row && row.id) out[row.id] = row.name || row.id;
    } catch (e) {}
  }

  return out;
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function cleanNotes(notes) {
  return String(notes || '').trim().slice(0, 200);
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
