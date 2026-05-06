/* ─── Sovereign Finance · nav.js v1.0.10 · Premium card system foundation ─── */
/*
 * Purpose:
 *   One navigation source for the whole app.
 *
 * Layer UI v1.0.10:
 *   - Keeps layered desktop rail.
 *   - Keeps mobile full-module drawer.
 *   - Keeps global app shell.
 *   - Keeps theme/app-shell overlap guard.
 *   - Adds premium card foundation to existing cards/panels only.
 *   - Adds reveal motion, layered borders, soft depth, hover lift, and real-data badges.
 *   - Does not change values, forms, API calls, ledger logic, schema, or business rules.
 */

(function () {
  'use strict';

  const VERSION = 'v1.0.10';
  const MOBILE_STYLE_ID = 'sov-nav-mobile-guard';
  const PREMIUM_STYLE_ID = 'sov-nav-premium-rail';
  const CARD_STYLE_ID = 'sov-premium-card-system';
  const DRAWER_ID = 'sov-mobile-module-drawer';
  const DRAWER_TOGGLE_ID = 'sov-mobile-module-toggle';

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

  const PAGE_META = {
    hub: {
      eyebrow: 'Today Command Center',
      title: 'Am I safe right now?',
      purpose: 'Start here to understand money position, urgent actions, and where to go next.',
      proof: 'Real account, bill, transaction, and planning data only.',
      next: 'Check alerts, then act on the highest-pressure item.'
    },
    add: {
      eyebrow: 'Capture Flow',
      title: 'Record what changed.',
      purpose: 'Add the movement once, clearly, so the rest of the system can stay truthful.',
      proof: 'No silent ledger mutation outside the submitted form.',
      next: 'Choose account, amount, category, and save only when the entry is real.'
    },
    transactions: {
      eyebrow: 'Ledger Timeline',
      title: 'See the money trail.',
      purpose: 'Review what happened, when it happened, and how the running history changed.',
      proof: 'Transaction rows are the audit surface for financial movement.',
      next: 'Scan recent activity and open the item that needs correction or review.'
    },
    bills: {
      eyebrow: 'Obligation Control',
      title: 'Know what needs action.',
      purpose: 'Separate paid, due, overdue, and upcoming bills without guessing.',
      proof: 'Paid status must be backed by bill state and payment source.',
      next: 'Handle the nearest real obligation first.'
    },
    cc: {
      eyebrow: 'Credit Discipline',
      title: 'Protect the statement cycle.',
      purpose: 'Track card pressure, due timing, and minimum-payment awareness.',
      proof: 'Card values must stay tied to real account and transaction state.',
      next: 'Check what is due, what is safe, and what should not be pushed forward.'
    },
    accounts: {
      eyebrow: 'Money Location',
      title: 'Know where cash is sitting.',
      purpose: 'See each account as a live pocket of money, not just a label.',
      proof: 'Balances must reconcile against real ledger and declared balance state.',
      next: 'Open the account that looks wrong or needs reconciliation.'
    },
    atm: {
      eyebrow: 'Cash Movement',
      title: 'Track physical money clearly.',
      purpose: 'Keep cash movement visible so withdrawals and usage do not disappear mentally.',
      proof: 'ATM movement must remain tied to real transactions and account effects.',
      next: 'Review recent cash movement before adding or correcting anything.'
    },
    nano: {
      eyebrow: 'Small Loan Ledger',
      title: 'Keep small obligations visible.',
      purpose: 'Track who owes what, what was repaid, and what remains without mental math.',
      proof: 'Loan movement must only reflect real create, repay, or push actions.',
      next: 'Review open balances before taking action.'
    },
    debts: {
      eyebrow: 'Debt Pressure Map',
      title: 'See what still has weight.',
      purpose: 'Understand owed and owing balances, progress, and pressure order.',
      proof: 'Debt state must match ledger movement and audit trail.',
      next: 'Act on the debt with the clearest next payment or correction.'
    },
    salary: {
      eyebrow: 'Income Breakdown',
      title: 'Understand what came in.',
      purpose: 'Turn salary into components, deductions, tax awareness, and usable money.',
      proof: 'Salary figures must come from real income records or explicit user entry.',
      next: 'Review components before planning the month.'
    },
    goals: {
      eyebrow: 'Future Builder',
      title: 'Connect money to direction.',
      purpose: 'Make savings and targets visible so progress does not stay abstract.',
      proof: 'Goal progress must be calculated from real saved values only.',
      next: 'Check which goal needs funding or cleanup.'
    },
    insights: {
      eyebrow: 'Pattern Reader',
      title: 'Find the signal inside the numbers.',
      purpose: 'Surface patterns that help decisions without inventing conclusions.',
      proof: 'Insights must be computed from existing transactions and balances.',
      next: 'Use patterns as prompts, not as fake certainty.'
    },
    charts: {
      eyebrow: 'Visual Intelligence',
      title: 'Make patterns visible.',
      purpose: 'Show movement, pressure, and trend without hiding source data.',
      proof: 'Every bar, ring, and line must render from real values only.',
      next: 'Look for the longest bar, sharpest change, or strange gap.'
    },
    reconciliation: {
      eyebrow: 'Truth Matching',
      title: 'Does app truth match real balance?',
      purpose: 'Compare declared reality against system state before trusting conclusions.',
      proof: 'Reconciliation scope must be stated. Clean only means clean for checked scope.',
      next: 'Declare real balance only when verified outside the app.'
    },
    audit: {
      eyebrow: 'Change Ledger',
      title: 'See what changed.',
      purpose: 'Keep every important system action traceable and reviewable.',
      proof: 'Audit rows are proof trail, not decoration.',
      next: 'Search the entity or action that needs explanation.'
    },
    snapshots: {
      eyebrow: 'Rollback Safety',
      title: 'Know whether you can rewind.',
      purpose: 'Protect recovery confidence before risky work or major corrections.',
      proof: 'Snapshot status is safety context, not a guarantee until restore is proven.',
      next: 'Check latest snapshot before trusting rollback coverage.'
    }
  };

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

  function getActiveItem(path) {
    return NAV_ITEMS.find(item => isActive(item, path)) || NAV_ITEMS[0];
  }

  function getActiveMeta(path) {
    const active = getActiveItem(path);
    return PAGE_META[active.key] || PAGE_META.hub;
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

  function drawerItemHTML(item, path) {
    const active = isActive(item, path) ? ' active' : '';

    return `
      <a href="${item.href}" class="mobile-drawer-item${active}" data-nav-key="${item.key}" data-nav-group="${item.group}">
        <span class="mobile-drawer-icon">${item.emoji}</span>
        <span class="mobile-drawer-label">${item.label}</span>
        <span class="mobile-drawer-dot" aria-hidden="true"></span>
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

  function drawerGroupHTML(group, path) {
    const items = NAV_ITEMS.filter(item => item.group === group.key);
    if (!items.length) return '';

    return `
      <section class="mobile-drawer-layer" data-nav-layer="${group.key}">
        <div class="mobile-drawer-layer-title">${group.label}</div>
        <div class="mobile-drawer-layer-grid">
          ${items.map(item => drawerItemHTML(item, path)).join('')}
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

  function drawerHTML(path) {
    return `
      <button id="${DRAWER_TOGGLE_ID}" class="mobile-module-toggle" type="button" aria-label="Open all modules" aria-controls="${DRAWER_ID}" aria-expanded="false">
        <span class="mobile-module-toggle-icon">☰</span>
        <span class="mobile-module-toggle-text">All</span>
      </button>

      <div id="${DRAWER_ID}" class="mobile-module-drawer" aria-hidden="true">
        <div class="mobile-drawer-backdrop" data-drawer-close="true"></div>
        <aside class="mobile-drawer-panel" role="dialog" aria-modal="true" aria-label="All Sovereign Finance modules">
          <div class="mobile-drawer-handle" aria-hidden="true"></div>
          <div class="mobile-drawer-head">
            <div>
              <div class="mobile-drawer-kicker">Sovereign Finance</div>
              <div class="mobile-drawer-title">All Modules</div>
            </div>
            <button class="mobile-drawer-close" type="button" aria-label="Close modules" data-drawer-close="true">×</button>
          </div>
          <div class="mobile-drawer-pill">
            <span class="mobile-drawer-pulse"></span>
            <span>Real data mode · no demo values</span>
          </div>
          <div class="mobile-drawer-layers">
            ${NAV_GROUPS.map(group => drawerGroupHTML(group, path)).join('')}
          </div>
        </aside>
      </div>
    `;
  }

  function shellHTML(path) {
    const active = getActiveItem(path);
    const meta = getActiveMeta(path);

    return `
      <section class="sov-app-shell" data-shell-page="${active.key}" data-shell-version="${VERSION}" aria-label="Page identity">
        <div class="sov-shell-orb" aria-hidden="true">${active.emoji}</div>
        <div class="sov-shell-main">
          <div class="sov-shell-eyebrow">${meta.eyebrow}</div>
          <h1 class="sov-shell-title">${meta.title}</h1>
          <p class="sov-shell-purpose">${meta.purpose}</p>
        </div>
        <div class="sov-shell-proof">
          <div class="sov-shell-proof-pill">
            <span class="sov-shell-pulse"></span>
            <span>Real data mode</span>
          </div>
          <div class="sov-shell-proof-line">${meta.proof}</div>
          <div class="sov-shell-next">${meta.next}</div>
        </div>
      </section>
    `;
  }

  function injectMobileBottomNavGuard() {
    const existing = document.getElementById(MOBILE_STYLE_ID);
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.id = MOBILE_STYLE_ID;
    style.textContent = `
      @media (max-width: 860px) {
        html { min-height: 100%; }

        body {
          min-height: 100%;
          padding-bottom: calc(96px + env(safe-area-inset-bottom)) !important;
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
        .bottom-nav,
        .mobile-module-toggle,
        .mobile-module-drawer {
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
        from { opacity: 0; transform: translateX(-14px) scale(0.985); filter: saturate(0.92); }
        to { opacity: 1; transform: translateX(0) scale(1); filter: saturate(1); }
      }

      @keyframes sov-rail-pulse {
        0%, 100% { box-shadow: 0 0 0 rgba(34, 197, 94, 0); }
        50% { box-shadow: 0 0 20px rgba(34, 197, 94, 0.36); }
      }

      @keyframes sov-drawer-rise {
        from { opacity: 0; transform: translateY(20px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes sov-shell-rise {
        from { opacity: 0; transform: translateY(-8px) scale(0.992); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      :root { --sov-theme-safe-top: 52px; }

      header,
      .topbar,
      .app-header,
      .page-header {
        position: relative;
        z-index: 120;
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

      @media (min-width: 1200px) {
        body { padding-left: 332px !important; }

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

        .desktop-nav-brand-copy { min-width: 0; }

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
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.24), rgba(34, 197, 94, 0.10)) !important;
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

      .sov-app-shell {
        position: relative;
        z-index: 40;
        width: min(1120px, calc(100% - 32px));
        margin: clamp(22px, 4vw, 42px) auto 18px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) minmax(260px, 0.78fr);
        align-items: center;
        gap: 16px;
        padding: 16px;
        border-radius: 28px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background:
          radial-gradient(circle at 7% 0%, rgba(34, 197, 94, 0.16), transparent 15rem),
          radial-gradient(circle at 100% 0%, rgba(59, 130, 246, 0.12), transparent 14rem),
          rgba(255, 255, 255, 0.72);
        box-shadow:
          0 18px 50px rgba(15, 23, 42, 0.10),
          inset 0 1px 0 rgba(255, 255, 255, 0.70);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        animation: sov-shell-rise 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
        isolation: isolate;
      }

      .sov-app-shell::before {
        content: "";
        position: absolute;
        inset: -14px -10px auto -10px;
        height: var(--sov-theme-safe-top);
        pointer-events: none;
        z-index: -1;
      }

      .sov-shell-orb {
        width: 58px;
        height: 58px;
        display: grid;
        place-items: center;
        border-radius: 22px;
        background:
          radial-gradient(circle at 35% 20%, rgba(255, 255, 255, 0.90), transparent 2.8rem),
          linear-gradient(135deg, rgba(34, 197, 94, 0.22), rgba(59, 130, 246, 0.14));
        box-shadow:
          0 14px 32px rgba(34, 197, 94, 0.14),
          inset 0 1px 0 rgba(255, 255, 255, 0.78);
        font-size: 27px;
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

      .sov-shell-proof-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        border-radius: 999px;
        color: #047857;
        background: rgba(34, 197, 94, 0.10);
        border: 1px solid rgba(34, 197, 94, 0.18);
        font-size: 11px;
        font-weight: 950;
      }

      .sov-shell-pulse {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #22c55e;
        animation: sov-rail-pulse 2.4s ease-in-out infinite;
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

      @media (min-width: 1600px) {
        body { padding-left: 352px !important; }
        .desktop-nav { left: 30px !important; width: 292px !important; }
      }

      @media (min-width: 1200px) and (max-height: 820px) {
        .desktop-nav {
          top: 16px !important;
          max-height: calc(100vh - 32px) !important;
          gap: 7px !important;
          padding: 12px !important;
        }

        .desktop-nav-brand { padding-bottom: 0; }

        .desktop-nav-mark {
          width: 36px;
          height: 36px;
          flex-basis: 36px;
          border-radius: 14px;
        }

        .desktop-nav-name { font-size: 15px; }
        .desktop-nav-system-pill { padding: 5px 9px; font-size: 10px; }
        .desktop-nav-layer { padding: 6px; border-radius: 18px; }
        .desktop-nav-layer-title { margin-bottom: 4px; font-size: 8px; }

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

      @media (max-width: 980px) {
        .sov-app-shell { grid-template-columns: auto minmax(0, 1fr); }
        .sov-shell-proof { grid-column: 1 / -1; }
      }

      @media (max-width: 860px) {
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
          font-size: 23px;
        }

        .sov-shell-title {
          font-size: 26px;
          letter-spacing: -0.055em;
        }

        .sov-shell-purpose { font-size: 12.5px; }

        .mobile-module-toggle {
          position: fixed;
          right: 14px;
          bottom: calc(86px + env(safe-area-inset-bottom));
          z-index: 2410;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-width: 66px;
          height: 42px;
          padding: 0 13px;
          border: 1px solid rgba(148, 163, 184, 0.35);
          border-radius: 999px;
          color: #ecfdf5;
          background:
            radial-gradient(circle at 30% 0%, rgba(134, 239, 172, 0.24), transparent 5rem),
            rgba(15, 23, 42, 0.94);
          box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          font-weight: 950;
          letter-spacing: -0.02em;
        }

        .mobile-module-toggle-icon { font-size: 15px; line-height: 1; }
        .mobile-module-toggle-text { font-size: 12px; line-height: 1; }

        .mobile-module-drawer {
          position: fixed;
          inset: 0;
          z-index: 3000;
          display: none;
          pointer-events: none;
        }

        .mobile-module-drawer.open {
          display: block;
          pointer-events: auto;
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
          animation: sov-drawer-rise 360ms cubic-bezier(0.16, 1, 0.3, 1) both;
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
          font-weight: 500;
        }

        .mobile-drawer-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin: 0 4px 10px;
          padding: 7px 10px;
          border-radius: 999px;
          color: #bbf7d0;
          background: rgba(34, 197, 94, 0.10);
          border: 1px solid rgba(134, 239, 172, 0.16);
          font-size: 11px;
          font-weight: 900;
        }

        .mobile-drawer-pulse {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #22c55e;
          animation: sov-rail-pulse 2.4s ease-in-out infinite;
        }

        .mobile-drawer-layers {
          display: flex;
          flex-direction: column;
          gap: 9px;
        }

        .mobile-drawer-layer {
          padding: 9px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.045);
          border: 1px solid rgba(255, 255, 255, 0.055);
        }

        .mobile-drawer-layer-title {
          margin: 0 4px 7px;
          color: rgba(203, 213, 225, 0.72);
          font-size: 9px;
          line-height: 1;
          font-weight: 1000;
          text-transform: uppercase;
          letter-spacing: 0.15em;
        }

        .mobile-drawer-layer-grid {
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
          box-shadow: 0 10px 28px rgba(34, 197, 94, 0.14);
        }

        .mobile-drawer-icon {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border-radius: 11px;
          background: rgba(255, 255, 255, 0.075);
          font-size: 15px;
          line-height: 1;
        }

        .mobile-drawer-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .mobile-drawer-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: transparent;
        }

        .mobile-drawer-item.active .mobile-drawer-dot {
          background: #86efac;
          box-shadow: 0 0 14px rgba(134, 239, 172, 0.70);
        }
      }

      @media (max-width: 420px) {
        .mobile-drawer-layer-grid { grid-template-columns: 1fr; }
      }

      @media (prefers-reduced-motion: reduce) {
        .desktop-nav,
        .sov-app-shell,
        .mobile-drawer-panel,
        .desktop-nav-pulse,
        .sov-shell-pulse,
        .mobile-drawer-pulse {
          animation: none !important;
          transition: none !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function injectPremiumCardSystem() {
    const existing = document.getElementById(CARD_STYLE_ID);
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.id = CARD_STYLE_ID;
    style.textContent = `
      @keyframes sov-card-rise {
        from {
          opacity: 0;
          transform: translateY(12px) scale(0.992);
          filter: saturate(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
          filter: saturate(1);
        }
      }

      @keyframes sov-card-sheen {
        from { transform: translateX(-120%) rotate(10deg); opacity: 0; }
        35% { opacity: 0.55; }
        to { transform: translateX(220%) rotate(10deg); opacity: 0; }
      }

      .sov-card-upgraded {
        position: relative;
        overflow: hidden;
        isolation: isolate;
        border-radius: clamp(20px, 2.2vw, 30px) !important;
        border: 1px solid rgba(148, 163, 184, 0.22) !important;
        background:
          radial-gradient(circle at 12% 0%, rgba(34, 197, 94, 0.105), transparent 14rem),
          radial-gradient(circle at 100% 10%, rgba(59, 130, 246, 0.08), transparent 13rem),
          rgba(255, 255, 255, 0.78) !important;
        box-shadow:
          0 18px 48px rgba(15, 23, 42, 0.095),
          inset 0 1px 0 rgba(255, 255, 255, 0.74) !important;
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        transform: translateZ(0);
        animation: sov-card-rise 460ms cubic-bezier(0.16, 1, 0.3, 1) both;
        animation-delay: calc(var(--sov-card-index, 0) * 38ms);
        transition:
          transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1),
          border-color 240ms cubic-bezier(0.16, 1, 0.3, 1),
          background 240ms cubic-bezier(0.16, 1, 0.3, 1) !important;
      }

      .sov-card-upgraded::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: -1;
        border-radius: inherit;
        background:
          linear-gradient(135deg, rgba(255, 255, 255, 0.52), transparent 38%),
          radial-gradient(circle at 20% 0%, rgba(255, 255, 255, 0.36), transparent 11rem);
      }

      .sov-card-upgraded::after {
        content: "";
        position: absolute;
        top: -30%;
        left: -40%;
        width: 34%;
        height: 160%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.46), transparent);
        transform: translateX(-120%) rotate(10deg);
        opacity: 0;
      }

      .sov-card-upgraded:hover {
        transform: translateY(-3px) scale(1.006);
        border-color: rgba(34, 197, 94, 0.24) !important;
        box-shadow:
          0 24px 64px rgba(15, 23, 42, 0.13),
          0 0 0 1px rgba(34, 197, 94, 0.06),
          inset 0 1px 0 rgba(255, 255, 255, 0.82) !important;
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

      .sov-card-upgraded table {
        border-collapse: separate;
        border-spacing: 0;
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
        letter-spacing: 0.02em;
        pointer-events: none;
      }

      .sov-card-proof-dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: #22c55e;
        box-shadow: 0 0 14px rgba(34, 197, 94, 0.42);
      }

      .sov-card-upgraded.sov-card-has-proof {
        padding-top: max(var(--sov-original-padding-top, 0px), 18px);
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
            inset 0 1px 0 rgba(255, 255, 255, 0.72) !important;
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

  function replaceMobileDrawer(path) {
    document.querySelectorAll('.mobile-module-toggle, .mobile-module-drawer').forEach(node => node.remove());
    document.body.insertAdjacentHTML('beforeend', drawerHTML(path));
  }

  function replaceAppShell(path) {
    document.querySelectorAll('.sov-app-shell').forEach(node => node.remove());
    const header = document.querySelector('header');
    const html = shellHTML(path);

    if (header) {
      header.insertAdjacentHTML('afterend', html);
      return;
    }

    const main = document.querySelector('main, .wrap, .container');
    if (main) {
      main.insertAdjacentHTML('beforebegin', html);
      return;
    }

    document.body.insertAdjacentHTML('afterbegin', html);
  }

  function setHeaderTitle(path) {
    const titleEl = document.querySelector('header .title');
    if (!titleEl) return;

    const active = getActiveItem(path);
    titleEl.textContent = active.label;
  }

  function markBodyPage(path) {
    const active = getActiveItem(path);

    if (active) {
      document.documentElement.setAttribute('data-page', active.key);
      document.body.setAttribute('data-page', active.key);
    }
  }

  function enhanceExistingCards() {
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

    const ignored = [
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

    const nodes = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(node => {
        if (!node || node.nodeType !== 1) return false;
        if (node.classList.contains('sov-card-upgraded')) return false;
        return !ignored.some(selector => node.matches(selector));
      });

    nodes.forEach((node, index) => {
      node.classList.add('sov-card-upgraded');
      node.style.setProperty('--sov-card-index', String(Math.min(index, 14)));

      const hasActionForm = node.querySelector('form, input, select, textarea, button');
      const hasTable = node.querySelector('table');
      const hasMoneySignal = /\b(rs|pkr|balance|amount|paid|due|owed|cash|salary|bill|debt|goal|transaction|snapshot|audit)\b/i.test(node.textContent || '');

      if ((hasMoneySignal || hasTable) && !hasActionForm && !node.querySelector('.sov-card-proof-badge')) {
        const badge = document.createElement('div');
        badge.className = 'sov-card-proof-badge';
        badge.innerHTML = '<span class="sov-card-proof-dot"></span><span>Real data</span>';
        node.classList.add('sov-card-has-proof');
        node.insertAdjacentElement('afterbegin', badge);
      }
    });
  }

  function observeCards() {
    const main = document.querySelector('main, .wrap, .container, body');
    if (!main) return;

    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(enhanceExistingCards, 80);
    });

    observer.observe(main, {
      childList: true,
      subtree: true
    });

    window.SOV_CARD_OBSERVER = observer;
  }

  function setDrawerOpen(isOpen) {
    const drawer = document.getElementById(DRAWER_ID);
    const toggle = document.getElementById(DRAWER_TOGGLE_ID);

    if (!drawer || !toggle) return;

    drawer.classList.toggle('open', isOpen);
    drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    document.documentElement.classList.toggle('mobile-drawer-open', isOpen);
  }

  function bindDrawerEvents() {
    const drawer = document.getElementById(DRAWER_ID);
    const toggle = document.getElementById(DRAWER_TOGGLE_ID);

    if (!drawer || !toggle) return;

    toggle.addEventListener('click', () => {
      setDrawerOpen(!drawer.classList.contains('open'));
    });

    drawer.querySelectorAll('[data-drawer-close="true"]').forEach(node => {
      node.addEventListener('click', () => setDrawerOpen(false));
    });

    drawer.querySelectorAll('.mobile-drawer-item').forEach(node => {
      node.addEventListener('click', () => setDrawerOpen(false));
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') setDrawerOpen(false);
    });
  }

  function initNav() {
    const path = currentPath();

    injectMobileBottomNavGuard();
    injectPremiumRailStyle();
    injectPremiumCardSystem();
    replaceDesktopNav(path);
    replaceAppShell(path);
    replaceBottomNav(path);
    replaceMobileDrawer(path);
    setHeaderTitle(path);
    markBodyPage(path);
    bindDrawerEvents();
    enhanceExistingCards();
    observeCards();

    window.SOV_NAV = {
      version: VERSION,
      items: NAV_ITEMS.slice(),
      groups: NAV_GROUPS.slice(),
      pageMeta: Object.assign({}, PAGE_META),
      bottomKeys: BOTTOM_KEYS.slice(),
      activePath: path,
      activeItem: getActiveItem(path),
      activeMeta: getActiveMeta(path),
      mobileGuard: MOBILE_STYLE_ID,
      premiumRail: PREMIUM_STYLE_ID,
      cardSystem: CARD_STYLE_ID,
      mobileDrawer: DRAWER_ID,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      enhanceCards: enhanceExistingCards
    };

    console.log('[nav ' + VERSION + '] loaded', path);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
