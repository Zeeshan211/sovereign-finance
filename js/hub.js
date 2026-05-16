/* js/hub.js
 * Sovereign Finance · Hub UI Loader
 * v0.1.2-hub-ui-contract-reader
 *
 * Frontend-only file.
 * Reads /api/hub and renders Hub dashboard values.
 * Does not mutate backend data.
 * Does not calculate financial truth.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.2-hub-ui-contract-reader';

  const SELECTORS = {
    debug: ['#hubDebug', '#debugPanel', '[data-hub-debug]'],
    status: ['[data-hub-status]', '#hubStatus'],
    lastLoaded: ['[data-hub-last-loaded]', '#hubLastLoaded']
  };

  const METRIC_LABEL_MAP = [
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

  function text(value) {
    return String(value == null ? '' : value);
  }

  async function fetchJSON(url) {
    const finalUrl = url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now();

    const res = await fetch(finalUrl, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });

    const raw = await res.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Expected JSON from ${url}, received: ${raw.slice(0, 120)}`);
    }

    if (!res.ok || data.ok === false) {
      const message =
        data.error?.message ||
        data.error ||
        data.message ||
        `HTTP ${res.status}`;

      throw new Error(message);
    }

    return data;
  }

  function queryFirst(selectors) {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }

    return null;
  }

  function leafNodes() {
    return Array.from(document.querySelectorAll('body *')).filter(el => {
      return el.children.length === 0 && text(el.textContent).trim();
    });
  }

  function findCompactContainerByLabel(label) {
    const lower = label.toLowerCase();

    const candidates = Array.from(document.querySelectorAll('section, article, div, li'))
      .filter(node => text(node.textContent).toLowerCase().includes(lower))
      .sort((a, b) => text(a.textContent).length - text(b.textContent).length);

    return candidates[0] || null;
  }

  function setValueNearLabel(label, value) {
    const container = findCompactContainerByLabel(label);

    if (!container) return false;

    const leaves = Array.from(container.querySelectorAll('*')).filter(el => {
      if (el.children.length) return false;

      const current = text(el.textContent).trim();
      return current === 'Loading' ||
        current === 'Unavailable' ||
        current === '—' ||
        current === '--' ||
        current === '0' ||
        current.startsWith('Rs ');
    });

    const target = leaves[leaves.length - 1];

    if (!target) return false;

    target.textContent = value;
    target.classList.add('sf-hub-loaded-value');
    return true;
  }

  function replaceExactText(oldText, newText) {
    for (const el of leafNodes()) {
      if (text(el.textContent).trim() === oldText) {
        el.textContent = newText;
      }
    }
  }

  function replaceTextContaining(fragment, newText) {
    for (const el of leafNodes()) {
      if (text(el.textContent).includes(fragment)) {
        el.textContent = newText;
      }
    }
  }

  function renderStatus(data) {
    const status = data.health?.overall || 'unknown';
    const alerts = Array.isArray(data.alerts) ? data.alerts.length : 0;
    const value = `Hub ${data.version || 'unknown'} · ${status} · alerts ${alerts}`;

    const statusEl = queryFirst(SELECTORS.status);
    if (statusEl) statusEl.textContent = value;

    const lastLoadedEl = queryFirst(SELECTORS.lastLoaded);
    if (lastLoadedEl) {
      lastLoadedEl.textContent = 'Last loaded: ' + new Date().toLocaleTimeString();
    }

    replaceTextContaining('Loading source status', value);
    replaceTextContaining('Last loaded:', 'Last loaded: ' + new Date().toLocaleTimeString());
  }

  function renderMetrics(data) {
    const summary = data.summary || {};

    for (const [label, formatter] of METRIC_LABEL_MAP) {
      setValueNearLabel(label, formatter(summary, data));
    }

    replaceExactText('Unavailable', 'Available');
    replaceExactText('Loading', 'Loaded');
  }

  function renderServices(data) {
    const services = data.health?.services || {};

    for (const [name, service] of Object.entries(services)) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      const value = service.ok ? 'OK' : 'Check';
      setValueNearLabel(label, value);
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
    const debug = queryFirst(SELECTORS.debug);

    if (!debug) return;

    debug.textContent = JSON.stringify({
      ui_version: VERSION,
      api_version: data.version,
      health: data.health,
      summary: data.summary,
      alerts: data.alerts
    }, null, 2);
  }

  function renderHub(data) {
    renderStatus(data);
    renderMetrics(data);
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
    replaceExactText('Loading', 'Failed');

    const statusEl = queryFirst(SELECTORS.status);
    if (statusEl) {
      statusEl.textContent = 'Hub failed · ' + (err.message || String(err));
    }

    const debug = queryFirst(SELECTORS.debug);
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
