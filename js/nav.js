/* Sovereign Finance shared navigation v1.1.2
 * Smart Layout Guard
 *
 * Contract:
 * - Pure frontend navigation helper.
 * - No data mutation.
 * - No API writes.
 * - No ledger interaction.
 * - Keeps existing page routes.
 * - Fixes stuck More drawer.
 * - Adds global layout guard so fixed sidebar does not cut pages.
 * - Adds reusable smart layout utilities for all pages.
 */

(function () {
  'use strict';

  const NAV_VERSION = '1.1.2';

  const LINKS = [
    { key: 'hub', label: 'Hub', href: '/index.html', icon: '🏠', group: 'dashboard', daily: true },
    { key: 'forecast', label: 'Forecast', href: '/forecast.html', icon: '🔮', group: 'dashboard', daily: true },
    { key: 'insights', label: 'Insights', href: '/insights.html', icon: '💡', group: 'dashboard' },
    { key: 'charts', label: 'Charts', href: '/charts.html', icon: '📊', group: 'dashboard' },

    { key: 'add', label: 'Add Transaction', shortLabel: 'Add', href: '/add.html', icon: '➕', group: 'money', daily: true },
    { key: 'transactions', label: 'Transactions', shortLabel: 'Txns', href: '/transactions.html', icon: '🧾', group: 'money', daily: true },
    { key: 'accounts', label: 'Accounts', href: '/accounts.html', icon: '🏦', group: 'money' },
    { key: 'reconciliation', label: 'Reconciliation', shortLabel: 'Recon', href: '/reconciliation.html', icon: '⚖️', group: 'money' },

    { key: 'bills', label: 'Bills', href: '/bills.html', icon: '📅', group: 'obligations', daily: true },
    { key: 'debts', label: 'Debts', href: '/debts.html', icon: '🧱', group: 'obligations' },
    { key: 'cc', label: 'Credit Card', href: '/cc.html', icon: '💳', group: 'obligations' },
    { key: 'atm', label: 'ATM Fees', shortLabel: 'ATM', href: '/atm.html', icon: '🏧', group: 'obligations' },
    { key: 'nano-loans', label: 'Nano Loans', href: '/nano-loans.html', icon: '⚡', group: 'obligations' },

    { key: 'salary', label: 'Salary', href: '/salary.html', icon: '💼', group: 'planning' },
    { key: 'monthly-close', label: 'Monthly Close', shortLabel: 'Close', href: '/monthly-close.html', icon: '✅', group: 'planning' },
    { key: 'budgets', label: 'Budgets', href: '/budgets.html', icon: '🎯', group: 'planning' },
    { key: 'goals', label: 'Goals', href: '/goals.html', icon: '🏁', group: 'planning' },

    { key: 'snapshots', label: 'Snapshots', href: '/snapshots.html', icon: '📸', group: 'records' },
    { key: 'audit', label: 'Audit Log', shortLabel: 'Audit', href: '/audit.html', icon: '🛡️', group: 'records' }
  ];

  const SECTIONS = [
    { key: 'dashboard', label: 'Dashboard', hint: 'Status, safety, insight', icon: '◈', keys: ['hub', 'forecast', 'insights', 'charts'] },
    { key: 'money', label: 'Money', hint: 'Entry, ledger, accounts', icon: '◍', keys: ['add', 'transactions', 'accounts', 'reconciliation'] },
    { key: 'obligations', label: 'Obligations', hint: 'Bills, debts, card', icon: '◇', keys: ['bills', 'debts', 'cc', 'atm', 'nano-loans'] },
    { key: 'planning', label: 'Planning', hint: 'Salary, close, goals', icon: '□', keys: ['salary', 'monthly-close', 'budgets', 'goals'] },
    { key: 'records', label: 'Records', hint: 'Rollback and audit', icon: '△', keys: ['snapshots', 'audit'] }
  ];

  const MOBILE_LINKS = ['hub', 'add', 'transactions', 'bills', 'forecast'];

  function byKey(key) {
    return LINKS.find(link => link.key === key) || null;
  }

  function normalizePath(pathname) {
    let p = String(pathname || '/').split('?')[0].split('#')[0];

    if (p === '/' || p === '') return '/index.html';
    if (!p.endsWith('.html') && !p.includes('/api/')) p = p.replace(/\/$/, '') + '.html';

    return p;
  }

  function currentKey() {
    const p = normalizePath(window.location.pathname);

    const direct = LINKS.find(link => normalizePath(link.href) === p);
    if (direct) return direct.key;

    if (p.includes('monthly-close')) return 'monthly-close';
    if (p.includes('nano-loans')) return 'nano-loans';
    if (p.includes('reconciliation')) return 'reconciliation';
    if (p.includes('transactions')) return 'transactions';
    if (p.includes('forecast')) return 'forecast';
    if (p.includes('insights')) return 'insights';
    if (p.includes('charts')) return 'charts';
    if (p.includes('salary')) return 'salary';
    if (p.includes('bills')) return 'bills';
    if (p.includes('debts')) return 'debts';
    if (p.includes('cc')) return 'cc';
    if (p.includes('atm')) return 'atm';
    if (p.includes('audit')) return 'audit';
    if (p.includes('snapshots')) return 'snapshots';
    if (p.includes('accounts')) return 'accounts';
    if (p.includes('add')) return 'add';

    return 'hub';
  }

  function currentSectionKey() {
    const key = currentKey();
    const link = byKey(key);
    return link ? link.group : 'dashboard';
  }

  function isCurrent(link) {
    return link && link.key === currentKey();
  }

  function isMobileDailyKey(key) {
    return MOBILE_LINKS.includes(key);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sectionLinks(section) {
    return section.keys.map(byKey).filter(Boolean);
  }

  function navItem(link, mode) {
    const active = isCurrent(link);
    const label = mode === 'mobile' ? (link.shortLabel || link.label) : link.label;

    const cls = [
      mode === 'mobile' ? 'sf-mobile-nav-item' : 'sf-nav-item',
      active ? 'active' : ''
    ].filter(Boolean).join(' ');

    return `
      <a class="${cls}" href="${escapeHtml(link.href)}" data-nav-key="${escapeHtml(link.key)}" aria-current="${active ? 'page' : 'false'}">
        <span class="${mode === 'mobile' ? 'sf-mobile-nav-icon' : 'sf-nav-icon'}">${escapeHtml(link.icon)}</span>
        <span class="${mode === 'mobile' ? 'sf-mobile-nav-label' : 'sf-nav-label'}">${escapeHtml(label)}</span>
      </a>
    `;
  }

  function compactActionHtml() {
    const actions = ['hub', 'add', 'transactions', 'forecast'].map(byKey).filter(Boolean);

    return `
      <div class="sf-quick-actions" aria-label="Quick actions">
        ${actions.map(link => `
          <a class="sf-quick-action ${isCurrent(link) ? 'active' : ''}" href="${escapeHtml(link.href)}">
            <span>${escapeHtml(link.icon)}</span>
            <strong>${escapeHtml(link.shortLabel || link.label)}</strong>
          </a>
        `).join('')}
      </div>
    `;
  }

  function desktopSectionHtml(section) {
    const activeSection = section.key === currentSectionKey();
    const openAttr = activeSection || section.key === 'dashboard' ? 'open' : '';

    return `
      <details class="sf-nav-section ${activeSection ? 'active-section' : ''}" data-section="${escapeHtml(section.key)}" ${openAttr}>
        <summary class="sf-nav-section-summary">
          <span class="sf-nav-section-mark">${escapeHtml(section.icon)}</span>
          <span class="sf-nav-section-text">
            <strong>${escapeHtml(section.label)}</strong>
            <small>${escapeHtml(section.hint)}</small>
          </span>
          <span class="sf-nav-section-chevron">⌄</span>
        </summary>
        <div class="sf-nav-section-links">
          ${sectionLinks(section).map(link => navItem(link, 'desktop')).join('')}
        </div>
      </details>
    `;
  }

  function desktopNavHtml() {
    return `
      <aside class="sf-shell-nav" data-nav-version="${NAV_VERSION}" aria-label="Finance navigation">
        <div class="sf-shell-nav-inner">
          <a class="sf-shell-brand" href="/index.html">
            <span class="sf-shell-brand-mark">SF</span>
            <span>
              <strong>Sovereign Finance</strong>
              <small>Clean command shell</small>
            </span>
          </a>

          ${compactActionHtml()}

          <div class="sf-nav-sections">
            ${SECTIONS.map(desktopSectionHtml).join('')}
          </div>

          <div class="sf-nav-footer">
            <span>nav v${NAV_VERSION}</span>
            <span>Smart layout</span>
          </div>
        </div>
      </aside>
    `;
  }

  function mobileNavHtml() {
    const daily = MOBILE_LINKS.map(byKey).filter(Boolean);
    const moreActive = !isMobileDailyKey(currentKey());

    return `
      <nav class="sf-mobile-nav" aria-label="Mobile navigation" data-nav-version="${NAV_VERSION}">
        ${daily.map(link => navItem(link, 'mobile')).join('')}
        <button class="sf-mobile-nav-item sf-more-trigger ${moreActive ? 'active' : ''}" type="button" aria-expanded="false" aria-controls="sf-more-drawer">
          <span class="sf-mobile-nav-icon">☰</span>
          <span class="sf-mobile-nav-label">More</span>
        </button>
      </nav>

      <div class="sf-more-backdrop" data-close-more hidden></div>

      <aside class="sf-more-drawer" id="sf-more-drawer" aria-label="More Finance tools" hidden>
        <div class="sf-more-drawer-head">
          <div>
            <strong>Finance tools</strong>
            <small>Grouped by job</small>
          </div>
          <button class="sf-more-close" type="button" data-close-more aria-label="Close menu">×</button>
        </div>

        <div class="sf-more-drawer-body">
          ${SECTIONS.map(section => `
            <section class="sf-more-section">
              <div class="sf-more-section-title">
                <span>${escapeHtml(section.icon)}</span>
                <strong>${escapeHtml(section.label)}</strong>
              </div>
              <div class="sf-more-grid">
                ${sectionLinks(section).map(link => `
                  <a class="sf-more-link ${isCurrent(link) ? 'active' : ''}" href="${escapeHtml(link.href)}">
                    <span>${escapeHtml(link.icon)}</span>
                    <strong>${escapeHtml(link.shortLabel || link.label)}</strong>
                  </a>
                `).join('')}
              </div>
            </section>
          `).join('')}
        </div>
      </aside>
    `;
  }

  function addStyles() {
    if (document.getElementById('sf-nav-style')) return;

    const style = document.createElement('style');
    style.id = 'sf-nav-style';
    style.textContent = `
      :root {
        --sf-nav-width: 286px;
        --sf-nav-gap: 18px;
        --sf-nav-offset: calc(var(--sf-nav-width) + var(--sf-nav-gap));
        --sf-mobile-nav-height: 78px;
        --sf-content-max: 1440px;
        --sf-page-pad: 16px;
        --sf-nav-bg: rgba(255, 255, 255, 0.92);
        --sf-nav-bg-strong: rgba(255, 255, 255, 0.98);
        --sf-nav-border: var(--border, rgba(148, 163, 184, 0.28));
        --sf-nav-text: var(--text, #0f172a);
        --sf-nav-muted: var(--text-muted, #475569);
        --sf-nav-dim: var(--text-dim, #64748b);
      }

      html,
      body {
        max-width: 100%;
        overflow-x: hidden;
      }

      *,
      *::before,
      *::after {
        min-width: 0;
      }

      img,
      svg,
      canvas,
      video {
        max-width: 100%;
      }

      .sf-shell-nav {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 1200;
        width: var(--sf-nav-width);
        padding: 14px;
        pointer-events: none;
      }

      .sf-shell-nav-inner {
        height: 100%;
        background: var(--sf-nav-bg);
        border: 1px solid var(--sf-nav-border);
        border-radius: 26px;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.13);
        backdrop-filter: blur(18px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        pointer-events: auto;
      }

      .sf-shell-brand {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 16px 14px 12px;
        color: var(--sf-nav-text);
        text-decoration: none;
      }

      .sf-shell-brand-mark {
        width: 42px;
        height: 42px;
        border-radius: 16px;
        display: grid;
        place-items: center;
        background: linear-gradient(135deg, #dcfce7, #93c5fd);
        color: #052e16;
        font-size: 12px;
        font-weight: 950;
        letter-spacing: -0.04em;
        flex: 0 0 auto;
      }

      .sf-shell-brand strong {
        display: block;
        font-size: 15px;
        font-weight: 950;
        line-height: 1.1;
        letter-spacing: -0.03em;
      }

      .sf-shell-brand small {
        display: block;
        margin-top: 3px;
        color: var(--sf-nav-dim);
        font-size: 11px;
        font-weight: 850;
      }

      .sf-quick-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        padding: 6px 12px 12px;
      }

      .sf-quick-action {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 9px;
        border-radius: 16px;
        color: var(--sf-nav-muted);
        background: rgba(248, 250, 252, 0.78);
        border: 1px solid rgba(148, 163, 184, 0.22);
        text-decoration: none;
      }

      .sf-quick-action span {
        width: 24px;
        height: 24px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: #fff;
        font-size: 13px;
        flex: 0 0 auto;
      }

      .sf-quick-action strong {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 12px;
        font-weight: 950;
      }

      .sf-quick-action:hover,
      .sf-quick-action.active {
        color: var(--sf-nav-text);
        background: linear-gradient(135deg, rgba(34, 197, 94, 0.13), rgba(37, 99, 235, 0.08));
        border-color: rgba(34, 197, 94, 0.26);
      }

      .sf-nav-sections {
        flex: 1;
        overflow: auto;
        padding: 2px 10px 10px;
      }

      .sf-nav-section {
        margin: 8px 0;
        border-radius: 18px;
        border: 1px solid transparent;
      }

      .sf-nav-section[open],
      .sf-nav-section.active-section {
        background: rgba(248, 250, 252, 0.72);
        border-color: rgba(148, 163, 184, 0.18);
      }

      .sf-nav-section-summary {
        list-style: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px;
        border-radius: 18px;
        color: var(--sf-nav-muted);
        user-select: none;
      }

      .sf-nav-section-summary::-webkit-details-marker {
        display: none;
      }

      .sf-nav-section-summary:hover {
        color: var(--sf-nav-text);
        background: rgba(255, 255, 255, 0.66);
      }

      .sf-nav-section-mark {
        width: 28px;
        height: 28px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        background: #ffffff;
        border: 1px solid rgba(148, 163, 184, 0.24);
        font-size: 12px;
        font-weight: 950;
        color: #166534;
        flex: 0 0 auto;
      }

      .sf-nav-section-text {
        flex: 1;
      }

      .sf-nav-section-text strong {
        display: block;
        color: var(--sf-nav-text);
        font-size: 12px;
        font-weight: 950;
        letter-spacing: -0.01em;
      }

      .sf-nav-section-text small {
        display: block;
        margin-top: 2px;
        overflow: hidden;
        color: var(--sf-nav-dim);
        font-size: 10px;
        font-weight: 800;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .sf-nav-section-chevron {
        color: var(--sf-nav-dim);
        font-size: 13px;
        font-weight: 950;
        transition: transform 160ms ease;
      }

      .sf-nav-section[open] .sf-nav-section-chevron {
        transform: rotate(180deg);
      }

      .sf-nav-section-links {
        display: grid;
        gap: 5px;
        padding: 0 8px 10px 44px;
      }

      .sf-nav-item {
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 38px;
        padding: 8px 9px;
        border-radius: 14px;
        color: var(--sf-nav-muted);
        text-decoration: none;
        font-size: 12px;
        font-weight: 900;
        border: 1px solid transparent;
      }

      .sf-nav-item:hover {
        background: rgba(255, 255, 255, 0.82);
        color: var(--sf-nav-text);
      }

      .sf-nav-item.active {
        background: linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(37, 99, 235, 0.08));
        border-color: rgba(34, 197, 94, 0.24);
        color: var(--sf-nav-text);
      }

      .sf-nav-icon {
        width: 25px;
        height: 25px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: #ffffff;
        border: 1px solid rgba(148, 163, 184, 0.24);
        font-size: 12px;
        flex: 0 0 auto;
      }

      .sf-nav-label {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .sf-nav-footer {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px 14px;
        color: var(--sf-nav-dim);
        font-size: 10px;
        font-weight: 850;
        border-top: 1px solid rgba(148, 163, 184, 0.20);
      }

      .sf-mobile-nav {
        position: fixed;
        left: 10px;
        right: 10px;
        bottom: 10px;
        z-index: 1300;
        min-height: var(--sf-mobile-nav-height);
        display: none;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 5px;
        padding: 8px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.95);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 18px 44px rgba(15, 23, 42, 0.17);
        backdrop-filter: blur(18px);
      }

      .sf-mobile-nav-item {
        display: grid;
        place-items: center;
        gap: 4px;
        padding: 7px 3px;
        border-radius: 16px;
        color: var(--sf-nav-muted);
        text-decoration: none;
        font-size: 10px;
        font-weight: 950;
        border: 1px solid transparent;
        background: transparent;
        font-family: inherit;
        cursor: pointer;
      }

      .sf-mobile-nav-item.active {
        background: rgba(34, 197, 94, 0.13);
        border-color: rgba(34, 197, 94, 0.22);
        color: var(--sf-nav-text);
      }

      .sf-mobile-nav-icon {
        width: 24px;
        height: 24px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: #ffffff;
        border: 1px solid rgba(148, 163, 184, 0.24);
        font-size: 12px;
      }

      .sf-mobile-nav-label {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        max-width: 100%;
      }

      .sf-more-backdrop[hidden],
      .sf-more-drawer[hidden] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      .sf-more-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1390;
        background: rgba(15, 23, 42, 0.32);
        backdrop-filter: blur(2px);
      }

      .sf-more-drawer {
        position: fixed;
        left: 10px;
        right: 10px;
        bottom: calc(var(--sf-mobile-nav-height) + 24px);
        z-index: 1400;
        max-height: min(68vh, 620px);
        display: flex;
        flex-direction: column;
        border-radius: 26px;
        background: var(--sf-nav-bg-strong);
        border: 1px solid rgba(148, 163, 184, 0.30);
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.24);
        overflow: hidden;
      }

      .sf-more-drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 15px 16px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.20);
      }

      .sf-more-drawer-head strong {
        display: block;
        color: var(--sf-nav-text);
        font-size: 14px;
        font-weight: 950;
      }

      .sf-more-drawer-head small {
        display: block;
        margin-top: 2px;
        color: var(--sf-nav-dim);
        font-size: 11px;
        font-weight: 850;
      }

      .sf-more-close {
        width: 36px;
        height: 36px;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: #fff;
        color: var(--sf-nav-text);
        font-size: 20px;
        font-weight: 900;
        cursor: pointer;
      }

      .sf-more-drawer-body {
        overflow: auto;
        padding: 12px;
      }

      .sf-more-section {
        margin: 0 0 14px;
      }

      .sf-more-section-title {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 8px;
        color: var(--sf-nav-dim);
        font-size: 11px;
        font-weight: 950;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .sf-more-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .sf-more-link {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 11px 10px;
        border-radius: 16px;
        color: var(--sf-nav-muted);
        background: rgba(248, 250, 252, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.20);
        text-decoration: none;
      }

      .sf-more-link.active {
        color: var(--sf-nav-text);
        background: rgba(34, 197, 94, 0.13);
        border-color: rgba(34, 197, 94, 0.24);
      }

      .sf-more-link strong {
        overflow: hidden;
        font-size: 12px;
        font-weight: 950;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      /*
       * Smart Layout Contract
       * This is the global guard that stops pages from cutting off when the
       * desktop sidebar exists.
       */

      body.sf-nav-ready {
        padding-left: 0 !important;
      }

      body.sf-nav-ready > main,
      body.sf-nav-ready .page,
      body.sf-nav-ready .app-page,
      body.sf-nav-ready .dashboard,
      body.sf-nav-ready .wrap,
      body.sf-nav-ready .container {
        min-width: 0 !important;
      }

      body.sf-nav-ready table {
        max-width: 100%;
      }

      body.sf-nav-ready .table-scroll,
      body.sf-nav-ready .table-wrap,
      body.sf-nav-ready .scroll-x,
      body.sf-nav-ready .overflow-x,
      body.sf-nav-ready [data-scroll-x] {
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .sf-smart-page,
      .app-page {
        width: 100%;
        max-width: var(--sf-content-max);
        margin-inline: auto;
        padding-inline: var(--sf-page-pad);
        min-width: 0;
      }

      .sf-smart-grid,
      .smart-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
        gap: var(--smart-gap, 16px);
        min-width: 0;
      }

      .sf-smart-card,
      .smart-card,
      .card,
      .panel {
        min-width: 0;
        max-width: 100%;
      }

      .sf-smart-table,
      .table-scroll {
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .sf-smart-table > table,
      .table-scroll > table {
        width: 100%;
      }

      @media (min-width: 981px) {
        .sf-mobile-nav,
        .sf-more-backdrop,
        .sf-more-drawer {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }

        body.sf-nav-ready > main,
        body.sf-nav-ready .page,
        body.sf-nav-ready .app-page {
          width: auto !important;
          max-width: min(var(--sf-content-max), calc(100vw - var(--sf-nav-offset) - 28px)) !important;
          margin-left: var(--sf-nav-offset) !important;
          margin-right: 18px !important;
        }

        body.sf-nav-ready > main {
          display: block;
        }
      }

      @media (max-width: 980px) {
        .sf-shell-nav {
          display: none;
        }

        .sf-mobile-nav {
          display: grid;
        }

        body.sf-nav-ready {
          padding-left: 0 !important;
          padding-bottom: calc(var(--sf-mobile-nav-height) + 24px);
        }

        body.sf-nav-ready > main,
        body.sf-nav-ready .page,
        body.sf-nav-ready .app-page {
          width: min(100%, calc(100vw - 20px)) !important;
          max-width: calc(100vw - 20px) !important;
          margin-left: auto !important;
          margin-right: auto !important;
        }

        main {
          padding-bottom: calc(var(--sf-mobile-nav-height) + 18px);
        }
      }

      @media (max-width: 390px) {
        .sf-mobile-nav {
          gap: 3px;
          padding: 7px;
        }

        .sf-mobile-nav-label {
          font-size: 9px;
        }

        .sf-more-grid {
          grid-template-columns: 1fr;
        }
      }

      @media print {
        .sf-shell-nav,
        .sf-mobile-nav,
        .sf-more-backdrop,
        .sf-more-drawer {
          display: none !important;
        }

        body.sf-nav-ready > main,
        body.sf-nav-ready .page,
        body.sf-nav-ready .app-page {
          width: 100% !important;
          max-width: none !important;
          margin-left: 0 !important;
          margin-right: 0 !important;
          padding-left: 0 !important;
          padding-right: 0 !important;
        }

        body.sf-nav-ready {
          padding-left: 0 !important;
          padding-bottom: 0 !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function removeExistingNav() {
    document.querySelectorAll('.sf-shell-nav, .sf-mobile-nav, .sf-more-backdrop, .sf-more-drawer').forEach(node => node.remove());
  }

  function openMoreDrawer() {
    const trigger = document.querySelector('.sf-more-trigger');
    const backdrop = document.querySelector('.sf-more-backdrop');
    const drawer = document.querySelector('.sf-more-drawer');

    if (!trigger || !backdrop || !drawer) return;

    backdrop.hidden = false;
    drawer.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sf-more-open');
  }

  function closeMoreDrawer() {
    const trigger = document.querySelector('.sf-more-trigger');
    const backdrop = document.querySelector('.sf-more-backdrop');
    const drawer = document.querySelector('.sf-more-drawer');

    if (backdrop) backdrop.hidden = true;
    if (drawer) drawer.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');

    document.body.classList.remove('sf-more-open');
  }

  function bindEvents() {
    const trigger = document.querySelector('.sf-more-trigger');

    if (trigger) {
      trigger.addEventListener('click', function () {
        const drawer = document.querySelector('.sf-more-drawer');
        if (drawer && !drawer.hidden) closeMoreDrawer();
        else openMoreDrawer();
      });
    }

    document.querySelectorAll('[data-close-more]').forEach(node => {
      node.addEventListener('click', closeMoreDrawer);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMoreDrawer();
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 980) closeMoreDrawer();
      scheduleOverflowCheck();
    });
  }

  function scheduleOverflowCheck() {
    window.clearTimeout(window.__sfOverflowTimer);
    window.__sfOverflowTimer = window.setTimeout(checkOverflow, 250);
  }

  function checkOverflow() {
    const body = document.body;
    const doc = document.documentElement;

    if (!body || !doc) return;

    const overflow = Math.max(body.scrollWidth, doc.scrollWidth) - window.innerWidth;

    document.documentElement.dataset.sfOverflow = overflow > 4 ? 'true' : 'false';

    if (overflow > 4) {
      console.warn('[SovereignNav v' + NAV_VERSION + '] horizontal overflow detected:', Math.round(overflow), 'px');
    }
  }

  function mount() {
    if (!document.body) return;

    addStyles();
    removeExistingNav();

    document.body.insertAdjacentHTML('afterbegin', desktopNavHtml());
    document.body.insertAdjacentHTML('beforeend', mobileNavHtml());
    document.body.classList.add('sf-nav-ready');
    document.documentElement.dataset.navVersion = NAV_VERSION;

    closeMoreDrawer();
    bindEvents();
    scheduleOverflowCheck();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.SovereignNav = {
    version: NAV_VERSION,
    links: LINKS.slice(),
    sections: SECTIONS.slice(),
    mobileLinks: MOBILE_LINKS.slice(),
    currentKey,
    currentSectionKey,
    openMoreDrawer,
    closeMoreDrawer,
    checkOverflow
  };
})();
