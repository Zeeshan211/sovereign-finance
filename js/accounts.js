/* ─── Sovereign Finance · Accounts Page v0.5.0 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    paint();
    await window.store.refreshBalances();
    paint();
  }

  function paint() {
    const accounts = window.store.accounts || [];
    const b = window.store.balances || {};

    const assets = accounts.filter(a => a.type === 'asset');
    const liabilities = accounts.filter(a => a.type === 'liability');

    animate('acc-net-worth', b.net_worth || 0);
    setClass('acc-net-worth', (b.net_worth || 0) >= 0 ? 'nw-value positive counter' : 'nw-value negative counter');

    setText('acc-assets-total', fmt(b.total_assets || 0) + ' PKR');
    setText('acc-liabilities-total', fmt(b.total_liabilities || 0) + ' PKR');
    setText('acc-assets-count', 'Assets · ' + assets.length);
    setText('acc-liabilities-count', 'Liabilities · ' + liabilities.length);
    setText('acc-day-count', accounts.length + ' active');

    const assetsList = document.getElementById('acc-assets-list');
    const liabList = document.getElementById('acc-liabilities-list');
    if (assetsList) {
      assetsList.innerHTML = '';
      assets.forEach(a => assetsList.appendChild(buildRow(a)));
    }
    if (liabList) {
      liabList.innerHTML = '';
      liabilities.forEach(a => liabList.appendChild(buildRow(a)));
    }
  }

  function animate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.animateNumber) window.animateNumber(el, val);
    else el.textContent = fmt(val);
  }

  function buildRow(a) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const balance = a.balance || 0;
    let cls = 'zero';
    if (a.type === 'liability' && balance > 0) cls = 'negative';
    else if (balance > 0) cls = 'positive';
    else if (balance < 0) cls = 'negative';

    row.innerHTML = `
      <div class="account-left">
        <div class="account-icon">${a.icon || '🏦'}</div>
        <div class="account-info">
          <div class="account-name">${esc(a.name)}</div>
          <div class="account-kind">${esc(kindLabel(a.kind))}</div>
        </div>
      </div>
      <div class="account-balance ${cls}">${fmt(balance)}<span class="balance-currency">PKR</span></div>
    `;
    return row;
  }

  function kindLabel(k) {
    return ({
      cash: 'In hand', wallet: 'Mobile wallet', bank: 'Bank account',
      prepaid: 'Prepaid card', cc: 'Credit card'
    })[k] || (k || '');
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  function setClass(id, cls) { const el = document.getElementById(id); if (el) el.className = cls; }
})();