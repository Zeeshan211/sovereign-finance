/* ─── Sovereign Finance · Dynamic Navigation v0.8.0 ─── */
/* Single source of truth for sidebar AND bottom nav.
   Add a new page = add ONE entry here. Done. */

(function () {
  const NAV_ITEMS = [
    { href: '/',                  emoji: '🏠', short: 'Hub',      long: 'Hub',             matchExact: true },
    { href: '/add.html',          emoji: '➕', short: 'Add',      long: 'Add Transaction' },
    { href: '/transactions.html', emoji: '💸', short: 'Tx',       long: 'Transactions' },
    { href: '/accounts.html',     emoji: '🏦', short: 'Accounts', long: 'Accounts' },
    { href: '/debts.html',        emoji: '💳', short: 'Debts',    long: 'Debts' },
    { href: '/bills.html',        emoji: '📅', short: 'Bills',    long: 'Bills' }
  ];

  const BOTTOM_NAV_LIMIT = 5; // first N items show on mobile bottom nav

  function currentPath() {
    return window.location.pathname.replace(/\/index\.html$/, '/');
  }

  function isActive(item) {
    const path = currentPath();
    if (item.matchExact) return path === item.href;
    if (item.href === '/') return path === '/';
    // /edit.html should highlight Transactions
    if (path === '/edit.html' && item.href === '/transactions.html') return true;
    return path === item.href;
  }

  function buildSidebar() {
    const old = document.querySelector('.desktop-nav');
    if (old) old.remove();

    const aside = document.createElement('aside');
    aside.className = 'desktop-nav';
    NAV_ITEMS.forEach(item => {
      const a = document.createElement('a');
      a.href = item.href;
      a.className = 'desktop-nav-item' + (isActive(item) ? ' active' : '');
      a.innerHTML = `<span class="nav-emoji">${item.emoji}</span><span class="nav-text">${item.long}</span>`;
      aside.appendChild(a);
    });
    document.body.appendChild(aside);
  }

  function buildBottomNav() {
    const old = document.querySelector('.bottom-nav');
    if (old) old.remove();

    const nav = document.createElement('nav');
    nav.className = 'bottom-nav';
    const inner = document.createElement('div');
    inner.className = 'bottom-nav-inner';

    NAV_ITEMS.slice(0, BOTTOM_NAV_LIMIT).forEach(item => {
      const a = document.createElement('a');
      a.href = item.href;
      a.className = 'nav-item' + (isActive(item) ? ' active' : '');
      a.innerHTML = `<div class="nav-emoji">${item.emoji}</div><div class="nav-text">${item.short}</div>`;
      inner.appendChild(a);
    });
    nav.appendChild(inner);
    document.body.appendChild(nav);
  }

  function build() {
    buildSidebar();
    buildBottomNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  window.nav = { items: NAV_ITEMS.slice(), refresh: build };
})();
