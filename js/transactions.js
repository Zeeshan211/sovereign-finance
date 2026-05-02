/* ─── Sovereign Finance · Transactions List v0.6.0 ─── */
/* 3 view modes: compact, standard (default), dense (sheet-like) */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  const VIEW_KEY = 'sov_tx_view_v1';

  async function init() {
    const savedView = localStorage.getItem(VIEW_KEY) ||
                      (window.innerWidth >= 900 ? 'dense' : 'standard');
    setView(savedView);

    renderList();
    await window.store.getAll();
    renderList();
    attachSearch();
    attachViewToggle();
  }

  function setView(view) {
    const list = document.getElementById('txList');
    if (!list) return;
    list.className = 'tx-list view-' + view;
    document.querySelectorAll('.view-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    localStorage.setItem(VIEW_KEY, view);
  }

  function attachViewToggle() {
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setView(btn.dataset.view);
        renderList(document.getElementById('searchInput').value);
      });
    });
  }

  function getCurrentView() {
    return localStorage.getItem(VIEW_KEY) || 'standard';
  }

  function renderList(filterText) {
    const list = document.getElementById('txList');
    const empty = document.getElementById('emptyState');
    const countEl = document.getElementById('txCount');
    if (!list) return;

    const view = getCurrentView();
    const all = window.store.getCachedAll();
    const filter = (filterText || '').toLowerCase().trim();

    const filtered = filter
      ? all.filter(tx => {
          const acc = window.store.getAccount(tx.accountId).name.toLowerCase();
          const cat = window.store.getCategory(tx.categoryId).name.toLowerCase();
          const notes = (tx.notes || '').toLowerCase();
          const id = (tx.id || '').toLowerCase();
          return acc.includes(filter) || cat.includes(filter) || notes.includes(filter) || id.includes(filter);
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

    list.innerHTML = '';

    if (view === 'dense') {
      list.appendChild(buildDenseTable(filtered));
    } else {
      // Compact + Standard share grouping by date
      const groups = {};
      filtered.forEach(tx => {
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
          <div class="tx-info">
            <div class="tx-name">${esc(cat.name)}</div>
          </div>
        </div>
        <div class="tx-amount ${colorClass}">${sign} ${fmt(tx.amount)}<span class="tx-currency">PKR</span></div>
      `;
    } else {
      // Standard
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
      <thead>
        <tr>
          <th class="dense-th">Date</th>
          <th class="dense-th">Type</th>
          <th class="dense-th align-right">Amount</th>
          <th class="dense-th">Account</th>
          <th class="dense-th">Category</th>
          <th class="dense-th">Notes</th>
          <th class="dense-th">TX ID</th>
          <th class="dense-th">Created</th>
          <th class="dense-th align-right">Actions</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

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
        <td class="dense-td align-right">
          <a href="/edit.html?id=${encodeURIComponent(tx.id)}" class="dense-action">Edit</a>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Copy TX ID on click
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
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function attachSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    input.addEventListener('input', () => renderList(input.value));
  }
})();