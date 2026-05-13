/* /api/audit
 * Sovereign Finance · Audit Trail Engine
 * v0.3.0-audit-health-integrity
 *
 * Banking-grade audit backend:
 * - Read-only audit viewer
 * - Health endpoint
 * - Hash-chain verification endpoint
 * - CSV / JSON export
 * - Entity drilldown
 * - Action taxonomy
 * - POST/PUT/DELETE blocked
 *
 * Important:
 * - This does not mutate money.
 * - This does not backfill hashes yet.
 * - It verifies row_hash where present and reports coverage.
 */

const VERSION = 'v0.3.0-audit-health-integrity';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const ACTION_TAXONOMY = {
  transactions: [
    'TXN_ADD',
    'TRANSACTION_CREATED',
    'TRANSACTION_REVERSED',
    'TRANSACTION_REVERSE_BLOCKED',
    'TRANSFER',
    'TRANSFER_CREATED',
    'TRANSFER_REVERSED'
  ],
  bills: [
    'BILL_PAYMENT_CREATED',
    'BILL_PAYMENT_REVERSED',
    'BILL_PAYMENT_EXCLUDED_LEDGER_REVERSED',
    'BILL_REPAIR_RUN'
  ],
  debts: [
    'DEBT_CREATED',
    'DEBT_ORIGIN_LEDGER_CREATED',
    'DEBT_ORIGIN_LEDGER_REPAIRED',
    'DEBT_PAYMENT_CREATED',
    'DEBT_PAYMENT_REVERSED',
    'DEBT_PURGED'
  ],
  salary: [
    'SALARY_CONFIG_SAVED',
    'SALARY_DETECTED',
    'SALARY_CANDIDATE_IGNORED'
  ],
  reconciliation: [
    'RECONCILIATION_DECLARED',
    'RECONCILIATION_DRIFT_DETECTED',
    'RECONCILIATION_ADJUSTMENT_PROPOSED',
    'RECONCILIATION_ADJUSTMENT_COMMITTED'
  ],
  system: [
    'AUDIT_VERIFY_RUN',
    'AUDIT_EXPORT_RUN',
    'MANUAL_D1_PURGE_DECLARED',
    'SOURCE_DEGRADED',
    'CRISIS_DETECTED'
  ]
};

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();

  if (method !== 'GET') {
    return json({
      ok: false,
      version: VERSION,
      error: 'Audit log is read-only.',
      write_policy: 'blocked',
      allowed_methods: ['GET']
    }, 405);
  }

  try {
    const path = getPath(context);

    if (path[0] === 'health') return getHealth(context);
    if (path[0] === 'verify') return getVerify(context);
    if (path[0] === 'export.csv') return exportCsv(context);
    if (path[0] === 'export.json') return exportJson(context);
    if (path[0] === 'actions') return getActions();
    if (path[0] === 'entity') return getEntityAudit(context, path[1], path[2]);
    if (path[0] === 'correlation') return getCorrelationAudit(context, path[1]);

    return getAuditList(context);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

/* ─────────────────────────────
 * Main list
 * ───────────────────────────── */

async function getAuditList(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const cols = await auditColumns(db);

  const limit = clampInt(url.searchParams.get('limit'), 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1000000, 0);

  const filters = buildFilters(url, cols);
  const select = selectAuditColumns(cols);

  const countRow = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM audit_log
    ${filters.where}
  `).bind(...filters.args).first();

  const rows = await db.prepare(`
    SELECT ${select.join(', ')}
    FROM audit_log
    ${filters.where}
    ORDER BY ${orderBy(cols)}
    LIMIT ? OFFSET ?
  `).bind(...filters.args, limit, offset).all();

  const events = (rows.results || []).map(row => normalizeAuditRow(row, cols));
  const health = await buildHealth(db, cols);

  return json({
    ok: true,
    version: VERSION,
    read_only: true,
    write_policy: 'blocked',
    count: Number(countRow?.count || 0),
    limit,
    offset,
    next_offset: offset + events.length < Number(countRow?.count || 0) ? offset + events.length : null,
    filters: filters.echo,
    health_summary: {
      status: health.status,
      row_count: health.row_count,
      hash_coverage_pct: health.hash_coverage_pct,
      first_hash_break: health.first_hash_break
    },
    events,
    rows: events
  });
}

/* ─────────────────────────────
 * Health
 * ───────────────────────────── */

async function getHealth(context) {
  const db = context.env.DB;
  const cols = await auditColumns(db);
  const health = await buildHealth(db, cols);

  return json({
    ok: true,
    version: VERSION,
    health,
    status: health.status
  });
}

async function buildHealth(db, cols) {
  const exists = cols.size > 0;

  if (!exists) {
    return {
      status: 'missing',
      audit_table_exists: false,
      row_count: 0,
      hashed_row_count: 0,
      hash_coverage_pct: 0,
      first_hash_break: null,
      latest_event_at: null,
      latest_event_id: null,
      action_counts: {},
      critical_event_count: 0,
      checks: {
        read_available: false,
        hash_columns_present: false,
        chain_verifiable: false,
        post_blocked: true,
        export_available: true
      }
    };
  }

  const rowCount = Number((await db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).first())?.c || 0);

  const hashColsPresent = cols.has('row_hash') && cols.has('prev_hash');

  const hashedRowCount = hashColsPresent
    ? Number((await db.prepare(`
        SELECT COUNT(*) AS c
        FROM audit_log
        WHERE row_hash IS NOT NULL AND row_hash != ''
      `).first())?.c || 0)
    : 0;

  const latest = await db.prepare(`
    SELECT ${selectAuditColumns(cols).join(', ')}
    FROM audit_log
    ORDER BY ${orderBy(cols)}
    LIMIT 1
  `).first();

  const actionCounts = await getActionCounts(db, cols);
  const criticalEventCount = await countCriticalEvents(db, cols);
  const verify = hashColsPresent ? await verifyHashChain(db, cols, 10000) : null;

  const hashCoveragePct = rowCount ? Math.round((hashedRowCount / rowCount) * 10000) / 100 : 0;

  let status = 'ok';

  if (!exists) status = 'missing';
  else if (verify && !verify.ok) status = 'tamper_suspect';
  else if (rowCount > 0 && hashCoveragePct < 100) status = 'partial_hash';
  else if (!hashColsPresent) status = 'no_hash_chain';

  return {
    status,
    audit_table_exists: true,
    row_count: rowCount,
    hashed_row_count: hashedRowCount,
    hash_coverage_pct: hashCoveragePct,
    first_hash_break: verify && !verify.ok ? verify.first_break : null,
    latest_event_at: latest ? eventTimestamp(latest) : null,
    latest_event_id: latest ? latest.id : null,
    action_counts: actionCounts,
    critical_event_count: criticalEventCount,
    checks: {
      read_available: true,
      hash_columns_present: hashColsPresent,
      chain_verifiable: Boolean(hashColsPresent && verify),
      chain_ok: verify ? verify.ok : null,
      post_blocked: true,
      put_blocked: true,
      delete_blocked: true,
      export_available: true,
      entity_drilldown_available: true
    },
    recommendations: recommendationList({
      row_count: rowCount,
      hash_cols_present: hashColsPresent,
      hash_coverage_pct: hashCoveragePct,
      verify
    })
  };
}

/* ─────────────────────────────
 * Verify
 * ───────────────────────────── */

async function getVerify(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const cols = await auditColumns(db);

  const limit = clampInt(url.searchParams.get('limit'), 1, 50000, 10000);

  if (!cols.has('row_hash') || !cols.has('prev_hash')) {
    return json({
      ok: true,
      version: VERSION,
      status: 'no_hash_chain',
      verified: false,
      reason: 'audit_log does not have row_hash and prev_hash columns yet.',
      next_step: 'Add hash-chain columns and route all future audit writes through the centralized audit writer.'
    });
  }

  const result = await verifyHashChain(db, cols, limit);

  return json({
    ok: true,
    version: VERSION,
    status: result.ok ? 'ok' : 'tamper_suspect',
    verified: result.ok,
    ...result
  });
}

async function verifyHashChain(db, cols, limit) {
  const select = selectAuditColumns(cols);

  const rows = await db.prepare(`
    SELECT ${select.join(', ')}
    FROM audit_log
    ORDER BY ${ascendingOrderBy(cols)}
    LIMIT ?
  `).bind(limit).all();

  const events = (rows.results || []).map(row => normalizeAuditRow(row, cols));

  let previousHash = '';
  let checked = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (!event.row_hash) {
      return {
        ok: false,
        checked,
        total_scanned: events.length,
        first_break: {
          index,
          id: event.id,
          timestamp: event.timestamp,
          reason: 'missing_row_hash'
        }
      };
    }

    if ((event.prev_hash || '') !== previousHash) {
      return {
        ok: false,
        checked,
        total_scanned: events.length,
        first_break: {
          index,
          id: event.id,
          timestamp: event.timestamp,
          reason: 'prev_hash_mismatch',
          expected_prev_hash: previousHash,
          stored_prev_hash: event.prev_hash || ''
        }
      };
    }

    const expected = await computeAuditHash(event, previousHash);

    if (expected !== event.row_hash) {
      return {
        ok: false,
        checked,
        total_scanned: events.length,
        first_break: {
          index,
          id: event.id,
          timestamp: event.timestamp,
          reason: 'row_hash_mismatch',
          expected_hash: expected,
          stored_hash: event.row_hash
        }
      };
    }

    previousHash = event.row_hash;
    checked += 1;
  }

  return {
    ok: true,
    checked,
    total_scanned: events.length,
    latest_verified_hash: previousHash || null
  };
}

/* ─────────────────────────────
 * Export
 * ───────────────────────────── */

async function exportJson(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const cols = await auditColumns(db);
  const filters = buildFilters(url, cols);
  const limit = clampInt(url.searchParams.get('limit'), 1, 50000, 10000);
  const select = selectAuditColumns(cols);

  const rows = await db.prepare(`
    SELECT ${select.join(', ')}
    FROM audit_log
    ${filters.where}
    ORDER BY ${orderBy(cols)}
    LIMIT ?
  `).bind(...filters.args, limit).all();

  const events = (rows.results || []).map(row => normalizeAuditRow(row, cols));

  return json({
    ok: true,
    version: VERSION,
    exported_at: nowISO(),
    format: 'json',
    count: events.length,
    filters: filters.echo,
    events
  });
}

async function exportCsv(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const cols = await auditColumns(db);
  const filters = buildFilters(url, cols);
  const limit = clampInt(url.searchParams.get('limit'), 1, 50000, 10000);
  const select = selectAuditColumns(cols);

  const rows = await db.prepare(`
    SELECT ${select.join(', ')}
    FROM audit_log
    ${filters.where}
    ORDER BY ${orderBy(cols)}
    LIMIT ?
  `).bind(...filters.args, limit).all();

  const events = (rows.results || []).map(row => normalizeAuditRow(row, cols));

  const header = [
    'id',
    'timestamp',
    'action',
    'entity',
    'entity_id',
    'kind',
    'severity',
    'created_by',
    'ip',
    'source_route',
    'source_version',
    'request_id',
    'correlation_id',
    'prev_hash',
    'row_hash',
    'detail'
  ];

  const lines = [header.join(',')];

  for (const event of events) {
    lines.push(header.map(key => csvCell(event[key] ?? '')).join(','));
  }

  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'content-disposition': `attachment; filename="sovereign-audit-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}

/* ─────────────────────────────
 * Entity / correlation
 * ───────────────────────────── */

async function getEntityAudit(context, entity, entityId) {
  if (!entity || !entityId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'entity and entity_id required'
    }, 400);
  }

  const db = context.env.DB;
  const cols = await auditColumns(db);
  const select = selectAuditColumns(cols);

  if (!cols.has('entity') || !cols.has('entity_id')) {
    return json({
      ok: false,
      version: VERSION,
      error: 'audit_log does not have entity/entity_id columns'
    }, 409);
  }

  const rows = await db.prepare(`
    SELECT ${select.join(', ')}
    FROM audit_log
    WHERE entity = ? AND entity_id = ?
    ORDER BY ${orderBy(cols)}
    LIMIT 500
  `).bind(entity, entityId).all();

  const events = (rows.results || []).map(row => normalizeAuditRow(row, cols));

  return json({
    ok: true,
    version: VERSION,
    entity,
    entity_id: entityId,
    count: events.length,
    events
  });
}

