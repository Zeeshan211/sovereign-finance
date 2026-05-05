/* ─── Sovereign Finance · Add Transaction Form v0.3.1 · Layer 2 caller repair ─── */
/*
 * Changes vs v0.3.0:
 *   - Awaits store.refreshBalances() and store.refreshCategories() before first render.
 *   - Works with store v0.2.2 normalized accounts array.
 *   - Keeps URL prefill contract:
 *       /add.html?type=transfer&amount=N&from=ACCT&to=ACCT&notes=ENCODED
 *   - Keeps transfer validation: source and destination cannot match.
 *   - Keeps no-delete/no-edit audit-safe flow.
 *
 * Layer 2 rule:
 *   Add page must use store.js as caller contract.
 *   It must not care whether /api/balances returns accounts as object map or array.
 */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', initAddForm);

  let selectedType = 'expense';
  let pendingURLParams = null;
  let isSubmitting = false;

  const $ = id => document.getElementById(id);

  function localToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function initAddForm() {
    setDateToToday();
    captureURLParams();
    attachTypeToggle();
    attachAmountValidation();
    attachSourceChangeHandler();
    attachSubmitHandler();
    attachDefensiveRefocus();

    await loadStoreData();
    populateAccountDropdown();
    populateCategoryDropdown();
    applyTypeMode(selectedType);
    consumeURLParams();
    updateSubmitState();

    console.log('[add v0.3.1] init complete · selectedType=', selectedType);
  }

  async function loadStoreData() {
    if (!window.store) {
      console.warn('[add v0.3.1] window.store missing');
      return;
    }

    const jobs = [];

    if (typeof window.store.refreshBalances === 'function') {
      jobs.push(window.store.refreshBalances());
    }

    if (typeof window.store.refreshCategories === 'function') {
      jobs.push(window.store.refreshCategories());
    }

    try {
      await Promise.all(jobs);
    } catch (e) {
      console.warn('[add v0.3.1] store refresh warning:', e.message);
    }
  }

  function accountsArray() {
    if (!window.store) return [];

    if (Array.isArray(window.store.accounts)) return window.store.accounts;
    if (Array.isArray(window.store.cachedAccounts)) return window.store.cachedAccounts;

    if (window.store.accounts && typeof window.store.accounts === 'object') {
      return Object.keys(window.store.accounts).map(id => ({
        id,
        ...window.store.accounts[id]
      }));
    }

    return [];
  }

  function categoriesArray() {
    if (!window.store) return [];

    if (Array.isArray(window.store.categories)) return window.store.categories;
    if (Array.isArray(window.store.cachedCategories)) return window.store.cachedCategories;

    return [];
  }

  function buildAccountOptions(sel, excludeId) {
    const rows = accountsArray();

    sel.innerHTML = '<option value="">Pick account...</option>';

    rows.forEach(a => {
      if (!a || !a.id) return;
      if (excludeId && a.id === excludeId) return;

      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = ((a.icon || '🏦') + '  ' + (a.name || a.id)).trim();
      sel.appendChild(opt);
    });
  }

  function populateAccountDropdown() {
    const sel = $('accountSelect');
    if (!sel) return;

    const current = sel.value;
    buildAccountOptions(sel);

    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }

    console.log('[add v0.3.1] populated', sel.options.length - 1, 'accounts');
  }

  function populateTransferToDropdown() {
    const sel = $('transferToSelect');
    if (!sel) return;

    const sourceId = ($('accountSelect') || {}).value || '';
    const current = sel.value;

    buildAccountOptions(sel, sourceId);

    if (current && current !== sourceId && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }

    console.log('[add v0.3.1] populated', sel.options.length - 1, 'destination accounts');
  }

  function populateCategoryDropdown() {
    const sel = $('categorySelect');
    if (!sel) return;

    const current = sel.value;
    const rows = categoriesArray();

    sel.innerHTML = '<option value="">Pick category...</option>';

    rows.forEach(c => {
      if (!c || !c.id) return;

      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = ((c.icon || '📝') + '  ' + (c.name || c.id)).trim();
      sel.appendChild(opt);
    });

    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }

    console.log('[add v0.3.1] populated', sel.options.length - 1, 'categories');
  }

  function setDateToToday() {
    const dateEl = $('dateInput');
    if (!dateEl) return;
    dateEl.value = localToday();
  }

  function attachTypeToggle() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        selectedType = btn.dataset.type || 'expense';

        applyTypeMode(selectedType);
        consumeURLParams();
        updateSubmitState();
      });
    });
  }

  function applyTypeMode(type) {
    const transferWrap = $('transferToWrap');
    const categoryWrap = $('categoryWrap');
    const fromLabel = $('accountFromLabel');
    const isTransfer = type === 'transfer';

    if (transferWrap) transferWrap.hidden = !isTransfer;
    if (categoryWrap) categoryWrap.hidden = isTransfer;
    if (fromLabel) fromLabel.textContent = isTransfer ? 'From Account' : 'Account';

    if (isTransfer) populateTransferToDropdown();
  }

  function attachAmountValidation() {
    const amt = $('amountInput');
    if (amt) amt.addEventListener('input', updateSubmitState);
  }

  function attachSourceChangeHandler() {
    const accSel = $('accountSelect');
    if (!accSel) return;

    accSel.addEventListener('change', () => {
      if (selectedType === 'transfer') populateTransferToDropdown();
      consumeURLParams();
      updateSubmitState();
    });
  }

  function attachDefensiveRefocus() {
    const accSel = $('accountSelect');
    const catSel = $('categorySelect');
    const toSel = $('transferToSelect');

    if (accSel) {
      accSel.addEventListener('focus', async () => {
        if (accSel.options.length < 2) {
          await loadStoreData();
          populateAccountDropdown();
          updateSubmitState();
        }
      });

      accSel.addEventListener('change', updateSubmitState);
    }

    if (catSel) {
      catSel.addEventListener('focus', async () => {
        if (catSel.options.length < 2) {
          await loadStoreData();
          populateCategoryDropdown();
        }
      });
    }

    if (toSel) {
      toSel.addEventListener('focus', async () => {
        if (toSel.options.length < 2) {
          await loadStoreData();
          populateTransferToDropdown();
          updateSubmitState();
        }
      });

      toSel.addEventListener('change', updateSubmitState);
    }
  }

  function updateSubmitState() {
    const amountEl = $('amountInput');
    const accountEl = $('accountSelect');
    const btn = $('submitBtn');

    if (!amountEl || !accountEl || !btn) return;

    const amount = parseFloat(amountEl.value);
    const account = accountEl.value;

    let ok = amount > 0 && !!account && !isSubmitting;

    if (selectedType === 'transfer') {
      const destSel = $('transferToSelect');
      const dest = destSel ? destSel.value : '';
      ok = ok && !!dest && dest !== account;
    }

    btn.disabled = !ok;
  }

  function captureURLParams() {
    const params = new URLSearchParams(window.location.search);
    if (!params.toString()) return;

    pendingURLParams = {
      type: params.get('type'),
      amount: params.get('amount'),
      from: params.get('from'),
      to: params.get('to'),
      notes: params.get('notes')
    };

    const source = pendingURLParams.notes && pendingURLParams.notes.toLowerCase().includes('cc paydown')
      ? 'CC Planner'
      : 'link';

    showPrefillBanner(source);
  }

  function consumeURLParams() {
    if (!pendingURLParams) return;

    const p = pendingURLParams;

    const validTypes = ['expense', 'income', 'transfer'];
    if (p.type && validTypes.includes(p.type) && selectedType !== p.type) {
      const btn = document.querySelector('.type-btn[data-type="' + p.type + '"]');
      if (btn) btn.click();
    }

    if (p.amount && !isNaN(parseFloat(p.amount))) {
      const amtInput = $('amountInput');
      if (amtInput && !amtInput.value) amtInput.value = parseFloat(p.amount);
    }

    let fromConsumed = !p.from;
    if (p.from) {
      const accSel = $('accountSelect');

      if (accSel) {
        const hasOption = [...accSel.options].some(o => o.value === p.from);

        if (hasOption) {
          if (accSel.value !== p.from) {
            accSel.value = p.from;
            accSel.dispatchEvent(new Event('change'));
          }

          fromConsumed = true;
        }
      }
    }

    let toConsumed = !p.to;
    if (p.to && selectedType === 'transfer') {
      const toSel = $('transferToSelect');

      if (toSel) {
        const hasOption = [...toSel.options].some(o => o.value === p.to);

        if (hasOption) {
          if (toSel.value !== p.to) toSel.value = p.to;
          toConsumed = true;
        }
      }
    } else if (p.to && selectedType !== 'transfer') {
      toConsumed = true;
    }

    if (p.notes) {
      const notesInput = $('notesInput');
      if (notesInput && !notesInput.value) notesInput.value = p.notes.slice(0, 200);
    }

    updateSubmitState();

    if (fromConsumed && toConsumed) {
      console.log('[add v0.3.1] URL params consumed:', p);
      pendingURLParams = null;
    }
  }

  function showPrefillBanner(source) {
    const form = $('addForm');
    if (!form) return;

    const existing = document.querySelector('.prefill-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.className = 'prefill-banner';
    banner.style.cssText = 'background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:var(--accent,#22c55e);padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center';
    banner.textContent = 'Prefilled from ' + source + ' - verify before saving';

    form.insertBefore(banner, form.firstChild);
  }

  function attachSubmitHandler() {
    const form = $('addForm');
    if (!form) return;

    form.addEventListener('submit', async e => {
      e.preventDefault();

      if (isSubmitting) return;

      const btn = $('submitBtn');
      const sourceId = ($('accountSelect') || {}).value || '';
      const amount = ($('amountInput') || {}).value || '';

      if (!sourceId || !(parseFloat(amount) > 0)) {
        showToast('Amount and account are required', 'error');
        updateSubmitState();
        return;
      }

      const data = {
        type: selectedType,
        amount,
        accountId: sourceId,
        categoryId: ($('categorySelect') || {}).value || 'other',
        date: ($('dateInput') || {}).value || localToday(),
        notes: ($('notesInput') || {}).value || ''
      };

      if (selectedType === 'transfer') {
        const destId = ($('transferToSelect') || {}).value || '';

        if (!destId) {
          showToast('Pick a destination account for the transfer', 'error');
          return;
        }

        if (destId === sourceId) {
          showToast('Source and destination cannot be the same', 'error');
          return;
        }

        data.transferToAccountId = destId;
        data.categoryId = 'transfer';
      }

      isSubmitting = true;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Saving...';
      }

      try {
        const result = await window.store.addTransaction(data);

        if (result.ok) {
          let msg;

          if (result.queued) msg = 'Queued offline';
          else if (selectedType === 'transfer') msg = 'Transfer saved';
          else msg = 'Saved to cloud';

          showToast(msg, 'success');

          setTimeout(() => {
            window.location.href = '/transactions.html';
          }, 700);

          return;
        }

        showToast(result.error || 'Save failed', 'error');
      } catch (e) {
        showToast(e.message || 'Save failed', 'error');
      }

      isSubmitting = false;

      if (btn) {
        btn.textContent = 'Save Transaction';
      }

      updateSubmitState();
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
