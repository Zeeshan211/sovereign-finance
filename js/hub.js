/* ─── Sovereign Finance · Hub v0.5.0 with animated counters ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    paint();
    await Promise.all([
      window.store.refreshBalances(),
      window.store.refreshDebts()
    ]);
    paint();
  }

  function paint() {
    const b = window.store.balances;
    const d = window.store.debts;

    const netWorth = b.net_worth || 0;
    const liquid = b.total_assets || 0;
    const cc = b.cc_outstanding || 0;
    const personalDebts = d.total_owe || 0;
    const trueBurden = netWorth - personalDebts;

    animate('hub-net-worth', netWorth);
    setClass('hub-net-worth', netWorth >= 0 ? 'nw-value positive counter' : 'nw-value negative counter');

    animate('hub-liquid', liquid);
    animate('hub-cc', cc);
    animate('hub-debts', personalDebts);
    animate('hub-burden', trueBurden);
    setClass('hub-burden', trueBurden >= 0 ? 'stat-value accent counter' : 'stat-value danger counter');
  }

  function animate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.animateNumber) {
      window.animateNumber(el, val);
    } else {
      el.textContent = Math.round(val).toLocaleString('en-US');
    }
  }

  function setClass(id, cls) {
    const el = document.getElementById(id);
    if (el) el.className = cls;
  }
})();