async function getCorrelationAudit(context, correlationId) {
  if (!correlationId) {
    return json({
      ok: false,
      version: VERSION,
      error: 'correlation_id required'
    }, 400);
  }

  const db = context.env.DB;
  const cols = await auditColumns(db);

  if (!cols.has('correlation_id')) {
    return json({
      ok: false,
      version: VERSION,
      error: 'audit_log does not have correlation_id column yet'
    }, 409);
  }

  const select = selectAuditColumns(cols);

  const rows = await db.prepare(`
    SELECT ${select.join(', ')}
    FROM audit_log
    WHERE correlation_id = ?
    ORDER BY ${ascendingOrderBy(cols)}
    LIMIT 1000
  `).bind(correlationId).all();

  const events = (rows.results || []).map(row => normalizeAuditRow(row, cols));

  return json({
    ok: true,
    version: VERSION,
    correlation_id: correlationId,
    count: events.length,
    events
  });
}

function getActions() {
  return json({
    ok: true,
    version: VERSION,
    taxonomy: ACTION_TAXONOMY,
    flat_actions: Object.values(ACTION_TAXONOMY).flat()
  });
}

/* ─────────────────────────────
 * Query helpers
 * ───────────────────────────── */

async function auditColumns(db) {
  try {
    const info = await db.prepare(`PRAGMA table_info(audit_log)`).all();
    return new Set((info.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function selectAuditColumns(cols) {
  const preferred = [
    'id',
    'timestamp',
    'created_at',
    'action',
    'entity',
    'entity_id',
    'kind',
    'severity',
    'detail',
    'detail_json',
    'payload_hash',
    'before_hash',
    'after_hash',
    'prev_hash',
    'row_hash',
    'created_by',
    'ip',
    'user_agent',
    'request_id',
    'correlation_id',
    'source_route',
    'source_version'
  ];

  const selected = preferred.filter(col => cols.has(col));

  return selected.length ? selected : ['*'];
}

function buildFilters(url, cols) {
  const clauses = [];
  const args = [];
  const echo = {};

  addFilter('action', 'action');
  addFilter('entity', 'entity');
  addFilter('entity_id', 'entity_id');
  addFilter('kind', 'kind');
  addFilter('severity', 'severity');
  addFilter('created_by', 'created_by');
  addFilter('correlation_id', 'correlation_id');
  addFilter('request_id', 'request_id');

  const from = url.searchParams.get('from') || url.searchParams.get('after');
  const to = url.searchParams.get('to') || url.searchParams.get('before');

  const tsCol = timestampColumn(cols);

  if (from && tsCol) {
    clauses.push(`${tsCol} >= ?`);
    args.push(from);
    echo.from = from;
  }

  if (to && tsCol) {
    clauses.push(`${tsCol} <= ?`);
    args.push(to);
    echo.to = to;
  }

  function addFilter(param, column) {
    const value = url.searchParams.get(param);
    if (!value || !cols.has(column)) return;

    clauses.push(`${column} = ?`);
    args.push(value);
    echo[param] = value;
  }

  return {
    where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '',
    args,
    echo
  };
}

function timestampColumn(cols) {
  if (cols.has('timestamp')) return 'timestamp';
  if (cols.has('created_at')) return 'created_at';
  return null;
}

function orderBy(cols) {
  if (cols.has('timestamp')) return 'datetime(timestamp) DESC, id DESC';
  if (cols.has('created_at')) return 'datetime(created_at) DESC, id DESC';
  return 'id DESC';
}

function ascendingOrderBy(cols) {
  if (cols.has('timestamp')) return 'datetime(timestamp) ASC, id ASC';
  if (cols.has('created_at')) return 'datetime(created_at) ASC, id ASC';
  return 'id ASC';
}

function eventTimestamp(row) {
  return row.timestamp || row.created_at || null;
}

/* ─────────────────────────────
 * Row normalization
 * ───────────────────────────── */

function normalizeAuditRow(row, cols) {
  const detail = row.detail_json || row.detail || '';
  const parsed = parseDetail(detail);

  return {
    id: row.id || null,
    timestamp: eventTimestamp(row),
    action: row.action || '',
    entity: row.entity || '',
    entity_id: row.entity_id || '',
    kind: row.kind || '',
    severity: row.severity || inferSeverity(row),
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    detail_json: parsed,
    payload_hash: row.payload_hash || '',
    before_hash: row.before_hash || '',
    after_hash: row.after_hash || '',
    prev_hash: row.prev_hash || '',
    row_hash: row.row_hash || '',
    created_by: row.created_by || '',
    ip: row.ip || '',
    user_agent: row.user_agent || '',
    request_id: row.request_id || '',
    correlation_id: row.correlation_id || '',
    source_route: row.source_route || '',
    source_version: row.source_version || '',
    has_hash: Boolean(row.row_hash),
    raw: row
  };
}

function parseDetail(detail) {
  if (!detail) return null;
  if (typeof detail === 'object') return detail;

  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

function inferSeverity(row) {
  const action = String(row.action || '').toUpperCase();

  if (
    action.includes('BLOCK') ||
    action.includes('FAIL') ||
    action.includes('PURGE') ||
    action.includes('REVERSED') ||
    action.includes('CRISIS')
  ) {
    return 'critical';
  }

  if (
    action.includes('REPAIR') ||
    action.includes('WARN') ||
    action.includes('DEGRADED')
  ) {
    return 'warning';
  }

  return 'info';
}

/* ─────────────────────────────
 * Counts
 * ───────────────────────────── */

async function getActionCounts(db, cols) {
  if (!cols.has('action')) return {};

  const rows = await db.prepare(`
    SELECT action, COUNT(*) AS count
    FROM audit_log
    GROUP BY action
    ORDER BY count DESC, action
    LIMIT 100
  `).all();

  const out = {};

  for (const row of rows.results || []) {
    out[row.action || 'UNKNOWN'] = Number(row.count || 0);
  }

  return out;
}

async function countCriticalEvents(db, cols) {
  if (!cols.has('action')) return 0;

  const severityClause = cols.has('severity')
    ? "severity IN ('critical', 'danger', 'error') OR"
    : '';

  const row = await db.prepare(`
    SELECT COUNT(*) AS c
    FROM audit_log
    WHERE ${severityClause}
      UPPER(action) LIKE '%PURGE%'
      OR UPPER(action) LIKE '%BLOCK%'
      OR UPPER(action) LIKE '%FAIL%'
      OR UPPER(action) LIKE '%CRISIS%'
      OR UPPER(action) LIKE '%REVERSE%'
  `).first();

  return Number(row?.c || 0);
}

/* ─────────────────────────────
 * Hashing
 * ───────────────────────────── */

async function computeAuditHash(event, previousHash) {
  const canonical = [
    event.timestamp || '',
    event.action || '',
    event.entity || '',
    event.entity_id || '',
    event.kind || '',
    event.detail || '',
    event.created_by || '',
    previousHash || ''
  ].join('|');

  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* ─────────────────────────────
 * Recommendations
 * ───────────────────────────── */

function recommendationList(input) {
  const out = [];

  if (!input.hash_cols_present) {
    out.push('Add prev_hash and row_hash columns to audit_log.');
    out.push('Route future audit inserts through centralized hash-chain writer.');
  }

  if (input.hash_cols_present && input.hash_coverage_pct < 100) {
    out.push('Backfill or mark legacy rows as pre-hash legacy; future rows must be 100% hashed.');
  }

  if (input.verify && !input.verify.ok) {
    out.push('Investigate first hash-chain break before trusting audit continuity.');
  }

  out.push('Add audit events to every money-mutating endpoint.');
  out.push('Expose audit health and verify panels in audit.html.');

  return out;
}

/* ─────────────────────────────
 * Utility
 * ───────────────────────────── */

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

  return String(raw).split('/').filter(Boolean);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function nowISO() {
  return new Date().toISOString();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache'
    }
  });
}