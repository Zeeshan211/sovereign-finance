/* js/bills.js
* Sovereign Finance · Bills UI
 * v0.7.0-effective-state-ui
 * v0.8.0-bills-root-engine-ui
*
 * Rules:
 * - Backend /api/bills current_cycle is money truth.
 * - Frontend never recalculates paid/remaining totals.
 * - Displays raw payment status and effective payment status separately.
 * - Ledger-reversed payments show as excluded from paid totals.
 * Frontend-only.
 * Reads /api/bills and /api/bills/health.
 * Uses existing shared shell/components/classes.
 * Does not mutate backend except explicit form actions.
 * Does not touch other pages.
*/

(function () {
'use strict';

  const VERSION = 'v0.7.0-effective-state-ui';
  const VERSION = 'v0.8.0-bills-root-engine-ui';

  const API_BILLS = '/api/bills';
  const API_BILLS_HEALTH = '/api/bills/health';
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
    selectedHistory: null,
loading: false
};

  const $ = id => document.getElementById(id);

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  function text(value) {
    return String(value == null ? '' : value);
}

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
  function clean(value) {
    return text(value).trim();
}

function money(value) {
const n = Number(value || 0);
    return 'Rs ' + n.toLocaleString('en-PK', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
maximumFractionDigits: 2
});
}

  function currentMonth() {
    return new Date().toISOString().slice(0, 7);
  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function todayISO() {
return new Date().toISOString().slice(0, 10);
}

  function clean(value, fallback = '') {
    const raw = value == null ? fallback : value;
    return String(raw == null ? '' : raw).trim();
  }

  function pctPaid(cycle) {
    const amount = Number(cycle?.amount_paisa || 0);
    const paid = Number(cycle?.paid_paisa || 0);

    if (!amount || amount <= 0) return 0;

    return Math.max(0, Math.min(100, paid / amount * 100));
  }

  function toneForStatus(status) {
    const s = String(status || '').toLowerCase();

    if (s === 'paid') return 'good';
    if (s === 'partial') return 'warn';
    if (s === 'unpaid') return 'danger';
    if (s === 'ledger_reversed') return 'danger';
    if (s === 'reversed') return 'danger';
    if (s === 'ledger_missing') return 'warn';

    return '';
  }

  function tag(text, tone) {
    return `<span class="bill-tag ${tone || ''}">${esc(text)}</span>`;
  }

  function row(title, sub, value, tone) {
    return `
      <div class="bill-row">
        <div>
          <div class="bill-row-title">${esc(title)}</div>
          ${sub ? `<div class="bill-row-sub">${esc(sub)}</div>` : ''}
        </div>
        <div class="bill-row-value ${tone ? `sf-tone-${esc(tone)}` : ''}">
          ${value == null ? '—' : value}
        </div>
      </div>
    `;
  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
}

async function fetchJSON(url, options) {
    const response = await fetch(url, {
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

    const text = await response.text();

    let payload = null;
    const raw = await res.text();

    let json;
try {
      payload = text ? JSON.parse(text) : null;
      json = JSON.parse(raw);
} catch {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
      throw new Error(`Expected JSON from ${url}, received: ${raw.slice(0, 120)}`);
}

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    if (!res.ok || json.ok === false) {
      throw new Error(json.error?.message || json.error || json.message || `HTTP ${res.status}`);
}

    return payload;
    return json;
}

  async function postJSON(url, body) {
    return fetchJSON(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
  }
  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;

  function bills() {
    return Array.isArray(state.payload?.bills) ? state.payload.bills : [];
    el.textContent = value;
    el.setAttribute('data-loaded', 'true');
    el.setAttribute('data-bills-rendered', VERSION);
    return true;
}

  function selectedBill() {
    return bills().find(bill => String(bill.id) === String(state.selectedBillId)) || null;
  }
  function setDataValue(key, value) {
    document.querySelectorAll(`[data-bills-value="${key}"]`).forEach(el => {
      el.textContent = value;
      el.setAttribute('data-loaded', 'true');
      el.setAttribute('data-bills-rendered', VERSION);
    });

  function excludedCount() {
    let count = 0;
    document.querySelectorAll(`[data-kpi-value="${key}"]`).forEach(el => {
      el.textContent = value;
      el.setAttribute('data-loaded', 'true');
      el.setAttribute('data-bills-rendered', VERSION);
    });
  }

    for (const bill of bills()) {
      const ignored = bill.current_cycle?.ignored_payments || [];
      count += ignored.filter(payment => payment.effective_status === 'ledger_reversed' || payment.ledger_reversed).length;
    }
  function setList(key, html) {
    const el = document.querySelector(`[data-bills-list="${key}"]`);
    if (!el) return;

    return count;
    el.innerHTML = html;
    el.setAttribute('data-loaded', 'true');
    el.setAttribute('data-bills-rendered', VERSION);
}

  function renderHero() {
    const payload = state.payload || {};
    const health = payload.health || state.health || {};

    setText('billsHeroAmount', money(payload.remaining || 0));
    setText(
      'billsHeroCopy',
      `Remaining this cycle for ${payload.month || currentMonth()}. Backend paid total excludes ledger-reversed bill payments.`
    );
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

    setText('billsVersionPill', payload.version || VERSION);
    setText('billsMonthPill', payload.month || currentMonth());
    setText('billsHealthPill', `health ${health.status || 'unknown'}`);
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

    setText('billsFooterVersion', `${VERSION} · backend ${payload.version || 'unknown'}`);
  function button(label, id, extraClass) {
    return `<button id="${escapeHtml(id)}" class="sf-button ${escapeHtml(extraClass || '')}" type="button">${escapeHtml(label)}</button>`;
}

  function renderMetrics() {
    const payload = state.payload || {};
    const cycle = payload.current_cycle || {};
  function selectedBill() {
    const bills = state.payload?.bills || [];
    return bills.find(bill => bill.id === state.selectedBillId) || bills[0] || null;
  }

    setText('metricExpected', money(payload.expected_this_cycle ?? cycle.expected_amount ?? 0));
    setText('metricPaid', money(payload.paid_this_cycle ?? cycle.paid_amount ?? 0));
    setText('metricRemaining', money(payload.remaining ?? cycle.remaining_amount ?? 0));
    setText(
      'metricCounts',
      `${payload.paid_count ?? cycle.paid_count ?? 0} / ${payload.partial_count ?? cycle.partial_count ?? 0} / ${payload.unpaid_count ?? cycle.unpaid_count ?? 0}`
    );
    setText('metricExcluded', String(excludedCount()));
  function healthStatus() {
    return state.health?.status || state.payload?.health?.status || 'unknown';
}

  function billName(bill) {
    return bill.name || bill.label || bill.id || 'Bill';
  function arrayCount(value) {
    return Array.isArray(value) ? value.length : number(value, 0);
}

  function billAccount(bill) {
    return bill.account_label || bill.account_name || bill.account_id || bill.default_account_id || '—';
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

  function billCategory(bill) {
    return bill.category_label || bill.category_name || bill.category_id || '—';
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

  function billTags(bill) {
    const cycle = bill.current_cycle || {};
    const tags = [];
  async function loadAll() {
    if (state.loading) return;
    state.loading = true;

    try {
      setText('bills-state-pill', 'Loading');

    tags.push(tag(cycle.status || bill.payment_status || 'unknown', toneForStatus(cycle.status || bill.payment_status)));
    tags.push(tag(`month ${cycle.month || bill.month || state.payload?.month || currentMonth()}`));
    tags.push(tag(`${cycle.active_payment_count || 0} effective payment${Number(cycle.active_payment_count || 0) === 1 ? '' : 's'}`));
      await loadAccounts();

    if (Number(cycle.ignored_payment_count || 0) > 0) {
      tags.push(tag(`${cycle.ignored_payment_count} ignored`, 'warn'));
    }
      const [payload, health] = await Promise.all([
        fetchJSON(API.bills),
        fetchJSON(API.health)
      ]);

    const ignored = cycle.ignored_payments || [];
    if (ignored.some(payment => payment.effective_status === 'ledger_reversed' || payment.ledger_reversed)) {
      tags.push(tag('ledger reversed excluded', 'danger'));
    }
      state.payload = payload;
      state.health = health;

    const payments = cycle.payments || [];
    if (payments.some(payment => payment.ledger_transaction)) {
      tags.push(tag('ledger linked', 'good'));
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

    return tags.join('');
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

  function renderBills() {
    const list = $('billsList');
    if (!list) return;
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

    const rows = bills();
  function renderBillsList() {
    const bills = state.payload?.bills || [];

    if (!rows.length) {
      list.innerHTML = '<div class="bill-empty">No active bills returned by backend.</div>';
    if (!bills.length) {
      setList('bills', empty('No active bills', 'Use Add New Bill to create a bill obligation.'));
return;
}

    list.innerHTML = rows.map(bill => renderBillCard(bill)).join('');
    bindBillCardActions();
    setList('bills', bills.map(bill => billRow(bill)).join(''));
}

  function renderBillCard(bill) {
  function billRow(bill) {
const cycle = bill.current_cycle || {};
    const selected = String(bill.id) === String(state.selectedBillId);
    const paid = cycle.paid_amount ?? bill.paid_amount ?? 0;
    const remaining = cycle.remaining_amount ?? bill.remaining_amount ?? 0;
    const amount = cycle.amount ?? bill.amount ?? 0;
    const paidPercent = pctPaid(cycle);
    const selected = bill.id === state.selectedBillId;
    const ignored = Array.isArray(cycle.ignored_payments) ? cycle.ignored_payments.length : number(cycle.ignored_payment_count);
    const effective = Array.isArray(cycle.payments) ? cycle.payments.length : number(cycle.effective_payment_count);

return `
      <article class="bill-card ${selected ? 'is-selected' : ''}" data-bill-id="${esc(bill.id)}">
        <div class="bill-card-head">
          <div class="bill-icon">🧾</div>

          <div>
            <div class="bill-title">${esc(billName(bill))}</div>
            <div class="bill-sub">Due day ${esc(bill.due_day || '—')} · ${esc(billAccount(bill))} · ${esc(billCategory(bill))}</div>
          </div>

          <div class="bill-amount">${money(amount)}</div>
        </div>

        <div class="bill-bars">
          <div class="bill-progress" style="--paid-pct:${paidPercent}%;">
            <div class="bill-progress-fill"></div>
          </div>

          <div class="bill-progress-copy">
            <span>Paid ${money(paid)}</span>
            <span>Remaining ${money(remaining)}</span>
      <button class="sf-finance-row ${selected ? 'is-active' : ''}" type="button" data-bill-select="${escapeHtml(bill.id)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${escapeHtml(bill.name || bill.id)}</div>
          <div class="sf-row-subtitle">
            ${escapeHtml(cycle.status || 'unknown')} · due ${escapeHtml(cycle.due_date || 'unscheduled')} · ${effective} paid row(s) · ${ignored} ignored
         </div>
       </div>

        <div class="bill-tags">${billTags(bill)}</div>

        <div class="bill-actions">
          <button class="bill-action" type="button" data-select-bill="${esc(bill.id)}">History</button>
          <button class="bill-action primary" type="button" data-pay-bill="${esc(bill.id)}">Pay</button>
          <button class="bill-action" type="button" data-edit-bill="${esc(bill.id)}">Edit</button>
          <button class="bill-action" type="button" data-defer-bill="${esc(bill.id)}">Defer</button>
        </div>
      </article>
        <div class="sf-row-right">${escapeHtml(money(cycle.remaining_amount))}</div>
      </button>
   `;
}

  function bindBillCardActions() {
    document.querySelectorAll('[data-select-bill]').forEach(button => {
      button.addEventListener('click', () => selectBill(button.getAttribute('data-select-bill')));
    });

    document.querySelectorAll('[data-pay-bill]').forEach(button => {
      button.addEventListener('click', () => openPayPanel(button.getAttribute('data-pay-bill')));
    });

    document.querySelectorAll('[data-edit-bill]').forEach(button => {
      button.addEventListener('click', () => openEditPanel(button.getAttribute('data-edit-bill')));
    });

    document.querySelectorAll('[data-defer-bill]').forEach(button => {
      button.addEventListener('click', () => openDeferPanel(button.getAttribute('data-defer-bill')));
    });
  }

  async function selectBill(id) {
    state.selectedBillId = id;
    renderBills();

  function renderSelectedBill() {
const bill = selectedBill();

if (!bill) {
      renderSelectedBill(null);
      setList('selected', empty('No bill selected', 'Select a bill from the current cycle list.'));
      resetPaymentForm(null);
return;
}

    try {
      state.selectedHistory = await fetchJSON(`/api/bills/history?bill_id=${encodeURIComponent(id)}`);
    } catch {
      state.selectedHistory = null;
    }

    renderSelectedBill(bill);
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

  function renderSelectedBill(bill) {
if (!bill) {
      setText('selectedBillTitle', 'No bill selected');
      setText('selectedBillSub', 'Select a bill to view linked payments and ledger transaction IDs.');
      setHTML('selectedBillPanel', '<div class="bill-empty">No bill selected.</div>');
      if (name) name.value = '';
      if (amount) amount.value = '';
      if (date) date.value = todayISO();
      if (account) account.value = '';
      setText('bills-payment-state', 'Select bill');
return;
}

const cycle = bill.current_cycle || {};
    const historyPayments = Array.isArray(state.selectedHistory?.payments)
      ? state.selectedHistory.payments
      : (cycle.payments || []);

    setText('selectedBillTitle', billName(bill));
    setText('selectedBillSub', `${cycle.month || state.payload?.month || currentMonth()} · backend effective status ${cycle.status || 'unknown'}`);

    const paymentCards = historyPayments.length
      ? historyPayments.map(renderPaymentCard).join('')
      : '<div class="bill-empty">No payment rows for this bill/month.</div>';

    setHTML('selectedBillPanel', `
      ${row('Cycle status', 'Backend current_cycle.status', cycle.status || 'unknown', toneForStatus(cycle.status))}
      ${row('Amount', 'Bill amount', money(cycle.amount ?? bill.amount ?? 0))}
      ${row('Effective paid', 'Excludes ledger-reversed payments', money(cycle.paid_amount ?? bill.paid_amount ?? 0), 'positive')}
      ${row('Remaining', 'Backend remaining amount', money(cycle.remaining_amount ?? bill.remaining_amount ?? 0), 'warning')}
      ${row('Raw / active / ignored', 'Payment row counts', `${cycle.raw_payment_count || 0} / ${cycle.active_payment_count || 0} / ${cycle.ignored_payment_count || 0}`)}
      <div class="bills-stack">${paymentCards}</div>
    `);
  }

  function renderPaymentCard(payment) {
    const effective = payment.effective_status || payment.status || 'unknown';
    const raw = payment.status || 'unknown';

    const tags = [
      tag(`raw ${raw}`),
      tag(`effective ${effective}`, toneForStatus(effective))
    ];

    if (payment.effective_paid === true) {
      tags.push(tag('counted in paid total', 'good'));
    } else {
      tags.push(tag('excluded from paid total', 'warn'));
    }

    if (payment.ledger_reversed || effective === 'ledger_reversed') {
      tags.push(tag('ledger reversed', 'danger'));
    }
    if (name) name.value = bill.name || bill.id;
    if (amount) amount.value = number(cycle.remaining_amount || bill.amount, 0);
    if (date && !date.value) date.value = todayISO();
    if (account) account.value = bill.default_account_id || bill.last_paid_account_id || '';

    if (payment.ledger_missing || effective === 'ledger_missing') {
      tags.push(tag('ledger missing', 'warn'));
    }

    if (payment.ledger_transaction?.id) {
      tags.push(tag(`txn ${payment.ledger_transaction.id}`));
    }
    setText('bills-payment-state', 'Ready');
  }

    return `
      <div class="bill-payment">
        <div class="bill-payment-head">
          <div>
            <div class="bill-payment-title">${esc(payment.id || 'payment')}</div>
            <div class="bill-payment-meta">${esc(payment.month || payment.cycle_month || '—')} · ${esc(payment.paid_at || payment.created_at || '—')}</div>
          </div>
          <div class="bill-row-value">${money(payment.amount)}</div>
        </div>
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

        <div class="bill-tags">${tags.join('')}</div>
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

        ${payment.effective_exclusion_reason ? `<div class="bill-row-sub">Reason: ${esc(payment.effective_exclusion_reason)}</div>` : ''}
      </div>
    `;
    setList('health', rows.concat(details).join(''));
    setText('bills-health-pill', status === 'pass' ? 'Pass' : status);
}

  function openPayPanel(id) {
    state.selectedBillId = id;
    const bill = selectedBill();
    if (!bill) return;
  function renderDebug() {
    const debug = document.querySelector('[data-bills-debug]') || document.getElementById('bills-debug-output');

    const cycle = bill.current_cycle || {};
    const remaining = cycle.remaining_amount ?? bill.remaining_amount ?? bill.amount ?? 0;
    if (!debug) return;

    setHTML('billActionPanel', `
      <form class="bill-form" id="payBillForm">
        <div class="bill-field">
          <label>Bill</label>
          <input class="bill-input" value="${esc(billName(bill))}" disabled>
        </div>
    const debugEnabled = new URLSearchParams(location.search).get('debug') === '1';
    const panel = document.getElementById('bills-debug-panel');

        <div class="bill-field">
          <label for="payAmountInput">Amount</label>
          <input class="bill-input" id="payAmountInput" type="number" step="0.01" value="${esc(remaining)}">
        </div>
    if (panel && debugEnabled) panel.hidden = false;

        <div class="bill-field">
          <label for="payDateInput">Date</label>
          <input class="bill-input" id="payDateInput" type="date" value="${todayISO()}">
        </div>
    debug.textContent = JSON.stringify({
      ui_version: VERSION,
      bills: state.payload,
      health: state.health,
      accounts: state.accounts
    }, null, 2);
  }

        <div class="bill-field">
          <label for="payNotesInput">Notes</label>
          <textarea class="bill-textarea" id="payNotesInput">${esc(`${billName(bill)} · Bill payment`)}</textarea>
        </div>
  function renderError(err) {
    const message = err.message || String(err);

        <button class="bill-action primary" type="button" id="confirmPayBillBtn">Confirm Payment</button>
      </form>
    `);
    setText('bills-state-pill', 'Bills failed');
    setText('bills-health-status', 'Error');
    setText('bills-health-pill', 'Error');
    setList('bills', empty('Bills failed to load', message));
    setList('health', empty('Bills health unavailable', message));

    $('confirmPayBillBtn')?.addEventListener('click', () => submitPayBill(id));
    console.error('[Bills UI error]', err);
}

  async function submitPayBill(id) {
    const bill = selectedBill();
    if (!bill) return;
  function bindStaticActions() {
    const refresh = document.getElementById('bills-refresh-btn');
    if (refresh) refresh.addEventListener('click', loadAll);

    const amount = Number($('payAmountInput')?.value || 0);
    const repair = document.getElementById('bills-repair-btn');
    if (repair) repair.addEventListener('click', repairBills);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Amount must be greater than zero.');
      return;
    }
    const addNew = document.getElementById('bills-add-new-btn');
    if (addNew) {
      addNew.addEventListener('click', () => {
        const form = document.getElementById('bills-add-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      await postJSON('/api/bills/pay', {
        bill_id: id,
        amount,
        date: $('payDateInput')?.value || todayISO(),
        month: state.payload?.month || currentMonth(),
        account_id: bill.account_id || bill.default_account_id,
        category_id: bill.category_id || 'bills_utilities',
        notes: $('payNotesInput')?.value || `${billName(bill)} · Bill payment`,
        created_by: 'bills-ui'
        const name = document.getElementById('bill-add-name');
        if (name) name.focus();
});

      toast('Bill payment saved.');
      await loadBills();
      await selectBill(id);
      setHTML('billActionPanel', '<div class="bill-empty">Payment saved. Backend totals refreshed.</div>');
    } catch (err) {
      setHTML('billActionPanel', `<div class="bill-empty">Payment failed: ${esc(err.message)}</div>`);
}
  }

  function openEditPanel(id) {
    state.selectedBillId = id;
    const bill = selectedBill();
    if (!bill) return;

    setHTML('billActionPanel', `
      <form class="bill-form" id="editBillForm">
        <div class="bill-field">
          <label for="editBillNameInput">Name</label>
          <input class="bill-input" id="editBillNameInput" value="${esc(billName(bill))}">
        </div>
    const addForm = document.getElementById('bills-add-form');
    if (addForm) addForm.addEventListener('submit', submitAddBill);

        <div class="bill-field">
          <label for="editBillAmountInput">Amount</label>
          <input class="bill-input" id="editBillAmountInput" type="number" step="0.01" value="${esc(bill.amount || 0)}">
        </div>

        <div class="bill-field">
          <label for="editBillDueDayInput">Due Day</label>
          <input class="bill-input" id="editBillDueDayInput" type="number" min="1" max="31" value="${esc(bill.due_day || '')}">
        </div>

        <button class="bill-action primary" type="button" id="confirmEditBillBtn">Save Bill</button>
      </form>
    `);

    $('confirmEditBillBtn')?.addEventListener('click', () => submitEditBill(id));
    const paymentForm = document.getElementById('bills-payment-form');
    if (paymentForm) paymentForm.addEventListener('submit', submitPayment);
}

  async function submitEditBill(id) {
    try {
      await postJSON('/api/bills/update', {
        bill_id: id,
        name: $('editBillNameInput')?.value || '',
        amount: Number($('editBillAmountInput')?.value || 0),
        due_day: Number($('editBillDueDayInput')?.value || 0)
  function bindDynamicActions() {
    document.querySelectorAll('[data-bill-select]').forEach(buttonEl => {
      buttonEl.addEventListener('click', () => {
        state.selectedBillId = buttonEl.getAttribute('data-bill-select');
        renderBillsList();
        renderSelectedBill();
});
    });

      toast('Bill updated.');
      await loadBills();
      await selectBill(id);
      setHTML('billActionPanel', '<div class="bill-empty">Bill saved. Backend totals refreshed.</div>');
    } catch (err) {
      setHTML('billActionPanel', `<div class="bill-empty">Edit failed: ${esc(err.message)}</div>`);
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

  function openDeferPanel(id) {
    state.selectedBillId = id;
    const bill = selectedBill();
    if (!bill) return;
  async function submitAddBill(event) {
    event.preventDefault();

    setHTML('billActionPanel', `
      <form class="bill-form" id="deferBillForm">
        <div class="bill-field">
          <label>Bill</label>
          <input class="bill-input" value="${esc(billName(bill))}" disabled>
        </div>
    const form = event.currentTarget;
    const data = new FormData(form);

        <div class="bill-field">
          <label for="deferMonthInput">Deferred Month</label>
          <input class="bill-input" id="deferMonthInput" type="month" value="${esc(state.payload?.month || currentMonth())}">
        </div>
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

        <button class="bill-action primary" type="button" id="confirmDeferBillBtn">Defer Bill</button>
      </form>
    `);
    if (!body.name) return alert('Bill name is required.');
    if (!body.amount || body.amount <= 0) return alert('Expected amount must be greater than 0.');

    $('confirmDeferBillBtn')?.addEventListener('click', () => submitDeferBill(id));
  }
    setText('bills-add-state', 'Saving');

  async function submitDeferBill(id) {
try {
      await postJSON('/api/bills/defer', {
        bill_id: id,
        deferred_month: $('deferMonthInput')?.value || state.payload?.month || currentMonth()
      const result = await fetchJSON(API.bills, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
});

      toast('Bill deferred.');
      await loadBills();
      await selectBill(id);
      setHTML('billActionPanel', '<div class="bill-empty">Bill deferred. Backend refreshed.</div>');
      form.reset();
      setText('bills-add-state', 'Saved');
      state.selectedBillId = result.bill?.id || state.selectedBillId;
      await loadAll();
} catch (err) {
      setHTML('billActionPanel', `<div class="bill-empty">Defer failed: ${esc(err.message)}</div>`);
      setText('bills-add-state', 'Error');
      alert(err.message || String(err));
}
}

  function renderHealth() {
    const health = state.health || state.payload?.health || {};
  async function submitPayment(event) {
    event.preventDefault();

    setHTML('billsHealthPanel', `
      ${row('Status', 'Backend bills health', health.status || 'unknown', health.status === 'ok' ? 'positive' : 'warning')}
      ${row('Payment rows', 'bill_payments rows', String(health.payment_rows ?? '—'))}
      ${row('Orphans', 'payment rows without bill', String(health.orphans ?? 0), Number(health.orphans || 0) ? 'danger' : 'positive')}
      ${row('Active payment reversed txn mismatch', 'stored paid but ledger reversed', String(health.active_payment_reversed_txn_mismatch ?? 0), Number(health.active_payment_reversed_txn_mismatch || 0) ? 'danger' : 'positive')}
      ${row('Missing reversal txn', 'reversal_transaction_id missing from ledger', String(health.missing_reversal_txn ?? 0), Number(health.missing_reversal_txn || 0) ? 'danger' : 'positive')}
      ${row('Duplicate bill/month/amount', 'duplicate payment detector', String(health.duplicate_bill_month_amount ?? 0), Number(health.duplicate_bill_month_amount || 0) ? 'warning' : 'positive')}
      ${row('Amount mismatches', 'bill payment vs ledger amount', String(health.amount_mismatches ?? 0), Number(health.amount_mismatches || 0) ? 'danger' : 'positive')}
    `);
  }
    const bill = selectedBill();
    if (!bill) return alert('Select a bill first.');

  function renderDebug() {
    setText('billsDebug', JSON.stringify({
      version: VERSION,
      payload: state.payload,
      health: state.health,
      selectedBillId: state.selectedBillId,
      selectedHistory: state.selectedHistory
    }, null, 2));
  }
    const form = event.currentTarget;
    const data = new FormData(form);

  function renderAll() {
    renderHero();
    renderMetrics();
    renderBills();
    renderHealth();
    renderDebug();
    const accountId = clean(data.get('account_id'));
    const amount = number(data.get('amount'));

    const selected = selectedBill();
    if (selected) renderSelectedBill(selected);
  }
    if (!accountId) return alert('Payment account is required.');
    if (!amount || amount <= 0) return alert('Payment amount must be greater than 0.');

  async function loadBills() {
    state.loading = true;
    setText('billsHeroAmount', 'Loading…');
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
      const month = currentMonth();
      state.payload = await fetchJSON(`${API_BILLS}?month=${encodeURIComponent(month)}`);

      try {
        const healthPayload = await fetchJSON(API_BILLS_HEALTH);
        state.health = healthPayload.health || healthPayload;
      } catch {
        state.health = state.payload.health || null;
      }
      await fetchJSON(API.bills, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      renderAll();
      form.reset();
      setText('bills-payment-state', 'Saved');
      await loadAll();
} catch (err) {
      setText('billsHeroAmount', 'Bills failed');
      setText('billsHeroCopy', err.message);
      setHTML('billsList', `<div class="bill-empty">Bills failed: ${esc(err.message)}</div>`);
      setHTML('billsHealthPanel', `<div class="bill-empty">Health unavailable: ${esc(err.message)}</div>`);
    } finally {
      state.loading = false;
      setText('bills-payment-state', 'Error');
      alert(err.message || String(err));
}
}

async function repairBills() {
    setText('bills-state-pill', 'Repairing');

try {
      const result = await postJSON('/api/bills/repair', {});
      toast(`Repair complete: ${result.repaired || 0} rows.`);
      await loadBills();
      const result = await fetchJSON(API.bills, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'repair' })
      });

      console.log('[Bills repair]', result);
      await loadAll();
} catch (err) {
      toast(`Repair failed: ${err.message}`);
      setText('bills-state-pill', 'Repair failed');
      alert(err.message || String(err));
}
}

  function toast(message) {
    const el = $('billToast');
    if (!el) return;

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function bind() {
    $('refreshBillsBtn')?.addEventListener('click', loadBills);
    $('repairBillsBtn')?.addEventListener('click', repairBills);
  }

  function init() {
    bind();
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
  document.addEventListener('DOMContentLoaded', () => {
    bindStaticActions();
    loadAll();
  });
})();
