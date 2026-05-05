/* ─── audit.js · Audit Log page · v0.2.0 ─── */
/*
 * Layer 2 caller repair.
 *
 * Contract:
 *   GET /api/audit returns:
 *   {
 *     ok: true,
 *     total: number,
 *     limit: number,
 *     offset: number,
 *     rows: [...]
 *   }
 *
 * This file is defensive:
 *   - Works even if audit.html has old/missing container IDs.
 *   - Creates its own audit panel if needed.
 *   - Parses JSON detail safely.
 *   - Shows empty/error states instead of staying stuck on loading.
 */

(function () {
  'use strict';

  const VERSION = 'v0.2.0';

  const STATE = {
    rows: [],
    limit: 100,
    offset: 0,
    loading: false
  };

  const $ = id => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    if (!ts) return '—';

    try {
      const normalized = String(ts).replace(' ', 'T') + 'Z';
      const d = new Date(normalized);

      if (Number.isNaN(d.getTime())) return String(ts);

      return d.toLocaleString('en-PK', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return String(ts);
    }
  }

  function parseDetail(detail) {
    if (!detail) return '';

    if (typeof detail === 'object') {
      return JSON.stringify(detail, null, 2);
    }

    const raw = String(detail);

    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (e) {
      return raw;
    }
  }

  function shortDetail(detail) {
    const text = parseDetail(detail)
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return '—';
    if (text.length <= 160) return text;

    return text.slice(0, 160) + '…';
  }

  function getMain() {
    return document.querySelector('main') ||
      document.querySelector('.page') ||
      document.querySelector('.container') ||
      document.body;
  }

  function ensurePanel() {
    let panel =
      $('audit-panel') ||
      $('auditLog') ||
      $('audit-log') ||
      document.querySelector('[data-audit-panel]');

    if (panel) return panel;

    const main = getMain();

    panel = document.createElement('section');
    panel.id = 'audit-panel';
    panel.setAttribute('data-audit-panel', '1');
    panel.innerHTML = `
      <div class="audit-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin:16px 0">
        <div>
          <h2 style="margin:0">Audit Log</h2>
          <p id="audit-summary" style="margin:4px 0 0;color:var(--muted,#94a3b8);font-size:13px">Loading…</p>
        </div>
        <button id="audit-refresh" class="btn" type="button">Refresh</button>
      </div>
      <div id="audit-list">Loading…</div>
    `;

    main.appendChild(panel);

    return panel;
  }

  function getListEl() {
    return $('audit-list') ||
      $('auditRows') ||
      $('audit-rows') ||
      $('auditLogRows') ||
      $('audit-log-rows') ||
      document.querySelector('[data-audit-list]') ||
      ensurePanel().querySelector('#audit-list');
  }

  function setSummary(text) {
    const el = $('audit-summary') ||
      $('audit-count') ||
      document.querySelector('[data-audit-summary]');

    if (el) el.textContent = text;
  }

  function setLoading() {
    const list = getListEl();
    if (list) list.innerHTML = `<div class="empty-state-inline">Loading audit log…</div>`;
    setSummary('Loading…');
  }

  function setError(msg) {
    const list = getListEl();
    if (list) {
      list.innerHTML = `
        <div class="empty-state-inline" style="color:var(--danger,#ef4444)">
          Audit log failed: ${esc(msg)}
        </div>
      `;
    }

    setSummary('Failed');
  }

  function actionTone(action) {
    const a = String(action || '').toUpperCase();

    if (a.includes('DELETE') || a.includes('REVERSE')) return 'danger';
    if (a.includes('CREATE') || a.includes('ADD') || a.includes('TRANSFER')) return 'success';
    if (a.includes('UPDATE') || a.includes('EDIT')) return 'warn';

    return 'neutral';
  }

  function actionBadge(row) {
    const action = esc(row.action || 'EVENT');
    const tone = actionTone(row.action);

    const colors = {
      success: 'background:rgba(34,197,94,.12);color:#22c55e;border-color:rgba(34,197,94,.25)',
      danger: 'background:rgba(239,68,68,.12);color:#ef4444;border-color:rgba(239,68,68,.25)',
      warn: 'background:rgba(245,158,11,.12);color:#f59e0b;border-color:rgba(245,158,11,.25)',
      neutral: 'background:rgba(148,163,184,.12);color:#94a3b8;border-color:rgba(148,163,184,.25)'
    };

    return `<span style="display:inline-block;border:1px solid;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;${colors[tone]}">${action}</span>`;
  }

  function renderRows(rows) {
    const list = getListEl();

    if (!list) return;

    if (!rows.length) {
      list.innerHTML = `<div class="empty-state-inline">No audit events yet.</div>`;
      setSummary('0 events');
      return;
    }

    setSummary(`${rows.length} event${rows.length === 1 ? '' : 's'} shown`);

    list.innerHTML = rows.map(row => {
      const detail = shortDetail(row.detail);
      const fullDetail = parseDetail(row.detail);
      const entity = [row.entity, row.entity_id].filter(Boolean).join(' · ') || '—';

      return `
        <article class="audit-row" style="
          border:1px solid var(--border,rgba(148,163,184,.18));
          background:var(--card,rgba(15,23,42,.72));
          border-radius:14px;
          padding:12px 14px;
          margin:10px 0;
          box-shadow:0 8px 24px rgba(0,0,0,.12);
        ">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
            <div style="min-width:0">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                ${actionBadge(row)}
                <span style="font-size:12px;color:var(--muted,#94a3b8)">${esc(row.kind || 'event')}</span>
              </div>
              <div style="margin-top:8px;font-weight:700;color:var(--text,#e5e7eb);word-break:break-word">${esc(entity)}</div>
              <div style="margin-top:5px;font-size:12px;color:var(--muted,#94a3b8);word-break:break-word">${esc(detail)}</div>
            </div>
            <div style="text-align:right;white-space:nowrap;font-size:12px;color:var(--muted,#94a3b8)">
              ${esc(fmtTime(row.timestamp))}
              <div style="margin-top:5px">${esc(row.created_by || 'system')}</div>
            </div>
          </div>
          <details style="margin-top:8px">
            <summary style="cursor:pointer;color:var(--muted,#94a3b8);font-size:12px">details</summary>
            <pre style="
              white-space:pre-wrap;
              word-break:break-word;
              overflow:auto;
              margin:8px 0 0;
              padding:10px;
              border-radius:10px;
              background:rgba(2,6,23,.5);
              color:var(--text,#e5e7eb);
              font-size:12px;
            ">${esc(fullDetail)}</pre>
          </details>
        </article>
      `;
    }).join('');
  }

  async function loadAudit() {
    if (STATE.loading) return;

    STATE.loading = true;
    setLoading();

    try {
      const res = await fetch(`/api/audit?limit=${encodeURIComponent(STATE.limit)}&offset=${encodeURIComponent(STATE.offset)}`, {
        cache: 'no-store'
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);

      const data = await res.json();

      if (!data.ok) throw new Error(data.error || 'Audit API failed');

      STATE.rows = data.rows || data.audit || data.events || [];
      renderRows(STATE.rows);
    } catch (err) {
      console.error('[audit v0.2.0] load failed:', err);
      setError(err.message);
    } finally {
      STATE.loading = false;
    }
  }

  function bindRefresh() {
    const btn = $('audit-refresh') ||
      $('refreshAudit') ||
      $('refresh_btn') ||
      document.querySelector('[data-audit-refresh]');

    if (btn) {
      btn.addEventListener('click', loadAudit);
    }
  }

  function init() {
    ensurePanel();
    bindRefresh();
    loadAudit();

    console.log('[audit v0.2.0] initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
