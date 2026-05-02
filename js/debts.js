/* ─── Sovereign Finance · Debts Page v0.3.1 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let activeDebt = null;

  async function init() {
    paint();
    await Promise.all([
      window.store.refreshDebts(),
      window.store.refreshBalances()
    ]);
    paint();
    attachModalEvents();
  }

  function paint() {
    const data = window.store.debts || { debts: [], total_owe: 0, total_owed: 0 };
    const owe = data.debts.filter(d => d.kind === 'owe' && d.status === 'active');
    const owed = data.debts.filter(d => d.kind === 'owed' && d.status === 'active');
    const closed = data.debts.filter(d => d.status === 'closed');

    setText('debts-total-owe', fmt(data.total_owe) + ' PKR');
    setText('debts-total-owed', fmt(data.total_owed) + ' PKR');
    setText('debts-owe-count', owe.length + (owe.length === 1 ? ' debt' : ' debts'));
    setText('debts-owed-count', owed.length + (owed.length === 1 ? ' person' : ' people'));
    setText('debts-summary', closed.length + ' cleared · ' + (owe.length + owed.length) + ' active');
    setText('debts-net-burden', 'Net: ' + fmt(data.total_owe - data.total_owed) + ' PKR');

    const oweList = document.getElementById('debts-owe-list');
    const owedList = document.getElementById('debts-owed-list');
    const rcvHeader = document.getElementById('receivables-header');
    oweList.innerHTML = '';
    owedList.innerHTML = '';

    if (owe.length === 0) {
      oweList.innerHTML = '<div class="empty-state-inline">No active debts. Mashallah.</div>';
    } else {
      owe.sort((a, b) => (a.snowball_order || 99) - (b.snowball_order || 99))
         .forEach((d, idx) => oweList.appendChild(buildRow(d, idx === 0)));
    }

    if (owed.length === 0) {
      rcvHeader.style.display = 'none';
      owedList.style.display = 'none';
    } else {
      rcvHeader.style.display = '';
      owedList.style.display = '';
      owed.forEach(d => owedList.appendChild(buildRow(d, false)));
    }
  }

  function buildRow(d, isFirst) {
    const original = d.original_amount || 0;
    const paid = d.paid_amount || 0;
    const remaining = original - paid;
    const pct = original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0;
    const isReceivable = d.kind === 'owed';
    const progressClass = pct >= 100 ? 'done' : (pct >= 50 ? 'half' : 'start');

    const row = document.createElement('div');
    row.className = 'debt-row' + (isFirst ? ' debt-first' : '');
    row.innerHTML = `
      <div class="debt-header">
        <div class="debt-info">
          <div class="debt-name">
            ${isFirst ? '<span class="debt-pin">FIRST</span>' : ''}${esc(d.name)}
          </div>
          <div class="debt-sub">${isReceivable ? 'owes you' : 'snowball #' + (d.snowball_order || '-')}</div>
        </div>
        <div class="debt-amount ${isReceivable ? 'positive' : 'negative'}">
          ${fmt(remaining)}<span class="debt-currency">PKR</span>
        </div>
      </div>
      <div class="debt-progress">
        <div class="debt-progress-bar ${progressClass}" style="width:${pct}%"></div>
      </div>
      <div class="debt-meta">
        <span>paid ${fmt(paid)} of ${fmt(original)}</span>
        <span>${pct}%</span>
      </div>
      <div class="debt-actions">
        <button class="debt-pay-btn" data-action="pay">${isReceivable ? 'Receive' : 'Pay'}</button>
        <button class="debt-close-btn" data-action="close">Mark Cleared</button>
      </div>
    `;
    row.querySelector('[data-action="pay"]').addEventListener('click', () => openPayModal(d));
    row.querySelector('[data-action="close"]').addEventListener('click', () => closeDebt(d));
    return row;
  }

  function openPayModal(debt) {
    activeDebt = debt;
    const remaining = (debt.original_amount || 0) - (debt.paid_amount || 0);
    document.getElementById('payModalTitle').textContent =
      (debt.kind === 'owed' ? 'Receive from ' : 'Pay ') + debt.name;
    document.getElementById('payModalSub').textContent = 'Remaining: ' + fmt(remaining) + ' PKR';
    document.getElementById('payAmount').value = '';
    document.getElementById('payDate').value = new Date().toISOString().slice(0, 10);

    const sel = document.getElementById('payAccount');
    sel.innerHTML = '';
    window.store.accounts.filter(a => a.type === 'asset').forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.icon + '  ' + a.name;
      sel.appendChild(opt);
    });

    document.getElementById('payModal').style.display = 'flex';
  }

  function closeModal() {
    document.getElementById('payModal').style.display = 'none';
    activeDebt = null;
  }

  function attachModalEvents() {
    document.getElementById('payCancel').addEventListener('click', closeModal);
    document.getElementById('payConfirm').addEventListener('click', confirmPayment);
    document.getElementById('payModal').addEventListener('click', (e) => {
      if (e.target.id === 'payModal') closeModal();
    });
  }

  async function confirmPayment() {
    if (!activeDebt) return;
    const amount = parseFloat(document.getElementById('payAmount').value);
    const accountId = document.getElementById('payAccount').value;
    const date = document.getElementById('payDate').value;
    if (isNaN(amount) || amount <= 0) { showToast('Enter amount', 'error'); return; }
    if (!accountId) { showToast('Pick account', 'error'); return; }

    const btn = document.getElementById('payConfirm');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      const res = await fetch('/api/debts/' + encodeURIComponent(activeDebt.id) + '/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, account_id: accountId, date })
      });
      const data = await res.json();
      if (!data.ok) {
        showToast(data.error || 'Failed', 'error');
      } else {
        showToast('Saved ✓', 'success');
        closeModal();
        await Promise.all([
          window.store.refreshDebts(),
          window.store.refreshBalances(),
          window.store.refreshTransactions()
        ]);
        paint();
      }
    } catch (e) {
      showToast('Network error', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm';
    }
  }

  async function closeDebt(debt) {
    if (!confirm('Mark "' + debt.name + '" as fully cleared? (You can reopen later if needed)')) return;
    try {
      const res = await fetch('/api/debts/' + encodeURIComponent(debt.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: debt.name,
          kind: debt.kind,
          original_amount: debt.original_amount,
          paid_amount: debt.original_amount,
          snowball_order: debt.snowball_order,
          due_date: debt.due_date,
          status: 'closed',
          notes: debt.notes
        })
      });
      const data = await res.json();
      if (!data.ok) {
        showToast(data.error || 'Failed', 'error');
      } else {
        showToast('Cleared ✓', 'success');
        await Promise.all([window.store.refreshDebts(), window.store.refreshBalances()]);
        paint();
      }
    } catch (e) {
      showToast('Network error', 'error');
    }
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