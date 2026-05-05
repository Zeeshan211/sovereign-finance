/* ─── Sovereign Finance · Hub Bootstrap v0.7.5d · REAL ID FIX ─── */
/* Renders hero KPIs from /api/balances on home page */
/*
 * Changes vs v0.7.5c (broken — wrong IDs from wrong repo):
 *   - Real IDs verified live from deployed index.html via Console fetch:
 *       hub-net-worth (was wrongly kpi-net)
 *       hub-liquid    (was wrongly kpi-liquid)
 *       hub-cc        (was wrongly kpi-cc)
 *       hub-debts     (was wrongly kpi-debts)
 *   - REMOVED tile rendering (page has nav-grid with nav-card items already in HTML —
 *     no quickAccessGrid element exists)
 *   - REMOVED dynamic subtitle update (no [data-subtitle] elements exist)
 *   - Pattern 7 fix #3 (final): read DEPLOYED index.html, not assumed file from another repo
 *
 * Element IDs verified via:
 *   fetch('/?cb=...').then(r=>r.text()).then(t=>t.match(/id="[^"]+"/g))
 *   Returned: dayNum, hub-net-worth, hub-liquid, hub-cc, hub-debts, hub-burden,
 *             hub-recent-tx, hub-top-debts, hub-due-soon
 *
 * SCOPE: KPI hero rendering only. Other hub elements (recent tx, top debts, due soon,
 * burden, dayNum) NOT rendered by this ship — separate work if those need wiring.
 */

(function () {
  'use strict';

  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs —';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
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

      console.log('[hub] KPIs rendered · net:', d.net_worth, '· liquid:', d.total_liquid_assets, '· cc:', d.cc_outstanding, '· debts:', d.total_debts);
    } catch (e) {
      console.warn('[hub] loadBalances threw:', e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadBalances);
  } else {
    loadBalances();
  }
})();
