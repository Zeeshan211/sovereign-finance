/* ─── Sovereign Finance · Accounts Catch-All API · v0.2.2 ───
 * Adds CC validation fields (Sub-1D-4e):
 *   - credit_limit (REAL)        → max balance the CC allows
 *   - min_payment_amount (REAL)  → minimum required to avoid late fee
 *   - statement_day (INTEGER)    → day of month statement closes (1-31)
 *   - payment_due_day (INTEGER)  → day of month payment is due (1-31)
 *
 * GET response additions:
 *   - cc_utilization_pct: abs(balance)/credit_limit*100 (CC only, null otherwise)
 *   - available_credit: credit_limit - abs(balance) (CC only, null otherwise)
 *   - days_to_payment_due: derived from payment_due_day vs today (CC only)
 *   - cc_status_label: 'critical' (>=90%) | 'warning' (>=75%) | 'healthy' | 'no limit set'
 *
 * Routes unchanged from v0.2.1.
 *
 * v0.2.1 → v0.2.2 changes:
 *   - GET handleList: enrich CC accounts with utilization/available/days_to_due/status
 *   - GET handleSingle: same enrichment
 *   - POST handleCreate: accept credit_limit, min_payment_amount, statement_day, payment_due_day
 *   - PUT handleEdit: add 4 new fields to allowlist + validation
 *   - INSERT statement extended to write new columns
 */

import { json, audit, snapshot } from '../_lib.js';

const VALID_KINDS = ['cash', 'bank', 'wallet', 'prepaid', 'cc'];
const KIND_LABELS = {
  cash: 'Cash',
  bank: 'Bank',
  wallet: 'Wallet',
  prepaid: 'Prepaid',
  cc: 'Credit Card',
};
const isCreditCard = kind => kind === 'cc';

/* ─── Helpers ─── */
function slugifyId(name) {
  const slug = String(name || 'account')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return slug || ('acc_' + Math.random().toString(36).slice(2, 8));
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '—';
}

async function computeBalance(db, accountId, openingBalance) {
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
  return Number(openingBalance || 0) + credits - debits;
}

