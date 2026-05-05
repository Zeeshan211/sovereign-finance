/* /api/merchants/[[path]] v0.1.2 - adds POST /touch (increment learned_count) */
/* D1 schema verified live: id, name, aliases, default_category_id, default_account_id, is_pra_required, learned_count, created_at */
/* Routes: */
/*   GET    /api/merchants            - list all */
/*   GET    /api/merchants/{id}       - get single */
/*   POST   /api/merchants            - create */
/*   POST   /api/merchants/{id}/touch - increment learned_count (auto-rules learning) */
/*   PUT    /api/merchants/{id}       - edit */
/*   DELETE /api/merchants/{id}       - delete */

import { json, audit, snapshot } from '../_lib.js';

function normalizeName(s) {
  if (!s) return '';
  return String(s).toLowerCase().trim();
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

    if (segments.length === 2 && segments[1] === 'touch') {
      var touchId = segments[0];
      if (method === 'POST') return await handleTouch(env, touchId, request);
      return json({ ok: false, error: 'Method not allowed for /touch' }, 405);
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('[merchants api]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function handleList(db) {
  var rs = await db.prepare(
    "SELECT * FROM merchants ORDER BY learned_count DESC, name ASC"
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
  var defaultAccountId = body.default_account_id || null;
  var aliases = body.aliases ? String(body.aliases).trim() : null;
  var isPraRequired = body.is_pra_required ? 1 : 0;
  var createdBy = body.created_by || 'web-merchant-create';

  if (!name) return json({ ok: false, error: 'name is required' }, 400);
  if (name.length > 100) return json({ ok: false, error: 'name too long (max 100)' }, 400);

  var normName = normalizeName(name);
  var existing = await db.prepare(
    "SELECT id, name FROM merchants WHERE LOWER(TRIM(name)) = ?"
  ).bind(normName).first();
  if (existing) {
    return json({ ok: false, error: 'Merchant with this name already exists', existing_id: existing.id, existing_name: existing.name }, 409);
  }

  var id = body.id || ('MER-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  await db.prepare(
    "INSERT INTO merchants (id, name, aliases, default_category_id, default_account_id, is_pra_required, learned_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))"
  ).bind(id, name, aliases, defaultCategoryId, defaultAccountId, isPraRequired).run();

  await audit(env, {
    action: 'MERCHANT_CREATE',
    entity: 'merchant',
    entity_id: id,
    kind: 'mutation',
    detail: JSON.stringify({ id: id, name: name, aliases: aliases, default_category_id: defaultCategoryId, default_account_id: defaultAccountId, is_pra_required: isPraRequired }),
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

  var allowed = ['name', 'aliases', 'default_category_id', 'default_account_id', 'is_pra_required'];
  var updates = {};
  for (var i = 0; i < allowed.length; i++) {
    var k = allowed[i];
    if (k in body && body[k] !== undefined) {
      updates[k] = body[k];
    }
  }

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, error: 'No editable fields supplied' }, 400);
  }

  if ('name' in updates) {
    var n = String(updates.name).trim();
    if (!n) return json({ ok: false, error: 'name cannot be empty' }, 400);
    if (n.length > 100) return json({ ok: false, error: 'name too long' }, 400);

    var normName = normalizeName(n);
    var conflict = await db.prepare(
      "SELECT id FROM merchants WHERE LOWER(TRIM(name)) = ? AND id != ?"
    ).bind(normName, id).first();
    if (conflict) {
      return json({ ok: false, error: 'Another merchant has this name', conflict_id: conflict.id }, 409);
    }
    updates.name = n;
  }

  if ('is_pra_required' in updates) {
    updates.is_pra_required = updates.is_pra_required ? 1 : 0;
  }

  await snapshot(env, 'pre-merchant-edit-' + id + '-' + Date.now(), body.created_by || 'web-merchant-edit');

  var keys = Object.keys(updates);
  var sets = keys.map(function (k) { return k + ' = ?'; }).join(', ');
  var vals = keys.map(function (k) { return updates[k]; });
  vals.push(id);

  var stmt = db.prepare("UPDATE merchants SET " + sets + " WHERE id = ?");
  await stmt.bind.apply(stmt, vals).run();

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

async function handleTouch(env, id, request) {
  var db = env.DB;
  var body;
  try { body = await request.json(); } catch (_) { body = {}; }

  var existing = await db.prepare("SELECT id, learned_count FROM merchants WHERE id = ?").bind(id).first();
  if (!existing) return json({ ok: false, error: 'Merchant not found' }, 404);

  // Increment learned_count by 1
  await db.prepare("UPDATE merchants SET learned_count = COALESCE(learned_count, 0) + 1 WHERE id = ?").bind(id).run();

  // Light audit (no snapshot — touch is non-destructive, high-frequency)
  await audit(env, {
    action: 'MERCHANT_TOUCH',
    entity: 'merchant',
    entity_id: id,
    kind: 'event',
    detail: JSON.stringify({ prev_count: existing.learned_count || 0, source: body.source || 'add-txn' }),
    created_by: body.created_by || 'web-merchant-touch'
  });

  return json({ ok: true, id: id, action: 'MERCHANT_TOUCH', new_count: (existing.learned_count || 0) + 1 });
}
