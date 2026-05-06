/* ─── Sovereign Finance · nav.js v1.0.4 · Layer 5D mobile bottom nav guard ─── */
/*
 * Purpose:
 *   One navigation source for the whole app.
 *
 * Layer 5B:
 *   - ATM is a real module and globally visible in desktop/sidebar navigation.
 *   - Bottom nav remains focused on daily core tools:
 *       Hub, Add, Transactions, Bills, CC
 *
 * Layer 5D v1.0.4:
 *   - Bottom nav is forced fixed at the bottom on mobile.
 *   - Body gets mobile safe-area padding so content is not hidden behind nav.
 *   - Guard is injected by nav.js so pages with stale CSS still behave correctly.
 *   - No ledger/API writes.
 *
 * Contract:
 *   - Replaces existing .desktop-nav and .bottom-nav if present.
 *   - Injects nav if a page forgot it.
 *   - Active state is based on current pathname.
 */

(function () {
  'use strict';

  const VERSION = 'v1.0.4';
  const STYLE_ID = 'sov-nav-mobile-guard';

  const NAV_ITEMS = [
    { key: 'hub', label: 'Hub', short: 'Hub', href: '/', aliases: ['/index.html'], emoji: '🏠' },
    { key: 'add', label: 'Add Transaction', short: 'Add', href: '/add.html', aliases: [], emoji: '➕' },
    { key: 'transactions', label: 'Transactions', short: 'Tx', href: '/transactions.html', aliases: [], emoji: '📜' },
    { key: 'atm', label: 'ATM', short: 'ATM', href: '/atm.html', aliases: [], emoji: '🏧' },
    { key: 'accounts', label: 'Accounts', short: 'Accts', href: '/accounts.html', aliases: [], emoji: '🏦' },
    { key: 'cc', label: 'CC Planner', short: 'CC', href: '/cc.html', aliases: [], emoji: '🪪' },
    { key: 'debts', label: 'Debts', short: 'Debts', href: '/debts.html', aliases: [], emoji: '💳' },
    { key: 'bills', label: 'Bills', short: 'Bills', href: '/bills.html', aliases: [], emoji: '📅' },
    { key: 'goals', label: 'Goals', short: 'Goals', href: '/goals.html', aliases: [], emoji: '🎯' },
    { key: 'salary', label: 'Salary', short: 'Salary', href: '/salary.html', aliases: [], emoji: '💰' },
    { key: 'insights', label: 'Insights', short: 'Insights', href: '/insights.html', aliases: [], emoji: '🧠' },
    { key: 'charts', label: 'Charts', short: 'Charts', href: '/charts.html', aliases: [], emoji: '📊' },
    { key: 'reconciliation', label: 'Reconciliation', short: 'Recon', href: '/reconciliation.html', aliases: [], emoji: '⚖️' },
    { key: 'audit', label: 'Audit Log', short: 'Audit', href: '/audit.html', aliases: [], emoji: '🛡️' },
    { key: 'snapshots', label: 'Snapshots', short: 'Snaps', href: '/snapshots.html', aliases: [], emoji: '📸' }
  ];

  const BOTTOM_KEYS = ['hub', 'add', 'transactions', 'bills', 'cc'];

  function normalizePath(pathname) {
    let path = pathname || '/';

    if (!path.startsWith('/')) path = '/' + path;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    return path;
  }

  function currentPath() {
    return normalizePath(window.location.pathname || '/');
  }

  function isActive(item, path) {
    if (normalizePath(item.href) === path) return true;

    return (item.aliases || []).some(alias => normalizePath(alias) === path);
  }

  function navItemHTML(item, path, mode) {
    const active = isActive(item, path) ? ' active' : '';
    const label = mode === 'bottom' ? item.short : item.label;
    const cls = mode === 'bottom' ? 'nav-item' : 'desktop-nav-item';

    return `
      <a href="${item.href}" class="${cls}${active}" data-nav-key="${item.key}">
        <span class="nav-emoji">${item.emoji}</span>
        <span class="nav-text">${label}</span>
      </a>
    `;
  }

  function desktopHTML(path) {
    return `
      <aside class="desktop-nav" aria-label="Desktop navigation" data-nav-version="${VERSION}">
        ${NAV_ITEMS.map(item => navItemHTML(item, path, 'desktop')).join('')}
      </aside>
    `;
  }

  function bottomHTML(path) {
    const items = NAV_ITEMS.filter(item => BOTTOM_KEYS.includes(item.key));

    return `
      <nav class="bottom-nav" aria-label="Bottom navigation" data-nav-version="${VERSION}">
        <div class="bottom-nav-inner">
          ${items.map(item => navItemHTML(item, path, 'bottom')).join('')}
        </div>
      </nav>
    `;
  }

  function injectMobileBottomNavGuard() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @media (max-width: 860px) {
        html {
          min-height: 100%;
        }

        body {
          min-height: 100%;
          padding-bottom: calc(86px + env(safe-area-inset-bottom)) !important;
        }

        .bottom-nav {
          position: fixed !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          z-index: 2400 !important;
          display: block !important;
          width: 100% !important;
          padding: 8px 10px calc(8px + env(safe-area-inset-bottom)) !important;
          margin: 0 !important;
          background: rgba(255, 255, 255, 0.94) !important;
          border-top: 1px solid rgba(148, 163, 184, 0.35) !important;
          box-shadow: 0 -14px 32px rgba(15, 23, 42, 0.14) !important;
          backdrop-filter: blur(16px) !important;
          -webkit-backdrop-filter: blur(16px) !important;
        }

        .bottom-nav-inner {
          display: grid !important;
          grid-template-columns: repeat(5, minmax(0, 1fr)) !important;
          gap: 6px !important;
          width: min(560px, 100%) !important;
          margin: 0 auto !important;
          padding: 0 !important;
        }

        .bottom-nav .nav-item {
          min-width: 0 !important;
          min-height: 52px !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 3px !important;
          border-radius: 16px !important;
          color: var(--text-muted, #64748b) !important;
          text-decoration: none !important;
          font-size: 11px !important;
          font-weight: 900 !important;
          line-height: 1.05 !important;
          -webkit-tap-highlight-color: transparent !important;
        }

        .bottom-nav .nav-item.active {
          color: var(--accent-deep, #047857) !important;
          background: var(--accent-soft, rgba(16, 185, 129, 0.12)) !important;
        }

        .bottom-nav .nav-emoji {
          display: block !important;
          font-size: 18px !important;
          line-height: 1 !important;
          height: 20px !important;
        }

        .bottom-nav .nav-text {
          display: block !important;
          max-width: 100% !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }
      }

      @media (min-width: 861px) {
        .bottom-nav {
          display: none !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function replaceDesktopNav(path) {
    document.querySelectorAll('.desktop-nav').forEach(node => node.remove());

    const header = document.querySelector('header');
    const html = desktopHTML(path);

    if (header) {
      header.insertAdjacentHTML('afterend', html);
      return;
    }

    document.body.insertAdjacentHTML('afterbegin', html);
  }

  function replaceBottomNav(path) {
    document.querySelectorAll('.bottom-nav').forEach(node => node.remove());
    document.body.insertAdjacentHTML('beforeend', bottomHTML(path));
  }

  function setHeaderTitle(path) {
    const titleEl = document.querySelector('header .title');
    if (!titleEl) return;

    const active = NAV_ITEMS.find(item => isActive(item, path));
    if (!active) return;

    titleEl.textContent = active.label;
  }

  function markBodyPage(path) {
    const active = NAV_ITEMS.find(item => isActive(item, path));

    if (active) {
      document.documentElement.setAttribute('data-page', active.key);
      document.body.setAttribute('data-page', active.key);
    }
  }

  function initNav() {
    const path = currentPath();

    injectMobileBottomNavGuard();
    replaceDesktopNav(path);
    replaceBottomNav(path);
    setHeaderTitle(path);
    markBodyPage(path);

    window.SOV_NAV = {
      version: VERSION,
      items: NAV_ITEMS.slice(),
      bottomKeys: BOTTOM_KEYS.slice(),
      activePath: path,
      mobileGuard: STYLE_ID
    };

    console.log('[nav ' + VERSION + '] loaded', path);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
