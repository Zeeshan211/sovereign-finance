/* ─── Sovereign Finance · Audit Log Page v0.9.0 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let data = { entries: [], actions: [], count: 0 };
  let activeFilter = '';

  async function init() {
    await window.store.getAll();
    await load();
    paint();
    populateActionFilter();
    attachEvents();
  }

  async function load() {
    try {
      const url = '/api/audit' + (activeFilter ? '?action=' + encodeURIComponent(activeFilter) : '');
      const res = await fetch(url);
      const d = await res.json();
      if (d.ok) data = d;
    } catch (e) {}
  }

  function populateActionFilter() {
    const sel = document.getElementById('actionFilter');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    data.actions.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.action;
      opt.textContent = formatAction(a.action) + ' (' + a.count + ')';
      if (a.action === activeFilter) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function paint() {
    setText('audit-summary', data.count + ' entries' + (activeFilter ? ' · filtered' : ''));

    const list = document.getElementById('audit-list');
    list.innerHTML = '';
    if (data.entries.length === 0) {
      list.innerHTML = '<div class="empty-state-inline">No audit entries.</div>';
      return;
    }

    const groups = {};
    data.entries.forEach(e => {
      const d = (e.timestamp || '').slice(0, 10) || 'unknown';
      if (!groups[d]) groups[d] = [];
      groups[d].push(e);
    });

    Object.keys(groups).forEach(date => {
      const header = document.createElement('div');
      header.className = 'tx-date-header';
      header.textContent = formatDateLabel(date) + ' · ' + groups[date].length;
      list.appendChild(header);
      groups[date].forEach(e => list.appendChild(buildRow(e)));
    });
  }

  function buildRow(entry) {
    const time = entry.timestamp ? entry.timestamp.slice(11, 16) : '—';
    const actionType = (entry.action || '').toLowerCase();
    let badgeClass = 'badge-grey';
    if (actionType.indexOf('create') >= 0 || actionType.indexOf('add') >= 0 || actionType.indexOf('insert') >= 0) badgeClass = 'badge-green';
    else if (actionType.indexOf('delete') >= 0 || actionType.indexOf('remove') >= 0) badgeClass = 'badge-red';
    else if (actionType.indexOf('update') >= 0 || actionType.indexOf('edit') >= 0 || actionType.indexOf('change') >= 0) badgeClass = 'badge-blue';
    else if (actionType.indexOf('pay') >= 0 || actionType.indexOf('cleared') >= 0) badgeClass = 'badge-purple';

    const row = document.createElement('div');
    row.className = 'audit-row';
    row.innerHTML = `
      <div class="audit-time">${esc(time)}</div>
      <div class="audit-content">
        <div class="audit-action">
          <span class="type-badge ${badgeClass}">${esc(formatAction(entry.action || 'unknown'))}</span>
        </div>
        ${entry.details ? `<div class="audit-details">${esc(entry.details)}</div>` : ''}
        ${entry.entity_id ? `<div class="audit-entity"><code>${esc(entry.entity_id)}</code></div>` : ''}
      </div>
    `;
    return row;
  }

  function attachEvents() {
    document.getElementById('actionFilter').addEventListener('change', async (e) => {
      activeFilter = e.target.value;
      await load();
      paint();
    });
    document.getElementById('auditRefresh').addEventListener('click', async () => {
      await load();
      populateActionFilter();
      paint();
    });
  }

  function formatAction(a) { return String(a || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

  function formatDateLabel(iso) {
    if (iso === 'unknown') return 'Unknown date';
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (iso === today) return 'Today';
    if (iso === yest) return 'Yesterday';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
})();
