/* ─── /api/accounts/[[path]] · v0.2.3 · BALANCE MATH FIX ─── */
/*
 * Changes vs v0.2.2:
 *   - GET handler: replaced broken type handling with balances.js v0.4.2 proven logic
 *   - Was: catch-all `else balance += amt` → wrongly ADDED for borrow/repay/cc_spend/atm
 *   - Fixed: explicit handling for all 8 transaction types matching balances.js
 *   - Now liability-aware (CC paydown reduces CC balance correctly)
 *
 * Schema cite (per SCHEMA.md):
 *   accounts: id, name, type, kind, opening_balance, status, deleted_at, credit_limit, ...
 *   transactions: id, type, amount, account_id, transfer_to_account_id, reversed_at, ...
 *
 * Type handlers (match balances.js v0.4.2 exactly):
 *   income, borrow         → +amount
 *   expense, cc_payment, repay, atm → -amount
 *   cc_spend on liability  → +amount (debt grows)
 *   transfer source on asset → -amount
 *   transfer source on liability → +amount (cash advance)
 *   transfer dest on asset → +amount
 *   transfer dest on liability → -amount (CC paydown)
 *
 * PRESERVED from v0.2.2:
 *   - All existing endpoints + paths
 *   - status='active' / archive / delete handling
 *   - CC enrichment (utilization, days to due, etc)
 *   - Audit-after-write
 */

import { json, audit } from '../_lib.js';

const ALLOWED_KINDS = ['cash', 'bank', 'wallet', 'prepaid', 'cc'];
const ALLOWED_TYPES = ['asset', 'liability'];

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];

    // Single account: /api/accounts/<id>
    if (path.length === 1) {
      const id = path[0];
      const acct = await db.prepare(
        "SELECT * FROM accounts WHERE id = ? AND (deleted_at IS NULL OR deleted_at = '')"
      ).bind(id).first();

      if (!acct) return json({ ok: false, error: 'Account not found' }, 404);

      const txns = await db.prepare(
        "SELECT type, amount, account_id, transfer_to_account_id FROM transactions WHERE (account_id = ? OR transfer_to_account_id = ?) AND (reversed_at IS NULL OR reversed_at = '')"
      ).bind(id, id).all();

      const enriched = enrichAccount(acct, txns.results || []);
      return json({ ok: true, account: enriched });
    }

    // List all: /api/accounts
    const accounts = await db.prepare(
      "SELECT * FROM accounts WHERE (deleted_at IS NULL OR deleted_at = '') ORDER BY display_order, name"
    ).all();

    const allTxns = await db.prepare(
      "SELECT type, amount, account_id, transfer_to_account_id FROM transactions WHERE (reversed_at IS NULL OR reversed_at = '')"
    ).all();

    // Build account-type lookup for liability-aware transfer math
    const acctType = {};
    (accounts.results || []).forEach(a => { acctType[a.id] = a.type; });

    const enriched = (accounts.results || []).map(acct => {
      const relevant = (allTxns.results || []).filter(
        t => t.account_id === acct.id || t.transfer_to_account_id === acct.id
      );
      return enrichAccount(acct, relevant, acctType);
    });

    return json({ ok: true, accounts: enriched });

  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

function computeBalance(acct, txns, acctType) {
  let balance = acct.opening_balance || 0;
  txns.forEach(t => {
    const amt = t.amount || 0;
    if (t.type === 'income') {
      if (t.account_id === acct.id) balance += amt;
    } else if (t.type === 'expense' || t.type === 'cc_payment' || t.type === 'repay' || t.type === 'atm') {
      if (t.account_id === acct.id) balance -= amt;
    } else if (t.type === 'cc_spend') {
      // CC spend on liability account → balance grows
      if (t.account_id === acct.id) balance += amt;
    } else if (t.type === 'borrow') {
      if (t.account_id === acct.id) balance += amt;
    } else if (t.type === 'transfer') {
      // Source side
      if (t.account_id === acct.id) {
        if (acct.type === 'liability') {
          balance += amt; // cash advance: liability grows
        } else {
          balance -= amt; // asset depletes
        }
      }
      // Destination side
      if (t.transfer_to_account_id === acct.id) {
        if (acct.type === 'liability') {
          balance -= amt; // CC paydown: liability shrinks
        } else {
          balance += amt; // asset grows
        }
      }
    }
  });
  return Math.round(balance * 100) / 100;
}

