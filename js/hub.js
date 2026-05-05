/* ─── Sovereign Finance · Hub Bootstrap v0.7.5b · Polish FIX ─── */
/* Renders Quick Access tiles + dynamic subtitle counts */
/*
 * Changes vs v0.7.5 (broken):
 *   - REMOVED loadBalances() KPI rendering — that's index.html's inline loadKpis() job
 *     (was using wrong element IDs: netWorthValue/liquidValue/ccValue/debtsValue
 *      should have been kpi-net/kpi-liquid/kpi-cc/kpi-debts per index.html)
 *   - hub.js now ONLY does: render Quick Access tiles + update tile subtitles from /api/balances
 *   - No conflict with inline loadKpis() — both fetch same endpoint independently
 *   - Pattern 7 fix: read index.html before assuming element IDs
 *
 * PRESERVED from v0.7.5 intent:
 *   - Dynamic Accounts subtitle from d.account_count
 *   - Dynamic Debts subtitle from d.debt_count
 *   - Falls back to default subtitle if API unreachable
 */

(function () {
  'use strict';

  // Quick Access tile data (matches existing index.html structure)
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

  async function updateSubtitles() {
    try {
      const r = await fetch('/api/balances', { cache: 'no-store' });
      if (!r.ok) {
        console.warn('[hub] subtitle update failed: HTTP ' + r.status);
        return;
      }
      const d = await r.json();
      if (!d.ok) {
        console.warn('[hub] subtitle update failed:', d.error);
        return;
      }

      // Dynamic Accounts subtitle (was hardcoded "11 active")
      const accountsSub = document.querySelector('[data-subtitle="accounts"]');
      if (accountsSub && d.account_count != null) {
        accountsSub.textContent = d.account_count + ' active';
      }

      // Dynamic Debts subtitle
      const debtsSub = document.querySelector('[data-subtitle="debts"]');
      if (debtsSub && d.debt_count != null) {
        debtsSub.textContent = d.debt_count + ' active';
      }

    } catch (e) {
      console.warn('[hub] updateSubtitles threw:', e.message);
    }
  }

  // Init on DOMContentLoaded
  function init() {
    renderTiles();
    updateSubtitles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
