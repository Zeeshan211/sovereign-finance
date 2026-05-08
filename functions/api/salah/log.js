// functions/api/salah/log.js v0.3.0
// Salah live logging endpoint
//
// Product model:
// - Fard score is ONLY the five daily prayers: Fajr, Dhuhr, Asr, Maghrib, Isha.
// - Bonus prayers are tracked separately and never inflate the /10 Fard score.
// - Qaza is recovery state.
// - Udhr is an attribute, not a location category.
// - Jumuah is treated as a Friday/bonus entry, not part of five-prayer daily score.
//
// Scope:
// - Writes only salah_daily_status and salah_prayer_entries
// - Reads/writes only salah_* tables
// - Does not touch Finance, ledger, transactions, bills, debts, salary, monthly close

import { json } from '../_lib.js';

const VERSION = 'salah-log-api-v0.3.0';
const TZ = 'Asia/Karachi';

const FARD_PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

const BONUS_PRAYERS = [
  'jumuah',
  'tahajjud',
  'witr',
  'ishraq',
  'duha',
  'awwabin',
  'nafl'
];

const ALL_PRAYERS = [...FARD_PRAYERS, ...BONUS_PRAYERS];

const PRAYER_LABELS = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
  jumuah: 'Jumuah',
  tahajjud: 'Tahajjud',
  witr: 'Witr',
  ishraq: 'Ishraq',
  duha: 'Duha',
  awwabin: 'Awwabin',
  nafl: 'Nafl'
};

const FARD_CODE_MAP = {
  M: { raw: 'Masjid', normalized: 'M', label: 'Masjid', score: 2.0, location: 'masjid' },
  J: { raw: 'Jamaat', normalized: 'J', label: 'Jamaat', score: 1.5, location: 'jamaat' },
  H: { raw: 'Home', normalized: 'H', label: 'Home', score: 0.5, location: 'home' },
  W: { raw: 'Work', normalized: 'W', label: 'Work', score: 0.5, location: 'work' },
  HU: { raw: 'Home·U', normalized: 'HU', label: 'Home Udhr', score: 0.8, location: 'home', udhr: true },
  WU: { raw: 'Work·U', normalized: 'WU', label: 'Work Udhr', score: 0.8, location: 'work', udhr: true },
  L: { raw: 'Late', normalized: 'L', label: 'Late', score: 0.3, location: 'late' },
  Q: { raw: 'Qaza', normalized: 'Q', label: 'Qaza', score: -1.5, location: 'qaza', qaza: true }
};

