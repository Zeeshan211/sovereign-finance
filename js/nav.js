/* ─── Sovereign Finance · nav.js v1.0.1 · Layer 3 shared navigation ─── */
/*
 * Purpose:
 *   One navigation source for the whole app.
 *
 * Fixes:
 *   - Goals exists but was missing from shared nav.
 *   - Charts exists and stays discoverable.
 *   - Pages with old hardcoded nav get normalized at runtime.
 *
 * Contract:
 *   - Replaces existing .desktop-nav and .bottom-nav if present.
 *   - Injects nav if a page forgot it.
 *   - Active state is based on current pathname.
 *   - No ledger/API writes.
 */

(function () {
  'use strict';

  const VERSION = 'v1.0.1';

  const NAV_ITEMS = [
    { key: 'hub', label: 'Hub', short: 'Hub', href: '/', aliases: ['/index.html'], emoji: '🏠' },
    { key: 'add', label: 'Add Transaction', short: 'Add', href: '/add.html', aliases: [], emoji: '➕' },
    { key: 'transactions', label: 'Transactions', short: 'Tx', href: '/transactions.html', aliases: [], emoji: '📜' },
    { key: 'accounts', label: 'Accounts', short: 'Accts', href: '/accounts.html', aliases: [], emoji: '🏦' },
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

  const BOTTOM_KEYS = ['hub', 'add', 'transactions', 'bills', 'charts'];

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

    replaceDesktopNav(path);
    replaceBottomNav(path);
    setHeaderTitle(path);
    markBodyPage(path);

    window.SOV_NAV = {
      version: VERSION,
      items: NAV_ITEMS.slice(),
      bottomKeys: BOTTOM_KEYS.slice(),
      activePath: path
    };

    console.log('[nav ' + VERSION + '] loaded', path);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
