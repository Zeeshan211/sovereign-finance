/* /api/categorization-rules — auto-categorization rules engine
 * Sovereign Finance — action-based POST
 *
 * Actions (POST body: {action, ...fields}):
 *   create_rule  {name?, match_field, match_type?, match_value, target_category_id, priority?}
 *   list_rules   {} (also available via GET)
 *   update_rule  {id, ...fields to change}
 *   delete_rule  {id}
 *   apply_rules  {rule_id?, dry_run?}  — dry_run defaults true; pass dry_run:false to commit
 *
 * GET returns the user's rules (same as list_rules).
 */

import { getUserId, json, uuid, audit } from '../_lib.js';

const VERSION = 'v1.0.0-categorization-rules';

const MATCH_FIELDS = new Set(['merchant', 'notes']);
const MATCH_TYPES = new Set(['contains', 'exact', 'starts_with']);

function s(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequestGet(context) {
  const userId = getUserId(context);
  if (!userId) return json({ ok: false, version: VERSION, error: 'Unauthorized' }, 401);
  return handleListRules(context.env.DB, userId);
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return json({ ok: false, version: VERSION, error: 'D1 binding DB missing' }, 500);

    const userId = getUserId(context);
    if (!userId) return json({ ok: false, version: VERSION, error: 'Unauthorized' }, 401);

    const body = await readJson(context.request);
    const action = s(body.action).toLowerCase();

    switch (action) {
      case 'create_rule': return handleCreateRule(db, body, context.env, userId);
      case 'list_rules':  return handleListRules(db, userId);
      case 'update_rule': return handleUpdateRule(db, body, context.env, userId);
      case 'delete_rule': return handleDeleteRule(db, body, context.env, userId);
      case 'apply_rules': return handleApplyRules(db, body, context.env, userId);
      default:
        return json({
          ok: false,
          version: VERSION,
          error: `unknown action "${action}"; expected one of create_rule, list_rules, update_rule, delete_rule, apply_rules`,
        }, 400);
    }
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

async function categoryExists(db, userId, categoryId) {
  const row = await db.prepare(`SELECT id FROM categories WHERE id = ? AND user_id = ?`)
    .bind(categoryId, userId).first();
  return !!row;
}

function validateMatchFields(matchField, matchType, matchValue) {
  if (!MATCH_FIELDS.has(matchField)) {
    return `match_field must be one of: ${[...MATCH_FIELDS].join(', ')}`;
  }
  if (!MATCH_TYPES.has(matchType)) {
    return `match_type must be one of: ${[...MATCH_TYPES].join(', ')}`;
  }
  if (!matchValue) {
    return 'match_value is required';
  }
  return null;
}

async function handleCreateRule(db, body, env, userId) {
  const matchField = s(body.match_field).toLowerCase();
  const matchType = s(body.match_type || 'contains').toLowerCase();
  const matchValue = s(body.match_value).trim();
  const targetCategoryId = s(body.target_category_id).trim();

  const matchError = validateMatchFields(matchField, matchType, matchValue);
  if (matchError) return json({ ok: false, version: VERSION, error: matchError }, 400);

  if (!targetCategoryId) {
    return json({ ok: false, version: VERSION, error: 'target_category_id is required' }, 400);
  }
  if (!(await categoryExists(db, userId, targetCategoryId))) {
    return json({ ok: false, version: VERSION, error: `target_category_id "${targetCategoryId}" not found for this user` }, 400);
  }

  const id = uuid();
  const ts = nowIso();
  const priority = Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0;

  await db.prepare(
    `INSERT INTO categorization_rules
       (id, user_id, name, match_field, match_type, match_value, target_category_id, priority, is_active, times_applied, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).bind(id, userId, s(body.name) || null, matchField, matchType, matchValue, targetCategoryId, priority, ts, ts).run();

  await audit(env, {
    action: 'CATEGORIZATION_RULE_CREATE',
    entity: 'categorization_rules',
    entity_id: id,
    detail: { match_field: matchField, match_type: matchType, match_value: matchValue, target_category_id: targetCategoryId },
    user_id: userId,
  });

  const rule = await db.prepare(`SELECT * FROM categorization_rules WHERE id = ?`).bind(id).first();

  return json({
    ok: true, version: VERSION, action: 'create_rule', committed: true, writes_performed: true,
    data: { rule },
  });
}

async function handleListRules(db, userId) {
  const result = await db.prepare(
    `SELECT * FROM categorization_rules WHERE user_id = ? ORDER BY priority DESC, created_at DESC`
  ).bind(userId).all();

  return json({
    ok: true, version: VERSION, action: 'list_rules', committed: true, writes_performed: false,
    data: { rules: result.results || [] },
  });
}

async function handleUpdateRule(db, body, env, userId) {
  const id = s(body.id).trim();
  if (!id) return json({ ok: false, version: VERSION, error: 'id is required' }, 400);

  const existing = await db.prepare(`SELECT * FROM categorization_rules WHERE id = ? AND user_id = ?`)
    .bind(id, userId).first();
  if (!existing) return json({ ok: false, version: VERSION, error: 'rule not found' }, 404);

  const matchField = body.match_field !== undefined ? s(body.match_field).toLowerCase() : existing.match_field;
  const matchType = body.match_type !== undefined ? s(body.match_type).toLowerCase() : existing.match_type;
  const matchValue = body.match_value !== undefined ? s(body.match_value).trim() : existing.match_value;
  const targetCategoryId = body.target_category_id !== undefined ? s(body.target_category_id).trim() : existing.target_category_id;
  const priority = body.priority !== undefined && Number.isFinite(body.priority) ? Math.trunc(body.priority) : existing.priority;
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
  const name = body.name !== undefined ? (s(body.name) || null) : existing.name;

  const matchError = validateMatchFields(matchField, matchType, matchValue);
  if (matchError) return json({ ok: false, version: VERSION, error: matchError }, 400);
  if (!(await categoryExists(db, userId, targetCategoryId))) {
    return json({ ok: false, version: VERSION, error: `target_category_id "${targetCategoryId}" not found for this user` }, 400);
  }

  const ts = nowIso();
  await db.prepare(
    `UPDATE categorization_rules
     SET name = ?, match_field = ?, match_type = ?, match_value = ?, target_category_id = ?, priority = ?, is_active = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).bind(name, matchField, matchType, matchValue, targetCategoryId, priority, isActive, ts, id, userId).run();

  await audit(env, {
    action: 'CATEGORIZATION_RULE_UPDATE',
    entity: 'categorization_rules',
    entity_id: id,
    detail: { match_field: matchField, match_type: matchType, match_value: matchValue, target_category_id: targetCategoryId },
    user_id: userId,
  });

  const rule = await db.prepare(`SELECT * FROM categorization_rules WHERE id = ?`).bind(id).first();

  return json({
    ok: true, version: VERSION, action: 'update_rule', committed: true, writes_performed: true,
    data: { rule },
  });
}

async function handleDeleteRule(db, body, env, userId) {
  const id = s(body.id).trim();
  if (!id) return json({ ok: false, version: VERSION, error: 'id is required' }, 400);

  const existing = await db.prepare(`SELECT id FROM categorization_rules WHERE id = ? AND user_id = ?`)
    .bind(id, userId).first();
  if (!existing) return json({ ok: false, version: VERSION, error: 'rule not found' }, 404);

  await db.prepare(`DELETE FROM categorization_rules WHERE id = ? AND user_id = ?`).bind(id, userId).run();

  await audit(env, {
    action: 'CATEGORIZATION_RULE_DELETE',
    entity: 'categorization_rules',
    entity_id: id,
    user_id: userId,
  });

  return json({
    ok: true, version: VERSION, action: 'delete_rule', committed: true, writes_performed: true,
    data: { id },
  });
}

function isReversalOrReversed(tx) {
  const notes = s(tx.notes).toUpperCase();
  return notes.includes('[REVERSAL OF ') || !!tx.reversed_by || !!tx.reversed_at || notes.includes('[REVERSED BY ');
}

function ruleMatches(rule, transaction) {
  const haystack = s(transaction[rule.match_field]).toLowerCase();
  const needle = s(rule.match_value).toLowerCase();
  if (!haystack || !needle) return false;

  switch (rule.match_type) {
    case 'exact':       return haystack === needle;
    case 'starts_with': return haystack.startsWith(needle);
    case 'contains':
    default:             return haystack.includes(needle);
  }
}

// category_id is categorization metadata, not a ledger-defining field (amount/type/account/date
// are untouched) — recategorizing existing rows here does not violate the append-only ledger
// contract, which guards against silent edits to the financial facts themselves.
async function handleApplyRules(db, body, env, userId) {
  const dryRun = body.dry_run !== false; // default true
  const ruleId = body.rule_id ? s(body.rule_id).trim() : null;

  let rulesQuery = `SELECT * FROM categorization_rules WHERE user_id = ? AND is_active = 1`;
  const rulesParams = [userId];
  if (ruleId) {
    rulesQuery += ` AND id = ?`;
    rulesParams.push(ruleId);
  }
  rulesQuery += ` ORDER BY priority DESC, created_at ASC`;

  const rulesResult = await db.prepare(rulesQuery).bind(...rulesParams).all();
  const rules = rulesResult.results || [];

  if (rules.length === 0) {
    return json({
      ok: true, version: VERSION, action: 'apply_rules', committed: !dryRun, writes_performed: false,
      data: { dry_run: dryRun, matched: [], matched_count: 0 },
    });
  }

  const txResult = await db.prepare(
    `SELECT id, merchant, notes, category_id, reversed_by, reversed_at FROM transactions WHERE user_id = ?`
  ).bind(userId).all();
  const transactions = (txResult.results || []).filter(tx => !isReversalOrReversed(tx));

  const matches = [];
  for (const tx of transactions) {
    for (const rule of rules) {
      if (rule.target_category_id === tx.category_id) continue;
      if (ruleMatches(rule, tx)) {
        matches.push({ transaction_id: tx.id, rule_id: rule.id, from_category_id: tx.category_id, to_category_id: rule.target_category_id });
        break; // highest-priority matching rule wins per transaction
      }
    }
  }

  if (dryRun) {
    return json({
      ok: true, version: VERSION, action: 'apply_rules', committed: false, writes_performed: false,
      data: { dry_run: true, matched: matches, matched_count: matches.length },
    });
  }

  const ts = nowIso();
  const ruleApplyCounts = new Map();
  for (const m of matches) {
    await db.prepare(`UPDATE transactions SET category_id = ? WHERE id = ? AND user_id = ?`)
      .bind(m.to_category_id, m.transaction_id, userId).run();
    ruleApplyCounts.set(m.rule_id, (ruleApplyCounts.get(m.rule_id) || 0) + 1);
  }

  for (const [appliedRuleId, count] of ruleApplyCounts) {
    await db.prepare(
      `UPDATE categorization_rules SET times_applied = times_applied + ?, last_applied_at = ? WHERE id = ? AND user_id = ?`
    ).bind(count, ts, appliedRuleId, userId).run();
  }

  await audit(env, {
    action: 'CATEGORIZATION_RULES_APPLY',
    entity: 'transactions',
    kind: 'mutation',
    detail: { rule_id: ruleId, applied_count: matches.length },
    user_id: userId,
  });

  return json({
    ok: true, version: VERSION, action: 'apply_rules', committed: true, writes_performed: matches.length > 0,
    data: { dry_run: false, matched: matches, matched_count: matches.length },
  });
}
