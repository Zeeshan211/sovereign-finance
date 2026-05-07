/* ─── Sovereign Finance · nav.js v1.0.14 · Hub-only shell + wording cleanup ─── */
/*
 * Contract:
 * - Mobile <= 860px: bottom nav visible.
 * - Mobile <= 860px: All drawer visible.
 * - Web/tablet >= 861px: side rail visible.
 * - Big app shell appears ONLY on Hub.
 * - Other pages keep normal page content without duplicate wrapper.
 * - CC wording changed to Credit Card.
 * - Account amount / Real data overlap prevented.
 * - Existing cards/panels get safe premium treatment.
 * - Existing real percentage/progress elements get motion.
 * - No fake numbers.
 * - No ledger/API/schema/business-logic changes.
 */

(function () {
  'use strict';

  const VERSION = 'v1.0.14';
  const STYLE_ID = 'sov-nav-contract-style';
  const CARD_STYLE_ID = 'sov-premium-card-style';
  const MOTION_STYLE_ID = 'sov-real-data-motion-style';
  const DRAWER_ID = 'sov-mobile-module-drawer';
  const DRAWER_TOGGLE_ID = 'sov-mobile-module-toggle';

  const NAV_GROUPS = [
    { key: 'daily', label: 'Daily Core' },
    { key: 'money', label: 'Money Control' },
    { key: 'plan', label: 'Planning' },
    { key: 'proof', label: 'Proof & Safety' }
  ];

  const NAV_ITEMS = [
    { key: 'hub', group: 'daily', label: 'Hub', short: 'Hub', href: '/', aliases: ['/index.html'], icon: '⌂' },
    { key: 'add', group: 'daily', label: 'Add Transaction', short: 'Add', href: '/add.html', aliases: [], icon: '+' },
    { key: 'transactions', group: 'daily', label: 'Transactions', short: 'Tx', href: '/transactions.html', aliases: [], icon: '≡' },
    { key: 'bills', group: 'daily', label: 'Bills', short: 'Bills', href: '/bills.html', aliases: [], icon: '□' },
    { key: 'credit-card', group: 'daily', label: 'Credit Card', short: 'Card', href: '/cc.html', aliases: [], icon: '◈' },

    { key: 'accounts', group: 'money', label: 'Accounts', short: 'Accts', href: '/accounts.html', aliases: [], icon: '▣' },
    { key: 'atm', group: 'money', label: 'ATM', short: 'ATM', href: '/atm.html', aliases: [], icon: '▤' },
    { key: 'nano', group: 'money', label: 'Nano Loans', short: 'Nano', href: '/nano-loans.html', aliases: [], icon: '◇' },
    { key: 'debts', group: 'money', label: 'Debts', short: 'Debts', href: '/debts.html', aliases: [], icon: '▥' },
    { key: 'salary', group: 'money', label: 'Salary', short: 'Salary', href: '/salary.html', aliases: [], icon: '₹' },

    { key: 'goals', group: 'plan', label: 'Goals', short: 'Goals', href: '/goals.html', aliases: [], icon: '◎' },
    { key: 'insights', group: 'plan', label: 'Insights', short: 'Insights', href: '/insights.html', aliases: [], icon: '✦' },
    { key: 'charts', group: 'plan', label: 'Charts', short: 'Charts', href: '/charts.html', aliases: [], icon: '▲' },

    { key: 'reconciliation', group: 'proof', label: 'Reconciliation', short: 'Recon', href: '/reconciliation.html', aliases: [], icon: '⚖' },
    { key: 'audit', group: 'proof', label: 'Audit Log', short: 'Audit', href: '/audit.html', aliases: [], icon: '◇' },
    { key: 'snapshots', group: 'proof', label: 'Snapshots', short: 'Snaps', href: '/snapshots.html', aliases: [], icon: '▧' }
  ];

  const BOTTOM_KEYS = ['hub', 'add', 'transactions', 'bills', 'credit-card'];

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

  function activeItem(path) {
    return NAV_ITEMS.find(item => isActive(item, path)) || NAV_ITEMS[0];
  }

  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(100, num));
  }

  function percentFromNode(node) {
    if (!node) return null;

    const attrs = [
      node.getAttribute('data-percent'),
      node.getAttribute('data-percentage'),
      node.getAttribute('data-progress'),
      node.getAttribute('aria-valuenow')
    ];

    for (const attr of attrs) {
      const pct = clampPercent(attr);
      if (pct !== null) return pct;
    }

    const text = (node.textContent || '').trim();
    const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!match) return null;

    return clampPercent(match[1]);
  }

  function navLink(item, path, mode) {
    const active = isActive(item, path) ? ' active' : '';
    const label = mode === 'bottom' ? item.short : item.label;
    const cls = mode === 'bottom' ? 'nav-item' : mode === 'drawer' ? 'mobile-drawer-item' : 'desktop-nav-item';

    if (mode === 'drawer') {
      return `
        <a href="${item.href}" class="${cls}${active}" data-nav-key="${item.key}">
          <span class="nav-icon">${item.icon}</span>
          <span class="nav-text">${item.label}</span>
          <span class="nav-dot"></span>
        </a>
      `;
    }

    return `
      <a href="${item.href}" class="${cls}${active}" data-nav-key="${item.key}">
        <span class="nav-icon">${item.icon}</span>
        <span class="nav-text">${label}</span>
      </a>
    `;
  }

  function groupHTML(group, path, mode) {
    const items = NAV_ITEMS.filter(item => item.group === group.key);
    return `
      <section class="${mode}-nav-layer">
        <div class="${mode}-nav-layer-title">${group.label}</div>
        <div class="${mode}-nav-layer-items">
          ${items.map(item => navLink(item, path, mode === 'mobile-drawer' ? 'drawer' : 'desktop')).join('')}
        </div>
      </section>
    `;
  }

  function desktopHTML(path) {
    return `
      <aside class="desktop-nav" aria-label="Desktop navigation" data-nav-version="${VERSION}">
        <div class="desktop-nav-brand">
          <div class="desktop-nav-mark">SF</div>
          <div>
            <div class="desktop-nav-kicker">Sovereign</div>
            <div class="desktop-nav-name">Finance OS</div>
          </div>
        </div>
        <div class="desktop-nav-system-pill">
          <span class="desktop-nav-pulse"></span>
          <span>Real data mode</span>
        </div>
        <div class="desktop-nav-layers">
          ${NAV_GROUPS.map(group => groupHTML(group, path, 'desktop')).join('')}
        </div>
      </aside>
    `;
  }

  function bottomHTML(path) {
    const items = NAV_ITEMS.filter(item => BOTTOM_KEYS.includes(item.key));
    return `
      <nav class="bottom-nav" aria-label="Bottom navigation" data-nav-version="${VERSION}">
        <div class="bottom-nav-inner">
          ${items.map(item => navLink(item, path, 'bottom')).join('')}
        </div>
      </nav>
    `;
  }

  function drawerHTML(path) {
    return `
      <button id="${DRAWER_TOGGLE_ID}" class="mobile-module-toggle" type="button" aria-label="Open all modules" aria-controls="${DRAWER_ID}" aria-expanded="false">
        <span>☰</span>
        <span>All</span>
      </button>
      <div id="${DRAWER_ID}" class="mobile-module-drawer" aria-hidden="true">
        <div class="mobile-drawer-backdrop" data-drawer-close="true"></div>
        <aside class="mobile-drawer-panel" role="dialog" aria-modal="true" aria-label="All modules">
          <div class="mobile-drawer-handle"></div>
          <div class="mobile-drawer-head">
            <div>
              <div class="mobile-drawer-kicker">Sovereign Finance</div>
              <div class="mobile-drawer-title">All Modules</div>
            </div>
            <button class="mobile-drawer-close" type="button" data-drawer-close="true" aria-label="Close modules">×</button>
          </div>
          <div class="mobile-drawer-pill">
            <span class="desktop-nav-pulse"></span>
            <span>Real data mode · no demo values</span>
          </div>
          <div class="mobile-drawer-layers">
            ${NAV_GROUPS.map(group => groupHTML(group, path, 'mobile-drawer')).join('')}
          </div>
        </aside>
      </div>
    `;
  }

  function hubShellHTML() {
    return `
      <section class="sov-app-shell sov-hub-shell" data-shell-page="hub" data-shell-version="${VERSION}" aria-label="Hub safety summary">
        <div class="sov-shell-orb">⌂</div>
        <div class="sov-shell-main">
          <div class="sov-shell-eyebrow">Today Command Center</div>
          <h1 class="sov-shell-title">Hub Cockpit</h1>
          <p class="sov-shell-purpose">This screen should answer: what needs attention, what changed, and where I go next.</p>
        </div>
        <div class="sov-shell-proof">
          <div class="sov-shell-proof-pill"><span class="desktop-nav-pulse"></span><span>Safety check</span></div>
          <div class="sov-shell-proof-line">Unsafe means: overdue bill, Credit Card pressure, cash mismatch, debt pressure, or unreconciled balance.</div>
          <div class="sov-shell-next">Use the cards below as the real signal source.</div>
        </div>
      </section>
    `;
  }

  function injectStyles() {
    const old = document.getElementById(STYLE_ID);
    if (old) old.remove();

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes sov-rail-enter {
        from { opacity: 0; transform: translateX(-12px) scale(0.985); }
        to { opacity: 1; transform: translateX(0) scale(1); }
      }

      @keyframes sov-shell-rise {
        from { opacity: 0; transform: translateY(-8px) scale(0.992); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes sov-pulse {
        0%, 100% { box-shadow: 0 0 0 rgba(34, 197, 94, 0); }
        50% { box-shadow: 0 0 20px rgba(34, 197, 94, 0.36); }
      }

      header,
      .topbar,
      .app-header,
      .page-header {
        position: relative;
        z-index: 140;
      }

      .theme-toggle,
      .theme-button,
      .theme-btn,
      #themeToggle,
      #theme-toggle,
      [data-theme-toggle] {
        position: relative;
        z-index: 3200 !important;
      }

      .desktop-nav,
      .bottom-nav,
      .mobile-module-toggle,
      .mobile-module-drawer,
      .sov-app-shell {
        box-sizing: border-box;
      }

      .desktop-nav,
      .bottom-nav,
      .mobile-module-toggle,
      .mobile-module-drawer {
        display: none;
      }

      .sov-app-shell {
        position: relative;
        z-index: 40;
        width: min(1120px, calc(100% - 32px));
        margin: clamp(24px, 4vw, 44px) auto 18px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) minmax(250px, 0.78fr);
        align-items: center;
        gap: 16px;
        padding: 16px;
        border-radius: 28px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background:
          radial-gradient(circle at 7% 0%, rgba(34, 197, 94, 0.16), transparent 15rem),
          radial-gradient(circle at 100% 0%, rgba(59, 130, 246, 0.12), transparent 14rem),
          var(--card, rgba(255, 255, 255, 0.72));
        box-shadow:
          0 18px 50px rgba(15, 23, 42, 0.10),
          inset 0 1px 0 rgba(255, 255, 255, 0.50);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        animation: sov-shell-rise 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
      }

      .sov-shell-orb {
        width: 58px;
        height: 58px;
        display: grid;
        place-items: center;
        border-radius: 22px;
        color: #052e16;
        background:
          radial-gradient(circle at 35% 20%, rgba(255, 255, 255, 0.90), transparent 2.8rem),
          linear-gradient(135deg, rgba(34, 197, 94, 0.24), rgba(59, 130, 246, 0.16));
        box-shadow: 0 14px 32px rgba(34, 197, 94, 0.14);
        font-size: 25px;
        font-weight: 1000;
      }

      .sov-shell-main { min-width: 0; }

      .sov-shell-eyebrow {
        color: var(--accent-deep, #047857);
        font-size: 11px;
        font-weight: 1000;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      .sov-shell-title {
        margin: 4px 0 0;
        color: var(--text-main, #0f172a);
        font-size: clamp(22px, 3.3vw, 34px);
        line-height: 0.98;
        font-weight: 1000;
        letter-spacing: -0.065em;
      }

      .sov-shell-purpose {
        margin: 8px 0 0;
        max-width: 680px;
        color: var(--text-muted, #64748b);
        font-size: 13px;
        line-height: 1.45;
        font-weight: 750;
      }

      .sov-shell-proof {
        min-width: 0;
        padding: 12px;
        border-radius: 22px;
        background: rgba(15, 23, 42, 0.045);
        border: 1px solid rgba(15, 23, 42, 0.055);
      }

      .sov-shell-proof-pill,
      .desktop-nav-system-pill,
      .mobile-drawer-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        padding: 7px 10px;
        border-radius: 999px;
        color: #047857;
        background: rgba(34, 197, 94, 0.10);
        border: 1px solid rgba(34, 197, 94, 0.18);
        font-size: 11px;
        font-weight: 950;
      }

      .desktop-nav-pulse {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #22c55e;
        animation: sov-pulse 2.4s ease-in-out infinite;
      }

      .sov-shell-proof-line,
      .sov-shell-next {
        margin-top: 8px;
        color: var(--text-muted, #64748b);
        font-size: 12px;
        line-height: 1.38;
        font-weight: 760;
      }

      .sov-shell-next {
        color: var(--text-main, #0f172a);
        font-weight: 900;
      }

      @media (min-width: 861px) {
        body { padding-left: 308px !important; }

        .desktop-nav {
          display: flex !important;
          position: fixed !important;
          top: 18px !important;
          left: 18px !important;
          width: 262px !important;
          max-height: calc(100vh - 36px) !important;
          overflow: hidden !important;
          flex-direction: column !important;
          gap: 9px !important;
          padding: 13px !important;
          border-radius: 28px !important;
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

        .desktop-nav-brand {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 4px 5px 2px;
        }

        .desktop-nav-mark {
          width: 38px;
          height: 38px;
          display: grid;
          place-items: center;
          flex: 0 0 38px;
          border-radius: 15px;
          color: #052e16;
          font-size: 13px;
          font-weight: 1000;
          letter-spacing: -0.04em;
          background: linear-gradient(135deg, #86efac, #22c55e);
          box-shadow: 0 14px 30px rgba(34, 197, 94, 0.24);
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
          font-size: 16px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: -0.045em;
        }

        .desktop-nav-system-pill {
          margin: 0 5px 2px;
          color: #bbf7d0;
          background: rgba(34, 197, 94, 0.10);
          border-color: rgba(134, 239, 172, 0.16);
        }

        .desktop-nav-layers {
          display: flex;
          min-height: 0;
          overflow: hidden;
          flex-direction: column;
          gap: 7px;
        }

        .desktop-nav-layer {
          padding: 7px;
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.045);
          border: 1px solid rgba(255, 255, 255, 0.055);
        }

        .desktop-nav-layer-title {
          margin: 0 4px 5px;
          color: rgba(203, 213, 225, 0.72);
          font-size: 8px;
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
          min-height: 31px !important;
          display: grid !important;
          grid-template-columns: 24px minmax(0, 1fr) !important;
          align-items: center !important;
          gap: 8px !important;
          padding: 6px 8px !important;
          border-radius: 14px !important;
          color: rgba(226, 232, 240, 0.78) !important;
          background: transparent !important;
          border: 1px solid transparent !important;
          font-size: 12px !important;
          font-weight: 850 !important;
          text-decoration: none !important;
        }

        .desktop-nav-item:hover {
          color: #ffffff !important;
          transform: translateX(3px) !important;
          background: rgba(255, 255, 255, 0.075) !important;
          border-color: rgba(255, 255, 255, 0.09) !important;
        }

        .desktop-nav-item.active {
          color: #dcfce7 !important;
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.24), rgba(34, 197, 94, 0.10)) !important;
          border-color: rgba(134, 239, 172, 0.28) !important;
          box-shadow: 0 10px 28px rgba(34, 197, 94, 0.14) !important;
        }

        .desktop-nav-item .nav-icon {
          width: 24px !important;
          height: 24px !important;
          display: grid !important;
          place-items: center !important;
          border-radius: 10px !important;
          font-size: 13px !important;
          line-height: 1 !important;
          text-align: center !important;
          background: rgba(255, 255, 255, 0.075);
        }

        .desktop-nav-item .nav-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .bottom-nav,
        .mobile-module-toggle,
        .mobile-module-drawer {
          display: none !important;
        }
      }

      @media (min-width: 1200px) {
        body { padding-left: 332px !important; }

        .desktop-nav {
          top: 24px !important;
          left: 22px !important;
          width: 284px !important;
          max-height: calc(100vh - 48px) !important;
          padding: 14px !important;
        }

        .desktop-nav-item {
          min-height: 34px !important;
          font-size: 13px !important;
        }
      }

      @media (max-width: 860px) {
        html { min-height: 100%; }

        body {
          min-height: 100%;
          padding-left: 0 !important;
          padding-bottom: calc(100px + env(safe-area-inset-bottom)) !important;
        }

        .desktop-nav { display: none !important; }

        .sov-app-shell {
          width: min(100% - 22px, 720px);
          margin: 18px auto 14px;
          grid-template-columns: minmax(0, 1fr);
          gap: 12px;
          padding: 14px;
          border-radius: 24px;
        }

        .sov-shell-orb {
          width: 48px;
          height: 48px;
          border-radius: 18px;
          font-size: 22px;
        }

        .sov-shell-title {
          font-size: 26px;
          letter-spacing: -0.055em;
        }

        .sov-shell-purpose { font-size: 12.5px; }

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
          background: rgba(255, 255, 255, 0.96) !important;
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
          min-height: 54px !important;
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

        .bottom-nav .nav-icon {
          display: grid !important;
          place-items: center !important;
          font-size: 17px !important;
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

        .mobile-module-toggle {
          position: fixed !important;
          right: 14px !important;
          bottom: calc(88px + env(safe-area-inset-bottom)) !important;
          z-index: 2410 !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 6px !important;
          min-width: 66px !important;
          height: 42px !important;
          padding: 0 13px !important;
          border: 1px solid rgba(148, 163, 184, 0.35) !important;
          border-radius: 999px !important;
          color: #ecfdf5 !important;
          background: rgba(15, 23, 42, 0.94) !important;
          box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22) !important;
          backdrop-filter: blur(16px) !important;
          -webkit-backdrop-filter: blur(16px) !important;
          font-size: 12px !important;
          font-weight: 950 !important;
        }

        .mobile-module-drawer {
          position: fixed !important;
          inset: 0 !important;
          z-index: 3000 !important;
          display: none !important;
          pointer-events: none !important;
        }

        .mobile-module-drawer.open {
          display: block !important;
          pointer-events: auto !important;
        }

        .mobile-drawer-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(15, 23, 42, 0.52);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }

        .mobile-drawer-panel {
          position: absolute;
          left: 10px;
          right: 10px;
          bottom: calc(10px + env(safe-area-inset-bottom));
          max-height: min(78vh, 680px);
          overflow-y: auto;
          padding: 10px 12px 14px;
          border-radius: 28px;
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.22);
          background:
            radial-gradient(circle at 15% 0%, rgba(34, 197, 94, 0.22), transparent 13rem),
            radial-gradient(circle at 90% 18%, rgba(59, 130, 246, 0.14), transparent 11rem),
            linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 0.98));
          box-shadow: 0 30px 80px rgba(2, 6, 23, 0.38);
        }

        .mobile-drawer-handle {
          width: 44px;
          height: 5px;
          margin: 2px auto 12px;
          border-radius: 999px;
          background: rgba(226, 232, 240, 0.26);
        }

        .mobile-drawer-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 0 4px 8px;
        }

        .mobile-drawer-kicker {
          color: rgba(203, 213, 225, 0.70);
          font-size: 10px;
          font-weight: 950;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }

        .mobile-drawer-title {
          margin-top: 2px;
          color: #ffffff;
          font-size: 24px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: -0.055em;
        }

        .mobile-drawer-close {
          width: 38px;
          height: 38px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 999px;
          color: #e2e8f0;
          background: rgba(255, 255, 255, 0.06);
          font-size: 26px;
          line-height: 1;
        }

        .mobile-drawer-pill {
          margin: 0 4px 10px;
          color: #bbf7d0;
          background: rgba(34, 197, 94, 0.10);
          border-color: rgba(134, 239, 172, 0.16);
        }

        .mobile-drawer-layers {
          display: flex;
          flex-direction: column;
          gap: 9px;
        }

        .mobile-drawer-nav-layer {
          padding: 9px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.045);
          border: 1px solid rgba(255, 255, 255, 0.055);
        }

        .mobile-drawer-nav-layer-title {
          margin: 0 4px 7px;
          color: rgba(203, 213, 225, 0.72);
          font-size: 9px;
          line-height: 1;
          font-weight: 1000;
          text-transform: uppercase;
          letter-spacing: 0.15em;
        }

        .mobile-drawer-nav-layer-items {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px;
        }

        .mobile-drawer-item {
          min-width: 0;
          min-height: 48px;
          display: grid;
          grid-template-columns: 28px minmax(0, 1fr) 6px;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-radius: 16px;
          color: rgba(226, 232, 240, 0.80);
          background: rgba(255, 255, 255, 0.035);
          border: 1px solid rgba(255, 255, 255, 0.055);
          text-decoration: none;
          font-size: 12px;
          font-weight: 900;
        }

        .mobile-drawer-item.active {
          color: #dcfce7;
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.24), rgba(34, 197, 94, 0.10));
          border-color: rgba(134, 239, 172, 0.28);
        }

        .mobile-drawer-item .nav-icon {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.075);
          font-size: 14px;
          line-height: 1;
        }

        .mobile-drawer-item .nav-text {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .mobile-drawer-item.active .nav-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #86efac;
          box-shadow: 0 0 14px rgba(134, 239, 172, 0.70);
        }
      }

      @media (max-width: 420px) {
        .mobile-drawer-nav-layer-items { grid-template-columns: 1fr; }
      }

      @media (prefers-reduced-motion: reduce) {
        .desktop-nav,
        .sov-app-shell,
        .desktop-nav-pulse {
          animation: none !important;
          transition: none !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function injectCardStyles() {
    const old = document.getElementById(CARD_STYLE_ID);
    if (old) old.remove();

    const style = document.createElement('style');
    style.id = CARD_STYLE_ID;
    style.textContent = `
      @keyframes sov-card-rise {
        from { opacity: 0; transform: translateY(12px) scale(0.992); filter: saturate(0.94); }
        to { opacity: 1; transform: translateY(0) scale(1); filter: saturate(1); }
      }

      @keyframes sov-card-sheen {
        from { transform: translateX(-130%) rotate(10deg); opacity: 0; }
        35% { opacity: 0.48; }
        to { transform: translateX(230%) rotate(10deg); opacity: 0; }
      }

      .sov-card-upgraded {
        position: relative;
        overflow: hidden;
        isolation: isolate;
        border-radius: clamp(20px, 2.1vw, 30px) !important;
        border: 1px solid rgba(148, 163, 184, 0.22) !important;
        background:
          radial-gradient(circle at 12% 0%, rgba(34, 197, 94, 0.105), transparent 14rem),
          radial-gradient(circle at 100% 10%, rgba(59, 130, 246, 0.08), transparent 13rem),
          var(--card, rgba(255, 255, 255, 0.78)) !important;
        box-shadow:
          0 18px 48px rgba(15, 23, 42, 0.095),
          inset 0 1px 0 rgba(255, 255, 255, 0.50) !important;
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        transform: translateZ(0);
        animation: sov-card-rise 460ms cubic-bezier(0.16, 1, 0.3, 1) both;
        animation-delay: calc(var(--sov-card-index, 0) * 38ms);
        transition:
          transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1),
          border-color 240ms cubic-bezier(0.16, 1, 0.3, 1) !important;
      }

      .sov-card-upgraded::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: -1;
        border-radius: inherit;
        background:
          linear-gradient(135deg, rgba(255, 255, 255, 0.42), transparent 38%),
          radial-gradient(circle at 20% 0%, rgba(255, 255, 255, 0.26), transparent 11rem);
      }

      .sov-card-upgraded::after {
        content: "";
        position: absolute;
        top: -30%;
        left: -40%;
        width: 34%;
        height: 160%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.40), transparent);
        transform: translateX(-130%) rotate(10deg);
        opacity: 0;
      }

      .sov-card-upgraded:hover {
        transform: translateY(-3px) scale(1.006);
        border-color: rgba(34, 197, 94, 0.24) !important;
        box-shadow:
          0 24px 64px rgba(15, 23, 42, 0.13),
          0 0 0 1px rgba(34, 197, 94, 0.06),
          inset 0 1px 0 rgba(255, 255, 255, 0.62) !important;
      }

      .sov-card-upgraded:hover::after {
        animation: sov-card-sheen 920ms cubic-bezier(0.16, 1, 0.3, 1) both;
      }

      .sov-card-upgraded h1,
      .sov-card-upgraded h2,
      .sov-card-upgraded h3,
      .sov-card-upgraded .title,
      .sov-card-upgraded .card-title {
        letter-spacing: -0.045em;
      }

      .sov-card-upgraded .amount,
      .sov-card-upgraded .balance,
      .sov-card-upgraded .value,
      .sov-card-upgraded .metric,
      .sov-card-upgraded [data-value],
      .sov-card-upgraded [data-amount] {
        letter-spacing: -0.055em;
        text-wrap: balance;
      }

      .sov-card-upgraded input,
      .sov-card-upgraded select,
      .sov-card-upgraded textarea {
        border-radius: 14px;
      }

      .sov-card-proof-badge {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: calc(100% - 24px);
        padding: 6px 9px;
        border-radius: 999px;
        color: #047857;
        background: rgba(34, 197, 94, 0.10);
        border: 1px solid rgba(34, 197, 94, 0.16);
        font-size: 10px;
        line-height: 1;
        font-weight: 950;
        pointer-events: none;
      }

      .sov-card-proof-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: #22c55e;
        box-shadow: 0 0 14px rgba(34, 197, 94, 0.42);
      }

      html[data-page="accounts"] .sov-card-proof-badge,
      .account-card .sov-card-proof-badge {
        display: none !important;
      }

      html[data-page="audit"] .sov-card-proof-badge,
      html[data-page="transactions"] .sov-card-proof-badge,
      html[data-page="reconciliation"] .sov-card-proof-badge,
      html[data-page="snapshots"] .sov-card-proof-badge {
        color: #1d4ed8;
        background: rgba(59, 130, 246, 0.10);
        border-color: rgba(59, 130, 246, 0.16);
      }

      html[data-page="audit"] .sov-card-proof-dot,
      html[data-page="transactions"] .sov-card-proof-dot,
      html[data-page="reconciliation"] .sov-card-proof-dot,
      html[data-page="snapshots"] .sov-card-proof-dot {
        background: #3b82f6;
        box-shadow: 0 0 14px rgba(59, 130, 246, 0.42);
      }

      @media (max-width: 860px) {
        .sov-card-upgraded {
          border-radius: 22px !important;
          box-shadow:
            0 14px 34px rgba(15, 23, 42, 0.09),
            inset 0 1px 0 rgba(255, 255, 255, 0.50) !important;
        }

        .sov-card-upgraded:hover {
          transform: none;
        }

        .sov-card-proof-badge {
          position: relative;
          top: auto;
          right: auto;
          margin: 0 0 10px;
          width: fit-content;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .sov-card-upgraded,
        .sov-card-upgraded::after {
          animation: none !important;
          transition: none !important;
        }

        .sov-card-upgraded:hover {
          transform: none !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function injectMotionStyles() {
    const old = document.getElementById(MOTION_STYLE_ID);
    if (old) old.remove();

    const style = document.createElement('style');
    style.id = MOTION_STYLE_ID;
    style.textContent = `
      @keyframes sov-fill-grow {
        from { transform: scaleX(0); }
        to { transform: scaleX(1); }
      }

      @keyframes sov-value-glow {
        0%, 100% { text-shadow: 0 0 0 rgba(34, 197, 94, 0); }
        50% { text-shadow: 0 0 18px rgba(34, 197, 94, 0.22); }
      }

      @keyframes sov-soft-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-2px); }
      }

      .sov-motion-ready { --sov-motion-fill: 0%; }

      .sov-motion-bar {
        position: relative;
        overflow: hidden;
        min-height: 10px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.075);
        box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.08);
      }

      .sov-motion-bar .sov-motion-fill {
        position: absolute;
        inset: 0 auto 0 0;
        width: var(--sov-motion-fill);
        min-width: 0;
        max-width: 100%;
        border-radius: inherit;
        transform-origin: left center;
        background:
          linear-gradient(90deg, rgba(16, 185, 129, 0.92), rgba(34, 197, 94, 0.72)),
          radial-gradient(circle at 100% 50%, rgba(255, 255, 255, 0.42), transparent 2.6rem);
        box-shadow:
          0 0 18px rgba(34, 197, 94, 0.20),
          inset 0 1px 0 rgba(255, 255, 255, 0.35);
        animation: sov-fill-grow 780ms cubic-bezier(0.16, 1, 0.3, 1) both;
      }

      .sov-motion-value { animation: sov-value-glow 2.8s ease-in-out 1; }
      .sov-motion-float { animation: sov-soft-float 5.4s ease-in-out infinite; }

      html[data-page="bills"] .sov-motion-bar .sov-motion-fill,
      html[data-page="credit-card"] .sov-motion-bar .sov-motion-fill,
      html[data-page="debts"] .sov-motion-bar .sov-motion-fill {
        background:
          linear-gradient(90deg, rgba(245, 158, 11, 0.92), rgba(34, 197, 94, 0.72)),
          radial-gradient(circle at 100% 50%, rgba(255, 255, 255, 0.42), transparent 2.6rem);
      }

      html[data-page="audit"] .sov-motion-bar .sov-motion-fill,
      html[data-page="transactions"] .sov-motion-bar .sov-motion-fill,
      html[data-page="reconciliation"] .sov-motion-bar .sov-motion-fill,
      html[data-page="snapshots"] .sov-motion-bar .sov-motion-fill {
        background:
          linear-gradient(90deg, rgba(59, 130, 246, 0.92), rgba(34, 197, 94, 0.72)),
          radial-gradient(circle at 100% 50%, rgba(255, 255, 255, 0.42), transparent 2.6rem);
      }

      @media (prefers-reduced-motion: reduce) {
        .sov-motion-bar .sov-motion-fill,
        .sov-motion-value,
        .sov-motion-float {
          animation: none !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function replaceNodes(selector, html, location) {
    document.querySelectorAll(selector).forEach(node => node.remove());

    if (location === 'body-end') {
      document.body.insertAdjacentHTML('beforeend', html);
      return;
    }

    const header = document.querySelector('header');
    if (header) {
      header.insertAdjacentHTML('afterend', html);
      return;
    }

    document.body.insertAdjacentHTML('afterbegin', html);
  }

  function setHeaderTitle(path) {
    const titleEl = document.querySelector('header .title');
    if (!titleEl) return;
    titleEl.textContent = activeItem(path).label;
  }

  function markPage(path) {
    const item = activeItem(path);
    document.documentElement.setAttribute('data-page', item.key);
    document.body.setAttribute('data-page', item.key);
  }

  function enhanceCards() {
    const selectors = [
      '.card',
      '.panel',
      '.stat-card',
      '.summary-card',
      '.account-card',
      '.bill-card',
      '.debt-card',
      '.goal-card',
      '.budget-card',
      '.snapshot-card',
      '.audit-card',
      '.metric-card',
      '.kpi-card',
      '.hero-card',
      '.glass-card',
      '.tile',
      '.box',
      'section.card',
      'article.card'
    ];

    const excluded = [
      '.desktop-nav',
      '.desktop-nav *',
      '.bottom-nav',
      '.bottom-nav *',
      '.mobile-module-drawer',
      '.mobile-module-drawer *',
      '.mobile-module-toggle',
      '.sov-app-shell',
      '.sov-app-shell *'
    ];

    const nodes = Array.from(document.querySelectorAll(selectors.join(','))).filter(node => {
      if (!node || node.nodeType !== 1) return false;
      if (node.classList.contains('sov-card-upgraded')) return false;
      return !excluded.some(selector => node.matches(selector));
    });

    nodes.forEach((node, index) => {
      node.classList.add('sov-card-upgraded');
      node.style.setProperty('--sov-card-index', String(Math.min(index, 14)));

      if (index < 5) node.classList.add('sov-motion-float');

      const hasForm = !!node.querySelector('form, input, select, textarea, button');
      const isAccountsPage = document.documentElement.getAttribute('data-page') === 'accounts';
      const isAccountCard = node.classList.contains('account-card') || !!node.closest('.account-card');
      const hasTable = !!node.querySelector('table');
      const text = node.textContent || '';
      const hasMoneySignal = /\b(rs|pkr|balance|amount|paid|due|owed|cash|salary|bill|debt|goal|transaction|snapshot|audit|reconcile)\b/i.test(text);

      if (!isAccountsPage && !isAccountCard && (hasMoneySignal || hasTable) && !hasForm && !node.querySelector('.sov-card-proof-badge')) {
        const badge = document.createElement('div');
        badge.className = 'sov-card-proof-badge';
        badge.innerHTML = '<span class="sov-card-proof-dot"></span><span>Real data</span>';
        node.insertAdjacentElement('afterbegin', badge);
      }
    });
  }

  function enhanceRealDataMotion() {
    const excluded = [
      '.desktop-nav',
      '.desktop-nav *',
      '.bottom-nav',
      '.bottom-nav *',
      '.mobile-module-drawer',
      '.mobile-module-drawer *',
      '.mobile-module-toggle',
      '.sov-app-shell',
      '.sov-app-shell *'
    ];

    const barSelectors = [
      '[data-percent]',
      '[data-percentage]',
      '[data-progress]',
      '[aria-valuenow]',
      '.progress',
      '.progress-bar',
      '.meter',
      '.meter-bar',
      '.bar',
      '.bar-fill'
    ];

    const bars = Array.from(document.querySelectorAll(barSelectors.join(','))).filter(node => {
      if (!node || node.nodeType !== 1) return false;
      if (node.classList.contains('sov-motion-done')) return false;
      return !excluded.some(selector => node.matches(selector));
    });

    bars.forEach(node => {
      const percent = percentFromNode(node);
      if (percent === null) return;

      node.classList.add('sov-motion-ready', 'sov-motion-bar', 'sov-motion-done');
      node.style.setProperty('--sov-motion-fill', percent + '%');

      if (!node.querySelector('.sov-motion-fill')) {
        const fill = document.createElement('span');
        fill.className = 'sov-motion-fill';
        fill.setAttribute('aria-hidden', 'true');
        node.insertAdjacentElement('afterbegin', fill);
      }
    });

    const values = Array.from(document.querySelectorAll('.amount, .balance, .value, .metric, [data-value], [data-amount]')).filter(node => {
      if (!node || node.nodeType !== 1) return false;
      if (node.classList.contains('sov-motion-value')) return false;
      return !excluded.some(selector => node.matches(selector));
    });

    values.slice(0, 24).forEach(node => node.classList.add('sov-motion-value'));
  }

  function observeEnhancements() {
    const root = document.querySelector('main, .wrap, .container, body');
    if (!root || window.SOV_UI_OBSERVER) return;

    let timer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        enhanceCards();
        enhanceRealDataMotion();
      }, 120);
    });

    observer.observe(root, { childList: true, subtree: true });
    window.SOV_UI_OBSERVER = observer;
  }

  function setDrawerOpen(open) {
    const drawer = document.getElementById(DRAWER_ID);
    const toggle = document.getElementById(DRAWER_TOGGLE_ID);
    if (!drawer || !toggle) return;

    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function bindDrawer() {
    const drawer = document.getElementById(DRAWER_ID);
    const toggle = document.getElementById(DRAWER_TOGGLE_ID);
    if (!drawer || !toggle) return;

    toggle.addEventListener('click', function () {
      setDrawerOpen(!drawer.classList.contains('open'));
    });

    drawer.querySelectorAll('[data-drawer-close="true"]').forEach(function (node) {
      node.addEventListener('click', function () {
        setDrawerOpen(false);
      });
    });

    drawer.querySelectorAll('.mobile-drawer-item').forEach(function (node) {
      node.addEventListener('click', function () {
        setDrawerOpen(false);
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setDrawerOpen(false);
    });
  }

  function initNav() {
    const path = currentPath();
    const item = activeItem(path);

    injectStyles();
    injectCardStyles();
    injectMotionStyles();
    markPage(path);

    replaceNodes('.desktop-nav', desktopHTML(path), 'after-header');
    document.querySelectorAll('.sov-app-shell').forEach(node => node.remove());
    if (item.key === 'hub') replaceNodes('.sov-app-shell', hubShellHTML(), 'after-header');

    replaceNodes('.bottom-nav', bottomHTML(path), 'body-end');
    replaceNodes('.mobile-module-toggle, .mobile-module-drawer', drawerHTML(path), 'body-end');

    setHeaderTitle(path);
    bindDrawer();
    enhanceCards();
    enhanceRealDataMotion();
    observeEnhancements();

    window.SOV_NAV = {
      version: VERSION,
      items: NAV_ITEMS.slice(),
      groups: NAV_GROUPS.slice(),
      bottomKeys: BOTTOM_KEYS.slice(),
      activePath: path,
      activeItem: item,
      enhanceCards: enhanceCards,
      enhanceMotion: enhanceRealDataMotion,
      openDrawer: function () { setDrawerOpen(true); },
      closeDrawer: function () { setDrawerOpen(false); }
    };

    console.log('[nav ' + VERSION + '] loaded', path);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
