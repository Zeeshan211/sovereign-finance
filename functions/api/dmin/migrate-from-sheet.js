export async function onRequestPost({ request, env }) {
  const expectedSecret = env.MIGRATION_SECRET;
  if (!expectedSecret) {
    return _err(500, 'MIGRATION_SECRET not configured');
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

  const requiredKeys = ['schema_version', 'transactions', 'debts', 'bills'];
  for (const k of requiredKeys) {
    if (!(k in payload)) return _err(400, 'Missing required key: ' + k);
  }
  if (payload.schema_version !== '1.0') {
    return _err(400, 'Unsupported schema_version: ' + payload.schema_version);
  }

  const db = env.DB;
  const stmts = [];
  const stats = { txns: 0, debts: 0, payments: 0, bills: 0 };

  stmts.push(db.prepare('DELETE FROM debt_payments'));
  stmts.push(db.prepare('DELETE FROM transactions'));
  stmts.push(db.prepare('DELETE FROM debts'));
  stmts.push(db.prepare('DELETE FROM bills'));

  for (const t of payload.transactions) {
    if (!t.txn_id || !t.dt_local || !t.account_id || !t.type) continue;
    stmts.push(
      db.prepare(
        `INSERT INTO transactions
          (txn_id, dt_local, account_id, type, category_id, amount_minor, currency, note, linked_txn_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        t.txn_id, t.dt_local, t.account_id, t.type,
        t.category_id || null, t.amount_minor || 0,
        t.currency || 'PKR', t.note || null,
        t.linked_txn_id || null, t.created_by || 'migration'
      )
    );
    stats.txns++;
  }

  for (const d of payload.debts) {
    if (!d.name) continue;
    stmts.push(
      db.prepare(
        `INSERT INTO debts (name, original_minor, kind, notes, is_active)
         VALUES (?, ?, ?, ?, 1)`
      ).bind(d.name, d.original_minor || 0, d.kind || 'creditor', d.notes || null)
    );
    stats.debts++;
  }

  for (const b of payload.bills) {
    if (!b.name) continue;
    stmts.push(
      db.prepare(
        `INSERT INTO bills (name, account_id, amount_minor, due_day, last_paid_dt, notes, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).bind(
        b.name, b.account_id || null, b.amount_minor || 0,
        b.due_day || null, b.last_paid_dt || null, b.notes || null
      )
    );
    stats.bills++;
  }

  const auditDetail = JSON.stringify({
    source: payload.source || 'unknown',
    exported_at: payload.exported_at,
    stats: stats
  });
  stmts.push(
    db.prepare(
      `INSERT INTO audit_log (action, entity, kind, detail, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind('MIGRATION_FROM_SHEET', 'system', 'admin', auditDetail, 'sheet-migration')
  );

  try {
    await db.batch(stmts);
  } catch(e) {
    return _err(500, 'D1 batch failed: ' + (e.message || String(e)));
  }

  if (payload.debt_payments && payload.debt_payments.length > 0) {
    const paymentStmts = [];
    for (const p of payload.debt_payments) {
      if (!p.debt_name || !p.amount_minor) continue;
      const debtRow = await db.prepare('SELECT id FROM debts WHERE name = ?').bind(p.debt_name).first();
      if (!debtRow) continue;
      paymentStmts.push(
        db.prepare(
          `INSERT INTO debt_payments (debt_id, dt_local, amount_minor, note, created_by)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(debtRow.id, p.dt_local, p.amount_minor, p.note || null, 'sheet-migration')
      );
      stats.payments++;
    }
    if (paymentStmts.length > 0) {
      try { await db.batch(paymentStmts); }
      catch(e) { return _err(500, 'Debt payments insert failed: ' + e.message); }
    }
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
