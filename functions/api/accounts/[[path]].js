/* ─── /api/accounts/[[path]] · v0.2.6 · ACCOUNT MUTATION SAFETY ─── */
/*
 * Layer 2 account contract:
 *   - /api/accounts and /api/balances use the same formula-layer truth.
 *   - Account delete/archive is soft-only.
 *   - Accounts with active transactions cannot be archived/deleted.
 *   - opening_balance cannot be changed after active transactions exist.
 *   - type/kind/status/deleted_at/archived_at cannot be edited through PUT.
 *   - Audit failures do not break successful account mutations.
 */

import { json, audit } from '../_lib.js';

const VERSION = 'v0.2.6';

const ALLOWED_KINDS = ['cash', 'bank', 'wallet', 'prepaid', 'cc'];
const ALLOWED_TYPES = ['asset', 'liability'];

const TYPE_PLUS = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

const SAFE_EDITABLE_FIELDS = [
  'name',
  'icon',
  'currency',
  'color',
  'display_order',
  'credit_limit',
  'min_payment_amount',
  'statement_day',
  'payment_due_day'
];

const CONDITION_ACTIVE_ACCOUNT = "(deleted_at IS NULL OR deleted_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

function isReversalRow(t) {
  if (!t) return false;

  if (t.reversed_by || t.reversed_at) return true;

  const notes = String(t.notes || '').toUpperCase();

  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    const url = new URL(context.request.url);
    const debug = url.searchParams.get('debug') === '1';

    if (path.length === 1) {
      const id = path[0];

      const acct = await db.prepare(
        `SELECT * FROM accounts WHERE id = ? AND ${CONDITION_ACTIVE_ACCOUNT}`
      ).bind(id).first();

      if (!acct) return json({ ok: false, version: VERSION, error: 'Account not found' }, 404);

      const rows = await loadAccountTransactionRows(db, id);
      const activeRows = rows.filter(t => !isReversalRow(t));

      const body = {
        ok: true,
        version: VERSION,
        account: enrichAccount(acct, activeRows)
      };

      if (debug) {
        body.debug = {
          txn_count: rows.length,
          active_txn_count: activeRows.length,
          hidden_reversal_count: rows.length - activeRows.length,
          reversal_bridge: 'reversed_by/reversed_at columns plus Sheet notes markers'
        };
      }

      return json(body);
    }

    const accounts = await db.prepare(
      `SELECT * FROM accounts
       WHERE ${CONDITION_ACTIVE_ACCOUNT}
       ORDER BY display_order, name`
    ).all();

    const allTxns = await db.prepare(
      `SELECT id, type, amount, account_id, transfer_to_account_id, fee_amount, pra_amount,
              reversed_by, reversed_at, linked_txn_id, notes
       FROM transactions
       ORDER BY date ASC, created_at ASC`
    ).all();

    const rows = allTxns.results || [];
    const activeRows = rows.filter(t => !isReversalRow(t));

    const enriched = (accounts.results || []).map(acct => {
      const relevant = activeRows.filter(t => t.account_id === acct.id || t.transfer_to_account_id === acct.id);
      return enrichAccount(acct, relevant);
    });

    const body = {
      ok: true,
      version: VERSION,
      accounts: enriched
    };

    if (debug) {
      body.debug = {
        txn_count: rows.length,
        active_txn_count: activeRows.length,
        hidden_reversal_count: rows.length - activeRows.length,
        account_count: enriched.length,
        reversal_bridge: 'reversed_by/reversed_at columns plus Sheet notes markers'
      };
    }

    return json(body);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function loadAccountTransactionRows(db, id) {
  const txns = await db.prepare(
    `SELECT id, type, amount, account_id, transfer_to_account_id, fee_amount, pra_amount,
            reversed_by, reversed_at, linked_txn_id, notes
     FROM transactions
     WHERE account_id = ? OR transfer_to_account_id = ?
     ORDER BY date ASC, created_at ASC`
  ).bind(id, id).all();

  return txns.results || [];
}

async function getActiveTxnCount(db, id) {
  const rows = await loadAccountTransactionRows(db, id);
  return rows.filter(t => !isReversalRow(t)).length;
}

function computeBalance(acct, txns) {
  let balance = Number(acct.opening_balance) || 0;

  txns.forEach(t => {
    if (isReversalRow(t)) return;

    const amt = Number(t.amount) || 0;
    const fee = Number(t.fee_amount) || 0;
    const pra = Number(t.pra_amount) || 0;
    const acctId = t.account_id;
    const toAcctId = t.transfer_to_account_id;
    const type = String(t.type || '').toLowerCase();

    if ((type === 'transfer' || type === 'cc_payment') && toAcctId) {
      if (acctId === acct.id) {
        balance -= amt;
        if (fee) balance -= fee;
        if (pra) balance -= pra;
      }

      if (toAcctId === acct.id) {
        balance += amt;
      }

      return;
    }

    if (acctId !== acct.id) return;

    if (TYPE_PLUS.has(type)) {
      balance += amt;
      return;
    }

    if (TYPE_MINUS.has(type)) {
      balance -= amt;
      if (fee) balance -= fee;
      if (pra) balance -= pra;
    }
  });

  return round2(balance);
}

function enrichAccount(acct, txns) {
  const balance = computeBalance(acct, txns);

  const enriched = {
    ...acct,
    version: VERSION,
    balance,
    kind_label: kindLabel(acct.kind),
    is_credit_card: acct.kind === 'cc'
  };

  if (acct.kind === 'cc') {
    const limit = Number(acct.credit_limit) || 0;
    const outstanding = Math.max(0, -balance);

    enriched.cc_outstanding = round2(outstanding);
    enriched.cc_utilization_pct = limit > 0 ? round1((outstanding / limit) * 100) : null;
    enriched.available_credit = limit > 0 ? Math.max(0, round2(limit - outstanding)) : null;
    enriched.days_to_payment_due = computeDaysToPaymentDue(acct.payment_due_day);
    enriched.cc_status_label = ccStatusLabel(enriched.cc_utilization_pct);
  }

  return enriched;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function kindLabel(kind) {
  return ({ cash: 'Cash', bank: 'Bank', wallet: 'Wallet', prepaid: 'Prepaid', cc: 'Credit Card' })[kind] || kind;
}

function ccStatusLabel(pct) {
  if (pct == null) return null;
  if (pct >= 90) return '🔴 Critical';
  if (pct >= 70) return '🟠 High';
  if (pct >= 30) return '🟡 Medium';
  return '🟢 Low';
}

function computeDaysToPaymentDue(dueDay) {
  if (!dueDay) return null;

  const today = new Date();
  const todayDay = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  let days = Number(dueDay) - todayDay;
  if (days < 0) days += daysInMonth;

  return days;
}

function normalizeAccountId(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function validateCreateBody(body) {
  const id = normalizeAccountId(body.id);
  const name = String(body.name || '').trim();
  const kind = body.kind;
  const type = body.type;

  if (!id) return { ok: false, error: 'id required' };
  if (!/^[a-z0-9_]{2,48}$/.test(id)) return { ok: false, error: 'id must be 2-48 lowercase letters/numbers/underscores' };
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > 80) return { ok: false, error: 'name max 80 chars' };
  if (!ALLOWED_KINDS.includes(kind)) return { ok: false, error: 'invalid kind' };
  if (!ALLOWED_TYPES.includes(type)) return { ok: false, error: 'invalid type' };
  if (kind === 'cc' && type !== 'liability') return { ok: false, error: 'kind cc must use type liability' };
  if (kind !== 'cc' && type === 'liability') return { ok: false, error: 'only kind cc may use type liability for now' };

  return { ok: true, id, name, kind, type };
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    const body = await context.request.json();

    if (path.length !== 0) {
      return json({ ok: false, version: VERSION, error: 'Path not supported for POST' }, 400);
    }

    const valid = validateCreateBody(body);
    if (!valid.ok) return json({ ok: false, version: VERSION, error: valid.error }, 400);

    const existing = await db.prepare(
      'SELECT id FROM accounts WHERE id = ?'
    ).bind(valid.id).first();

    if (existing) {
      return json({ ok: false, version: VERSION, error: 'Account id already exists' }, 409);
    }

    await db.prepare(
      `INSERT INTO accounts
        (id, name, icon, type, kind, opening_balance, currency, color, display_order, status,
         credit_limit, min_payment_amount, statement_day, payment_due_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).bind(
      valid.id,
      valid.name,
      body.icon || null,
      valid.type,
      valid.kind,
      Number(body.opening_balance) || 0,
      body.currency || 'PKR',
      body.color || null,
      Number(body.display_order) || 0,
      body.credit_limit != null ? Number(body.credit_limit) : null,
      body.min_payment_amount != null ? Number(body.min_payment_amount) : null,
      body.statement_day != null ? Number(body.statement_day) : null,
      body.payment_due_day != null ? Number(body.payment_due_day) : null
    ).run();

    const auditResult = await safeAudit(context.env, {
      action: 'ACCT_CREATE',
      entity: 'account',
      entity_id: valid.id,
      kind: 'mutation',
      detail: {
        id: valid.id,
        name: valid.name,
        type: valid.type,
        kind: valid.kind,
        opening_balance: Number(body.opening_balance) || 0
      },
      created_by: body.created_by || 'web-account-create'
    });

    return json({
      ok: true,
      version: VERSION,
      id: valid.id,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires account id' }, 400);
    }

    const id = path[0];
    const body = await context.request.json();

    const existing = await db.prepare(
      'SELECT * FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = \'\')'
    ).bind(id).first();

    if (!existing) {
      return json({ ok: false, version: VERSION, error: 'Account not found' }, 404);
    }

    const forbidden = ['id', 'type', 'kind', 'status', 'deleted_at', 'archived_at'];
    const forbiddenTouched = forbidden.filter(k => body[k] !== undefined);

    if (forbiddenTouched.length) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Unsafe account fields cannot be edited',
        fields: forbiddenTouched
      }, 400);
    }

    const activeTxnCount = await getActiveTxnCount(db, id);

    if (body.opening_balance !== undefined && activeTxnCount > 0) {
      return json({
        ok: false,
        version: VERSION,
        error: 'opening_balance cannot be changed after active transactions exist',
        active_txn_count: activeTxnCount
      }, 409);
    }

    const updates = [];
    const values = [];

    SAFE_EDITABLE_FIELDS.forEach(field => {
      if (body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(body[field]);
      }
    });

    if (body.opening_balance !== undefined) {
      updates.push('opening_balance = ?');
      values.push(Number(body.opening_balance) || 0);
    }

    if (updates.length === 0) {
      return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    values.push(id);

    await db.prepare(
      'UPDATE accounts SET ' + updates.join(', ') + ' WHERE id = ?'
    ).bind(...values).run();

    const auditResult = await safeAudit(context.env, {
      action: 'ACCT_UPDATE',
      entity: 'account',
      entity_id: id,
      kind: 'mutation',
      detail: {
        fields: updates.map(x => x.split(' = ')[0]),
        active_txn_count: activeTxnCount,
        body
      },
      created_by: body.created_by || 'web-account-update'
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      updated_fields: updates.map(x => x.split(' = ')[0]),
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires account id' }, 400);
    }

    const id = path[0];
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || 'delete';
    const createdBy = url.searchParams.get('created_by') || 'web-account-delete';

    const existing = await db.prepare(
      'SELECT * FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = \'\')'
    ).bind(id).first();

    if (!existing) {
      return json({ ok: false, version: VERSION, error: 'Account not found' }, 404);
    }

    const activeTxnCount = await getActiveTxnCount(db, id);

    if (activeTxnCount > 0) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Account has active transactions and cannot be archived or deleted',
        id,
        active_txn_count: activeTxnCount
      }, 409);
    }

    if (action === 'archive') {
      await db.prepare(
        "UPDATE accounts SET status = 'archived', archived_at = datetime('now') WHERE id = ?"
      ).bind(id).run();

      const auditResult = await safeAudit(context.env, {
        action: 'ACCT_ARCHIVE',
        entity: 'account',
        entity_id: id,
        kind: 'mutation',
        detail: {
          archived: true,
          active_txn_count: activeTxnCount
        },
        created_by: createdBy
      });

      return json({
        ok: true,
        version: VERSION,
        id,
        status: 'archived',
        audited: auditResult.ok,
        audit_error: auditResult.error || null
      });
    }

    await db.prepare(
      "UPDATE accounts SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?"
    ).bind(id).run();

    const auditResult = await safeAudit(context.env, {
      action: 'ACCT_DELETE',
      entity: 'account',
      entity_id: id,
      kind: 'mutation',
      detail: {
        soft_delete: true,
        active_txn_count: activeTxnCount
      },
      created_by: createdBy
    });

    return json({
      ok: true,
      version: VERSION,
      id,
      status: 'deleted',
      soft_delete: true,
      audited: auditResult.ok,
      audit_error: auditResult.error || null
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function safeAudit(env, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail || {})
    };

    const result = await audit(env, payload);

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
