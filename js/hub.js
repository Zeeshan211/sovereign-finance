/* ─── Sovereign Finance · Hub Bootstrap v0.7.5c · KPI render restored ─── */
/* Renders Quick Access tiles + hero KPIs from /api/balances */
/*
 * Changes vs v0.7.5b (broken — removed only KPI renderer):
 *   - Restored loadBalances() with VERIFIED element IDs from index.html live read:
 *       kpi-net (was wrongly netWorthValue in v0.7.5)
 *       kpi-liquid (was wrongly liquidValue)
 *       kpi-cc (was wrongly ccValue)
 *       kpi-debts (was wrongly debtsValue)
 *   - Pattern 7 fix #2: read index.html before assuming element IDs
 *   - Removed comment claiming "index.html has inline loadKpis" (it does NOT)
 *
 * Element IDs verified live in index.html sections:
 *   <div class="kpi-value" id="kpi-net">Rs —</div>
 *   <div class="kpi-value" id="kpi-liquid">Rs —</div>
 *   <div class="kpi-value" id="kpi-cc">Rs —</div>
 *   <div class="kpi-value" id="kpi-debts">Rs —</div>
 *
 * PRESERVED:
 *   - Quick Access tile rendering
 *   - Dynamic Accounts/Debts subtitles
 *   - Defensive null checks
 */

(function () {
  'use strict';

  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs —';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

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
        console.warn('[hub] loadBalances failed: HTTP ' + r.status);
        return;
      }
      const d = await r.json();
      if (!d.ok) {
        console.warn('[hub] loadBalances failed:', d.error);
        return;
      }

      // Hero KPIs (verified IDs from index.html live read)
      const netEl = document.getElementById('kpi-net');
      if (netEl) netEl.textContent = fmtPKR(d.net_worth);

      const liquidEl = document.getElementById('kpi-liquid');
      if (liquidEl) liquidEl.textContent = fmtPKR(d.total_liquid_assets);

      const ccEl = document.getElementById('kpi-cc');
      if (ccEl) ccEl.textContent = fmtPKR(Math.abs(d.cc_outstanding));

      const debtsEl = document.getElementById('kpi-debts');
      if (debtsEl) debtsEl.textContent = fmtPKR(d.total_debts || d.total_owe || 0);

      // Dynamic tile subtitles
      const accountsSub = document.querySelector('[data-subtitle="accounts"]');
      if (accountsSub && d.account_count != null) {
        accountsSub.textContent = d.account_count + ' active';
      }

      const debtsSub = document.querySelector('[data-subtitle="debts"]');
      if (debtsSub && d.debt_count != null) {
        debtsSub.textContent = d.debt_count + ' active';
      }

    } catch (e) {
      console.warn('[hub] loadBalances threw:', e.message);
    }
  }

  function init() {
    renderTiles();
    loadBalances();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
