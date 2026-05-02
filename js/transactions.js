/* ─── Sovereign Finance · Transactions List v0.9.0 with filters ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  const VIEW_KEY = 'sov_tx_view_v1';
  const FILTERS_KEY = 'sov_tx_filters_v1';
  let filters = loadFilters();

  async function init() {
    const savedView = localStorage.getItem(VIEW_KEY) || (window.innerWidth >= 900 ? 'dense' : 'standard');
    setView(savedView);
    renderList();
    await window.store.getAll();
    populateFilterDropdowns();
    paintFilterValues();
    renderList();
    attachSearch();
    attachViewToggle();
    attachFilters();
  }

  function loadFilters() {
    try { return JSON.parse(localStorage.getItem(FILTERS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveFilters() { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch (e) {} }
  function activeCount() { return Object.values(filters).filter(v => v).length; }

  function populateFilterDropdowns() {
    const accSel = document.getElementById('filterAccount');
    const catSel = document.getElementById('filterCategory');
    if (!accSel || !catSel) return;
    window.store.accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.icon + '  ' + a.name;
      accSel.appendChild(opt);
    });
    window.store.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.icon + '  ' + c.name;
      catSel.appendChild(opt);
    });
  }

  function paintFilterValues() {
    const map = {
      filterFrom: 'from', filterTo: 'to', filterType: 'type',
      filterAccount: 'account', filterCategory: 'category',
      filterMin: 'min', filterMax: 'max'
    };
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id);
      if (el && filters[map[id]]) el.value = filters[map[id]];
    });
    updateBadge();
  }

  function updateBadge() {
    const badge = document.getElementById('filterActiveBadge');
    const n = activeCount();
    if (n > 0) { badge.style.display = 'inline-block'; badge.textContent = n; }
    else { badge.style.display = 'none'; }
  }

  function attachFilters() {
    const ids = ['filterFrom', 'filterTo', 'filterType', 'filterAccount', 'filterCategory', 'filterMin', 'filterMax'];
    const map = {
      filterFrom: 'from', filterTo: 'to', filterType: 'type',
      filterAccount: 'account', filterCategory: 'category',
      filterMin: 'min', filterMax: 'max'
    };
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        filters[map[id]] = el.value || null;
        saveFilters();
        updateBadge();
        renderList(document.getElementById('searchInput').value);
      });
    });
    document.getElementById('filterClear').addEventListener('click', () => {
      filters = {};
      saveFilters();
      paintFilterValues();
      ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      updateBadge();
      renderList(document.getElementById('searchInput').value);
    });
  }

  function applyFilters(rows) {
    return rows.filter(tx => {
      if (filters.from && tx.date < filters.from) return false;
      if (filters.to && tx.date > filters.to) return false;
      if (filters.type && tx.type !== filters.type) return false;
      if (filters.account && tx.accountId !== filters.account) return false;
      if (filters.category && tx.categoryId !== filters.category) return false;
      if (filters.min && tx.amount < parseFloat(filters.min)) return false;
      if (filters.max && tx.amount > parseFloat(filters.max)) return false;
      return true;
    });
  }

  function setView(view) {
    const list = document.getElementById('txList');
    if (!list) return;
    list.className = 'tx-list view-' + view;
    document.querySelectorAll('.view-btn[data-view]').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    localStorage.setItem(VIEW_KEY, view);
  }

  function attachViewToggle() {
    document.querySelectorAll('.view-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        setView(btn.dataset.view);
        renderList(document.getElementById('searchInput').value);
      });
    });
  }

  function getCurrentView() { return localStorage.getItem(VIEW_KEY) || 'standard'; }

  function renderList(filterText) {
    const list = document.getElementById('txList');
    const empty = document.getElementById('emptyState');
    const countEl = document.getElementById('txCount');
    if (!list) return;

    const view = getCurrentView();
    const all = window.store.getCachedAll();
    let working = applyFilters(all);

    const ft = (filterText || '').toLowerCase().trim();
    if (ft) {
      working = working.filter(tx => {
        const acc = window.store.getAccount(tx.accountId).name.toLowerCase();
        const cat = window.store.getCategory(tx.categoryId).name.toLowerCase();
        const notes = (tx.notes || '').toLowerCase();
        const id = (tx.id || '').toLowerCase();
        return acc.includes(ft) || cat.includes(ft) || notes.includes(ft) || id.includes(ft);
      });
    }

    countEl.textContent = working.length + (working.length === 1 ? ' entry' : ' entries');

    if (working.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
      empty.textContent = (ft || activeCount() > 0) ? 'No matches.' : 'No transactions yet.';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = '';

    if (view === 'dense') {
      list.appendChild(buildDenseTable(working));
    } else {
      const groups = {};
      working.forEach(tx => {
        const label = formatDateLabel(tx.date);
        if (!groups[label]) groups[label] = [];
        groups[label].push(tx);
      });
      Object.keys(groups).forEach(label => {
        const header = document.createElement('div');
        header.className = 'tx-date-header';
        header.textContent = label;
        list.appendChild(header);
        groups[label].forEach(tx => list.appendChild(buildRow(tx, view)));
      });
    }
  }

  function buildRow(tx, view) {
    const acc = window.store.getAccount(tx.accountId);
    const cat = window.store.getCategory(tx.categoryId);
    const sign = tx.type === 'income' ? '+' : (tx.type === 'expense' ? '−' : '↔');
    const colorClass = tx.type === 'income' ? 'positive' : (tx.type === 'expense' ? 'negative' : 'neutral');

    const link = document.createElement('a');
    link.href = '/edit.html?id=' + encodeURIComponent(tx.id);
    link.className = 'tx-row tx-link';

    if (view === 'compact') {
      link.innerHTML = `
        <div class="tx-left">
          <div class="tx-icon">${cat.icon}</div>
          <div class="tx-info"><div class="tx-name">${esc(cat.name)}</div></div>
        </div>
        <div class="tx-amount ${colorClass}">${sign} ${fmt(tx.amount)}<span class="tx-currency">PKR</span></div>
      `;
    } else {
      link.innerHTML = `
        <div class="tx-left">
          <div class="tx-icon">${cat.icon}</div>
          <div class="tx-info">
            <div class="tx-name">${esc(cat.name)}</div>
            <div class="tx-sub">${acc.icon} ${esc(acc.name)}${tx.notes ? ' · ' + esc(tx.notes) : ''}</div>
          </div>
        </div>
        <div class="tx-amount ${colorClass}">${sign} ${fmt(tx.amount)}<span class="tx-currency">PKR</span></div>
      `;
    }
    return link;
  }

  function buildDenseTable(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'dense-wrap';
    const table = document.createElement('table');
    table.className = 'dense-table';
    table.innerHTML = `
      <thead><tr>
        <th class="dense-th">Date</th><th class="dense-th">Type</th>
        <th class="dense-th align-right">Amount</th><th class="dense-th">Account</th>
        <th class="dense-th">Category</th><th class="dense-th">Notes</th>
        <th class="dense-th">TX ID</th><th class="dense-th">Created</th>
        <th class="dense-th align-right">Actions</th>
      </tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    rows.forEach(tx => {
      const acc = window.store.getAccount(tx.accountId);
      const cat = window.store.getCategory(tx.categoryId);
      const sign = tx.type === 'income' ? '+' : (tx.type === 'expense' ? '−' : '↔');
      const colorClass = tx.type === 'income' ? 'positive' : (tx.type === 'expense' ? 'negative' : 'neutral');
      const typeColor = tx.type === 'income' ? 'badge-green' :
                        tx.type === 'expense' ? 'badge-red' :
                        tx.type === 'transfer' ? 'badge-blue' :
                        tx.type === 'cc_payment' ? 'badge-purple' :
                        tx.type === 'cc_spend' ? 'badge-amber' : 'badge-grey';

      const tr = document.createElement('tr');
      tr.className = 'dense-row';
      tr.innerHTML = `
        <td class="dense-td">${esc(tx.date)}</td>
        <td class="dense-td"><span class="type-badge ${typeColor}">${esc(tx.type)}</span></td>
        <td class="dense-td align-right ${colorClass}"><strong>${sign} ${fmt(tx.amount)}</strong> <span class="tx-currency">PKR</span></td>
        <td class="dense-td"><span class="dense-icon">${acc.icon}</span> ${esc(acc.name)}</td>
        <td class="dense-td"><span class="dense-icon">${cat.icon}</span> ${esc(cat.name)}</td>
        <td class="dense-td dense-notes">${esc(tx.notes || '')}</td>
        <td class="dense-td"><code class="tx-id-code" data-id="${esc(tx.id)}" title="Click to copy">${esc(tx.id.slice(-8))}</code></td>
        <td class="dense-td dense-time">${formatTime(tx.createdAt)}</td>
        <td class="dense-td align-right"><a href="/edit.html?id=${encodeURIComponent(tx.id)}" class="dense-action">Edit</a></td>
      `;
      tbody.appendChild(tr);
    });

    table.addEventListener('click', (e) => {
      const code = e.target.closest('.tx-id-code');
      if (code) {
        navigator.clipboard.writeText(code.dataset.id).then(() => {
          code.classList.add('copied');
          setTimeout(() => code.classList.remove('copied'), 800);
        });
      }
    });

    wrap.appendChild(table);
    return wrap;
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

  function formatDateLabel(iso) {
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (iso === today) return 'Today';
    if (iso === yest) return 'Yesterday';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
  }

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  function attachSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    input.addEventListener('input', () => renderList(input.value));
  }
})();