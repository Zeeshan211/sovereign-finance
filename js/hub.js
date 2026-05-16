/* js/hub.js
 * Sovereign Finance · Hub UI Safe Renderer
 * v0.1.4-hub-safe-panel-render
 *
 * Frontend-only.
 * Reads /api/hub and renders a compact status panel.
 * Does not mutate backend data.
 * Does not touch other finance pages.
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.4-hub-safe-panel-render';

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function safeText(value) {
    return String(value == null ? '' : value);
  }

  function isHubPage() {
    const path = location.pathname.toLowerCase();
    const bodyText = safeText(document.body?.textContent).toLowerCase();

    return (
      path === '/' ||
      path.endsWith('/index.html') ||
      bodyText.includes('finance hub') ||
      bodyText.includes('liquid now') ||
      bodyText.includes('money position')
    );
  }

  async function fetchHub() {
    const res = await fetch('/api/hub?ts=' + Date.now(), {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const raw = await res.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error('Expected JSON from /api/hub, received: ' + raw.slice(0, 120));
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.error?.message || data.error || data.message || 'Hub API failed');
    }

    return data;
  }

  function ensureStyles() {
    if (document.getElementById('sf-hub-safe-style')) return;

    const style = document.createElement('style');
    style.id = 'sf-hub-safe-style';
    style.textContent = `
      .sf-hub-safe-panel {
        margin: 12px 0 16px;
        padding: 12px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.72);
        color: #e5e7eb;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
      }

      .sf-hub-safe-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }

      .sf-hub-safe-title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .sf-hub-safe-status {
        font-size: 12px;
        color: #cbd5e1;
      }

      .sf-hub-safe-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
      }

      .sf-hub-safe-card {
        padding: 10px;
        border-radius: 12px;
        background: rgba(30, 41, 59, 0.74);
        border: 1px solid rgba(148, 163, 184, 0.18);
      }

      .sf-hub-safe-label {
        font-size: 11px;
        color: #94a3b8;
        margin-bottom: 4px;
      }

      .sf-hub-safe-value {
        font-size: 15px;
        font-weight: 750;
        color: #f8fafc;
      }

      .sf-hub-safe-alert-ok {
        color: #86efac;
      }

      .sf-hub-safe-alert-warn {
        color: #fbbf24;
      }

      .sf-hub-safe-error {
        padding: 12px;
        border-radius: 12px;
        background: rgba(127, 29, 29, 0.32);
        border: 1px solid rgba(248, 113, 113, 0.35);
        color: #fecaca;
        font-size: 13px;
      }
    `;
    document.head.appendChild(style);
  }

  function findMountPoint() {
    const existing = document.getElementById('sfHubSafePanel');
    if (existing) return existing;

    const panel = document.createElement('section');
    panel.id = 'sfHubSafePanel';
    panel.className = 'sf-hub-safe-panel';
    panel.setAttribute('data-hub-ui-version', VERSION);

    const main =
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;

    const firstLargeBlock =
      main.querySelector('section') ||
      main.querySelector('article') ||
      main.firstElementChild;

    if (firstLargeBlock && firstLargeBlock.parentNode) {
      firstLargeBlock.parentNode.insertBefore(panel, firstLargeBlock.nextSibling);
    } else {
      main.prepend(panel);
    }

    return panel;
  }

  function renderPanel(data) {
    ensureStyles();

    const s = data.summary || {};
    const h = data.health || {};
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];

    const panel = findMountPoint();

    panel.innerHTML = `
      <div class="sf-hub-safe-top">
        <div>
          <div class="sf-hub-safe-title">Backend Contract Hub</div>
          <div class="sf-hub-safe-status">
            ${escapeHtml(data.version || 'unknown')} · overall ${escapeHtml(h.overall || 'unknown')} · ${new Date().toLocaleTimeString()}
          </div>
        </div>
        <div class="${alerts.length ? 'sf-hub-safe-alert-warn' : 'sf-hub-safe-alert-ok'}">
          ${alerts.length ? `${alerts.length} alert(s)` : 'No backend alerts'}
        </div>
      </div>

      <div class="sf-hub-safe-grid">
        ${metric('Liquid Now', money(s.cash_now))}
        ${metric('Net Worth', money(s.net_worth))}
        ${metric('Forecast End', money(s.forecast_projected_end))}
        ${metric('Next Salary', money(s.salary_amount))}
        ${metric('Expected Income', money(s.forecast_expected_income))}
        ${metric('Expected Outflow', money(s.forecast_expected_outflow))}
        ${metric('Debt Payable', money(s.total_owe))}
        ${metric('Receivables', money(s.total_owed))}
        ${metric('Reconciliation', `${Number(s.reconciliation_matched_count || 0)} matched / ${Number(s.reconciliation_pending_statement_count || 0)} pending`)}
      </div>
    `;

    replaceOldLoadingText(data);

    window.SovereignHub = {
      ui_version: VERSION,
      api: data,
      reload: load
    };
  }

  function metric(label, value) {
    return `
      <div class="sf-hub-safe-card">
        <div class="sf-hub-safe-label">${escapeHtml(label)}</div>
        <div class="sf-hub-safe-value">${escapeHtml(value)}</div>
      </div>
    `;
  }

  function replaceOldLoadingText(data) {
    const summary = data.summary || {};
    const replacements = [
      ['Loading source status', `Hub ${data.version} · ${data.health?.overall || 'unknown'} · alerts ${(data.alerts || []).length}`],
      ['Last loaded:', 'Last loaded: ' + new Date().toLocaleTimeString()]
    ];

    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (el.children.length) continue;

      const value = safeText(el.textContent).trim();

      if (value === 'Loading') el.textContent = 'Loaded';
      if (value === 'Unavailable') el.textContent = 'Available';

      for (const [find, replace] of replacements) {
        if (value.includes(find)) el.textContent = replace;
      }
    }

    // Expose values for manual console verification.
    console.log('[Hub UI Rendered]', {
      ui_version: VERSION,
      api_version: data.version,
      cash_now: summary.cash_now,
      salary_amount: summary.salary_amount,
      forecast_projected_end: summary.forecast_projected_end,
      alerts: data.alerts
    });
  }

  function renderError(err) {
    ensureStyles();

    const panel = findMountPoint();
    panel.innerHTML = `
      <div class="sf-hub-safe-error">
        Hub UI failed: ${escapeHtml(err.message || String(err))}
      </div>
    `;

    console.error('[Hub UI Error]', err);
  }

  async function load() {
    if (!isHubPage()) return;

    try {
      const data = await fetchHub();
      renderPanel(data);
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
    document.addEventListener('DOMContentLoaded', load, { once: true });
  } else {
    load();
  }
})();
