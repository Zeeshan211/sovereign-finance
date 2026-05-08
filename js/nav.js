/* Sovereign Finance shared navigation v1.0.19
 * Emoji navigation restore
 * No data mutation. No API writes. No ledger interaction.
 */

(function () {
  'use strict';

  const NAV_VERSION = '1.0.19';

  const PRIMARY_LINKS = [
    { key: 'hub', label: 'Hub', href: '/index.html', icon: '🏠', group: 'core' },
    { key: 'forecast', label: 'Forecast', href: '/forecast.html', icon: '🔮', group: 'brain' },
    { key: 'insights', label: 'Insights', href: '/insights.html', icon: '💡', group: 'brain' },
    { key: 'monthly-close', label: 'Monthly Close', href: '/monthly-close.html', icon: '✅', group: 'brain' },
    { key: 'add', label: 'Add', href: '/add.html', icon: '➕', group: 'core' },
    { key: 'transactions', label: 'Transactions', href: '/transactions.html', icon: '📒', group: 'core' },
    { key: 'accounts', label: 'Accounts', href: '/accounts.html', icon: '🏦', group: 'truth' },
    { key: 'reconciliation', label: 'Reconciliation', href: '/reconciliation.html', icon: '⚖️', group: 'truth' },
    { key: 'bills', label: 'Bills', href: '/bills.html', icon: '🧾', group: 'obligations' },
    { key: 'cc', label: 'Credit Card', href: '/cc.html', icon: '💳', group: 'obligations' },
    { key: 'debts', label: 'Debts', href: '/debts.html', icon: '🪨', group: 'obligations' },
    { key: 'salary', label: 'Salary', href: '/salary.html', icon: '💼', group: 'income' },
    { key: 'atm', label: 'ATM', href: '/atm.html', icon: '🏧', group: 'tools' },
    { key: 'nano-loans', label: 'Nano Loans', href: '/nano-loans.html', icon: '🧩', group: 'tools' },
    { key: 'snapshots', label: 'Snapshots', href: '/snapshots.html', icon: '📸', group: 'audit' },
    { key: 'audit', label: 'Audit', href: '/audit.html', icon: '🛡️', group: 'audit' },
    { key: 'charts', label: 'Charts', href: '/charts.html', icon: '📊', group: 'analysis' },
    { key: 'budgets', label: 'Budgets', href: '/budgets.html', icon: '🎯', group: 'planning' },
    { key: 'goals', label: 'Goals', href: '/goals.html', icon: '🏁', group: 'planning' }
  ];

  const MOBILE_LINKS = [
    { key: 'hub', label: 'Hub', href: '/index.html', icon: '🏠' },
    { key: 'add', label: 'Add', href: '/add.html', icon: '➕' },
    { key: 'transactions', label: 'Ledger', href: '/transactions.html', icon: '📒' },
    { key: 'forecast', label: 'Forecast', href: '/forecast.html', icon: '🔮' },
    { key: 'cc', label: 'Card', href: '/cc.html', icon: '💳' }
  ];

  const GROUP_LABELS = {
    core: '⚡ Daily Core',
    brain: '🧠 Finance Brain',
    truth: '🏦 Truth + Accounts',
    obligations: '🔥 Obligations',
    income: '💼 Income',
    tools: '🛠️ Tools',
    audit: '🛡️ Audit',
    analysis: '📊 Analysis',
    planning: '🎯 Planning'
  };

  function normalizePath(pathname) {
    let p = String(pathname || '/').split('?')[0].split('#')[0];
    if (p === '/' || p === '') return '/index.html';
    if (!p.endsWith('.html') && !p.includes('/api/')) p = p.replace(/\/$/, '') + '.html';
    return p;
  }

  function currentKey() {
    const p = normalizePath(window.location.pathname);
    const found = PRIMARY_LINKS.find(link => normalizePath(link.href) === p);
    if (found) return found.key;
    return 'hub';
  }

  function isCurrent(link) {
    return link.key === currentKey();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function groupedLinks() {
    const groups = [];
    for (const link of PRIMARY_LINKS) {
      let group = groups.find(item => item.key === link.group);
      if (!group) {
        group = { key: link.group, label: GROUP_LABELS[link.group] || link.group, links: [] };
        groups.push(group);
      }
      group.links.push(link);
    }
    return groups;
  }

  function navItem(link, mode) {
    const active = isCurrent(link);
    const cls = [
      mode === 'mobile' ? 'sf-mobile-nav-item' : 'sf-nav-item',
      active ? 'active' : ''
    ].filter(Boolean).join(' ');

    return `
      <a class="${cls}" href="${escapeHtml(link.href)}" data-nav-key="${escapeHtml(link.key)}" aria-current="${active ? 'page' : 'false'}">
        <span class="${mode === 'mobile' ? 'sf-mobile-nav-icon' : 'sf-nav-icon'}">${escapeHtml(link.icon)}</span>
        <span class="${mode === 'mobile' ? 'sf-mobile-nav-label' : 'sf-nav-label'}">${escapeHtml(link.label)}</span>
      </a>
    `;
  }

  function desktopNavHtml() {
    return `
      <aside class="sf-shell-nav" data-nav-version="${NAV_VERSION}">
        <div class="sf-shell-nav-inner">
          <a class="sf-shell-brand" href="/index.html">
            <span class="sf-shell-brand-mark">💰</span>
            <span>
              <strong>Sovereign</strong>
              <small>Finance Core</small>
            </span>
          </a>

          <div class="sf-nav-groups">
            ${groupedLinks().map(group => `
              <section class="sf-nav-group" data-group="${escapeHtml(group.key)}">
                <div class="sf-nav-group-title">${escapeHtml(group.label)}</div>
                <div class="sf-nav-group-links">
                  ${group.links.map(link => navItem(link, 'desktop')).join('')}
                </div>
              </section>
            `).join('')}
          </div>

          <div class="sf-nav-footer">
            <span>nav v${NAV_VERSION}</span>
            <span>✨ alive</span>
          </div>
        </div>
      </aside>
    `;
  }

  function mobileNavHtml() {
    return `
      <nav class="sf-mobile-nav" aria-label="Mobile navigation" data-nav-version="${NAV_VERSION}">
        ${MOBILE_LINKS.map(link => navItem(link, 'mobile')).join('')}
      </nav>
    `;
  }

  function addStyles() {
    if (document.getElementById('sf-nav-style')) return;

    const style = document.createElement('style');
    style.id = 'sf-nav-style';
    style.textContent = `
      :root {
        --sf-nav-width: 266px;
        --sf-mobile-nav-height: 78px;
      }

      body { min-height: 100vh; }

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
        background: rgba(255,255,255,.94);
        border: 1px solid rgba(148,163,184,.28);
        border-radius: 26px;
        box-shadow: 0 24px 70px rgba(15,23,42,.15);
        backdrop-filter: blur(20px);
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
        color: #0f172a;
        text-decoration: none;
      }

      .sf-shell-brand-mark {
        width: 42px;
        height: 42px;
        border-radius: 16px;
        display: grid;
        place-items: center;
        background: linear-gradient(135deg, #bbf7d0, #93c5fd);
        font-size: 21px;
        box-shadow: 0 12px 30px rgba(15,23,42,.12);
      }

      .sf-shell-brand strong {
        display: block;
        font-size: 15px;
        font-weight: 950;
        line-height: 1.1;
      }

      .sf-shell-brand small {
        display: block;
        margin-top: 2px;
        color: #64748b;
        font-size: 11px;
        font-weight: 850;
      }

      .sf-nav-groups {
        flex: 1;
        overflow: auto;
        padding: 4px 10px 10px;
      }

      .sf-nav-group { margin: 10px 0 14px; }

      .sf-nav-group-title {
        margin: 0 8px 7px;
        color: #64748b;
        font-size: 10px;
        font-weight: 950;
        text-transform: uppercase;
        letter-spacing: .07em;
      }

      .sf-nav-group-links {
        display: grid;
        gap: 5px;
      }

      .sf-nav-item {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 42px;
        padding: 9px 10px;
        border-radius: 15px;
        color: #475569;
        text-decoration: none;
        font-size: 13px;
        font-weight: 900;
        border: 1px solid transparent;
        transition: all .18s ease;
      }

      .sf-nav-item:hover {
        background: #f8fafc;
        color: #0f172a;
        transform: translateX(2px);
      }

      .sf-nav-item.active {
        background: linear-gradient(135deg, rgba(34,197,94,.16), rgba(37,99,235,.10));
        border-color: rgba(34,197,94,.25);
        color: #0f172a;
      }

      .sf-nav-icon {
        width: 29px;
        height: 29px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        background: #fff;
        border: 1px solid rgba(148,163,184,.28);
        font-size: 16px;
        flex: 0 0 auto;
      }

      .sf-nav-item.active .sf-nav-icon {
        background: #dcfce7;
        border-color: rgba(34,197,94,.30);
      }

      .sf-nav-label {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .sf-nav-footer {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px 14px;
        color: #64748b;
        font-size: 10px;
        font-weight: 850;
        border-top: 1px solid rgba(148,163,184,.22);
      }

      .sf-mobile-nav {
        position: fixed;
        left: 10px;
        right: 10px;
        bottom: 10px;
        z-index: 1300;
        min-height: var(--sf-mobile-nav-height);
        display: none;
        grid-template-columns: repeat(5, minmax(0,1fr));
        gap: 6px;
        padding: 8px;
        border-radius: 24px;
        background: rgba(255,255,255,.95);
        border: 1px solid rgba(148,163,184,.28);
        box-shadow: 0 18px 44px rgba(15,23,42,.16);
        backdrop-filter: blur(18px);
      }

      .sf-mobile-nav-item {
        min-width: 0;
        display: grid;
        place-items: center;
        gap: 4px;
        padding: 7px 4px;
        border-radius: 16px;
        color: #475569;
        text-decoration: none;
        font-size: 10px;
        font-weight: 950;
        border: 1px solid transparent;
      }

      .sf-mobile-nav-item.active {
        background: rgba(34,197,94,.13);
        border-color: rgba(34,197,94,.22);
        color: #0f172a;
      }

      .sf-mobile-nav-icon {
        width: 26px;
        height: 26px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        background: #fff;
        border: 1px solid rgba(148,163,184,.28);
        font-size: 15px;
      }

      .sf-mobile-nav-label {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        max-width: 100%;
      }

      body.sf-nav-ready { padding-left: calc(var(--sf-nav-width) + 18px); }

      @media (max-width: 980px) {
        .sf-shell-nav { display: none; }
        .sf-mobile-nav { display: grid; }
        body.sf-nav-ready {
          padding-left: 0;
          padding-bottom: calc(var(--sf-mobile-nav-height) + 24px);
        }
        main { padding-bottom: calc(var(--sf-mobile-nav-height) + 16px); }
      }

      @media print {
        .sf-shell-nav,
        .sf-mobile-nav { display: none !important; }
        body.sf-nav-ready {
          padding-left: 0 !important;
          padding-bottom: 0 !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function removeExistingNav() {
    document.querySelectorAll('.sf-shell-nav, .sf-mobile-nav').forEach(node => node.remove());
  }

  function mount() {
    if (!document.body) return;
    addStyles();
    removeExistingNav();
    document.body.insertAdjacentHTML('afterbegin', desktopNavHtml());
    document.body.insertAdjacentHTML('beforeend', mobileNavHtml());
    document.body.classList.add('sf-nav-ready');
    document.documentElement.dataset.navVersion = NAV_VERSION;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.SovereignNav = {
    version: NAV_VERSION,
    links: PRIMARY_LINKS.slice(),
    mobileLinks: MOBILE_LINKS.slice(),
    currentKey
  };
})();
