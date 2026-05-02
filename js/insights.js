/* ─── Sovereign Finance · Insights Page v0.9.0 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let currentDays = 30;
  let data = { totals: { income: 0, expense: 0 }, net: 0, by_category: [], by_account: [], daily_trend: [] };

  async function init() {
    paint();
    await load();
    paint();
    attachPeriodToggle();
  }

  async function load() {
    try {
      const res = await fetch('/api/insights?days=' + currentDays);
      const d = await res.json();
      if (d.ok) data = d;
    } catch (e) {}
  }

  function attachPeriodToggle() {
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentDays = parseInt(btn.dataset.days);
        document.getElementById('period-label').textContent = currentDays;
        await load();
        paint();
      });
    });
  }

  function paint() {
    const expense = data.totals.expense || 0;
    const income = data.totals.income || 0;
    const net = data.net || 0;
    const dailyAvg = expense / currentDays;

    animate('ins-net', net);
    setClass('ins-net', net >= 0 ? 'nw-value positive counter' : 'nw-value negative counter');
    animate('ins-income', income);
    animate('ins-expense', expense);
    animate('ins-avg', dailyAvg);

    const top = data.by_category[0];
    setText('ins-top-cat', top ? (top.icon + ' ' + top.name) : '—');
    setText('insights-summary', currentDays + 'd · ' + data.by_category.length + ' categories');

    paintCategoryList();
    paintAccountList();
    paintTrendChart();
  }

  function paintCategoryList() {
    const wrap = document.getElementById('ins-cat-list');
    wrap.innerHTML = '';
    if (data.by_category.length === 0) {
      wrap.innerHTML = '<div class="empty-state-inline">No expense data for this period.</div>';
      return;
    }
    const max = data.by_category[0].total || 1;
    data.by_category.forEach(c => {
      const pct = Math.round((c.total / max) * 100);
      const row = document.createElement('div');
      row.className = 'cat-bar-row';
      row.innerHTML = `
        <div class="cat-bar-label">
          <span class="cat-bar-icon">${c.icon || '✨'}</span>
          <span class="cat-bar-name">${esc(c.name || c.id)}</span>
          <span class="cat-bar-count">${c.count}×</span>
        </div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%"></div></div>
        <div class="cat-bar-amount">${fmt(c.total)} PKR</div>
      `;
      wrap.appendChild(row);
    });
  }

  function paintAccountList() {
    const wrap = document.getElementById('ins-acc-list');
    wrap.innerHTML = '';
    if (data.by_account.length === 0) {
      wrap.innerHTML = '<div class="empty-state-inline">No data.</div>';
      return;
    }
    const max = data.by_account[0].total || 1;
    data.by_account.forEach(a => {
      const pct = Math.round((a.total / max) * 100);
      const row = document.createElement('div');
      row.className = 'cat-bar-row';
      row.innerHTML = `
        <div class="cat-bar-label">
          <span class="cat-bar-icon">${a.icon || '🏦'}</span>
          <span class="cat-bar-name">${esc(a.name || a.id)}</span>
          <span class="cat-bar-count">${a.count}×</span>
        </div>
        <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%; background: var(--info);"></div></div>
        <div class="cat-bar-amount">${fmt(a.total)} PKR</div>
      `;
      wrap.appendChild(row);
    });
  }

  function paintTrendChart() {
    const wrap = document.getElementById('ins-trend-chart');
    if (data.daily_trend.length === 0) {
      wrap.innerHTML = '<div class="empty-state-inline">No daily trend data.</div>';
      return;
    }
    const max = Math.max(...data.daily_trend.map(d => d.total)) || 1;
    let html = '<div class="trend-chart">';
    data.daily_trend.forEach(d => {
      const h = Math.max(2, Math.round((d.total / max) * 100));
      const date = new Date(d.date + 'T00:00:00');
      const lbl = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      html += `<div class="trend-bar" title="${lbl}: ${fmt(d.total)} PKR">
        <div class="trend-bar-fill" style="height:${h}%"></div>
        <div class="trend-bar-label">${date.getDate()}</div>
      </div>`;
    });
    html += '</div>';
    wrap.innerHTML = html;
  }

  function animate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.animateNumber) window.animateNumber(el, val);
    else el.textContent = fmt(val);
  }

  function setClass(id, cls) { const el = document.getElementById(id); if (el) el.className = cls; }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
})();
