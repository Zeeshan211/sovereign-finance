/* ─── Sovereign Finance · Bills Page v0.9.2 · FULL REWRITE ─── */
/*
 * Changes vs v0.9.0:
 *   - renderStats now derives all values from bills array (was reading body.count which doesn't exist)
 *   - Defensive `|| []` on every array access
 *   - Race guard on loadAll (_loadAllInFlight flag)
 *   - Verbose logging for debug
 *   - DOM IDs verified live: bills-total, bills-count, bills-remaining, bills-paid-count, bills-list
 *   - All modals + CRUD flows preserved verbatim
 *
 * Schema (per SCHEMA.md):
 *   bills: id, name, amount, due_day, frequency, category_id, default_account_id,
 *          last_paid_date, auto_post, status, deleted_at
 *   transactions: id, type, amount, date, account_id, category_id, notes
 */

(function () {
  'use strict';

  const VERSION = 'v0.9.2';
  console.log('[bills]', VERSION, 'init');

  const $ = id => document.getElementById(id);

  /* ─────── Helpers ─────── */
  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs —';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function daysUntilDue(dueDay) {
    if (dueDay == null) return null;
    const today = new Date();
    const todayDay = today.getDate();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    let diff = dueDay - todayDay;
    if (diff < 0) diff += daysInMonth;
    return diff;
  }

  function isPaidThisPeriod(bill) {
    if (!bill.last_paid_date) return false;
    const paid = new Date(bill.last_paid_date);
    const now = new Date();
    if (bill.frequency === 'monthly' || !bill.frequency) {
      return paid.getMonth() === now.getMonth() && paid.getFullYear() === now.getFullYear();
    }
    if (bill.frequency === 'weekly') {
      const diffMs = now - paid;
      return diffMs < 7 * 24 * 60 * 60 * 1000;
    }
    if (bill.frequency === 'yearly') {
      return paid.getFullYear() === now.getFullYear();
    }
    return false;
  }

  /* ─────── Stats render ─────── */
  function renderStats(billsArr) {
    const bills = Array.isArray(billsArr) ? billsArr : [];
    const active = bills.filter(b => b.status === 'active' || b.status == null);

    const totalAll = active.reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const paidThisPeriod = active.filter(b => isPaidThisPeriod(b));
    const remaining = active.filter(b => !isPaidThisPeriod(b)).reduce((s, b) => s + (Number(b.amount) || 0), 0);

    const totalEl = $('bills-total');
    if (totalEl) totalEl.textContent = fmtPKR(totalAll);

    const countEl = $('bills-count');
    if (countEl) countEl.textContent = active.length + ' bill' + (active.length === 1 ? '' : 's');

    const remainingEl = $('bills-remaining');
    if (remainingEl) remainingEl.textContent = fmtPKR(remaining);

    const paidCountEl = $('bills-paid-count');
    if (paidCountEl) paidCountEl.textContent = paidThisPeriod.length + ' paid';
  }

  /* ─────── List render ─────── */
  function renderList(billsArr) {
    const bills = Array.isArray(billsArr) ? billsArr : [];
    const listEl = $('bills-list');
    if (!listEl) return;

    if (bills.length === 0) {
      listEl.innerHTML = '<div class="empty-state-inline">No bills yet. Click + Add Bill above.</div>';
      return;
    }

    const active = bills.filter(b => b.status === 'active' || b.status == null);
    const sorted = active.sort((a, b) => {
      const aD = daysUntilDue(a.due_day);
      const bD = daysUntilDue(b.due_day);
      if (aD == null && bD == null) return (a.name || '').localeCompare(b.name || '');
      if (aD == null) return 1;
      if (bD == null) return -1;
      return aD - bD;
    });

    listEl.innerHTML = sorted.map(b => {
      const days = daysUntilDue(b.due_day);
      const paid = isPaidThisPeriod(b);
      let dueText = '';
      let dueCls = '';
      if (paid) {
        dueText = '✓ Paid this ' + (b.frequency || 'period');
        dueCls = 'meta';
      } else if (days == null) {
        dueText = 'No due day set';
        dueCls = 'meta';
      } else if (days === 0) {
        dueText = 'Due today';
        dueCls = 'meta danger';
      } else if (days === 1) {
        dueText = 'Due tomorrow';
        dueCls = 'meta warn';
      } else if (days <= 7) {
        dueText = 'Due in ' + days + ' days';
        dueCls = 'meta warn';
      } else {
        dueText = 'Due in ' + days + ' days';
        dueCls = 'meta';
      }

      return `
        <div class="mini-row" data-bill-id="${escHtml(b.id)}">
          <div class="mini-row-left">
            <div class="mini-row-meta">
              <div class="mini-row-name">${escHtml(b.name)}</div>
              <div class="mini-row-sub">
                <span class="${dueCls}">${dueText}</span>
                <span class="meta">${escHtml(b.category_id || 'bills')}</span>
              </div>
            </div>
          </div>
          <div class="mini-row-right">
            <div class="mini-row-amount value">${fmtPKR(b.amount)}</div>
            <div style="display:flex;gap:6px;margin-top:4px">
              ${paid ? '' : `<button class="ghost-btn pay-bill-btn" data-bill-id="${escHtml(b.id)}" style="font-size:11px;padding:3px 8px">Pay</button>`}
              <button class="ghost-btn edit-bill-btn" data-bill-id="${escHtml(b.id)}" style="font-size:11px;padding:3px 8px">✏️</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Wire row buttons
    listEl.querySelectorAll('.pay-bill-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const id = btn.getAttribute('data-bill-id');
        const bill = bills.find(x => x.id === id);
        if (bill) openPayModal(bill);
      });
    });
    listEl.querySelectorAll('.edit-bill-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const id = btn.getAttribute('data-bill-id');
        const bill = bills.find(x => x.id === id);
        if (bill) openEditModal(bill);
      });
    });
  }

  /* ─────── Load all ─────── */
  let _loadAllInFlight = false;
  async function loadAll() {
    if (_loadAllInFlight) {
      console.log('[bills]', VERSION, 'loadAll skip (in flight)');
      return;
    }
    _loadAllInFlight = true;
    console.log('[bills]', VERSION, 'loadAll start');
    try {
      // Refresh accounts cache so dropdowns work
      if (window.store && window.store.refreshBalances) {
        try { await window.store.refreshBalances(); } catch (_) { /* non-fatal */ }
      }

      const r = await fetch('/api/bills?cb=' + Date.now(), { cache: 'no-store' });
      const body = await r.json();
      const billsArr = Array.isArray(body.bills) ? body.bills : [];
      console.log('[bills] /api/bills', r.status, '→', billsArr.length, 'bills (keys: ' + Object.keys(body).join(',') + ')');

      if (!body.ok) throw new Error(body.error || 'bills payload not ok');

      renderStats(billsArr);
      renderList(billsArr);
    } catch (e) {
      console.error('[bills] loadAll FAILED:', e);
      const list = $('bills-list');
      if (list) list.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      const totalEl = $('bills-total');
      if (totalEl) totalEl.textContent = 'Rs —';
      const countEl = $('bills-count');
      if (countEl) countEl.textContent = 'load failed';
    } finally {
      _loadAllInFlight = false;
    }
  }

  /* ─────── Pay Bill modal ─────── */
  let _payContext = null;

  function openPayModal(bill) {
    _payContext = bill;
    const m = $('payBillModal');
    if (!m) return;
    m.style.display = 'flex';

    if ($('payBillTitle')) $('payBillTitle').textContent = 'Pay ' + bill.name;
    if ($('payBillSub')) $('payBillSub').textContent = (bill.frequency || 'monthly') + ' · ' + escHtml(bill.category_id || 'bills');
    if ($('payBillAmount')) $('payBillAmount').value = bill.amount || '';
    if ($('payBillDate')) $('payBillDate').value = todayISO();

    populateAccountDropdown('payBillAccount', bill.default_account_id);
  }

  function closePayModal() {
    const m = $('payBillModal');
    if (m) m.style.display = 'none';
    _payContext = null;
  }

  async function submitPay() {
    if (!_payContext) return;
    const btn = $('payBillConfirm');
    const accountId = $('payBillAccount')?.value;
    const amount = parseFloat($('payBillAmount')?.value || '0');
    const date = $('payBillDate')?.value || todayISO();

    if (!accountId || !amount || amount <= 0) {
      alert('Account and positive amount required');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Paying…'; }
    try {
      const r = await fetch('/api/bills/' + encodeURIComponent(_payContext.id) + '/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          amount,
          date,
          created_by: 'web-bill-pay'
        })
      });
      const data = await r.json();
      if (data.ok) {
        closePayModal();
        loadAll();
      } else {
        alert('Pay failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Pay failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm Pay'; }
    }
  }

  function wirePayModal() {
    const cancel = $('payBillCancel');
    if (cancel) cancel.addEventListener('click', closePayModal);
    const confirm = $('payBillConfirm');
    if (confirm) confirm.addEventListener('click', submitPay);
  }

  /* ─────── Add Bill modal ─────── */
  function openAddModal() {
    const m = $('addBillModal');
    if (!m) return;
    m.style.display = 'flex';
    ['newBillName', 'newBillAmount', 'newBillDueDay'].forEach(id => {
      const el = $(id);
      if (el) el.value = '';
    });
    populateAccountDropdown('newBillAccount');
    populateCategoryDropdown('newBillCategory');
  }

  function closeAddModal() {
    const m = $('addBillModal');
    if (m) m.style.display = 'none';
  }

  async function submitAdd() {
    const btn = $('addBillConfirm');
    const name = $('newBillName')?.value?.trim();
    const amount = parseFloat($('newBillAmount')?.value || '0');
    const dueDay = parseInt($('newBillDueDay')?.value || '0', 10) || null;
    const accountId = $('newBillAccount')?.value || null;
    const categoryId = $('newBillCategory')?.value || 'bills';

    if (!name || !amount || amount <= 0) {
      alert('Name and positive amount required');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          amount,
          due_day: dueDay,
          frequency: 'monthly',
          category_id: categoryId,
          default_account_id: accountId,
          created_by: 'web-bill-create'
        })
      });
      const data = await r.json();
      if (data.ok) {
        closeAddModal();
        loadAll();
      } else {
        alert('Add failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Bill'; }
    }
  }

  function wireAddModal() {
    const addBtn = $('addBillBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);
    const cancel = $('addBillCancel');
    if (cancel) cancel.addEventListener('click', closeAddModal);
    const confirm = $('addBillConfirm');
    if (confirm) confirm.addEventListener('click', submitAdd);
  }

  /* ─────── Edit Bill modal ─────── */
  let _editContext = null;

  function openEditModal(bill) {
    _editContext = bill;
    const m = $('editBillModal');
    if (!m) return;
    m.style.display = 'flex';

    if ($('editBillTitle')) $('editBillTitle').textContent = 'Edit ' + bill.name;
    if ($('editBillSub')) $('editBillSub').textContent = (bill.frequency || 'monthly') + ' · ' + escHtml(bill.id);
    if ($('editBillName')) $('editBillName').value = bill.name || '';
    if ($('editBillAmount')) $('editBillAmount').value = bill.amount || '';
    if ($('editBillDueDay')) $('editBillDueDay').value = bill.due_day || '';

    populateAccountDropdown('editBillAccount', bill.default_account_id);
    populateCategoryDropdown('editBillCategory', bill.category_id);
  }

  function closeEditModal() {
    const m = $('editBillModal');
    if (m) m.style.display = 'none';
    _editContext = null;
  }

  async function submitEdit() {
    if (!_editContext) return;
    const btn = $('editBillConfirm');
    const id = _editContext.id;

    const body = {
      name: $('editBillName')?.value?.trim(),
      amount: parseFloat($('editBillAmount')?.value || '0'),
      due_day: parseInt($('editBillDueDay')?.value || '0', 10) || null,
      default_account_id: $('editBillAccount')?.value || null,
      category_id: $('editBillCategory')?.value || 'bills',
      created_by: 'web-bill-edit'
    };

    if (!body.name || !body.amount || body.amount <= 0) {
      alert('Name and positive amount required');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await fetch('/api/bills/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (data.ok) {
        closeEditModal();
        loadAll();
      } else {
        alert('Save failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  async function deleteBill() {
    if (!_editContext) return;
    if (!confirm('Delete bill "' + _editContext.name + '"?')) return;
    const id = _editContext.id;
    try {
      const r = await fetch('/api/bills/' + encodeURIComponent(id) + '?action=delete&created_by=web-bill-delete', { method: 'DELETE' });
      const data = await r.json();
      if (data.ok) {
        closeEditModal();
        loadAll();
      } else {
        alert('Delete failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  function wireEditModal() {
    const cancel = $('editBillCancel');
    if (cancel) cancel.addEventListener('click', closeEditModal);
    const confirm = $('editBillConfirm');
    if (confirm) confirm.addEventListener('click', submitEdit);
    const del = $('editBillDelete');
    if (del) del.addEventListener('click', deleteBill);
  }

  /* ─────── Account + Category dropdowns ─────── */
  function populateAccountDropdown(elId, selectedId) {
    const sel = $(elId);
    if (!sel) return;
    const accounts = (window.store && window.store.cachedAccounts) || [];
    sel.innerHTML = '<option value="">Select account…</option>' +
      accounts.filter(a => a.type === 'asset').map(a =>
        '<option value="' + escHtml(a.id) + '"' + (a.id === selectedId ? ' selected' : '') + '>' +
        escHtml((a.icon || '') + ' ' + a.name) + '</option>'
      ).join('');
  }

  function populateCategoryDropdown(elId, selectedId) {
    const sel = $(elId);
    if (!sel) return;
    fetch('/api/categories', { cache: 'no-store' }).then(r => r.json()).then(d => {
      const cats = (d.categories || []).filter(c => !c.archived);
      sel.innerHTML = cats.map(c =>
        '<option value="' + escHtml(c.id) + '"' + (c.id === selectedId ? ' selected' : '') + '>' +
        escHtml(c.name) + '</option>'
      ).join('');
    }).catch(() => {
      sel.innerHTML = '<option value="bills">Bills</option>';
    });
  }

  /* ─────── Init ─────── */
  function init() {
    wirePayModal();
    wireAddModal();
    wireEditModal();
    loadAll();
    // Refresh every 60s (was 30s — reduced to lower API load)
    setInterval(loadAll, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
