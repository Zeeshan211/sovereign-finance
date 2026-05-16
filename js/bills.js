/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.8.0-bills-root-engine-ui
 *
 * Frontend-only.
 * Reads /api/bills and /api/bills/health.
 * Uses existing shared shell/components/classes.
 * Does not mutate backend except explicit form actions.
 * Does not touch other pages.
 */

(function () {
  'use strict';

  const VERSION = 'v0.8.0-bills-root-engine-ui';

  const API = {
    bills: '/api/bills',
    health: '/api/bills/health',
    balances: '/api/balances'
  };

  const state = {
    payload: null,
    health: null,
    accounts: [],
    selectedBillId: null,
    loading: false
  };

  function text(value) {
    return String(value == null ? '' : value);
  }

  function clean(value) {
    return text(value).trim();
  }

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function fetchJSON(url, options) {
    const finalUrl = url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now();

    const res = await fetch(finalUrl, {
      cache: 'no-store',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(options && options.headers ? options.headers : {})
      },
      ...(options || {})
    });

    const raw = await res.text();

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Expected JSON from ${url}, received: ${raw.slice(0, 120)}`);
    }

    if (!res.ok || json.ok === false) {
      throw new Error(json.error?.message || json.error || json.message || `HTTP ${res.status}`);
    }

    return json;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;

    el.textContent = value;
    el.setAttribute('data-loaded', 'true');
    el.setAttribute('data-bills-rendered', VERSION);
    return true;
  }

  function setDataValue(key, value) {
    document.querySelectorAll(`[data-bills-value="${key}"]`).forEach(el => {
      el.textContent = value;
      el.setAttribute('data-loaded', 'true');
      el.setAttribute('data-bills-rendered', VERSION);
    });

    document.querySelectorAll(`[data-kpi-value="${key}"]`).forEach(el => {
      el.textContent = value;
      el.setAttribute('data-loaded', 'true');
      el.setAttribute('data-bills-rendered', VERSION);
    });
  }

  function setList(key, html) {
    const el = document.querySelector(`[data-bills-list="${key}"]`);
    if (!el) return;

    el.innerHTML = html;
    el.setAttribute('data-loaded', 'true');
    el.setAttribute('data-bills-rendered', VERSION);
  }

  function row(title, subtitle, value, attrs) {
    return `
      <div class="sf-finance-row"${attrs ? ' ' + attrs : ''}>
        <div class="sf-row-left">
          <div class="sf-row-title">${escapeHtml(title)}</div>
          <div class="sf-row-subtitle">${escapeHtml(subtitle || '')}</div>
        </div>
        <div class="sf-row-right">${escapeHtml(value || '')}</div>
      </div>
    `;
  }

  function empty(title, subtitle) {
    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${escapeHtml(title)}</h3>
          <p class="sf-card-subtitle">${escapeHtml(subtitle || '')}</p>
        </div>
      </div>
    `;
  }

  function button(label, id, extraClass) {
    return `<button id="${escapeHtml(id)}" class="sf-button ${escapeHtml(extraClass || '')}" type="button">${escapeHtml(label)}</button>`;
  }

  function selectedBill() {
    const bills = state.payload?.bills || [];
    return bills.find(bill => bill.id === state.selectedBillId) || bills[0] || null;
  }

  function healthStatus() {
    return state.health?.status || state.payload?.health?.status || 'unknown';
  }

  function arrayCount(value) {
    return Array.isArray(value) ? value.length : number(value, 0);
  }

  async function loadAccounts() {
    try {
      const data = await fetchJSON(API.balances);
      const list = Array.isArray(data.account_list)
        ? data.account_list
        : Object.values(data.accounts || {});

      state.accounts = list
        .filter(account => {
          const status = clean(account.status || 'active').toLowerCase();
          return status !== 'inactive' && status !== 'deleted' && status !== 'archived';
        })
        .map(account => ({
          id: clean(account.id),
          name: clean(account.name || account.id),
          type: clean(account.type || account.kind || 'account'),
          balance: number(account.balance ?? account.current_balance ?? account.amount, 0)
        }))
        .filter(account => account.id);
    } catch (err) {
      console.warn('[Bills UI] account load failed', err);
      state.accounts = [];
    }
  }

  function renderAccountSelects() {
    const selects = document.querySelectorAll('[data-bills-account-select]');
    const options = [
      '<option value="">Choose account</option>',
      ...state.accounts.map(account => {
        return `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${money(account.balance)}</option>`;
      })
    ].join('');

    selects.forEach(select => {
      const current = select.value;
      select.innerHTML = options;
      if (current) select.value = current;
    });
  }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true;

    try {
      setText('bills-state-pill', 'Loading');

      await loadAccounts();

      const [payload, health] = await Promise.all([
        fetchJSON(API.bills),
        fetchJSON(API.health)
      ]);

      state.payload = payload;
      state.health = health;

      if (!state.selectedBillId && Array.isArray(payload.bills) && payload.bills.length) {
        state.selectedBillId = payload.bills[0].id;
      }

      renderAll();
    } catch (err) {
      renderError(err);
    } finally {
      state.loading = false;
    }
  }

  function renderAll() {
    renderAccountSelects();
    renderSummary();
    renderBillsList();
    renderSelectedBill();
    renderHealth();
    renderDebug();
    bindDynamicActions();

    window.SovereignBills = {
      ui_version: VERSION,
      payload: state.payload,
      health: state.health,
      accounts: state.accounts,
      reload: loadAll
    };
  }

  function renderSummary() {
    const payload = state.payload || {};
    const health = state.health || {};
    const status = healthStatus();

    const expected = money(payload.expected_this_cycle);
    const paid = money(payload.paid_this_cycle);
    const remaining = money(payload.remaining);
    const statusCounts = `${number(payload.paid_count)} paid · ${number(payload.partial_count)} partial · ${number(payload.unpaid_count)} unpaid`;
    const excluded = String(number(payload.ledger_reversed_excluded_count));
    const healthLabel = status === 'pass' ? 'Pass' : status === 'warn' ? 'Warn' : status;

    setDataValue('expected_this_cycle', expected);
    setDataValue('paid_this_cycle', paid);
    setDataValue('remaining', remaining);
    setDataValue('status_counts', statusCounts);
    setDataValue('ledger_reversed_excluded_count', excluded);
    setDataValue('health_status', healthLabel);
    setDataValue('bill_count', `${number(payload.count || (payload.bills || []).length)} bills`);
    setDataValue('payment_state', selectedBill() ? 'Ready' : 'Select bill');
    setDataValue('add_state', 'Ready');

    setText('bills-expected-this-cycle', expected);
    setText('bills-paid-this-cycle', paid);
    setText('bills-remaining', remaining);
    setText('bills-status-counts', statusCounts);
    setText('bills-ledger-reversed-excluded', excluded);
    setText('bills-health-status', healthLabel);
    setText('bills-count-pill', `${number(payload.count || (payload.bills || []).length)} bills`);
    setText('bills-state-pill', `${payload.version || 'Bills'} · ${status}`);
    setText('bills-last-loaded', 'Last loaded: ' + new Date().toLocaleTimeString());

    setText('bills-kpi-expected', expected);
    setText('bills-kpi-paid', paid);
    setText('bills-kpi-remaining', remaining);
    setText('bills-kpi-health', healthLabel);

    console.log('[Bills rendered]', VERSION, {
      backend: payload.version,
      health: health.version,
      expected: payload.expected_this_cycle,
      paid: payload.paid_this_cycle,
      remaining: payload.remaining,
      status
    });
  }

  function renderBillsList() {
    const bills = state.payload?.bills || [];

    if (!bills.length) {
      setList('bills', empty('No active bills', 'Use Add New Bill to create a bill obligation.'));
      return;
    }

    setList('bills', bills.map(bill => billRow(bill)).join(''));
  }

  function billRow(bill) {
    const cycle = bill.current_cycle || {};
    const selected = bill.id === state.selectedBillId;
    const ignored = Array.isArray(cycle.ignored_payments) ? cycle.ignored_payments.length : number(cycle.ignored_payment_count);
    const effective = Array.isArray(cycle.payments) ? cycle.payments.length : number(cycle.effective_payment_count);

    return `
      <button class="sf-finance-row ${selected ? 'is-active' : ''}" type="button" data-bill-select="${escapeHtml(bill.id)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${escapeHtml(bill.name || bill.id)}</div>
          <div class="sf-row-subtitle">
            ${escapeHtml(cycle.status || 'unknown')} · due ${escapeHtml(cycle.due_date || 'unscheduled')} · ${effective} paid row(s) · ${ignored} ignored
          </div>
        </div>
        <div class="sf-row-right">${escapeHtml(money(cycle.remaining_amount))}</div>
      </button>
    `;
  }

  function renderSelectedBill() {
    const bill = selectedBill();

    if (!bill) {
      setList('selected', empty('No bill selected', 'Select a bill from the current cycle list.'));
      resetPaymentForm(null);
      return;
    }

    const cycle = bill.current_cycle || {};
    const activePayments = Array.isArray(cycle.payments) ? cycle.payments : [];
    const ignoredPayments = Array.isArray(cycle.ignored_payments) ? cycle.ignored_payments : [];

    const paymentRows = activePayments.length
      ? activePayments.map(payment => row(
          `Payment ${payment.id || ''}`,
          `${payment.paid_date || '-'} · ${payment.account_id || '-'} · ${payment.transaction_id || 'no tx'}`,
          money(payment.amount)
        )).join('')
      : row('Valid payments', 'No active valid payments for this cycle', '0');

    const ignoredRows = ignoredPayments.length
      ? ignoredPayments.map(payment => row(
          `Ignored ${payment.id || ''}`,
          `${payment.ignore_reason || 'ignored'} · ${payment.transaction_id || 'no tx'}`,
          money(payment.amount)
        )).join('')
      : row('Ignored payments', 'No ignored or reversed payments in this cycle', '0');

    setList('selected', [
      row(bill.name || bill.id, `Status ${cycle.status || '-'} · due ${cycle.due_date || '-'}`, money(cycle.amount)),
      row('Paid amount', 'Backend current_cycle paid amount', money(cycle.paid_amount)),
      row('Remaining amount', 'Backend current_cycle remaining amount', money(cycle.remaining_amount)),
      row('Default account', 'Used only if present; payment form still shows account', bill.default_account_id || 'Select when paying'),
      paymentRows,
      ignoredRows,
      `<div class="sf-form-actions">
        ${button('Use Remaining Amount', 'bill-use-remaining-btn')}
        ${button('Refresh Detail', 'bill-refresh-selected-btn')}
      </div>`
    ].join(''));

    resetPaymentForm(bill);
  }

  function resetPaymentForm(bill) {
    const name = document.getElementById('bill-payment-name');
    const amount = document.getElementById('bill-payment-amount');
    const date = document.getElementById('bill-payment-date');
    const account = document.getElementById('bill-payment-account');

    if (!bill) {
      if (name) name.value = '';
      if (amount) amount.value = '';
      if (date) date.value = todayISO();
      if (account) account.value = '';
      setText('bills-payment-state', 'Select bill');
      return;
    }

    const cycle = bill.current_cycle || {};

    if (name) name.value = bill.name || bill.id;
    if (amount) amount.value = number(cycle.remaining_amount || bill.amount, 0);
    if (date && !date.value) date.value = todayISO();
    if (account) account.value = bill.default_account_id || bill.last_paid_account_id || '';

    setText('bills-payment-state', 'Ready');
  }

  function renderHealth() {
    const health = state.health || {};
    const status = health.status || 'unknown';

    const rows = [
      row('Health status', `Version ${health.version || '-'}`, status),
      row('Payment rows', 'Total bill payment rows checked', String(number(health.payment_rows))),
      row('Orphans', 'Active payments without transaction', String(arrayCount(health.orphans))),
      row('Active reversed mismatch', 'Active payments linked to reversed ledger transactions', String(arrayCount(health.active_payment_reversed_txn_mismatch))),
      row('Missing reversal txn', 'Reversed payments whose reversal transaction is missing', String(arrayCount(health.missing_reversal_txn))),
      row('Duplicates', 'Same bill/month/amount/account duplicates', String(arrayCount(health.duplicate_bill_month_amount))),
      row('Amount mismatches', 'Payment amount does not match ledger amount', String(arrayCount(health.amount_mismatches)))
    ];

    const details = [];

    [
      ['Orphans', health.orphans],
      ['Active reversed mismatch', health.active_payment_reversed_txn_mismatch],
      ['Missing reversal transaction', health.missing_reversal_txn],
      ['Duplicates', health.duplicate_bill_month_amount],
      ['Amount mismatches', health.amount_mismatches]
    ].forEach(([title, items]) => {
      if (!Array.isArray(items) || !items.length) return;

      details.push(row(
        title,
        items.map(item => item.payment_id || item.bill_id || item.transaction_id || item.key || 'issue').join(', '),
        `${items.length} issue(s)`
      ));
    });

    setList('health', rows.concat(details).join(''));
    setText('bills-health-pill', status === 'pass' ? 'Pass' : status);
  }

  function renderDebug() {
    const debug = document.querySelector('[data-bills-debug]') || document.getElementById('bills-debug-output');

    if (!debug) return;

    const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
    const panel = document.getElementById('bills-debug-panel');

    if (panel && debugEnabled) panel.hidden = false;

    debug.textContent = JSON.stringify({
      ui_version: VERSION,
      bills: state.payload,
      health: state.health,
      accounts: state.accounts
    }, null, 2);
  }

  function renderError(err) {
    const message = err.message || String(err);

    setText('bills-state-pill', 'Bills failed');
    setText('bills-health-status', 'Error');
    setText('bills-health-pill', 'Error');
    setList('bills', empty('Bills failed to load', message));
    setList('health', empty('Bills health unavailable', message));

    console.error('[Bills UI error]', err);
  }

  function bindStaticActions() {
    const refresh = document.getElementById('bills-refresh-btn');
    if (refresh) refresh.addEventListener('click', loadAll);

    const repair = document.getElementById('bills-repair-btn');
    if (repair) repair.addEventListener('click', repairBills);

    const addNew = document.getElementById('bills-add-new-btn');
    if (addNew) {
      addNew.addEventListener('click', () => {
        const form = document.getElementById('bills-add-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });

        const name = document.getElementById('bill-add-name');
        if (name) name.focus();
      });
    }

    const addForm = document.getElementById('bills-add-form');
    if (addForm) addForm.addEventListener('submit', submitAddBill);

    const paymentForm = document.getElementById('bills-payment-form');
    if (paymentForm) paymentForm.addEventListener('submit', submitPayment);
  }

  function bindDynamicActions() {
    document.querySelectorAll('[data-bill-select]').forEach(buttonEl => {
      buttonEl.addEventListener('click', () => {
        state.selectedBillId = buttonEl.getAttribute('data-bill-select');
        renderBillsList();
        renderSelectedBill();
      });
    });

    const useRemaining = document.getElementById('bill-use-remaining-btn');
    if (useRemaining) {
      useRemaining.addEventListener('click', () => {
        const bill = selectedBill();
        const amount = document.getElementById('bill-payment-amount');
        if (bill && amount) amount.value = number(bill.current_cycle?.remaining_amount || bill.amount, 0);
      });
    }

    const refreshSelected = document.getElementById('bill-refresh-selected-btn');
    if (refreshSelected) refreshSelected.addEventListener('click', loadAll);
  }

  async function submitAddBill(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);

    const body = {
      action: 'create',
      name: clean(data.get('name')),
      amount: number(data.get('amount')),
      due_day: data.get('due_day') ? number(data.get('due_day')) : null,
      frequency: clean(data.get('frequency') || 'monthly'),
      default_account_id: clean(data.get('default_account_id')),
      category_id: clean(data.get('category_id') || 'bills_utilities'),
      notes: clean(data.get('notes'))
    };

    if (!body.name) return alert('Bill name is required.');
    if (!body.amount || body.amount <= 0) return alert('Expected amount must be greater than 0.');

    setText('bills-add-state', 'Saving');

    try {
      const result = await fetchJSON(API.bills, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      form.reset();
      setText('bills-add-state', 'Saved');
      state.selectedBillId = result.bill?.id || state.selectedBillId;
      await loadAll();
    } catch (err) {
      setText('bills-add-state', 'Error');
      alert(err.message || String(err));
    }
  }

  async function submitPayment(event) {
    event.preventDefault();

    const bill = selectedBill();
    if (!bill) return alert('Select a bill first.');

    const form = event.currentTarget;
    const data = new FormData(form);

    const accountId = clean(data.get('account_id'));
    const amount = number(data.get('amount'));

    if (!accountId) return alert('Payment account is required.');
    if (!amount || amount <= 0) return alert('Payment amount must be greater than 0.');

    const body = {
      action: 'pay',
      bill_id: bill.id,
      amount,
      account_id: accountId,
      paid_date: clean(data.get('paid_date')) || todayISO(),
      notes: clean(data.get('notes'))
    };

    setText('bills-payment-state', 'Saving');

    try {
      await fetchJSON(API.bills, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      form.reset();
      setText('bills-payment-state', 'Saved');
      await loadAll();
    } catch (err) {
      setText('bills-payment-state', 'Error');
      alert(err.message || String(err));
    }
  }

  async function repairBills() {
    setText('bills-state-pill', 'Repairing');

    try {
      const result = await fetchJSON(API.bills, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'repair' })
      });

      console.log('[Bills repair]', result);
      await loadAll();
    } catch (err) {
      setText('bills-state-pill', 'Repair failed');
      alert(err.message || String(err));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindStaticActions();
    loadAll();
  });
})();
