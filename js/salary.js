/* ─── Sovereign Finance · Salary Page v0.9.0 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let data = { components: [], total: 0, count: 0, days_to_next: 0, next_payday: '' };

  async function init() {
    paint();
    await load();
    paint();
  }

  async function load() {
    try {
      const res = await fetch('/api/salary');
      const d = await res.json();
      if (d.ok) data = d;
    } catch (e) {}
  }

  function paint() {
    animate('salary-total', data.total);
    animate('salary-days', data.days_to_next);
    setText('salary-next-date', data.next_payday ? formatShort(data.next_payday) : '—');
    setText('salary-count', data.count + (data.count === 1 ? ' field' : ' fields'));
    setText('salary-summary', data.count + ' components · ' + Math.round(data.total).toLocaleString() + ' PKR');
    setText('salary-total-label', Math.round(data.total).toLocaleString() + ' PKR total');

    const list = document.getElementById('salary-list');
    list.innerHTML = '';
    if (data.components.length === 0) {
      list.innerHTML = '<div class="empty-state-inline">No salary data yet. Run sheet export to populate.</div>';
      return;
    }
    data.components.forEach(c => list.appendChild(buildRow(c)));
  }

  function buildRow(c) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const niceLabel = titleCase(c.label);
    row.innerHTML = `
      <div class="account-left">
        <div class="account-icon">💼</div>
        <div class="account-info">
          <div class="account-name">${esc(niceLabel)}</div>
          <div class="account-kind">${esc(c.key)}</div>
        </div>
      </div>
      <div class="account-balance positive">${fmt(c.value)}<span class="balance-currency">PKR</span></div>
    `;
    return row;
  }

  function titleCase(s) { return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1)); }
  function formatShort(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

  function animate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.animateNumber) window.animateNumber(el, val);
    else el.textContent = fmt(val);
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
})();
