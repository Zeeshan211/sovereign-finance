/* forecast.js
 * Sovereign Finance · Forecast Page
 * Extracted from inline <script> — zero logic changes.
 * Load order: sf-components.js → sf-shell.js → forecast.js
 */

(function () {
  'use strict';

  const VERSION = 'v0.3.1-forecast-single-api-render-fixed';
  const API_FORECAST = '/api/forecast';

  const state = {
    payload: null,
    events: [],
    selectedId: null
  };

  const $ = id => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = safeText(value, '');
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeText(value, fallback = '—') {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') {
      return value.name || value.label || value.title || value.id || value.value || fallback;
    }
    return String(value);
  }

  function num(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    const n = Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function money(value) {
    const n = num(value, NaN);
    if (!Number.isFinite(n)) return '—';

    const sign = n < 0 ? '-' : '';
    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function compactDate(value) {
    const raw = safeText(value, '').slice(0, 10);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '—';

    const [, month, day] = raw.split('-');
    const months = {
      '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
      '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
      '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec'
    };

    return `${Number(day)} ${months[month] || month}`;
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
    }

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    }

    return payload;
  }

  function buildForecastUrl() {
    const horizon    = $('horizonInput')?.value    || '30';
    const buffer     = $('bufferInput')?.value     || '0';
    const salaryMode = $('salaryModeInput')?.value || 'auto';
    const debtMode   = $('debtModeInput')?.value   || 'due';

    const params = new URLSearchParams();
    params.set('horizon', horizon);
    params.set('buffer',  buffer);
    params.set('salary',  salaryMode);
    params.set('debts',   debtMode);

    return `${API_FORECAST}?${params.toString()}`;
  }

  function renderKpis(summary) {
    summary = summary || {};

    setText('cashNow',        money(summary.cash_now));
    setText('expectedIncome', money(summary.expected_income));
    setText('expectedOutflow',money(summary.expected_outflow));
    setText('scenarioBuffer', money(summary.buffer));
    setText('projectedEnd',   money(summary.projected_end));

    const projected = $('projectedEnd');
    if (projected) {
      projected.classList.remove('good', 'warn', 'danger');
      const end = num(summary.projected_end);
      projected.classList.add(end < 0 ? 'danger' : end === 0 ? 'warn' : 'good');
    }
  }

  function eventClass(event) {
    if (event.type === 'income')  return 'good';
    if (event.type === 'outflow') return 'danger';
    return 'warn';
  }

  function amountClass(event) {
    return num(event.amount) >= 0 ? 'income' : 'outflow';
  }

  function eventIcon(event) {
    if (event.type === 'income')  return '📥';
    if (event.type === 'outflow') return '📤';
    return '🧮';
  }

  function detail(label, value) {
    return `
      <div class="forecast-detail-label">${esc(label)}</div>
      <div class="forecast-detail-value">${esc(value)}</div>
    `;
  }

  function renderEvents() {
    const list = $('forecastList');
    if (!list) return;

    const events = state.events || [];

    if (!events.length) {
      list.innerHTML = '<div class="forecast-empty">No forecast events inside this horizon.</div>';
      return;
    }

    list.innerHTML = events.map(event => `
      <article class="forecast-row" data-forecast-id="${esc(event.id)}">
        <button class="forecast-row-shell" type="button" data-toggle-forecast="${esc(event.id)}">
          <div class="forecast-icon">${eventIcon(event)}</div>

          <div>
            <div class="forecast-title-line">${esc(event.title)}</div>
            <div class="forecast-sub">${esc(event.description || event.source || '')}</div>
          </div>

          <div class="forecast-cell">${esc(event.source)}</div>
          <div class="forecast-date">${esc(compactDate(event.date))}</div>
          <div class="forecast-amount ${amountClass(event)}">${esc(money(event.amount))}</div>
          <div class="forecast-status-label ${eventClass(event)}">${esc(event.status || 'projected')}</div>
          <div class="forecast-caret">▾</div>
        </button>

        <div class="forecast-detail">
          <div class="forecast-detail-grid">
            ${detail('Source',        event.source  || '—')}
            ${detail('Type',          event.type    || '—')}
            ${detail('Date',          event.date    || '—')}
            ${detail('Amount',        money(event.amount))}
            ${detail('Account',       event.account_id || '—')}
            ${detail('Status',        event.status  || 'projected')}
            ${detail('Ledger impact', 'None · forecast projection only')}
            ${detail('Event ID',      event.id)}
          </div>
        </div>
      </article>
    `).join('');

    bindEvents();
  }

  function bindEvents() {
    document.querySelectorAll('[data-toggle-forecast]').forEach(button => {
      button.addEventListener('click', () => {
        const id  = button.getAttribute('data-toggle-forecast');
        const row = document.querySelector(`[data-forecast-id="${cssEscape(id)}"]`);
        if (!row) return;

        row.classList.toggle('is-open');
        selectEvent(id);
      });
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value || '').replace(/"/g, '\\"');
  }

  function miniRow(label, value) {
    return `
      <div class="forecast-detail-grid" style="padding:8px 0;border-bottom:1px solid var(--sf-border-subtle);">
        <div class="forecast-detail-label">${esc(label)}</div>
        <div class="forecast-detail-value">${esc(value)}</div>
      </div>
    `;
  }

  function selectEvent(id) {
    const event = state.events.find(item => String(item.id) === String(id));
    if (!event) return;

    state.selectedId = id;

    setText('forecastSelectedTitle', event.title);
    setText('forecastSelectedSub', `${event.source} · ${event.status || 'projected'} · ${event.date || 'no date'}`);

    const panel = $('forecastDetailPanel');
    if (panel) {
      panel.innerHTML = `
        ${miniRow('Amount',        money(event.amount))}
        ${miniRow('Type',          event.type    || '—')}
        ${miniRow('Date',          event.date    || '—')}
        ${miniRow('Account',       event.account_id || '—')}
        ${miniRow('Source',        event.source  || '—')}
        ${miniRow('Ledger impact', 'None · forecast only')}
      `;
    }
  }

  function renderRaw() {
    const raw = $('forecastRaw');
    if (raw) raw.textContent = JSON.stringify(state.payload || {}, null, 2);
  }

  function renderAll(payload) {
    state.payload = payload || {};
    state.events  = Array.isArray(payload.events) ? payload.events : [];

    renderKpis(payload.summary || {});
    renderEvents();
    renderRaw();

    setText('forecastHealth', 'Health OK');
    setText('forecastHorizonChip', `${payload.horizon_days || $('horizonInput')?.value || 30}-day horizon`);

    const salaryAmount  = payload.sources && payload.sources.salary_amount;
    const salaryEnabled = payload.sources && payload.sources.salary_enabled;
    setText('forecastSalaryChip', salaryEnabled ? `Salary ${money(salaryAmount)}` : 'Salary unavailable/excluded');

    setText('forecastStatusDetail', `${state.events.length} forecast event${state.events.length === 1 ? '' : 's'} projected.`);
    setText('forecastVersion',      VERSION);
    setText('forecastFooterVersion', `forecast.html · ${VERSION} · backend ${payload.version || 'unknown'}`);
  }

  async function loadForecast() {
    setText('forecastHealth',      'Loading forecast');
    setText('forecastStatusDetail','Reading forecast source.');

    const list = $('forecastList');
    if (list) list.innerHTML = '<div class="forecast-empty">Loading forecast events…</div>';

    try {
      const payload = await fetchJSON(buildForecastUrl());
      renderAll(payload);
    } catch (err) {
      setText('forecastHealth',      'Forecast unavailable');
      setText('forecastStatusDetail', err.message);

      if (list) {
        list.innerHTML = `<div class="forecast-empty">Forecast could not load: ${esc(err.message)}</div>`;
      }

      state.payload = { error: err.message };
      renderRaw();
    }
  }

  function bindControls() {
    ['horizonInput', 'bufferInput', 'salaryModeInput', 'debtModeInput'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input',  loadForecast);
      el.addEventListener('change', loadForecast);
    });

    $('refreshForecastBtn')?.addEventListener('click', loadForecast);
  }

  function init() {
    bindControls();
    loadForecast();

    window.SovereignForecast = {
      version: VERSION,
      reload:  loadForecast,
      state:   () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();
