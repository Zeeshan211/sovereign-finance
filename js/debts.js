/* js/debts.js
 * Sovereign Finance · Debts Console
 * v1.0.0-debts-banking-grade-ui
 *
 * UI rules:
 * - Backend owns debt/payment truth.
 * - Payment requires dry-run first.
 * - Confirm is locked until payload_hash exists.
 * - New payments create immutable debt_payments rows.
 * - Reversal uses debt-aware reverse route.
 * - No browser prompts/popups.
 */

(function () {
  'use strict';

  const API_DEBTS = '/api/debts';
  const API_HEALTH = '/api/debts/health';
  const API_PAYMENTS = '/api/debts/payments';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
    debts: [],
    payments: [],
    accounts: [],
    health: null,
    selectedDebtId: null,
    selectedPaymentId: null,
    payProof: null,
    filter: {
      search: '',
      view: 'active'
    },
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

  function normalizeAccounts(payload) {
    const raw = payload.accounts || payload.data || payload.results || [];

    if (Array.isArray(raw)) return raw;

    return Object.entries(raw).map(([id, value]) => ({
      id,
      ...(value || {})
    }));
  }

  function accountLabel(id) {
    const account = state.accounts.find(a => a.id === id);

    if (!account) return id || 'Unknown';

    return [account.icon || '', account.name || account.id].join(' ').trim();
  }

  function debtById(id) {
    return state.debts.find(debt => debt.id === id) || null;
  }

  function paymentsForDebt(debtId) {
    return state.payments.filter(payment => payment.debt_id === debtId);
  }

  function paymentById(paymentId) {
    const payment = state.payments.find(p => p.id === paymentId);

    if (!payment) return null;

    return {
      payment,
      debt: debtById(payment.debt_id)
    };
  }

  function debtDirectionLabel(debt) {
    return debt.kind === 'owe' || debt.direction === 'i_owe'
      ? 'I owe'
      : 'Owed to me';
  }

  function paymentVerb(debt) {
    return debt.kind === 'owe' || debt.direction === 'i_owe'
      ? 'Pay'
      : 'Receive';
  }

  function paymentNoun(debt) {
    return debt.kind === 'owe' || debt.direction === 'i_owe'
      ? 'payment'
      : 'receipt';
  }

  function isSettled(debt) {
    const status = String(debt.status || '').toLowerCase();

    return status === 'closed' ||
      status === 'settled' ||
      Number(debt.remaining_amount || debt.outstanding_amount || 0) <= 0;
  }

  function remainingAmount(debt) {
    return Number(debt.remaining_amount ?? debt.outstanding_amount ?? Math.max(0, Number(debt.original_amount || 0) - Number(debt.paid_amount || 0)));
  }

  function paidAmount(debt) {
    return Number(debt.paid_amount || 0);
  }

  function originalAmount(debt) {
    return Number(debt.original_amount || 0);
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

  async function loadAccounts() {
    try {
      const payload = await requestJSON(API_ACCOUNTS);
      state.accounts = normalizeAccounts(payload);
    } catch (err) {
      state.accounts = [];
      console.warn('[debts] accounts load failed:', err.message);
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

  async function loadDebts() {
    const payload = await requestJSON(API_DEBTS);
    state.debts = payload.debts || [];
  }

  async function loadPayments() {
    try {
      const payload = await requestJSON(`${API_PAYMENTS}?limit=500`);
      state.payments = payload.payments || [];
    } catch (err) {
      state.payments = [];
      console.warn('[debts] payments load failed:', err.message);
    }
  }

  async function loadAll() {
    try {
      await Promise.all([
        loadAccounts(),
        loadHealth()
      ]);

      await Promise.all([
        loadDebts(),
        loadPayments()
      ]);

      renderAll();
    } catch (err) {
      renderLoadError(err);
    }
  }

  function renderLoadError(err) {
    const list = $('debtsList');

    if (list) {
      list.innerHTML = `<div class="debts-empty">Debts failed: ${esc(err.message)}</div>`;
    }

    setText('debtsHealthTitle', 'Debts failed');
    setText('debtsHealthSub', err.message);
  }

  function renderAll() {
    renderMetrics();
    renderDebts();
    renderSelectedHistory();
    renderHealth();
    renderDebug();
  }

  function filteredDebts() {
    const q = state.filter.search.toLowerCase();
    const view = state.filter.view;

    return state.debts.filter(debt => {
      const haystack = [
        debt.id,
        debt.name,
        debt.kind,
        debt.direction,
        debt.status,
        debt.notes,
        debt.due_date,
        debt.next_due_date
      ].join(' ').toLowerCase();

      if (q && !haystack.includes(q)) return false;

      if (view === 'active') return !isSettled(debt);
      if (view === 'owe') return debt.kind === 'owe' || debt.direction === 'i_owe';
      if (view === 'owed') return debt.kind === 'owed' || debt.direction === 'owed_to_me';
      if (view === 'settled') return isSettled(debt);
      if (view === 'all') return true;

      return true;
    });
  }

  function renderMetrics() {
    let owe = 0;
    let owed = 0;
    let activeCount = 0;
    let settledCount = 0;

    for (const debt of state.debts) {
      const remaining = remainingAmount(debt);

      if (isSettled(debt)) {
        settledCount += 1;
      } else {
        activeCount += 1;
      }

      if (debt.kind === 'owe' || debt.direction === 'i_owe') {
        owe += remaining;
      } else {
        owed += remaining;
      }
    }

    const net = owed - owe;

    setText('metricOwe', money(owe));
    setText('metricOwed', money(owed));
    setText('metricNet', money(net));
    setText('metricCounts', `${activeCount} / ${settledCount}`);

    const netEl = $('metricNet');
    if (netEl) {
      netEl.className = 'sf-metric-value ' + (net >= 0 ? 'sf-tone-positive' : 'sf-tone-danger');
    }
  }

  function renderDebts() {
    const list = $('debtsList');

    if (!list) return;

    const debts = filteredDebts();

    if (!debts.length) {
      list.innerHTML = '<div class="debts-empty">No debts match current filters.</div>';
      return;
    }

    list.innerHTML = debts.map(renderDebtCard).join('');

    list.querySelectorAll('[data-select-debt]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedDebtId = button.dataset.selectDebt;
        renderSelectedHistory();
      });
    });

    list.querySelectorAll('[data-pay-debt]').forEach(button => {
      button.addEventListener('click', () => openPayPanel(button.dataset.payDebt));
    });

    list.querySelectorAll('[data-edit-debt]').forEach(button => {
      button.addEventListener('click', () => openDebtForm(button.dataset.editDebt));
    });

    list.querySelectorAll('[data-defer-debt]').forEach(button => {
      button.addEventListener('click', () => openDeferPanel(button.dataset.deferDebt));
    });
  }

  function renderDebtCard(debt) {
    const original = originalAmount(debt);
    const paid = paidAmount(debt);
    const remaining = remainingAmount(debt);
    const pct = original > 0 ? Math.min(100, Math.max(0, (paid / original) * 100)) : 0;
    const settled = isSettled(debt);
    const kind = debt.kind || 'owe';
    const payments = paymentsForDebt(debt.id);
    const activePayments = payments.filter(p => p.status === 'paid');
    const reversedPayments = payments.filter(p => p.status === 'reversed');

    const actionLabel = paymentVerb(debt);
    const directionLabel = debtDirectionLabel(debt);
    const due = debt.next_due_date || debt.due_date || (debt.due_day ? `day ${debt.due_day}` : 'no due date');

    return `
      <article class="debt-card is-${esc(kind)} ${settled ? 'is-closed is-settled' : ''}">
        <div class="debt-main-line">
          <div class="debt-icon">${kind === 'owe' ? '↗' : '↘'}</div>

          <div>
            <div class="debt-title">${esc(debt.name)}</div>
            <div class="debt-sub">
              ${esc(directionLabel)}
              · due ${esc(due)}
              · ${esc(debt.status || 'active')}
            </div>
          </div>

          <div class="debt-amount">${money(remaining)}</div>
        </div>

        <div class="debt-progress">
          <div class="debt-progress-meta">
            <span>Paid ${money(paid)}</span>
            <span>Original ${money(original)}</span>
          </div>
          <div class="debt-progress-track">
            <div class="debt-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>

        <div class="debt-tags">
          <span class="debt-tag ${kind === 'owe' ? 'danger' : 'good'}">${esc(directionLabel)}</span>
          <span class="debt-tag ${settled ? 'good' : 'warn'}">${settled ? 'settled/closed' : 'active'}</span>
          <span class="debt-tag">${activePayments.length} immutable payment${activePayments.length === 1 ? '' : 's'}</span>
          ${reversedPayments.length ? `<span class="debt-tag warn">${reversedPayments.length} reversed</span>` : ''}
          ${payments.length ? '<span class="debt-tag good">history linked</span>' : '<span class="debt-tag warn">legacy/no payment rows</span>'}
        </div>

        <div class="debt-card-actions">
          <button class="debt-action" type="button" data-select-debt="${esc(debt.id)}">History</button>
          <button class="debt-action pay" type="button" data-pay-debt="${esc(debt.id)}" ${settled ? 'disabled' : ''}>
            ${esc(actionLabel)}
          </button>
          <button class="debt-action" type="button" data-edit-debt="${esc(debt.id)}">Edit</button>
          <button class="debt-action" type="button" data-defer-debt="${esc(debt.id)}" ${settled ? 'disabled' : ''}>Defer</button>
        </div>
      </article>
    `;
  }

  function renderSelectedHistory() {
    const box = $('paymentHistory');
    const subtitle = $('historySubtitle');

    if (!box) return;

    const debt = debtById(state.selectedDebtId);

    if (!debt) {
      box.innerHTML = '<div class="debts-empty">No debt selected.</div>';
      if (subtitle) subtitle.textContent = 'Select a debt to view immutable payment rows and linked ledger transaction IDs.';
      return;
    }

    const payments = paymentsForDebt(debt.id);

    if (subtitle) {
      subtitle.textContent = `${debt.name} · ${payments.length} immutable payment row${payments.length === 1 ? '' : 's'}`;
    }

    if (!payments.length) {
      box.innerHTML = `
        <div class="debts-empty">
          No immutable payment rows yet.
          <br><br>
          This can be normal for legacy migrated paid amounts. New payments from this rebuild will appear here.
        </div>
      `;
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
              ${payment.transaction_reversed ? '<br>linked transaction reversed' : ''}
            </span>
          </span>

          <strong>
            ${esc(payment.status || 'paid')}
            <br>
            ${
              active && payment.reverse_eligible
                ? `<button class="debt-action reverse" type="button" data-reverse-payment="${esc(payment.id)}">Reverse</button>`
                : (active ? `<span class="debt-tag danger">${esc(payment.reverse_block_reason || 'blocked')}</span>` : '')
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
    const health = state.health;

    if (!health) {
      setText('debtsHealthTitle', 'Debts health unavailable');
      setText('debtsHealthSub', 'Health endpoint did not return.');
      return;
    }

    const status = health.status || 'unknown';

    setText('debtsHealthTitle', `Debts health: ${status.toUpperCase()}`);

    const sub =
      `debts ${health.debt_count || 0} · ` +
      `payments ${health.debt_payment_count || 0} · ` +
      `legacy opening ${health.legacy_opening_state_count || 0}`;

    setText('debtsHealthSub', sub);

    const panel = $('healthPanel');

    if (!panel) return;

    panel.innerHTML = [
      ['Status', status],
      ['Debt rows', health.debt_count || 0],
      ['Immutable payments', health.debt_payment_count || 0],
      ['Legacy opening states', health.legacy_opening_state_count || 0],
      ['Orphan payments', (health.orphan_payments_without_transaction || []).length],
      ['Active payment with reversed txn', (health.payments_with_reversed_transaction_but_active_payment || []).length],
      ['Missing reversal txn', (health.reversed_payments_without_reversal_transaction || []).length],
      ['Transaction amount mismatches', (health.transaction_amount_mismatches || []).length],
      ['Debt paid amount mismatches', (health.debt_paid_amount_mismatches || []).length],
      ['Duplicate payment suspicions', (health.duplicate_payment_suspicions || []).length]
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
      debts: state.debts,
      payments: state.payments,
      health: state.health,
      accounts: state.accounts,
      selectedDebtId: state.selectedDebtId,
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

    const payAccount = $('payAccountInput');

    if (payAccount) payAccount.innerHTML = options;
  }

  function openDebtForm(debtId) {
    const panel = $('debtFormPanel');
    const debt = debtById(debtId);

    if (!panel) return;

    closePayPanel();
    closeReversePaymentPanel();
    closeDeferPanel();

    panel.hidden = false;

    setText('debtFormTitle', debt ? 'Edit Debt' : 'Add Debt');
    setText('debtFormKicker', debt ? 'Debt Config' : 'New Debt');

    $('debtIdInput').value = debt ? debt.id : '';
    $('debtNameInput').value = debt ? debt.name || '' : '';
    $('debtKindInput').value = debt ? debt.kind || 'owe' : 'owe';
    $('debtOriginalInput').value = debt ? Number(debt.original_amount || 0) : '';
    $('debtDueDateInput').value = debt ? debt.due_date || debt.next_due_date || '' : '';
    $('debtInstallmentInput').value = debt ? debt.installment_amount || '' : '';
    $('debtNotesInput').value = debt ? debt.notes || '' : '';

    panel.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function closeDebtForm() {
    const panel = $('debtFormPanel');
    const form = $('debtForm');

    if (form) form.reset();
    if (panel) panel.hidden = true;
  }

  async function submitDebtForm(event) {
    event.preventDefault();

    const id = $('debtIdInput').value.trim();
    const payload = {
      name: $('debtNameInput').value.trim(),
      kind: $('debtKindInput').value,
      original_amount: Number($('debtOriginalInput').value || 0),
      due_date: $('debtDueDateInput').value || null,
      installment_amount: $('debtInstallmentInput').value === '' ? null : Number($('debtInstallmentInput').value),
      notes: $('debtNotesInput').value.trim(),
      created_by: 'web-debts'
    };

    try {
      if (id) {
        await requestJSON(`${API_DEBTS}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await requestJSON(API_DEBTS, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      closeDebtForm();
      await loadAll();
      notify(id ? 'Debt updated.' : 'Debt created.');
    } catch (err) {
      notify('Debt save failed: ' + err.message, 'error');
    }
  }

  function openPayPanel(debtId) {
    const debt = debtById(debtId);
    const panel = $('payPanel');

    if (!debt || !panel) return;

    closeDebtForm();
    closeReversePaymentPanel();
    closeDeferPanel();

    state.payProof = null;

    const remaining = remainingAmount(debt);

    panel.hidden = false;

    $('payDebtIdInput').value = debt.id;
    $('payPayloadHashInput').value = '';
    $('payOverrideTokenInput').value = '';
    $('payAmountInput').value = remaining > 0 ? remaining : '';
    $('payAccountInput').value = '';
    $('payDateInput').value = todayISO();
    $('payNotesInput').value = '';

    setText('payPanelTitle', `${paymentVerb(debt)} ${debt.name}`);

    $('payDebtSummary').innerHTML = `
      <div class="proof-title">${esc(debt.name)}</div>
      <div class="proof-sub">
        ${esc(debtDirectionLabel(debt))}
        · Original ${money(originalAmount(debt))}
        · Paid ${money(paidAmount(debt))}
        · Remaining ${money(remaining)}
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
        <div class="proof-sub">Confirm is disabled until backend returns a payload hash.</div>
      `;
    }

    if (confirm) confirm.disabled = true;

    const hashInput = $('payPayloadHashInput');
    const overrideInput = $('payOverrideTokenInput');

    if (hashInput) hashInput.value = '';
    if (overrideInput) overrideInput.value = '';
  }

  function buildPayPayload() {
    return {
      amount: Number($('payAmountInput').value || 0),
      account_id: $('payAccountInput').value,
      paid_date: $('payDateInput').value,
      notes: $('payNotesInput').value.trim(),
      created_by: 'web-debts'
    };
  }

  async function runPayDryRun() {
    const debtId = $('payDebtIdInput').value;
    const debt = debtById(debtId);

    if (!debt) {
      showPayProofError('Debt not found.');
      return;
    }

    const payload = buildPayPayload();

    try {
      const result = await requestJSON(`${API_DEBTS}/${encodeURIComponent(debtId)}/pay?dry_run=1`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      state.payProof = result;

      $('payPayloadHashInput').value = result.payload_hash || '';
      $('payOverrideTokenInput').value = result.override_token || '';

      const projected = result.projected_debt_state || {};
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
            ${esc(paymentVerb(debt))} amount: ${money(projected.amount || payload.amount)}
            <br>
            Remaining after: ${money(projected.remaining_after || 0)}
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
      box.className = 'proof-box danger';
      box.innerHTML = `
        <div class="proof-title">Dry-run failed</div>
        <div class="proof-sub">${esc(message)}</div>
      `;
    }
  }

  async function submitPay(event) {
    event.preventDefault();

    const debtId = $('payDebtIdInput').value;
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
      await requestJSON(`${API_DEBTS}/${encodeURIComponent(debtId)}/pay`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      closePayPanel();
      await loadAll();

      state.selectedDebtId = debtId;
      renderSelectedHistory();

      notify('Debt payment saved and ledger linked.');
    } catch (err) {
      showPayProofError(err.message);

      if (button) button.disabled = false;
    } finally {
      if (button) button.textContent = 'Confirm';
    }
  }

  function openReversePaymentPanel(paymentId) {
    const found = paymentById(paymentId);
    const panel = $('reversePaymentPanel');

    if (!found || !panel) return;

    closeDebtForm();
    closePayPanel();
    closeDeferPanel();

    state.selectedPaymentId = paymentId;
    panel.hidden = false;

    const { debt, payment } = found;

    $('reversePaymentIdInput').value = payment.id;
    $('reverseReasonInput').value = '';

    const error = $('reversePaymentError');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }

    $('reversePaymentSummary').innerHTML = `
      <div class="proof-title">${esc(debt ? debt.name : payment.debt_name)} · ${money(payment.amount)}</div>
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
      await requestJSON(`${API_DEBTS}/payments/${encodeURIComponent(id)}/reverse`, {
        method: 'POST',
        body: JSON.stringify({
          reason,
          created_by: 'web-debts'
        })
      });

      closeReversePaymentPanel();
      await loadAll();
      renderSelectedHistory();

      notify('Debt payment reversed.');
    } catch (err) {
      if (error) {
        error.hidden = false;
        error.textContent = err.message;
      }
    }
  }

  function openDeferPanel(debtId) {
    const debt = debtById(debtId);
    const panel = $('deferPanel');

    if (!debt || !panel) return;

    closeDebtForm();
    closePayPanel();
    closeReversePaymentPanel();

    panel.hidden = false;

    $('deferDebtIdInput').value = debt.id;
    $('deferDateInput').value = debt.next_due_date || debt.due_date || todayISO();
    $('deferReasonInput').value = '';

    $('deferSummary').innerHTML = `
      <div class="proof-title">${esc(debt.name)}</div>
      <div class="proof-sub">Defer changes due/follow-up date only. No ledger row will be created.</div>
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

    const debtId = $('deferDebtIdInput').value;
    const debt = debtById(debtId);

    if (!debt) return;

    try {
      await requestJSON(`${API_DEBTS}/${encodeURIComponent(debtId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          due_date: $('deferDateInput').value,
          notes: appendNote(debt.notes, 'Deferred: ' + $('deferReasonInput').value.trim()),
          created_by: 'web-debts'
        })
      });

      closeDeferPanel();
      await loadAll();

      notify('Debt deferred.');
    } catch (err) {
      notify('Defer failed: ' + err.message, 'error');
    }
  }

  function appendNote(existing, addition) {
    const left = String(existing || '').trim();
    const right = String(addition || '').trim();

    if (!left) return right;
    if (!right) return left;

    return `${left} | ${right}`.slice(0, 240);
  }

  function notify(message, kind) {
    let el = $('debtsToast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'debtsToast';
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
    const addBtn = $('addDebtBtn');
    const refreshBtn = $('refreshDebtsBtn');
    const searchInput = $('debtSearchInput');
    const viewFilter = $('debtViewFilter');

    const debtForm = $('debtForm');
    const cancelDebtFormBtn = $('cancelDebtFormBtn');

    const payForm = $('payForm');
    const cancelPayBtn = $('cancelPayBtn');
    const runPayDryRunBtn = $('runPayDryRunBtn');

    const reverseForm = $('reversePaymentForm');
    const cancelReverseBtn = $('cancelReversePaymentBtn');

    const deferForm = $('deferForm');
    const cancelDeferBtn = $('cancelDeferBtn');

    if (addBtn) addBtn.addEventListener('click', () => openDebtForm(null));
    if (refreshBtn) refreshBtn.addEventListener('click', loadAll);

    if (searchInput) {
      searchInput.addEventListener('input', event => {
        state.filter.search = event.target.value.trim();
        renderDebts();
      });
    }

    if (viewFilter) {
      viewFilter.addEventListener('change', event => {
        state.filter.view = event.target.value || 'active';
        renderDebts();
      });
    }

    if (debtForm) debtForm.addEventListener('submit', submitDebtForm);
    if (cancelDebtFormBtn) cancelDebtFormBtn.addEventListener('click', closeDebtForm);

    if (payForm) payForm.addEventListener('submit', submitPay);
    if (cancelPayBtn) cancelPayBtn.addEventListener('click', closePayPanel);
    if (runPayDryRunBtn) runPayDryRunBtn.addEventListener('click', runPayDryRun);

    if (reverseForm) reverseForm.addEventListener('submit', submitReversePayment);
    if (cancelReverseBtn) cancelReverseBtn.addEventListener('click', closeReversePaymentPanel);

    if (deferForm) deferForm.addEventListener('submit', submitDefer);
    if (cancelDeferBtn) cancelDeferBtn.addEventListener('click', closeDeferPanel);
  }

  function injectToastStyles() {
    if ($('debts-toast-style')) return;

    const style = document.createElement('style');
    style.id = 'debts-toast-style';
    style.textContent = `
      .toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 9999;
        transform: translateY(18px);
        opacity: 0;
        pointer-events: none;
        transition: .2s ease;
        border: 1px solid var(--sf-border);
        border-radius: 16px;
        padding: 12px 14px;
        background: var(--sf-card-strong);
        color: var(--sf-text);
        box-shadow: var(--sf-shadow-md);
        font-weight: 800;
      }

      .toast.show {
        transform: translateY(0);
        opacity: 1;
      }

      .toast-error {
        color: var(--sf-danger);
        border-color: rgba(255, 127, 138, .35);
      }

      .toast-success {
        color: var(--sf-positive);
        border-color: rgba(83, 215, 167, .35);
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    injectToastStyles();
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