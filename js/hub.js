/* js/hub.js
 * Sovereign Finance · Hub UI Renderer
 * v0.1.8-shell-kpi-binding
 *
 * Frontend-only.
 * Reads /api/hub and fills the existing shared shell + Hub page components.
 * Does not inject custom panels.
 * Does not create page-specific styling.
 * Does not mutate backend data.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.8-shell-kpi-binding';

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function text(value) {
    return String(value == null ? '' : value);
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function fetchJSON(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now(), {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const raw = await res.text();

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Expected JSON from ${url}, received: ${raw.slice(0, 100)}`);
    }

    if (!res.ok || json.ok === false) {
      throw new Error(json.error?.message || json.error || json.message || `HTTP ${res.status}`);
    }

    return json;
  }

  function setTextById(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;

    el.textContent = value;
    el.setAttribute('data-loaded', 'true');
    return true;
  }

  function setTextBySelector(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return false;

    el.textContent = value;
    el.setAttribute('data-loaded', 'true');
    return true;
  }

  function setValue(key, value) {
    const selectors = [
      `[data-hub-value="${key}"]`,
      `[data-hub-metric="${key}"]`,
      `[data-metric="${key}"]`,
      `[data-kpi="${key}"]`
    ];

    let updated = false;

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => {
        el.textContent = value;
        el.setAttribute('data-loaded', 'true');
        updated = true;
      });
    }

    return updated;
  }

  function setList(key, html) {
    const el = document.querySelector(`[data-hub-list="${key}"]`);
    if (!el) return;

    el.innerHTML = html;
    el.setAttribute('data-loaded', 'true');
  }

  function row(title, subtitle, value) {
    return `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${escapeHtml(title)}</div>
          <div class="sf-row-subtitle">${escapeHtml(subtitle || '')}</div>
        </div>
        <div class="sf-row-right">${escapeHtml(value || '')}</div>
      </div>
    `;
  }

  function empty(title, subtitle) {
    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${escapeHtml(title)}</h3>
          <p class="sf-card-subtitle">${escapeHtml(subtitle || '')}</p>
        </div>
      </div>
    `;
  }

  function findShellKpiValueByTitle(title) {
    const wanted = title.toLowerCase();

    const containers = Array.from(document.querySelectorAll('section, article, div, li'));
    const matching = containers
      .filter(node => text(node.textContent).toLowerCase().includes(wanted))
      .sort((a, b) => text(a.textContent).length - text(b.textContent).length);

    for (const container of matching) {
      const leaves = Array.from(container.querySelectorAll('*')).filter(el => {
        const value = text(el.textContent).trim();
        return el.children.length === 0 && value;
      });

      const valueNode = leaves.find(el => {
        const value = text(el.textContent).trim().toLowerCase();
        return value === 'loading' ||
          value === 'loaded' ||
          value === 'unavailable' ||
          value === '—' ||
          value === '--' ||
          value === '0' ||
          value === 'ok' ||
          value.startsWith('rs ') ||
          value.startsWith('-rs ') ||
          value.includes('alert');
      });

      if (valueNode) return valueNode;
    }

    return null;
  }

  function setShellKpi(title, value) {
    const node = findShellKpiValueByTitle(title);
    if (!node) return false;

    node.textContent = value;
    node.setAttribute('data-loaded', 'true');
    return true;
  }

  function renderPrimaryValues(data) {
    const s = data.summary || {};
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    const values = {
      cash_now: money(s.cash_now),
      net_worth: money(s.net_worth),
      forecast_expected_outflow: money(s.forecast_expected_outflow),
      total_owe: money(s.total_owe),
      total_owed: money(s.total_owed),
      liabilities_total: money(s.liabilities_total),
      salary_amount: money(s.salary_amount),
      forecast_projected_end: money(s.forecast_projected_end),
      attention_count: alerts.length ? `${alerts.length} alert(s)` : 'OK',
      forecast_status: data.health?.services?.forecast?.ok ? 'Forecast OK' : 'Check forecast',
      source_overall: data.health?.overall || 'unknown'
    };

    Object.entries(values).forEach(([key, value]) => setValue(key, value));

    setTextById('hub-liquid-now', values.cash_now);
    setTextById('hub-net-worth', values.net_worth);
    setTextById('hub-bills-remaining', values.forecast_expected_outflow);
    setTextById('hub-debt-payable', values.total_owe);
    setTextById('hub-receivables', values.total_owed);
    setTextById('hub-cc-outstanding', values.liabilities_total);
    setTextById('hub-next-salary', values.salary_amount);
    setTextById('hub-lowest-liquid', values.forecast_projected_end);
    setTextById('hub-attention-count', values.attention_count);
    setTextById('hub-forecast-status', values.forecast_status);
    setTextById('hub-source-overall', values.source_overall);

    /*
     * Shared-shell KPI strip generated from window.SF_PAGE.kpis.
     * Keep this Hub-only and title-bound; do not modify sf-shell.js.
     */
    setTextById('hub-kpi-liquid-now', values.cash_now);
    setTextById('hub-kpi-bills-remaining', values.forecast_expected_outflow);
    setTextById('hub-kpi-debt-payable', values.total_owe);
    setTextById('hub-kpi-forecast-risk', alerts.length ? `${alerts.length} alert(s)` : 'OK');

    setShellKpi('Liquid Now', values.cash_now);
    setShellKpi('Bills Remaining', values.forecast_expected_outflow);
    setShellKpi('Debt Payable', values.total_owe);
    setShellKpi('Forecast Risk', alerts.length ? `${alerts.length} alert(s)` : 'OK');

    const statusText = `${data.version || 'Hub'} · ${data.health?.overall || 'unknown'} · alerts ${alerts.length}`;
    setTextBySelector('[data-hub-status]', statusText);
    setTextById('hub-state-pill', statusText);

    const loadedText = 'Last loaded: ' + new Date().toLocaleTimeString();
    setTextBySelector('[data-hub-last-loaded]', loadedText);
    setTextById('hub-last-loaded', loadedText);
  }

  function renderAttention(data) {
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    if (!alerts.length) {
      setList('attention', empty('No active attention items', 'Backend contracts are passing with no Hub alerts.'));
      return;
    }

    setList('attention', alerts.map(alert => row(
      alert.title || alert.code || 'Attention item',
      alert.detail || alert.endpoint || 'Review required',
      alert.level || 'warn'
    )).join(''));
  }

  function renderForecast(data) {
    const s = data.summary || {};

    setList('forecast', [
      row('Cash now', 'Canonical transaction balance source', money(s.cash_now)),
      row('Expected income', 'Salary and receivable forecast', money(s.forecast_expected_income)),
      row('Expected outflow', 'Debt / bill pressure in horizon', money(s.forecast_expected_outflow)),
      row('Projected end', 'Forecast aggregate endpoint result', money(s.forecast_projected_end))
    ].join(''));
  }

  function renderReadiness(data) {
    const s = data.summary || {};

    setList('readiness', [
      row(
        'Reconciliation',
        `${number(s.reconciliation_matched_count)} matched · ${number(s.reconciliation_pending_statement_count)} pending`,
        `${number(s.reconciliation_exception_count)} exceptions`
      ),
      row('Backend health', 'Hub contract aggregate', data.health?.overall || 'unknown'),
      row('Alerts', 'Current backend contract alerts', Array.isArray(data.alerts) && data.alerts.length ? `${data.alerts.length}` : '0')
    ].join(''));
  }

  function renderObligations(data) {
    const s = data.summary || {};

    setList('bills', [
      row('Expected outflow', 'Forecast horizon pressure', money(s.forecast_expected_outflow)),
      row('Projected end after pressure', 'Cash + income - outflow', money(s.forecast_projected_end))
    ].join(''));

    setList('debts', [
      row('Payable', 'Outstanding amount you owe', money(s.total_owe)),
      row('Receivables', 'Expected amount owed to you', money(s.total_owed)),
      row('Active debt rows', 'Loaded from debts contract', String(number(s.active_debts_count)))
    ].join(''));
  }

  function renderPosition(data) {
    const s = data.summary || {};

    setList('accounts', [
      row('Liquid now', 'Spendable assets', money(s.total_liquid)),
      row('Total assets', 'Asset accounts', money(s.total_assets)),
      row('Liabilities', 'Liability accounts', money(s.liabilities_total)),
      row('Net worth', 'Assets plus liabilities', money(s.net_worth))
    ].join(''));

    setList('card', [
      row('Credit card outstanding', 'Liability pressure', money(s.liabilities_total)),
      row('Net worth impact', 'Included in formula-layer net worth', money(s.net_worth))
    ].join(''));
  }

  function renderActivity(data) {
    const s = data.summary || {};

    setList('activity', [
      row('Forecast events', 'Events in 30-day forecast', String(number(s.forecast_event_count))),
      row('Salary source', `Payday ${s.salary_payday || '-'}`, money(s.salary_amount)),
      row('Salary payout', 'Payout account', s.salary_payout_account_id || '-')
    ].join(''));
  }

  function renderSources(data) {
    const services = data.health?.services || {};
    const html = Object.entries(services).map(([key, service]) => row(
      key.charAt(0).toUpperCase() + key.slice(1),
      service.endpoint || '',
      service.ok ? 'OK' : 'Check'
    )).join('');

    setList('sources', html || empty('No source status', 'No services returned from /api/hub.'));
  }

  function renderDebug(data) {
    const debug = document.querySelector('[data-hub-debug]') || document.getElementById('hub-debug-output');

    if (!debug) return;

    const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
    const panel = document.getElementById('hub-debug-panel');

    if (panel && debugEnabled) panel.hidden = false;

    debug.textContent = JSON.stringify({
      ui_version: VERSION,
      api_version: data.version,
      health: data.health,
      summary: data.summary,
      alerts: data.alerts,
      sources: data.sources
    }, null, 2);
  }

  function render(data) {
    renderPrimaryValues(data);
    renderAttention(data);
    renderForecast(data);
    renderReadiness(data);
    renderObligations(data);
    renderPosition(data);
    renderActivity(data);
    renderSources(data);
    renderDebug(data);

    window.SovereignHub = {
      ui_version: VERSION,
      api: data,
      reload: load
    };

    console.log('[Hub rendered]', VERSION, data.version, data.health?.overall, data.summary);
  }

  function renderError(error) {
    const message = error.message || String(error);

    setTextById('hub-state-pill', 'Hub failed');
    setTextById('hub-attention-count', 'Error');
    setTextById('hub-forecast-status', 'Error');
    setTextById('hub-source-overall', 'Error');

    setList('attention', empty('Hub failed to load', message));
    setList('forecast', empty('Forecast unavailable', message));
    setList('readiness', empty('Readiness unavailable', message));
    setList('sources', empty('Source status unavailable', message));

    console.error('[Hub error]', error);
  }

  async function load() {
    try {
      const data = await fetchJSON('/api/hub');
      render(data);
    } catch (error) {
      renderError(error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load, { once: true });
  } else {
    load();
  }
})();
