/* ─── Sovereign Finance · Hub Bootstrap v0.7.9 · true_burden parity ─── */
/* Renders hero KPIs + freshness + Recent Tx + Top Debts + Due Soon */
/*
 * Changes vs v0.7.8:
 *   - hub-burden now renders /api/balances.true_burden directly
 *   - hub-liquid prefers total_liquid, with total_liquid_assets fallback
 *   - hub-debts prefers total_owed, with legacy fallbacks
 *
 * Ground Zero rule:
 *   Hub must display formula-layer truth from /api/balances.
 *   It must not rebuild finance formulas locally.
 */

(function () {
  'use strict';

  let lastFetchedAt = null;

  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs —';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

  function fmtAgo(ms) {
    if (!ms) return 'just now';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    return day + 'd ago';
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-PK', { month: 'short', day: 'numeric' });
    } catch (e) {
      return dateStr.slice(0, 10);
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function firstNumber() {
    for (let i = 0; i < arguments.length; i++) {
      const n = Number(arguments[i]);
      if (!Number.isNaN(n)) return n;
    }
    return 0;
  }

  function updateFreshnessLabel() {
    const el = document.getElementById('hub-freshness');
    if (!el || !lastFetchedAt) return;

    const ago = Date.now() - lastFetchedAt;
    el.textContent = 'Live · ' + fmtAgo(ago);
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

      const netWorth = firstNumber(d.net_worth);
      const totalLiquid = firstNumber(d.total_liquid, d.total_liquid_assets, d.cash_accessible, d.total_assets);
      const ccOutstanding = firstNumber(d.cc_outstanding, d.cc);
      const totalOwed = firstNumber(d.total_owed, d.total_debts, d.total_owe);
      const trueBurden = firstNumber(d.true_burden);

      const netEl = document.getElementById('hub-net-worth');
      if (netEl) netEl.textContent = fmtPKR(netWorth);

      const liquidEl = document.getElementById('hub-liquid');
      if (liquidEl) liquidEl.textContent = fmtPKR(totalLiquid);

      const ccEl = document.getElementById('hub-cc');
      if (ccEl) ccEl.textContent = fmtPKR(Math.abs(ccOutstanding));

      const debtsEl = document.getElementById('hub-debts');
      if (debtsEl) debtsEl.textContent = fmtPKR(totalOwed);

      const burdenEl = document.getElementById('hub-burden');
      if (burdenEl) burdenEl.textContent = fmtPKR(trueBurden);

      lastFetchedAt = Date.now();
      updateFreshnessLabel();
    } catch (e) {
      console.warn('[hub] loadBalances threw:', e.message);
    }
  }

  async function loadRecentTx() {
    const el = document.getElementById('hub-recent-tx');
    if (!el) return;

    el.innerHTML = '<div class="dense-row"><span class="label">Loading…</span></div>';

    try {
      const r = await fetch('/api/transactions', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);

      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'fetch failed');

      const txns = (d.transactions || [])
        .filter(t => !t.reversed_at && !t.reversed_by)
        .slice(0, 5);

      if (txns.length === 0) {
        el.innerHTML = '<div class="dense-row"><span class="label">No transactions yet.</span></div>';
        return;
      }

      el.innerHTML = txns.map(t => {
        const isExpense = ['expense', 'cc_spend', 'cc_payment', 'repay', 'debt_out', 'atm', 'transfer'].includes(t.type);
        const cls = isExpense ? 'value danger' : 'value';
        const sign = isExpense ? '-' : '+';
        const label = escapeHtml(t.notes || t.category_id || t.type || 'Transaction');
        const meta = fmtDate(t.date) + ' · ' + (t.account_id || '');

        return `<div class="dense-row">
          <div>
            <span class="label">${label}</span>
            <span class="meta">${meta}</span>
          </div>
          <span class="${cls}">${sign}${fmtPKR(t.amount).replace('Rs ', 'Rs ')}</span>
        </div>`;
      }).join('');
    } catch (e) {
      console.warn('[hub] loadRecentTx failed:', e.message);
      el.innerHTML = '<div class="dense-row"><span class="label">Could not load.</span></div>';
    }
  }

  async function loadTopDebts() {
    const el = document.getElementById('hub-top-debts');
    if (!el) return;

    el.innerHTML = '<div class="dense-row"><span class="label">Loading…</span></div>';

    try {
      const r = await fetch('/api/debts', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);

      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'fetch failed');

      const debts = (d.debts || [])
        .filter(x => x.status === 'active')
        .map(x => ({
          ...x,
          outstanding: (Number(x.original_amount) || 0) - (Number(x.paid_amount) || 0)
        }))
        .filter(x => x.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, 3);

      if (debts.length === 0) {
        el.innerHTML = '<div class="dense-row"><span class="label">No active debts.</span></div>';
        return;
      }

      el.innerHTML = debts.map(x => {
        const label = escapeHtml(x.name || 'Debt');
        const kind = escapeHtml(x.kind || '');

        return `<div class="dense-row">
          <div>
            <span class="label">${label}</span>
            <span class="meta">${kind}</span>
          </div>
          <span class="value danger">${fmtPKR(x.outstanding)}</span>
        </div>`;
      }).join('');
    } catch (e) {
      console.warn('[hub] loadTopDebts failed:', e.message);
      el.innerHTML = '<div class="dense-row"><span class="label">Could not load.</span></div>';
    }
  }

  async function loadDueSoon() {
    const el = document.getElementById('hub-due-soon');
    if (!el) return;

    el.innerHTML = '<div class="dense-row"><span class="label">Loading…</span></div>';

    try {
      const r = await fetch('/api/bills', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);

      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'fetch failed');

      const today = new Date();
      const todayDay = today.getDate();
      const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

      const bills = (d.bills || [])
        .filter(b => b.status === 'active' && b.due_day != null)
        .map(b => {
          let daysUntil = b.due_day - todayDay;
          if (daysUntil < 0) daysUntil += daysInMonth;
          return { ...b, daysUntil };
        })
        .filter(b => b.daysUntil <= 7)
        .sort((a, b) => a.daysUntil - b.daysUntil)
        .slice(0, 5);

      if (bills.length === 0) {
        el.innerHTML = '<div class="dense-row"><span class="label">Nothing due in next 7 days.</span></div>';
        return;
      }

      el.innerHTML = bills.map(b => {
        const label = escapeHtml(b.name || 'Bill');
        const meta = b.daysUntil === 0
          ? 'Due today'
          : (b.daysUntil === 1 ? 'Due tomorrow' : 'Due in ' + b.daysUntil + ' days');
        const cls = b.daysUntil <= 2 ? 'value danger' : 'value warn';

        return `<div class="dense-row">
          <div>
            <span class="label">${label}</span>
            <span class="meta">${meta}</span>
          </div>
          <span class="${cls}">${fmtPKR(b.amount)}</span>
        </div>`;
      }).join('');
    } catch (e) {
      console.warn('[hub] loadDueSoon failed:', e.message);
      el.innerHTML = '<div class="dense-row"><span class="label">Could not load.</span></div>';
    }
  }

  function loadAll() {
    loadBalances();
    loadRecentTx();
    loadTopDebts();
    loadDueSoon();
  }

  function init() {
    loadAll();
    setInterval(updateFreshnessLabel, 30000);
    setInterval(loadAll, 120000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
