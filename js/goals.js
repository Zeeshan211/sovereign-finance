/* ─── Sovereign Finance · Goals Page · v0.1.0 · Sub-1D-4a Ship 3 ───
 * Wires:
 *   - GET /api/goals → render summary + list
 *   - + Add Goal button → modal → POST /api/goals
 *   - ✏️ Edit button per row → modal → PUT /api/goals/{id}
 *   - 💰 Contribute button per row → modal → POST /api/goals/{id}/contribute
 *   - Edit modal Delete → DELETE /api/goals/{id}?created_by=web
 *
 * Backend contracts (goals/[[path]].js v0.2.0):
 *   POST /api/goals → {name, target_amount, current_amount?, deadline?, source_account_id?, display_order?, notes?}
 *   PUT  /api/goals/{id} → {name?, target_amount?, current_amount?, deadline?, source_account_id?, display_order?, notes?, status?}
 *   POST /api/goals/{id}/contribute → {amount, account_id?, date?, notes?}
 */
(function () {
  'use strict';

  if (window._goalsInited) return;
  window._goalsInited = true;

  const VERSION = 'v0.1.0';
  const $ = id => document.getElementById(id);

  const fmtPKR = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-PK');
  const todayLocal = () => {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  };
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

  /* ─────── Account dropdown helper ─────── */
  function populateAccountSelect(selectId, defaultValue, includeNone) {
    const sel = $(selectId);
    if (!sel) return;
    const accounts = (window.store && (window.store.cachedAccounts || window.store.accounts)) || [];
    const noneOption = includeNone
      ? `<option value=""${!defaultValue ? ' selected' : ''}>— ${includeNone} —</option>`
      : '';
    if (!accounts.length) {
      sel.innerHTML = noneOption + '<option value="">⚠ no accounts loaded — refresh page</option>';
      return;
    }
    sel.innerHTML = noneOption + accounts
      .map(a => `<option value="${escHtml(a.id)}"${a.id === defaultValue ? ' selected' : ''}>${escHtml(a.name)} (${escHtml(a.id)})</option>`)
      .join('');
  }

  /* ─────── Add Goal modal ─────── */
  function wireAddModal() {
    const trigger = $('addGoalBtn');
    const cancel = $('addGoalCancel');
    const confirm = $('addGoalConfirm');
    const backdrop = $('addGoalModal');
    if (trigger && !trigger._wired) { trigger.addEventListener('click', openAddModal); trigger._wired = true; }
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeAddModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmAdd); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAddModal(); });
      backdrop._wired = true;
    }
  }

  function openAddModal() {
    const name = $('addGoalName'); if (name) name.value = '';
    const target = $('addGoalTarget'); if (target) target.value = '';
    const current = $('addGoalCurrent'); if (current) current.value = '';
    const deadline = $('addGoalDeadline'); if (deadline) deadline.value = '';
    const notes = $('addGoalNotes'); if (notes) notes.value = '';
    populateAccountSelect('addGoalAccount', '', 'None');
    const m = $('addGoalModal');
    if (m) m.style.display = 'flex';
    if (name) setTimeout(() => name.focus(), 50);
  }

  function closeAddModal() {
    const m = $('addGoalModal');
    if (m) m.style.display = 'none';
  }

  async function confirmAdd() {
    const name = (($('addGoalName') || {}).value || '').trim();
    const target_amount = Number(($('addGoalTarget') || {}).value || 0);
    const current_amount = Number(($('addGoalCurrent') || {}).value || 0);
    const deadline = (($('addGoalDeadline') || {}).value || '') || null;
    const source_account_id = ($('addGoalAccount') || {}).value || null;
    const notes = (($('addGoalNotes') || {}).value || '').trim() || null;

    if (!name) { alert('Name is required'); return; }
    if (!target_amount || target_amount <= 0) { alert('Target amount must be > 0'); return; }
    if (current_amount < 0) { alert('Current amount cannot be negative'); return; }

    const btn = $('addGoalConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await getJSON('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ name, target_amount, current_amount, deadline, source_account_id, notes })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[goals] add POST →', r.status, 'ok ·', r.body.id);
        closeAddModal();
        await loadAll();
      } else {
        alert('Add failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Goal'; }
    }
  }

  /* ─────── Edit Goal modal ─────── */
  let _editContext = null;

  function wireEditModal() {
    const cancel = $('editGoalCancel');
    const confirm = $('editGoalConfirm');
    const del = $('editGoalDelete');
    const backdrop = $('editGoalModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeEditModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmEdit); confirm._wired = true; }
    if (del && !del._wired) { del.addEventListener('click', deleteFromEditModal); del._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeEditModal(); });
      backdrop._wired = true;
    }
  }

  function openEditModal(goal) {
    _editContext = { id: goal.id, original: { ...goal } };
    const title = $('editGoalTitle');
    const sub = $('editGoalSub');
    const name = $('editGoalName');
    const target = $('editGoalTarget');
    const current = $('editGoalCurrent');
    const deadline = $('editGoalDeadline');
    const notes = $('editGoalNotes');
    if (title) title.textContent = 'Edit ' + goal.name;
    if (sub) sub.textContent = 'id: ' + goal.id;
    if (name) name.value = goal.name || '';
    if (target) target.value = goal.target_amount || 0;
    if (current) current.value = goal.current_amount || 0;
    if (deadline) deadline.value = goal.deadline || '';
    if (notes) notes.value = goal.notes || '';
    populateAccountSelect('editGoalAccount', goal.source_account_id || '', 'None');
    const m = $('editGoalModal');
    if (m) m.style.display = 'flex';
  }

  function closeEditModal() {
    _editContext = null;
    const m = $('editGoalModal');
    if (m) m.style.display = 'none';
  }

  async function confirmEdit() {
    if (!_editContext) return;
    const name = (($('editGoalName') || {}).value || '').trim();
    const target_amount = Number(($('editGoalTarget') || {}).value || 0);
    const current_amount = Number(($('editGoalCurrent') || {}).value || 0);
    const deadline = (($('editGoalDeadline') || {}).value || '') || null;
    const source_account_id = ($('editGoalAccount') || {}).value || null;
    const notes = (($('editGoalNotes') || {}).value || '').trim() || null;

    if (!name) { alert('Name is required'); return; }
    if (!target_amount || target_amount <= 0) { alert('Target amount must be > 0'); return; }
    if (current_amount < 0) { alert('Current amount cannot be negative'); return; }

    const btn = $('editGoalConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/goals/' + encodeURIComponent(_editContext.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ name, target_amount, current_amount, deadline, source_account_id, notes })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[goals] edit PUT →', r.status, 'ok · fields', r.body.updated_fields);
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
    const name = _editContext.original.name || _editContext.id;
    const ok = confirm(
      'Delete "' + name + '"?\n\n' +
      'This soft-deletes the goal (status set to "deleted"). ' +
      'A snapshot is taken before the change — recoverable via D1 console if needed.'
    );
    if (!ok) return;

    const btn = $('editGoalDelete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      const r = await getJSON(
        '/api/goals/' + encodeURIComponent(_editContext.id) + '?created_by=web',
        { method: 'DELETE', cache: 'no-store' }
      );
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[goals] delete DELETE →', r.status, 'ok · snapshot', r.body.snapshot_id);
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

  /* ─────── Contribute modal ─────── */
  let _contribContext = null;

  function wireContributeModal() {
    const cancel = $('contributeCancel');
    const confirm = $('contributeConfirm');
    const backdrop = $('contributeModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeContributeModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmContribute); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeContributeModal(); });
      backdrop._wired = true;
    }
  }

  function openContributeModal(goal) {
    _contribContext = { id: goal.id, name: goal.name, remaining: goal.remaining };
    const t = $('contributeTitle');
    const sub = $('contributeSub');
    const amt = $('contributeAmount');
    const date = $('contributeDate');
    const notes = $('contributeNotes');
    if (t) t.textContent = 'Add to ' + goal.name;
    if (sub) sub.textContent = 'Remaining ' + fmtPKR(goal.remaining);
    if (amt) amt.value = '';
    if (date) date.value = todayLocal();
    if (notes) notes.value = '';
    populateAccountSelect('contributeAccount', goal.source_account_id || '', 'Just bump goal, no ledger entry');
    const m = $('contributeModal');
    if (m) m.style.display = 'flex';
  }

  function closeContributeModal() {
    _contribContext = null;
    const m = $('contributeModal');
    if (m) m.style.display = 'none';
  }

  async function confirmContribute() {
    if (!_contribContext) return;
    const amt = Number(($('contributeAmount') || {}).value || 0);
    const account_id = ($('contributeAccount') || {}).value || null;
    const date = ($('contributeDate') || {}).value || todayLocal();
    const notes = (($('contributeNotes') || {}).value || '').trim() || null;
    if (!amt || amt <= 0) { alert('Enter a valid amount'); return; }

    const btn = $('contributeConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/goals/' + encodeURIComponent(_contribContext.id) + '/contribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ amount: amt, account_id, date, notes })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[goals] contribute POST →', r.status, 'ok · txn', r.body.txn_id, '· new', r.body.new_current_amount);
        closeContributeModal();
        await loadAll();
      } else {
        alert('Contribute failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Contribute failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Contribute'; }
    }
  }

  /* ─────── Renderer ─────── */
  function renderRow(g) {
    const pct = g.pct || 0;
    const statusClass = g.is_achieved ? 'accent' : (pct >= 75 ? 'liabilities' : 'negative');
    const deadlineText = g.deadline_label || 'no deadline';
    return `
      <div class="mini-row" data-goal-id="${escHtml(g.id)}">
        <div class="mini-row-left">
          <div class="mini-row-name">${escHtml(g.name)}${g.is_achieved ? ' 🎉' : ''}</div>
          <div class="mini-row-sub">${pct}% · ${fmtPKR(g.current_amount)} of ${fmtPKR(g.target_amount)} · ${escHtml(deadlineText)}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount ${statusClass}">${fmtPKR(g.remaining)}</div>
          <div style="display:flex;gap:6px;margin-top:4px;justify-content:flex-end">
            ${g.is_achieved ? `
              <span class="dense-badge accent" style="font-size:11px;padding:3px 8px">✓ achieved</span>
            ` : `
              <button class="primary-btn contribute-btn" data-goal-id="${escHtml(g.id)}"
                      style="font-size:12px;padding:4px 10px">💰 Add</button>
            `}
            <button class="ghost-btn edit-goal-btn" data-goal-id="${escHtml(g.id)}"
                    style="font-size:12px;padding:4px 10px" title="Edit / Delete">✏️</button>
          </div>
        </div>
      </div>`;
  }

  function renderList(goals) {
    const container = $('goals-list');
    if (!container) return;
    if (!goals.length) {
      container.innerHTML = '<div class="empty-state-inline">No goals yet — click + Add Goal above.</div>';
      return;
    }
    container.innerHTML = goals.map(renderRow).join('');

    container.querySelectorAll('.contribute-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.goalId;
        const g = goals.find(x => x.id === id);
        if (g) openContributeModal(g);
      });
    });
    container.querySelectorAll('.edit-goal-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.goalId;
        const g = goals.find(x => x.id === id);
        if (g) openEditModal(g);
      });
    });
  }

  function renderStats(payload) {
    setStat('goals-total-current', payload.total_current);
    setStat('goals-total-remaining', payload.total_remaining);
    const cnt = $('goals-count');
    if (cnt) cnt.textContent = (payload.count || 0) + ' ' + (payload.count === 1 ? 'goal' : 'goals');
    const ach = $('goals-achieved-count');
    if (ach) ach.textContent = (payload.achieved_count || 0) + ' achieved';
    const summary = $('goals-summary');
    if (summary) {
      summary.textContent = `${payload.achieved_count || 0} of ${payload.count || 0} done · ${fmtPKR(payload.total_remaining || 0)} to go`;
    }
  }

  /* ─────── Loader ─────── */
  async function loadAll() {
    console.log('[goals]', VERSION, 'loadAll start');
    try {
      // Refresh accounts cache so dropdowns work
      if (window.store && window.store.refreshBalances) {
        try { await window.store.refreshBalances(); } catch (_) { /* non-fatal */ }
      }
      const r = await fetch('/api/goals', { cache: 'no-store' });
      const body = await r.json();
      console.log('[goals] /api/goals', r.status, '→', body.count, 'goals');
      if (!body.ok) throw new Error(body.error || 'goals payload not ok');
      renderStats(body);
      renderList(body.goals || []);
    } catch (e) {
      console.error('[goals] loadAll FAILED:', e);
      const list = $('goals-list');
      if (list) list.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      const sum = $('goals-summary');
      if (sum) sum.textContent = 'load failed';
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[goals]', VERSION, 'init');
    wireAddModal();
    wireEditModal();
    wireContributeModal();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
