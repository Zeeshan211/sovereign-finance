/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.7.0-effective-state-ui
 *
 * Rules:
 * - Backend /api/bills current_cycle is money truth.
 * - Frontend never recalculates paid/remaining totals.
 * - Displays raw payment status and effective payment status separately.
 * - Ledger-reversed payments show as excluded from paid totals.
 */

(function () {
  'use strict';

  const VERSION = 'v0.7.0-effective-state-ui';

  const API_BILLS = '/api/bills';
  const API_BILLS_HEALTH = '/api/bills/health';

  const state = {
    payload: null,
    health: null,
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
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
  }

  function money(value) {
    const n = Number(value || 0);
    return 'Rs ' + n.toLocaleString('en-PK', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function currentMonth() {
    return new Date().toISOString().slice(0, 7);
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
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options && options.headers ? options.headers : {})
      },
      ...(options || {})
    });

    const text = await response.text();

    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
    }

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    }

    return payload;
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

  function bills() {
    return Array.isArray(state.payload?.bills) ? state.payload.bills : [];
  }

  function selectedBill() {
    return bills().find(bill => String(bill.id) === String(state.selectedBillId)) || null;
  }

  function excludedCount() {
    let count = 0;

    for (const bill of bills()) {
      const ignored = bill.current_cycle?.ignored_payments || [];
      count += ignored.filter(payment => payment.effective_status === 'ledger_reversed' || payment.ledger_reversed).length;
    }

    return count;
  }

  function renderHero() {
    const payload = state.payload || {};
    const health = payload.health || state.health || {};

    setText('billsHeroAmount', money(payload.remaining || 0));
    setText(
      'billsHeroCopy',
      `Remaining this cycle for ${payload.month || currentMonth()}. Backend paid total excludes ledger-reversed bill payments.`
    );

    setText('billsVersionPill', payload.version || VERSION);
    setText('billsMonthPill', payload.month || currentMonth());
    setText('billsHealthPill', `health ${health.status || 'unknown'}`);

    setText('billsFooterVersion', `${VERSION} · backend ${payload.version || 'unknown'}`);
  }

  function renderMetrics() {
    const payload = state.payload || {};
    const cycle = payload.current_cycle || {};

    setText('metricExpected', money(payload.expected_this_cycle ?? cycle.expected_amount ?? 0));
    setText('metricPaid', money(payload.paid_this_cycle ?? cycle.paid_amount ?? 0));
    setText('metricRemaining', money(payload.remaining ?? cycle.remaining_amount ?? 0));
    setText(
      'metricCounts',
      `${payload.paid_count ?? cycle.paid_count ?? 0} / ${payload.partial_count ?? cycle.partial_count ?? 0} / ${payload.unpaid_count ?? cycle.unpaid_count ?? 0}`
    );
    setText('metricExcluded', String(excludedCount()));
  }

  function billName(bill) {
    return bill.name || bill.label || bill.id || 'Bill';
  }

  function billAccount(bill) {
    return bill.account_label || bill.account_name || bill.account_id || bill.default_account_id || '—';
  }

  function billCategory(bill) {
    return bill.category_label || bill.category_name || bill.category_id || '—';
  }

  function billTags(bill) {
    const cycle = bill.current_cycle || {};
    const tags = [];

    tags.push(tag(cycle.status || bill.payment_status || 'unknown', toneForStatus(cycle.status || bill.payment_status)));
    tags.push(tag(`month ${cycle.month || bill.month || state.payload?.month || currentMonth()}`));
    tags.push(tag(`${cycle.active_payment_count || 0} effective payment${Number(cycle.active_payment_count || 0) === 1 ? '' : 's'}`));

    if (Number(cycle.ignored_payment_count || 0) > 0) {
      tags.push(tag(`${cycle.ignored_payment_count} ignored`, 'warn'));
    }

    const ignored = cycle.ignored_payments || [];
    if (ignored.some(payment => payment.effective_status === 'ledger_reversed' || payment.ledger_reversed)) {
      tags.push(tag('ledger reversed excluded', 'danger'));
    }

    const payments = cycle.payments || [];
    if (payments.some(payment => payment.ledger_transaction)) {
      tags.push(tag('ledger linked', 'good'));
    }

    return tags.join('');
  }

  function renderBills() {
    const list = $('billsList');
    if (!list) return;

    const rows = bills();

    if (!rows.length) {
      list.innerHTML = '<div class="bill-empty">No active bills returned by backend.</div>';
      return;
    }

    list.innerHTML = rows.map(bill => renderBillCard(bill)).join('');
    bindBillCardActions();
  }

  function renderBillCard(bill) {
    const cycle = bill.current_cycle || {};
    const selected = String(bill.id) === String(state.selectedBillId);
    const paid = cycle.paid_amount ?? bill.paid_amount ?? 0;
    const remaining = cycle.remaining_amount ?? bill.remaining_amount ?? 0;
    const amount = cycle.amount ?? bill.amount ?? 0;
    const paidPercent = pctPaid(cycle);

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

    const bill = selectedBill();

    if (!bill) {
      renderSelectedBill(null);
      return;
    }

    try {
      state.selectedHistory = await fetchJSON(`/api/bills/history?bill_id=${encodeURIComponent(id)}`);
    } catch {
      state.selectedHistory = null;
    }

    renderSelectedBill(bill);
  }

  function renderSelectedBill(bill) {
    if (!bill) {
      setText('selectedBillTitle', 'No bill selected');
      setText('selectedBillSub', 'Select a bill to view linked payments and ledger transaction IDs.');
      setHTML('selectedBillPanel', '<div class="bill-empty">No bill selected.</div>');
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

    if (payment.ledger_missing || effective === 'ledger_missing') {
      tags.push(tag('ledger missing', 'warn'));
    }

    if (payment.ledger_transaction?.id) {
      tags.push(tag(`txn ${payment.ledger_transaction.id}`));
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

        <div class="bill-tags">${tags.join('')}</div>

        ${payment.effective_exclusion_reason ? `<div class="bill-row-sub">Reason: ${esc(payment.effective_exclusion_reason)}</div>` : ''}
      </div>
    `;
  }

  function openPayPanel(id) {
    state.selectedBillId = id;
    const bill = selectedBill();
    if (!bill) return;

    const cycle = bill.current_cycle || {};
    const remaining = cycle.remaining_amount ?? bill.remaining_amount ?? bill.amount ?? 0;

    setHTML('billActionPanel', `
      <form class="bill-form" id="payBillForm">
        <div class="bill-field">
          <label>Bill</label>
          <input class="bill-input" value="${esc(billName(bill))}" disabled>
        </div>

        <div class="bill-field">
          <label for="payAmountInput">Amount</label>
          <input class="bill-input" id="payAmountInput" type="number" step="0.01" value="${esc(remaining)}">
        </div>

        <div class="bill-field">
          <label for="payDateInput">Date</label>
          <input class="bill-input" id="payDateInput" type="date" value="${todayISO()}">
        </div>

        <div class="bill-field">
          <label for="payNotesInput">Notes</label>
          <textarea class="bill-textarea" id="payNotesInput">${esc(`${billName(bill)} · Bill payment`)}</textarea>
        </div>

        <button class="bill-action primary" type="button" id="confirmPayBillBtn">Confirm Payment</button>
      </form>
    `);

    $('confirmPayBillBtn')?.addEventListener('click', () => submitPayBill(id));
  }

  async function submitPayBill(id) {
    const bill = selectedBill();
    if (!bill) return;

    const amount = Number($('payAmountInput')?.value || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Amount must be greater than zero.');
      return;
    }

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
  }

  async function submitEditBill(id) {
    try {
      await postJSON('/api/bills/update', {
        bill_id: id,
        name: $('editBillNameInput')?.value || '',
        amount: Number($('editBillAmountInput')?.value || 0),
        due_day: Number($('editBillDueDayInput')?.value || 0)
      });

      toast('Bill updated.');
      await loadBills();
      await selectBill(id);
      setHTML('billActionPanel', '<div class="bill-empty">Bill saved. Backend totals refreshed.</div>');
    } catch (err) {
      setHTML('billActionPanel', `<div class="bill-empty">Edit failed: ${esc(err.message)}</div>`);
    }
  }

  function openDeferPanel(id) {
    state.selectedBillId = id;
    const bill = selectedBill();
    if (!bill) return;

    setHTML('billActionPanel', `
      <form class="bill-form" id="deferBillForm">
        <div class="bill-field">
          <label>Bill</label>
          <input class="bill-input" value="${esc(billName(bill))}" disabled>
        </div>

        <div class="bill-field">
          <label for="deferMonthInput">Deferred Month</label>
          <input class="bill-input" id="deferMonthInput" type="month" value="${esc(state.payload?.month || currentMonth())}">
        </div>

        <button class="bill-action primary" type="button" id="confirmDeferBillBtn">Defer Bill</button>
      </form>
    `);

    $('confirmDeferBillBtn')?.addEventListener('click', () => submitDeferBill(id));
  }

  async function submitDeferBill(id) {
    try {
      await postJSON('/api/bills/defer', {
        bill_id: id,
        deferred_month: $('deferMonthInput')?.value || state.payload?.month || currentMonth()
      });

      toast('Bill deferred.');
      await loadBills();
      await selectBill(id);
      setHTML('billActionPanel', '<div class="bill-empty">Bill deferred. Backend refreshed.</div>');
    } catch (err) {
      setHTML('billActionPanel', `<div class="bill-empty">Defer failed: ${esc(err.message)}</div>`);
    }
  }

  function renderHealth() {
    const health = state.health || state.payload?.health || {};

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

  function renderDebug() {
    setText('billsDebug', JSON.stringify({
      version: VERSION,
      payload: state.payload,
      health: state.health,
      selectedBillId: state.selectedBillId,
      selectedHistory: state.selectedHistory
    }, null, 2));
  }

  function renderAll() {
    renderHero();
    renderMetrics();
    renderBills();
    renderHealth();
    renderDebug();

    const selected = selectedBill();
    if (selected) renderSelectedBill(selected);
  }

  async function loadBills() {
    state.loading = true;
    setText('billsHeroAmount', 'Loading…');

    try {
      const month = currentMonth();
      state.payload = await fetchJSON(`${API_BILLS}?month=${encodeURIComponent(month)}`);

      try {
        const healthPayload = await fetchJSON(API_BILLS_HEALTH);
        state.health = healthPayload.health || healthPayload;
      } catch {
        state.health = state.payload.health || null;
      }

      renderAll();
    } catch (err) {
      setText('billsHeroAmount', 'Bills failed');
      setText('billsHeroCopy', err.message);
      setHTML('billsList', `<div class="bill-empty">Bills failed: ${esc(err.message)}</div>`);
      setHTML('billsHealthPanel', `<div class="bill-empty">Health unavailable: ${esc(err.message)}</div>`);
    } finally {
      state.loading = false;
    }
  }

  async function repairBills() {
    try {
      const result = await postJSON('/api/bills/repair', {});
      toast(`Repair complete: ${result.repaired || 0} rows.`);
      await loadBills();
    } catch (err) {
      toast(`Repair failed: ${err.message}`);
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