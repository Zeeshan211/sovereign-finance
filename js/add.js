/* ─── Sovereign Finance · Add Transaction Form v0.2.0 · Sub-1D-TXFER-FIX ───
 * Wires up the transfer destination dropdown added in add.html v0.6.0.
 *
 * Changes vs v0.1.0:
 *   - Type toggle now shows/hides transferToWrap + categoryWrap
 *   - Account label swaps "Account" ↔ "From Account" with type
 *   - transferToSelect populated from accounts (excludes current source)
 *   - Source change re-populates destination (excludes new source)
 *   - Submit validation: transfer requires dest, dest !== source
 *   - Submit payload includes transferToAccountId for transfer type
 *
 * PRESERVED from v0.1.0:
 *   - localToday() local-date logic
 *   - Defensive re-populate on focus
 *   - Console-log instrumentation
 *   - Defensive null checks (works even if v0.6.0 HTML not yet deployed)
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
    attachSourceChangeHandler();
    attachSubmitHandler();
    attachDefensiveRefocus();
    applyTypeMode(selectedType);
    console.log('[add v0.2.0] init complete · selectedType=', selectedType);
  }

  function buildAccountOptions(sel, excludeId) {
    sel.innerHTML = '<option value="">Pick account…</option>';
    (window.store.accounts || []).forEach(a => {
      if (excludeId && a.id === excludeId) return;
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

    if (window.store && typeof window.store.refreshBalances === 'function') {
      window.store.refreshBalances().then(() => {
        const current = sel.value;
        buildAccountOptions(sel);
        sel.value = current;
        if (selectedType === 'transfer') populateTransferToDropdown();
        console.log('[add] re-populated', sel.options.length - 1, 'accounts (after API)');
      }).catch(err => {
        console.warn('[add] refreshBalances failed:', err.message);
      });
    }
  }

  function populateTransferToDropdown() {
    const sel = document.getElementById('transferToSelect');
    if (!sel) return;
    const sourceId = (document.getElementById('accountSelect') || {}).value || '';
    const current = sel.value;
    buildAccountOptions(sel, sourceId);
    if (current && current !== sourceId) sel.value = current;
    console.log('[add] populated', sel.options.length - 1, 'destination accounts (excluding', sourceId || 'none', ')');
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
    const toSel = document.getElementById('transferToSelect');
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
    if (toSel) {
      toSel.addEventListener('focus', () => {
        if (toSel.options.length < 2) populateTransferToDropdown();
      });
      toSel.addEventListener('change', updateSubmitState);
    }
  }

  function attachSourceChangeHandler() {
    const accSel = document.getElementById('accountSelect');
    if (!accSel) return;
    accSel.addEventListener('change', () => {
      if (selectedType === 'transfer') populateTransferToDropdown();
    });
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
        applyTypeMode(selectedType);
        updateSubmitState();
      });
    });
  }

  function applyTypeMode(type) {
    const transferWrap = document.getElementById('transferToWrap');
    const categoryWrap = document.getElementById('categoryWrap');
    const fromLabel    = document.getElementById('accountFromLabel');
    const isTransfer   = type === 'transfer';

    if (transferWrap) transferWrap.hidden = !isTransfer;
    if (categoryWrap) categoryWrap.hidden = isTransfer;
    if (fromLabel)    fromLabel.textContent = isTransfer ? 'From Account' : 'Account';

    if (isTransfer) populateTransferToDropdown();
  }

  function attachAmountValidation() {
    const amt = document.getElementById('amountInput');
    if (amt) amt.addEventListener('input', updateSubmitState);
  }

  function updateSubmitState() {
    const amount  = parseFloat(document.getElementById('amountInput').value);
    const account = document.getElementById('accountSelect').value;
    const btn     = document.getElementById('submitBtn');
    let ok = (amount > 0 && !!account);
    if (selectedType === 'transfer') {
      const destSel = document.getElementById('transferToSelect');
      const dest = destSel ? destSel.value : '';
      ok = ok && !!dest && dest !== account;
    }
    btn.disabled = !ok;
  }

  function attachSubmitHandler() {
    const form = document.getElementById('addForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      const sourceId = document.getElementById('accountSelect').value;
      const data = {
        type:       selectedType,
        amount:     document.getElementById('amountInput').value,
        accountId:  sourceId,
        categoryId: document.getElementById('categorySelect').value,
        date:       document.getElementById('dateInput').value || localToday(),
        notes:      document.getElementById('notesInput').value
      };

      if (selectedType === 'transfer') {
        const destSel = document.getElementById('transferToSelect');
        const destId = destSel ? destSel.value : '';
        if (!destId) {
          showToast('Pick a destination account for the transfer', 'error');
          btn.disabled = false;
          btn.textContent = 'Save Transaction';
          return;
        }
        if (destId === sourceId) {
          showToast('Source and destination cannot be the same', 'error');
          btn.disabled = false;
          btn.textContent = 'Save Transaction';
          return;
        }
        data.transferToAccountId = destId;
        data.categoryId = ''; // backend hardcodes 'transfer' for transfer rows
      }

      const result = await window.store.addTransaction(data);

      if (result.ok) {
        let msg;
        if (result.queued) msg = 'Queued (offline) ✓';
        else if (selectedType === 'transfer') msg = 'Transfer saved ✓';
        else msg = 'Saved to cloud ✓';
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