async function fkRefs(db, accountId) {
  const txn = await db
    .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE account_id = ?`)
    .bind(accountId)
    .first();
  const bill = await db
    .prepare(`SELECT COUNT(*) AS c FROM bills WHERE default_account_id = ? AND status = 'active'`)
    .bind(accountId)
    .first();
  return {
    transactions: Number(txn?.c || 0),
    bills: Number(bill?.c || 0),
    total: Number(txn?.c || 0) + Number(bill?.c || 0),
  };
}

/**
 * Enrich CC accounts with utilization/available/days_to_due/status_label.
 * Returns the same row with extra fields. For non-CC, all CC fields are null.
 */
function enrichCCFields(account) {
  const out = { ...account };
  if (!isCreditCard(account.kind)) {
    out.cc_utilization_pct = null;
    out.available_credit = null;
    out.days_to_payment_due = null;
    out.cc_status_label = null;
    return out;
  }
  const balance = Number(account.balance || 0);
  const limit = Number(account.credit_limit || 0);
  const outstanding = Math.abs(Math.min(0, balance)); // balance is negative when money owed
  out.outstanding = outstanding;

  if (limit > 0) {
    out.cc_utilization_pct = Math.min(999, Math.round((outstanding / limit) * 100));
    out.available_credit = Math.max(0, limit - outstanding);
    if (out.cc_utilization_pct >= 100) out.cc_status_label = 'over limit';
    else if (out.cc_utilization_pct >= 90) out.cc_status_label = 'critical';
    else if (out.cc_utilization_pct >= 75) out.cc_status_label = 'warning';
    else out.cc_status_label = 'healthy';
  } else {
    out.cc_utilization_pct = null;
    out.available_credit = null;
    out.cc_status_label = 'no limit set';
  }

  if (account.payment_due_day) {
    const today = new Date();
    const todayDay = today.getUTCDate();
    const dueDay = Number(account.payment_due_day);
    let daysToDue = dueDay - todayDay;
    // If due day already passed this month, count to next month's due day
    if (daysToDue < 0) {
      const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
      daysToDue = (daysInMonth - todayDay) + dueDay;
    }
    out.days_to_payment_due = daysToDue;
  } else {
    out.days_to_payment_due = null;
  }

  return out;
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

    if (segments.length === 1) {
      const id = segments[0];
      if (method === 'GET') return await handleSingle(db, id);
      if (method === 'PUT') return await handleEdit(db, id, request);
      if (method === 'DELETE') return await handleDelete(db, id, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 2) {
      const id = segments[0];
      const action = segments[1];
      if (method === 'POST' && action === 'archive') return await handleArchive(db, id);
      if (method === 'POST' && action === 'unarchive') return await handleUnarchive(db, id);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[accounts api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

/* ─── GET /api/accounts ─── */
async function handleList(db) {
  const rs = await db
    .prepare(`SELECT * FROM accounts WHERE status = 'active' OR status IS NULL ORDER BY display_order ASC, name ASC`)
    .all();
  const rows = rs.results || [];

  const accounts = await Promise.all(rows.map(async row => {
    const balance = await computeBalance(db, row.id, row.opening_balance);
    const base = {
      id: row.id,
      name: row.name,
      icon: row.icon,
      type: row.type,
      kind: row.kind,
      opening_balance: Number(row.opening_balance || 0),
      currency: row.currency || 'PKR',
      color: row.color,
      display_order: Number(row.display_order || 0),
      balance,
      kind_label: kindLabel(row.kind),
      is_credit_card: isCreditCard(row.kind),
      credit_limit: row.credit_limit != null ? Number(row.credit_limit) : null,
      min_payment_amount: row.min_payment_amount != null ? Number(row.min_payment_amount) : null,
      statement_day: row.statement_day != null ? Number(row.statement_day) : null,
      payment_due_day: row.payment_due_day != null ? Number(row.payment_due_day) : null,
    };
    return enrichCCFields(base);
  }));

  const totals = {
    cash: 0,
    bank: 0,
    ewallet: 0,
    prepaid: 0,
    credit_card_outstanding: 0,
    total_assets: 0,
    net_worth: 0,
  };
  for (const a of accounts) {
    if (a.is_credit_card) {
      totals.credit_card_outstanding += Math.abs(Math.min(0, a.balance));
    } else if (a.kind === 'cash') totals.cash += a.balance;
    else if (a.kind === 'bank') totals.bank += a.balance;
    else if (a.kind === 'wallet') totals.ewallet += a.balance;
    else if (a.kind === 'prepaid') totals.prepaid += a.balance;

    if (!a.is_credit_card) totals.total_assets += a.balance;
  }
  totals.net_worth = totals.total_assets - totals.credit_card_outstanding;

  return json({
    ok: true,
    accounts,
    totals,
    asof: new Date().toISOString(),
    count: accounts.length,
  });
}

/* ─── POST /api/accounts ─── */
async function handleCreate(db, request) {
  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').trim();
  const icon = body.icon || '🏦';
  const type = body.type || 'asset';
  const kind = body.kind || 'bank';
  const opening_balance = Number(body.opening_balance || 0);
  const currency = body.currency || 'PKR';
  const color = body.color || null;
  const display_order = Number(body.display_order || 99);
  const credit_limit = body.credit_limit != null ? Number(body.credit_limit) : null;
  const min_payment_amount = body.min_payment_amount != null ? Number(body.min_payment_amount) : null;
  const statement_day = body.statement_day != null ? Number(body.statement_day) : null;
  const payment_due_day = body.payment_due_day != null ? Number(body.payment_due_day) : null;

  if (!name) return json({ ok: false, error: 'Name is required' }, 400);
  if (name.length > 60) return json({ ok: false, error: 'Name too long (max 60)' }, 400);
  if (!VALID_KINDS.includes(kind)) {
    return json({ ok: false, error: `Invalid kind: ${kind}. Must be one of: ${VALID_KINDS.join(', ')}` }, 400);
  }
  if (credit_limit != null && credit_limit < 0) return json({ ok: false, error: 'credit_limit cannot be negative' }, 400);
  if (statement_day != null && (statement_day < 1 || statement_day > 31)) return json({ ok: false, error: 'statement_day must be 1-31' }, 400);
  if (payment_due_day != null && (payment_due_day < 1 || payment_due_day > 31)) return json({ ok: false, error: 'payment_due_day must be 1-31' }, 400);

  const id = body.id || slugifyId(name);
  const existing = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (existing) return json({ ok: false, error: 'Account id already exists — pick a different name' }, 409);

  await db
    .prepare(
      `INSERT INTO accounts
        (id, name, icon, type, kind, opening_balance, currency, color, display_order, status,
         credit_limit, min_payment_amount, statement_day, payment_due_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .bind(
      id, name, icon, type, kind, opening_balance, currency, color, display_order,
      credit_limit, min_payment_amount, statement_day, payment_due_day
    )
    .run();

  await audit(db, {
    action: 'ACCOUNT_CREATE',
    entity_type: 'account',
    entity_id: id,
    details: {
      name, icon, type, kind, opening_balance, currency, display_order,
      credit_limit, min_payment_amount, statement_day, payment_due_day,
    },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'ACCOUNT_CREATE' });
}

/* ─── GET /api/accounts/{id} ─── */
async function handleSingle(db, id) {
  const row = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!row) return json({ ok: false, error: 'Account not found' }, 404);
  const balance = await computeBalance(db, row.id, row.opening_balance);
  const enriched = enrichCCFields({
    ...row,
    balance,
    kind_label: kindLabel(row.kind),
    is_credit_card: isCreditCard(row.kind),
    credit_limit: row.credit_limit != null ? Number(row.credit_limit) : null,
    min_payment_amount: row.min_payment_amount != null ? Number(row.min_payment_amount) : null,
    statement_day: row.statement_day != null ? Number(row.statement_day) : null,
    payment_due_day: row.payment_due_day != null ? Number(row.payment_due_day) : null,
  });
  return json({ ok: true, account: enriched });
}

