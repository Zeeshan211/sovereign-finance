/* ─── /api/accounts/[[path]] · v0.2.5 · SHEET REVERSAL BRIDGE ─── */
/*
 * Ground Zero rule:
 *   /api/accounts and /api/balances must use the same formula-layer truth.
 *
 * Changes vs v0.2.4:
 *   - Excludes D1-native reversed rows: reversed_by / reversed_at
 *   - Excludes imported Sheet reversal markers in notes:
 *       [REVERSED BY ...]
 *       [REVERSAL OF ...]
 *   - Adds optional ?debug=1 counts for parity checks
 *
 * Account balance formula:
 *   Balance(A) = opening
 *              + income + borrow + debt_in + salary
 *              - expense - repay - debt_out - atm - cc_spend - transfer
 *
 * Transfer handling:
 *   - Legacy Sheet transfers:
 *       OUT row = transfer, subtracts from source
 *       IN row  = income, adds to destination
 *   - Modern D1 transfers:
 *       transfer or cc_payment with transfer_to_account_id
 *       subtracts from source and adds to destination
 */

import { json, audit } from '../_lib.js';

const VERSION = 'v0.2.5';

const ALLOWED_KINDS = ['cash', 'bank', 'wallet', 'prepaid', 'cc'];
const ALLOWED_TYPES = ['asset', 'liability'];

const TYPE_PLUS = new Set(['income', 'salary', 'debt_in', 'borrow', 'opening']);
const TYPE_MINUS = new Set(['expense', 'cc_spend', 'atm', 'debt_out', 'repay', 'transfer']);

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
        "SELECT * FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')"
      ).bind(id).first();

      if (!acct) return json({ ok: false, version: VERSION, error: 'Account not found' }, 404);

      const txns = await db.prepare(
        `SELECT id, type, amount, account_id, transfer_to_account_id, fee_amount, pra_amount,
                reversed_by, reversed_at, linked_txn_id, notes
         FROM transactions
         WHERE account_id = ? OR transfer_to_account_id = ?
         ORDER BY date ASC, created_at ASC`
      ).bind(id, id).all();

      const rows = txns.results || [];
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
      "SELECT * FROM accounts WHERE (deleted_at IS NULL OR deleted_at = '') ORDER BY display_order, name"
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

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    const body = await context.request.json();

    if (path.length === 0) {
      if (!body.id || !body.name || !ALLOWED_KINDS.includes(body.kind) || !ALLOWED_TYPES.includes(body.type)) {
        return json({ ok: false, version: VERSION, error: 'Missing or invalid required fields (id, name, kind, type)' }, 400);
      }

      await db.prepare(
        "INSERT INTO accounts (id, name, icon, type, kind, opening_balance, currency, color, display_order, status, credit_limit, min_payment_amount, statement_day, payment_due_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)"
      ).bind(
        body.id,
        body.name,
        body.icon || null,
        body.type,
        body.kind,
        body.opening_balance || 0,
        body.currency || 'PKR',
        body.color || null,
        body.display_order || 0,
        body.credit_limit || null,
        body.min_payment_amount || null,
        body.statement_day || null,
        body.payment_due_day || null
      ).run();

      await audit(context.env, {
        action: 'ACCT_CREATE',
        entity: 'account',
        entity_id: body.id,
        kind: 'mutation',
        detail: JSON.stringify(body),
        created_by: body.created_by || 'web-account-create'
      });

      return json({ ok: true, version: VERSION, id: body.id });
    }

    return json({ ok: false, version: VERSION, error: 'Path not supported for POST' }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) return json({ ok: false, version: VERSION, error: 'Path requires account id' }, 400);

    const id = path[0];
    const body = await context.request.json();
    const updates = [];
    const values = [];

    const editable = [
      'name',
      'icon',
      'opening_balance',
      'currency',
      'color',
      'display_order',
      'credit_limit',
      'min_payment_amount',
      'statement_day',
      'payment_due_day'
    ];

    editable.forEach(field => {
      if (body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(body[field]);
      }
    });

    if (updates.length === 0) return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);

    values.push(id);

    await db.prepare("UPDATE accounts SET " + updates.join(', ') + " WHERE id = ?").bind(...values).run();

    await audit(context.env, {
      action: 'ACCT_UPDATE',
      entity: 'account',
      entity_id: id,
      kind: 'mutation',
      detail: JSON.stringify(body),
      created_by: body.created_by || 'web-account-update'
    });

    return json({ ok: true, version: VERSION, id });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    if (path.length !== 1) return json({ ok: false, version: VERSION, error: 'Path requires account id' }, 400);

    const id = path[0];
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || 'delete';

    if (action === 'archive') {
      await db.prepare("UPDATE accounts SET status = 'archived', archived_at = datetime('now') WHERE id = ?").bind(id).run();

      await audit(context.env, {
        action: 'ACCT_ARCHIVE',
        entity: 'account',
        entity_id: id,
        kind: 'mutation',
        detail: 'Archived',
        created_by: 'web-account-archive'
      });

      return json({ ok: true, version: VERSION, id, status: 'archived' });
    }

    await db.prepare("UPDATE accounts SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?").bind(id).run();

    await audit(context.env, {
      action: 'ACCT_DELETE',
      entity: 'account',
      entity_id: id,
      kind: 'mutation',
      detail: 'Soft delete',
      created_by: 'web-account-delete'
    });

    return json({ ok: true, version: VERSION, id, status: 'deleted' });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}
