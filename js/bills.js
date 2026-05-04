/* ─── Sovereign Finance · Bills Page · v0.9.0 · Sub-1D-3d Ship 4 ───
 * Adds:
 *   - ✏️ Edit button on every row
 *   - Edit modal wired: populate from row, PUT on save, DELETE inside
 *   - Null-due-day display fix ("no due date" instead of misleading "X days late")
 *   - Replaced confirm() Delete with descriptive snapshot-aware prompt
 *
 * Backend contracts (functions/api/bills/[[path]].js v0.2.0):
 *   GET    /api/bills                 → list + summary
 *   POST   /api/bills                 → {name, amount, due_day, default_account_id, category_id}
 *   PUT    /api/bills/{id}            → {name?, amount?, due_day?, default_account_id?, category_id?}
 *   DELETE /api/bills/{id}?created_by=web → soft-delete (snapshot + audit)
 *   POST   /api/bills/{id}/pay        → {amount, account_id, date}
 */
(function () {
  'use strict';

  if (window._billsInited) return;
  window._billsInited = true;

  const VERSION = 'v0.9.0';
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

  /* ─────── Account + Category dropdowns shared helper ─────── */
  function populateAccountSelect(selectId, defaultValue) {
    const sel = $(selectId);
    if (!sel) return;
    const accounts = (window.store && (window.store.cachedAccounts || window.store.accounts)) || [];
    if (!accounts.length) {
      sel.innerHTML = '<option value="">⚠ no accounts loaded — refresh the page</option>';
      return;
    }
    sel.innerHTML = accounts
      .map(a => `<option value="${escHtml(a.id)}"${a.id === defaultValue ? ' selected' : ''}>${escHtml(a.name)} (${escHtml(a.id)})</option>`)
      .join('');
  }

  function populateCategorySelect(selectId, defaultValue) {
    const sel = $(selectId);
    if (!sel) return;
    const cats = (window.store && (window.store.categories || [])) || [];
    if (!cats.length) {
      // Fallback to common bill categories
      sel.innerHTML = `
        <option value="bills"${defaultValue === 'bills' ? ' selected' : ''}>Bills</option>
        <option value="utilities"${defaultValue === 'utilities' ? ' selected' : ''}>Utilities</option>
        <option value="subscription"${defaultValue === 'subscription' ? ' selected' : ''}>Subscription</option>
        <option value="rent"${defaultValue === 'rent' ? ' selected' : ''}>Rent</option>
        <option value="services"${defaultValue === 'services' ? ' selected' : ''}>Services</option>`;
      return;
    }
    sel.innerHTML = cats
      .map(c => `<option value="${escHtml(c.id)}"${c.id === defaultValue ? ' selected' : ''}>${escHtml(c.name || c.id)}</option>`)
      .join('');
  }

  /* ─────── Pay Bill modal ─────── */
  let _payContext = null;

  function wirePayModal() {
    const cancel = $('payBillCancel');
    const confirm = $('payBillConfirm');
    const backdrop = $('payBillModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closePayModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmPay); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closePayModal(); });
      backdrop._wired = true;
    }
  }

  function openPayModal(bill) {
    _payContext = { id: bill.id, name: bill.name, amount: bill.amount };
    const t = $('payBillTitle');
    const sub = $('payBillSub');
    const amt = $('payBillAmount');
    const date = $('payBillDate');
    if (t) t.textContent = 'Pay ' + bill.name;
    if (sub) sub.textContent = 'Amount ' + fmtPKR(bill.amount);
    if (amt) amt.value = bill.amount > 0 ? bill.amount : '';
    if (date) date.value = todayLocal();
    populateAccountSelect('payBillAccount', bill.default_account_id);
    const m = $('payBillModal');
    if (m) m.style.display = 'flex';
  }

  function closePayModal() {
    _payContext = null;
    const m = $('payBillModal');
    if (m) m.style.display = 'none';
  }

  async function confirmPay() {
    if (!_payContext) return;
    const amt = Number(($('payBillAmount') || {}).value || 0);
    const accountId = ($('payBillAccount') || {}).value || '';
    const date = ($('payBillDate') || {}).value || todayLocal();
    if (!amt || amt <= 0) { alert('Enter a valid amount'); return; }
    if (!accountId) { alert('Select an account'); return; }

    const btn = $('payBillConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Paying…'; }
    try {
      const r = await getJSON('/api/bills/' + encodeURIComponent(_payContext.id) + '/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ amount: amt, account_id: accountId, date })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[bills] pay POST →', r.status, 'ok · txn', r.body.txn_id);
        closePayModal();
        await loadAll();
      } else {
        alert('Mark Paid failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Mark Paid failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Mark Paid'; }
    }
  }

  /* ─────── Add Bill modal ─────── */
  function wireAddModal() {
    const trigger = $('addBillBtn');
    const cancel = $('addBillCancel');
    const confirm = $('addBillConfirm');
    const backdrop = $('addBillModal');
    if (trigger && !trigger._wired) { trigger.addEventListener('click', openAddModal); trigger._wired = true; }
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeAddModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmAdd); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAddModal(); });
      backdrop._wired = true;
    }
  }

  function openAddModal() {
    const name = $('newBillName'); if (name) name.value = '';
    const amt = $('newBillAmount'); if (amt) amt.value = '';
    const due = $('newBillDueDay'); if (due) due.value = '1';
    populateAccountSelect('newBillAccount');
    populateCategorySelect('newBillCategory', 'bills');
    const m = $('addBillModal');
    if (m) m.style.display = 'flex';
    if (name) setTimeout(() => name.focus(), 50);
  }

  function closeAddModal() {
    const m = $('addBillModal');
    if (m) m.style.display = 'none';
  }

  async function confirmAdd() {
    const name = (($('newBillName') || {}).value || '').trim();
    const amount = Number(($('newBillAmount') || {}).value || 0);
    const due_day = Number(($('newBillDueDay') || {}).value || 1);
    const default_account_id = ($('newBillAccount') || {}).value || null;
    const category_id = ($('newBillCategory') || {}).value || 'bills';

    if (!name) { alert('Bill name is required'); return; }
    if (!amount || amount <= 0) { alert('Amount must be > 0'); return; }
    if (due_day < 1 || due_day > 31) { alert('Due day must be 1-31'); return; }

    const btn = $('addBillConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await getJSON('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ name, amount, due_day, default_account_id, category_id })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[bills] add POST →', r.status, 'ok ·', r.body.id);
        closeAddModal();
        await loadAll();
      } else {
        alert('Add failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Bill'; }
    }
  }

  /* ─────── Edit Bill modal (NEW) ─────── */
  let _editContext = null;

  function wireEditModal() {
    const cancel = $('editBillCancel');
    const confirm = $('editBillConfirm');
    const del = $('editBillDelete');
    const backdrop = $('editBillModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeEditModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmEdit); confirm._wired = true; }
    if (del && !del._wired) { del.addEventListener('click', deleteFromEditModal); del._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeEditModal(); });
      backdrop._wired = true;
    }
  }

  function openEditModal(bill) {
    _editContext = { id: bill.id, original: { ...bill } };
    const title = $('editBillTitle');
    const sub = $('editBillSub');
    const name = $('editBillName');
    const amt = $('editBillAmount');
    const due = $('editBillDueDay');
    if (title) title.textContent = 'Edit ' + bill.name;
    if (sub) sub.textContent = 'id: ' + bill.id;
    if (name) name.value = bill.name || '';
    if (amt) amt.value = bill.amount || 0;
    if (due) due.value = bill.due_day || '';
    populateAccountSelect('editBillAccount', bill.default_account_id);
    populateCategorySelect('editBillCategory', bill.category_id || 'bills');
    const m = $('editBillModal');
    if (m) m.style.display = 'flex';
  }

  function closeEditModal() {
    _editContext = null;
    const m = $('editBillModal');
    if (m) m.style.display = 'none';
  }

  async function confirmEdit() {
    if (!_editContext) return;
    const name = (($('editBillName') || {}).value || '').trim();
    const amount = Number(($('editBillAmount') || {}).value || 0);
    const due_day = Number(($('editBillDueDay') || {}).value || 0);
    const default_account_id = ($('editBillAccount') || {}).value || null;
    const category_id = ($('editBillCategory') || {}).value || 'bills';

    if (!name) { alert('Bill name is required'); return; }
    if (!amount || amount <= 0) { alert('Amount must be > 0'); return; }
    if (due_day && (due_day < 1 || due_day > 31)) { alert('Due day must be 1-31'); return; }

    const btn = $('editBillConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/bills/' + encodeURIComponent(_editContext.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          name,
          amount,
          due_day: due_day || 1,
          default_account_id,
          category_id
        })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[bills] edit PUT →', r.status, 'ok · fields', r.body.updated_fields);
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
      'This soft-deletes the bill (status set to "deleted"). ' +
      'A snapshot is taken before the change — recoverable via D1 console if needed. ' +
      'Row will disappear from this page.'
    );
    if (!ok) return;

    const btn = $('editBillDelete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      const r = await getJSON(
        '/api/bills/' + encodeURIComponent(_editContext.id) + '?created_by=web',
        { method: 'DELETE', cache: 'no-store' }
      );
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[bills] delete DELETE →', r.status, 'ok · snapshot', r.body.snapshot_id);
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
  function renderRow(bill) {
    const isPaid = bill.paidThisPeriod;
    const statusClass = isPaid ? 'accent' : (bill.status === 'overdue' ? 'negative' : 'liabilities');
    const dueDayDisplay = bill.due_day
      ? bill.daysLabel
      : 'no due date set';
    return `
      <div class="mini-row" data-bill-id="${escHtml(bill.id)}">
        <div class="mini-row-left">
          <div class="mini-row-name">${escHtml(bill.name)}</div>
          <div class="mini-row-sub">${escHtml(dueDayDisplay)} · ${escHtml(bill.default_account_id || '—')}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount ${statusClass}">${fmtPKR(bill.amount)}</div>
          <div style="display:flex;gap:6px;margin-top:4px;justify-content:flex-end">
            ${isPaid ? `
              <span class="dense-badge accent" style="font-size:11px;padding:3px 8px">✓ paid</span>
            ` : `
              <button class="primary-btn pay-bill-btn" data-bill-id="${escHtml(bill.id)}"
                      style="font-size:12px;padding:4px 10px">✓ Pay</button>
            `}
            <button class="ghost-btn edit-bill-btn" data-bill-id="${escHtml(bill.id)}"
                    style="font-size:12px;padding:4px 10px" title="Edit / Delete">✏️</button>
          </div>
        </div>
      </div>`;
  }

  function renderList(bills) {
    const container = $('bills-list');
    if (!container) return;
    if (!bills.length) {
      container.innerHTML = '<div class="empty-state-inline">No bills yet — click + Add Bill above.</div>';
      return;
    }
    container.innerHTML = bills.map(renderRow).join('');

    container.querySelectorAll('.pay-bill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.billId;
        const b = bills.find(x => x.id === id);
        if (b) openPayModal(b);
      });
    });
    container.querySelectorAll('.edit-bill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.billId;
        const b = bills.find(x => x.id === id);
        if (b) openEditModal(b);
      });
    });
  }

  function renderStats(payload) {
    setStat('bills-total', payload.total_monthly);
    setStat('bills-remaining', payload.remaining_this_period);
    const cnt = $('bills-count');
    if (cnt) cnt.textContent = (payload.count || 0) + ' ' + (payload.count === 1 ? 'bill' : 'bills');
    const paidCnt = $('bills-paid-count');
    if (paidCnt) paidCnt.textContent = (payload.paid_count || 0) + ' paid this month';
    const summary = $('bills-summary');
    if (summary) {
      summary.textContent = `${payload.paid_count || 0} of ${payload.count || 0} paid · ${fmtPKR(payload.remaining_this_period || 0)} remaining`;
    }
  }

  /* ─────── Loader ─────── */
  async function loadAll() {
    console.log('[bills]', VERSION, 'loadAll start');
    try {
      // Refresh accounts cache so dropdowns work (per-page balances refresh on open)
      if (window.store && window.store.refreshBalances) {
        try { await window.store.refreshBalances(); } catch (_) { /* non-fatal */ }
      }
      const r = await fetch('/api/bills', { cache: 'no-store' });
      const body = await r.json();
      console.log('[bills] /api/bills', r.status, '→', body.count, 'bills');
      if (!body.ok) throw new Error(body.error || 'bills payload not ok');
      renderStats(body);
      renderList(body.bills || []);
    } catch (e) {
      console.error('[bills] loadAll FAILED:', e);
      const list = $('bills-list');
      if (list) list.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      const sum = $('bills-summary');
      if (sum) sum.textContent = 'load failed';
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[bills]', VERSION, 'init');
    wirePayModal();
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