function enrichAccount(acct, txns, acctType) {
  const balance = computeBalance(acct, txns, acctType);

  const enriched = {
    ...acct,
    balance: balance,
    kind_label: kindLabel(acct.kind),
    is_credit_card: acct.kind === 'cc'
  };

  if (acct.kind === 'cc') {
    const limit = acct.credit_limit || 0;
    const outstanding = Math.abs(balance);
    enriched.cc_utilization_pct = limit > 0 ? Math.round((outstanding / limit) * 1000) / 10 : null;
    enriched.available_credit = limit > 0 ? Math.max(0, limit - outstanding) : null;
    enriched.days_to_payment_due = computeDaysToPaymentDue(acct.payment_due_day);
    enriched.cc_status_label = ccStatusLabel(enriched.cc_utilization_pct);
  }

  return enriched;
}

function kindLabel(kind) {
  const labels = {
    cash: 'Cash', bank: 'Bank', wallet: 'Wallet', prepaid: 'Prepaid', cc: 'Credit Card'
  };
  return labels[kind] || kind;
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
  let days = dueDay - todayDay;
  if (days < 0) days += daysInMonth;
  return days;
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    const body = await context.request.json();

    // POST /api/accounts → create
    if (path.length === 0) {
      if (!body.id || !body.name || !ALLOWED_KINDS.includes(body.kind) || !ALLOWED_TYPES.includes(body.type)) {
        return json({ ok: false, error: 'Missing or invalid required fields (id, name, kind, type)' }, 400);
      }

      await db.prepare(
        "INSERT INTO accounts (id, name, icon, type, kind, opening_balance, currency, color, display_order, status, credit_limit, min_payment_amount, statement_day, payment_due_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)"
      ).bind(
        body.id, body.name, body.icon || null, body.type, body.kind,
        body.opening_balance || 0, body.currency || 'PKR', body.color || null,
        body.display_order || 0,
        body.credit_limit || null, body.min_payment_amount || null,
        body.statement_day || null, body.payment_due_day || null
      ).run();

      await audit(context.env, {
        action: 'ACCT_CREATE', entity: 'account', entity_id: body.id,
        kind: 'mutation', detail: JSON.stringify(body),
        created_by: body.created_by || 'web-account-create'
      });

      return json({ ok: true, id: body.id });
    }

    return json({ ok: false, error: 'Path not supported for POST' }, 400);

  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    if (path.length !== 1) return json({ ok: false, error: 'Path requires account id' }, 400);

    const id = path[0];
    const body = await context.request.json();

    const updates = [];
    const values = [];
    const editable = ['name', 'icon', 'opening_balance', 'currency', 'color', 'display_order', 'credit_limit', 'min_payment_amount', 'statement_day', 'payment_due_day'];
    editable.forEach(field => {
      if (body[field] !== undefined) {
        updates.push(field + ' = ?');
        values.push(body[field]);
      }
    });
    if (updates.length === 0) return json({ ok: false, error: 'Nothing to update' }, 400);

    values.push(id);
    await db.prepare("UPDATE accounts SET " + updates.join(', ') + " WHERE id = ?").bind(...values).run();

    await audit(context.env, {
      action: 'ACCT_UPDATE', entity: 'account', entity_id: id,
      kind: 'mutation', detail: JSON.stringify(body),
      created_by: body.created_by || 'web-account-update'
    });

    return json({ ok: true, id });

  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = context.params.path || [];
    if (path.length !== 1) return json({ ok: false, error: 'Path requires account id' }, 400);

    const id = path[0];
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || 'delete';

    if (action === 'archive') {
      await db.prepare("UPDATE accounts SET status = 'archived', archived_at = datetime('now') WHERE id = ?").bind(id).run();
      await audit(context.env, {
        action: 'ACCT_ARCHIVE', entity: 'account', entity_id: id,
        kind: 'mutation', detail: 'Archived', created_by: 'web-account-archive'
      });
      return json({ ok: true, id, status: 'archived' });
    }

    await db.prepare("UPDATE accounts SET status = 'deleted', deleted_at = datetime('now') WHERE id = ?").bind(id).run();
    await audit(context.env, {
      action: 'ACCT_DELETE', entity: 'account', entity_id: id,
      kind: 'mutation', detail: 'Soft delete', created_by: 'web-account-delete'
    });
    return json({ ok: true, id, status: 'deleted' });

  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
