/* ─── Sovereign Finance · Debts Page v0.3.0 ─── */

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
    const owe = data.debts.filter(d => d.kind === 'owe');
    const owed = data.debts.filter(d => d.kind === 'owed');

    setText('debts-total-owe', fmt(data.total_owe));
    setText('debts-summary',
      data.debts.length + ' total · ' + owe.length + ' owe · ' + owed.length + ' owed');
    setText('debts-owe-count', owe.length + ' debts · ' + fmt(data.total_owe) + ' PKR');
    setText('debts-owed-count', owed.length + ' · ' + fmt(data.total_owed) + ' PKR');

    const oweList = document.getElementById('debts-owe-list');
    const owedList = document.getElementById('debts-owed-list');
    oweList.innerHTML = '';
    owedList.innerHTML = '';

    if (owe.length === 0) oweList.innerHTML = '<div class="empty-state-inline">No debts. Mashallah.</div>';
    else owe.sort((a, b) => (a.snowball_order || 99) - (b.snowball_order || 99))
            .forEach(d => oweList.appendChild(buildRow(d)));

    if (owed.length === 0) owedList.innerHTML = '<div class="empty-state-inline">No receivables.</div>';
    else owed.forEach(d => owedList.appendChild(buildRow(d)));
  }

  function buildRow(d) {
    const original = d.original_amount || 0;
    const paid = d.paid_amount || 0;
    const remaining = original - paid;
    const pct = original > 0 ? Math.min(100, Math.round((paid / original) * 100)) : 0;
    const isReceivable = d.kind === 'owed';

    const row = document.createElement('div');
    row.className = 'debt-row';
    row.innerHTML = `
      <div class="debt-header">
        <div class="debt-info">
          <div class="debt-name">${esc(d.name)}</div>
          <div class="debt-sub">${isReceivable ? '↘️ owes you' : '↗️ snowball #' + (d.snowball_order || '-')}</div>
        </div>
        <div class="debt-amount ${isReceivable ? 'positive' : 'negative'}">
          ${fmt(remaining)}<span class="debt-currency">PKR</span>
        </div>
      </div>
      <div class="debt-progress">
        <div class="debt-progress-bar" style="width:${pct}%"></div>
      </div>
      <div class="debt-meta">
        <span>paid ${fmt(paid)} of ${fmt(original)}</span>
        <span>${pct}%</span>
      </div>
      <div class="debt-actions">
        <button class="debt-pay-btn" data-id="${d.id}">${isReceivable ? '💰 Receive' : '💸 Pay'}</button>
      </div>
    `;
    row.querySelector('.debt-pay-btn').addEventListener('click', () => openPayModal(d));
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
      btn.textContent = 'Confirm Payment';
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
