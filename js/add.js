/*  Sovereign Finance  Add Transaction Form v0.3.3  D1 Category Source Alignment  */
/*
* Audit correction:
* - Removes phantom hardcoded category fallback.
* - Category dropdown now uses ONLY categories returned by /api/categories.
* - If D1 categories are empty/unavailable, category stays optional and submits as null.
* - This prevents UI from offering "Groceries" or any other category that D1 will reject.
*
* Contract:
* - Add page must populate accounts directly from /api/accounts.
* - It may use store.addTransaction if available.
* - If store is unavailable, it writes directly to /api/transactions.
* - No silent offline queue.
* - No phantom category IDs.
*/

(function () {
  'use strict';

  const VERSION = 'v0.3.3';

  let selectedType = 'expense';
  let accounts = [];
  let categories = [];
  let categoriesLoaded = false;
  let submitting = false;

  const $ = id => document.getElementById(id);

  function todayLocal() {
    const d = new Date();

    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('-');
  }

  function toast(msg, kind) {
    const old = document.querySelector('.toast');

    if (old) old.remove();

    const el = document.createElement('div');

    el.className = 'toast toast-' + (kind || 'info');
    el.textContent = msg;

    document.body.appendChild(el);

    setTimeout(() => el.classList.add('show'), 20);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, 3000);
  }

  function setSubmitText(text) {
    const btn = $('submitBtn');

    if (btn) btn.textContent = text;
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }

    return data;
  }

  function normalizeAccounts(raw) {
    if (Array.isArray(raw)) return raw;

    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(id => ({
        id,
        ...raw[id]
      }));
    }

    return [];
  }

  function normalizeCategories(raw) {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(c => c && c.id)
      .map(c => ({
        id: String(c.id || '').trim(),
        name: String(c.name || c.id || '').trim(),
        icon: String(c.icon || '').trim()
      }))
      .filter(c => c.id);
  }

  async function loadAccounts() {
    try {
      const data = await fetchJSON('/api/accounts?debug=1');

      accounts = normalizeAccounts(data.accounts);
    } catch (e1) {
      console.warn('[add v0.3.3] /api/accounts failed:', e1.message);

      try {
        if (window.store && typeof window.store.refreshBalances === 'function') {
          await window.store.refreshBalances();
          accounts = normalizeAccounts(window.store.accounts || window.store.cachedAccounts || []);
        }
      } catch (e2) {
        console.warn('[add v0.3.3] store account fallback failed:', e2.message);
      }
    }

    if (!accounts.length) {
      toast('Accounts failed to load. Add is blocked.', 'error');
    }
  }

  async function loadCategories() {
    categoriesLoaded = false;
    categories = [];

    try {
      const data = await fetchJSON('/api/categories');

      categories = normalizeCategories(data.categories);
      categoriesLoaded = true;
    } catch (e) {
      console.warn('[add v0.3.3] /api/categories failed:', e.message);
      categories = [];
      categoriesLoaded = false;
    }
  }

  function accountLabel(a) {
    return ((a.icon || '') + '  ' + (a.name || a.id)).trim();
  }

  function categoryLabel(c) {
    return ((c.icon || '') + '  ' + (c.name || c.id)).trim();
  }

  function fillAccounts() {
    const source = $('accountSelect');
    const dest = $('transferToSelect');

    if (source) {
      const old = source.value;

      source.innerHTML = '<option value="">Pick account...</option>';

      accounts.forEach(a => {
        if (!a || !a.id) return;

        const opt = document.createElement('option');

        opt.value = a.id;
        opt.textContent = accountLabel(a);

        source.appendChild(opt);
      });

      if (old && [...source.options].some(o => o.value === old)) {
        source.value = old;
      }
    }

    if (dest) fillTransferDest();
  }

  function fillTransferDest() {
    const dest = $('transferToSelect');
    const source = $('accountSelect');

    if (!dest) return;

    const from = source ? source.value : '';
    const old = dest.value;

    dest.innerHTML = '<option value="">Pick account...</option>';

    accounts.forEach(a => {
      if (!a || !a.id || a.id === from) return;

      const opt = document.createElement('option');

      opt.value = a.id;
      opt.textContent = accountLabel(a);

      dest.appendChild(opt);
    });

    if (old && old !== from && [...dest.options].some(o => o.value === old)) {
      dest.value = old;
    }
  }

  function fillCategories() {
    const sel = $('categorySelect');

    if (!sel) return;

    const old = sel.value;

    sel.innerHTML = '';

    const empty = document.createElement('option');

    empty.value = '';

    if (categories.length) {
      empty.textContent = 'No category';
    } else if (categoriesLoaded) {
      empty.textContent = 'No categories in D1 - save without category';
    } else {
      empty.textContent = 'Categories unavailable - save without category';
    }

    sel.appendChild(empty);

    categories.forEach(c => {
      const opt = document.createElement('option');

      opt.value = c.id;
      opt.textContent = categoryLabel(c);

      sel.appendChild(opt);
    });

    if (old && [...sel.options].some(o => o.value === old)) {
      sel.value = old;
    } else {
      sel.value = '';
    }

    sel.disabled = !categories.length;
  }

  function setType(type) {
    selectedType = type || 'expense';

    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === selectedType);
    });

    const isTransfer = selectedType === 'transfer';

    if ($('transferToWrap')) $('transferToWrap').hidden = !isTransfer;
    if ($('categoryWrap')) $('categoryWrap').hidden = isTransfer;
    if ($('accountFromLabel')) $('accountFromLabel').textContent = isTransfer ? 'From Account' : 'Account';

    fillTransferDest();
    updateButton();
  }

  function updateButton() {
    const btn = $('submitBtn');

    if (!btn) return;

    const amount = parseFloat(($('amountInput') || {}).value || '0');
    const from = ($('accountSelect') || {}).value || '';
    const to = ($('transferToSelect') || {}).value || '';

    let ok = amount > 0 && !!from && !submitting;

    if (selectedType === 'transfer') {
      ok = ok && !!to && to !== from;
    }

    btn.disabled = !ok;
  }

  function collectPayload() {
    const amount = parseFloat(($('amountInput') || {}).value || '0');
    const from = ($('accountSelect') || {}).value || '';
    const to = ($('transferToSelect') || {}).value || '';
    const category = ($('categorySelect') || {}).value || null;
    const date = ($('dateInput') || {}).value || todayLocal();
    const notes = (($('notesInput') || {}).value || '').trim();

    if (!(amount > 0)) throw new Error('Amount must be greater than 0');
    if (!from) throw new Error('Pick an account');

    const payload = {
      type: selectedType,
      amount,
      accountId: from,
      categoryId: selectedType === 'transfer' ? null : category,
      date,
      notes
    };

    if (selectedType === 'transfer') {
      if (!to) throw new Error('Pick a destination account');
      if (to === from) throw new Error('Source and destination cannot match');

      payload.transferToAccountId = to;
      payload.categoryId = null;
    }

    return payload;
  }

  async function submit(e) {
    e.preventDefault();

    if (submitting) return;

    let payload;

    try {
      payload = collectPayload();
    } catch (err) {
      toast(err.message, 'error');
      updateButton();
      return;
    }

    submitting = true;
    updateButton();
    setSubmitText('Saving...');

    try {
      let result;

      if (window.store && typeof window.store.addTransaction === 'function') {
        result = await window.store.addTransaction(payload);
      } else {
        result = await directAdd(payload);
      }

      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'Save failed');
      }

      toast(payload.type === 'transfer' ? 'Transfer saved' : 'Transaction saved', 'success');

      setTimeout(() => {
        window.location.href = '/transactions.html';
      }, 650);
    } catch (err) {
      toast(err.message || 'Save failed', 'error');

      submitting = false;
      setSubmitText('Save Transaction');
      updateButton();
    }
  }

  async function directAdd(payload) {
    const body = {
      date: payload.date,
      type: payload.type,
      amount: payload.amount,
      account_id: payload.accountId,
      category_id: payload.categoryId || null,
      notes: payload.notes,
      created_by: 'web-add-direct'
    };

    if (payload.transferToAccountId) {
      body.transfer_to_account_id = payload.transferToAccountId;
    }

    const res = await fetch('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || !data.ok) {
      return {
        ok: false,
        error: (data && data.error) || ('HTTP ' + res.status)
      };
    }

    return data;
  }

  function wireEvents() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => setType(btn.dataset.type || 'expense'));
    });

    ['amountInput', 'accountSelect', 'transferToSelect', 'categorySelect'].forEach(id => {
      const el = $(id);

      if (!el) return;

      el.addEventListener('input', updateButton);
      el.addEventListener('change', () => {
        if (id === 'accountSelect') fillTransferDest();
        updateButton();
      });
    });

    const form = $('addForm');

    if (form) form.addEventListener('submit', submit);
  }

  async function init() {
    console.log('[add v0.3.3] init');

    const date = $('dateInput');

    if (date && !date.value) date.value = todayLocal();

    wireEvents();

    await Promise.all([
      loadAccounts(),
      loadCategories()
    ]);

    fillAccounts();
    fillCategories();
    setType(selectedType);
    updateButton();

    console.log('[add v0.3.3] ready', {
      accounts: accounts.length,
      categories: categories.length,
      categoriesLoaded,
      store: window.store && window.store.version
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
