/* ─── Sovereign Finance · Hub Bootstrap v0.7.5 · Polish ─── */
/* Renders Quick Access tiles + loads live balances on home page */
/*
 * Changes vs v0.7.4:
 *   - Accounts hub card subtitle now dynamic from live data
 *   - Was hardcoded "11 active" — now reads d.account_count from /api/balances
 *   - Falls back to "Manage" if API unreachable (no broken display)
 *
 * PRESERVED from v0.7.4:
 *   - All other tile rendering
 *   - loadBalances logic, currency formatting
 *   - Day-N badge (separate ship to retire)
 */

(function () {
  'use strict';

  // Format PKR currency
  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs —';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

  // Quick Access tile data
  const tiles = [
    { id: 'add',          label: 'Add',           icon: '➕', href: '/add.html',          subtitle: 'New transaction' },
    { id: 'transactions', label: 'Transactions',  icon: '📋', href: '/transactions.html', subtitle: 'History' },
    { id: 'accounts',     label: 'Accounts',      icon: '🏦', href: '/accounts.html',     subtitle: 'Manage' },
    { id: 'debts',        label: 'Debts',         icon: '💸', href: '/debts.html',        subtitle: 'Track' },
    { id: 'bills',        label: 'Bills',         icon: '📄', href: '/bills.html',        subtitle: 'Recurring' },
    { id: 'cc',           label: 'CC Planner',    icon: '🪪', href: '/cc.html',           subtitle: 'Payoff' },
    { id: 'reconcile',    label: 'Reconcile',     icon: '⚖',  href: '/reconciliation.html', subtitle: 'Balance check' },
    { id: 'audit',        label: 'Audit',         icon: '📊', href: '/audit.html',        subtitle: 'Activity log' }
  ];

  function renderTiles() {
    const grid = document.getElementById('quickAccessGrid');
    if (!grid) return;
    grid.innerHTML = tiles.map(t => `
      <a href="${t.href}" class="qa-tile" data-tile="${t.id}">
        <div class="qa-icon">${t.icon}</div>
        <div class="qa-label">${t.label}</div>
        <div class="qa-subtitle" data-subtitle="${t.id}">${t.subtitle}</div>
      </a>
    `).join('');
  }

  async function loadBalances() {
    try {
      const r = await fetch('/api/balances', { cache: 'no-store' });
      if (!r.ok) {
        console.warn('[hub] loadBalances failed: HTTP ' + r.status + ' on /api/balances');
        return;
      }
      const d = await r.json();
      if (!d.ok) {
        console.warn('[hub] loadBalances failed:', d.error);
        return;
      }

      // Update hero stats
      const netWorthEl = document.getElementById('netWorthValue');
      if (netWorthEl) netWorthEl.textContent = fmtPKR(d.net_worth);

      const liquidEl = document.getElementById('liquidValue');
      if (liquidEl) liquidEl.textContent = fmtPKR(d.total_liquid_assets);

      const ccEl = document.getElementById('ccValue');
      if (ccEl) ccEl.textContent = fmtPKR(d.cc_outstanding);

      const debtsEl = document.getElementById('debtsValue');
      if (debtsEl) debtsEl.textContent = fmtPKR(d.total_debts || d.total_owe || 0);

      // Polish: dynamic accounts subtitle (was hardcoded "11 active")
      const accountsSub = document.querySelector('[data-subtitle="accounts"]');
      if (accountsSub && d.account_count != null) {
        accountsSub.textContent = d.account_count + ' active';
      }

      // Polish: dynamic debts subtitle if count available
      const debtsSub = document.querySelector('[data-subtitle="debts"]');
      if (debtsSub && d.debt_count != null) {
        debtsSub.textContent = d.debt_count + ' active';
      }

    } catch (e) {
      console.warn('[hub] loadBalances threw:', e.message);
    }
  }

  // Init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      renderTiles();
      loadBalances();
    });
  } else {
    renderTiles();
    loadBalances();
  }
})();
