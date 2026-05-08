// functions/api/salah/today.js v0.2.0
// Salah today-live endpoint
//
// Scope:
// - Read-only
// - Reads only salah_* tables
// - Supports daily prayers + bonus prayers
// - Does not touch Finance, ledger, transactions, bills, debts, salary, or monthly close

import { json } from '../_lib.js';

const VERSION = 'salah-today-api-v0.2.0';
const TZ = 'Asia/Karachi';

const PRAYER_ORDER = [
  'fajr',
  'dhuhr',
  'asr',
  'maghrib',
  'isha',
  'jumuah',
  'tahajjud',
  'witr',
  'ishraq',
  'duha',
  'awwabin',
  'nafl'
];

const DAILY_PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const BONUS_PRAYERS = ['tahajjud', 'witr', 'ishraq', 'duha', 'awwabin', 'nafl'];

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

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return json({ ok: false, version: VERSION, error: 'D1 binding DB is missing' }, 500);
    }

    const url = new URL(request.url);
    const requestedDay = cleanDay(url.searchParams.get('day'));
    const day = requestedDay || todayPk();

    const daily = await env.DB.prepare(
      `SELECT *
       FROM salah_daily_status
       WHERE day = ?`
    ).bind(day).first();

    const entriesRes = await env.DB.prepare(
      `SELECT *
       FROM salah_prayer_entries
       WHERE day = ?
       ORDER BY
        CASE prayer_name
          WHEN 'fajr' THEN 1
          WHEN 'dhuhr' THEN 2
          WHEN 'asr' THEN 3
          WHEN 'maghrib' THEN 4
          WHEN 'isha' THEN 5
          WHEN 'jumuah' THEN 6
          WHEN 'tahajjud' THEN 7
          WHEN 'witr' THEN 8
          WHEN 'ishraq' THEN 9
          WHEN 'duha' THEN 10
          WHEN 'awwabin' THEN 11
          WHEN 'nafl' THEN 12
          ELSE 99
        END`
    ).bind(day).all();

    const prayerTimes = await env.DB.prepare(
      `SELECT *
       FROM salah_prayer_times
       WHERE day = ?`
    ).bind(day).first();

    const entries = normalizeEntries(entriesRes.results || []);
    const tally = buildTally(daily, entries);
    const charts = buildCharts(entries, tally);
    const focus = buildFocus(entries, tally);

    if (!daily) {
      return json({
        ok: true,
        version: VERSION,
        connected: false,
        day,
        message: 'No Salah data found for this day. Seed or log today before showing live state.',
        daily: null,
        prayer_times: prayerTimes || null,
        prayers: entries,
        daily_prayers: entries.filter(e => DAILY_PRAYERS.includes(e.prayer_name)),
        bonus_prayers: entries.filter(e => BONUS_PRAYERS.includes(e.prayer_name)),
        tally,
        charts,
        focus,
        source_freshness: freshness(null)
      });
    }

    return json({
      ok: true,
      version: VERSION,
      connected: true,
      day,
      daily: normalizeDaily(daily),
      prayer_times: prayerTimes || null,
      prayers: entries,
      daily_prayers: entries.filter(e => DAILY_PRAYERS.includes(e.prayer_name)),
      bonus_prayers: entries.filter(e => BONUS_PRAYERS.includes(e.prayer_name)),
      tally,
      charts,
      focus,
      source_freshness: freshness(daily)
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

function todayPk() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}

function cleanDay(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function normalizeDaily(row) {
  return {
    day: row.day,
    day_of_month: row.day_of_month,
    score: numberOrNull(row.score),
    tier_label: row.tier_label || null,
    qaza_count: Number(row.qaza_count || 0),
    logged_count: Number(row.logged_count || 0),
    masjid_count: Number(row.masjid_count || 0),
    jamaat_count: Number(row.jamaat_count || 0),
    work_count: Number(row.work_count || 0),
    home_count: Number(row.home_count || 0),
    late_count: Number(row.late_count || 0),
    notes: row.notes || null,
    raw_codes: {
      fajr: row.raw_fajr_code || null,
      dhuhr: row.raw_dhuhr_code || null,
      asr: row.raw_asr_code || null,
      maghrib: row.raw_maghrib_code || null,
      isha: row.raw_isha_code || null,
      jumuah: row.raw_jumuah_code || null,
      tahajjud: row.raw_tahajjud_status || null
    },
    normalized_codes: {
      fajr: row.normalized_fajr_code || null,
      dhuhr: row.normalized_dhuhr_code || null,
      asr: row.normalized_asr_code || null,
      maghrib: row.normalized_maghrib_code || null,
      isha: row.normalized_isha_code || null,
      jumuah: row.normalized_jumuah_code || null
    }
  };
}

function normalizeEntries(rows) {
  const byName = new Map();

  for (const row of rows) {
    byName.set(row.prayer_name, {
      id: row.id,
      day: row.day,
      prayer_name: row.prayer_name,
      label: PRAYER_LABELS[row.prayer_name] || row.prayer_name,
      raw_code: row.raw_code || null,
      normalized_code: row.normalized_code || null,
      location_label: row.location_label || null,
      score_value: numberOrNull(row.score_value),
      is_logged: bool(row.is_logged),
      is_masjid: bool(row.is_masjid),
      is_jamaat: bool(row.is_jamaat),
      is_work: bool(row.is_work),
      is_home: bool(row.is_home),
      is_late: bool(row.is_late),
      is_qaza: bool(row.is_qaza),
      has_valid_udhr: bool(row.has_valid_udhr),
      is_jam_combined: bool(row.is_jam_combined),
      jam_type: row.jam_type || null,
      logged_at: row.logged_at || null,
      note: row.note || null,
      source_column: row.source_column || null,
      updated_at: row.updated_at || null
    });
  }

  return PRAYER_ORDER
    .filter(name => byName.has(name))
    .map(name => byName.get(name));
}

function buildTally(daily, entries) {
  const dailyEntries = entries.filter(e => DAILY_PRAYERS.includes(e.prayer_name));
  const bonusEntries = entries.filter(e => BONUS_PRAYERS.includes(e.prayer_name));
  const scoreEntries = entries.filter(e => e.normalized_code !== 'NO');

  const fallback = {
    score: scoreEntries.reduce((sum, e) => sum + Number(e.score_value || 0), 0),
    qaza_count: 0,
    logged_count: 0,
    daily_total: 5,
    masjid_count: 0,
    jamaat_count: 0,
    work_count: 0,
    home_count: 0,
    late_count: 0,
    udhr_count: 0,
    bonus_logged_count: 0,
    bonus_total: BONUS_PRAYERS.length
  };

  for (const e of entries) {
    if (e.is_masjid) fallback.masjid_count++;
    if (e.is_jamaat) fallback.jamaat_count++;
    if (e.is_work) fallback.work_count++;
    if (e.is_home) fallback.home_count++;
    if (e.is_late) fallback.late_count++;
    if (e.is_qaza) fallback.qaza_count++;
    if (e.has_valid_udhr) fallback.udhr_count++;
  }

  fallback.logged_count = dailyEntries.filter(e => e.is_logged).length;
  fallback.bonus_logged_count = bonusEntries.filter(e => e.is_logged).length;

  if (!daily) return fallback;

  return {
    ...fallback,
    score: numberOrNull(daily.score) ?? fallback.score,
    qaza_count: Number(daily.qaza_count || fallback.qaza_count),
    logged_count: Number(daily.logged_count || fallback.logged_count),
    masjid_count: Number(daily.masjid_count || fallback.masjid_count),
    jamaat_count: Number(daily.jamaat_count || fallback.jamaat_count),
    work_count: Number(daily.work_count || fallback.work_count),
    home_count: Number(daily.home_count || fallback.home_count),
    late_count: Number(daily.late_count || fallback.late_count)
  };
}

function buildCharts(entries, tally) {
  const logged = tally.logged_count || 0;
  const missing = Math.max(0, 5 - logged);
  const denominator = Math.max(1, tally.masjid_count + tally.home_count + tally.work_count + tally.udhr_count + tally.qaza_count + tally.late_count);

  return {
    completion_percent: Math.round((logged / 5) * 100),
    score_percent: Math.max(0, Math.min(100, Math.round((Number(tally.score || 0) / 10) * 100))),
    completion: {
      logged,
      missing
    },
    distribution: {
      masjid: pct(tally.masjid_count, denominator),
      home: pct(tally.home_count, denominator),
      work: pct(tally.work_count, denominator),
      udhr: pct(tally.udhr_count, denominator),
      qaza: pct(tally.qaza_count, denominator),
      late: pct(tally.late_count, denominator)
    },
    prayers: entries.map(e => ({
      prayer_name: e.prayer_name,
      label: e.label,
      score_value: e.score_value,
      is_logged: e.is_logged,
      is_qaza: e.is_qaza,
      has_valid_udhr: e.has_valid_udhr
    }))
  };
}

function buildFocus(entries, tally) {
  const byName = new Map(entries.map(e => [e.prayer_name, e]));
  const next = DAILY_PRAYERS.find(name => {
    const e = byName.get(name);
    return !e || !e.is_logged;
  });

  if (next) {
    return {
      type: 'next_prayer',
      title: PRAYER_LABELS[next],
      message: 'This is the next prayer without a logged status. Keep the record honest and move cleanly.'
    };
  }

  if (tally.qaza_count > 0) {
    return {
      type: 'recovery',
      title: 'Recovery',
      message: 'A Qaza entry is visible today. Keep it visible until recovery is handled.'
    };
  }

  return {
    type: 'complete',
    title: 'Hold the line',
    message: 'All five daily prayers have a logged status. Protect the rest of the day.'
  };
}

function freshness(daily) {
  return {
    source_system: daily ? daily.source_system || null : null,
    source_tab: daily ? daily.source_tab || null : null,
    source_version: daily ? daily.source_version || null : null,
    source_layout: daily ? daily.source_layout || null : null,
    source_row: daily ? daily.source_row || null : null,
    source_checksum: daily ? daily.source_checksum || null : null,
    export_batch_id: daily ? daily.export_batch_id || null : null,
    exported_at: daily ? daily.exported_at || null : null,
    updated_at: daily ? daily.updated_at || null : null,
    api_queried_at: new Date().toISOString()
  };
}

function pct(value, total) {
  return Math.round((Number(value || 0) / total) * 100);
}

function bool(value) {
  return Number(value || 0) === 1;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function part(parts, type) {
  return parts.find(p => p.type === type).value;
}
