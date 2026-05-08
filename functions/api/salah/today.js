// functions/api/salah/today.js v0.1.0
// Salah today-live endpoint
//
// Scope:
// - Read-only
// - Reads only salah_* tables
// - Does not touch Finance, ledger, transactions, bills, debts, salary, or monthly close
// - Returns honest empty state if today's Salah data is not seeded yet

import { json } from '../_lib.js';

const VERSION = 'salah-today-api-v0.1.0';
const TZ = 'Asia/Karachi';

const PRAYER_ORDER = [
  'fajr',
  'dhuhr',
  'asr',
  'maghrib',
  'isha',
  'jumuah'
];

const PRAYER_LABELS = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
  jumuah: 'Jumuah'
};

export async function onRequestGet({ request, env }) {
  try {
    if (!env.DB) {
      return json({
        ok: false,
        version: VERSION,
        error: 'D1 binding DB is missing'
      }, 500);
    }

    const url = new URL(request.url);
    const requestedDay = cleanDay(url.searchParams.get('day'));
    const day = requestedDay || todayPk();

    const daily = await env.DB.prepare(
      `SELECT
        day,
        day_of_month,
        raw_fajr_code,
        raw_dhuhr_code,
        raw_asr_code,
        raw_maghrib_code,
        raw_isha_code,
        raw_jumuah_code,
        raw_tahajjud_status,
        normalized_fajr_code,
        normalized_dhuhr_code,
        normalized_asr_code,
        normalized_maghrib_code,
        normalized_isha_code,
        normalized_jumuah_code,
        score,
        tier_label,
        qaza_count,
        logged_count,
        masjid_count,
        jamaat_count,
        work_count,
        home_count,
        late_count,
        notes,
        source_system,
        source_tab,
        source_version,
        source_layout,
        source_row,
        source_checksum,
        export_batch_id,
        exported_at,
        created_at,
        updated_at
      FROM salah_daily_status
      WHERE day = ?`
    ).bind(day).first();

    const entriesRes = await env.DB.prepare(
      `SELECT
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
        created_at,
        updated_at
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
          ELSE 99
        END`
    ).bind(day).all();

    const prayerTimes = await env.DB.prepare(
      `SELECT
        day,
        city,
        country,
        timezone,
        method,
        fajr_time,
        dhuhr_time,
        asr_time,
        maghrib_time,
        isha_time,
        provider,
        provider_date,
        fetched_at,
        is_fallback,
        source_note,
        created_at,
        updated_at
      FROM salah_prayer_times
      WHERE day = ?`
    ).bind(day).first();

    const entries = normalizeEntries(entriesRes.results || []);
    const tally = buildTally(daily, entries);

    if (!daily) {
      return json({
        ok: true,
        version: VERSION,
        connected: false,
        day,
        message: 'No Salah data found for this day. Seed or sync today before showing live state.',
        daily: null,
        prayer_times: prayerTimes || null,
        prayers: entries,
        tally,
        source_freshness: {
          source_system: null,
          source_tab: null,
          source_version: null,
          export_batch_id: null,
          exported_at: null,
          updated_at: null,
          api_queried_at: new Date().toISOString()
        }
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
      tally,
      source_freshness: {
        source_system: daily.source_system || null,
        source_tab: daily.source_tab || null,
        source_version: daily.source_version || null,
        source_layout: daily.source_layout || null,
        source_row: daily.source_row || null,
        source_checksum: daily.source_checksum || null,
        export_batch_id: daily.export_batch_id || null,
        exported_at: daily.exported_at || null,
        updated_at: daily.updated_at || null,
        api_queried_at: new Date().toISOString()
      }
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

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;

  return `${y}-${m}-${d}`;
}

function cleanDay(value) {
  const v = String(value || '').trim();
  if (!v) return '';
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
  const fallback = {
    score: null,
    qaza_count: 0,
    logged_count: 0,
    masjid_count: 0,
    jamaat_count: 0,
    work_count: 0,
    home_count: 0,
    late_count: 0,
    udhr_count: 0
  };

  for (const e of entries) {
    if (e.is_logged) fallback.logged_count++;
    if (e.is_masjid) fallback.masjid_count++;
    if (e.is_jamaat) fallback.jamaat_count++;
    if (e.is_work) fallback.work_count++;
    if (e.is_home) fallback.home_count++;
    if (e.is_late) fallback.late_count++;
    if (e.is_qaza) fallback.qaza_count++;
    if (e.has_valid_udhr) fallback.udhr_count++;
  }

  if (!daily) return fallback;

  return {
    score: numberOrNull(daily.score),
    qaza_count: Number(daily.qaza_count || fallback.qaza_count),
    logged_count: Number(daily.logged_count || fallback.logged_count),
    masjid_count: Number(daily.masjid_count || fallback.masjid_count),
    jamaat_count: Number(daily.jamaat_count || fallback.jamaat_count),
    work_count: Number(daily.work_count || fallback.work_count),
    home_count: Number(daily.home_count || fallback.home_count),
    late_count: Number(daily.late_count || fallback.late_count),
    udhr_count: fallback.udhr_count
  };
}

function bool(value) {
  return Number(value || 0) === 1;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
