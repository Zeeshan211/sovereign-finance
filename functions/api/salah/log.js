// functions/api/salah/log.js v0.1.0
// Salah log endpoint
//
// Scope:
// - Writes only salah_daily_status and salah_prayer_entries
// - Reads/writes only salah_* tables
// - Does not touch Finance, ledger, transactions, bills, debts, salary, or monthly close

import { json } from '../_lib.js';

const VERSION = 'salah-log-api-v0.1.0';
const TZ = 'Asia/Karachi';

const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'jumuah'];

const CODE_MAP = {
  M: { raw: 'Masjid', normalized: 'M', label: 'Masjid', score: 2.0, masjid: 1 },
  J: { raw: 'Jamaat', normalized: 'J', label: 'Jamaat', score: 1.5, jamaat: 1 },
  H: { raw: 'Home', normalized: 'H', label: 'Home', score: 0.5, home: 1 },
  W: { raw: 'Work', normalized: 'W', label: 'Work', score: 0.5, work: 1 },
  HU: { raw: 'Home·U', normalized: 'HU', label: 'Home Udhr', score: 0.8, home: 1, udhr: 1 },
  WU: { raw: 'Work·U', normalized: 'WU', label: 'Work Udhr', score: 0.8, work: 1, udhr: 1 },
  L: { raw: 'Late', normalized: 'L', label: 'Late', score: 0.3, late: 1 },
  Q: { raw: 'Qaza', normalized: 'Q', label: 'Qaza', score: -1.5, qaza: 1 }
};

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json({ ok: false, version: VERSION, error: 'D1 binding DB is missing' }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const day = cleanDay(body.day) || todayPk();
    const prayer = cleanPrayer(body.prayer);
    const code = cleanCode(body.code);
    const note = cleanText(body.note || '');

    if (!prayer) {
      return json({ ok: false, version: VERSION, error: 'Invalid prayer name' }, 400);
    }

    if (!code || !CODE_MAP[code]) {
      return json({ ok: false, version: VERSION, error: 'Invalid Salah code' }, 400);
    }

    const stamp = nowPkIso();
    const meta = CODE_MAP[code];
    const id = `salah_${day}_${prayer}`;

    await ensureDailyRow(env.DB, day, stamp);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO salah_prayer_entries (
        id, day, prayer_name, raw_code, normalized_code, location_label, score_value,
        is_logged, is_masjid, is_jamaat, is_work, is_home, is_late, is_qaza,
        has_valid_udhr, is_jam_combined, jam_type, logged_at, note,
        source_system, source_tab, source_version, source_row, source_column,
        source_checksum, export_batch_id, exported_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 'salah_page', '🕌 Salah', 'salah-log-api-v0.1.0', NULL, NULL, ?, ?, ?, datetime('now'))`
    ).bind(
      id,
      day,
      prayer,
      meta.raw,
      meta.normalized,
      meta.label,
      meta.score,
      meta.masjid ? 1 : 0,
      meta.jamaat ? 1 : 0,
      meta.work ? 1 : 0,
      meta.home ? 1 : 0,
      meta.late ? 1 : 0,
      meta.qaza ? 1 : 0,
      meta.udhr ? 1 : 0,
      stamp,
      note || null,
      `page_log_${day}_${prayer}_${code}`,
      `salah_page_log_${day}`,
      stamp
    ).run();

    await recalcDaily(env.DB, day, stamp);

    return json({
      ok: true,
      version: VERSION,
      day,
      prayer,
      code,
      logged_at: stamp,
      message: `${prayer} logged as ${meta.label}`
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

export async function onRequestOptions() {
  return json({ ok: true, version: VERSION });
}

async function ensureDailyRow(db, day, stamp) {
  const existing = await db.prepare(
    `SELECT day FROM salah_daily_status WHERE day = ?`
  ).bind(day).first();

  if (existing) return;

  const dayOfMonth = Number(day.slice(8, 10));

  await db.prepare(
    `INSERT INTO salah_daily_status (
      day, day_of_month, score, tier_label, qaza_count, logged_count, masjid_count,
      jamaat_count, work_count, home_count, late_count, source_system, source_tab,
      source_version, source_layout, export_batch_id, exported_at, updated_at
    ) VALUES (?, ?, 0, NULL, 0, 0, 0, 0, 0, 0, 0, 'salah_page', '🕌 Salah', 'salah-log-api-v0.1.0', 'today_live', ?, ?, datetime('now'))`
  ).bind(day, dayOfMonth, `salah_page_log_${day}`, stamp).run();
}

async function recalcDaily(db, day, stamp) {
  const res = await db.prepare(
    `SELECT prayer_name, raw_code, normalized_code, score_value, is_logged, is_masjid, is_jamaat, is_work, is_home, is_late, is_qaza
     FROM salah_prayer_entries
     WHERE day = ?`
  ).bind(day).all();

  const rows = res.results || [];
  const byPrayer = new Map(rows.map(r => [r.prayer_name, r]));

  const get = (prayer, key) => {
    const row = byPrayer.get(prayer);
    return row ? row[key] : null;
  };

  const score = rows.reduce((sum, row) => sum + Number(row.score_value || 0), 0);
  const logged = rows.filter(r => Number(r.is_logged || 0) === 1 && r.prayer_name !== 'jumuah').length;
  const masjid = rows.filter(r => Number(r.is_masjid || 0) === 1).length;
  const jamaat = rows.filter(r => Number(r.is_jamaat || 0) === 1).length;
  const work = rows.filter(r => Number(r.is_work || 0) === 1).length;
  const home = rows.filter(r => Number(r.is_home || 0) === 1).length;
  const late = rows.filter(r => Number(r.is_late || 0) === 1).length;
  const qaza = rows.filter(r => Number(r.is_qaza || 0) === 1).length;

  await db.prepare(
    `UPDATE salah_daily_status SET
      raw_fajr_code = ?,
      raw_dhuhr_code = ?,
      raw_asr_code = ?,
      raw_maghrib_code = ?,
      raw_isha_code = ?,
      raw_jumuah_code = ?,
      normalized_fajr_code = ?,
      normalized_dhuhr_code = ?,
      normalized_asr_code = ?,
      normalized_maghrib_code = ?,
      normalized_isha_code = ?,
      normalized_jumuah_code = ?,
      score = ?,
      tier_label = ?,
      qaza_count = ?,
      logged_count = ?,
      masjid_count = ?,
      jamaat_count = ?,
      work_count = ?,
      home_count = ?,
      late_count = ?,
      source_system = 'salah_page',
      source_version = 'salah-log-api-v0.1.0',
      source_layout = 'today_live',
      export_batch_id = ?,
      exported_at = ?,
      updated_at = datetime('now')
    WHERE day = ?`
  ).bind(
    get('fajr', 'raw_code'),
    get('dhuhr', 'raw_code'),
    get('asr', 'raw_code'),
    get('maghrib', 'raw_code'),
    get('isha', 'raw_code'),
    get('jumuah', 'raw_code'),
    get('fajr', 'normalized_code'),
    get('dhuhr', 'normalized_code'),
    get('asr', 'normalized_code'),
    get('maghrib', 'normalized_code'),
    get('isha', 'normalized_code'),
    get('jumuah', 'normalized_code'),
    round1(score),
    tier(score),
    qaza,
    logged,
    masjid,
    jamaat,
    work,
    home,
    late,
    `salah_page_log_${day}`,
    stamp,
    day
  ).run();
}

function cleanPrayer(value) {
  const v = String(value || '').trim().toLowerCase();
  return PRAYERS.includes(v) ? v : '';
}

function cleanCode(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanDay(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function cleanText(value) {
  return String(value || '').trim().slice(0, 500);
}

function todayPk() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}

function nowPkIso() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(now);

  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}T${part(parts, 'hour')}:${part(parts, 'minute')}:${part(parts, 'second')}+05:00`;
}

function part(parts, type) {
  return parts.find(p => p.type === type).value;
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function tier(score) {
  if (score >= 9) return '🟢 Excellent';
  if (score >= 6) return '🟡 Good';
  if (score >= 3) return '🟠 Mediocre';
  if (score >= 0) return '🔴 Low';
  return '⚫ Negative';
}
