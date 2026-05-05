/* ─── Sovereign Finance · Hub Bootstrap v0.7.6 · Live freshness indicator ─── */
/* Renders hero KPIs + live "last updated" indicator from /api/balances */
/*
 * Changes vs v0.7.5d:
 *   - Added live freshness indicator (#hub-freshness) — replaces retired Day-N badge
 *   - Format: "Live · just now" / "Live · 5m ago" / "Live · 1h ago" / "Live · 2h ago"
 *   - Updates on every loadBalances() call
 *   - Auto-refresh every 30 seconds (lightweight, just re-fetches /api/balances)
 *
 * PRESERVED from v0.7.5d:
 *   - All 4 KPI renders with verified IDs (hub-net-worth, hub-liquid, hub-cc, hub-debts)
 *   - PKR formatting helper
 *   - Defensive null checks on every element
 *   - Console log on success for debugging
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

      const netEl = document.getElementById('hub-net-worth');
      if (netEl) netEl.textContent = fmtPKR(d.net_worth);

      const liquidEl = document.getElementById('hub-liquid');
      if (liquidEl) liquidEl.textContent = fmtPKR(d.total_liquid_assets);

      const ccEl = document.getElementById('hub-cc');
      if (ccEl) ccEl.textContent = fmtPKR(Math.abs(d.cc_outstanding));

      const debtsEl = document.getElementById('hub-debts');
      if (debtsEl) debtsEl.textContent = fmtPKR(d.total_debts || d.total_owe || 0);

      lastFetchedAt = Date.now();
      updateFreshnessLabel();

      console.log('[hub] KPIs rendered · net:', d.net_worth, '· liquid:', d.total_liquid_assets, '· cc:', d.cc_outstanding, '· debts:', d.total_debts);
    } catch (e) {
      console.warn('[hub] loadBalances threw:', e.message);
    }
  }

  function init() {
    loadBalances();
    // Refresh freshness label every 30 seconds without re-fetching
    setInterval(updateFreshnessLabel, 30000);
    // Re-fetch balances every 2 minutes (silent, just to keep data fresh on long views)
    setInterval(loadBalances, 120000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
