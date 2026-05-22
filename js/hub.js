/* Sovereign Finance · Hub Page Controller
 * js/hub.js
 * v0.1.0-hub-page-controller
 *
 * Fetches /api/hub as primary source, then fetches secondary APIs
 * for list sections (forecast events, debts, bills, accounts, cc,
 * recent transactions) that the hub aggregator does not inline.
 *
 * Wires up every data-hub-value, data-hub-list, data-hub-status
 * element declared in index.html.
 *
 * Follows the same IIFE + ready() pattern used by sf-shell.js and
 * the rest of the Sovereign Finance JS layer.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.0-hub-page-controller';

  /* ─────────────────────────────
   * API endpoints
   * ───────────────────────────── */

  const API = {
    hub:          '/api/hub',
    forecast:     '/api/forecast?horizon=30',
    debts:        '/api/debts',
    bills:        '/api/bills',
    accounts:     '/api/balances',
    cc:           '/api/cc',
    transactions: '/api/transactions?limit=12'
  };

  /* ─────────────────────────────
   * Module state
   * ───────────────────────────── */

  const state = {
    hub:          null,
    forecast:     null,
    debts:        null,
    bills:        null,
    accounts:     null,
    cc:           null,
    transactions: null,
    loadedAt:     null,
    errors:       {}
  };

  /* ─────────────────────────────
   * DOM helpers
   * ───────────────────────────── */

  const $ = id => document.getElementById(id);

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHtml(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html || '';
  }

  function qa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  /* ─────────────────────────────
   * Number / money helpers
   * ───────────────────────────── */

  function num(value, fallback) {
    if (fallback === undefined) fallback = 0;
    if (value == null || value === '') return fallback;
    const n = typeof value === 'number'
      ? value
      : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function money(value) {
    const n = num(value, NaN);
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    return sign + 'Rs\u00a0' + abs.toLocaleString('en-PK', {
      minimumFractionDigits: abs % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function compactDate(value) {
    const raw = String(value || '').slice(0, 10);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '—';
    const [, month, day] = raw.split('-');
    const months = {
      '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
      '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
      '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec'
    };
    return `${Number(day)}\u00a0${months[month] || month}`;
  }

  function timeAgo(isoString) {
    if (!isoString) return '';
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  /* ─────────────────────────────
   * Fetch helpers
   * ───────────────────────────── */

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
      throw new Error(`Non-JSON from ${url}: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error((payload && (payload.error || payload.message)) || `HTTP ${response.status}`);
    }
    return payload;
  }

  /* Fetch without throwing — records error in state.errors */
  async function safeFetch(key, url) {
    try {
      state[key] = await fetchJSON(url);
    } catch (err) {
      state.errors[key] = err.message || String(err);
      state[key] = null;
    }
  }

  /* ─────────────────────────────
   * Loading / error state renderers
   * ───────────────────────────── */

  function loadingHtml(label) {
    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">Loading ${esc(label)}</h3>
          <p class="sf-card-subtitle">Fetching from backend.</p>
        </div>
      </div>`;
  }

  function errorHtml(label, message) {
    return `
      <div class="sf-empty-state sf-error-state">
        <div>
          <h3 class="sf-card-title">${esc(label)} unavailable</h3>
          <p class="sf-card-subtitle">${esc(message)}</p>
        </div>
      </div>`;
  }

  function emptyHtml(label) {
    return `
      <div class="sf-empty-state">
        <div>
          <h3 class="sf-card-title">No ${esc(label)}</h3>
          <p class="sf-card-subtitle">Nothing to show right now.</p>
        </div>
      </div>`;
  }

  /* ─────────────────────────────
   * Set all loading skeletons before fetching
   * ───────────────────────────── */

  function showLoadingState() {
    const pill = $('hub-state-pill');
    if (pill) pill.textContent = 'Loading';

    setText('hub-last-loaded', 'Last loaded: —');

    // All value slots
    const valueSlots = [
      'hub-liquid-now', 'hub-net-worth', 'hub-bills-remaining',
      'hub-debt-payable', 'hub-receivables', 'hub-cc-outstanding',
      'hub-next-salary', 'hub-lowest-liquid',
      'hub-kpi-liquid-now', 'hub-kpi-bills-remaining',
      'hub-kpi-debt-payable', 'hub-kpi-forecast-risk',
      'hub-attention-count', 'hub-forecast-status', 'hub-source-overall'
    ];
    valueSlots.forEach(id => setText(id, '—'));

    // All list slots
    const lists = {
      'hub-attention-list':    'attention items',
      'hub-cash-path':         'forecast',
      'hub-readiness-panel':   'readiness status',
      'hub-bills-list':        'bills',
      'hub-debts-list':        'debts',
      'hub-accounts-preview':  'accounts',
      'hub-card-pressure':     'card data',
      'hub-recent-activity':   'recent activity',
      'hub-source-list':       'sources'
    };
    Object.entries(lists).forEach(([id, label]) => {
      setHtml(id, loadingHtml(label));
    });
  }

  /* ─────────────────────────────
   * STATUS PILL + PILL HELPERS
   * ───────────────────────────── */

  function pillHtml(text, tone) {
    const cls = tone ? `sf-pill sf-pill--${tone}` : 'sf-pill';
    return `<span class="${cls}">${esc(text)}</span>`;
  }

  function toneForService(ok) {
    return ok ? 'positive' : 'danger';
  }

  /* ─────────────────────────────
   * RENDER: status pill + last loaded
   * ───────────────────────────── */

  function renderStatusPill() {
    const hub = state.hub;
    const pill = $('hub-state-pill');
    const lastLoaded = $('hub-last-loaded');

    if (!hub) {
      if (pill) {
        pill.textContent = 'Error';
        pill.className = 'sf-pill sf-pill--danger';
      }
      return;
    }

    const overall = hub.health && hub.health.overall === 'pass' ? 'pass' : 'warn';
    if (pill) {
      pill.textContent = overall === 'pass' ? 'All systems go' : 'Warning';
      pill.className = `sf-pill sf-pill--${overall === 'pass' ? 'positive' : 'warning'}`;
    }

    state.loadedAt = new Date().toISOString();
    if (lastLoaded) {
      lastLoaded.textContent = `Last loaded: ${timeAgo(state.loadedAt)}`;
    }
  }

  /* ─────────────────────────────
   * RENDER: data-hub-value slots
   * ───────────────────────────── */

  function renderValues() {
    const hub = state.hub;
    if (!hub) return;

    const s = hub.summary || {};
    const h = hub.health || {};

    // Map: elementId → value
    const values = {
      'hub-liquid-now':       money(s.cash_now),
      'hub-net-worth':        money(s.net_worth),
      'hub-bills-remaining':  money(s.forecast_expected_outflow),
      'hub-debt-payable':     money(s.total_owe),
      'hub-receivables':      money(s.total_owed),
      'hub-cc-outstanding':   money(s.liabilities_total),
      'hub-next-salary':      s.salary_enabled ? money(s.salary_amount) : '—',
      'hub-lowest-liquid':    money(s.forecast_projected_end),

      // KPI card value slots (rendered by sf-shell.js into metric cards)
      'hub-kpi-liquid-now':      money(s.cash_now),
      'hub-kpi-bills-remaining': money(s.forecast_expected_outflow),
      'hub-kpi-debt-payable':    money(s.total_owe),
      'hub-kpi-forecast-risk':   alertRiskLabel(hub.alerts),

      // Misc
      'hub-forecast-status': forecastStatusLabel(hub),
      'hub-source-overall':  h.overall === 'pass' ? 'All passing' : 'Issues found'
    };

    Object.entries(values).forEach(([id, value]) => setText(id, value));

    // Subtitle for lowest liquid
    const sub = $('hub-lowest-liquid-sub');
    if (sub) {
      sub.textContent = `30-day forecast · ${s.forecast_event_count || 0} events`;
    }

    // Attention count
    const alerts = Array.isArray(hub.alerts) ? hub.alerts : [];
    setText('hub-attention-count', alerts.length ? `${alerts.length} item${alerts.length === 1 ? '' : 's'}` : 'Clear');

    // Apply tone class to net worth
    const nwEl = $('hub-net-worth');
    if (nwEl) {
      const nw = num(s.net_worth, 0);
      nwEl.className = nw >= 0 ? 'sf-row-right' : 'sf-row-right sf-tone-danger';
    }

    // Apply tone class to lowest liquid
    const llEl = $('hub-lowest-liquid');
    if (llEl) {
      const ll = num(s.forecast_projected_end, 0);
      llEl.className = ll >= 0 ? 'sf-row-right' : 'sf-row-right sf-tone-danger';
    }
  }

  function alertRiskLabel(alerts) {
    if (!Array.isArray(alerts) || !alerts.length) return 'Clear';
    const critical = alerts.filter(a => a.level === 'critical');
    if (critical.length) return `${critical.length} critical`;
    return `${alerts.length} warning${alerts.length === 1 ? '' : 's'}`;
  }

  function forecastStatusLabel(hub) {
    const services = hub.health && hub.health.services || {};
    const fc = services.forecast;
    if (!fc) return 'Unknown';
    if (fc.ok) return fc.salary_enabled ? 'Active + salary' : 'Active';
    return 'Unavailable';
  }

  /* ─────────────────────────────
   * RENDER: attention list
   * ───────────────────────────── */

  function renderAttention() {
    const el = $('hub-attention-list');
    if (!el) return;

    const hub = state.hub;
    if (!hub) {
      el.innerHTML = errorHtml('Attention items', state.errors.hub || 'Hub API unavailable');
      return;
    }

    const alerts = Array.isArray(hub.alerts) ? hub.alerts : [];
    const services = hub.health && hub.health.services || {};

    // Build rows from alerts + any failing services
    const rows = [];

    alerts.forEach(alert => {
      const tone = alert.level === 'critical' ? 'danger' : 'warning';
      rows.push({ tone, title: alert.title, detail: alert.detail, endpoint: alert.endpoint });
    });

    // If health.overall is warn but no alerts were surfaced, add a generic row
    if (!alerts.length && hub.health && hub.health.overall !== 'pass') {
      rows.push({
        tone: 'warning',
        title: 'One or more services are not passing',
        detail: 'Check source status below.',
        endpoint: null
      });
    }

    if (!rows.length) {
      el.innerHTML = `
        <div class="sf-dense-row">
          <span class="sf-tone-positive">✓ No alerts</span>
          <span>All contracts passing</span>
        </div>`;
      return;
    }

    el.innerHTML = rows.map(row => `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title sf-tone-${esc(row.tone)}">${esc(row.title)}</div>
          <div class="sf-row-subtitle">${esc(row.detail || '')}${row.endpoint ? ` · <code>${esc(row.endpoint)}</code>` : ''}</div>
        </div>
        <div class="sf-row-right">
          <span class="sf-pill sf-pill--${esc(row.tone)}">${row.tone === 'danger' ? 'Critical' : 'Warn'}</span>
        </div>
      </div>`).join('');
  }

  /* ─────────────────────────────
   * RENDER: forecast cash path
   * ───────────────────────────── */

  function renderForecast() {
    const el = $('hub-cash-path');
    if (!el) return;

    if (state.errors.forecast) {
      el.innerHTML = errorHtml('Forecast', state.errors.forecast);
      return;
    }

    const payload = state.forecast;
    if (!payload) {
      el.innerHTML = emptyHtml('forecast events');
      return;
    }

    const events = Array.isArray(payload.events) ? payload.events : [];
    const summary = payload.summary || {};

    // Summary row first
    const summaryRow = `
      <div class="sf-dense-row">
        <span>Expected income</span>
        <strong class="sf-tone-positive">${esc(money(summary.expected_income))}</strong>
      </div>
      <div class="sf-dense-row">
        <span>Expected outflow</span>
        <strong class="sf-tone-danger">${esc(money(summary.expected_outflow))}</strong>
      </div>
      <div class="sf-dense-row">
        <span>Projected end balance</span>
        <strong>${esc(money(summary.projected_end))}</strong>
      </div>`;

    if (!events.length) {
      el.innerHTML = summaryRow + `<div class="sf-dense-row"><span>No forecast events in horizon</span></div>`;
      return;
    }

    // Show up to 8 events
    const shown = events.slice(0, 8);
    const moreCount = events.length - shown.length;

    const eventRows = shown.map(ev => {
      const isIncome = ev.type === 'income';
      const amountClass = isIncome ? 'sf-tone-positive' : 'sf-tone-danger';
      return `
        <div class="sf-dense-row">
          <span>
            <strong>${esc(ev.title || ev.source || '—')}</strong>
            ${ev.date ? `<span class="sf-muted"> · ${esc(compactDate(ev.date))}</span>` : ''}
          </span>
          <strong class="${amountClass}">${esc(money(ev.amount))}</strong>
        </div>`;
    }).join('');

    const moreRow = moreCount > 0
      ? `<div class="sf-dense-row sf-muted"><span>+${moreCount} more events</span><a href="/forecast.html" class="sf-button">Open Forecast</a></div>`
      : '';

    el.innerHTML = summaryRow + eventRows + moreRow;
  }

  /* ─────────────────────────────
   * RENDER: readiness (Monthly Close + Reconciliation)
   * ───────────────────────────── */

  function renderReadiness() {
    const el = $('hub-readiness-panel');
    if (!el) return;

    const hub = state.hub;
    if (!hub) {
      el.innerHTML = errorHtml('Readiness', state.errors.hub || 'Unavailable');
      return;
    }

    const services = hub.health && hub.health.services || {};
    const s = hub.summary || {};

    const recon = services.reconciliation;
    const reconOk = recon && recon.ok;

    const rows = [
      {
        label: 'Reconciliation',
        value: reconOk
          ? `${s.reconciliation_matched_count || 0} / ${s.reconciliation_account_count || 0} matched`
          : 'Not passing',
        tone: reconOk ? 'positive' : 'warning',
        link: '/reconciliation.html'
      },
      {
        label: 'Exceptions',
        value: s.reconciliation_exception_count > 0
          ? `${s.reconciliation_exception_count} open`
          : 'None',
        tone: s.reconciliation_exception_count > 0 ? 'warning' : 'positive',
        link: '/reconciliation.html'
      },
      {
        label: 'Pending statements',
        value: s.reconciliation_pending_statement_count > 0
          ? `${s.reconciliation_pending_statement_count} accounts`
          : 'Clear',
        tone: s.reconciliation_pending_statement_count > 0 ? 'warning' : 'positive',
        link: '/reconciliation.html'
      },
      {
        label: 'Monthly Close',
        value: 'Open page to check',
        tone: null,
        link: '/monthly-close.html'
      }
    ];

    el.innerHTML = rows.map(row => `
      <div class="sf-dense-row">
        <span>${esc(row.label)}</span>
        <strong class="${row.tone ? 'sf-tone-' + esc(row.tone) : ''}">${esc(row.value)}</strong>
      </div>`).join('') +
      `<div class="sf-dense-row" style="margin-top:10px;">
        <a href="/reconciliation.html" class="sf-button">Open Reconciliation</a>
        <a href="/monthly-close.html" class="sf-button">Monthly Close</a>
      </div>`;
  }

  /* ─────────────────────────────
   * RENDER: bills list
   * ───────────────────────────── */

  function renderBills() {
    const el = $('hub-bills-list');
    if (!el) return;

    if (state.errors.bills) {
      el.innerHTML = errorHtml('Bills', state.errors.bills);
      return;
    }

    const payload = state.bills;
    if (!payload) {
      el.innerHTML = emptyHtml('bills');
      return;
    }

    // Support both bills array and current_cycle structure
    const bills = Array.isArray(payload.bills)
      ? payload.bills
      : Array.isArray(payload.current_cycle)
        ? payload.current_cycle
        : [];

    // Pull summary values
    const expected = payload.expected_this_cycle != null ? money(payload.expected_this_cycle) : '—';
    const paid     = payload.paid_this_cycle != null     ? money(payload.paid_this_cycle)     : '—';
    const remaining = payload.remaining != null           ? money(payload.remaining)            : '—';

    const summaryHtml = `
      <div class="sf-dense-row">
        <span>Expected this cycle</span>
        <strong>${esc(expected)}</strong>
      </div>
      <div class="sf-dense-row">
        <span>Paid this cycle</span>
        <strong class="sf-tone-positive">${esc(paid)}</strong>
      </div>
      <div class="sf-dense-row">
        <span>Remaining</span>
        <strong class="${num(payload.remaining, 0) > 0 ? 'sf-tone-warning' : ''}">${esc(remaining)}</strong>
      </div>`;

    if (!bills.length) {
      el.innerHTML = summaryHtml + `<div class="sf-dense-row"><span>No bills found</span></div>`;
      return;
    }

    const unpaid = bills
      .filter(b => b.status !== 'paid')
      .slice(0, 6);

    const billRows = unpaid.map(b => {
      const status = String(b.status || 'unpaid');
      const tone = status === 'paid' ? 'positive' : status === 'partial' ? 'warning' : 'danger';
      return `
        <div class="sf-dense-row">
          <span>
            <strong>${esc(b.name || b.bill_name || '—')}</strong>
            ${b.due_day ? `<span class="sf-muted"> · due day\u00a0${esc(b.due_day)}</span>` : ''}
          </span>
          <strong class="sf-tone-${tone}">${esc(money(b.amount))}</strong>
        </div>`;
    }).join('');

    const moreCount = bills.filter(b => b.status !== 'paid').length - unpaid.length;
    const moreRow = moreCount > 0
      ? `<div class="sf-dense-row sf-muted"><span>+${moreCount} more bills</span></div>`
      : '';

    el.innerHTML = summaryHtml + billRows + moreRow;
  }

  /* ─────────────────────────────
   * RENDER: debts list
   * ───────────────────────────── */

  function renderDebts() {
    const el = $('hub-debts-list');
    if (!el) return;

    if (state.errors.debts) {
      el.innerHTML = errorHtml('Debts', state.errors.debts);
      return;
    }

    const payload = state.debts;
    if (!payload) {
      el.innerHTML = emptyHtml('debts');
      return;
    }

    const debts = Array.isArray(payload.debts) ? payload.debts : [];

    const summaryHtml = `
      <div class="sf-dense-row">
        <span>I owe</span>
        <strong class="sf-tone-danger">${esc(money(payload.total_owe))}</strong>
      </div>
      <div class="sf-dense-row">
        <span>Owed to me</span>
        <strong class="sf-tone-positive">${esc(money(payload.total_owed))}</strong>
      </div>`;

    if (!debts.length) {
      el.innerHTML = summaryHtml + `<div class="sf-dense-row"><span>No active debts</span></div>`;
      return;
    }

    const shown = debts.slice(0, 6);
    const moreCount = debts.length - shown.length;

    const debtRows = shown.map(d => {
      const isOwed = d.kind === 'owed';
      const tone = isOwed ? 'positive' : 'danger';
      const label = isOwed ? 'receivable' : 'payable';
      return `
        <div class="sf-dense-row">
          <span>
            <strong>${esc(d.name || '—')}</strong>
            <span class="sf-muted"> · ${label}</span>
          </span>
          <strong class="sf-tone-${tone}">${esc(money(d.remaining_amount))}</strong>
        </div>`;
    }).join('');

    const moreRow = moreCount > 0
      ? `<div class="sf-dense-row sf-muted"><span>+${moreCount} more debts</span></div>`
      : '';

    el.innerHTML = summaryHtml + debtRows + moreRow;
  }

  /* ─────────────────────────────
   * RENDER: accounts preview
   * ───────────────────────────── */

  function renderAccounts() {
    const el = $('hub-accounts-preview');
    if (!el) return;

    if (state.errors.accounts) {
      el.innerHTML = errorHtml('Accounts', state.errors.accounts);
      return;
    }

    const payload = state.accounts;
    if (!payload) {
      el.innerHTML = emptyHtml('accounts');
      return;
    }

    // /api/balances returns accounts array + totals
    const accounts = Array.isArray(payload.accounts)
      ? payload.accounts
      : Array.isArray(payload.account_list)
        ? payload.account_list
        : [];

    if (!accounts.length) {
      el.innerHTML = emptyHtml('accounts');
      return;
    }

    // Show assets only, up to 8
    const assets = accounts
      .filter(a => String(a.type || a.kind || '').toLowerCase() !== 'liability')
      .slice(0, 8);

    el.innerHTML = assets.map(a => {
      const balance = num(a.balance, 0);
      const toneClass = balance < 0 ? 'sf-tone-danger' : '';
      return `
        <div class="sf-finance-row">
          <div class="sf-row-left">
            <div class="sf-row-title">${esc(a.icon ? a.icon + '\u00a0' : '') + esc(a.name || a.id)}</div>
            <div class="sf-row-subtitle">${esc(String(a.kind || a.type || 'account'))}</div>
          </div>
          <div class="sf-row-right ${toneClass}">${esc(money(balance))}</div>
        </div>`;
    }).join('');
  }

  /* ─────────────────────────────
   * RENDER: credit card pressure
   * ───────────────────────────── */

  function renderCard() {
    const el = $('hub-card-pressure');
    if (!el) return;

    if (state.errors.cc) {
      el.innerHTML = errorHtml('Credit Card', state.errors.cc);
      return;
    }

    const payload = state.cc;
    if (!payload) {
      el.innerHTML = emptyHtml('credit card data');
      return;
    }

    const cards = Array.isArray(payload.accounts) ? payload.accounts : [];

    if (!cards.length) {
      el.innerHTML = `
        <div class="sf-dense-row">
          <span>No credit card accounts found</span>
        </div>`;
      return;
    }

    el.innerHTML = cards.map(card => {
      const outstanding = num(card.outstanding, 0);
      const limit = num(card.credit_limit, 0);
      const utilPct = card.utilization_pct != null ? `${card.utilization_pct}%` : '—';
      const due = card.due || {};
      const daysUntilDue = due.days_until_payment_due;
      const dueLabel = daysUntilDue == null
        ? '—'
        : daysUntilDue < 0
          ? 'Overdue'
          : daysUntilDue === 0
            ? 'Due today'
            : `Due in\u00a0${daysUntilDue}d`;
      const dueTone = daysUntilDue != null && daysUntilDue <= 3
        ? 'sf-tone-danger'
        : daysUntilDue != null && daysUntilDue <= 7
          ? 'sf-tone-warning'
          : '';

      return `
        <div class="sf-dense-row">
          <span><strong>${esc(card.name || card.id)}</strong></span>
          <strong class="sf-tone-danger">${esc(money(outstanding))}</strong>
        </div>
        <div class="sf-dense-row">
          <span>Utilization</span>
          <strong>${esc(utilPct)}${limit > 0 ? ` of ${esc(money(limit))}` : ''}</strong>
        </div>
        <div class="sf-dense-row">
          <span>Payment due</span>
          <strong class="${dueTone}">${esc(dueLabel)}</strong>
        </div>
        ${card.due_headline ? `<div class="sf-dense-row sf-muted"><span>${esc(card.due_headline)}</span></div>` : ''}`;
    }).join('<hr style="border:0;border-top:1px solid var(--sf-border-subtle);margin:8px 0">');
  }

  /* ─────────────────────────────
   * RENDER: recent activity (transactions)
   * ───────────────────────────── */

  function renderActivity() {
    const el = $('hub-recent-activity');
    if (!el) return;

    if (state.errors.transactions) {
      el.innerHTML = errorHtml('Recent Activity', state.errors.transactions);
      return;
    }

    const payload = state.transactions;
    if (!payload) {
      el.innerHTML = emptyHtml('recent transactions');
      return;
    }

    const txns = Array.isArray(payload.transactions) ? payload.transactions : [];

    if (!txns.length) {
      el.innerHTML = emptyHtml('recent transactions');
      return;
    }

    const IN_TYPES = new Set(['income', 'salary', 'opening', 'borrow', 'debt_in', 'adjustment_positive']);

    el.innerHTML = txns.map(t => {
      const isIn = IN_TYPES.has(String(t.type || '').toLowerCase());
      const amtClass = isIn ? 'sf-tone-positive' : 'sf-tone-danger';
      const sign = isIn ? '+' : '−';
      const displayAmt = num(t.pkr_amount || t.amount, 0);

      // Derive a clean label: merchant > notes excerpt > type
      let label = t.merchant || '';
      if (!label && t.notes) {
        label = t.notes.replace(/\[.*?\]/g, '').replace(/\|.*$/, '').trim().slice(0, 48);
      }
      if (!label) label = t.type || '—';

      return `
        <div class="sf-dense-row">
          <span>
            <strong>${esc(label)}</strong>
            <span class="sf-muted"> · ${esc(compactDate(t.date))}</span>
          </span>
          <strong class="${amtClass}">${sign}${esc(money(displayAmt))}</strong>
        </div>`;
    }).join('');
  }

  /* ─────────────────────────────
   * RENDER: source status list
   * ───────────────────────────── */

  function renderSources() {
    const el = $('hub-source-list');
    if (!el) return;

    const hub = state.hub;
    if (!hub) {
      el.innerHTML = errorHtml('Sources', state.errors.hub || 'Hub unavailable');
      return;
    }

    const sources = hub.sources || {};
    const services = (hub.health && hub.health.services) || {};

    // Build display list from hub.sources (which has endpoint + ok + version + error)
    const sourceEntries = Object.entries(sources).map(([key, src]) => {
      const ok = src && src.ok;
      const label = src && src.endpoint ? src.endpoint : key;
      const ver = src && src.version ? src.version : '—';
      const errMsg = src && src.error ? src.error.message || JSON.stringify(src.error) : null;
      return { key, label, ok, ver, errMsg };
    });

    if (!sourceEntries.length) {
      el.innerHTML = emptyHtml('source data');
      return;
    }

    el.innerHTML = sourceEntries.map(s => `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">
            <code>${esc(s.label)}</code>
          </div>
          <div class="sf-row-subtitle">
            ${s.ver !== '—' ? `v\u00a0${esc(s.ver)}` : ''}
            ${s.errMsg ? ` · ${esc(s.errMsg)}` : ''}
          </div>
        </div>
        <div class="sf-row-right">
          <span class="sf-pill sf-pill--${s.ok ? 'positive' : 'danger'}">${s.ok ? 'Pass' : 'Fail'}</span>
        </div>
      </div>`).join('');
  }

  /* ─────────────────────────────
   * RENDER: debug panel
   * ───────────────────────────── */

  function renderDebug() {
    const el = $('hub-debug-output');
    if (!el) return;

    el.textContent = JSON.stringify({
      hub:          state.hub,
      forecast:     state.forecast,
      debts:        state.debts,
      bills:        state.bills,
      accounts:     state.accounts,
      cc:           state.cc,
      transactions: state.transactions,
      errors:       state.errors,
      loadedAt:     state.loadedAt
    }, null, 2);
  }

  /* ─────────────────────────────
   * RENDER ALL: called after all fetches complete
   * ───────────────────────────── */

  function renderAll() {
    renderStatusPill();
    renderValues();
    renderAttention();
    renderForecast();
    renderReadiness();
    renderBills();
    renderDebts();
    renderAccounts();
    renderCard();
    renderActivity();
    renderSources();
    renderDebug();
  }

  /* ─────────────────────────────
   * LOAD: primary hub fetch + secondary list fetches in parallel
   * ───────────────────────────── */

  async function load() {
    showLoadingState();

    // Hub is primary — fetch it first so we have summary data quickly,
    // then kick off all secondary fetches in parallel.
    await safeFetch('hub', API.hub);

    // Render values and status from hub immediately so the page feels fast
    renderStatusPill();
    renderValues();
    renderAttention();
    renderReadiness();
    renderSources();

    // Secondary fetches — all parallel
    await Promise.all([
      safeFetch('forecast',     API.forecast),
      safeFetch('debts',        API.debts),
      safeFetch('bills',        API.bills),
      safeFetch('accounts',     API.accounts),
      safeFetch('cc',           API.cc),
      safeFetch('transactions', API.transactions)
    ]);

    // Render everything once all data is in
    renderAll();
  }

  /* ─────────────────────────────
   * INIT
   * ───────────────────────────── */

  function init() {
    load();

    // Expose refresh hook for the Refresh button declared in SF_PAGE.actions.
    // sf-shell.js renders action buttons with id from the action config.
    // index.html does not declare a button id for refresh, so we also listen
    // for any button whose label text is "Refresh" as a fallback.
    document.addEventListener('click', function (event) {
      const btn = event.target.closest('button, a');
      if (!btn) return;

      const label = (btn.textContent || '').trim();
      const id = btn.id || '';

      if (id === 'hub-refresh' || label === 'Refresh') {
        event.preventDefault();
        state.errors = {};
        load();
      }
    });

    // Expose global for console debugging
    window.SovereignHub = {
      version: VERSION,
      reload:  load,
      state:   () => JSON.parse(JSON.stringify(state))
    };
  }

  /* ─────────────────────────────
   * Boot
   * ───────────────────────────── */

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  ready(init);

})();
