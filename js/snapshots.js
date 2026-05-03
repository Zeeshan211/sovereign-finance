// ════════════════════════════════════════════════════════════════════
// snapshots.js — Snapshots page: create + list viewer
// LOCKED · Sub-1D-2e · v0.0.1
//
// Endpoints used:
//   GET  /api/snapshots          → list of snapshots
//   GET  /api/snapshots?id=X     → single snapshot detail (with per-table counts)
//   POST /api/snapshots          → create new {label, created_by}
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, kind = 'success') {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + (kind === 'err' || kind === 'error' ? 'toast-error' : 'toast-success');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
    return r.json();
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const t = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
    const diff = Date.now() - t.getTime();
    if (isNaN(diff)) return iso;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    return t.toISOString().slice(0, 10);
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    return iso.replace('T', ' ').slice(0, 19) + ' UTC';
  }

  // ─── LOADER ───────────────────────────────────────────────────────
  let allSnaps = [];

  async function loadSnaps() {
    try {
      const d = await getJSON('/api/snapshots?limit=50');
      if (!d.ok) throw new Error(d.error || 'snapshots load failed');

      allSnaps = d.snapshots || [];
      $('s_count').textContent = allSnaps.length;

      if (!allSnaps.length) {
        $('s_latest_label').textContent = '—';
        $('s_latest_when').textContent = '—';
        $('s_total_rows').textContent = '0';
        $('s_list_total').textContent = '0 snapshots';
        $('snapList').innerHTML = '<div class="empty-state-inline">No snapshots yet. Create one above to backup current state.</div>';
        return;
      }

      const latest = allSnaps[0];
      $('s_latest_label').textContent = latest.label || '—';
      $('s_latest_when').textContent  = timeAgo(latest.created_at);
      $('s_total_rows').textContent   = String(allSnaps.reduce((s, x) => s + (x.row_count_total || 0), 0));
      $('s_list_total').textContent   = allSnaps.length + ' snapshot' + (allSnaps.length === 1 ? '' : 's');

      $('snapList').innerHTML = allSnaps.map(s => {
        const isAuto = s.label && s.label.startsWith('pre-');
        const labelClass = isAuto ? 'neutral' : 'positive';
        const rowSafe = escHtml(s.id);
        return `
          <div class="account-row" data-snap-id="${rowSafe}" style="cursor:pointer">
            <div class="account-left">
              <div class="account-icon">${isAuto ? '🔒' : '📸'}</div>
              <div class="account-info">
                <div class="account-name">${escHtml(s.label)}</div>
                <div class="account-kind">${escHtml(s.id)} · ${escHtml(s.created_by || 'system')} · ${timeAgo(s.created_at)}</div>
              </div>
            </div>
            <div class="account-balance ${labelClass}">${(s.row_count_total || 0).toLocaleString()}<span class="balance-currency">rows</span></div>
          </div>
          <div id="detail-${rowSafe}" style="display:none;padding:12px 18px;background:var(--bg-elev-1);border-radius:12px;margin:-6px 0 12px"></div>
        `;
      }).join('');

      // Wire row clicks → expand detail
      document.querySelectorAll('[data-snap-id]').forEach(row => {
        row.addEventListener('click', onRowClick);
      });
    } catch (e) {
      $('snapList').innerHTML = '<div class="empty-state-inline">Failed to load: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── ROW EXPAND ───────────────────────────────────────────────────
  async function onRowClick(ev) {
    const row = ev.currentTarget;
    const id = row.getAttribute('data-snap-id');
    const detail = $('detail-' + id);
    if (!detail) return;

    if (detail.style.display === 'block') {
      detail.style.display = 'none';
      return;
    }

    detail.style.display = 'block';
    detail.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Loading detail…</div>';

    try {
      const d = await getJSON('/api/snapshots?id=' + encodeURIComponent(id));
      if (!d.ok) throw new Error(d.error || 'detail failed');

      const tables = d.tables || [];
      const created = fmtDateTime(d.snapshot.created_at);
      const totalRows = d.snapshot.row_count_total;

      detail.innerHTML = `
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:10px;font-size:13px;color:var(--text-muted)">
          <span>📅 ${escHtml(created)}</span>
          <span>👤 ${escHtml(d.snapshot.created_by || 'system')}</span>
          <span>📦 ${totalRows.toLocaleString()} rows total</span>
          <span>✅ ${escHtml(d.snapshot.status)}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">
          ${tables.map(t => `
            <div style="background:var(--bg-elev-2);padding:8px 12px;border-radius:8px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:13px">${escHtml(t.table_name)}</span>
              <span style="font-weight:600;font-variant-numeric:tabular-nums">${(t.row_count || 0).toLocaleString()}</span>
            </div>`).join('')}
        </div>
      `;
    } catch (e) {
      detail.innerHTML = '<div style="padding:8px;color:var(--danger)">Detail failed: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── CREATE FORM ──────────────────────────────────────────────────
  async function onCreate(ev) {
    ev.preventDefault();
    const btn = $('snap_submit');
    const label = $('snap_label').value.trim();

    if (!label) {
      toast('Label required', 'err');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating…';

    try {
      const r = await fetch('/api/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, created_by: 'web-snapshots' })
      });
      const d = await r.json();

      if (!d.ok) {
        toast('❌ ' + (d.error || 'Snapshot failed'), 'err');
      } else {
        toast(`✅ Snapshot created · ${d.total_rows.toLocaleString()} rows · ${d.snapshot_id}`);
        $('snap_label').value = '';
        await loadSnaps();
      }
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Snapshot';
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────
  function init() {
    $('snapForm').addEventListener('submit', onCreate);
    loadSnaps();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
