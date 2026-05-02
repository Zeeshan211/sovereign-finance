/* ─── Sovereign Finance · Transactions List v0.0.9 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    // Show cached immediately for fast paint
    renderList();
    // Then refresh from D1
    await window.store.getAll();
    renderList();
    attachSearch();
  }

  function renderList(filterText) {
    const list = document.getElementById('txList');
    const empty = document.getElementById('emptyState');
    const countEl = document.getElementById('txCount');
    if (!list) return;

    const all = window.store.getCachedAll();
    const filter = (filterText || '').toLowerCase().trim();

    const filtered = filter
      ? all.filter(tx => {
          const acc = window.store.getAccount(tx.accountId).name.toLowerCase();
          const cat = window.store.getCategory(tx.categoryId).name.toLowerCase();
          const notes = (tx.notes || '').toLowerCase();
          return acc.includes(filter) || cat.includes(filter) || notes.includes(filter);
        })
      : all;

    countEl.textContent = filtered.length + (filtered.length === 1 ? ' entry' : ' entries');

    if (filtered.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = filter ? 'No matches.' : 'No transactions yet. Tap ➕ Add to log your first.';
      return;
    }
    empty.style.display = 'none';

    const groups = {};
    filtered.forEach(tx => {
      const label = formatDateLabel(tx.date);
      if (!groups[label]) groups[label] = [];
      groups[label].push(tx);
    });

    list.innerHTML = '';
    Object.keys(groups).forEach(label => {
      const header = document.createElement('div');
      header.className = 'tx-date-header';
      header.textContent = label;
      list.appendChild(header);

      groups[label].forEach(tx => {
        list.appendChild(buildRow(tx));
      });
    });
  }

  function buildRow(tx) {
    const acc = window.store.getAccount(tx.accountId);
    const cat = window.store.getCategory(tx.categoryId);
    const sign = tx.type === 'income' ? '+' : (tx.type === 'expense' ? '−' : '↔');
    const colorClass = tx.type === 'income' ? 'positive' : (tx.type === 'expense' ? 'negative' : 'neutral');

    const row = document.createElement('div');
    row.className = 'tx-row';
    row.innerHTML = `
      <div class="tx-left">
        <div class="tx-icon">${cat.icon}</div>
        <div class="tx-info">
          <div class="tx-name">${escapeHtml(cat.name)}</div>
          <div class="tx-sub">${acc.icon} ${escapeHtml(acc.name)}${tx.notes ? ' · ' + escapeHtml(tx.notes) : ''}</div>
        </div>
      </div>
      <div class="tx-amount ${colorClass}">${sign} ${formatAmount(tx.amount)}<span class="tx-currency">PKR</span></div>
    `;
    return row;
  }

  function formatAmount(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function formatDateLabel(iso) {
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (iso === today) return 'Today';
    if (iso === yest) return 'Yesterday';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function attachSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    input.addEventListener('input', () => renderList(input.value));
  }
})();