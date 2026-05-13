/* /api/reconciliation
 * Sovereign Finance · Reconciliation Engine
 * v0.2.0-reconciliation-declaration-health
 *
 * Banking-grade rules:
 * - /api/accounts is the current balance source.
 * - Reconciliation never writes ledger transactions directly.
 * - Declaration records evidence only: declared balance vs computed balance.
 * - Adjustment workflow is blocked until routed through /api/transactions dry-run + commit hash.
 * - Every rupee drift gets severity, proof, source version, and audit trail.
 */

const VERSION = 'v0.2.0-reconciliation-declaration-health';

const SOURCE_ENDPOINT = '/api/accounts';
const OK_THRESHOLD = 100;
const CHECK_THRESHOLD = 1000;

export async function onRequestGet(context) {
  try {
    const path = getPath(context);

    if (path[0] === 'health') {
      return getHealth(context);
    }

    if (path[0] === 'declarations') {
      return getDeclarations(context);
    }

    return getOverview(context);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = getPath(context);
    const body = await readJSON(context.request);
    const dryRun = isDryRun(context.request, body);

    if (path[0] === 'declare' || path.length === 0) {
      return declareBalance(context, body, dryRun);
    }

    if (path[0] === 'adjustment' || path[0] === 'adjust') {
      return json({
        ok: false,
        version: VERSION,
        error: 'Adjustment commit is intentionally blocked in reconciliation backend.',
        reason: 'Reconciliation records declarations only. Any ledger adjustment must go through /api/transactions dry-run + payload hash commit.',
        required_flow: [
          'Save reconciliation declaration',
          'Investigate drift',
          'Prepare /api/transactions dry-run adjustment',
          'Commit only through transactions payload hash'
        ]
      }, 423);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported reconciliation POST route.'
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

/* ─────────────────────────────
 * GET overview
 * ───────────────────────────── */

async function getOverview(context) {
  const db = context.env.DB;
  await ensureTables(db);

  const source = await readAccountsSource(context);
  if (!source.ok) {
    return json({
      ok: false,
      version: VERSION,
      status: 'source_error',
      error: 'Unable to read /api/accounts.',
      source
    }, 200);
  }

  const accounts = normalizeAccounts(source.payload);
  const latestMap = await loadLatestDeclarations(db);

  const rows = accounts.map(account => {
    const latest = latestMap.get(account.id) || null;
    const computed = round2(account.balance);
    const declared = latest ? round2(latest.declared_balance) : null;
    const delta = latest ? round2(declared - computed) : null;
    const severity = latest ? classifyDelta(delta) : 'not_reconciled';

    return {
      ...account,
      computed_balance: computed,
      latest_declaration: latest,
      declared_balance: declared,
      delta,
      drift_abs: delta == null ? null : round2(Math.abs(delta)),
      severity,
      reconciled: Boolean(latest)
    };
  });

  const summary = summarize(rows);

  return json({
    ok: true,
    version: VERSION,
    status: summary.investigate_count > 0 ? 'investigate' : summary.check_count > 0 ? 'check' : 'ok',
    source: SOURCE_ENDPOINT,
    source_version: source.version,
    generated_at: nowISO(),

    accounts: rows,
    summary,

    policy: {
      source_endpoint: SOURCE_ENDPOINT,
      source_rule: 'Reconciliation must display same computed balances as Accounts.',
      delta_formula: 'declared_balance - computed_balance',
      ok_threshold_abs_lt: OK_THRESHOLD,
      check_threshold_abs_lt: CHECK_THRESHOLD,
      investigate_threshold_abs_gte: CHECK_THRESHOLD,
      ledger_write_policy: 'blocked',
      adjustment_requires_transactions_api: true,
      direct_transactions_insert_allowed: false,
      declaration_persists: true
    },

    sign_policy: {
      asset_accounts: 'Declare actual positive available balance from bank/wallet/cash.',
      liability_accounts: 'Declare outstanding as negative balance, matching Accounts display convention.',
      formula: 'delta = declared - computed'
    }
  });
}

/* ─────────────────────────────
 * GET health
 * ───────────────────────────── */

async function getHealth(context) {
  const db = context.env.DB;
  await ensureTables(db);

  const source = await readAccountsSource(context);
  const accounts = source.ok ? normalizeAccounts(source.payload) : [];
  const latestMap = await loadLatestDeclarations(db);

  const rows = accounts.map(account => {
    const latest = latestMap.get(account.id) || null;
    const delta = latest ? round2(round2(latest.declared_balance) - round2(account.balance)) : null;

    return {
      account_id: account.id,
      account_name: account.name,
      computed_balance: round2(account.balance),
      declared_balance: latest ? round2(latest.declared_balance) : null,
      delta,
      severity: latest ? classifyDelta(delta) : 'not_reconciled',
      declared_at: latest ? latest.declared_at : null
    };
  });

  const summary = summarize(rows);
  const directWriteBlocked = true;

  return json({
    ok: true,
    version: VERSION,
    status: !source.ok
      ? 'source_error'
      : summary.investigate_count > 0
        ? 'investigate'
        : summary.check_count > 0
          ? 'check'
          : 'ok',

    source: {
      endpoint: SOURCE_ENDPOINT,
      ok: source.ok,
      version: source.version,
      status: source.status,
      error: source.error || null
    },

    checks: {
      source_available: source.ok,
      accounts_returned: accounts.length,
      active_accounts_returned: accounts.filter(a => a.active).length,
      declaration_rows: await countRows(db, 'reconciliation_declarations'),
      declared_accounts: summary.declared_count,
      open_drift_count: summary.check_count + summary.investigate_count,
      high_drift_count: summary.investigate_count,
      total_abs_drift: summary.total_abs_drift,
      direct_transaction_insert_disabled: directWriteBlocked,
      adjustment_commit_blocked: true
    },

    summary,
    rows
  });
}

/* ─────────────────────────────
 * GET declarations
 * ───────────────────────────── */

async function getDeclarations(context) {
  const db = context.env.DB;
  await ensureTables(db);

  const url = new URL(context.request.url);
  const accountId = safeText(url.searchParams.get('account_id'), '', 120);
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100);

  const where = accountId ? 'WHERE account_id = ?' : '';
  const bind = accountId ? [accountId, limit] : [limit];

  const res = await db.prepare(`
    SELECT *
    FROM reconciliation_declarations
    ${where}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).bind(...bind).all();

  return json({
    ok: true,
    version: VERSION,
    count: (res.results || []).length,
    declarations: (res.results || []).map(normalizeDeclaration)
  });
}

/* ─────────────────────────────
 * POST declare
 * ───────────────────────────── */

async function declareBalance(context, body, dryRun) {
  const db = context.env.DB;
  await ensureTables(db);

  const accountId = safeText(body.account_id || body.id, '', 120);
  const declaredBalance = moneyNumber(body.declared_balance ?? body.actual_balance ?? body.balance, null);
  const declaredAt = normalizeDateTime(body.declared_at || body.date) || nowISO();
  const notes = safeText(body.notes, '', 1000);
  const createdBy = safeText(body.created_by, 'web-reconciliation', 120) || 'web-reconciliation';

  if (!accountId) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: dryRun,
      error: 'account_id required'
    }, 400);
  }

  if (declaredBalance == null || !Number.isFinite(declaredBalance)) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: dryRun,
      error: 'declared_balance must be numeric'
    }, 400);
  }

  const source = await readAccountsSource(context);
  if (!source.ok) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: dryRun,
      error: 'Unable to read /api/accounts for computed balance.',
      source
    }, 424);
  }

  const accounts = normalizeAccounts(source.payload);
  const account = accounts.find(a => String(a.id) === String(accountId));

  if (!account) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: dryRun,
      error: 'account_id not found in /api/accounts',
      account_id: accountId
    }, 404);
  }

  const computedBalance = round2(account.balance);
  const delta = round2(declaredBalance - computedBalance);
  const severity = classifyDelta(delta);

  const declaration = {
    id: makeId('recon'),
    account_id: account.id,
    account_name: account.name,
    account_kind: account.kind || account.type || 'asset',
    account_type: account.type || account.kind || 'asset',
    computed_balance: computedBalance,
    declared_balance: round2(declaredBalance),
    delta,
    severity,
    declared_at: declaredAt,
    notes,
    source_endpoint: SOURCE_ENDPOINT,
    source_version: source.version || '',
    source_status: String(source.status || ''),
    created_at: nowISO(),
    created_by: createdBy,
    status: severity === 'ok' ? 'matched' : 'drift_detected'
  };

  const proof = buildDeclarationProof(declaration, account, source);

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      dry_run: true,
      action: 'reconciliation.declare',
      writes_performed: false,
      ledger_writes_performed: false,
      declaration,
      proof
    });
  }

  await insertDeclaration(db, declaration);

  return json({
    ok: true,
    version: VERSION,
    dry_run: false,
    action: 'reconciliation.declare',
    writes_performed: true,
    ledger_writes_performed: false,
    declaration,
    proof
  });
}

/* ─────────────────────────────
 * Source reader
 * ───────────────────────────── */

async function readAccountsSource(context) {
  const url = new URL(SOURCE_ENDPOINT, context.request.url);
  const headers = new Headers();

  headers.set('accept', 'application/json');

  const cookie = context.request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);

  const auth = context.request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);

  const cf = context.request.headers.get('cf-access-jwt-assertion');
  if (cf) headers.set('cf-access-jwt-assertion', cf);

  try {
    const res = await fetch(url.toString(), {
      headers,
      cache: 'no-store'
    });

    const text = await res.text();

    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (err) {
      return {
        ok: false,
        endpoint: SOURCE_ENDPOINT,
        status: res.status,
        version: null,
        error: 'Non-JSON /api/accounts response: ' + err.message,
        preview: text.slice(0, 500)
      };
    }

    return {
      ok: res.ok && payload && payload.ok !== false,
      endpoint: SOURCE_ENDPOINT,
      status: res.status,
      version: payload?.version || payload?.api_version || payload?.meta?.version || null,
      payload,
      error: payload?.error || null
    };
  } catch (err) {
    return {
      ok: false,
      endpoint: SOURCE_ENDPOINT,
      status: 0,
      version: null,
      error: err.message || String(err)
    };
  }
}

function normalizeAccounts(payload) {
  const raw = Array.isArray(payload?.accounts)
    ? payload.accounts
    : payload?.accounts && typeof payload.accounts === 'object'
      ? Object.values(payload.accounts)
      : payload?.accounts_by_id && typeof payload.accounts_by_id === 'object'
        ? Object.values(payload.accounts_by_id)
        : Array.isArray(payload?.account_list)
          ? payload.account_list
          : [];

  return raw
    .filter(Boolean)
    .map(account => {
      const id = safeText(account.id || account.account_id, '', 120);
      const type = safeText(account.type || account.kind || account.account_type || 'asset', 'asset', 80).toLowerCase();
      const kind = safeText(account.kind || account.type || type || 'asset', 'asset', 80).toLowerCase();
      const status = safeText(account.status || 'active', 'active', 80).toLowerCase();

      return {
        id,
        name: safeText(account.name || account.label || id, id, 160),
        type,
        kind,
        status,
        active: status === 'active' || status === '',
        currency: safeText(account.currency || 'PKR', 'PKR', 12).toUpperCase(),
        balance: round2(account.balance ?? account.current_balance ?? account.amount ?? 0),
        sign_policy: isLiability({ type, kind, id, name: account.name })
          ? 'liability_declared_as_negative_outstanding'
          : 'asset_declared_as_positive_available_balance'
      };
    })
    .filter(account => account.id);
}

/* ─────────────────────────────
 * D1 tables
 * ───────────────────────────── */

async function ensureTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS reconciliation_declarations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      account_name TEXT,
      account_kind TEXT,
      account_type TEXT,
      computed_balance REAL NOT NULL,
      declared_balance REAL NOT NULL,
      delta REAL NOT NULL,
      severity TEXT NOT NULL,
      declared_at TEXT NOT NULL,
      notes TEXT,
      source_endpoint TEXT NOT NULL,
      source_version TEXT,
      source_status TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      status TEXT NOT NULL DEFAULT 'drift_detected'
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_reconciliation_declarations_account_created
    ON reconciliation_declarations(account_id, created_at DESC)
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_reconciliation_declarations_severity
    ON reconciliation_declarations(severity)
  `).run();
}

async function insertDeclaration(db, row) {
  await db.prepare(`
    INSERT INTO reconciliation_declarations (
      id,
      account_id,
      account_name,
      account_kind,
      account_type,
      computed_balance,
      declared_balance,
      delta,
      severity,
      declared_at,
      notes,
      source_endpoint,
      source_version,
      source_status,
      created_at,
      created_by,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.id,
    row.account_id,
    row.account_name,
    row.account_kind,
    row.account_type,
    row.computed_balance,
    row.declared_balance,
    row.delta,
    row.severity,
    row.declared_at,
    row.notes,
    row.source_endpoint,
    row.source_version,
    row.source_status,
    row.created_at,
    row.created_by,
    row.status
  ).run();
}

async function loadLatestDeclarations(db) {
  const res = await db.prepare(`
    SELECT d.*
    FROM reconciliation_declarations d
    INNER JOIN (
      SELECT account_id, MAX(datetime(created_at)) AS max_created
      FROM reconciliation_declarations
      GROUP BY account_id
    ) latest
      ON latest.account_id = d.account_id
     AND latest.max_created = datetime(d.created_at)
    ORDER BY d.account_id
  `).all();

  const map = new Map();

  for (const row of res.results || []) {
    map.set(String(row.account_id), normalizeDeclaration(row));
  }

  return map;
}

function normalizeDeclaration(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    account_kind: row.account_kind,
    account_type: row.account_type,
    computed_balance: round2(row.computed_balance),
    declared_balance: round2(row.declared_balance),
    delta: round2(row.delta),
    severity: row.severity,
    declared_at: row.declared_at,
    notes: row.notes || '',
    source_endpoint: row.source_endpoint,
    source_version: row.source_version || '',
    source_status: row.source_status || '',
    created_at: row.created_at,
    created_by: row.created_by || '',
    status: row.status || 'drift_detected'
  };
}

/* ─────────────────────────────
 * Proof / summary
 * ───────────────────────────── */

function buildDeclarationProof(declaration, account, source) {
  return {
    action: 'reconciliation.declare',
    version: VERSION,
    writes_performed: false,
    ledger_writes_performed: false,
    source_of_truth: SOURCE_ENDPOINT,
    source_version: source.version || null,
    formula: 'declared_balance - computed_balance',
    computed_balance: declaration.computed_balance,
    declared_balance: declaration.declared_balance,
    delta: declaration.delta,
    severity: declaration.severity,
    checks: [
      {
        check: 'source_available',
        status: source.ok ? 'pass' : 'fail',
        source: SOURCE_ENDPOINT,
        detail: 'Computed balance loaded from /api/accounts.'
      },
      {
        check: 'account_found',
        status: account ? 'pass' : 'fail',
        source: SOURCE_ENDPOINT,
        detail: account ? `Account ${account.id} found.` : 'Account missing.'
      },
      {
        check: 'declared_balance_numeric',
        status: Number.isFinite(declaration.declared_balance) ? 'pass' : 'fail',
        source: 'request.declared_balance',
        detail: 'Declared balance is numeric.'
      },
      {
        check: 'severity_assigned',
        status: 'pass',
        source: 'reconciliation.policy',
        detail: `Severity ${declaration.severity} assigned from absolute drift.`
      },
      {
        check: 'ledger_write_blocked',
        status: 'pass',
        source: 'api.contract',
        detail: 'Reconciliation declaration does not mutate transactions or account balances.'
      }
    ]
  };
}

function summarize(rows) {
  let declaredCount = 0;
  let okCount = 0;
  let checkCount = 0;
  let investigateCount = 0;
  let notReconciledCount = 0;
  let totalAbsDrift = 0;

  for (const row of rows) {
    if (!row.reconciled && row.severity === 'not_reconciled') {
      notReconciledCount += 1;
      continue;
    }

    declaredCount += 1;

    const abs = Math.abs(Number(row.delta || 0));
    totalAbsDrift += abs;

    if (row.severity === 'ok') okCount += 1;
    else if (row.severity === 'check') checkCount += 1;
    else if (row.severity === 'investigate') investigateCount += 1;
  }

  return {
    account_count: rows.length,
    active_account_count: rows.filter(r => r.active).length,
    declared_count: declaredCount,
    not_reconciled_count: notReconciledCount,
    ok_count: okCount,
    check_count: checkCount,
    investigate_count: investigateCount,
    open_drift_count: checkCount + investigateCount,
    total_abs_drift: round2(totalAbsDrift)
  };
}

function classifyDelta(delta) {
  const abs = Math.abs(Number(delta || 0));

  if (abs < OK_THRESHOLD) return 'ok';
  if (abs < CHECK_THRESHOLD) return 'check';
  return 'investigate';
}

/* ─────────────────────────────
 * Helpers
 * ───────────────────────────── */

function getPath(context) {
  const raw = context.params && context.params.path;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(x => String(x)).filter(Boolean);
  return String(raw).split('/').filter(Boolean);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isDryRun(request, body) {
  const url = new URL(request.url);

  return url.searchParams.get('dry_run') === '1' ||
    url.searchParams.get('dry_run') === 'true' ||
    body.dry_run === true ||
    body.dry_run === '1' ||
    body.dry_run === 'true';
}

function moneyNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? round2(n) : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function safeText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function normalizeDateTime(value) {
  const raw = safeText(value, '', 80);
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw + 'T00:00:00.000Z';
  }

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString();
}

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isLiability(account) {
  const joined = [
    account.kind,
    account.type,
    account.name,
    account.id
  ].map(v => String(v || '').toLowerCase()).join(' ');

  return joined.includes('liability') ||
    joined.includes('credit') ||
    joined.includes('cc') ||
    joined.includes('card');
}

async function countRows(db, table) {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}