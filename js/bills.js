/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.8.1-read-only-stabilizer
 *
 * Frontend-only.
 * Safe read-only renderer for /api/bills and /api/bills/health.
 * No writes. No add/pay/repair actions in this stabilizer pass.
 * Uses existing shared shell/classes only.
 */

(function () {
  'use strict';

  const VERSION = 'v0.8.1-read-only-stabilizer';

  const API = {
    bills: '/api/bills',
    health: '/api/bills/health'
  };

  const state = {
    payload: null,
    health: null,
    selectedBillId: null
  };

  function text(value) {
    return String(value == null ? '' : value);
  }

  function clean(value) {
    return text(value).trim();
  }

  function number(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async function fetchJSON(url) {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'ts=' + Date.now(), {
      cache: 'no-store',
      credentials: 'include',
      headers: { Accept: 'application/json' }
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
    if (!el) return false;

    el.innerHTML = html;
    el.setAttribute('data-loaded', 'true');
    el.setAttribute('data-bills-rendered', VERSION);
    return true;
  }

  function row(title, subtitle, value, extraAttrs) {
    return `
      <div class="sf-finance-row"${extraAttrs ? ' ' + extraAttrs : ''}>
        <div class="sf-row-left">
          <div class="sf-row-title">${escapeHtml(title)}</div>
          <div class="sf-row-subtitle">${escapeHtml(subtitle || '')}</div>
        </div>
        <div class="sf-row-right">${escapeHtml(value || '')}</div>
      </div>
    `;
  }

  function buttonRow(title, subtitle, value, billId, active) {
    return `
      <button class="sf-finance-row ${active ? 'is-active' : ''}" type="button" data-bill-select="${escapeHtml(billId)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${escapeHtml(title)}</div>
          <div class="sf-row-subtitle">${escapeHtml(subtitle || '')}</div>
        </div>
        <div class="sf-row-right">${escapeHtml(value || '')}</div>
      </button>
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

  function healthStatus() {
    return state.health?.status || state.payload?.health?.status || 'unknown';
  }

  function countArray(value) {
    return Array.isArray(value) ? value.length : number(value, 0);
  }

  function selectedBill() {
    const bills = state.payload?.bills || [];
    return bills.find(bill => bill.id === state.selectedBillId) || bills[0] || null;
  }

  async function load() {
    try {
      setText('bills-state-pill', 'Loading');

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
    }
  }

  function renderAll() {
    renderSummary();
    renderBillsList();
    renderSelectedBill();
    renderHealth();
    renderActionsNotice();
    renderDebug();
    bindBillSelection();

    window.SovereignBills = {
      ui_version: VERSION,
      payload: state.payload,
      health: state.health,
      selected_bill_id: state.selectedBillId,
      reload: load
    };

    console.log('[Bills rendered]', VERSION, {
      backend: state.payload?.version,
      health: state.health?.version,
      expected: state.payload?.expected_this_cycle,
      paid: state.payload?.paid_this_cycle,
      remaining: state.payload?.remaining,
      status: healthStatus()
    });
  }

  function renderSummary() {
    const payload = state.payload || {};
    const status = healthStatus();
    const bills = payload.bills || [];

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
    setDataValue('bill_count', `${bills.length} bills`);
    setDataValue('add_state', 'Read-only');
    setDataValue('payment_state', 'Read-only');

    setText('bills-expected-this-cycle', expected);
    setText('bills-paid-this-cycle', paid);
    setText('bills-remaining', remaining);
    setText('bills-status-counts', statusCounts);
    setText('bills-ledger-reversed-excluded', excluded);
    setText('bills-health-status', healthLabel);
    setText('bills-count-pill', `${bills.length} bills`);
    setText('bills-health-pill', healthLabel);
    setText('bills-add-state', 'Read-only');
    setText('bills-payment-state', 'Read-only');
    setText('bills-state-pill', `${payload.version || 'Bills'} · ${healthLabel}`);
    setText('bills-last-loaded', 'Last loaded: ' + new Date().toLocaleTimeString());

    setText('bills-kpi-expected', expected);
    setText('bills-kpi-paid', paid);
    setText('bills-kpi-remaining', remaining);
    setText('bills-kpi-health', healthLabel);
  }

  function renderBillsList() {
    const bills = state.payload?.bills || [];

    if (!bills.length) {
      setList('bills', empty('No active bills', 'Bills backend returned no current-cycle bills.'));
      return;
    }

    setList('bills', bills.map(bill => {
      const cycle = bill.current_cycle || {};
      const ignored = Array.isArray(cycle.ignored_payments)
        ? cycle.ignored_payments.length
        : number(cycle.ignored_payment_count);
      const effective = Array.isArray(cycle.payments)
        ? cycle.payments.length
        : number(cycle.effective_payment_count);

      return buttonRow(
        bill.name || bill.id,
        `${cycle.status || 'unknown'} · due ${cycle.due_date || 'unscheduled'} · ${effective} active · ${ignored} ignored`,
        money(cycle.remaining_amount),
        bill.id,
        bill.id === state.selectedBillId
      );
    }).join(''));
  }

  function renderSelectedBill() {
    const bill = selectedBill();

    if (!bill) {
      setList('selected', empty('No bill selected', 'Select a bill from the current cycle list.'));
      return;
    }

    const cycle = bill.current_cycle || {};
    const activePayments = Array.isArray(cycle.payments) ? cycle.payments : [];
    const ignoredPayments = Array.isArray(cycle.ignored_payments) ? cycle.ignored_payments : [];

    const activeRows = activePayments.length
      ? activePayments.map(payment => row(
          `Payment ${payment.id || ''}`,
          `${payment.paid_date || '-'} · ${payment.account_id || '-'} · ${payment.transaction_id || 'no transaction'}`,
          money(payment.amount)
        )).join('')
      : row('Valid payments', 'No valid active payments in this cycle', '0');

    const ignoredRows = ignoredPayments.length
      ? ignoredPayments.map(payment => row(
          `Ignored ${payment.id || ''}`,
          `${payment.ignore_reason || 'ignored'} · ${payment.transaction_id || 'no transaction'}`,
          money(payment.amount)
        )).join('')
      : row('Ignored payments', 'No ignored/reversed payments in this cycle', '0');

    setList('selected', [
      row(bill.name || bill.id, `Status ${cycle.status || '-'} · due ${cycle.due_date || '-'}`, money(cycle.amount)),
      row('Paid amount', 'Backend current_cycle paid amount', money(cycle.paid_amount)),
      row('Remaining amount', 'Backend current_cycle remaining amount', money(cycle.remaining_amount)),
      row('Default account', 'Shown for context only in read-only stabilizer', bill.default_account_id || 'Select when paying'),
      activeRows,
      ignoredRows
    ].join(''));
  }

  function renderHealth() {
    const health = state.health || {};
    const status = health.status || 'unknown';

    const rows = [
      row('Health status', `Version ${health.version || '-'}`, status),
      row('Payment rows', 'Total bill payment rows checked', String(number(health.payment_rows))),
      row('Orphans', 'Active payments without transaction', String(countArray(health.orphans))),
      row('Active reversed mismatch', 'Active payments linked to reversed ledger transactions', String(countArray(health.active_payment_reversed_txn_mismatch))),
      row('Missing reversal transaction', 'Reversed payments with missing reversal transaction', String(countArray(health.missing_reversal_txn))),
      row('Duplicates', 'Same bill/month/amount/account duplicates', String(countArray(health.duplicate_bill_month_amount))),
      row('Amount mismatches', 'Payment amount does not match ledger amount', String(countArray(health.amount_mismatches)))
    ];

    const issueRows = [];

    [
      ['Orphan', health.orphans],
      ['Active reversed mismatch', health.active_payment_reversed_txn_mismatch],
      ['Missing reversal transaction', health.missing_reversal_txn],
      ['Duplicate', health.duplicate_bill_month_amount],
      ['Amount mismatch', health.amount_mismatches]
    ].forEach(([label, items]) => {
      if (!Array.isArray(items) || !items.length) return;

      items.forEach(item => {
        issueRows.push(row(
          label,
          item.reason || item.payment_id || item.bill_id || item.transaction_id || item.key || 'issue',
          item.amount != null ? money(item.amount) : 'Review'
        ));
      });
    });

    setList('health', rows.concat(issueRows).join(''));
    setText('bills-health-pill', status === 'pass' ? 'Pass' : status);
  }

  function renderActionsNotice() {
    const addForm = document.getElementById('bills-add-form');
    if (addForm) {
      addForm.addEventListener('submit', function (event) {
        event.preventDefault();
        alert('Add New Bill is temporarily paused in this read-only stabilizer. Next pass will wire create safely.');
      }, { once: true });
    }

    const paymentForm = document.getElementById('bills-payment-form');
    if (paymentForm) {
      paymentForm.addEventListener('submit', function (event) {
        event.preventDefault();
        alert('Pay Bill is temporarily paused in this read-only stabilizer. Next pass will wire payment safely.');
      }, { once: true });
    }
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
      health: state.health
    }, null, 2);
  }

  function bindBillSelection() {
    document.querySelectorAll('[data-bill-select]').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedBillId = el.getAttribute('data-bill-select');
        renderBillsList();
        renderSelectedBill();
      });
    });
  }

  function renderError(err) {
    const message = err.message || String(err);

    setText('bills-state-pill', 'Bills failed');
    setText('bills-health-status', 'Error');
    setText('bills-health-pill', 'Error');

    setList('bills', empty('Bills failed to load', message));
    setList('selected', empty('Selected bill unavailable', message));
    setList('health', empty('Bills health unavailable', message));

    console.error('[Bills UI error]', err);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load, { once: true });
  } else {
    load();
  }
})();
