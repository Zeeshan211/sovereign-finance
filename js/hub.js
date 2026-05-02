/* ─── Sovereign Finance · Hub Dashboard v0.7.3 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let billsData = { bills: [] };

  async function init() {
    paint();
    await Promise.all([
      window.store.refreshBalances(),
      window.store.refreshDebts(),
      window.store.refreshTransactions(),
      loadBills()
    ]);
    paint();
  }

  async function loadBills() {
    try {
      const res = await fetch('/api/bills');
      const data = await res.json();
      if (data.ok) billsData = data;
    } catch (e) {}
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

    paintRecentTx();
    paintTopDebts();
    paintDueSoon();
  }

  function paintRecentTx() {
    const wrap = document.getElementById('hub-recent-tx');
    if (!wrap) return;
    const all = window.store.getCachedAll();
    const recent = all.slice(0, 8);
    wrap.innerHTML = '';
    if (recent.length === 0) {
      wrap.innerHTML = '<div class="empty-state-inline">No transactions yet.</div>';
      return;
    }
    recent.forEach(tx => {
      const acc = window.store.getAccount(tx.accountId);
      const cat = window.store.getCategory(tx.categoryId);
      const sign = tx.type === 'income' ? '+' : (tx.type === 'expense' ? '−' : '↔');
      const colorClass = tx.type === 'income' ? 'positive' : (tx.type === 'expense' ? 'negative' : 'neutral');
      const row = document.createElement('a');
      row.href = '/edit.html?id=' + encodeURIComponent(tx.id);
      row.className = 'tx-row tx-link';
      row.innerHTML = `
        <div class="tx-left">
          <div class="tx-icon">${cat.icon}</div>
          <div class="tx-info">
            <div class="tx-name">${esc(cat.name)}</div>
            <div class="tx-sub">${formatDateLabel(tx.date)} · ${acc.icon} ${esc(acc.name)}</div>
          </div>
        </div>
        <div class="tx-amount ${colorClass}">${sign} ${fmt(tx.amount)}<span class="tx-currency">PKR</span></div>
      `;
      wrap.appendChild(row);
    });
  }

  function paintTopDebts() {
    const wrap = document.getElementById('hub-top-debts');
    if (!wrap) return;
    const debts = ((window.store.debts && window.store.debts.debts) || [])
      .filter(d => d.kind === 'owe' && d.status === 'active')
      .sort((a, b) => (a.snowball_order || 99) - (b.snowball_order || 99))
      .slice(0, 3);
    wrap.innerHTML = '';
    if (debts.length === 0) {
      wrap.innerHTML = '<div class="empty-state-inline">No active debts. Mashallah.</div>';
      return;
    }
    debts.forEach((d, i) => {
      const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
      const pct = d.original_amount > 0 ? Math.round((d.paid_amount / d.original_amount) * 100) : 0;
      const row = document.createElement('a');
      row.href = '/debts.html';
      row.className = 'mini-row';
      row.innerHTML = `
        <div class="mini-row-left">
          ${i === 0 ? '<span class="debt-pin">FIRST</span>' : ''}
          <div class="mini-row-name">${esc(d.name)}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount negative">${fmt(remaining)} <span class="tx-currency">PKR</span></div>
          <div class="mini-row-sub">${pct}% paid</div>
        </div>
      `;
      wrap.appendChild(row);
    });
  }

  function paintDueSoon() {
    const wrap = document.getElementById('hub-due-soon');
    if (!wrap) return;
    const upcoming = (billsData.bills || [])
      .filter(b => !b.paidThisPeriod && (b.status === 'overdue' || b.status === 'due-today' || b.status === 'due-soon'))
      .sort((a, b) => a.due_day - b.due_day)
      .slice(0, 5);
    wrap.innerHTML = '';
    if (upcoming.length === 0) {
      wrap.innerHTML = '<div class="empty-state-inline">No bills due soon.</div>';
      return;
    }
    upcoming.forEach(b => {
      const row = document.createElement('a');
      row.href = '/bills.html';
      row.className = 'mini-row';
      row.innerHTML = `
        <div class="mini-row-left">
          <span class="bill-status-dot bill-status-${b.status}-dot"></span>
          <div class="mini-row-name">${esc(b.name)}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount negative">${fmt(b.amount)} <span class="tx-currency">PKR</span></div>
          <div class="mini-row-sub">${b.daysLabel}</div>
        </div>
      `;
      wrap.appendChild(row);
    });
  }

  function animate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.animateNumber) window.animateNumber(el, val);
    else el.textContent = Math.round(val).toLocaleString('en-US');
  }

  function setClass(id, cls) {
    const el = document.getElementById(id);
    if (el) el.className = cls;
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function formatDateLabel(iso) {
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (iso === today) return 'Today';
    if (iso === yest) return 'Yesterday';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
})();