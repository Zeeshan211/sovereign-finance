/* ─── Sovereign Finance · nav.js v1.0.6 · Layered premium navigation rail ─── */
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
 *
 * Layer 5C v1.0.5:
 *   - Nano Loans is now a real module in global desktop/sidebar navigation.
 *   - Nano Loans is not added to mobile bottom nav; bottom nav remains daily-core only.
 *   - No ledger/API writes.
 *
 * Layer UI v1.0.6:
 *   - Desktop side rail becomes layered, grouped, premium, compact, and non-scrolling in normal desktop height.
 *   - Adds section layers: Daily Core, Money Control, Planning, Proof.
 *   - Adds active glow, rail header, compact item density, and soft animated depth.
 *   - Mobile bottom nav remains daily-core only.
 *   - No ledger/API writes.
 *
 * Contract:
 *   - Replaces existing .desktop-nav and .bottom-nav if present.
 *   - Injects nav if a page forgot it.
 *   - Active state is based on current pathname.
 */

(function () {
  'use strict';

  const VERSION = 'v1.0.6';
  const MOBILE_STYLE_ID = 'sov-nav-mobile-guard';
  const PREMIUM_STYLE_ID = 'sov-nav-premium-rail';

  const NAV_GROUPS = [
    { key: 'daily', label: 'Daily Core' },
    { key: 'money', label: 'Money Control' },
    { key: 'plan', label: 'Planning' },
    { key: 'proof', label: 'Proof & Safety' }
  ];

  const NAV_ITEMS = [
    { key: 'hub', group: 'daily', label: 'Hub', short: 'Hub', href: '/', aliases: ['/index.html'], emoji: '🏠' },
    { key: 'add', group: 'daily', label: 'Add Transaction', short: 'Add', href: '/add.html', aliases: [], emoji: '➕' },
    { key: 'transactions', group: 'daily', label: 'Transactions', short: 'Tx', href: '/transactions.html', aliases: [], emoji: '📜' },
    { key: 'bills', group: 'daily', label: 'Bills', short: 'Bills', href: '/bills.html', aliases: [], emoji: '📅' },
    { key: 'cc', group: 'daily', label: 'CC Planner', short: 'CC', href: '/cc.html', aliases: [], emoji: '🪪' },

    { key: 'accounts', group: 'money', label: 'Accounts', short: 'Accts', href: '/accounts.html', aliases: [], emoji: '🏦' },
    { key: 'atm', group: 'money', label: 'ATM', short: 'ATM', href: '/atm.html', aliases: [], emoji: '🏧' },
    { key: 'nano', group: 'money', label: 'Nano Loans', short: 'Nano', href: '/nano-loans.html', aliases: [], emoji: '🤝' },
    { key: 'debts', group: 'money', label: 'Debts', short: 'Debts', href: '/debts.html', aliases: [], emoji: '💳' },
    { key: 'salary', group: 'money', label: 'Salary', short: 'Salary', href: '/salary.html', aliases: [], emoji: '💰' },

    { key: 'goals', group: 'plan', label: 'Goals', short: 'Goals', href: '/goals.html', aliases: [], emoji: '🎯' },
    { key: 'insights', group: 'plan', label: 'Insights', short: 'Insights', href: '/insights.html', aliases: [], emoji: '🧠' },
    { key: 'charts', group: 'plan', label: 'Charts', short: 'Charts', href: '/charts.html', aliases: [], emoji: '📊' },

    { key: 'reconciliation', group: 'proof', label: 'Reconciliation', short: 'Recon', href: '/reconciliation.html', aliases: [], emoji: '⚖️' },
    { key: 'audit', group: 'proof', label: 'Audit Log', short: 'Audit', href: '/audit.html', aliases: [], emoji: '🛡️' },
    { key: 'snapshots', group: 'proof', label: 'Snapshots', short: 'Snaps', href: '/snapshots.html', aliases: [], emoji: '📸' }
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
      <a href="${item.href}" class="${cls}${active}" data-nav-key="${item.key}" data-nav-group="${item.group}">
        <span class="nav-emoji">${item.emoji}</span>
        <span class="nav-text">${label}</span>
      </a>
    `;
  }

  function desktopGroupHTML(group, path) {
    const items = NAV_ITEMS.filter(item => item.group === group.key);

    if (!items.length) return '';

    return `
      <section class="desktop-nav-layer" data-nav-layer="${group.key}">
        <div class="desktop-nav-layer-title">${group.label}</div>
        <div class="desktop-nav-layer-items">
          ${items.map(item => navItemHTML(item, path, 'desktop')).join('')}
        </div>
      </section>
    `;
  }

  function desktopHTML(path) {
    return `
      <aside class="desktop-nav" aria-label="Desktop navigation" data-nav-version="${VERSION}">
        <div class="desktop-nav-brand">
          <div class="desktop-nav-mark">SF</div>
          <div class="desktop-nav-brand-copy">
            <div class="desktop-nav-kicker">Sovereign</div>
            <div class="desktop-nav-name">Finance OS</div>
          </div>
        </div>
        <div class="desktop-nav-system-pill">
          <span class="desktop-nav-pulse"></span>
          <span>Real data mode</span>
        </div>
        <div class="desktop-nav-layers">
          ${NAV_GROUPS.map(group => desktopGroupHTML(group, path)).join('')}
        </div>
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
    const existing = document.getElementById(MOBILE_STYLE_ID);
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.id = MOBILE_STYLE_ID;
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

  function injectPremiumRailStyle() {
    const existing = document.getElementById(PREMIUM_STYLE_ID);
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.id = PREMIUM_STYLE_ID;
    style.textContent = `
      @keyframes sov-rail-enter {
        from {
          opacity: 0;
          transform: translateX(-14px) scale(0.985);
          filter: saturate(0.92);
        }
        to {
          opacity: 1;
          transform: translateX(0) scale(1);
          filter: saturate(1);
        }
      }

      @keyframes sov-rail-pulse {
        0%, 100% {
          box-shadow: 0 0 0 rgba(34, 197, 94, 0);
        }
        50% {
          box-shadow: 0 0 20px rgba(34, 197, 94, 0.36);
        }
      }

      @media (min-width: 1200px) {
        body {
          padding-left: 332px !important;
        }

        .desktop-nav {
          display: flex !important;
          position: fixed !important;
          top: 24px !important;
          left: 22px !important;
          width: 284px !important;
          max-height: calc(100vh - 48px) !important;
          overflow: hidden !important;
          flex-direction: column !important;
          gap: 10px !important;
          padding: 14px !important;
          border-radius: 30px !important;
          color: #e2e8f0 !important;
          border: 1px solid rgba(148, 163, 184, 0.22) !important;
          background:
            radial-gradient(circle at 18% 0%, rgba(34, 197, 94, 0.20), transparent 13rem),
            radial-gradient(circle at 90% 12%, rgba(59, 130, 246, 0.16), transparent 12rem),
            linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 0.98)) !important;
          box-shadow:
            0 30px 80px rgba(2, 6, 23, 0.28),
            inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
          backdrop-filter: blur(18px) !important;
          -webkit-backdrop-filter: blur(18px) !important;
          z-index: 900 !important;
          animation: sov-rail-enter 620ms cubic-bezier(0.16, 1, 0.3, 1) both !important;
        }

        .desktop-nav::before {
          content: "";
          position: absolute;
          inset: 10px;
          pointer-events: none;
          border-radius: 24px;
          border: 1px solid rgba(255, 255, 255, 0.055);
        }

        .desktop-nav-brand {
          display: flex;
          align-items: center;
          gap: 11px;
          padding: 6px 6px 4px;
          position: relative;
          z-index: 1;
        }

        .desktop-nav-mark {
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          flex: 0 0 42px;
          border-radius: 16px;
          color: #052e16;
          font-size: 13px;
          font-weight: 1000;
          letter-spacing: -0.04em;
          background: linear-gradient(135deg, #86efac, #22c55e);
          box-shadow: 0 14px 30px rgba(34, 197, 94, 0.24);
        }

        .desktop-nav-brand-copy {
          min-width: 0;
        }

        .desktop-nav-kicker {
          color: rgba(226, 232, 240, 0.64);
          font-size: 10px;
          font-weight: 950;
          letter-spacing: 0.16em;
          text-transform: uppercase;
        }

        .desktop-nav-name {
          margin-top: 2px;
          color: #ffffff;
          font-size: 17px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: -0.045em;
        }

        .desktop-nav-system-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          width: fit-content;
          margin: 0 6px 2px;
          padding: 7px 10px;
          border-radius: 999px;
          color: #bbf7d0;
          background: rgba(34, 197, 94, 0.10);
          border: 1px solid rgba(134, 239, 172, 0.16);
          font-size: 11px;
          font-weight: 900;
          position: relative;
          z-index: 1;
        }

        .desktop-nav-pulse {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #22c55e;
          animation: sov-rail-pulse 2.4s ease-in-out infinite;
        }

        .desktop-nav-layers {
          display: flex;
          min-height: 0;
          overflow: hidden;
          flex-direction: column;
          gap: 8px;
          position: relative;
          z-index: 1;
        }

        .desktop-nav-layer {
          padding: 8px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.045);
          border: 1px solid rgba(255, 255, 255, 0.055);
        }

        .desktop-nav-layer-title {
          margin: 0 4px 6px;
          color: rgba(203, 213, 225, 0.72);
          font-size: 9px;
          line-height: 1;
          font-weight: 1000;
          text-transform: uppercase;
          letter-spacing: 0.15em;
        }

        .desktop-nav-layer-items {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .desktop-nav-item {
          min-height: 34px !important;
          display: grid !important;
          grid-template-columns: 26px minmax(0, 1fr) !important;
          align-items: center !important;
          gap: 8px !important;
          padding: 7px 9px !important;
          border-radius: 15px !important;
          color: rgba(226, 232, 240, 0.78) !important;
          background: transparent !important;
          border: 1px solid transparent !important;
          font-size: 13px !important;
          font-weight: 850 !important;
          text-decoration: none !important;
          transition:
            transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
            background 240ms cubic-bezier(0.16, 1, 0.3, 1),
            border-color 240ms cubic-bezier(0.16, 1, 0.3, 1),
            color 240ms cubic-bezier(0.16, 1, 0.3, 1),
            box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1) !important;
        }

        .desktop-nav-item:hover {
          color: #ffffff !important;
          transform: translateX(4px) !important;
          background: rgba(255, 255, 255, 0.075) !important;
          border-color: rgba(255, 255, 255, 0.09) !important;
        }

        .desktop-nav-item.active {
          color: #dcfce7 !important;
          background:
            linear-gradient(135deg, rgba(34, 197, 94, 0.24), rgba(34, 197, 94, 0.10)) !important;
          border-color: rgba(134, 239, 172, 0.28) !important;
          box-shadow:
            0 10px 28px rgba(34, 197, 94, 0.14),
            inset 0 1px 0 rgba(255, 255, 255, 0.10) !important;
        }

        .desktop-nav-item.active::after {
          content: "";
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #86efac;
          box-shadow: 0 0 14px rgba(134, 239, 172, 0.70);
          justify-self: end;
          grid-column: 2;
          grid-row: 1;
        }

        .desktop-nav-item .nav-emoji {
          width: 26px !important;
          height: 26px !important;
          display: grid !important;
          place-items: center !important;
          border-radius: 10px !important;
          font-size: 15px !important;
          line-height: 1 !important;
          text-align: center !important;
          background: rgba(255, 255, 255, 0.075);
        }

        .desktop-nav-item .nav-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          letter-spacing: -0.01em;
        }
      }

      @media (min-width: 1600px) {
        body {
          padding-left: 352px !important;
        }

        .desktop-nav {
          left: 30px !important;
          width: 292px !important;
        }
      }

      @media (min-width: 1200px) and (max-height: 820px) {
        .desktop-nav {
          top: 16px !important;
          max-height: calc(100vh - 32px) !important;
          gap: 7px !important;
          padding: 12px !important;
        }

        .desktop-nav-brand {
          padding-bottom: 0;
        }

        .desktop-nav-mark {
          width: 36px;
          height: 36px;
          flex-basis: 36px;
          border-radius: 14px;
        }

        .desktop-nav-name {
          font-size: 15px;
        }

        .desktop-nav-system-pill {
          padding: 5px 9px;
          font-size: 10px;
        }

        .desktop-nav-layer {
          padding: 6px;
          border-radius: 18px;
        }

        .desktop-nav-layer-title {
          margin-bottom: 4px;
          font-size: 8px;
        }

        .desktop-nav-item {
          min-height: 30px !important;
          padding: 5px 8px !important;
          border-radius: 13px !important;
          font-size: 12px !important;
        }

        .desktop-nav-item .nav-emoji {
          width: 22px !important;
          height: 22px !important;
          font-size: 13px !important;
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
    injectPremiumRailStyle();
    replaceDesktopNav(path);
    replaceBottomNav(path);
    setHeaderTitle(path);
    markBodyPage(path);

    window.SOV_NAV = {
      version: VERSION,
      items: NAV_ITEMS.slice(),
      groups: NAV_GROUPS.slice(),
      bottomKeys: BOTTOM_KEYS.slice(),
      activePath: path,
      mobileGuard: MOBILE_STYLE_ID,
      premiumRail: PREMIUM_STYLE_ID
    };

    console.log('[nav ' + VERSION + '] loaded', path);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
