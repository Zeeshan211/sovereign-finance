/* ─── Sovereign Finance · Add Transaction Form v0.1.0 · Sub-1D-3a-fix3 ─── */
/* CHANGES from v0.0.9:
   - Removed broken window.store.refreshAccounts() call (method doesn't exist → was throwing
     TypeError → killing the rest of init → category dropdown stayed empty)
   - Now uses window.store.refreshBalances() which exists AND updates accounts as side effect
   - today() uses LOCAL date (was UTC, off-by-1 in Karachi mornings)
   - Defensive re-populate on dropdown focus if list looks empty
   - Console logs to confirm population fired
*/

(function () {
  document.addEventListener('DOMContentLoaded', initAddForm);

  let selectedType = 'expense';

  function localToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function initAddForm() {
    populateAccountDropdown();
    populateCategoryDropdown();
    setDateToToday();
    attachTypeToggle();
    attachAmountValidation();
    attachSubmitHandler();
    attachDefensiveRefocus();
    console.log('[add] init complete · selectedType=', selectedType);
  }

  function buildAccountOptions(sel) {
    sel.innerHTML = '<option value="">Pick account…</option>';
    (window.store.accounts || []).forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = (a.icon || '🏦') + '  ' + a.name;
      sel.appendChild(opt);
    });
  }

  function populateAccountDropdown() {
    const sel = document.getElementById('accountSelect');
    if (!sel) return;
    buildAccountOptions(sel);
    sel.addEventListener('change', updateSubmitState);
    console.log('[add] populated', sel.options.length - 1, 'accounts (first pass)');

    // Refresh from API and rebuild (use refreshBalances which updates cachedAccounts)
    if (window.store && typeof window.store.refreshBalances === 'function') {
      window.store.refreshBalances().then(() => {
        const current = sel.value;
        buildAccountOptions(sel);
        sel.value = current;
        console.log('[add] re-populated', sel.options.length - 1, 'accounts (after API)');
      }).catch(err => {
        console.warn('[add] refreshBalances failed:', err.message);
      });
    }
  }

  function populateCategoryDropdown() {
    const sel = document.getElementById('categorySelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Pick category…</option>';
    (window.store.categories || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = (c.icon || '📝') + '  ' + c.name;
      sel.appendChild(opt);
    });
    console.log('[add] populated', sel.options.length - 1, 'categories');
  }

  function attachDefensiveRefocus() {
    const accSel = document.getElementById('accountSelect');
    const catSel = document.getElementById('categorySelect');
    if (accSel) {
      accSel.addEventListener('focus', () => {
        if (accSel.options.length < 2) populateAccountDropdown();
      });
    }
    if (catSel) {
      catSel.addEventListener('focus', () => {
        if (catSel.options.length < 2) populateCategoryDropdown();
      });
    }
  }

  function setDateToToday() {
    const dateEl = document.getElementById('dateInput');
    if (!dateEl) return;
    dateEl.value = localToday();
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
        date: document.getElementById('dateInput').value || localToday(),
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
