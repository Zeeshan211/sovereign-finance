// ════════════════════════════════════════════════════════════════════
// /api/admin/migrate-from-sheet — v1.1 PATH-A LIVE SCHEMA TRANSLATOR
// LOCKED · 7-Layer Audit · Self-Contained
//
// Receives banking-grade payload from Apps Script (File A).
// Translates to live decimal schema before INSERT.
// Atomic: single db.batch() = all-or-nothing.
// ════════════════════════════════════════════════════════════════════

export async function onRequestPost({ request, env }) {
  const expectedSecret = env.MIGRATION_SECRET;
  if (!expectedSecret) {
    return _err(500, 'MIGRATION_SECRET not configured on Cloudflare');
  }
  const providedSecret = request.headers.get('X-Migration-Secret');
  if (providedSecret !== expectedSecret) {
    return _err(401, 'Invalid migration secret');
  }

  let payload;
  try {
    payload = await request.json();
  } catch(e) {
    return _err(400, 'Invalid JSON payload');
  }

  const requiredKeys = ['schema_version', 'accounts', 'transactions', 'debts', 'bills'];
  for (const k of requiredKeys) {
    if (!(k in payload)) return _err(400, 'Missing required key: ' + k);
  }
  if (payload.schema_version !== '1.0') {
    return _err(400, 'Unsupported schema_version: ' + payload.schema_version);
  }

  const db = env.DB;
  const stmts = [];
  const stats = { accounts: 0, txns: 0, debts: 0, bills: 0 };
  const paidMap = payload.debt_paid_map || {};

  // ─── DELETE in safe order: children first, parents last ───
  stmts.push(db.prepare('DELETE FROM transactions'));
  stmts.push(db.prepare('DELETE FROM bills'));
  stmts.push(db.prepare('DELETE FROM debts'));
  stmts.push(db.prepare('DELETE FROM accounts'));

  // ─── INSERT accounts (parents first) ───
  payload.accounts.forEach((a, idx) => {
    if (!a.id || !a.name) return;
    const type = (a.kind === 'cc') ? 'liability' : 'asset';
    stmts.push(
      db.prepare(
        `INSERT INTO accounts
           (id, name, icon, type, kind, opening_balance, display_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        a.id,
        a.name,
        a.icon || '',
        type,
        a.kind || 'bank',
        0,
        idx + 1
      )
    );
    stats.accounts++;
  });

  // ─── INSERT debts (translate kind 'creditor' → 'owe', merge paid_amount) ───
  payload.debts.forEach((d, idx) => {
    if (!d.name) return;
    const id = 'debt_' + String(d.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
    const original = (d.original_minor || 0) / 100;
    const paid = (paidMap[d.name] || 0) / 100;
    const kind = (d.kind === 'receivable' || d.kind === 'owed') ? 'owed' : 'owe';
    stmts.push(
      db.prepare(
        `INSERT INTO debts
           (id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        d.name,
        kind,
        original,
        paid,
        idx + 1,
        null,
        'active',
        d.notes || null
      )
    );
    stats.debts++;
  });

  // ─── INSERT bills (translate amount_minor → amount, account_id → default_account_id) ───
  payload.bills.forEach((b) => {
    if (!b.name) return;
    const id = 'bill_' + String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) + '_' + Date.now().toString(36);
    const amount = (b.amount_minor || 0) / 100;
    stmts.push(
      db.prepare(
        `INSERT INTO bills
           (id, name, amount, due_day, frequency, category_id, default_account_id, last_paid_date, auto_post)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        b.name,
        amount,
        b.due_day || null,
        'monthly',
        'bills',
        b.account_id || null,
        b.last_paid_dt || null,
        0
      )
    );
    stats.bills++;
  });

  // ─── INSERT transactions (translate amount_minor → amount, txn_id → id, dt_local → date, note → notes) ───
  payload.transactions.forEach((t) => {
    if (!t.txn_id || !t.dt_local || !t.account_id || !t.type) return;
    const amount = (t.amount_minor || 0) / 100;
    if (amount <= 0) return;
    stmts.push(
      db.prepare(
        `INSERT INTO transactions
           (id, date, type, amount, account_id, transfer_to_account_id,
            category_id, notes, fee_amount, pra_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        t.txn_id,
        t.dt_local,
        t.type,
        amount,
        t.account_id,
        null,
        t.category_id || 'other',
        t.note || '',
        0,
        0,
        new Date().toISOString()
      )
    );
    stats.txns++;
  });

  // ─── EXECUTE atomic batch ───
  try {
    await db.batch(stmts);
  } catch(e) {
    return _err(500, 'D1 batch failed: ' + (e.message || String(e)));
  }

  // ─── audit_log row (optional — table may not exist) ───
  try {
    const auditDetail = JSON.stringify({
      source: payload.source || 'unknown',
      exported_at: payload.exported_at,
      stats: stats
    });
    await db.prepare(
      `INSERT INTO audit_log (action, entity, kind, detail, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('MIGRATION_FROM_SHEET', 'system', 'admin', auditDetail, 'sheet-migration').run();
  } catch(e) {
    // audit_log table may not exist — non-fatal
  }

  return new Response(JSON.stringify({
    ok: true,
    message: 'Migration successful',
    stats: stats,
    timestamp: new Date().toISOString()
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function _err(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const onRequestGet = () =>
  new Response('POST only', { status: 405 });
