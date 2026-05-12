/* Sovereign Finance — International Rate Config + FX Cache API
 * v1.0.0-intl-rates-core
 *
 * Routes:
 *   GET  /api/intl-rates                    Read current config row.
 *   POST /api/intl-rates                    Update config; writes audit rows for changed fields.
 *   GET  /api/intl-rates/fx?from=USD&to=PKR Cached FX rate (refresh if stale).
 *   POST /api/intl-rates/fx/refresh?...     Force refresh, bypass cache.
 *   GET  /api/intl-rates/audit?limit=20     Recent rate change log.
 *
 * Tables:
 *   intl_rate_config   - single row, id=1
 *   intl_rate_audit    - one row per field change
 *   intl_fx_cache      - cached FX provider responses
 *
 * Hard rules:
 *   - Never silently overwrite config without audit.
 *   - Never call FX provider if a fresh cached row exists.
 *   - Never block on FX provider failure if a stale cached row is available
 *     (return stale + warning instead of erroring).
 */

const VERSION = 'v1.0.0-intl-rates-core';

const EDITABLE_FIELDS = [
  'fx_fee_pct',
  'excise_on_fx_fee_pct',
  'advance_tax_pct',
  'pra_pct',
  'default_bank_charge',
  'default_currency',
  'fx_provider',
  'fx_cache_ttl_minutes'
];

const NUMERIC_FIELDS = new Set([
  'fx_fee_pct',
  'excise_on_fx_fee_pct',
  'advance_tax_pct',
  'pra_pct',
  'default_bank_charge',
  'fx_cache_ttl_minutes'
]);

export async function onRequest(context) {
  try {
    const request = context.request;
    const method = request.method.toUpperCase();
    const path = normalizePath(context.params.path);

    if (method === 'GET' && path.length === 0) {
      return await handleGetConfig(context);
    }

    if (method === 'POST' && path.length === 0) {
      return await handleUpdateConfig(context);
    }

    if (method === 'GET' && path[0] === 'fx') {
      return await handleGetFx(context, false);
    }

    if (method === 'POST' && path[0] === 'fx' && path[1] === 'refresh') {
      return await handleGetFx(context, true);
    }

    if (method === 'GET' && path[0] === 'audit') {
      return await handleGetAudit(context);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported intl-rates route',
      supported_routes: [
        'GET  /api/intl-rates',
        'POST /api/intl-rates',
        'GET  /api/intl-rates/fx?from=USD&to=PKR',
        'POST /api/intl-rates/fx/refresh?from=USD&to=PKR',
        'GET  /api/intl-rates/audit?limit=20'
      ]
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

/* ====================================================================== */
/* CONFIG: read                                                           */
/* ====================================================================== */
async function handleGetConfig(context) {
  const db = context.env.DB;
  const row = await db
    .prepare('SELECT * FROM intl_rate_config WHERE id = 1')
    .first();

  if (!row) {
    return json({
      ok: false,
      version: VERSION,
      error: 'intl_rate_config row missing. Run migration 004 seed.'
    }, 500);
  }

  return json({
    ok: true,
    version: VERSION,
    config: row
  });
}

/* ====================================================================== */
/* CONFIG: update + audit                                                 */
/* ====================================================================== */
async function handleUpdateConfig(context) {
  const db = context.env.DB;
  const body = await readJSON(context.request);
  const changedBy = cleanText(body.changed_by, 'web-intl-rates', 80);
  const reason = cleanText(body.reason, '', 240);

  const current = await db
    .prepare('SELECT * FROM intl_rate_config WHERE id = 1')
    .first();

  if (!current) {
    return json({
      ok: false,
      version: VERSION,
      error: 'intl_rate_config row missing. Run migration 004 seed.'
    }, 500);
  }

  const sanitized = {};
  const audit = [];
  const validation = [];

  for (const field of EDITABLE_FIELDS) {
    if (!(field in body)) continue;

    const raw = body[field];
    const cleaned = cleanField(field, raw, validation);

    if (cleaned === undefined) continue;

    const oldValue = current[field];
    if (sameValue(oldValue, cleaned)) continue;

    sanitized[field] = cleaned;
    audit.push({
      field_name: field,
      old_value: oldValue == null ? null : String(oldValue),
      new_value: String(cleaned)
    });
  }

  if (validation.length > 0) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Validation failed',
      validation
    }, 400);
  }

  if (Object.keys(sanitized).length === 0) {
    return json({
      ok: true,
      version: VERSION,
      changed: 0,
      message: 'No changes to apply',
      config: current
    });
  }

  const setClauses = Object.keys(sanitized).map((k) => `${k} = ?`);
  const updateValues = Object.values(sanitized);
  setClauses.push('updated_at = datetime(\'now\')');
  setClauses.push('updated_by = ?');
  updateValues.push(changedBy);

  const updateSql = `UPDATE intl_rate_config SET ${setClauses.join(', ')} WHERE id = 1`;

  await db.prepare(updateSql).bind(...updateValues).run();

  for (const a of audit) {
    await db
      .prepare(
        'INSERT INTO intl_rate_audit (changed_by, field_name, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?)'
      )
      .bind(changedBy, a.field_name, a.old_value, a.new_value, reason || null)
      .run();
  }

  const updated = await db
    .prepare('SELECT * FROM intl_rate_config WHERE id = 1')
    .first();

  return json({
    ok: true,
    version: VERSION,
    changed: audit.length,
    audit,
    config: updated
  });
}

