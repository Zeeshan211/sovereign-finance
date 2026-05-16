/* js/hub.js
 * Sovereign Finance · Hub UI Loader
 * v0.1.3-hub-ui-value-render-fix
 *
 * Frontend-only file.
 * Reads /api/hub and renders real Hub dashboard values.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.3-hub-ui-value-render-fix';

  const METRICS = [
    ['Liquid Now', s => money(s.cash_now)],
    ['Net Worth', s => money(s.net_worth)],
    ['Bills Remaining', s => money(s.forecast_expected_outflow)],
    ['Debt Payable', s => money(s.total_owe)],
    ['Receivables', s => money(s.total_owed)],
    ['Credit Card Outstanding', s => money(s.liabilities_total)],
    ['Next Salary', s => money(s.salary_amount)],
    ['Lowest Forecast Liquid', s => money(s.forecast_projected_end)],
    ['Forecast Risk', (s, data) => {
      const alerts = Array.isArray(data.alerts) ? data.alerts : [];
      return alerts.length ? `${alerts.length} alert(s)` : 'OK';
    }]
  ];

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function txt(value) {
    return String(value == null ? '' : value).trim();
  }

  async function fetchJSON(url) {
    const finalUrl = url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now();

    const res = await fetch(finalUrl, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const raw = await res.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Expected JSON from ${url}, received: ${raw.slice(0, 120)}`);
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.error?.message || data.error || data.message || `HTTP ${res.status}`);
    }

    return data;
  }

  function getLeafNodes(root) {
    return Array.from(root.querySelectorAll('*')).filter(el => {
      return el.children.length === 0 && txt(el.textContent);
    });
  }

  function findBestContainer(label) {
    const lower = label.toLowerCase();

    return Array.from(document.querySelectorAll('section, article, div, li'))
      .filter(node => txt(node.textContent).toLowerCase().includes(lower))
      .sort((a, b) => txt(a.textContent).length - txt(b.textContent).length)[0] || null;
  }

  function looksLikeValueNode(el) {
    const value = txt(el.textContent);

    if (!value) return false;
    if (value === 'Loading') return true;
    if (value === 'Loaded') return true;
    if (value === 'Unavailable') return true;
    if (value === 'Available') return true;
    if (value === '—') return true;
    if (value === '--') return true;
    if (value === '0') return true;
    if (value === 'OK') return true;
    if (value.includes('alert')) return true;
    if (value.startsWith('Rs ')) return true;
    if (value.startsWith('-Rs ')) return true;

    return false;
  }

  function setValueNearLabel(label, value) {
    const container = findBestContainer(label);
    if (!container) return false;

    const leaves = getLeafNodes(container);
    const valueNodes = leaves.filter(looksLikeValueNode);

    let target = valueNodes[valueNodes.length - 1];

    if (!target) {
      target = leaves.find(el => txt(el.textContent) !== label);
    }

    if (!target) return false;

    target.textContent = value;
    target.classList.add('sf-hub-loaded-value');
    target.setAttribute('data-hub-rendered', 'true');

    return true;
  }

  function renderMetrics(data) {
    const summary = data.summary || {};

    for (const [label, formatter] of METRICS) {
      setValueNearLabel(label, formatter(summary, data));
    }
  }

  function renderStatus(data) {
    const status = data.health?.overall || 'unknown';
    const alertCount = Array.isArray(data.alerts) ? data.alerts.length : 0;
    const statusText = `Hub ${data.version || 'unknown'} · ${status} · alerts ${alertCount}`;
    const loadedText = 'Last loaded: ' + new Date().toLocaleTimeString();

    const statusEl =
      document.querySelector('[data-hub-status]') ||
      document.querySelector('#hubStatus');

    if (statusEl) statusEl.textContent = statusText;

    const lastLoadedEl =
      document.querySelector('[data-hub-last-loaded]') ||
      document.querySelector('#hubLastLoaded');

    if (lastLoadedEl) lastLoadedEl.textContent = loadedText;

    replaceLeafContaining('Loading source status', statusText);
    replaceLeafContaining('Last loaded:', loadedText);
  }

  function renderServices(data) {
    const services = data.health?.services || {};

    for (const [name, service] of Object.entries(services)) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      setValueNearLabel(label, service.ok ? 'OK' : 'Check');
    }
  }

  function renderAlerts(data) {
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    const alertContainer =
      document.querySelector('[data-hub-alerts]') ||
      document.querySelector('#hubAlerts');

    if (!alertContainer) return;

    if (!alerts.length) {
      alertContainer.innerHTML = '<div class="muted">No active backend alerts.</div>';
      return;
    }

    alertContainer.innerHTML = alerts.map(alert => {
      const level = escapeHtml(alert.level || 'warn');
      const title = escapeHtml(alert.title || alert.code || 'Alert');
      const detail = escapeHtml(alert.detail || '');
      const endpoint = escapeHtml(alert.endpoint || '');

      return `
        <div class="hub-alert hub-alert-${level}">
          <div class="hub-alert-title">${title}</div>
          <div class="hub-alert-detail">${detail}</div>
          ${endpoint ? `<div class="hub-alert-endpoint">${endpoint}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderDebug(data) {
    const debug =
      document.querySelector('#hubDebug') ||
      document.querySelector('#debugPanel') ||
      document.querySelector('[data-hub-debug]');

    if (!debug) return;

    debug.textContent = JSON.stringify({
      ui_version: VERSION,
      api_version: data.version,
      health: data.health,
      summary: data.summary,
      alerts: data.alerts
    }, null, 2);
  }

  function replaceLeafContaining(fragment, value) {
    for (const el of getLeafNodes(document.body)) {
      if (txt(el.textContent).includes(fragment)) {
        el.textContent = value;
      }
    }
  }

  function replaceExactLeaf(oldValue, newValue) {
    for (const el of getLeafNodes(document.body)) {
      if (txt(el.textContent) === oldValue) {
        el.textContent = newValue;
      }
    }
  }

  function renderHub(data) {
    renderMetrics(data);
    renderStatus(data);
    renderServices(data);
    renderAlerts(data);
    renderDebug(data);

    window.SovereignHub = {
      ui_version: VERSION,
      api: data,
      reload: loadHub
    };
  }

  function renderError(err) {
    replaceExactLeaf('Loading', 'Failed');
    replaceExactLeaf('Loaded', 'Failed');

    const statusEl =
      document.querySelector('[data-hub-status]') ||
      document.querySelector('#hubStatus');

    if (statusEl) {
      statusEl.textContent = 'Hub failed · ' + (err.message || String(err));
    }

    const debug =
      document.querySelector('#hubDebug') ||
      document.querySelector('#debugPanel') ||
      document.querySelector('[data-hub-debug]');

    if (debug) {
      debug.textContent = JSON.stringify({
        ui_version: VERSION,
        error: err.message || String(err)
      }, null, 2);
    }

    console.error('[Sovereign Hub UI]', err);
  }

  async function loadHub() {
    try {
      const data = await fetchJSON('/api/hub');
      renderHub(data);
    } catch (err) {
      renderError(err);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHub, { once: true });
  } else {
    loadHub();
  }
})();
