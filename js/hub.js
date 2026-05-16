/* js/hub.js
 * Sovereign Finance · Hub UI Renderer
 * v0.1.6-existing-shell-deterministic
 *
 * Frontend-only.
 * Reads /api/hub and fills the existing Hub shell.
 * Does not inject standalone panels.
 * Does not create custom styling.
 * Does not mutate backend data.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.6-existing-shell-deterministic';

  const METRICS = [
    {
      key: 'cash_now',
      labels: ['Liquid Now', 'Cash Now', 'Liquid'],
      value: s => money(s.cash_now)
    },
    {
      key: 'net_worth',
      labels: ['Net Worth'],
      value: s => money(s.net_worth)
    },
    {
      key: 'forecast_expected_outflow',
      labels: ['Bills Remaining', 'Expected Outflow', 'Outflow'],
      value: s => money(s.forecast_expected_outflow)
    },
    {
      key: 'total_owe',
      labels: ['Debt Payable', 'Payable', 'Total Owe'],
      value: s => money(s.total_owe)
    },
    {
      key: 'total_owed',
      labels: ['Receivables', 'Total Owed'],
      value: s => money(s.total_owed)
    },
    {
      key: 'liabilities_total',
      labels: ['Credit Card Outstanding', 'Liabilities', 'CC Outstanding'],
      value: s => money(s.liabilities_total)
    },
    {
      key: 'salary_amount',
      labels: ['Next Salary', 'Salary'],
      value: s => money(s.salary_amount)
    },
    {
      key: 'forecast_projected_end',
      labels: ['Lowest Forecast Liquid', 'Forecast End', 'Projected End'],
      value: s => money(s.forecast_projected_end)
    },
    {
      key: 'forecast_risk',
      labels: ['Forecast Risk', 'Risk'],
      value: (s, data) => {
        const alerts = Array.isArray(data.alerts) ? data.alerts : [];
        return alerts.length ? `${alerts.length} alert(s)` : 'OK';
      }
    }
  ];

  const SERVICES = {
    health: ['Health'],
    accounts: ['Accounts'],
    debts: ['Debts'],
    salary: ['Salary'],
    forecast: ['Forecast'],
    reconciliation: ['Reconciliation']
  };

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function lower(value) {
    return clean(value).toLowerCase();
  }

  function isHubPage() {
    const path = lower(location.pathname);
    const bodyText = lower(document.body ? document.body.textContent : '');

    return (
      path === '/' ||
      path.endsWith('/index.html') ||
      bodyText.includes('finance hub') ||
      bodyText.includes('liquid now') ||
      bodyText.includes('money position')
    );
  }

  async function fetchJSON(url) {
    const finalUrl = url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now();

    const response = await fetch(finalUrl, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Expected JSON from ${url}, received: ${raw.slice(0, 120)}`);
    }

    if (!response.ok || data.ok === false) {
      throw new Error(data.error?.message || data.error || data.message || `HTTP ${response.status}`);
    }

    return data;
  }

  function allElements() {
    return Array.from(document.querySelectorAll('body *'));
  }

  function leaves(root) {
    return Array.from(root.querySelectorAll('*')).filter(el => {
      return el.children.length === 0 && clean(el.textContent);
    });
  }

  function findByDataHook(key) {
    return document.querySelector(
      [
        `[data-hub-value="${key}"]`,
        `[data-hub-metric="${key}"]`,
        `[data-metric="${key}"]`,
        `[data-kpi="${key}"]`,
        `#hub-${key}`,
        `#hub_${key}`,
        `#${key}`
      ].join(',')
    );
  }

  function nodeContainsAnyLabel(node, labels) {
    const value = lower(node.textContent);
    return labels.some(label => value.includes(lower(label)));
  }

  function findSmallestContainer(labels) {
    const selectors = [
      '[data-card]',
      '[data-kpi]',
      '[data-metric]',
      '.card',
      '.kpi',
      '.metric',
      '.stat',
      '.panel',
      '.tile',
      'section',
      'article',
      'li',
      'div'
    ].join(',');

    return Array.from(document.querySelectorAll(selectors))
      .filter(node => nodeContainsAnyLabel(node, labels))
      .sort((a, b) => clean(a.textContent).length - clean(b.textContent).length)[0] || null;
  }

  function isLikelyValueNode(el, labels) {
    const value = clean(el.textContent);
    const l = lower(value);

    if (!value) return false;
    if (labels.some(label => l === lower(label))) return false;

    if (l === 'loading') return true;
    if (l === 'loaded') return true;
    if (l === 'unavailable') return true;
    if (l === 'available') return true;
    if (l === '—') return true;
    if (l === '--') return true;
    if (l === '0') return true;
    if (l === 'ok') return true;
    if (l.includes('alert')) return true;
    if (l.startsWith('rs ')) return true;
    if (l.startsWith('-rs ')) return true;
    if (/^-?\d[\d,]*(\.\d+)?$/.test(l)) return true;

    return false;
  }

  function findValueTarget(container, labels) {
    const explicit = container.querySelector(
      '[data-value], [data-hub-value], [data-metric-value], [data-kpi-value], .value, .metric-value, .kpi-value, .stat-value, .amount'
    );

    if (explicit) return explicit;

    const leafNodes = leaves(container);
    const valueNodes = leafNodes.filter(el => isLikelyValueNode(el, labels));

    if (valueNodes.length) return valueNodes[valueNodes.length - 1];

    return leafNodes
      .filter(el => !labels.some(label => lower(el.textContent) === lower(label)))
      .slice(-1)[0] || null;
  }

  function setMetric(metric, data) {
    const summary = data.summary || {};
    const value = metric.value(summary, data);

    const direct = findByDataHook(metric.key);
    if (direct) {
      direct.textContent = value;
      direct.setAttribute('data-hub-rendered', 'true');
      return true;
    }

    const container = findSmallestContainer(metric.labels);
    if (!container) return false;

    const target = findValueTarget(container, metric.labels);
    if (!target) return false;

    target.textContent = value;
    target.setAttribute('data-hub-rendered', 'true');
    return true;
  }

  function setService(name, service) {
    const labels = SERVICES[name] || [name];
    const value = service && service.ok ? 'OK' : 'Check';

    const direct = document.querySelector(
      `[data-hub-service="${name}"], [data-service="${name}"], #hub-service-${name}, #service-${name}`
    );

    if (direct) {
      direct.textContent = value;
      direct.setAttribute('data-hub-rendered', 'true');
      return true;
    }

    const container = findSmallestContainer(labels);
    if (!container) return false;

    const target = findValueTarget(container, labels);
    if (!target) return false;

    target.textContent = value;
    target.setAttribute('data-hub-rendered', 'true');
    return true;
  }

  function replaceLeafContaining(fragment, value) {
    const wanted = lower(fragment);

    for (const el of allElements()) {
      if (el.children.length) continue;
      if (lower(el.textContent).includes(wanted)) {
        el.textContent = value;
        el.setAttribute('data-hub-rendered', 'true');
      }
    }
  }

  function renderStatus(data) {
    const status = data.health?.overall || 'unknown';
    const alertCount = Array.isArray(data.alerts) ? data.alerts.length : 0;
    const statusText = `Hub ${data.version || 'unknown'} · ${status} · alerts ${alertCount}`;
    const lastLoadedText = 'Last loaded: ' + new Date().toLocaleTimeString();

    const statusEl =
      document.querySelector('[data-hub-status]') ||
      document.querySelector('#hubStatus');

    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.setAttribute('data-hub-rendered', 'true');
    }

    const lastLoadedEl =
      document.querySelector('[data-hub-last-loaded]') ||
      document.querySelector('#hubLastLoaded');

    if (lastLoadedEl) {
      lastLoadedEl.textContent = lastLoadedText;
      lastLoadedEl.setAttribute('data-hub-rendered', 'true');
    }

    replaceLeafContaining('Loading source status', statusText);
    replaceLeafContaining('Last loaded:', lastLoadedText);
  }

  function renderMetrics(data) {
    for (const metric of METRICS) {
      setMetric(metric, data);
    }
  }

  function renderServices(data) {
    const services = data.health?.services || {};

    for (const [name, service] of Object.entries(services)) {
      setService(name, service);
    }
  }

  function renderAlerts(data) {
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    const target =
      document.querySelector('[data-hub-alerts]') ||
      document.querySelector('#hubAlerts');

    if (!target) return;

    target.textContent = alerts.length
      ? alerts.map(alert => `${alert.level || 'warn'}: ${alert.title || alert.code || 'Alert'}`).join('\n')
      : 'No active backend alerts.';

    target.setAttribute('data-hub-rendered', 'true');
  }

  function renderDebug(data) {
    const debug =
      document.querySelector('[data-hub-debug]') ||
      document.querySelector('#hubDebug') ||
      document.querySelector('#debugPanel');

    if (!debug) return;

    debug.textContent = JSON.stringify({
      ui_version: VERSION,
      api_version: data.version,
      health: data.health,
      summary: data.summary,
      alerts: data.alerts
    }, null, 2);

    debug.setAttribute('data-hub-rendered', 'true');
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

    console.log('[Hub UI rendered]', {
      ui_version: VERSION,
      api_version: data.version,
      summary: data.summary,
      alerts: data.alerts
    });
  }

  function renderError(err) {
    const message = 'Hub failed · ' + (err.message || String(err));

    const statusEl =
      document.querySelector('[data-hub-status]') ||
      document.querySelector('#hubStatus');

    if (statusEl) statusEl.textContent = message;

    replaceLeafContaining('Loading source status', message);

    const debug =
      document.querySelector('[data-hub-debug]') ||
      document.querySelector('#hubDebug') ||
      document.querySelector('#debugPanel');

    if (debug) {
      debug.textContent = JSON.stringify({
        ui_version: VERSION,
        error: err.message || String(err)
      }, null, 2);
    }

    console.error('[Hub UI error]', err);
  }

  async function loadHub() {
    if (!isHubPage()) return;

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
