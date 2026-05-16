/* js/hub.js
 * Sovereign Finance · Hub UI Loader
 * v0.1.1-hub-ui-contract-reader
 *
 * Frontend-only file.
 * Reads /api/hub and renders compact dashboard values.
 * Does not mutate backend data.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.1-hub-ui-contract-reader';

  const money = value => {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';
    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  };

  const text = value => String(value == null ? '' : value);

  async function fetchJSON(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now(), {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const raw = await res.text();

    try {
      const data = JSON.parse(raw);
      if (!res.ok || data.ok === false) {
        throw new Error(data.error?.message || data.error || `HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      throw new Error(`Non-JSON response from ${url}: ${raw.slice(0, 80)}`);
    }
  }

  function findSectionByLabel(label) {
    const lower = label.toLowerCase();
    const nodes = Array.from(document.querySelectorAll('section, article, div'));

    return nodes
      .filter(node => node.textContent && node.textContent.toLowerCase().includes(lower))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  }

  function setLoadingNear(label, value) {
    const section = findSectionByLabel(label);
    if (!section) return false;

    const candidates = Array.from(section.querySelectorAll('*'))
      .filter(el => text(el.textContent).trim() === 'Loading' || text(el.textContent).trim() === 'Unavailable');

    const target = candidates[candidates.length - 1];

    if (!target) return false;

    target.textContent = value;
    target.classList.add('sf-hub-loaded-value');
    return true;
  }

  function setAllTextContains(oldText, newText) {
    Array.from(document.querySelectorAll('*')).forEach(el => {
      if (el.children.length) return;
      if (text(el.textContent).trim() === oldText) {
        el.textContent = newText;
      }
    });
  }

  function setStatusPills(data) {
    setAllTextContains('Loading', 'Loaded');

    const lastLoadedCandidates = Array.from(document.querySelectorAll('*'))
      .filter(el => text(el.textContent).includes('Last loaded:'));

    lastLoadedCandidates.forEach(el => {
      el.textContent = 'Last loaded: ' + new Date().toLocaleTimeString();
    });

    const sourceCandidates = Array.from(document.querySelectorAll('*'))
      .filter(el => text(el.textContent).includes('Loading source status'));

    sourceCandidates.forEach(el => {
      el.textContent = `Hub ${data.version} · ${data.health?.overall || 'unknown'} · alerts ${data.alerts?.length || 0}`;
    });
  }

  function renderHub(data) {
    const s = data.summary || {};
    const h = data.health || {};
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    setLoadingNear('Liquid Now', money(s.cash_now));
    setLoadingNear('Net Worth', money(s.net_worth));
    setLoadingNear('Bills Remaining', money(s.forecast_expected_outflow));
    setLoadingNear('Debt Payable', money(s.total_owe));
    setLoadingNear('Receivables', money(s.total_owed));
    setLoadingNear('Credit Card Outstanding', money(s.liabilities_total));
    setLoadingNear('Next Salary', money(s.salary_amount));
    setLoadingNear('Lowest Forecast Liquid', money(s.forecast_projected_end));
    setLoadingNear('Forecast Risk', alerts.length ? `${alerts.length} alert(s)` : 'OK');

    setStatusPills(data);

    const debug = document.getElementById('hubDebug') || document.getElementById('debugPanel');
    if (debug) {
      debug.textContent = JSON.stringify({
        ui_version: VERSION,
        api_version: data.version,
        health: h,
        summary: s,
        alerts
      }, null, 2);
    }

    window.SovereignHub = {
      version: VERSION,
      api: data,
      reload: loadHub
    };
  }

  function renderError(err) {
    setAllTextContains('Loading', 'Failed');

    const debug = document.getElementById('hubDebug') || document.getElementById('debugPanel');

    if (debug) {
      debug.textContent = JSON.stringify({
        ui_version: VERSION,
        error: err.message || String(err)
      }, null, 2);
    }

    console.error('[Hub UI]', err);
  }

  async function loadHub() {
    try {
      const data = await fetchJSON('/api/hub');
      renderHub(data);
    } catch (err) {
      renderError(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHub, { once: true });
  } else {
    loadHub();
  }
})();