/* ====================================================================== */
/* FX: cached lookup, optional force-refresh                              */
/* ====================================================================== */
async function handleGetFx(context, forceRefresh) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const from = cleanCurrency(url.searchParams.get('from') || 'USD');
  const to = cleanCurrency(url.searchParams.get('to') || 'PKR');

  if (!from || !to) {
    return json({
      ok: false,
      version: VERSION,
      error: 'from and to currency codes required (e.g. ?from=USD&to=PKR)'
    }, 400);
  }

  if (from === to) {
    return json({
      ok: true,
      version: VERSION,
      from,
      to,
      rate: 1,
      source: 'identity',
      fetched_at: new Date().toISOString(),
      stale: false
    });
  }

  const config = await db
    .prepare('SELECT fx_provider, fx_cache_ttl_minutes FROM intl_rate_config WHERE id = 1')
    .first();

  const ttlMinutes = Number(config?.fx_cache_ttl_minutes) || 360;
  const provider = cleanText(config?.fx_provider, 'exchangerate.host', 80);

  const cached = await db
    .prepare(
      'SELECT id, rate, fetched_at, provider FROM intl_fx_cache WHERE base_currency = ? AND quote_currency = ? ORDER BY fetched_at DESC LIMIT 1'
    )
    .bind(from, to)
    .first();

  const cacheFresh = cached && !isStale(cached.fetched_at, ttlMinutes);

  if (cached && cacheFresh && !forceRefresh) {
    return json({
      ok: true,
      version: VERSION,
      from,
      to,
      rate: Number(cached.rate),
      source: 'cache',
      provider: cached.provider,
      fetched_at: cached.fetched_at,
      stale: false,
      cache_id: cached.id
    });
  }

  const fetched = await fetchFxFromProvider(provider, from, to);

  if (!fetched.ok) {
    if (cached) {
      return json({
        ok: true,
        version: VERSION,
        from,
        to,
        rate: Number(cached.rate),
        source: 'cache_stale_provider_failed',
        provider: cached.provider,
        fetched_at: cached.fetched_at,
        stale: true,
        cache_id: cached.id,
        provider_error: fetched.error
      });
    }
    return json({
      ok: false,
      version: VERSION,
      error: 'FX provider failed and no cached rate available',
      provider,
      from,
      to,
      provider_error: fetched.error
    }, 502);
  }

  const insert = await db
    .prepare(
      'INSERT INTO intl_fx_cache (base_currency, quote_currency, rate, provider, raw_response) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(from, to, fetched.rate, provider, fetched.raw)
    .run();

  return json({
    ok: true,
    version: VERSION,
    from,
    to,
    rate: fetched.rate,
    source: forceRefresh ? 'forced_refresh' : 'fresh_fetch',
    provider,
    fetched_at: new Date().toISOString(),
    stale: false,
    cache_id: insert.meta?.last_row_id || null
  });
}