const BONUS_CODE_MAP = {
  YES: { raw: 'Yes', normalized: 'YES', label: 'Completed', score: 0, bonus_done: true },
  NO: { raw: 'No', normalized: 'NO', label: 'Not Today', score: 0, bonus_done: false },
  M: { raw: 'Masjid', normalized: 'M', label: 'Masjid', score: 0, location: 'masjid', bonus_done: true },
  H: { raw: 'Home', normalized: 'H', label: 'Home', score: 0, location: 'home', bonus_done: true },
  J: { raw: 'Jamaat', normalized: 'J', label: 'Jamaat', score: 0, location: 'jamaat', bonus_done: true }
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

    const isFard = FARD_PRAYERS.includes(prayer);
    const codeMap = isFard ? FARD_CODE_MAP : BONUS_CODE_MAP;
    const meta = codeMap[code];

    if (!meta) {
      return json({
        ok: false,
        version: VERSION,
        error: isFard ? 'Invalid Fard Salah code' : 'Invalid bonus prayer code'
      }, 400);
    }

    const stamp = nowPkIso();
    const id = `salah_${day}_${prayer}`;
    const isLogged = isFard ? code !== 'NO' : Boolean(meta.bonus_done);
    const scoreValue = isFard ? meta.score : 0;

    await ensureDailyRow(env.DB, day, stamp);

    await env.DB.prepare(
      `INSERT OR REPLACE INTO salah_prayer_entries (
        id,
        day,
        prayer_name,
        raw_code,
        normalized_code,
        location_label,
        score_value,
        is_logged,
        is_masjid,
        is_jamaat,
        is_work,
        is_home,
        is_late,
        is_qaza,
        has_valid_udhr,
        is_jam_combined,
        jam_type,
        logged_at,
        note,
        source_system,
        source_tab,
        source_version,
        source_row,
        source_column,
        source_checksum,
        export_batch_id,
        exported_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, 'salah_page', '🕌 Salah', ?, NULL, NULL, ?, ?, ?, datetime('now'))`
    ).bind(
      id,
      day,
      prayer,
      meta.raw,
      meta.normalized,
      meta.label,
      scoreValue,
      isLogged ? 1 : 0,
      meta.location === 'masjid' ? 1 : 0,
      meta.location === 'jamaat' ? 1 : 0,
      meta.location === 'work' ? 1 : 0,
      meta.location === 'home' ? 1 : 0,
      meta.location === 'late' ? 1 : 0,
      meta.location === 'qaza' ? 1 : 0,
      meta.udhr ? 1 : 0,
      isLogged ? stamp : null,
      note || null,
      VERSION,
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
      prayer_label: PRAYER_LABELS[prayer] || prayer,
      prayer_type: isFard ? 'fard' : 'bonus',
      code,
      logged_at: isLogged ? stamp : null,
      message: `${PRAYER_LABELS[prayer] || prayer} logged as ${meta.label}`
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
      day,
      day_of_month,
      score,
      tier_label,
      qaza_count,
      logged_count,
      masjid_count,
      jamaat_count,
      work_count,
      home_count,
      late_count,
      source_system,
      source_tab,
      source_version,
      source_layout,
      export_batch_id,
      exported_at,
      updated_at
    ) VALUES (?, ?, 0, NULL, 0, 0, 0, 0, 0, 0, 0, 'salah_page', '🕌 Salah', ?, 'today_live', ?, ?, datetime('now'))`
  ).bind(
    day,
    dayOfMonth,
    VERSION,
    `salah_page_log_${day}`,
    stamp
  ).run();
}

async function recalcDaily(db, day, stamp) {
  const res = await db.prepare(
    `SELECT
      prayer_name,
      raw_code,
      normalized_code,
      score_value,
      is_logged,
      is_masjid,
      is_jamaat,
      is_work,
      is_home,
      is_late,
      is_qaza,
      has_valid_udhr
    FROM salah_prayer_entries
    WHERE day = ?`
  ).bind(day).all();

  const rows = res.results || [];
  const byPrayer = new Map(rows.map(row => [row.prayer_name, row]));

  const fardRows = rows.filter(row => FARD_PRAYERS.includes(row.prayer_name));
  const fardScoreRows = fardRows.filter(row => row.normalized_code !== 'NO');

  const fardScore = round1(
    fardScoreRows.reduce((sum, row) => sum + Number(row.score_value || 0), 0)
  );

  const loggedCount = fardRows.filter(row => Number(row.is_logged || 0) === 1).length;
  const qazaCount = fardRows.filter(row => Number(row.is_qaza || 0) === 1).length;

  const masjidCount = fardRows.filter(row => Number(row.is_masjid || 0) === 1).length;
  const jamaatCount = fardRows.filter(row => Number(row.is_jamaat || 0) === 1).length;
  const workCount = fardRows.filter(row => Number(row.is_work || 0) === 1).length;
  const homeCount = fardRows.filter(row => Number(row.is_home || 0) === 1).length;
  const lateCount = fardRows.filter(row => Number(row.is_late || 0) === 1).length;

  await db.prepare(
    `UPDATE salah_daily_status SET
      raw_fajr_code = ?,
      raw_dhuhr_code = ?,
      raw_asr_code = ?,
      raw_maghrib_code = ?,
      raw_isha_code = ?,
      raw_jumuah_code = ?,
      raw_tahajjud_status = ?,
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
      source_version = ?,
      source_layout = 'today_live',
      export_batch_id = ?,
      exported_at = ?,
      updated_at = datetime('now')
    WHERE day = ?`
  ).bind(
    getPrayerValue(byPrayer, 'fajr', 'raw_code'),
    getPrayerValue(byPrayer, 'dhuhr', 'raw_code'),
    getPrayerValue(byPrayer, 'asr', 'raw_code'),
    getPrayerValue(byPrayer, 'maghrib', 'raw_code'),
    getPrayerValue(byPrayer, 'isha', 'raw_code'),
    getPrayerValue(byPrayer, 'jumuah', 'raw_code'),
    getPrayerValue(byPrayer, 'tahajjud', 'raw_code'),
    getPrayerValue(byPrayer, 'fajr', 'normalized_code'),
    getPrayerValue(byPrayer, 'dhuhr', 'normalized_code'),
    getPrayerValue(byPrayer, 'asr', 'normalized_code'),
    getPrayerValue(byPrayer, 'maghrib', 'normalized_code'),
    getPrayerValue(byPrayer, 'isha', 'normalized_code'),
    getPrayerValue(byPrayer, 'jumuah', 'normalized_code'),
    fardScore,
    tier(fardScore),
    qazaCount,
    loggedCount,
    masjidCount,
    jamaatCount,
    workCount,
    homeCount,
    lateCount,
    VERSION,
    `salah_page_log_${day}`,
    stamp,
    day
  ).run();
}

function getPrayerValue(byPrayer, prayer, key) {
  const row = byPrayer.get(prayer);
  return row ? row[key] : null;
}

function cleanPrayer(value) {
  const v = String(value || '').trim().toLowerCase();
  return ALL_PRAYERS.includes(v) ? v : '';
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());

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
  if (score >= 3) return '🟠 Steady';
  if (score >= 0) return '🔴 Needs Recovery';
  return '⚫ Recovery Needed';
}