/* ─── PUT /api/accounts/{id} ─── */
async function handleEdit(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Account not found' }, 404);

  const allowed = [
    'name', 'icon', 'type', 'kind', 'opening_balance', 'currency', 'color', 'display_order',
    'credit_limit', 'min_payment_amount', 'statement_day', 'payment_due_day',
  ];
  const updates = {};
  for (const k of allowed) {
    if (k in body && body[k] !== undefined) updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No editable fields supplied' }, 400);
  }

  if ('name' in updates) {
    const n = String(updates.name || '').trim();
    if (!n) return json({ ok: false, error: 'Name cannot be empty' }, 400);
    if (n.length > 60) return json({ ok: false, error: 'Name too long' }, 400);
    updates.name = n;
  }
  if ('kind' in updates && !VALID_KINDS.includes(updates.kind)) {
    return json({ ok: false, error: `Invalid kind: ${updates.kind}. Must be one of: ${VALID_KINDS.join(', ')}` }, 400);
  }
  if ('opening_balance' in updates) updates.opening_balance = Number(updates.opening_balance) || 0;
  if ('display_order' in updates) updates.display_order = Number(updates.display_order) || 0;
  if ('credit_limit' in updates) {
    const v = updates.credit_limit;
    if (v === null || v === '') updates.credit_limit = null;
    else {
      const n = Number(v);
      if (isNaN(n) || n < 0) return json({ ok: false, error: 'credit_limit must be ≥ 0 or null' }, 400);
      updates.credit_limit = n;
    }
  }
  if ('min_payment_amount' in updates) {
    const v = updates.min_payment_amount;
    if (v === null || v === '') updates.min_payment_amount = null;
    else {
      const n = Number(v);
      if (isNaN(n) || n < 0) return json({ ok: false, error: 'min_payment_amount must be ≥ 0 or null' }, 400);
      updates.min_payment_amount = n;
    }
  }
  if ('statement_day' in updates) {
    const v = updates.statement_day;
    if (v === null || v === '') updates.statement_day = null;
    else {
      const n = Number(v);
      if (isNaN(n) || n < 1 || n > 31) return json({ ok: false, error: 'statement_day must be 1-31 or null' }, 400);
      updates.statement_day = n;
    }
  }
  if ('payment_due_day' in updates) {
    const v = updates.payment_due_day;
    if (v === null || v === '') updates.payment_due_day = null;
    else {
      const n = Number(v);
      if (isNaN(n) || n < 1 || n > 31) return json({ ok: false, error: 'payment_due_day must be 1-31 or null' }, 400);
      updates.payment_due_day = n;
    }
  }

  const snapId = await snapshot(db, {
    label: `account_edit_${id}_${Date.now()}`,
    tables: ['accounts'],
    where: `id = '${id}'`,
  });

  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(updates);
  await db.prepare(`UPDATE accounts SET ${sets} WHERE id = ?`).bind(...vals, id).run();

  await audit(db, {
    action: 'ACCOUNT_EDIT',
    entity_type: 'account',
    entity_id: id,
    details: { before: existing, after: updates, snapshot_id: snapId },
    created_by: 'web',
  });

  return json({ ok: true, id, updated_fields: Object.keys(updates), snapshot_id: snapId });
}

