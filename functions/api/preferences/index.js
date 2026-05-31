// GET  /api/preferences — fetch user preferences (creates defaults if absent)
// PUT  /api/preferences — update one or more preference fields

import { json, audit } from '../_lib.js';

const VALID_THEMES     = new Set(['dark', 'light', 'system']);
const VALID_CURRENCIES = new Set(['PKR', 'USD', 'AED', 'GBP', 'EUR', 'SAR', 'CAD', 'AUD']);
const VALID_DATE_FMTS  = new Set(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']);
const VALID_WEEK_START = new Set(['monday', 'sunday', 'saturday']);

const DEFAULTS = {
  theme: 'dark',
  primary_currency: 'PKR',
  date_format: 'DD/MM/YYYY',
  week_start: 'monday',
  privacy_mode: 0,
  compact_numbers: 1,
};

export async function onRequestGet(context) {
  try {
    const userId = context.data?.user_id;
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    let prefs = await context.env.DB.prepare(
      `SELECT theme, primary_currency, date_format, week_start, privacy_mode, compact_numbers, updated_at
       FROM user_preferences WHERE user_id = ?`
    ).bind(userId).first();

    if (!prefs) {
      await context.env.DB.prepare(
        `INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`
      ).bind(userId).run();
      prefs = { ...DEFAULTS, updated_at: new Date().toISOString() };
    }

    return json({ ok: true, preferences: prefs });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const userId = context.data?.user_id;
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const body = await context.request.json().catch(() => ({}));
    const updates = {};
    const errors  = [];

    if ('theme' in body) {
      if (!VALID_THEMES.has(body.theme)) errors.push(`theme must be one of: ${[...VALID_THEMES].join(', ')}`);
      else updates.theme = body.theme;
    }
    if ('primary_currency' in body) {
      if (!VALID_CURRENCIES.has(body.primary_currency)) errors.push(`primary_currency must be one of: ${[...VALID_CURRENCIES].join(', ')}`);
      else updates.primary_currency = body.primary_currency;
    }
    if ('date_format' in body) {
      if (!VALID_DATE_FMTS.has(body.date_format)) errors.push(`date_format must be one of: ${[...VALID_DATE_FMTS].join(', ')}`);
      else updates.date_format = body.date_format;
    }
    if ('week_start' in body) {
      if (!VALID_WEEK_START.has(body.week_start)) errors.push(`week_start must be one of: ${[...VALID_WEEK_START].join(', ')}`);
      else updates.week_start = body.week_start;
    }
    if ('privacy_mode' in body)    updates.privacy_mode    = body.privacy_mode    ? 1 : 0;
    if ('compact_numbers' in body) updates.compact_numbers = body.compact_numbers ? 1 : 0;

    if (errors.length)                    return json({ ok: false, error: errors.join('; ') }, 400);
    if (!Object.keys(updates).length)     return json({ ok: false, error: 'No valid fields provided' }, 400);

    const now = new Date().toISOString();
    const keys = Object.keys(updates);
    const vals = Object.values(updates);

    // Build: INSERT ... ON CONFLICT DO UPDATE SET field = excluded.field
    const insertCols  = ['user_id', ...keys, 'updated_at'].join(', ');
    const insertPhs   = ['?', ...keys.map(() => '?'), '?'].join(', ');
    const updateSets  = keys.map(k => `${k} = excluded.${k}`).join(', ') + ', updated_at = excluded.updated_at';

    await context.env.DB.prepare(
      `INSERT INTO user_preferences (${insertCols}) VALUES (${insertPhs})
       ON CONFLICT (user_id) DO UPDATE SET ${updateSets}`
    ).bind(userId, ...vals, now).run();

    await audit(context.env, {
      action: 'PREFERENCES_UPDATE',
      entity: 'user_preferences',
      entity_id: userId,
      kind: 'mutation',
      detail: updates,
      created_by: userId,
    });

    const prefs = await context.env.DB.prepare(
      `SELECT theme, primary_currency, date_format, week_start, privacy_mode, compact_numbers, updated_at
       FROM user_preferences WHERE user_id = ?`
    ).bind(userId).first();

    return json({ ok: true, preferences: prefs });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
