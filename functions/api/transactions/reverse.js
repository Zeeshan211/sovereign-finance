/* ─── /api/transactions/reverse — POST ─── */
/* Cloudflare Pages Function v0.2.0 · atomic ledger reversal contract
 *
 * Contract:
 * - Frontend sends { id, reason, created_by? }.
 * - Backend owns reversal correctness.
 * - Single-row reversal:
 *     1. Inserts audit-visible reversal machinery row.
 *     2. Marks original row reversed_by / reversed_at / reversal_reason.
 * - Linked transfer reversal:
 *     1. Finds linked transfer pair through linked_txn_id or [linked: ...] notes.
 *     2. Inserts two reversal machinery rows.
 *     3. Marks both original legs reversed.
 * - Active formula APIs should exclude:
 *     - originals marked reversed_by / reversed_at
 *     - machinery rows whose notes contain [REVERSAL OF ...]
 *
 * Important:
 * - This endpoint does not let the frontend pick accounts.
 * - It reverses the original transaction against the original account linkage.
 * - Reason is mandatory so corrections are audit-grade.
 */

import { audit } from '../_lib.js';

const VERSION = 'v0.2.0';

export async function onRequestPost(context) {
  try {
    const body = await readJSON(context.request);
    const id = cleanText(body.id, '', 160);
    const reason = cleanText(body.reason, '', 240);
    const createdBy = cleanText(body.created_by, 'web-ledger', 80) || 'web-ledger';

    if (!id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'id required' }, 400);
    }

    if (!reason) {
      return jsonResponse({ ok: false, version: VERSION, error: 'reason required' }, 400);
    }

    const db = context.env.DB;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    const orig = await db.prepare(
      'SELECT * FROM transactions WHERE id = ?'
    ).bind(id).first();

    if (!orig) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Original transaction not found' }, 404);
    }

    const originalGuard = validateOriginalRow(orig);
    if (!originalGuard.ok) {
      return jsonResponse({ ok: false, version: VERSION, error: originalGuard.error }, originalGuard.status);
    }

    const linked = await findLinkedRow(db, orig);

    if (linked) {
      const linkedGuard = validateOriginalRow(linked, 'Linked');
      if (!linkedGuard.ok) {
        return jsonResponse({ ok: false, version: VERSION, error: linkedGuard.error }, linkedGuard.status);
      }

      return reverseLinkedPair(context, orig, linked, today, now, createdBy, reason);
    }

    return reverseSingleRow(context, orig, today, now, createdBy, reason);
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

async function reverseSingleRow(context, orig, today, now, createdBy, reason) {
  const db = context.env.DB;

  const amount = Number(orig.amount) || 0;
  if (amount <= 0) {
    return jsonResponse({ ok: false, version: VERSION, error: 'Original amount is invalid' }, 400);
  }

  const reversalId = makeTxnId('rev');
  const reversalType = mapReversalType(orig.type);
  const reversalNotes = makeReversalNotes(orig, reason);

  const insertReversal = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    reversalId,
    today,
    reversalType,
    amount,
    orig.account_id || null,
    null,
    null,
    reversalNotes,
    0,
    0,
    orig.id
  );

  const markOriginal = db.prepare(
    `UPDATE transactions
     SET reversed_by = ?, reversed_at = ?, reversal_reason = ?
     WHERE id = ?
       AND (reversed_by IS NULL OR reversed_by = '')
       AND (reversed_at IS NULL OR reversed_at = '')`
  ).bind(
    reversalId,
    now,
    reason,
    orig.id
  );

  await db.batch([insertReversal, markOriginal]);

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
      amount,
      account_id: orig.account_id || null,
      paired: false,
      reason,
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
    reason,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function reverseLinkedPair(context, a, b, today, now, createdBy, reason) {
  const db = context.env.DB;
  const pair = normalizeTransferPair(a, b);

  if (!pair) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Linked rows are not a recognized transfer pair'
    }, 400);
  }

  const amount = Number(pair.amount) || 0;
  if (amount <= 0) {
    return jsonResponse({ ok: false, version: VERSION, error: 'Transfer amount is invalid' }, 400);
  }

  const revOutId = makeTxnId('revout');
  const revInId = makeTxnId('revin');

  const outNotes = makeTransferReversalNotes({
    direction: 'out',
    originalId: pair.outRow.id,
    linkedId: revInId,
    fromAccount: pair.destAccount,
    toAccount: pair.sourceAccount,
    reason
  });

  const inNotes = makeTransferReversalNotes({
    direction: 'in',
    originalId: pair.inRow.id,
    linkedId: revOutId,
    fromAccount: pair.sourceAccount,
    toAccount: pair.destAccount,
    reason
  });

  const revOutStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount, linked_txn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    revOutId,
    today,
    'transfer',
    amount,
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
    amount,
    pair.sourceAccount,
    null,
    null,
    inNotes,
    0,
    0,
    revOutId
  );

  const markOutStmt = db.prepare(
    `UPDATE transactions
     SET reversed_by = ?, reversed_at = ?, reversal_reason = ?
     WHERE id = ?
       AND (reversed_by IS NULL OR reversed_by = '')
       AND (reversed_at IS NULL OR reversed_at = '')`
  ).bind(
    revOutId,
    now,
    reason,
    pair.outRow.id
  );

  const markInStmt = db.prepare(
    `UPDATE transactions
     SET reversed_by = ?, reversed_at = ?, reversal_reason = ?
     WHERE id = ?
       AND (reversed_by IS NULL OR reversed_by = '')
       AND (reversed_at IS NULL OR reversed_at = '')`
  ).bind(
    revInId,
    now,
    reason,
    pair.inRow.id
  );

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
      amount,
      source_account: pair.sourceAccount,
      destination_account: pair.destAccount,
      paired: true,
      reason,
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
    reason,
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

function validateOriginalRow(row, label = 'Original') {
  if (!row) {
    return { ok: false, status: 404, error: `${label} transaction not found` };
  }

  if (isReversalMachineRow(row)) {
    return { ok: false, status: 400, error: `${label} row is reversal machinery and cannot be reversed` };
  }

  if (row.reversed_by || row.reversed_at) {
    return { ok: false, status: 400, error: `${label} transaction is already reversed` };
  }

  return { ok: true };
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

function isReversalMachineRow(t) {
  if (!t) return false;
  const notes = String(t.notes || '').toUpperCase();
  return notes.includes('[REVERSAL OF ');
}

function makeReversalNotes(orig, reason) {
  const base = `[REVERSAL OF ${orig.id}]`;
  const reasonText = reason ? ` Reason: ${reason}` : '';
  const old = orig.notes ? ` Original: ${String(orig.notes)}` : '';
  return (base + reasonText + old).slice(0, 240);
}

function makeTransferReversalNotes(input) {
  const base = `[REVERSAL OF ${input.originalId}] [linked: ${input.linkedId}]`;
  const movement = input.direction === 'out'
    ? ` Reverse transfer out from ${input.fromAccount} to ${input.toAccount}.`
    : ` Reverse transfer in to ${input.toAccount} from ${input.fromAccount}.`;

  const reasonText = input.reason ? ` Reason: ${input.reason}` : '';
  return (base + movement + reasonText).slice(0, 240);
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
    atm: 'income',
    salary: 'expense',
    opening: 'expense',
    debt_in: 'debt_out',
    debt_out: 'debt_in'
  };

  return map[String(originalType || '').toLowerCase()] || originalType;
}

async function safeAudit(context, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail || {})
    };

    const result = await audit(context.env, payload);

    return {
      ok: !!(result && result.ok),
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err)
    };
  }
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
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