/* ─── DELETE /api/accounts/{id} — FK-SAFE smart delete ─── */
async function handleDelete(db, id, request) {
  const url = new URL(request.url);
  const created_by = url.searchParams.get('created_by') || 'web';

  const existing = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Account not found' }, 404);

  const refs = await fkRefs(db, id);
  if (refs.total > 0) {
    return json({
      ok: false,
      error: `Cannot delete: account has ${refs.transactions} transaction(s) and ${refs.bills} active bill(s) referencing it.`,
      refs,
      suggested_action: 'archive',
      hint: 'Use POST /api/accounts/{id}/archive to hide this account without breaking historical references.',
    }, 409);
  }

  const snapId = await snapshot(db, {
    label: `account_delete_${id}_${Date.now()}`,
    tables: ['accounts'],
    where: `id = '${id}'`,
  });

  await db.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id).run();

  await audit(db, {
    action: 'ACCOUNT_DELETE',
    entity_type: 'account',
    entity_id: id,
    details: { before: existing, snapshot_id: snapId, refs_at_delete: refs },
    created_by,
  });

  return json({ ok: true, id, action: 'ACCOUNT_DELETE', snapshot_id: snapId });
}

/* ─── POST /api/accounts/{id}/archive ─── */
async function handleArchive(db, id) {
  const existing = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Account not found' }, 404);
  if (existing.status === 'archived') return json({ ok: false, error: 'Already archived' }, 409);

  const snapId = await snapshot(db, {
    label: `account_archive_${id}_${Date.now()}`,
    tables: ['accounts'],
    where: `id = '${id}'`,
  });

  const now = new Date().toISOString();
  await db
    .prepare(`UPDATE accounts SET status = 'archived', archived_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();

  await audit(db, {
    action: 'ACCOUNT_ARCHIVE',
    entity_type: 'account',
    entity_id: id,
    details: { before: existing, snapshot_id: snapId },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'ACCOUNT_ARCHIVE', snapshot_id: snapId });
}

/* ─── POST /api/accounts/{id}/unarchive ─── */
async function handleUnarchive(db, id) {
  const existing = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Account not found' }, 404);
  if (existing.status !== 'archived') return json({ ok: false, error: 'Account is not archived' }, 409);

  await db
    .prepare(`UPDATE accounts SET status = 'active', archived_at = NULL WHERE id = ?`)
    .bind(id)
    .run();

  await audit(db, {
    action: 'ACCOUNT_UNARCHIVE',
    entity_type: 'account',
    entity_id: id,
    details: { before: existing },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'ACCOUNT_UNARCHIVE' });
}
