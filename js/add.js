/* ─── Sovereign Finance · Add Transaction Form v0.0.9 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', initAddForm);

  let selectedType = 'expense';

  function initAddForm() {
    populateAccountDropdown();
    populateCategoryDropdown();
    setDateToToday();
    attachTypeToggle();
    attachAmountValidation();
    attachSubmitHandler();
  }

  function populateAccountDropdown() {
    const sel = document.getElementById('accountSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Pick account…</option>';
    window.store.accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.icon + '  ' + a.name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', updateSubmitState);

    // Re-populate after API loads (async)
    window.store.refreshAccounts().then(() => {
      if (sel.options.length <= window.store.accounts.length) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">Pick account…</option>';
      window.store.accounts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.icon + '  ' + a.name;
        sel.appendChild(opt);
      });
      sel.value = current;
    });
  }

  function populateCategoryDropdown() {
    const sel = document.getElementById('categorySelect');
    if (!sel) return;
    window.store.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.icon + '  ' + c.name;
      sel.appendChild(opt);
    });
  }

  function setDateToToday() {
    const dateEl = document.getElementById('dateInput');
    if (!dateEl) return;
    dateEl.value = new Date().toISOString().slice(0, 10);
  }

  function attachTypeToggle() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedType = btn.dataset.type;
      });
    });
  }

  function attachAmountValidation() {
    const amt = document.getElementById('amountInput');
    if (amt) amt.addEventListener('input', updateSubmitState);
  }

  function updateSubmitState() {
    const amount = parseFloat(document.getElementById('amountInput').value);
    const account = document.getElementById('accountSelect').value;
    const btn = document.getElementById('submitBtn');
    btn.disabled = !(amount > 0 && account);
  }

  function attachSubmitHandler() {
    const form = document.getElementById('addForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      const data = {
        type: selectedType,
        amount: document.getElementById('amountInput').value,
        accountId: document.getElementById('accountSelect').value,
        categoryId: document.getElementById('categorySelect').value,
        date: document.getElementById('dateInput').value,
        notes: document.getElementById('notesInput').value
      };

      const result = await window.store.addTransaction(data);

      if (result.ok) {
        const msg = result.queued ? 'Queued (offline) ✓' : 'Saved to cloud ✓';
        showToast(msg, 'success');
        setTimeout(() => { window.location.href = '/transactions.html'; }, 700);
      } else {
        showToast(result.error || 'Save failed', 'error');
        btn.disabled = false;
        btn.textContent = 'Save Transaction';
      }
    });
  }

  function showToast(msg, kind) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (kind || 'info');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2200);
  }
})();