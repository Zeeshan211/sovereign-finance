/* ─── Sovereign Finance · Accounts Catch-All API · v0.2.1 ───
 * Bug fixes from v0.2.0:
 *   - Credit card detection: kind is 'cc' in D1, not 'credit_card'.
 *     v0.2.0 set is_credit_card=false on Alfalah CC → CC balance was
 *     ADDED to total_assets instead of subtracted from net_worth.
 *     Net worth was overstated by ~157k.
 *   - E-wallet detection: kind is 'wallet' in D1, not 'ewallet'.
 *     v0.2.0 left totals.ewallet=0 despite Easypaisa holding 92,300.77.
 *
 * Both root-caused to: assumed enum values without reading live data.
 * Pattern 4 violation by me, caught by verify-after-deploy step.
 *
 * Routes unchanged from v0.2.0:
 *   GET    /api/accounts                       → list (active only) + balances + totals
 *   POST   /api/accounts                       → create
 *   GET    /api/accounts/{id}                  → single
 *   PUT    /api/accounts/{id}                  → edit
 *   DELETE /api/accounts/{id}?created_by=web   → smart delete (FK-safe)
 *   POST   /api/accounts/{id}/archive          → soft-archive
 *   POST   /api/accounts/{id}/unarchive        → restore
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
    return {
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
    };
  }));

  // Totals — use canonical D1 kinds: cash, bank, wallet, prepaid, cc
  const totals = {
    cash: 0,
    bank: 0,
    ewallet: 0, // backward-compat field name; sourced from kind='wallet'
    prepaid: 0,
    credit_card_outstanding: 0,
    total_assets: 0,
    net_worth: 0,
  };
  for (const a of accounts) {
    if (a.is_credit_card) {
      // CC balance is negative when money is owed; flip sign for "outstanding"
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

  if (!name) return json({ ok: false, error: 'Name is required' }, 400);
  if (name.length > 60) return json({ ok: false, error: 'Name too long (max 60)' }, 400);
  if (!VALID_KINDS.includes(kind)) {
    return json({ ok: false, error: `Invalid kind: ${kind}. Must be one of: ${VALID_KINDS.join(', ')}` }, 400);
  }

  const id = body.id || slugifyId(name);
  const existing = await db.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (existing) return json({ ok: false, error: 'Account id already exists — pick a different name' }, 409);

  await db
    .prepare(
      `INSERT INTO accounts
        (id, name, icon, type, kind, opening_balance, currency, color, display_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    )
    .bind(id, name, icon, type, kind, opening_balance, currency, color, display_order)
    .run();

  await audit(db, {
    action: 'ACCOUNT_CREATE',
    entity_type: 'account',
    entity_id: id,
    details: { name, icon, type, kind, opening_balance, currency, display_order },
    created_by: 'web',
  });

  return json({ ok: true, id, action: 'ACCOUNT_CREATE' });
}

/* ─── GET /api/accounts/{id} ─── */
async function handleSingle(db, id) {
  const row = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!row) return json({ ok: false, error: 'Account not found' }, 404);
  const balance = await computeBalance(db, row.id, row.opening_balance);
  return json({
    ok: true,
    account: {
      ...row,
      balance,
      kind_label: kindLabel(row.kind),
      is_credit_card: isCreditCard(row.kind),
    },
  });
}

/* ─── PUT /api/accounts/{id} ─── */
async function handleEdit(db, id, request) {
  const body = await request.json().catch(() => ({}));
  const existing = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!existing) return json({ ok: false, error: 'Account not found' }, 404);

  const allowed = ['name', 'icon', 'type', 'kind', 'opening_balance', 'currency', 'color', 'display_order'];
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
