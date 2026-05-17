/* js/atm.js
 * Sovereign Finance · ATM Frontend Binding
 * v0.2.0-atm-frontend-binding
 *
 * Contract:
 * - Frontend does not calculate authoritative balances.
 * - Frontend submits ATM withdrawal intent only.
 * - Backend creates source transfer row, cash income row, and optional fee row.
 * - Fee row is separate and not linked to transfer pair.
 * - UI uses existing shared shell/components where available.
 */

(function () {
  'use strict';

  if (window.SovereignATM && window.SovereignATM.initialized) return;

  const VERSION = 'v0.2.0-atm-frontend-binding';

  const API_ATM = '/api/atm';
  const API_BALANCES = '/api/balances';

  const state = {
    context: null,
    balances: null,
    submitting: false
  };

  const $ = id => document.getElementById(id);

  function components() {
    return window.SFComponents || {};
  }

  function esc(value) {
    const c = components();

    if (typeof c.escapeHtml === 'function') return c.escapeHtml(value);

    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    const c = components();

    if (typeof c.money === 'function') {
      return c.money(value, {
        maximumFractionDigits: 2
      });
    }

    const n = Number(value);

    if (!Number.isFinite(n)) return '—';

    return 'Rs ' + n.toLocaleString('en-PK', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
  }

  function setValue(id, value) {
    const el = $(id);
    if (el && !el.value) el.value = value == null ? '' : String(value);
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  function setPill(id, label, tone) {
    const el = $(id);
    if (!el) return;

    el.textContent = label == null ? '' : String(label);
    el.className = 'sf-pill' + (tone ? ' sf-pill--' + tone : '');
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

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ('HTTP ' + response.status));
    }

    return data;
  }

  function accountId(account) {
    return account && (account.id || account.account_id) || '';
  }

  function accountName(account) {
    return account && (account.name || account.account_name || account.label || accountId(account)) || 'Account';
  }

  function accountLabel(account) {
    if (!account) return '—';
    return `${account.icon || ''} ${accountName(account)}`.trim();
  }

  function normalizeAccounts(payload) {
    if (!payload) return [];

    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (Array.isArray(payload.source_accounts)) return payload.source_accounts;

    if (payload.accounts && typeof payload.accounts === 'object') {
      return Object.entries(payload.accounts).map(([id, row]) => ({
        id,
        ...(row || {})
      }));
    }

    if (Array.isArray(payload.account_list)) return payload.account_list;

    return [];
  }

  function sourceAccounts() {
    if (!state.context) return [];

    if (Array.isArray(state.context.source_accounts)) {
      return state.context.source_accounts;
    }

    return normalizeAccounts(state.context)
      .filter(account => String(account.kind || account.type || '').toLowerCase() !== 'cash')
      .filter(account => String(account.type || '').toLowerCase() !== 'liability');
  }

  function destinationAccounts() {
    if (!state.context) return [];

    if (Array.isArray(state.context.destination_accounts)) {
      return state.context.destination_accounts;
    }

    return normalizeAccounts(state.context)
      .filter(account => String(account.type || '').toLowerCase() !== 'liability');
  }

  function getAccountBalance(accountIdValue) {
    if (!state.balances) return null;

    const accounts = state.balances.accounts || {};
    const row = accounts[accountIdValue];

    if (!row) return null;

    return row.balance ?? row.current_balance ?? row.amount ?? null;
  }

  function fillSelect(id, accounts, fallbackLabel) {
    const select = $(id);
    if (!select) return;

    const current = select.value;

    select.innerHTML = [
      `<option value="">${esc(fallbackLabel || 'Select account')}</option>`
    ].concat(accounts.map(account => {
      const idValue = accountId(account);
      const balance = getAccountBalance(idValue);
      const suffix = balance == null ? '' : ` · ${money(balance)}`;

      return `<option value="${esc(idValue)}">${esc(accountLabel(account) + suffix)}</option>`;
    })).join('');

    if (current) select.value = current;
  }

  function applyDefaults() {
    const defaults = state.context && state.context.defaults || {};

    setValue('atm-source-account', defaults.source_account_id || 'mashreq');
    setValue('atm-destination-account', defaults.destination_account_id || 'cash');
    setValue('atm-fee', defaults.fee_pkr == null ? 35 : defaults.fee_pkr);
    setValue('atm-date', todayISO());
  }

  function renderKpis() {
    const context = state.context || {};
    const pendingCount = Number(context.pending_count || 0);
    const pendingTotal = Number(context.total_pending_pkr || 0);
    const fees30 = context.fees_30d || {};
    const defaults = context.defaults || {};

    setText('atm-kpi-pending-count', String(pendingCount));
    setText('atm-kpi-pending-total', money(pendingTotal));
    setText('atm-kpi-fees-paid', money(fees30.paid || 0));
    setText('atm-kpi-fees-reversed', money(fees30.reversed || 0));
    setText('atm-kpi-fees-net', money(fees30.net || 0));
    setText('atm-kpi-default-fee', money(defaults.fee_pkr == null ? 35 : defaults.fee_pkr));

    setPill(
      'atm-source-status',
      context.version ? `ATM API ${context.version}` : 'ATM API loaded',
      'positive'
    );

    if (window.SFShell && typeof window.SFShell.setKpis === 'function') {
      window.SFShell.setKpis([
        {
          title: 'Pending ATM Fees',
          kicker: 'ATM',
          valueHtml: String(pendingCount),
          subtitle: money(pendingTotal),
          foot: 'Awaiting reversal or expiry',
          tone: pendingCount ? 'warning' : 'positive'
        },
        {
          title: 'Fees 30d',
          kicker: 'ATM',
          valueHtml: money(fees30.net || 0),
          subtitle: `Paid ${money(fees30.paid || 0)} · Reversed ${money(fees30.reversed || 0)}`,
          foot: 'Net fee pressure',
          tone: Number(fees30.net || 0) > 0 ? 'warning' : 'positive'
        },
        {
          title: 'Default Source',
          kicker: 'ATM',
          valueHtml: defaults.source_account_id || '—',
          subtitle: `Destination ${defaults.destination_account_id || 'cash'}`,
          foot: 'Backend defaults',
          tone: 'info'
        },
        {
          title: 'Balance Source',
          kicker: 'Accounts',
          valueHtml: 'Ledger',
          subtitle: 'No direct balance mutation',
          foot: 'transactions_canonical',
          tone: 'positive'
        }
      ]);
    }
  }

  function renderPendingFees() {
    const rows = state.context && Array.isArray(state.context.pending_fees)
      ? state.context.pending_fees
      : [];

    if (!rows.length) {
      setHTML('atm-pending-fees-list', emptyState(
        'No pending ATM fees',
        'No ATM fee rows are currently waiting for reversal.'
      ));
      return;
    }

    setHTML('atm-pending-fees-list', rows.map(row => `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(row.id || 'ATM fee')}</div>
          <div class="sf-row-subtitle">${esc(row.date || '—')} · ${esc(row.account_id || '—')} · age ${esc(row.age_days ?? '—')}d</div>
          <div class="sf-row-subtitle">${esc(row.notes || '')}</div>
        </div>
        <div class="sf-row-right">
          <div class="sf-tone-warning">${money(row.amount)}</div>
          <div class="sf-row-subtitle">pending</div>
        </div>
      </div>
    `).join(''));
  }

  function renderRecentRows() {
    const rows = state.context && Array.isArray(state.context.recent_atm_rows)
      ? state.context.recent_atm_rows
      : [];

    if (!rows.length) {
      setHTML('atm-recent-list', emptyState(
        'No recent ATM rows',
        'ATM rows will appear here after withdrawal activity.'
      ));
      return;
    }

    setHTML('atm-recent-list', rows.slice(0, 20).map(row => {
      const type = String(row.type || '').toLowerCase();
      const tone = type === 'income'
        ? 'positive'
        : type === 'transfer'
          ? 'info'
          : 'warning';

      return `
        <div class="sf-finance-row">
          <div class="sf-row-left">
            <div class="sf-row-title">${esc(row.id || 'ATM row')}</div>
            <div class="sf-row-subtitle">${esc(row.date || '—')} · ${esc(row.type || '—')} · ${esc(row.account_id || '—')}</div>
            <div class="sf-row-subtitle">${esc(row.notes || '')}</div>
          </div>
          <div class="sf-row-right">
            <div class="sf-tone-${tone}">${money(row.amount)}</div>
            <div class="sf-row-subtitle">${esc(row.linked_txn_id || 'unlinked')}</div>
          </div>
        </div>
      `;
    }).join(''));
  }

  function renderDebug() {
    const debug = {
      page_version: VERSION,
      endpoint: API_ATM,
      balance_endpoint: API_BALANCES,
      contract: {
        frontend_money_truth: false,
        backend_write_owner: '/api/atm',
        account_balance_source: 'transactions_canonical',
        fee_link_policy: 'fee row is separate, not linked to withdrawal pair'
      },
      context: state.context,
      balances: state.balances
    };

    setText('atm-debug-output', JSON.stringify(debug, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === 'function') {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function emptyState(title, subtitle) {
    const c = components();

    if (typeof c.emptyState === 'function') {
      return c.emptyState({ title, subtitle });
    }

    return `
      <div class="sf-empty-state">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(subtitle || '')}</p>
        </div>
      </div>
    `;
  }

  function loadingState(title, subtitle) {
    const c = components();

    if (typeof c.loadingState === 'function') {
      return c.loadingState({ title, subtitle });
    }

    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(subtitle || '')}</p>
        </div>
      </div>
    `;
  }

  function errorState(title, message) {
    const c = components();

    if (typeof c.errorState === 'function') {
      return c.errorState({ title, message });
    }

    return `
      <div class="sf-empty-state sf-tone-danger">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(message || '')}</p>
        </div>
      </div>
    `;
  }

  function readForm() {
    const source = $('atm-source-account');
    const destination = $('atm-destination-account');
    const amount = $('atm-amount');
    const fee = $('atm-fee');
    const date = $('atm-date');
    const notes = $('atm-notes');

    return {
      action: 'withdrawal',
      source_account_id: source ? source.value : '',
      cash_account_id: destination ? destination.value : 'cash',
      amount: amount ? asNumber(amount.value, 0) : 0,
      fee_amount: fee ? asNumber(fee.value, 0) : 0,
      date: date && date.value ? date.value : todayISO(),
      notes: notes ? notes.value.trim() : '',
      created_by: 'web-atm',
      idempotency_key: 'atm_' + Date.now()
    };
  }

  function validateForm(payload) {
    if (!payload.source_account_id) return 'Select source account.';
    if (!payload.cash_account_id) return 'Select cash/destination account.';
    if (payload.source_account_id === payload.cash_account_id) return 'Source and destination cannot be same.';
    if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) <= 0) return 'Amount must be greater than 0.';
    if (!Number.isFinite(Number(payload.fee_amount)) || Number(payload.fee_amount) < 0) return 'Fee cannot be negative.';
    if (!payload.date) return 'Date required.';
    return '';
  }

  async function submitWithdrawal(event) {
    if (event) event.preventDefault();

    if (state.submitting) return;

    const payload = readForm();
    const error = validateForm(payload);

    if (error) {
      showResult(false, error);
      return;
    }

    state.submitting = true;
    setDisabled('atm-submit', true);
    setText('atm-submit-label', 'Saving…');
    showResult(true, 'Submitting ATM withdrawal…');

    try {
      const response = await fetchJSON(API_ATM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      showResult(true, buildSuccessMessage(response));
      clearAmountFields();
      await loadAll();
    } catch (err) {
      showResult(false, err.message || String(err));
    } finally {
      state.submitting = false;
      setDisabled('atm-submit', false);
      setText('atm-submit-label', 'Record ATM withdrawal');
    }
  }

  function buildSuccessMessage(response) {
    const ids = response.transaction_ids || [];
    const sourceDelta = response.account_impact && response.account_impact.source_account_delta;
    const cashDelta = response.account_impact && response.account_impact.cash_account_delta;

    return [
      'ATM withdrawal recorded.',
      ids.length ? `Rows: ${ids.join(', ')}` : '',
      sourceDelta != null ? `Source impact: ${money(sourceDelta)}` : '',
      cashDelta != null ? `Cash impact: +${money(cashDelta).replace(/^Rs /, 'Rs ')}` : ''
    ].filter(Boolean).join(' ');
  }

  function clearAmountFields() {
    const amount = $('atm-amount');
    const notes = $('atm-notes');

    if (amount) amount.value = '';
    if (notes) notes.value = '';
  }

  function showResult(ok, message) {
    const el = $('atm-result');
    if (!el) return;

    el.hidden = false;
    el.className = 'sf-callout ' + (ok ? 'sf-callout--success' : 'sf-callout--danger');
    el.textContent = message;
  }

  function bindEvents() {
    const form = $('atm-form');

    if (form) {
      form.addEventListener('submit', submitWithdrawal);
    }

    $('atm-submit')?.addEventListener('click', submitWithdrawal);
    $('atm-refresh')?.addEventListener('click', loadAll);
  }

  async function loadAll() {
    setPill('atm-source-status', 'Loading', 'info');
    setHTML('atm-pending-fees-list', loadingState('Loading ATM fees', 'Reading /api/atm.'));
    setHTML('atm-recent-list', loadingState('Loading ATM rows', 'Reading /api/atm.'));

    try {
      const [contextResult, balancesResult] = await Promise.allSettled([
        fetchJSON(API_ATM),
        fetchJSON(API_BALANCES)
      ]);

      if (contextResult.status === 'fulfilled') {
        state.context = contextResult.value;
      } else {
        throw contextResult.reason;
      }

      if (balancesResult.status === 'fulfilled') {
        state.balances = balancesResult.value;
      } else {
        state.balances = null;
      }

      fillSelect('atm-source-account', sourceAccounts(), 'Source account');
      fillSelect('atm-destination-account', destinationAccounts(), 'Destination account');
      applyDefaults();
      renderKpis();
      renderPendingFees();
      renderRecentRows();
      renderDebug();
    } catch (err) {
      setPill('atm-source-status', 'ATM API failed', 'danger');
      setHTML('atm-pending-fees-list', errorState('ATM API failed', err.message || String(err)));
      setHTML('atm-recent-list', errorState('ATM rows unavailable', 'Could not load ATM context.'));
    }
  }

  function init() {
    window.SovereignATM = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      submitWithdrawal,
      context: () => state.context,
      balances: () => state.balances
    };

    setText('atm-js-version', VERSION);
    setText('atm-footer-version', `v0.2.0 · ATM · ${VERSION}`);

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
