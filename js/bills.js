/* js/bills.js
 * Sovereign Finance · Bills Console
 * v1.0.0-bills-banking-grade-ui
 *
 * UI rule:
 * - Frontend does not invent money truth.
 * - Backend owns bill cycle, payment state, ledger link, reversal state.
 * - Confirm Pay stays locked until /pay/dry-run returns payload_hash.
 * - No browser prompts.
 */

(function () {
  'use strict';

  const API_BILLS = '/api/bills';
  const API_HEALTH = '/api/bills/health';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
    bills: [],
    accounts: [],
    health: null,
    selectedBillId: null,
    selectedPaymentId: null,
    payProof: null,
    debug: new URLSearchParams(location.search).get('debug') === '1'
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

  function money(value) {
    const n = Number(value) || 0;
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  function todayISO() {
    const d = new Date();

    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('-');
  }

  function currentMonth() {
    return todayISO().slice(0, 7);
  }

  function billById(id) {
    return state.bills.find(bill => bill.id === id) || null;
  }

  function paymentById(id) {
    for (const bill of state.bills) {
      const payments = bill.current_cycle && bill.current_cycle.payments || [];
      const found = payments.find(payment => payment.id === id);

      if (found) {
        return {
          bill,
          payment: found
        };
      }
    }

    return null;
  }

  function accountLabel(id) {
    const account = state.accounts.find(a => a.id === id);

    if (!account) return id || 'Unknown';

    return [account.icon || '', account.name || account.id].join(' ').trim();
  }

  async function requestJSON(url, options) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      ...(options || {})
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || ('HTTP ' + response.status));
    }

    return payload;
  }

  function normalizeAccounts(payload) {
    const raw = payload.accounts || payload.data || payload.results || [];

    if (Array.isArray(raw)) {
      return raw;
    }

    return Object.entries(raw).map(([id, value]) => ({
      id,
      ...(value || {})
    }));
  }

  async function loadAccounts() {
    try {
      const payload = await requestJSON(API_ACCOUNTS);
      state.accounts = normalizeAccounts(payload);
    } catch (err) {
      state.accounts = [];
      console.warn('[bills] accounts failed:', err.message);
    }

    fillAccountSelects();
  }

  async function loadHealth() {
    try {
      const payload = await requestJSON(API_HEALTH);
      state.health = payload.health || null;
    } catch (err) {
      state.health = {
        status: 'error',
        error: err.message
      };
    }

    renderHealth();
  }

  async function loadBills() {
    const payload = await requestJSON(API_BILLS);
    state.bills = payload.bills || [];
  }

  async function loadAll() {
    try {
      await Promise.all([
        loadAccounts(),
        loadHealth()
      ]);

      await loadBills();
      renderAll();
    } catch (err) {
      renderLoadError(err);
    }
  }

  function renderLoadError(err) {
    const list = $('billsList');

    if (list) {
      list.innerHTML = `<div class="bills-empty">Bills failed: ${esc(err.message)}</div>`;
    }

    const title = $('billsHealthTitle');
    const sub = $('billsHealthSub');

    if (title) title.textContent = 'Bills failed';
    if (sub) sub.textContent = err.message;
  }

  function renderAll() {
    renderMetrics();
    renderBills();
    renderSelectedHistory();
    renderDebug();
  }

  function renderMetrics() {
    let expected = 0;
    let paid = 0;
    let remaining = 0;
    let paidCount = 0;
    let partialCount = 0;
    let unpaidCount = 0;

    for (const bill of state.bills) {
      const cycle = bill.current_cycle || {};

      expected += Number(cycle.expected_amount || bill.amount || 0);
      paid += Number(cycle.paid_total || 0);
      remaining += Number(cycle.remaining || 0);

      if (cycle.payment_status === 'paid') paidCount += 1;
      else if (cycle.payment_status === 'partial') partialCount += 1;
      else unpaidCount += 1;
    }

    setText('metricExpected', money(expected));
    setText('metricPaid', money(paid));
    setText('metricRemaining', money(remaining));
    setText('metricStatusCounts', `${paidCount} / ${partialCount} / ${unpaidCount}`);
  }

  function renderBills() {
    const list = $('billsList');

    if (!list) return;

    if (!state.bills.length) {
      list.innerHTML = '<div class="bills-empty">No bills found.</div>';
      return;
    }

    list.innerHTML = state.bills.map(renderBillCard).join('');

    list.querySelectorAll('[data-pay-bill]').forEach(button => {
      button.addEventListener('click', () => openPayPanel(button.dataset.payBill));
    });

    list.querySelectorAll('[data-edit-bill]').forEach(button => {
      button.addEventListener('click', () => openBillForm(button.dataset.editBill));
    });

    list.querySelectorAll('[data-defer-bill]').forEach(button => {
      button.addEventListener('click', () => openDeferPanel(button.dataset.deferBill));
    });

    list.querySelectorAll('[data-select-bill]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedBillId = button.dataset.selectBill;
        renderSelectedHistory();
      });
    });
  }

  function renderBillCard(bill) {
    const cycle = bill.current_cycle || {};
    const expected = Number(cycle.expected_amount || bill.amount || 0);
    const paid = Number(cycle.paid_total || 0);
    const remaining = Number(cycle.remaining || 0);
    const pct = expected > 0 ? Math.min(100, Math.max(0, (paid / expected) * 100)) : 0;
    const status = cycle.payment_status || 'unpaid';

    const className =
      status === 'paid'
        ? 'is-paid'
        : (status === 'partial' ? 'is-partial' : '');

    const paymentCount = Number(cycle.payment_count || 0);
    const reversedCount = Number(cycle.reversed_payment_count || 0);

    return `
      <article class="bill-card ${className}">
        <div class="bill-main-line">
          <div class="bill-icon">🧾</div>

          <div>
            <div class="bill-title">${esc(bill.name)}</div>
            <div class="bill-sub">
              Due day ${esc(bill.due_day == null ? 'variable' : bill.due_day)}
              · ${esc(accountLabel(bill.default_account_id))}
              · ${esc(bill.category_id || 'bills_utilities')}
            </div>
          </div>

          <div class="bill-amount">${money(expected)}</div>
        </div>

        <div class="bill-progress">
          <div class="bill-progress-meta">
            <span>Paid ${money(paid)}</span>
            <span>Remaining ${money(remaining)}</span>
          </div>
          <div class="bill-progress-track">
            <div class="bill-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>

        <div class="bill-tags">
          <span class="bill-tag ${status === 'paid' ? 'good' : status === 'partial' ? 'warn' : 'danger'}">
            ${esc(status)}
          </span>
          <span class="bill-tag">month ${esc(cycle.bill_month || currentMonth())}</span>
          <span class="bill-tag">${paymentCount} active payment${paymentCount === 1 ? '' : 's'}</span>
          ${reversedCount ? `<span class="bill-tag warn">${reversedCount} reversed</span>` : ''}
          ${(cycle.linked_transaction_ids || []).length ? '<span class="bill-tag good">ledger linked</span>' : '<span class="bill-tag warn">no ledger link</span>'}
        </div>

        <div class="bill-card-actions">
          <button class="bill-action" type="button" data-select-bill="${esc(bill.id)}">History</button>
          <button class="bill-action pay" type="button" data-pay-bill="${esc(bill.id)}" ${remaining <= 0 ? 'disabled' : ''}>
            Pay
          </button>
          <button class="bill-action" type="button" data-edit-bill="${esc(bill.id)}">Edit</button>
          <button class="bill-action" type="button" data-defer-bill="${esc(bill.id)}">Defer</button>
        </div>
      </article>
    `;
  }

  function renderSelectedHistory() {
    const box = $('paymentHistory');
    const subtitle = $('historySubtitle');

    if (!box) return;

    const bill = billById(state.selectedBillId);

    if (!bill) {
      box.innerHTML = '<div class="bills-empty">No bill selected.</div>';
      if (subtitle) subtitle.textContent = 'Select a bill to view linked payments and ledger transaction IDs.';
      return;
    }

    const payments = bill.current_cycle && bill.current_cycle.payments || [];

    if (subtitle) {
      subtitle.textContent = `${bill.name} · ${payments.length} payment row${payments.length === 1 ? '' : 's'}`;
    }

    if (!payments.length) {
      box.innerHTML = '<div class="bills-empty">No payments for this cycle.</div>';
      return;
    }

    box.innerHTML = payments.map(payment => {
      const active = String(payment.status || 'paid') === 'paid';

      return `
        <div class="history-line">
          <span>
            ${esc(payment.paid_date || '')}
            · ${money(payment.amount)}
            · ${esc(accountLabel(payment.account_id))}
            <br>
            <span style="font-size:11px;">
              payment ${esc(payment.id)}
              <br>
              ledger ${esc(payment.transaction_id || 'missing')}
              ${payment.reversal_transaction_id ? '<br>reversal ' + esc(payment.reversal_transaction_id) : ''}
            </span>
          </span>

          <strong>
            ${esc(payment.status || 'paid')}
            <br>
            ${
              active
                ? `<button class="bill-action reverse" type="button" data-reverse-payment="${esc(payment.id)}">Reverse</button>`
                : ''
            }
          </strong>
        </div>
      `;
    }).join('');

    box.querySelectorAll('[data-reverse-payment]').forEach(button => {
      button.addEventListener('click', () => openReversePaymentPanel(button.dataset.reversePayment));
    });
  }

  function renderHealth() {
    const title = $('billsHealthTitle');
    const sub = $('billsHealthSub');
    const panel = $('healthPanel');

    if (!state.health) {
      if (title) title.textContent = 'Bills health unavailable';
      if (sub) sub.textContent = 'Health endpoint did not return.';
      return;
    }

    const status = state.health.status || 'unknown';

    if (title) {
      title.textContent = `Bills health: ${status.toUpperCase()}`;
    }

    if (sub) {
      sub.textContent =
        `payments ${state.health.payment_count || 0} · ` +
        `orphans ${(state.health.orphan_payments_without_transaction || []).length} · ` +
        `mismatches ${(state.health.payment_amount_mismatches || []).length}`;
    }

    if (!panel) return;

    panel.innerHTML = [
      ['Status', status],
      ['Payment rows', state.health.payment_count || 0],
      ['Orphans', (state.health.orphan_payments_without_transaction || []).length],
      ['Active payment reversed txn mismatch', (state.health.payments_with_reversed_transaction_but_active_payment || []).length],
      ['Missing reversal txn', (state.health.reversed_payments_without_reversal_transaction || []).length],
      ['Duplicate bill/month/amount', (state.health.duplicate_payments_same_month || []).length],
      ['Amount mismatches', (state.health.payment_amount_mismatches || []).length]
    ].map(([label, value]) => `
      <div class="health-line">
        <span>${esc(label)}</span>
        <strong>${esc(value)}</strong>
      </div>
    `).join('');
  }

  function renderDebug() {
    const panel = $('debugPanel');
    const output = $('debugOutput');

    if (!panel || !output) return;

    if (!state.debug) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    output.textContent = JSON.stringify({
      bills: state.bills,
      health: state.health,
      accounts: state.accounts,
      selectedBillId: state.selectedBillId,
      selectedPaymentId: state.selectedPaymentId,
      payProof: state.payProof
    }, null, 2);
  }

  function fillAccountSelects() {
    const options = ['<option value="">Select account…</option>'].concat(
      state.accounts.map(account => {
        const label = [account.icon || '', account.name || account.id].join(' ').trim();
        return `<option value="${esc(account.id)}">${esc(label)}</option>`;
      })
    ).join('');

    ['billAccountInput', 'payAccountInput'].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = options;
    });
  }

  function openBillForm(billId) {
    const panel = $('billFormPanel');
    const bill = billById(billId);

    if (!panel) return;

    closePayPanel();
    closeReversePaymentPanel();
    closeDeferPanel();

    panel.hidden = false;

    setText('billFormTitle', bill ? 'Edit Bill' : 'Add Bill');
    setText('billFormKicker', bill ? 'Bill Config' : 'New Bill');

    $('billIdInput').value = bill ? bill.id : '';
    $('billNameInput').value = bill ? bill.name || '' : '';
    $('billAmountInput').value = bill ? Number(bill.amount || 0) : '';
    $('billDueDayInput').value = bill && bill.due_day != null ? bill.due_day : '';
    $('billAccountInput').value = bill ? bill.default_account_id || '' : '';
    $('billCategoryInput').value = bill ? bill.category_id || 'bills_utilities' : 'bills_utilities';
    $('billNotesInput').value = bill ? bill.notes || '' : '';

    panel.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function closeBillForm() {
    const panel = $('billFormPanel');
    const form = $('billForm');

    if (form) form.reset();
    if (panel) panel.hidden = true;
  }

  async function submitBillForm(event) {
    event.preventDefault();

    const id = $('billIdInput').value.trim();

    const payload = {
      name: $('billNameInput').value.trim(),
      amount: Number($('billAmountInput').value || 0),
      due_day: $('billDueDayInput').value === '' ? null : Number($('billDueDayInput').value),
      default_account_id: $('billAccountInput').value || null,
      category_id: $('billCategoryInput').value.trim() || 'bills_utilities',
      notes: $('billNotesInput').value.trim(),
      created_by: 'web-bills'
    };

    try {
      if (id) {
        await requestJSON(`${API_BILLS}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await requestJSON(API_BILLS, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      closeBillForm();
      await loadAll();
      notify(id ? 'Bill updated.' : 'Bill created.');
    } catch (err) {
      notify('Bill save failed: ' + err.message, 'error');
    }
  }

  function openPayPanel(billId) {
    const bill = billById(billId);
    const panel = $('payPanel');

    if (!bill || !panel) return;

    closeBillForm();
    closeReversePaymentPanel();
    closeDeferPanel();

    state.payProof = null;

    const cycle = bill.current_cycle || {};
    const remaining = Number(cycle.remaining || bill.amount || 0);

    panel.hidden = false;

    $('payBillIdInput').value = bill.id;
    $('payPayloadHashInput').value = '';
    $('payOverrideTokenInput').value = '';
    $('payAmountInput').value = remaining > 0 ? remaining : bill.amount || '';
    $('payAccountInput').value = bill.default_account_id || '';
    $('payDateInput').value = todayISO();
    $('payMonthInput').value = cycle.bill_month || currentMonth();
    $('payNotesInput').value = '';

    setText('payPanelTitle', `Pay ${bill.name}`);

    $('payBillSummary').innerHTML = `
      <div class="proof-title">${esc(bill.name)}</div>
      <div class="proof-sub">
        Expected ${money(cycle.expected_amount || bill.amount)}
        · Paid ${money(cycle.paid_total || 0)}
        · Remaining ${money(cycle.remaining || bill.amount)}
      </div>
    `;

    resetPayProof();

    panel.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function closePayPanel() {
    const panel = $('payPanel');
    const form = $('payForm');

    state.payProof = null;

    if (form) form.reset();
    if (panel) panel.hidden = true;

    resetPayProof();
  }

  function resetPayProof() {
    const box = $('payProofBox');
    const confirm = $('confirmPayBtn');

    if (box) {
      box.className = 'proof-box warn';
      box.innerHTML = `
        <div class="proof-title">Dry-run required</div>
        <div class="proof-sub">Confirm Pay is disabled until backend returns a payload hash.</div>
      `;
    }

    if (confirm) confirm.disabled = true;

    const hashInput = $('payPayloadHashInput');
    const overrideInput = $('payOverrideTokenInput');

    if (hashInput) hashInput.value = '';
    if (overrideInput) overrideInput.value = '';
  }

  async function runPayDryRun() {
    const billId = $('payBillIdInput').value;
    const bill = billById(billId);

    if (!bill) {
      showPayProofError('Bill not found.');
      return;
    }

    const payload = buildPayPayload();

    try {
      const result = await requestJSON(`${API_BILLS}/${encodeURIComponent(billId)}/pay/dry-run`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.payProof = result;

      $('payPayloadHashInput').value = result.payload_hash || '';
      $('payOverrideTokenInput').value = result.override_token || '';

      const projected = result.projected_bill_state || {};
      const proof = result.transaction_proof || {};
      const balance = proof.balance_projection || {};

      const confirm = $('confirmPayBtn');
      if (confirm) confirm.disabled = !result.payload_hash;

      const box = $('payProofBox');
      if (box) {
        box.className = result.requires_override ? 'proof-box warn' : 'proof-box good';
        box.innerHTML = `
          <div class="proof-title">Dry-run passed</div>
          <div class="proof-sub">
            Writes performed: ${esc(String(result.writes_performed))}
            <br>
            Payload hash: ${esc(String(result.payload_hash || '').slice(0, 16))}…
            <br>
            Remaining after payment: ${money(projected.remaining || 0)}
            <br>
            Projected account balance: ${money(balance.projected_balance || 0)}
            ${result.requires_override ? '<br>Override required: ' + esc(result.override_reason || '') : ''}
          </div>
        `;
      }
    } catch (err) {
      showPayProofError(err.message);
    }
  }

  function showPayProofError(message) {
    const box = $('payProofBox');
    const confirm = $('confirmPayBtn');

    if (confirm) confirm.disabled = true;

    if (box) {
      box.className = 'proof-box warn';
      box.innerHTML = `
        <div class="proof-title">Dry-run failed</div>
        <div class="proof-sub">${esc(message)}</div>
      `;
    }
  }

  function buildPayPayload() {
    return {
      amount: Number($('payAmountInput').value || 0),
      paid_date: $('payDateInput').value,
      account_id: $('payAccountInput').value,
      bill_month: $('payMonthInput').value,
      notes: $('payNotesInput').value.trim(),
      created_by: 'web-bills'
    };
  }

  async function submitPay(event) {
    event.preventDefault();

    const billId = $('payBillIdInput').value;
    const payloadHash = $('payPayloadHashInput').value;

    if (!payloadHash) {
      showPayProofError('Run dry-run before confirm.');
      return;
    }

    const payload = {
      ...buildPayPayload(),
      payload_hash: payloadHash,
      override_token: $('payOverrideTokenInput').value || undefined
    };

    const button = $('confirmPayBtn');

    if (button) {
      button.disabled = true;
      button.textContent = 'Saving…';
    }

    try {
      await requestJSON(`${API_BILLS}/${encodeURIComponent(billId)}/pay`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      closePayPanel();
      await loadAll();
      notify('Bill payment saved and ledger linked.');
    } catch (err) {
      showPayProofError(err.message);
      if (button) button.disabled = false;
    } finally {
      if (button) button.textContent = 'Confirm Pay';
    }
  }

  function openReversePaymentPanel(paymentId) {
    const found = paymentById(paymentId);
    const panel = $('reversePaymentPanel');

    if (!found || !panel) return;

    closeBillForm();
    closePayPanel();
    closeDeferPanel();

    state.selectedPaymentId = paymentId;
    panel.hidden = false;

    const { bill, payment } = found;

    $('reversePaymentIdInput').value = payment.id;
    $('reverseReasonInput').value = '';
    $('reversePaymentError').hidden = true;
    $('reversePaymentError').textContent = '';

    $('reversePaymentSummary').innerHTML = `
      <div class="proof-title">${esc(bill.name)} · ${money(payment.amount)}</div>
      <div class="proof-sub">
        Payment ${esc(payment.id)}
        <br>
        Ledger ${esc(payment.transaction_id)}
        <br>
        Account ${esc(accountLabel(payment.account_id))}
      </div>
    `;

    panel.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function closeReversePaymentPanel() {
    const panel = $('reversePaymentPanel');
    const form = $('reversePaymentForm');

    state.selectedPaymentId = null;

    if (form) form.reset();
    if (panel) panel.hidden = true;
  }

  async function submitReversePayment(event) {
    event.preventDefault();

    const id = $('reversePaymentIdInput').value;
    const reason = $('reverseReasonInput').value.trim();
    const error = $('reversePaymentError');

    if (!reason) {
      if (error) {
        error.hidden = false;
        error.textContent = 'Reason is required.';
      }
      return;
    }

    try {
      await requestJSON(`${API_BILLS}/payments/${encodeURIComponent(id)}/reverse`, {
        method: 'POST',
        body: JSON.stringify({
          reason,
          created_by: 'web-bills'
        })
      });

      closeReversePaymentPanel();
      await loadAll();
      notify('Bill payment reversed.');
    } catch (err) {
      if (error) {
        error.hidden = false;
        error.textContent = err.message;
      }
    }
  }

  function openDeferPanel(billId) {
    const bill = billById(billId);
    const panel = $('deferPanel');

    if (!bill || !panel) return;

    closeBillForm();
    closePayPanel();
    closeReversePaymentPanel();

    panel.hidden = false;

    $('deferBillIdInput').value = bill.id;
    $('deferDateInput').value = todayISO();
    $('deferReasonInput').value = '';

    $('deferSummary').innerHTML = `
      <div class="proof-title">${esc(bill.name)}</div>
      <div class="proof-sub">Defer changes due state only. No ledger row will be created.</div>
    `;

    panel.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function closeDeferPanel() {
    const panel = $('deferPanel');
    const form = $('deferForm');

    if (form) form.reset();
    if (panel) panel.hidden = true;
  }

  async function submitDefer(event) {
    event.preventDefault();

    const billId = $('deferBillIdInput').value;

    try {
      await requestJSON(`${API_BILLS}/${encodeURIComponent(billId)}/defer`, {
        method: 'POST',
        body: JSON.stringify({
          new_due_date: $('deferDateInput').value,
          reason: $('deferReasonInput').value.trim(),
          created_by: 'web-bills'
        })
      });

      closeDeferPanel();
      await loadAll();
      notify('Bill deferred.');
    } catch (err) {
      notify('Defer failed: ' + err.message, 'error');
    }
  }

  function notify(message, kind) {
    let el = $('billsToast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'billsToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.className = 'toast show ' + (kind === 'error' ? 'toast-error' : 'toast-success');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.className = 'toast';
    }, 3200);
  }

  function setText(id, value) {
    const el = $(id);

    if (el) el.textContent = value;
  }

  function bindEvents() {
    const addBtn = $('addBillBtn');
    const refreshBtn = $('refreshBillsBtn');
    const billForm = $('billForm');
    const cancelBillFormBtn = $('cancelBillFormBtn');
    const payForm = $('payForm');
    const cancelPayBtn = $('cancelPayBtn');
    const runPayDryRunBtn = $('runPayDryRunBtn');
    const reverseForm = $('reversePaymentForm');
    const cancelReverseBtn = $('cancelReversePaymentBtn');
    const deferForm = $('deferForm');
    const cancelDeferBtn = $('cancelDeferBtn');

    if (addBtn) addBtn.addEventListener('click', () => openBillForm(null));
    if (refreshBtn) refreshBtn.addEventListener('click', loadAll);
    if (billForm) billForm.addEventListener('submit', submitBillForm);
    if (cancelBillFormBtn) cancelBillFormBtn.addEventListener('click', closeBillForm);
    if (payForm) payForm.addEventListener('submit', submitPay);
    if (cancelPayBtn) cancelPayBtn.addEventListener('click', closePayPanel);
    if (runPayDryRunBtn) runPayDryRunBtn.addEventListener('click', runPayDryRun);
    if (reverseForm) reverseForm.addEventListener('submit', submitReversePayment);
    if (cancelReverseBtn) cancelReverseBtn.addEventListener('click', closeReversePaymentPanel);
    if (deferForm) deferForm.addEventListener('submit', submitDefer);
    if (cancelDeferBtn) cancelDeferBtn.addEventListener('click', closeDeferPanel);
  }

  function init() {
    bindEvents();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {
      once: true
    });
  } else {
    init();
  }
})();