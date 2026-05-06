/* ─── /api/audit · v0.2.0 · Layer 2 audit contract ─── */
/*
 * Read-only audit log endpoint.
 *
 * Supports:
 *   GET /api/audit
 *   GET /api/audit?limit=50&offset=0
 *   GET /api/audit?action=TRANSFER
 *   GET /api/audit?entity=transaction
 *   GET /api/audit?kind=mutation
 *   GET /api/audit?from=2026-05-01&to=2026-05-06
 *
 * Layer 2 contract:
 *   - Audit endpoint is read-only.
 *   - Response is versioned and stable.
 *   - Pagination is bounded.
 *   - Filters are parameterized.
 *   - Detail is returned both raw and parsed when possible.
 *   - No cache for audit reads.
 */

const VERSION = 'v0.2.0';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);

  const action = cleanFilter(url.searchParams.get('action'));
  const entity = cleanFilter(url.searchParams.get('entity'));
  const kind = cleanFilter(url.searchParams.get('kind'));

  const from = cleanDate(url.searchParams.get('from'));
  const to = cleanDate(url.searchParams.get('to'));

  const where = [];
  const binds = [];

  if (action) {
    where.push('action = ?');
    binds.push(action);
  }

  if (entity) {
    where.push('entity = ?');
    binds.push(entity);
  }

  if (kind) {
    where.push('kind = ?');
    binds.push(kind);
  }

  if (from) {
    where.push('date(timestamp) >= date(?)');
    binds.push(from);
  }

  if (to) {
    where.push('date(timestamp) <= date(?)');
    binds.push(to);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const countRes = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`)
      .bind(...binds)
      .first();

    const rowsRes = await env.DB
      .prepare(
        `SELECT id, timestamp, action, entity, entity_id, kind, detail, created_by, ip
         FROM audit_log ${whereSql}
         ORDER BY datetime(timestamp) DESC, id DESC
         LIMIT ?
         OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all();

    const rows = (rowsRes.results || []).map(normalizeAuditRow);

    return json({
      ok: true,
      version: VERSION,
      total: Number(countRes && countRes.n) || 0,
      limit,
      offset,
      filters: {
        action,
        entity,
        kind,
        from,
        to
      },
      rows,
      count: rows.length,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost() {
  return json({
    ok: false,
    version: VERSION,
    error: 'Audit log is read-only'
  }, 405);
}

export async function onRequestPut() {
  return json({
    ok: false,
    version: VERSION,
    error: 'Audit log is read-only'
  }, 405);
}

export async function onRequestDelete() {
  return json({
    ok: false,
    version: VERSION,
    error: 'Audit log is read-only'
  }, 405);
}

function normalizeAuditRow(row) {
  const detailRaw = row.detail == null ? '' : String(row.detail);
  const parsed = parseDetail(detailRaw);

  return {
    id: row.id,
    timestamp: row.timestamp,
    action: row.action || 'UNKNOWN',
    entity: row.entity || 'unknown',
    entity_id: row.entity_id || null,
    kind: row.kind || 'event',
    detail: detailRaw,
    detail_json: parsed.ok ? parsed.value : null,
    detail_parse_error: parsed.ok ? null : parsed.error,
    created_by: row.created_by || 'system',
    ip: row.ip || null
  };
}

function parseDetail(raw) {
  if (!raw) {
    return { ok: true, value: null };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(raw)
    };
  } catch (err) {
    return {
      ok: false,
      value: null,
      error: err.message
    };
  }
}

function clampInt(value, fallback, min, max) {
  const parsed = parseInt(value, 10);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, parsed));
}

function cleanFilter(value) {
  if (value == null) return null;

  const text = String(value).trim();

  if (!text) return null;
  if (text.length > 80) return text.slice(0, 80);

  return text;
}

function cleanDate(value) {
  if (value == null) return null;

  const text = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  return text;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
