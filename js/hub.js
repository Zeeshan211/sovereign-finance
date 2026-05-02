/* ─── Sovereign Finance · Hub Live Numbers v0.1.0 ─── */

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

    setText('hub-net-worth', fmt(netWorth));
    setClass('hub-net-worth', netWorth >= 0 ? 'nw-value positive' : 'nw-value negative');

    setText('hub-liquid', fmt(liquid));
    setText('hub-cc', fmt(cc));
    setText('hub-debts', fmt(personalDebts));
    setText('hub-burden', fmt(trueBurden));
    setClass('hub-burden', trueBurden >= 0 ? 'stat-value accent' : 'stat-value danger');
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function setClass(id, cls) {
    const el = document.getElementById(id);
    if (el) el.className = cls;
  }

  function fmt(n) {
    return Math.round(n).toLocaleString('en-US');
  }
})();
