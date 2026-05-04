/* ─── Sovereign Finance · Budgets Page · v0.1.0 · Sub-1D-4b Ship 6 ───
 * Wires:
 *   - GET /api/budgets → render summary + per-category bars
 *   - + Add Budget → modal → POST /api/budgets
 *   - ✏️ Edit → modal → PUT /api/budgets/{category_id}
 *   - Edit modal Delete → DELETE /api/budgets/{category_id}?created_by=web
 *
 * Backend contracts (budgets/[[path]].js v0.2.0):
 *   POST /api/budgets → {category_id, monthly_amount, notes?}
 *   PUT  /api/budgets/{category_id} → {monthly_amount?, notes?, status?}
 *
 * Note: category_id is the natural primary key (one budget per category).
 * UI uses the same shape as goals/bills (mini-row pattern).
 */
(function () {
  'use strict';

  if (window._budgetsInited) return;
  window._budgetsInited = true;

  const VERSION = 'v0.1.0';
  const $ = id => document.getElementById(id);

  const fmtPKR = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-PK');
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function getJSON(url, opts) {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  function setStat(elId, value) {
    const el = $(elId);
    if (!el) return;
    const numeric = Number(value) || 0;
    if (window.animateNumber) {
      window.animateNumber(el, numeric, { format: n => fmtPKR(n) });
    } else {
      el.textContent = fmtPKR(numeric);
    }
  }

  /* ─────── Add Budget modal ─────── */
  function wireAddModal() {
    const trigger = $('addBudgetBtn');
    const cancel = $('addBudgetCancel');
    const confirm = $('addBudgetConfirm');
    const backdrop = $('addBudgetModal');
    if (trigger && !trigger._wired) { trigger.addEventListener('click', openAddModal); trigger._wired = true; }
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeAddModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmAdd); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAddModal(); });
      backdrop._wired = true;
    }
  }

  function openAddModal() {
    const cat = $('addBudgetCategory'); if (cat) cat.value = '';
    const amt = $('addBudgetAmount'); if (amt) amt.value = '';
    const notes = $('addBudgetNotes'); if (notes) notes.value = '';
    const m = $('addBudgetModal');
    if (m) m.style.display = 'flex';
    if (cat) setTimeout(() => cat.focus(), 50);
  }

  function closeAddModal() {
    const m = $('addBudgetModal');
    if (m) m.style.display = 'none';
  }

  async function confirmAdd() {
    const category_id = (($('addBudgetCategory') || {}).value || '').trim();
    const monthly_amount = Number(($('addBudgetAmount') || {}).value || 0);
    const notes = (($('addBudgetNotes') || {}).value || '').trim() || null;

    if (!category_id) { alert('Category ID is required'); return; }
    if (category_id.length > 40) { alert('Category ID max 40 chars'); return; }
    if (isNaN(monthly_amount) || monthly_amount < 0) { alert('Monthly cap must be ≥ 0'); return; }

    const btn = $('addBudgetConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await getJSON('/api/budgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ category_id, monthly_amount, notes })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[budgets] add POST →', r.status, 'ok ·', r.body.category_id);
        closeAddModal();
        await loadAll();
      } else {
        alert('Add failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Budget'; }
    }
  }

  /* ─────── Edit Budget modal ─────── */
  let _editContext = null;

  function wireEditModal() {
    const cancel = $('editBudgetCancel');
    const confirm = $('editBudgetConfirm');
    const del = $('editBudgetDelete');
    const backdrop = $('editBudgetModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeEditModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmEdit); confirm._wired = true; }
    if (del && !del._wired) { del.addEventListener('click', deleteFromEditModal); del._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeEditModal(); });
      backdrop._wired = true;
    }
  }

  function openEditModal(budget) {
    _editContext = { id: budget.category_id, original: { ...budget } };
    const title = $('editBudgetTitle');
    const sub = $('editBudgetSub');
    const amt = $('editBudgetAmount');
    const notes = $('editBudgetNotes');
    if (title) title.textContent = 'Edit ' + budget.category_id;
    if (sub) sub.textContent = 'category: ' + budget.category_id + ' · spent ' + fmtPKR(budget.spent_this_period);
    if (amt) amt.value = budget.monthly_amount || 0;
    if (notes) notes.value = budget.notes || '';
    const m = $('editBudgetModal');
    if (m) m.style.display = 'flex';
  }

  function closeEditModal() {
    _editContext = null;
    const m = $('editBudgetModal');
    if (m) m.style.display = 'none';
  }

  async function confirmEdit() {
    if (!_editContext) return;
    const monthly_amount = Number(($('editBudgetAmount') || {}).value || 0);
    const notes = (($('editBudgetNotes') || {}).value || '').trim() || null;

    if (isNaN(monthly_amount) || monthly_amount < 0) { alert('Monthly cap must be ≥ 0'); return; }

    const btn = $('editBudgetConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/budgets/' + encodeURIComponent(_editContext.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ monthly_amount, notes })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[budgets] edit PUT →', r.status, 'ok · fields', r.body.updated_fields);
        closeEditModal();
        await loadAll();
      } else {
        alert('Save failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  async function deleteFromEditModal() {
    if (!_editContext) return;
    const id = _editContext.id;
    const ok = confirm(
      'Delete budget for "' + id + '"?\n\n' +
      'This soft-deletes the budget (status set to "deleted"). ' +
      'Your transaction history is unaffected. Snapshot taken — recoverable via D1 console if needed.'
    );
    if (!ok) return;

    const btn = $('editBudgetDelete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      const r = await getJSON(
        '/api/budgets/' + encodeURIComponent(id) + '?created_by=web',
        { method: 'DELETE', cache: 'no-store' }
      );
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[budgets] delete DELETE →', r.status, 'ok · snapshot', r.body.snapshot_id);
        closeEditModal();
        await loadAll();
      } else {
        alert('Delete failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Delete failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
    }
  }

  /* ─────── Renderer ─────── */
  function renderRow(b) {
    const pct = b.pct || 0;
    const pctDisplay = Math.min(100, pct);
    const labelClass = b.status_label === 'over' ? 'negative'
                     : b.status_label === 'critical' ? 'negative'
                     : b.status_label === 'warning' ? 'liabilities'
                     : b.status_label === 'no cap' ? '' : 'accent';
    const barClass = b.status_label === 'over' ? 'negative'
                   : b.status_label === 'critical' ? 'negative'
                   : b.status_label === 'warning' ? 'liabilities' : 'accent';
    const amountClass = b.overspent > 0 ? 'negative' : 'accent';
    const amountText = b.overspent > 0
      ? '+' + fmtPKR(b.overspent) + ' over'
      : fmtPKR(b.remaining) + ' left';

    return `
      <div class="mini-row" data-budget-id="${escHtml(b.category_id)}">
        <div class="mini-row-left" style="flex:1">
          <div class="mini-row-name">${escHtml(b.category_id)} <span class="dense-badge ${labelClass}" style="font-size:10px;padding:2px 6px;margin-left:4px">${escHtml(b.status_label)}</span></div>
          <div class="mini-row-sub">${fmtPKR(b.spent_this_period)} of ${fmtPKR(b.monthly_amount)} · ${pct}%</div>
          <div style="background:rgba(255,255,255,0.08);border-radius:4px;height:6px;margin-top:6px;overflow:hidden">
            <div style="width:${pctDisplay}%;height:100%;background:var(--${barClass === 'negative' ? 'danger' : barClass === 'liabilities' ? 'warning' : 'accent'},#22c55e);transition:width 0.3s"></div>
          </div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount ${amountClass}" style="font-size:13px">${amountText}</div>
          <button class="ghost-btn edit-budget-btn" data-budget-id="${escHtml(b.category_id)}"
                  style="font-size:12px;padding:4px 10px;margin-top:4px" title="Edit / Delete">✏️</button>
        </div>
      </div>`;
  }

  function renderList(budgets) {
    const container = $('budgets-list');
    if (!container) return;
    if (!budgets.length) {
      container.innerHTML = '<div class="empty-state-inline">No budgets yet — click + Add Budget above.</div>';
      return;
    }
    container.innerHTML = budgets.map(renderRow).join('');

    container.querySelectorAll('.edit-budget-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.budgetId;
        const b = budgets.find(x => x.category_id === id);
        if (b) openEditModal(b);
      });
    });
  }

  function renderStats(payload) {
    setStat('budgets-total-cap', payload.total_cap);
    setStat('budgets-total-spent', payload.total_spent);
    const cnt = $('budgets-count');
    if (cnt) cnt.textContent = (payload.count || 0) + ' ' + (payload.count === 1 ? 'budget' : 'budgets');
    const over = $('budgets-over-count');
    if (over) over.textContent = (payload.over_count || 0) + ' over cap';
    const summary = $('budgets-summary');
    if (summary) {
      const remaining = (payload.total_cap || 0) - (payload.total_spent || 0);
      summary.textContent = `${fmtPKR(payload.total_spent || 0)} spent · ${fmtPKR(Math.max(0, remaining))} left this month`;
    }
  }

  /* ─────── Loader ─────── */
  async function loadAll() {
    console.log('[budgets]', VERSION, 'loadAll start');
    try {
      const r = await fetch('/api/budgets', { cache: 'no-store' });
      const body = await r.json();
      console.log('[budgets] /api/budgets', r.status, '→', body.count, 'budgets · period', body.period_start, '→', body.period_end);
      if (!body.ok) throw new Error(body.error || 'budgets payload not ok');
      renderStats(body);
      renderList(body.budgets || []);
    } catch (e) {
      console.error('[budgets] loadAll FAILED:', e);
      const list = $('budgets-list');
      if (list) list.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      const sum = $('budgets-summary');
      if (sum) sum.textContent = 'load failed';
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[budgets]', VERSION, 'init');
    wireAddModal();
    wireEditModal();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
