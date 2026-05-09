/* Sovereign Finance Add Transaction Form v0.4.3
   Phase 4A Command Centre enforcement soft block.
   Contract:
   - Same save payload and write path as v0.4.1 when allowed.
   - Adds transaction.save frontend soft block.
   - Add page remains viewable/diagnostic.
   - Save button is disabled when backend enforcement blocks transaction.save.
   - Every block shows action, reason, source, required fix, override status.
   - No backend changes.
   - No D1 changes.
   - No ledger tests.
*/

(function () {
  'use strict';

  const VERSION = 'v0.4.3';
  const ENFORCED_ACTION = 'transaction.save';

  let selectedType = 'expense';
  let requestedTo = '';
  let requestedFrom = '';
  let accounts = [];
  let categories = [];
  let categoriesLoaded = false;
  let submitting = false;

  let enforcementLoaded = false;
  let enforcementError = '';
  let saveGate = {
    allowed: false,
    status: 'blocked',
    action: ENFORCED_ACTION,
    reason: 'Command Centre enforcement policy has not loaded yet.',
    source: 'window.SovereignEnforcement',
    required_fix: 'Wait for /api/finance-command-center to load before allowing writes.',
    override: { allowed: false },
    backend_enforced: false,
    frontend_enforced: true
  };

  const $ = id => document.getElementById(id);

  function todayLocal() {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('-');
  }

  function parseRoute() {
    const params = new URLSearchParams(window.location.search || '');
    const type = String(params.get('type') || '').toLowerCase().trim();
    const to = String(params.get('to') || '').trim();
    const from = String(params.get('from') || '').trim();

    if (['expense', 'income', 'transfer'].includes(type)) selectedType = type;
    if (to) requestedTo = to;
    if (from) requestedFrom = from;
    if (requestedTo && selectedType !== 'transfer') selectedType = 'transfer';
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
    if (raw && Array.isArray(raw.accounts)) return raw.accounts;

    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(id => ({ id, ...raw[id] }));
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

  function accountName(a) {
    return String(a.name || a.label || a.account_name || a.id || '').trim();
  }

  function accountKind(a) {
    return String(a.kind || a.type || '').toLowerCase().trim();
  }

  function accountLabel(a) {
    const name = accountName(a);
    const kind = accountKind(a);
    return [name, kind ? '(' + kind + ')' : ''].filter(Boolean).join(' ').trim();
  }

  function categoryLabel(c) {
    return (c.name || c.id || '').trim();
  }

  function findAccountById(id) {
    return accounts.find(a => String(a.id) === String(id)) || null;
  }

  function findCategoryById(id) {
    return categories.find(c => String(c.id) === String(id)) || null;
  }

  function findAccountByRouteKey(value) {
    if (!value) return null;

    const key = String(value).toLowerCase().trim();

    return accounts.find(account => {
      const id = String(account.id || '').toLowerCase();
      const name = accountName(account).toLowerCase();
      const kind = accountKind(account);

      if (id === key) return true;
      if (name === key) return true;
      if (key === 'cc' && (id === 'cc' || kind === 'cc' || name.includes('credit') || name.includes('alfalah cc'))) return true;
      if (key === 'credit_card' && (kind === 'cc' || name.includes('credit'))) return true;

      return false;
    }) || null;
  }

  function normalizeGate(raw) {
    if (!raw) {
      return {
        allowed: false,
        status: 'blocked',
        action: ENFORCED_ACTION,
        reason: 'Command Centre returned no action policy for transaction.save.',
        source: 'enforcement.actions',
        required_fix: 'Register transaction.save in backend enforcement actions.',
        override: { allowed: false },
        backend_enforced: false,
        frontend_enforced: true
      };
    }

    return {
      ...raw,
      allowed: raw.allowed === true,
      status: raw.allowed === true ? 'pass' : (raw.status || 'blocked'),
      action: raw.action || ENFORCED_ACTION,
      reason: raw.reason || 'Command Centre blocked this action.',
      source: raw.source || 'enforcement.actions',
      required_fix: raw.required_fix || 'Resolve the Command Centre blocker.',
      override: raw.override || { allowed: false },
      backend_enforced: raw.backend_enforced === true,
      frontend_enforced: true
    };
  }

  function syncEnforcement(snapshot) {
    enforcementLoaded = Boolean(snapshot && snapshot.loaded);
    enforcementError = snapshot && snapshot.error ? String(snapshot.error) : '';

    if (!snapshot || !snapshot.loaded) {
      saveGate = {
        allowed: false,
        status: 'blocked',
        action: ENFORCED_ACTION,
        reason: enforcementError || 'Command Centre enforcement policy has not loaded yet.',
        source: 'window.SovereignEnforcement',
        required_fix: 'Reload Add Transaction or open Command Centre to verify enforcement policy.',
        override: { allowed: false },
        backend_enforced: false,
        frontend_enforced: true
      };
      renderEnforcement();
      updateButton();
      return;
    }

    let gate = null;

    if (typeof snapshot.findAction === 'function') {
      gate = snapshot.findAction(ENFORCED_ACTION);
    }

    if (!gate && snapshot.enforcement && Array.isArray(snapshot.enforcement.actions)) {
      gate = snapshot.enforcement.actions.find(item => item.action === ENFORCED_ACTION);
    }

    saveGate = normalizeGate(gate);
    renderEnforcement();
    updateButton();
  }

  function ensureEnforcementSubscription() {
    if (window.SovereignEnforcement && typeof window.SovereignEnforcement.subscribe === 'function') {
      window.SovereignEnforcement.subscribe(syncEnforcement);
      if (typeof window.SovereignEnforcement.refresh === 'function') {
        window.SovereignEnforcement.refresh();
      }
      return;
    }

    saveGate = {
      allowed: false,
      status: 'blocked',
      action: ENFORCED_ACTION,
      reason: 'Command Centre enforcement loader is unavailable.',
      source: '/js/enforcement.js',
      required_fix: 'Confirm /js/enforcement.js loads before Add can write.',
      override: { allowed: false },
      backend_enforced: false,
      frontend_enforced: true
    };

    renderEnforcement();
    updateButton();
  }

  function renderEnforcement() {
    const panel = $('addEnforcementPanel');
    const chip = $('enforcementChip');

    if (!panel) return;

    const blocked = !saveGate.allowed;

    panel.hidden = false;
    panel.classList.toggle('warning', enforcementLoaded && blocked && saveGate.status !== 'blocked');

    const summary = $('addEnforcementSummary');
    const action = $('addBlockedAction');
    const reason = $('addBlockReason');
    const source = $('addBlockSource');
    const fix = $('addRequiredFix');
    const override = $('addOverrideStatus');
    const backend = $('addBackendStatus');

    if (summary) {
      summary.textContent = blocked
        ? 'Command Centre has blocked saving on this page. Viewing and editing fields is still allowed for diagnosis.'
        : 'Command Centre currently allows transaction.save. Backend API enforcement is still not active unless marked separately.';
    }

    if (action) action.textContent = saveGate.action || ENFORCED_ACTION;
    if (reason) reason.textContent = saveGate.reason || 'No reason returned.';
    if (source) source.textContent = saveGate.source || 'No source returned.';
    if (fix) fix.textContent = saveGate.required_fix || 'No required fix returned.';
    if (override) override.textContent = saveGate.override && saveGate.override.allowed ? 'Allowed' : 'Not allowed';
    if (backend) backend.textContent = saveGate.backend_enforced ? 'Yes' : 'No - frontend soft block only';

    if (chip) chip.hidden = !blocked;
  }

  function previewEmpty(id, title, sub) {
    const el = $(id);
    if (!el) return;

    el.classList.add('empty');
    el.innerHTML = `
      <span class="sf-bank-logo-wrap sf-icon-md sf-bank-default">
        <span class="sf-bank-fallback">?</span>
      </span>
      <span class="add-icon-preview-text">
        <strong>${title}</strong>
        <small>${sub}</small>
      </span>
    `;
  }

  function renderAccountPreview(previewId, accountId, emptyTitle) {
    const account = findAccountById(accountId);

    if (!account) {
      previewEmpty(previewId, emptyTitle, 'No account selected');
      return;
    }

    const el = $(previewId);
    if (!el) return;

    const iconHtml = window.SovereignIcons
      ? window.SovereignIcons.bank(account.id, { label: accountName(account), size: 'md' })
      : `<span class="sf-bank-logo-wrap sf-icon-md sf-bank-default"><span class="sf-bank-fallback">${String(account.id || '?').slice(0, 2).toUpperCase()}</span></span>`;

    el.classList.remove('empty');
    el.innerHTML = `
      ${iconHtml}
      <span class="add-icon-preview-text">
        <strong>${accountName(account)}</strong>
        <small>${accountKind(account) || 'account'}  ${account.id}</small>
      </span>
    `;
  }

  function renderCategoryPreview(categoryId) {
    const category = findCategoryById(categoryId);

    if (!category) {
      previewEmpty(
        'categoryPreview',
        categories.length ? 'No category' : 'Categories unavailable',
        categories.length ? 'Optional' : 'Save still allowed'
      );
      return;
    }

    const el = $('categoryPreview');
    if (!el) return;

    const iconHtml = window.SovereignIcons
      ? window.SovereignIcons.category(category.id, { label: categoryLabel(category), size: 'md' })
      : `<span class="sf-category-icon sf-icon-md sf-cat-slate"></span>`;

    el.classList.remove('empty');
    el.innerHTML = `
      ${iconHtml}
      <span class="add-icon-preview-text">
        <strong>${categoryLabel(category)}</strong>
        <small>${category.id}</small>
      </span>
    `;
  }

  function updatePreviews() {
    renderAccountPreview('accountPreview', ($('accountSelect') || {}).value || '', 'Pick account');

    if (selectedType === 'transfer') {
      renderAccountPreview('transferToPreview', ($('transferToSelect') || {}).value || '', 'Pick destination');
    }

    renderCategoryPreview(($('categorySelect') || {}).value || '');

    if (window.SovereignIcons && typeof window.SovereignIcons.decorate === 'function') {
      window.SovereignIcons.decorate(document);
    }
  }

  async function loadAccounts() {
    try {
      const data = await fetchJSON('/api/accounts?debug=1');
      accounts = normalizeAccounts(data.accounts || data);
    } catch (e1) {
      console.warn('[add v0.4.3] /api/accounts failed:', e1.message);

      try {
        if (window.store && typeof window.store.refreshBalances === 'function') {
          await window.store.refreshBalances();
          accounts = normalizeAccounts(window.store.accounts || window.store.cachedAccounts || []);
        }
      } catch (e2) {
        console.warn('[add v0.4.3] store account fallback failed:', e2.message);
      }
    }

    accounts = accounts.filter(a => a && a.id);

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
      console.warn('[add v0.4.3] /api/categories failed:', e.message);
      categories = [];
      categoriesLoaded = false;
    }
  }

  function fillAccounts() {
    const source = $('accountSelect');
    const dest = $('transferToSelect');

    if (source) {
      const old = source.value;
      source.innerHTML = '<option value="">Pick account...</option>';

      accounts.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = accountLabel(a);
        source.appendChild(opt);
      });

      const routeFrom = findAccountByRouteKey(requestedFrom);

      if (routeFrom && [...source.options].some(o => o.value === routeFrom.id)) {
        source.value = routeFrom.id;
      } else if (old && [...source.options].some(o => o.value === old)) {
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

    const routeTo = findAccountByRouteKey(requestedTo);

    if (routeTo && routeTo.id !== from && [...dest.options].some(o => o.value === routeTo.id)) {
      dest.value = routeTo.id;
      requestedTo = '';
    } else if (old && old !== from && [...dest.options].some(o => o.value === old)) {
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

  function updateRouteCopy(type) {
    const trustPanel = $('addTrustPanel');
    const trustText = $('addTrustText');
    const safetyText = $('addSafetyText');
    const chip = $('submitClarityChip');

    const copy = {
      expense: {
        panelClass: 'add-trust-panel',
        chipClass: 'add-chip',
        chip: 'Creates ledger transaction',
        trust: 'Expense creates one ledger transaction and reduces the selected account balance.',
        safety: 'Expense mode creates one transaction and reduces the selected account. If saving is blocked, Command Centre shows why.'
      },
      income: {
        panelClass: 'add-trust-panel income',
        chipClass: 'add-chip safe',
        chip: 'Creates ledger transaction',
        trust: 'Income creates one ledger transaction and increases the selected account balance.',
        safety: 'Income mode creates one transaction and increases the selected account. If saving is blocked, Command Centre shows why.'
      },
      transfer: {
        panelClass: 'add-trust-panel transfer',
        chipClass: 'add-chip transfer',
        chip: 'Creates linked transaction pair',
        trust: 'Transfer creates a linked pair: money leaves the source account and enters the destination account.',
        safety: 'Transfer mode creates linked OUT and IN rows. If saving is blocked, Command Centre shows why.'
      }
    };

    const item = copy[type] || copy.expense;

    if (trustPanel) trustPanel.className = item.panelClass;
    if (trustText) trustText.textContent = item.trust;
    if (safetyText) safetyText.textContent = item.safety;

    if (chip) {
      chip.className = item.chipClass;
      chip.textContent = item.chip;
    }
  }

  function setType(type) {
    selectedType = ['expense', 'income', 'transfer'].includes(type) ? type : 'expense';

    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === selectedType);
    });

    const isTransfer = selectedType === 'transfer';

    document.body.classList.toggle('transfer-mode', isTransfer);

    if ($('transferToWrap')) $('transferToWrap').hidden = !isTransfer;
    if ($('categoryWrap')) $('categoryWrap').hidden = isTransfer;
    if ($('accountFromLabel')) $('accountFromLabel').textContent = isTransfer ? 'From Account' : 'Account';

    fillTransferDest();
    updateRouteCopy(selectedType);
    updateButton();
    updatePreviews();
  }

  function updateButton() {
    const btn = $('submitBtn');
    if (!btn) return;

    const amount = parseFloat(($('amountInput') || {}).value || '0');
    const from = ($('accountSelect') || {}).value || '';
    const to = ($('transferToSelect') || {}).value || '';

    let ok = amount > 0 && !!from && !submitting && saveGate.allowed;

    if (selectedType === 'transfer') {
      ok = ok && !!to && to !== from;
    }

    btn.disabled = !ok;

    if (!saveGate.allowed) {
      setSubmitText('Blocked by Command Centre');
    } else if (!submitting) {
      setSubmitText('Save Transaction');
    }
  }

  function collectPayload() {
    if (!saveGate.allowed) {
      throw new Error('Command Centre blocked transaction.save: ' + (saveGate.reason || 'No reason returned.'));
    }

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

  function wireEvents() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => setType(btn.dataset.type || 'expense'));
    });

    ['amountInput', 'accountSelect', 'transferToSelect', 'categorySelect', 'dateInput', 'notesInput'].forEach(id => {
      const el = $(id);
      if (!el) return;

      el.addEventListener('input', updateButton);
      el.addEventListener('change', () => {
        if (id === 'accountSelect') fillTransferDest();
        updateButton();
        updatePreviews();
      });
    });

    const form = $('addForm');
    if (form) form.addEventListener('submit', submit);
  }

  async function init() {
    console.log('[add v0.4.3] init');

    parseRoute();

    const date = $('dateInput');
    if (date && !date.value) date.value = todayLocal();

    wireEvents();
    ensureEnforcementSubscription();

    await Promise.all([
      loadAccounts(),
      loadCategories()
    ]);

    fillAccounts();
    fillCategories();
    setType(selectedType);
    renderEnforcement();
    updateButton();
    updatePreviews();

    console.log('[add v0.4.3] ready', {
      accounts: accounts.length,
      categories: categories.length,
      categoriesLoaded,
      selectedType,
      enforcementLoaded,
      saveGate,
      store: window.store && window.store.version,
      icons: window.SovereignIcons && window.SovereignIcons.version
    });
  }

  window.SovereignAdd = {
    version: VERSION,
    get selectedType() {
      return selectedType;
    },
    accounts: () => accounts.slice(),
    categories: () => categories.slice(),
    enforcement: () => ({
      loaded: enforcementLoaded,
      error: enforcementError,
      saveGate: { ...saveGate }
    })
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