async function fetchFxFromProvider(provider, from, to) {
  if (provider !== 'open.er-api.com') {
    return { ok: false, error: `Unsupported FX provider: ${provider}. Only open.er-api.com is supported in this shipment.` };
  }

  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;

  try {
    const resp = await fetch(url, {
      headers: { 'accept': 'application/json' }
    });

    if (!resp.ok) {
      return { ok: false, error: `Provider HTTP ${resp.status}` };
    }

    const data = await resp.json();

    if (data?.result !== 'success') {
      return { ok: false, error: `Provider returned error: ${JSON.stringify(data).slice(0, 400)}` };
    }

    const rate = data?.rates?.[to];

    if (!Number.isFinite(rate) || rate <= 0) {
      return { ok: false, error: `Provider returned invalid rate for ${to}: ${JSON.stringify(data?.rates || data).slice(0, 400)}` };
    }

    return {
      ok: true,
      rate,
      raw: JSON.stringify(data).slice(0, 4000)
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/* ====================================================================== */
/* AUDIT: recent rate changes                                             */
/* ====================================================================== */
async function handleGetAudit(context) {
  const db = context.env.DB;
  const url = new URL(context.request.url);
  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 20;

  const rows = await db
    .prepare(
      'SELECT id, changed_at, changed_by, field_name, old_value, new_value, reason FROM intl_rate_audit ORDER BY changed_at DESC, id DESC LIMIT ?'
    )
    .bind(limit)
    .all();

  return json({
    ok: true,
    version: VERSION,
    limit,
    count: rows.results?.length || 0,
    audit: rows.results || []
  });
}

/* ====================================================================== */
/* helpers                                                                */
/* ====================================================================== */
function cleanField(field, raw, validation) {
  if (raw === null || raw === undefined || raw === '') return undefined;

  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      validation.push({ field, error: 'must be a number' });
      return undefined;
    }
    if (n < 0) {
      validation.push({ field, error: 'cannot be negative' });
      return undefined;
    }
    if (field === 'fx_cache_ttl_minutes') {
      const intVal = Math.round(n);
      if (intVal < 1) {
        validation.push({ field, error: 'must be >= 1 minute' });
        return undefined;
      }
      if (intVal > 10080) {
        validation.push({ field, error: 'must be <= 10080 minutes (7 days)' });
        return undefined;
      }
      return intVal;
    }
    if (field.endsWith('_pct') && n > 100) {
      validation.push({ field, error: 'percentage cannot exceed 100' });
      return undefined;
    }
    return Math.round(n * 1000) / 1000;
  }

  if (field === 'default_currency') {
    const cur = cleanCurrency(raw);
    if (!cur) {
      validation.push({ field, error: 'must be 3-letter ISO currency code' });
      return undefined;
    }
    return cur;
  }

    if (field === 'fx_provider') {
    const prov = cleanText(raw, '', 80);
    if (!prov) {
      validation.push({ field, error: 'cannot be empty' });
      return undefined;
    }
    if (prov !== 'open.er-api.com') {
      validation.push({ field, error: 'only open.er-api.com is supported in this shipment' });
      return undefined;
    }
    return prov;
  }

function cleanCurrency(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return '';
  return code;
}

function sameValue(a, b) {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return String(a) === String(b);
}

function isStale(fetchedAtIso, ttlMinutes) {
  if (!fetchedAtIso) return true;
  const fetched = new Date(fetchedAtIso.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(fetched)) return true;
  const ageMs = Date.now() - fetched;
  return ageMs > ttlMinutes * 60 * 1000;
}

async function readJSON(request) {
  const text = await request.text();
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Invalid JSON body');
  }
}

function normalizePath(path) {
  if (!path) return [];
  if (Array.isArray(path)) return path;
  return [path];
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    }
  });
}
