/* ─── Sovereign Finance · Bills Page v0.8.0 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let activeBill = null;
  let billsData = { bills: [], total_monthly: 0, remaining_this_period: 0, paid_count: 0, count: 0 };

  async function init() {
    paint();
    await Promise.all([loadBills(), window.store.refreshBalances()]);
    paint();
    attachEvents();
  }

  async function loadBills() {
    try {
      const res = await fetch('/api/bills');
      const data = await res.json();
      if (data.ok) billsData = data;
    } catch (e) { console.warn('bills api offline'); }
  }

  function paint() {
    animate('bills-total', billsData.total_monthly);
    animate('bills-remaining', billsData.remaining_this_period);
    setText('bills-count', billsData.count + (billsData.count === 1 ? ' bill' : ' bills'));
    setText('bills-paid-count', billsData.paid_count + ' paid this month');
    setText('bills-summary', billsData.count + ' bills · ' + billsData.paid_count + ' paid');

    const list = document.getElementById('bills-list');
    list.innerHTML = '';

    if (billsData.bills.length === 0) {
      list.innerHTML = '<div class="empty-state-inline">No bills yet. Tap "+ Add Bill" to create your first.</div>';
      return;
    }

    billsData.bills.forEach(b => list.appendChild(buildRow(b)));
  }

  function buildRow(b) {
    const acc = b.default_account_id ? window.store.getAccount(b.default_account_id) : null;
    const cat = window.store.getCategory(b.category_id || 'bills');
    const statusClass = 'bill-status-' + b.status;

    const row = document.createElement('div');
    row.className = 'debt-row bill-row ' + statusClass;
    row.innerHTML = `
      <div class="debt-header">
        <div class="debt-info">
          <div class="debt-name">
            <span class="bill-status-dot"></span>${esc(b.name)}
          </div>
          <div class="debt-sub">${cat.icon} ${esc(cat.name)} · day ${b.due_day} · ${b.daysLabel}</div>
        </div>
        <div class="debt-amount negative">${fmt(b.amount)}<span class="debt-currency">PKR</span></div>
      </div>
      <div class="debt-meta">
        <span>${acc ? acc.icon + ' ' + acc.name : 'no default account'}</span>
        <span class="bill-status-label">${b.status.replace(/-/g, ' ')}</span>
      </div>
      <div class="debt-actions">
        <button class="debt-pay-btn" data-action="pay" data-id="${b.id}" ${b.paidThisPeriod ? 'disabled' : ''}>
          ${b.paidThisPeriod ? 'Paid ✓' : 'Mark Paid'}
        </button>
        <button class="debt-close-btn" data-action="delete" data-id="${b.id}">Delete</button>
      </div>
    `;
    row.querySelector('[data-action="pay"]').addEventListener('click', () => {
      if (!b.paidThisPeriod) openPayModal(b);
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteBill(b));
    return row;
  }

  function openPayModal(bill) {
    activeBill = bill;
    document.getElementById('payBillTitle').textContent = 'Pay ' + bill.name;
    document.getElementById('payBillSub').textContent = 'Default amount: ' + fmt(bill.amount) + ' PKR';
    document.getElementById('payBillAmount').value = bill.amount;
    document.getElementById('payBillDate').value = new Date().toISOString().slice(0, 10);

    const sel = document.getElementById('payBillAccount');
    sel.innerHTML = '';
    window.store.accounts.filter(a => a.type === 'asset').forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.icon + '  ' + a.name;
      if (a.id === bill.default_account_id) opt.selected = true;
      sel.appendChild(opt);
    });

    document.getElementById('payBillModal').style.display = 'flex';
  }

  function closePayModal() {
    document.getElementById('payBillModal').style.display = 'none';
    activeBill = null;
  }

  function openAddModal() {
    document.getElementById('newBillName').value = '';
    document.getElementById('newBillAmount').value = '';
    document.getElementById('newBillDueDay').value = '1';

    const accSel = document.getElementById('newBillAccount');
    accSel.innerHTML = '<option value="">No default</option>';
    window.store.accounts.filter(a => a.type === 'asset').forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.icon + '  ' + a.name;
      accSel.appendChild(opt);
    });

    const catSel = document.getElementById('newBillCategory');
    catSel.innerHTML = '';
    window.store.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.icon + '  ' + c.name;
      if (c.id === 'bills') opt.selected = true;
      catSel.appendChild(opt);
    });

    document.getElementById('addBillModal').style.display = 'flex';
  }

  function closeAddModal() {
    document.getElementById('addBillModal').style.display = 'none';
  }

  function attachEvents() {
    document.getElementById('addBillBtn').addEventListener('click', openAddModal);
    document.getElementById('payBillCancel').addEventListener('click', closePayModal);
    document.getElementById('payBillConfirm').addEventListener('click', confirmPay);
    document.getElementById('addBillCancel').addEventListener('click', closeAddModal);
    document.getElementById('addBillConfirm').addEventListener('click', confirmAdd);

    document.getElementById('payBillModal').addEventListener('click', (e) => {
      if (e.target.id === 'payBillModal') closePayModal();
    });
    document.getElementById('addBillModal').addEventListener('click', (e) => {
      if (e.target.id === 'addBillModal') closeAddModal();
    });
  }

  async function confirmPay() {
    if (!activeBill) return;
    const amount = parseFloat(document.getElementById('payBillAmount').value);
    const accountId = document.getElementById('payBillAccount').value;
    const date = document.getElementById('payBillDate').value;
    if (isNaN(amount) || amount <= 0) { showToast('Enter amount', 'error'); return; }
    if (!accountId) { showToast('Pick account', 'error'); return; }

    const btn = document.getElementById('payBillConfirm');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      const res = await fetch('/api/bills/' + encodeURIComponent(activeBill.id) + '/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, account_id: accountId, date })
      });
      const data = await res.json();
      if (!data.ok) { showToast(data.error || 'Failed', 'error'); }
      else {
        showToast('Marked paid ✓', 'success');
        closePayModal();
        await Promise.all([loadBills(), window.store.refreshBalances()]);
        paint();
      }
    } catch (e) { showToast('Network error', 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Mark Paid'; }
  }

  async function confirmAdd() {
    const name = document.getElementById('newBillName').value.trim();
    const amount = parseFloat(document.getElementById('newBillAmount').value);
    const dueDay = parseInt(document.getElementById('newBillDueDay').value);
    const accountId = document.getElementById('newBillAccount').value;
    const categoryId = document.getElementById('newBillCategory').value;

    if (!name) { showToast('Bill name required', 'error'); return; }
    if (isNaN(amount) || amount <= 0) { showToast('Enter amount', 'error'); return; }

    const btn = document.getElementById('addBillConfirm');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, amount, due_day: dueDay,
          default_account_id: accountId || null,
          category_id: categoryId || 'bills'
        })
      });
      const data = await res.json();
      if (!data.ok) { showToast(data.error || 'Failed', 'error'); }
      else {
        showToast('Bill added ✓', 'success');
        closeAddModal();
        await loadBills();
        paint();
      }
    } catch (e) { showToast('Network error', 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Add Bill'; }
  }

  async function deleteBill(bill) {
    if (!confirm('Delete bill "' + bill.name + '"? (Past payments stay in transactions)')) return;
    try {
      const res = await fetch('/api/bills/' + encodeURIComponent(bill.id), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) { showToast('Deleted', 'success'); await loadBills(); paint(); }
      else showToast(data.error || 'Failed', 'error');
    } catch (e) { showToast('Network error', 'error'); }
  }

  function animate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.animateNumber) window.animateNumber(el, val);
    else el.textContent = fmt(val);
  }

  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  function showToast(msg, kind) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (kind || 'info');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2200);
  }
})();
