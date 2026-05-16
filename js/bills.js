/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.8.0-shell-aligned-simple-backend
 *
 * Honesty check — this file targets the backend that ACTUALLY exists:
 *   /api/bills/[[path]].js v0.2.0  (Ship 5)
 *     GET    /api/bills              → { ok, version, bills: [...] }
 *     GET    /api/bills/:id          → { ok, version, bill }
 *     PUT    /api/bills/:id          → update bill config (amount, due_day, …)
 *     POST   /api/bills/:id/pay      → mark paid (paid_date, account_id)
 *     DELETE /api/bills/:id          → soft-delete (status='deleted')
 *   /api/bills/health.js v1.0.1
 *     GET    /api/bills/health       → integrity report over bill_payments table
 *
 * Backend does NOT compute current-cycle math (expected / paid / remaining).
 * Backend does NOT expose create / defer / repair / history routes.
 * This UI reflects backend truth and clearly states what is unsupported.
 *
 * UI rules followed:
 *   - Shared shell vocabulary only (sf-finance-row, sf-pill, sf-button, …).
 *   - No foreign panels, no page-specific visual system.
 *   - Frontend does not recalculate money totals.
 *   - All static HTML IDs in bills.html are honored.
 */
(function () {
  'use strict';

  const VERSION = 'v0.8.0-shell-aligned-simple-backend';
  const API_BILLS = '/api/bills';
  const API_BILLS_HEALTH = '/api/bills/health';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
    bills: [],
    accounts: [],
    health: null,
    backendVersion: null,
    selectedBillId: null,
    loading: false,
    lastLoadedAt: null,
    actionsBound: false
  };

  const $ = (id) => document.getElementById(id);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function setText(id, value) { const el = $(id); if (el) el.textContent = value == null ? '' : String(value); }
  function setHTML(id, value) { const el = $(id); if (el) el.innerHTML  = value == null ? '' : String(value); }
  function clean(value, fallback = '') { return String((value == null ? fallback : value)).trim(); }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function currentMonth() { return new Date().toISOString().slice(0, 7); }
  function money(value) {
    const n = Number(value || 0);
    return 'Rs ' + n.toLocaleString('en-PK', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }
  function pill(text, tone) {
    const cls = tone ? ` sf-pill--${esc(tone)}` : '';
    return `<span class="sf-pill${cls}">${esc(text)}</span>`;
  }
  function paidThisMonth(bill) {
    if (!bill || !bill.last_paid_date) return false;
    return String(bill.last_paid_date).slice(0, 7) === currentMonth();
  }
  function activeBills() {
    return state.bills.filter((b) => b.status !== 'deleted');
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options?.headers || {}) },
      ...(options || {})
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; }
    catch { throw new Error(`Non-JSON from ${url}: HTTP ${response.status}`); }
    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    }
    return payload;
  }
  const postJSON   = (url, body) => fetchJSON(url, { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const putJSON    = (url, body) => fetchJSON(url, { method: 'PUT',    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const deleteJSON = (url)       => fetchJSON(url, { method: 'DELETE' });

  function accountRowsFromPayload(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (payload.accounts && typeof payload.accounts === 'object') return Object.values(payload.accounts);
    if (Array.isArray(payload.account_list)) return payload.account_list;
    return [];
  }

  async function loadAccounts() {
    try {
      const payload = await fetchJSON(API_ACCOUNTS);
      state.accounts = accountRowsFromPayload(payload).filter(Boolean);
    } catch {
      state.accounts = [];
    }
    populateAccountSelects();
  }

  function populateAccountSelects() {
    const selects = qa('[data-bills-account-select]');
    if (!selects.length) return;
    const opts = ['<option value="">Choose account</option>'].concat(
      state.accounts.map((acc) => {
        const id = acc.id || acc.account_id || '';
        const name = acc.name || acc.label || id;
        return `<option value="${esc(id)}">${esc(name)}</option>`;
      })
    ).join('');
    selects.forEach((sel) => {
      const current = sel.value;
      sel.innerHTML = opts;
      if (current) sel.value = current;
    });
  }

  async function loadBills() {
    if (state.loading) return;
    state.loading = true;
    setText('bills-state-pill', 'Loading');
    try {
      await loadAccounts();
      const payload = await fetchJSON(API_BILLS);
      state.bills = Array.isArray(payload.bills) ? payload.bills : [];
      state.backendVersion = payload.version || null;
      try {
        const healthPayload = await fetchJSON(API_BILLS_HEALTH);
        state.health = healthPayload.health || null;
      } catch (err) {
        state.health = { status: 'unavailable', error: err.message };
      }
      state.lastLoadedAt = new Date();
      renderAll();
      setText('bills-state-pill', 'Loaded');
    } catch (err) {
      setText('bills-state-pill', 'Failed');
      setHTML('bills-list', `<div class="sf-empty-state sf-tone-danger"><div><h3 class="sf-card-title">Bills failed to load</h3><p class="sf-card-subtitle">${esc(err.message)}</p></div></div>`);
      setHTML('bills-health-panel', `<div class="sf-empty-state sf-tone-danger"><div><h3 class="sf-card-title">Health unavailable</h3><p class="sf-card-subtitle">${esc(err.message)}</p></div></div>`);
      state.lastLoadedAt = new Date();
      renderHeaderPills();
      renderDebug();
    } finally {
      state.loading = false;
    }
  }

  function renderHeaderPills() {
    const last = state.lastLoadedAt
      ? `Last loaded: ${state.lastLoadedAt.toLocaleTimeString()}`
      : 'Last loaded: never';
    setText('bills-last-loaded', last);
    setText('bills-count-pill', `${activeBills().length} active bills`);
    const healthStatus = state.health?.status || 'unknown';
    setText('bills-health-pill', `health ${healthStatus}`);
  }

  /**
   * Static summary panel — only fields backend actually supports.
   * Backend has NO cycle math, so Expected/Paid/Remaining are honestly "—".
   * Paid/Partial/Unpaid is shown as "{paid_this_month} / 0 / {unpaid}" because
   * backend has no concept of partial payment.
   */
  function renderSummary() {
    const noMath = '<span title="Backend v0.2.0 does not compute cycle math">—</span>';
    setHTML('bills-expected-this-cycle', noMath);
    setHTML('bills-paid-this-cycle', noMath);
    setHTML('bills-remaining', noMath);

    const active = activeBills();
    const paid = active.filter(paidThisMonth).length;
    const unpaid = Math.max(0, active.length - paid);
    setText('bills-status-counts', `${paid} / 0 / ${unpaid}`);

    const reversedList = state.health?.payments_with_reversed_transaction_but_active_payment;
    const reversedCount = Array.isArray(reversedList) ? reversedList.length : (Number(reversedList) || 0);
    setText('bills-ledger-reversed-excluded', String(reversedCount));

    setText('bills-health-status', state.health?.status || 'unknown');
  }

  /**
   * Refresh the shared shell KPI tiles with backend truth.
   * SF_PAGE.kpis declares static "Loading" placeholders; the shell does not
   * render `id` for `valueId`, so we use the canonical SFShell.setKpis API
   * to inject live values into the same tiles.
   */
  function renderShellKpis() {
    if (!window.SFShell || typeof window.SFShell.setKpis !== 'function') return;
    const active = activeBills();
    const paid = active.filter(paidThisMonth).length;
    const unpaid = Math.max(0, active.length - paid);
    const healthStatus = state.health?.status || 'unknown';
    const tone =
      healthStatus === 'pass' ? 'positive' :
      healthStatus === 'warn' ? 'warning' :
      healthStatus === 'unavailable' ? 'danger' : 'info';
    try {
      window.SFShell.setKpis([
        { title: 'Expected This Cycle', kicker: 'Bills',
          value: '—',
          subtitle: 'Backend v0.2.0 does not compute cycle math',
          foot: `backend ${state.backendVersion || 'unknown'}` },
        { title: 'Paid This Month', kicker: 'last_paid_date in current month',
          value: String(paid),
          subtitle: `${paid} of ${active.length} active bills`,
          foot: 'derived from bills.last_paid_date',
          tone: active.length && paid === active.length ? 'positive' : 'info' },
        { title: 'Unpaid (active)', kicker: 'Pressure',
          value: String(unpaid),
          subtitle: 'Active bills without last_paid_date this month',
          foot: 'derived from bills',
          tone: unpaid > 0 ? 'warning' : 'positive' },
        { title: 'Bills Health', kicker: 'Integrity',
          value: healthStatus,
          subtitle: 'From /api/bills/health',
          foot: state.health?.payment_count != null ? `${state.health.payment_count} payment rows scanned` : '',
          tone }
      ]);
    } catch (err) {
      console.warn('[bills.js] shell KPI refresh failed', err);
    }
  }

  function renderBillsList() {
    const list = $('bills-list');
    if (!list) return;
    const rows = state.bills;
    if (!rows.length) {
      list.innerHTML = `<div class="sf-empty-state"><div><h3 class="sf-card-title">No bills</h3><p class="sf-card-subtitle">Backend returned an empty bills array.</p></div></div>`;
      return;
    }
    list.innerHTML = rows.map(renderBillRow).join('');
    qa('[data-bill-row]', list).forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedBillId = row.getAttribute('data-bill-row');
        renderBillsList();
        renderSelected();
        prefillPaymentForm();
      });
    });
  }

  function renderBillRow(bill) {
    const selected = String(bill.id) === String(state.selectedBillId);
    const status = String(bill.status || 'active');
    const paidNow = paidThisMonth(bill);
    const tone = paidNow ? 'positive'
      : status === 'deleted' ? 'danger'
      : status === 'paused'  ? 'warning'
      : 'info';
    const subBits = [
      `Due day ${bill.due_day || '—'}`,
      bill.frequency || 'monthly',
      `acct ${bill.last_paid_account_id || bill.default_account_id || '—'}`,
      `cat ${bill.category_id || '—'}`
    ];
    if (bill.last_paid_date) subBits.push(`last paid ${bill.last_paid_date}`);
    return `
      <div class="sf-finance-row${selected ? ' is-selected' : ''}" data-bill-row="${esc(bill.id)}" role="button" tabindex="0">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(bill.name || bill.id)}</div>
          <div class="sf-row-subtitle">${esc(subBits.join(' · '))}</div>
        </div>
        <div class="sf-row-right">
          ${money(bill.amount)} &middot; ${pill(paidNow ? 'paid this month' : status, tone)}
        </div>
      </div>
    `;
  }

  function renderSelected() {
    const panel = $('bills-selected-panel');
    if (!panel) return;
    const bill = state.bills.find((b) => String(b.id) === String(state.selectedBillId));
    if (!bill) {
      panel.innerHTML = `<div class="sf-loading-state"><div><h3 class="sf-card-title">No bill selected</h3><p class="sf-card-subtitle">Select a bill from the list.</p></div></div>`;
      return;
    }
    const rows = [
      ['Bill ID',              bill.id],
      ['Name',                 bill.name || '—'],
      ['Amount',               money(bill.amount)],
      ['Due day',              bill.due_day != null ? String(bill.due_day) : '—'],
      ['Frequency',            bill.frequency || '—'],
      ['Category',             bill.category_id || '—'],
      ['Default account',      bill.default_account_id || '—'],
      ['Last paid date',       bill.last_paid_date || '—'],
      ['Last paid account',    bill.last_paid_account_id || '—'],
      ['Auto-post',            bill.auto_post == null ? '—' : String(bill.auto_post)],
      ['Status',               bill.status || 'active']
    ];
    const rowsHtml = rows.map(([label, value]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left"><div class="sf-row-title">${esc(label)}</div></div>
        <div class="sf-row-right">${esc(value)}</div>
      </div>
    `).join('');
    panel.innerHTML = `
      ${rowsHtml}
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">Actions</div>
          <div class="sf-row-subtitle">PUT /api/bills/:id · DELETE /api/bills/:id</div>
        </div>
        <div class="sf-row-right">
          <button class="sf-button" type="button" data-edit-bill="${esc(bill.id)}">Edit amount</button>
          <button class="sf-button" type="button" data-delete-bill="${esc(bill.id)}">Soft-delete</button>
        </div>
      </div>
    `;
    qa('[data-edit-bill]', panel).forEach((b) => b.addEventListener('click', () => editBillAmount(bill)));
    qa('[data-delete-bill]', panel).forEach((b) => b.addEventListener('click', () => softDeleteBill(bill)));
  }

  async function editBillAmount(bill) {
    const next = window.prompt(`Edit amount for "${bill.name}" (current: ${bill.amount}):`, String(bill.amount ?? ''));
    if (next == null) return;
    const numeric = Number(next);
    if (!Number.isFinite(numeric) || numeric < 0) {
      window.alert('Amount must be a non-negative number.');
      return;
    }
    try {
      await putJSON(`${API_BILLS}/${encodeURIComponent(bill.id)}`, { amount: numeric });
      state.selectedBillId = bill.id;
      await loadBills();
    } catch (err) {
      window.alert(`Edit failed: ${err.message}`);
    }
  }

  async function softDeleteBill(bill) {
    if (!window.confirm(`Soft-delete bill "${bill.name}"? Status will be set to 'deleted'.`)) return;
    try {
      await deleteJSON(`${API_BILLS}/${encodeURIComponent(bill.id)}`);
      state.selectedBillId = null;
      await loadBills();
    } catch (err) {
      window.alert(`Delete failed: ${err.message}`);
    }
  }

  function prefillPaymentForm() {
    const bill = state.bills.find((b) => String(b.id) === String(state.selectedBillId));
    const nameInput   = $('bill-payment-name');
    const amountInput = $('bill-payment-amount');
    const dateInput   = $('bill-payment-date');
    const accountSel  = $('bill-payment-account');
    const stateSpan   = $('bills-payment-state');
    if (!bill) {
      if (nameInput) nameInput.value = '';
      if (stateSpan) stateSpan.textContent = 'Select bill';
      return;
    }
    if (nameInput)   nameInput.value = `${bill.name} (${bill.id})`;
    if (amountInput && !amountInput.value) amountInput.value = bill.amount || '';
    if (dateInput   && !dateInput.value)   dateInput.value   = todayISO();
    if (accountSel  && !accountSel.value)  accountSel.value  = bill.default_account_id || '';
    if (stateSpan) stateSpan.textContent = 'Ready';
  }

  function renderHealthPanel() {
    const panel = $('bills-health-panel');
    if (!panel) return;
    const h = state.health || {};
    const len = (arr) => Array.isArray(arr) ? arr.length : 0;
    const rows = [
      ['Status',                                 String(h.status || 'unknown'),
        h.status === 'pass' ? 'positive' : h.status === 'warn' ? 'warning' : 'danger'],
      ['Payment rows scanned',                   String(h.payment_count ?? '—')],
      ['Orphan payments (no txn)',               String(len(h.orphan_payments_without_transaction)),
        len(h.orphan_payments_without_transaction) ? 'danger' : 'positive'],
      ['Active payments w/ reversed txn',        String(len(h.payments_with_reversed_transaction_but_active_payment)),
        len(h.payments_with_reversed_transaction_but_active_payment) ? 'danger' : 'positive'],
      ['Reversed payments missing reversal txn', String(len(h.reversed_payments_without_reversal_transaction)),
        len(h.reversed_payments_without_reversal_transaction) ? 'danger' : 'positive'],
      ['Duplicate bill/month/amount rows',       String(len(h.duplicate_payments_same_month)),
        len(h.duplicate_payments_same_month) ? 'warning' : 'positive'],
      ['Payment amount mismatches',              String(len(h.payment_amount_mismatches)),
        len(h.payment_amount_mismatches) ? 'danger' : 'positive']
    ];
    panel.innerHTML = rows.map(([label, value, tone]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left"><div class="sf-row-title">${esc(label)}</div></div>
        <div class="sf-row-right${tone ? ' sf-tone-' + esc(tone) : ''}">${esc(value)}</div>
      </div>
    `).join('');
  }

  function renderDebug() {
    setText('bills-debug-output', JSON.stringify({
      version: VERSION,
      backendVersion: state.backendVersion,
      bill_count: state.bills.length,
      active_bill_count: activeBills().length,
      selectedBillId: state.selectedBillId,
      health: state.health,
      lastLoadedAt: state.lastLoadedAt
    }, null, 2));
  }

  function renderAll() {
    renderHeaderPills();
    renderShellKpis();
    renderSummary();
    renderBillsList();
    renderSelected();
    renderHealthPanel();
    renderDebug();
    prefillPaymentForm();
  }

  // ---- Add New Bill form -------------------------------------------------
  // Backend v0.2.0 has NO create-bill endpoint. We wire the form so it
  // surfaces a clear "not supported" message instead of silently failing.
  // Replace with a real POST when a create endpoint exists.
  function wireAddForm() {
    const form = $('bills-add-form');
    if (!form) return;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const stateSpan = $('bills-add-state');
      if (stateSpan) stateSpan.textContent = 'Not supported';
      window.alert(
        'Add New Bill is not yet supported by the backend.\n\n' +
        'Backend /api/bills v0.2.0 only exposes GET, PUT, POST /:id/pay and DELETE.\n' +
        'A create-bill endpoint must be added before this form can save.'
      );
    });
  }

  // ---- Pay Selected Bill form -------------------------------------------
  function wirePaymentForm() {
    const form = $('bills-payment-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const bill = state.bills.find((b) => String(b.id) === String(state.selectedBillId));
      const stateSpan = $('bills-payment-state');
      if (!bill) {
        if (stateSpan) stateSpan.textContent = 'Select a bill';
        window.alert('Select a bill from the list before recording a payment.');
        return;
      }
      const amount    = Number($('bill-payment-amount')?.value || 0);
      const paid_date = clean($('bill-payment-date')?.value) || todayISO();
      const account   = clean($('bill-payment-account')?.value);
      const notes     = clean($('bill-payment-notes')?.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        if (stateSpan) stateSpan.textContent = 'Bad amount';
        window.alert('Payment amount must be greater than zero.');
        return;
      }
      if (!account) {
        if (stateSpan) stateSpan.textContent = 'Account required';
        window.alert('Pick the account the payment was made from.');
        return;
      }
      if (stateSpan) stateSpan.textContent = 'Saving';
      try {
        await postJSON(`${API_BILLS}/${encodeURIComponent(bill.id)}/pay`, {
          paid_date,
          account_id: account,
          notes
        });
        if (stateSpan) stateSpan.textContent = 'Saved';
        form.reset();
        state.selectedBillId = bill.id;
        await loadBills();
      } catch (err) {
        if (stateSpan) stateSpan.textContent = 'Failed';
        window.alert(`Pay Bill failed: ${err.message}`);
      }
    });
    $('bill-payment-clear')?.addEventListener('click', () => {
      const stateSpan = $('bills-payment-state');
      if (stateSpan) stateSpan.textContent = 'Cleared';
    });
  }

  // ---- Shell-rendered actions (Refresh / Repair) ------------------------
  // The shell rebuilds the hero region whenever setKpis() runs, so direct
  // listeners on those buttons would be lost. Use document-level delegation.
  function wireShellActionsOnce() {
    if (state.actionsBound) return;
    state.actionsBound = true;
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#bills-refresh-btn')) {
        event.preventDefault();
        loadBills();
        return;
      }
      if (target.closest('#bills-repair-btn')) {
        event.preventDefault();
        window.alert(
          'Bills Repair is not yet supported by the backend.\n\n' +
          'No /api/bills/repair endpoint exists in v0.2.0.\n' +
          'Health is read-only via /api/bills/health.'
        );
      }
    });
  }

  function init() {
    wireShellActionsOnce();
    wireAddForm();
    wirePaymentForm();
    loadBills();
    window.SovereignBills = {
      version: VERSION,
      reload: loadBills,
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
