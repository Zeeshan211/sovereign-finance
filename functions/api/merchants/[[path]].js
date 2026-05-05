/* /api/merchants/[[path]] v0.1.0 - CRUD endpoint */
/* Schema (per SCHEMA.md): id, name, default_category_id, normalized_pattern, alias, last_used_at, hit_count, created_at */
/* No deleted_at column - hard delete only for now */
/* Pattern: matches debts/[[path]].js v0.2.1 with audit-after-write */

import { json, audit, snapshot } from '../_lib.js';

function normalizePattern(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var params = context.params;
  var path = params.path;
  var segments;
  if (!path) {
    segments = [];
  } else if (Array.isArray(path)) {
    segments = path;
  } else {
    segments = [path];
  }
  var method = request.method;
  var db = env.DB;

  try {
    if (segments.length === 0) {
      if (method === 'GET') return await handleList(db);
      if (method === 'POST') return await handleCreate(env, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    if (segments.length === 1) {
      var id = segments[0];
      if (method === 'GET') return await handleSingle(db, id);
      if (method === 'PUT') return await handleEdit(env, id, request);
      if (method === 'DELETE') return await handleDelete(env, id, request);
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[merchants api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function handleList(db) {
  var rs = await db.prepare(
    "SELECT * FROM merchants ORDER BY hit_count DESC, name ASC"
  ).all();
  var rows = rs.results || [];
  return json({ ok: true, merchants: rows, count: rows.length });
}

async function handleSingle(db, id) {
  var row = await db.prepare(
    "SELECT * FROM merchants WHERE id = ?"
  ).bind(id).first();
  if (!row) return json({ ok: false, error: 'Merchant not found' }, 404);
  return json({ ok: true, merchant: row });
}

async function handleCreate(env, request) {
  var db = env.DB;
  var body;
  try { body = await request.json(); } catch (_) { body = {}; }

  var name = body.name ? String(body.name).trim() : '';
  var defaultCategoryId = body.default_category_id || null;
  var alias = body.alias ? String(body.alias).trim() : null;
  var explicitPattern = body.normalized_pattern ? String(body.normalized_pattern).trim() : null;
  var pattern = explicitPattern || normalizePattern(name);
  var createdBy = body.created_by || 'web-merchant-create';

  if (!name) return json({ ok: false, error: 'name is required' }, 400);
  if (name.length > 100) return json({ ok: false, error: 'name too long (max 100)' }, 400);
  if (!pattern) return json({ ok: false, error: 'normalized_pattern could not be derived' }, 400);

  var existing = await db.prepare(
    "SELECT id FROM merchants WHERE normalized_pattern = ?"
  ).bind(pattern).first();
  if (existing) {
    return json({ ok: false, error: 'Merchant with this pattern already exists', existing_id: existing.id }, 409);
  }

  var id = body.id || ('MER-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  await db.prepare(
    "INSERT INTO merchants (id, name, default_category_id, normalized_pattern, alias, hit_count, created_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'))"
  ).bind(id, name, defaultCategoryId, pattern, alias).run();

  await audit(env, {
    action: 'MERCHANT_CREATE',
    entity: 'merchant',
    entity_id: id,
    kind: 'mutation',
    detail: JSON.stringify({ id: id, name: name, default_category_id: defaultCategoryId, normalized_pattern: pattern, alias: alias }),
    created_by: createdBy
  });

  return json({ ok: true, id: id, action: 'MERCHANT_CREATE' });
}

async function handleEdit(env, id, request) {
  var db = env.DB;
  var body;
  try { body = await request.json(); } catch (_) { body = {}; }

  var existing = await db.prepare("SELECT * FROM merchants WHERE id = ?").bind(id).first();
  if (!existing) return json({ ok: false, error: 'Merchant not found' }, 404);

  var allowed = ['name', 'default_category_id', 'normalized_pattern', 'alias'];
  var updates = {};
  for (var i = 0; i < allowed.length; i++) {
    var k = allowed[i];
    if (k in body && body[k] !== undefined) updates[k] = body[k];
  }

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No editable fields supplied' }, 400);
  }

  if ('name' in updates) {
    var n = String(updates.name).trim();
    if (!n) return json({ ok: false, error: 'name cannot be empty' }, 400);
    if (n.length > 100) return json({ ok: false, error: 'name too long' }, 400);
    updates.name = n;
  }

  if ('normalized_pattern' in updates) {
    var p = String(updates.normalized_pattern).trim();
    if (!p) return json({ ok: false, error: 'normalized_pattern cannot be empty' }, 400);

    var conflict = await db.prepare(
      "SELECT id FROM merchants WHERE normalized_pattern = ? AND id != ?"
    ).bind(p, id).first();
    if (conflict) {
      return json({ ok: false, error: 'Another merchant has this pattern', conflict_id: conflict.id }, 409);
    }
    updates.normalized_pattern = p;
  }

  await snapshot(env, 'pre-merchant-edit-' + id + '-' + Date.now(), body.created_by || 'web-merchant-edit');

  var keys = Object.keys(updates);
  var sets = keys.map(function (k) { return k + ' = ?'; }).join(', ');
  var vals = keys.map(function (k) { return updates[k]; });
  vals.push(id);

  await db.prepare("UPDATE merchants SET " + sets + " WHERE id = ?").bind.apply(null, [].concat(vals)).run();

  await audit(env, {
    action: 'MERCHANT_EDIT',
    entity: 'merchant',
    entity_id: id,
    kind: 'mutation',
    detail: JSON.stringify({ before: existing, after: updates }),
    created_by: body.created_by || 'web-merchant-edit'
  });

  return json({ ok: true, id: id, updated_fields: Object.keys(updates) });
}

async function handleDelete(env, id, request) {
  var db = env.DB;
  var url = new URL(request.url);
  var createdBy = url.searchParams.get('created_by') || 'web-merchant-delete';

  var existing = await db.prepare("SELECT * FROM merchants WHERE id = ?").bind(id).first();
  if (!existing) return json({ ok: false, error: 'Merchant not found' }, 404);

  await snapshot(env, 'pre-merchant-delete-' + id + '-' + Date.now(), createdBy);

  await db.prepare("DELETE FROM merchants WHERE id = ?").bind(id).run();

  await audit(env, {
    action: 'MERCHANT_DELETE',
    entity: 'merchant',
    entity_id: id,
    kind: 'mutation',
    detail: JSON.stringify({ before: existing }),
    created_by: createdBy
  });

  return json({ ok: true, id: id, action: 'MERCHANT_DELETE' });
}
