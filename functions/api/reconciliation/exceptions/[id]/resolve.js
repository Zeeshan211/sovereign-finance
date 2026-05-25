/* Sovereign Finance — Reconciliation Exception Resolve
 * POST /api/reconciliation/exceptions/:id/resolve
 * contract_version: reconciliation-v0.3
 */

const VERSION = 'reconciliation-v0.3';

export async function onRequestPost(context) {
  try {
    const db          = context.env.DB;
    const exceptionId = context.params.id;

    if (!db)          return json({ ok: false, version: VERSION, error: 'DB binding missing', code: 'DB_BINDING_MISSING' }, 500);
    if (!exceptionId) return json({ ok: false, version: VERSION, error: 'Exception ID required', code: 'ID_REQUIRED' }, 400);

    const body = await readJson(context.request);
    const note = clean(body.resolution_note || body.note || '');
    const now  = nowSql();

    const exists = await tableExists(db, 'reconciliation_exceptions');
    if (!exists) {
      return json({ ok: false, version: VERSION, error: 'reconciliation_exceptions table not found', code: 'TABLE_MISSING' }, 500);
    }

    const existing = await db.prepare(
      `SELECT id, status FROM reconciliation_exceptions WHERE id = ? LIMIT 1`
    ).bind(exceptionId).first().catch(() => null);

    if (!existing) {
      return json({ ok: false, version: VERSION, error: `Exception not found: ${exceptionId}`, code: 'NOT_FOUND' }, 404);
    }

    await db.prepare(
      `UPDATE reconciliation_exceptions
       SET status = 'resolved', resolved_at = ?, resolution_note = ?
       WHERE id = ?`
    ).bind(now, note || null, exceptionId).run();

    const updated = await db.prepare(
      `SELECT * FROM reconciliation_exceptions WHERE id = ? LIMIT 1`
    ).bind(exceptionId).first().catch(() => null);

    return json({
      ok:        true,
      version:   VERSION,
      exception: updated || { id: exceptionId, status: 'resolved', resolved_at: now }
    });
  } catch (e) {
    return json({ ok: false, version: VERSION, error: e.message || String(e), code: 'RESOLVE_FAILED' }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

async function tableExists(db, name) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1"
    ).bind(name).first();
    return Boolean(row?.name);
  } catch { return false; }
}

function clean(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
