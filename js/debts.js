/* js/debts.js
 * Sovereign Finance · Debts UI
 * v2.0.0-end-user-floating
 *
 * Contract:
 * - Loads debts, accounts, and health in parallel.
 * - All forms open in a floating overlay.
 * - Forms never drag the page down.
 * - Clicking inside floating forms never closes them.
 * - Payment save is disabled until amount + account are valid.
 * - Canonical create/payment/repair route: POST /api/debts
 * - Canonical schedule/status route: PUT /api/debts/:id
 */

(function () {
  'use strict';

  const VERSION = 'v2.0.0-end-user-floating';

  const API_DEBTS = '/api/debts';
  const API_DEBTS_HEALTH = '/api/debts?action=health';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
  debts: [],
  accounts: [],
  accountsLoading: false,
  accountsLoaded: false,
  accountsError: null,
  lastPayload: null,
  health: null,
  selectedDebtId: null,
  filter: 'active',
  search: '',
  sort: 'due',
  loading: false,
  lastProofHTML: '',
  lastProofTitle: 'Backend proof'
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

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function bodySafeDate() {
    return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  }

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function formatDate(value) {
    const raw = String(value || '').slice(0, 10);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '—';
    return raw;
  }

  function formatDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return '—';
    return raw.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
  }

  function safeIdPart(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function kindLabel(kind) {
    return kind === 'owed' ? 'Owed to me' : 'I owe';
  }

  function kindBucket(kind) {
    return kind === 'owed' ? 'Receivable' : 'Payable';
  }

  function tone(value) {
    const s = String(value || '').toLowerCase();

    if (['pass', 'ok', 'active', 'settled', 'linked', 'scheduled', 'paid_off', 'committed', 'passed'].includes(s)) return 'positive';
    if (['warn', 'paused', 'due_today', 'due_soon', 'no_schedule', 'payment_linked_only', 'pending'].includes(s)) return 'warning';
    if (['overdue', 'failed', 'danger', 'blocked', 'ledger_missing', 'needs repair'].includes(s)) return 'danger';

    return '';
  }

  function pill(text, toneName) {
    const cls = ['sf-pill'];
    if (toneName) cls.push(`sf-tone-${toneName}`);
    return `<span class="${cls.join(' ')}">${esc(text)}</span>`;
  }

  function detailRow(label, value, sub, toneName) {
    const valueClass = toneName ? ` sf-tone-${toneName}` : '';

    return `
      <div class="sf-debt-detail-row">
        <div>
          <div class="sf-row-title">${esc(label)}</div>
          ${sub ? `<div class="sf-row-subtitle">${esc(sub)}</div>` : ''}
        </div>
        <div class="sf-row-right${valueClass}">${value == null ? '—' : value}</div>
      </div>
    `;
  }

  function proofRow(label, value, sub, toneName) {
    return detailRow(label, value, sub, toneName);
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

  function postJSON(url, body) {
    return fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function putJSON(url, body) {
    return fetchJSON(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function normalizeDebt(row) {
    const original = num(row.original_amount ?? row.amount);
    const paid = num(row.paid_amount);
    const remaining = num(row.remaining_amount, Math.max(0, original - paid));

    return {
      ...row,
      id: row.id || '',
      name: row.name || row.title || row.label || row.id || 'Debt',
      kind: row.kind === 'owed' ? 'owed' : 'owe',
      original_amount: original,
      paid_amount: paid,
      remaining_amount: remaining,
      status: String(row.status || 'active').toLowerCase(),
      due_status: row.due_status || 'no_schedule',
      due_date: row.due_date || null,
      due_day: row.due_day == null ? null : row.due_day,
      installment_amount: row.installment_amount == null ? null : num(row.installment_amount),
      frequency: row.frequency || 'monthly',
      last_paid_date: row.last_paid_date || null,
      next_due_date: row.next_due_date || null,
      days_until_due: row.days_until_due == null ? null : row.days_until_due,
      days_overdue: row.days_overdue == null ? null : row.days_overdue,
      schedule_missing: Boolean(row.schedule_missing),
      origin_state: row.origin_state || '',
      origin_required: Boolean(row.origin_required ?? row.ledger_required),
      origin_linked: Boolean(row.origin_linked ?? row.ledger_linked),
      origin_transaction_ids: Array.isArray(row.origin_transaction_ids)
        ? row.origin_transaction_ids
        : (Array.isArray(row.ledger_transaction_ids) ? row.ledger_transaction_ids : []),
      origin_transactions: Array.isArray(row.origin_transactions)
        ? row.origin_transactions
        : (Array.isArray(row.ledger_transactions) ? row.ledger_transactions : []),
      payment_transaction_ids: Array.isArray(row.payment_transaction_ids) ? row.payment_transaction_ids : [],
      payment_transactions: Array.isArray(row.payment_transactions) ? row.payment_transactions : [],
      repair_required: Boolean(row.repair_required),
      notes: row.notes || '',
      created_at: row.created_at || null,
      raw: row
    };
  }

  function accountRowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.accounts)) return payload.accounts;
  if (payload.accounts && typeof payload.accounts === 'object') return Object.values(payload.accounts);
  if (payload.accounts_by_id && typeof payload.accounts_by_id === 'object') return Object.values(payload.accounts_by_id);
  if (Array.isArray(payload.account_list)) return payload.account_list;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === 'object') return Object.values(payload.data);
  return [];
}

  function normalizeAccount(row) {
  const id = row.id || row.account_id || row.key || row.slug || row.name || '';
  const name = row.name || row.label || row.display_name || id || 'Account';

  return {
    ...row,
    id: clean(id),
    name: clean(name),
    type: row.type || row.kind || 'account',
    balance: num(row.balance ?? row.current_balance ?? row.available_balance ?? row.amount, 0),
    status: row.status || 'active'
  };
}
async function loadAccounts(force) {
  if (state.accountsLoading) return state.accounts;
  if (state.accountsLoaded && !force) return state.accounts;

  state.accountsLoading = true;
  state.accountsError = null;
  refreshAccountSelects();

  try {
    const payload = await fetchJSON(API_ACCOUNTS);
    state.accounts = accountRowsFromPayload(payload)
      .filter(Boolean)
      .map(normalizeAccount)
      .filter(account => account.id);

    state.accountsLoaded = true;
    state.accountsError = state.accounts.length ? null : 'No accounts returned by /api/accounts';
  } catch (err) {
    state.accounts = [];
    state.accountsLoaded = false;
    state.accountsError = err.message || 'Failed to load accounts';
  } finally {
    state.accountsLoading = false;
    refreshAccountSelects();
    renderDebug({
      accounts_loaded: state.accountsLoaded,
      accounts_count: state.accounts.length,
      accounts_error: state.accountsError
    });
  }

  return state.accounts;
}

  function selectedDebt() {
    return findDebtById(state.selectedDebtId);
  }

  function findDebtById(id) {
    return state.debts.find(debt => String(debt.id) === String(id)) || null;
  }

  function isTerminalStatus(status) {
    return ['settled', 'archived', 'closed', 'deleted', 'paid', 'finished', 'completed', 'done']
      .includes(String(status || '').trim().toLowerCase());
  }

  function isActiveDebt(debt) {
    return !isTerminalStatus(debt.status);
  }

  function debtPaidPct(debt) {
    const original = num(debt.original_amount);
    const paid = num(debt.paid_amount);
    if (!original || original <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((paid / original) * 100)));
  }

  function accountOptions(selectedValue, placeholder) {
  if (state.accountsLoading) {
    return '<option value="">Loading accounts…</option>';
  }

  if (state.accountsError) {
    return `<option value="">Accounts unavailable: ${esc(state.accountsError)}</option>`;
  }

  if (!state.accounts.length) {
    return '<option value="">No accounts found</option>';
  }

  return [`<option value="">${esc(placeholder || 'Choose account…')}</option>`].concat(
    state.accounts.map(account => {
      const selected = String(account.id) === String(selectedValue || '') ? ' selected' : '';
      return `<option value="${esc(account.id)}"${selected}>${esc(account.name)} · ${money(account.balance)}</option>`;
    })
  ).join('');
}

  function refreshAccountSelects() {
  [
    ['floatingDebtAccountInput', 'Choose account…'],
    ['floatingRepairAccountInput', 'Choose account…'],
    ['floatingPaymentAccountInput', 'Choose payment account…']
  ].forEach(([id, placeholder]) => {
    const select = $(id);
    if (!select) return;

    const current = select.value;
    select.innerHTML = accountOptions(current, placeholder);

    const unavailable = state.accountsLoading || state.accountsError || !state.accounts.length;
    select.disabled = Boolean(unavailable);

    if (current && !unavailable) {
      select.value = current;
    }
  });

  updatePaymentButtons();
  updateRepairButtons();
  updateCreateButtons();

  const paymentHelp = $('floatingPaymentAccountHelp');
  if (paymentHelp) {
    paymentHelp.textContent = state.accounts.length
      ? 'Choose the account this money moved through.'
      : (state.accountsError || (state.accountsLoading ? 'Accounts are loading…' : 'No accounts found.'));
  }
}

  async function loadDebts() {
  if (state.loading) return;

  state.loading = true;
  setHTML('debtList', `<div class="sf-empty-state">Loading debts…</div>`);
  setText('metricHealth', 'loading');

  const startedAt = Date.now();

  const accountsPromise = loadAccounts(true)
    .then(accounts => {
      renderDebug({
        accounts_loaded: state.accountsLoaded,
        accounts_count: accounts.length,
        accounts_error: state.accountsError,
        elapsed_ms: Date.now() - startedAt
      });
      return accounts;
    });

  const healthPromise = fetchJSON(API_DEBTS_HEALTH)
    .then(payload => {
      state.health = payload;
      renderMetrics();
      renderDebug({
        health_loaded: true,
        health_status: payload?.status || payload?.health?.status || 'unknown',
        elapsed_ms: Date.now() - startedAt
      });
      return payload;
    })
    .catch(err => {
      state.health = null;
      renderMetrics();
      renderDebug({
        health_loaded: false,
        health_error: err.message,
        elapsed_ms: Date.now() - startedAt
      });
      return null;
    });

  try {
    const payload = await fetchJSON(API_DEBTS);

    state.lastPayload = payload;
    state.debts = (Array.isArray(payload.debts) ? payload.debts : []).map(normalizeDebt);

    if (state.selectedDebtId && !findDebtById(state.selectedDebtId)) {
      state.selectedDebtId = null;
    }

    if (!state.selectedDebtId && state.debts.length) {
      state.selectedDebtId = state.debts[0].id;
    }

    renderAll();

    renderDebug({
      debts_loaded: true,
      debts_count: state.debts.length,
      elapsed_ms: Date.now() - startedAt,
      loading_mode: 'parallel_debts_accounts_health'
    });
  } catch (err) {
    setHTML('debtList', `<div class="sf-empty-state">Failed to load debts: ${esc(err.message)}</div>`);
    setText('metricHealth', 'failed');
    renderDebug({
      debts_loaded: false,
      error: err.message,
      elapsed_ms: Date.now() - startedAt
    });
  } finally {
    state.loading = false;
  }

  void accountsPromise;
  void healthPromise;
}

  function debtSearchHaystack(debt) {
    return [
      debt.id,
      debt.name,
      debt.kind,
      debt.status,
      debt.due_status,
      debt.due_date,
      debt.next_due_date,
      debt.notes,
      debt.origin_state,
      debt.origin_transaction_ids.join(' '),
      debt.payment_transaction_ids.join(' ')
    ].join(' ').toLowerCase();
  }

  function compareDebts(a, b) {
    if (state.sort === 'created') {
      const ac = String(a.created_at || '');
      const bc = String(b.created_at || '');
      if (ac !== bc) return bc.localeCompare(ac);
      return String(a.id).localeCompare(String(b.id));
    }

    if (state.sort === 'amount') return num(b.remaining_amount) - num(a.remaining_amount);

    if (state.sort === 'name') {
      return String(a.name || '').localeCompare(String(b.name || '')) ||
        String(a.id || '').localeCompare(String(b.id || ''));
    }

    const ad = String(a.next_due_date || a.due_date || '9999-12-31');
    const bd = String(b.next_due_date || b.due_date || '9999-12-31');

    if (ad !== bd) return ad.localeCompare(bd);

    return String(a.name || '').localeCompare(String(b.name || '')) ||
      String(a.id || '').localeCompare(String(b.id || ''));
  }

  function filteredDebts() {
    const q = state.search.toLowerCase();

    return state.debts
      .filter(debt => {
        if (q && !debtSearchHaystack(debt).includes(q)) return false;

        if (state.filter === 'all') return true;
        if (state.filter === 'active') return isActiveDebt(debt);
        if (state.filter === 'owe') return debt.kind === 'owe' && isActiveDebt(debt);
        if (state.filter === 'owed') return debt.kind === 'owed' && isActiveDebt(debt);
        if (state.filter === 'due') return ['due_today', 'due_soon', 'overdue'].includes(debt.due_status) && isActiveDebt(debt);
        if (state.filter === 'missing_ledger') return debt.repair_required || (debt.origin_required && !debt.origin_linked);

        return true;
      })
      .sort(compareDebts);
  }

  function originLabel(debt) {
    if (debt.origin_linked) return 'ledger linked';
    if (debt.repair_required || (debt.origin_required && !debt.origin_linked)) return 'needs repair';

    const notes = String(debt.notes || '').toLowerCase();
    if (notes.includes('movement_now=0')) return 'debt-only';

    if (debt.origin_state === 'payment_linked_only') return 'payment linked only';
    if (debt.origin_state === 'legacy_unknown') return 'legacy/no-origin';

    return 'no origin movement';
  }

  function statusLabel(debt) {
    if (debt.status && debt.status !== 'active') return debt.status;
    if (debt.due_status === 'overdue') return 'overdue';
    if (debt.due_status === 'due_today') return 'due today';
    if (debt.due_status === 'due_soon') return 'due soon';
    if (debt.repair_required || (debt.origin_required && !debt.origin_linked)) return 'repair';
    return debt.status || 'active';
  }

  function subtitleForDebt(debt) {
    const parts = [
      kindBucket(debt.kind),
      originLabel(debt),
      debt.id
    ];

    if (debt.next_due_date || debt.due_date) {
      parts.push(`next ${debt.next_due_date || debt.due_date}`);
    } else {
      parts.push('no due date');
    }

    if (debt.days_overdue) parts.push(`${debt.days_overdue}d overdue`);
    if (debt.days_until_due != null && debt.due_status === 'due_soon') parts.push(`${debt.days_until_due}d left`);

    return parts.join(' · ');
  }

  function renderDebtRow(debt) {
    const selected = String(debt.id) === String(state.selectedDebtId);
    const pct = debtPaidPct(debt);
    const originTone = debt.origin_linked ? 'positive' : ((debt.repair_required || debt.origin_required) ? 'danger' : 'warning');

    return `
      <article class="sf-finance-row sf-debt-row ${selected ? 'is-selected' : ''}" data-debt-id="${esc(debt.id)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(debt.name)}</div>
          <div class="sf-row-subtitle">${esc(subtitleForDebt(debt))}</div>
          <div class="sf-section-actions">
            ${pill(kindLabel(debt.kind), debt.kind === 'owed' ? 'positive' : 'danger')}
            ${pill(statusLabel(debt), tone(statusLabel(debt)))}
            ${pill(originLabel(debt), originTone)}
            ${debt.due_status ? pill(debt.due_status.replace(/_/g, ' '), tone(debt.due_status)) : ''}
            ${pill(`${pct}% paid`, pct >= 100 ? 'positive' : 'warning')}
          </div>
        </div>

        <div class="sf-row-right">
          <div class="sf-debt-row-amount">${money(debt.remaining_amount)}</div>
          <div class="sf-card-subtitle">Remaining</div>
          <div class="sf-section-actions">
            <button class="sf-button" type="button" data-action="details" data-debt-id="${esc(debt.id)}">Details</button>
            <button class="sf-button" type="button" data-action="edit" data-debt-id="${esc(debt.id)}">Edit</button>
            <button class="sf-button sf-button--primary" type="button" data-action="payment" data-debt-id="${esc(debt.id)}">Payment</button>
            <button class="sf-button" type="button" data-action="defer" data-debt-id="${esc(debt.id)}">Defer</button>
            ${(debt.repair_required || (debt.origin_required && !debt.origin_linked))
              ? `<button class="sf-button" type="button" data-action="repair" data-debt-id="${esc(debt.id)}">Repair</button>`
              : ''}
          </div>
        </div>
      </article>
    `;
  }

  function renderDebtList() {
    const rows = filteredDebts();

    setHTML('debtList', rows.length
      ? rows.map(renderDebtRow).join('')
      : `<div class="sf-empty-state">No debts match this filter.</div>`);
  }

  function renderMetrics() {
    const payload = state.lastPayload || {};
    const totals = payload.totals || {};

    const totalOwe = payload.total_owe ?? totals.total_owe ??
      state.debts.filter(debt => debt.kind === 'owe' && isActiveDebt(debt))
        .reduce((sum, debt) => sum + num(debt.remaining_amount), 0);

    const totalOwed = payload.total_owed ?? totals.total_owed ??
      state.debts.filter(debt => debt.kind === 'owed' && isActiveDebt(debt))
        .reduce((sum, debt) => sum + num(debt.remaining_amount), 0);

    const dueSoon = payload.due_soon_count ?? totals.due_soon_count ??
      state.debts.filter(debt => debt.due_status === 'due_soon' && isActiveDebt(debt)).length;

    const overdue = payload.overdue_count ?? totals.overdue_count ??
      state.debts.filter(debt => debt.due_status === 'overdue' && isActiveDebt(debt)).length;

    const missingLedger = payload.repair_required_count ?? totals.repair_required_count ??
      state.debts.filter(debt => debt.repair_required || (debt.origin_required && !debt.origin_linked)).length;

    const healthStatus = state.health?.status || state.health?.health?.status || payload.status || 'unknown';

    setText('metricOwe', money(totalOwe));
    setText('metricOwed', money(totalOwed));
    setText('metricDueSoon', String(dueSoon));
    setText('metricOverdue', String(overdue));
    setText('metricMissingLedger', String(missingLedger));
    setText('metricHealth', healthStatus);

    setText('debtsVersionPill', payload.version || VERSION);
    setText('debtsHealthPill', `health ${healthStatus}`);
    setText('debtsLedgerPill', missingLedger ? `${missingLedger} needs repair` : 'ledger clean');
    setText('debtFooterVersion', `${VERSION} · backend ${payload.version || 'unknown'}`);

    if (missingLedger > 0) {
      setText('debtsHeroStatus', 'Ledger repair needed');
      setText('debtsHeroCopy', `${missingLedger} debt origin movement needs explicit repair.`);
    } else {
      setText('debtsHeroStatus', 'Debt truth');
      setText('debtsHeroCopy', 'Debt rows and ledger links are loaded from backend truth.');
    }
  }

  function renderSelectedDebt() {
    const debt = selectedDebt();

    if (!debt) {
      setText('selectedDebtTitle', 'No debt selected');
      setText('selectedDebtSub', 'Backend state summary');
      setHTML('selectedDebtPanel', `<div class="sf-empty-state">No debt selected.</div>`);
      return;
    }

    setText('selectedDebtTitle', debt.name);
    setText('selectedDebtSub', `${kindLabel(debt.kind)} · ${debt.id}`);

    setHTML('selectedDebtPanel', `
      ${detailRow('Kind', kindLabel(debt.kind), 'Debt direction', debt.kind === 'owed' ? 'positive' : 'danger')}
      ${detailRow('Original', money(debt.original_amount), 'Principal')}
      ${detailRow('Paid', money(debt.paid_amount), 'Recorded paid amount')}
      ${detailRow('Remaining', money(debt.remaining_amount), 'Current balance', debt.remaining_amount > 0 ? 'warning' : 'positive')}
      ${detailRow('Status', esc(debt.status || 'active'), 'Debt row status', tone(debt.status))}
      ${detailRow('Due status', esc(debt.due_status || 'no schedule'), 'Schedule state', tone(debt.due_status))}
      ${detailRow('Next due', esc(formatDate(debt.next_due_date || debt.due_date)), 'Computed due date')}
      ${detailRow('Origin state', esc(originLabel(debt)), 'Ledger origin classifier', debt.origin_linked ? 'positive' : ((debt.repair_required || debt.origin_required) ? 'danger' : 'warning'))}
      ${detailRow('Origin ledger IDs', esc(debt.origin_transaction_ids.length ? debt.origin_transaction_ids.join(', ') : 'None'), 'Linked origin rows')}
      ${detailRow('Payment ledger IDs', esc(debt.payment_transaction_ids.length ? debt.payment_transaction_ids.join(', ') : 'None'), 'Linked payment rows')}
      ${detailRow('Created', esc(formatDateTime(debt.created_at)), 'Debt created timestamp')}
      ${debt.notes ? detailRow('Notes', esc(debt.notes), 'Backend notes') : ''}
    `);
  }

  function renderEnforcement() {
    setHTML('debtEnforcementPanel', `
      ${detailRow('Money owner', 'POST /api/debts', 'Canonical backend', 'positive')}
      ${detailRow('Create', 'action=create', 'Debt record creation')}
      ${detailRow('Payment', 'action=payment', 'Pay/receive through one route', 'positive')}
      ${detailRow('Repair', 'action=repair_ledger', 'Explicit only', 'warning')}
      ${detailRow('Reversal owner', 'POST /api/transactions/reverse', 'Do not reverse from Debts')}
    `);
  }

  function setProof(title, html) {
    state.lastProofTitle = title || 'Backend proof';
    state.lastProofHTML = html || '';
    renderProof();
  }

  function renderProof(html) {
    const content = html || state.lastProofHTML || `<div class="sf-empty-state">No backend proof yet. Run a dry-run first.</div>`;
    setHTML('debtActionPanel', content);
  }

  function renderDebug(extra) {
    setText('debtDebug', JSON.stringify({
      version: VERSION,
      filter: state.filter,
      search: state.search,
      sort: state.sort,
      selectedDebtId: state.selectedDebtId,
      lastPayload: state.lastPayload,
      debts: state.debts,
      accounts: state.accounts,
      health: state.health,
      extra: extra || null
    }, null, 2));
  }

  function renderAll() {
    renderMetrics();
    ensureDebtControls();
    renderDebtList();
    renderSelectedDebt();
    renderEnforcement();
    renderProof();
    renderDebug();
  }

  function selectDebt(id) {
    state.selectedDebtId = id;

    document.querySelectorAll('[data-debt-id]').forEach(row => {
      row.classList.toggle('is-selected', row.getAttribute('data-debt-id') === String(id));
    });

    renderSelectedDebt();
    renderDebug();
  }

  function setFilter(filter) {
    state.filter = filter;

    document.querySelectorAll('[data-filter]').forEach(button => {
      button.classList.toggle('is-active', button.getAttribute('data-filter') === filter);
    });

    renderDebtList();
    renderDebug();
  }

  function ensureDebtControls() {
    if ($('debtSearchInput') && $('debtSortInput')) return;

    const filterRow = document.querySelector('.debt-filter-row');
    if (!filterRow) return;

    const controls = document.createElement('div');
    controls.className = 'sf-section-actions sf-debt-search-row';
    controls.innerHTML = `
      <input
        id="debtSearchInput"
        class="sf-input"
        type="search"
        placeholder="Search debts, IDs, notes, ledger IDs"
        value="${esc(state.search)}"
      >
      <select id="debtSortInput" class="sf-select">
        <option value="due">Sort: Due date</option>
        <option value="created">Sort: Created</option>
        <option value="amount">Sort: Amount</option>
        <option value="name">Sort: Name</option>
      </select>
    `;

    filterRow.insertAdjacentElement('afterend', controls);

    $('debtSearchInput')?.addEventListener('input', event => {
      state.search = clean(event.target.value);
      renderDebtList();
      renderDebug();
    });

    $('debtSortInput')?.addEventListener('change', event => {
      state.sort = event.target.value || 'due';
      renderDebtList();
      renderDebug();
    });

    const sort = $('debtSortInput');
    if (sort) sort.value = state.sort;
  }

  function closeFloatingForm() {
    const existing = $('debtFloatingOverlay');
    if (existing) existing.remove();

    document.body.classList.remove('sf-debt-floating-open');
    document.removeEventListener('keydown', closeOnEscape);
  }

  function openFloatingForm(title, subtitle, bodyHTML, options) {
    closeFloatingForm();

    const overlay = document.createElement('div');
    overlay.id = 'debtFloatingOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="sf-debt-floating-backdrop">
        <section class="sf-debt-floating-card" style="${options?.width ? `width: min(${options.width}, 100%);` : ''}">
          <div class="sf-debt-floating-head">
            <div>
              <p class="sf-section-kicker">Debt action</p>
              <h2 class="sf-section-title">${esc(title)}</h2>
              <p class="sf-section-subtitle">${esc(subtitle || '')}</p>
            </div>
            <button class="sf-button" type="button" data-floating-close="button">Close</button>
          </div>

          ${bodyHTML}
        </section>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.classList.add('sf-debt-floating-open');

    const backdrop = overlay.querySelector('.sf-debt-floating-backdrop');

    overlay.addEventListener('click', event => {
      const closeButton = event.target.closest('[data-floating-close="button"]');

      if (closeButton) {
        event.preventDefault();
        closeFloatingForm();
        return;
      }

      if (event.target === backdrop) {
        closeFloatingForm();
      }
    });

    document.removeEventListener('keydown', closeOnEscape);
    document.addEventListener('keydown', closeOnEscape);

    requestAnimationFrame(() => {
      const firstInput = overlay.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      if (firstInput && typeof firstInput.focus === 'function') {
        firstInput.focus({ preventScroll: true });
      }
    });
  }

  function closeOnEscape(event) {
    if (event.key === 'Escape') closeFloatingForm();
  }

  function setFloatingProof(html) {
    const el = $('floatingProofPanel');
    if (el) el.innerHTML = html || '';
  }

  function updateCreateButtons() {
    const name = clean($('floatingDebtNameInput')?.value);
    const amount = num($('floatingDebtOriginalInput')?.value);
    const movementNow = Boolean($('floatingDebtMovementNowInput')?.checked);
    const accountId = clean($('floatingDebtAccountInput')?.value);

    const disabled = !name || !amount || amount <= 0 || (movementNow && !accountId);

    ['floatingCreateDryRunBtn', 'floatingCreateSaveBtn'].forEach(id => {
      const button = $(id);
      if (button) button.disabled = disabled;
    });
  }

  function openCreateForm() {
    const body = `
      <form class="sf-form-grid sf-debt-create-form">
        <label class="sf-field">
          <span>Name / Person</span>
          <input class="sf-input" id="floatingDebtNameInput" type="text" autocomplete="off">
        </label>

        <label class="sf-field">
          <span>Direction</span>
          <select class="sf-select" id="floatingDebtKindInput">
            <option value="owed">Owed to me</option>
            <option value="owe">I owe</option>
          </select>
        </label>

        <label class="sf-field">
          <span>Original amount</span>
          <input class="sf-input" id="floatingDebtOriginalInput" type="number" step="0.01" min="0">
        </label>

        <label class="sf-field">
          <span>Already paid</span>
          <input class="sf-input" id="floatingDebtPaidInput" type="number" step="0.01" min="0" value="0">
        </label>

        <label class="sf-field">
          <span>Due date</span>
          <input class="sf-input" id="floatingDebtDueDateInput" type="date">
        </label>

        <label class="sf-field">
          <span>Due day</span>
          <input class="sf-input" id="floatingDebtDueDayInput" type="number" min="1" max="31">
        </label>

        <label class="sf-field">
          <span>Installment amount</span>
          <input class="sf-input" id="floatingDebtInstallmentInput" type="number" step="0.01" min="0">
        </label>

        <label class="sf-field">
          <span>Frequency</span>
          <select class="sf-select" id="floatingDebtFrequencyInput">
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="yearly">Yearly</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <label class="sf-field">
          <span>Status</span>
          <select class="sf-select" id="floatingDebtStatusInput">
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>

        <label class="sf-field">
          <span>Snowball order</span>
          <input class="sf-input" id="floatingDebtSnowballInput" type="number" step="1">
        </label>

        <label class="sf-field sf-field--wide">
          <span>Ledger movement now</span>
          <span class="sf-row-subtitle">
            <input id="floatingDebtMovementNowInput" type="checkbox">
            Money already moved for this debt
          </span>
        </label>

        <label class="sf-field">
          <span>Account</span>
          <select class="sf-select" id="floatingDebtAccountInput" disabled>
            ${accountOptions('', 'Choose account…')}
          </select>
        </label>

        <label class="sf-field">
          <span>Movement date</span>
          <input class="sf-input" id="floatingDebtMovementDateInput" type="date" value="${todayISO()}">
        </label>

        <label class="sf-field sf-field--wide">
          <span>Notes</span>
          <textarea class="sf-textarea" id="floatingDebtNotesInput"></textarea>
        </label>

        <div class="sf-section-actions sf-field--wide">
          <button class="sf-button" id="floatingCreateDryRunBtn" type="button" data-floating-action="create-dry-run" disabled>Dry-run</button>
          <button class="sf-button sf-button--primary" id="floatingCreateSaveBtn" type="button" data-floating-action="create-save" disabled>Save debt</button>
        </div>
      </form>

      <div id="floatingProofPanel" class="sf-debt-proof-card">
        <div class="sf-empty-state">Dry-run proof will appear here.</div>
      </div>
    `;

    openFloatingForm('Add debt', 'Create a debt record. Ledger movement is optional and explicit.', body, { width: '760px' });

    ['floatingDebtNameInput', 'floatingDebtOriginalInput', 'floatingDebtAccountInput'].forEach(id => {
      $(id)?.addEventListener('input', updateCreateButtons);
      $(id)?.addEventListener('change', updateCreateButtons);
    });

    $('floatingDebtMovementNowInput')?.addEventListener('change', event => {
      const account = $('floatingDebtAccountInput');
      if (account) account.disabled = !event.target.checked || !state.accounts.length;
      updateCreateButtons();
    });

    updateCreateButtons();
  }

  function buildDebtCreatePayload() {
    const movementNow = Boolean($('floatingDebtMovementNowInput')?.checked);
    const name = clean($('floatingDebtNameInput')?.value);

    return {
      action: 'create',
      name,
      kind: $('floatingDebtKindInput')?.value || 'owed',
      original_amount: num($('floatingDebtOriginalInput')?.value),
      paid_amount: num($('floatingDebtPaidInput')?.value),
      due_date: clean($('floatingDebtDueDateInput')?.value) || null,
      due_day: clean($('floatingDebtDueDayInput')?.value) || null,
      installment_amount: clean($('floatingDebtInstallmentInput')?.value) || null,
      frequency: $('floatingDebtFrequencyInput')?.value || 'monthly',
      status: $('floatingDebtStatusInput')?.value || 'active',
      snowball_order: clean($('floatingDebtSnowballInput')?.value) || null,
      movement_now: movementNow,
      account_id: movementNow ? clean($('floatingDebtAccountInput')?.value) : '',
      movement_date: clean($('floatingDebtMovementDateInput')?.value) || todayISO(),
      notes: clean($('floatingDebtNotesInput')?.value),
      idempotency_key: `debt_${bodySafeDate()}_${safeIdPart(name)}`,
      created_by: VERSION
    };
  }

  function validateDebtCreatePayload(payload) {
    if (!payload.name) return 'Debt name required.';
    if (!payload.kind) return 'Debt direction required.';
    if (!Number.isFinite(payload.original_amount) || payload.original_amount <= 0) return 'Original amount must be greater than 0.';
    if (!Number.isFinite(payload.paid_amount) || payload.paid_amount < 0) return 'Paid amount must be 0 or greater.';
    if (payload.paid_amount > payload.original_amount) return 'Already paid cannot exceed original amount.';
    if (payload.movement_now && !payload.account_id) return 'Select the account money moved through.';
    return null;
  }

  async function submitCreate(dryRun) {
    const payload = buildDebtCreatePayload();
    const error = validateDebtCreatePayload(payload);

    if (error) {
      toast(error);
      setFloatingProof(proofRow('Validation failed', esc(error), 'Fix form fields', 'danger'));
      return;
    }

    toast(dryRun ? 'Running debt dry-run…' : 'Saving debt…');

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? '?dry_run=1' : ''}`, payload);

      const proof = `
        ${proofRow(dryRun ? 'Dry-run' : 'Saved', dryRun ? 'Passed' : 'Committed', 'Backend validation', 'positive')}
        ${proofRow('Ledger movement', result.ledger?.created ? 'Yes' : 'No', 'Expected money movement', result.ledger?.created ? 'positive' : 'warning')}
        ${proofRow('Transaction type', esc(result.ledger?.type || 'none'), 'Expected ledger type')}
        ${proofRow('Account delta', result.ledger?.account_delta == null ? '0' : String(result.ledger.account_delta), 'Ledger-derived impact')}
      `;

      if (dryRun) {
        setFloatingProof(proof);
        toast('Debt dry-run passed.');
        return;
      }

      closeFloatingForm();
      setProof('Debt saved', proof);
      toast(result.ledger?.created ? 'Debt saved with ledger movement.' : 'Debt saved without money movement.');

      await loadDebts();

      const nextId = result.debt?.id || result.id;
      if (nextId) selectDebt(nextId);
    } catch (err) {
      toast(`Debt create failed: ${err.message}`);
      setFloatingProof(proofRow('Create failed', esc(err.message), 'Backend rejected request', 'danger'));
    }
  }

  function paymentAccountOptions(selectedValue) {
  return accountOptions(selectedValue, 'Choose payment account…');
}

  function updatePaymentButtons() {
  const amount = num($('floatingPaymentAmountInput')?.value);
  const accountId = clean($('floatingPaymentAccountInput')?.value);
  const disabled = !amount || amount <= 0 || !accountId || !state.accounts.length || state.accountsLoading || Boolean(state.accountsError);

  ['floatingPaymentDryRunBtn', 'floatingPaymentSaveBtn'].forEach(id => {
    const button = $(id);
    if (button) button.disabled = disabled;
  });
}

  function openPaymentForm(id) {
  const debt = findDebtById(id);

  if (!debt) {
    toast(`Debt not loaded: ${id}`);
    return;
  }

  selectDebt(debt.id);

  if (!state.accounts.length && !state.accountsLoading) {
    void loadAccounts(true);
  }

  const defaultNotes = debt.kind === 'owe'
    ? `${debt.name} · debt repayment`
    : `${debt.name} · debt received`;

  const actionLabel = debt.kind === 'owe' ? 'Record payment' : 'Record money received';
  const accountLabel = debt.kind === 'owe' ? 'Paid from' : 'Received into';
  const amountLabel = debt.kind === 'owe' ? 'Amount paid' : 'Amount received';

  const accountHelp = state.accounts.length
    ? 'Choose the account this money moved through.'
    : (state.accountsError || (state.accountsLoading ? 'Accounts are loading…' : 'Accounts are still loading. Wait a moment before saving.'));

  const accountDisabled = state.accounts.length && !state.accountsError && !state.accountsLoading ? '' : 'disabled';

  const body = `
    <div class="sf-debt-pay-card">
      <div class="sf-debt-pay-summary">
        <div>
          <p class="sf-section-kicker">${esc(kindLabel(debt.kind))}</p>
          <h3 class="sf-section-title">${esc(debt.name)}</h3>
          <p class="sf-section-subtitle">Remaining balance: ${money(debt.remaining_amount)}</p>
        </div>

        <div class="sf-debt-pay-amount">
          <span>Remaining</span>
          <strong>${money(debt.remaining_amount)}</strong>
        </div>
      </div>

      <form class="sf-form-grid sf-debt-pay-form">
        <input id="floatingPaymentDebtIdInput" type="hidden" value="${esc(debt.id)}">

        <label class="sf-field">
          <span class="sf-label">${esc(amountLabel)}</span>
          <input
            class="sf-input"
            id="floatingPaymentAmountInput"
            type="number"
            step="0.01"
            min="0"
            value="${esc(debt.installment_amount || debt.remaining_amount || '')}"
            autocomplete="off"
          >
        </label>

        <label class="sf-field">
          <span class="sf-label">Payment date</span>
          <input class="sf-input" id="floatingPaymentDateInput" type="date" value="${todayISO()}">
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">${esc(accountLabel)}</span>
          <select class="sf-select" id="floatingPaymentAccountInput" ${accountDisabled}>
            ${paymentAccountOptions('')}
          </select>
          <p class="sf-field-help" id="floatingPaymentAccountHelp">${esc(accountHelp)}</p>
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Note</span>
          <textarea class="sf-textarea" id="floatingPaymentNotesInput">${esc(defaultNotes)}</textarea>
        </label>

        <div class="sf-debt-pay-help sf-field--wide">
          Run dry-run first to confirm the ledger impact before saving.
        </div>

        <div class="sf-section-actions sf-field--wide">
          <button class="sf-button" id="floatingPaymentDryRunBtn" type="button" data-floating-action="payment-dry-run" disabled>Dry-run</button>
          <button class="sf-button sf-button--primary" id="floatingPaymentSaveBtn" type="button" data-floating-action="payment-save" disabled>Save payment</button>
        </div>
      </form>

      <div id="floatingProofPanel" class="sf-debt-pay-proof">
        <div class="sf-empty-state">Dry-run proof will appear here.</div>
      </div>
    </div>
  `;

  openFloatingForm(actionLabel, 'Confirm the account and amount before saving.', body, { width: '620px' });

  $('floatingPaymentAmountInput')?.addEventListener('input', updatePaymentButtons);
  $('floatingPaymentAccountInput')?.addEventListener('change', updatePaymentButtons);

  updatePaymentButtons();

  if (!state.accounts.length && !state.accountsLoading) {
    loadAccounts(true).then(() => {
      refreshAccountSelects();
      updatePaymentButtons();
    });
  }
}

  function buildPaymentPayload() {
    const debtId = clean($('floatingPaymentDebtIdInput')?.value) || state.selectedDebtId;
    const debt = findDebtById(debtId);
    const amount = num($('floatingPaymentAmountInput')?.value);
    const accountId = clean($('floatingPaymentAccountInput')?.value);
    const date = clean($('floatingPaymentDateInput')?.value) || todayISO();

    if (!debt) return { ok: false, error: `Selected debt is not loaded: ${debtId}` };
    if (!amount || amount <= 0) return { ok: false, error: 'Payment amount must be greater than 0.' };
    if (!accountId) return { ok: false, error: 'Select payment account.' };

    return {
      ok: true,
      debt,
      payload: {
        action: 'payment',
        debt_id: debt.id,
        amount,
        date,
        account_id: accountId,
        notes: clean($('floatingPaymentNotesInput')?.value),
        idempotency_key: `debtpay_${debt.id}_${bodySafeDate()}_${amount.toFixed(2)}_${safeIdPart(accountId)}`,
        created_by: VERSION
      }
    };
  }

  async function submitPayment(dryRun) {
    const built = buildPaymentPayload();

    if (!built.ok) {
      toast(built.error);
      setFloatingProof(proofRow('Validation failed', esc(built.error), 'Fix payment fields', 'danger'));
      return;
    }

    const { debt, payload } = built;

    toast(dryRun ? 'Running payment dry-run…' : 'Saving payment…');

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? '?dry_run=1' : ''}`, payload);

      const proof = `
        ${proofRow(dryRun ? 'Dry-run' : 'Payment saved', dryRun ? 'Passed' : 'Committed', 'Backend validation', 'positive')}
        ${proofRow('Transaction type', esc(result.ledger?.type || '—'), 'Ledger impact', result.ledger?.type === 'income' ? 'positive' : 'danger')}
        ${proofRow('Account delta', result.ledger?.account_delta == null ? '—' : String(result.ledger.account_delta), 'Account movement')}
        ${proofRow('Paid after', money(result.proof?.paid_amount_after || result.debt?.paid_amount || 0), 'Debt state')}
        ${proofRow('Remaining after', money(result.proof?.remaining_after || result.debt?.remaining_amount || 0), 'Debt balance')}
        ${proofRow('Status after', esc(result.proof?.status_after || result.debt?.status || '—'), 'Debt status', tone(result.proof?.status_after || result.debt?.status))}
      `;

      if (dryRun) {
        setFloatingProof(proof);
        toast('Payment dry-run passed.');
        return;
      }

      closeFloatingForm();

      setProof('Payment saved', `
        ${proof}
        ${proofRow('Payment ID', esc(result.payment_id || result.payment?.payment_id || '—'), 'Debt payment record')}
        ${proofRow('Ledger transaction', esc(result.payment_transaction_id || result.ledger?.transaction_id || '—'), 'Linked transaction row')}
      `);

      toast('Payment saved.');
      await loadDebts();
      selectDebt(debt.id);
    } catch (err) {
      toast(`Payment failed: ${err.message}`);

      setFloatingProof(`
        ${proofRow('Payment failed', esc(err.message), 'Backend rejected payment', 'danger')}
        ${proofRow('Amount', money(payload.amount), 'Attempted amount')}
        ${proofRow('Account', esc(payload.account_id), 'Attempted account')}
      `);
    }
  }

  function openEditForm(id) {
    const debt = findDebtById(id);

    if (!debt) {
      toast(`Debt not loaded: ${id}`);
      return;
    }

    selectDebt(debt.id);

    const body = `
      <form class="sf-form-grid">
        <label class="sf-field">
          <span>Due date</span>
          <input class="sf-input" id="floatingEditDueDateInput" type="date" value="${esc(debt.due_date || '')}">
        </label>

        <label class="sf-field">
          <span>Due day</span>
          <input class="sf-input" id="floatingEditDueDayInput" type="number" min="1" max="31" value="${esc(debt.due_day || '')}">
        </label>

        <label class="sf-field">
          <span>Installment amount</span>
          <input class="sf-input" id="floatingEditInstallmentInput" type="number" step="0.01" min="0" value="${esc(debt.installment_amount || '')}">
        </label>

        <label class="sf-field">
          <span>Frequency</span>
          <select class="sf-select" id="floatingEditFrequencyInput">
            ${['monthly', 'weekly', 'yearly', 'custom'].map(f => `<option value="${f}" ${debt.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </label>

        <label class="sf-field sf-field--wide">
          <span>Notes</span>
          <textarea class="sf-textarea" id="floatingEditNotesInput">${esc(debt.notes || '')}</textarea>
        </label>

        <div class="sf-section-actions sf-field--wide">
          <button class="sf-button sf-button--primary" type="button" data-floating-action="edit-save">Save changes</button>
        </div>
      </form>

      <div id="floatingProofPanel" class="sf-debt-proof-card"></div>
    `;

    openFloatingForm(`${debt.name} · Edit`, 'Update schedule/details only. No money movement.', body, { width: '680px' });
  }

  async function submitEdit() {
    const debt = selectedDebt();

    if (!debt) {
      toast('No debt selected.');
      return;
    }

    try {
      await putJSON(`${API_DEBTS}/${encodeURIComponent(debt.id)}`, {
        due_date: clean($('floatingEditDueDateInput')?.value) || null,
        due_day: clean($('floatingEditDueDayInput')?.value) || null,
        installment_amount: clean($('floatingEditInstallmentInput')?.value) || null,
        frequency: $('floatingEditFrequencyInput')?.value || 'custom',
        notes: clean($('floatingEditNotesInput')?.value)
      });

      closeFloatingForm();
      setProof('Edit saved', proofRow('Edit saved', 'Committed', 'Backend accepted schedule/details update', 'positive'));

      toast('Debt schedule updated.');
      await loadDebts();
      selectDebt(debt.id);
    } catch (err) {
      toast(`Edit failed: ${err.message}`);
      setFloatingProof(proofRow('Edit failed', esc(err.message), 'Backend rejected update', 'danger'));
    }
  }

  function openDeferForm(id) {
    const debt = findDebtById(id);

    if (!debt) {
      toast(`Debt not loaded: ${id}`);
      return;
    }

    selectDebt(debt.id);

    const body = `
      <form class="sf-form-grid">
        <label class="sf-field">
          <span>New due date</span>
          <input class="sf-input" id="floatingDeferDueDateInput" type="date" value="${esc(debt.due_date || '')}">
        </label>

        <label class="sf-field">
          <span>New due day</span>
          <input class="sf-input" id="floatingDeferDueDayInput" type="number" min="1" max="31" value="${esc(debt.due_day || '')}">
        </label>

        <label class="sf-field sf-field--wide">
          <span>Notes</span>
          <textarea class="sf-textarea" id="floatingDeferNotesInput">${esc(debt.notes || '')}</textarea>
        </label>

        <div class="sf-section-actions sf-field--wide">
          <button class="sf-button sf-button--primary" type="button" data-floating-action="defer-save">Save defer</button>
        </div>
      </form>

      <div id="floatingProofPanel" class="sf-debt-proof-card"></div>
    `;

    openFloatingForm(`${debt.name} · Defer`, 'Schedule only. No ledger movement.', body, { width: '640px' });
  }

  async function submitDefer() {
    const debt = selectedDebt();

    if (!debt) {
      toast('No debt selected.');
      return;
    }

    try {
      await putJSON(`${API_DEBTS}/${encodeURIComponent(debt.id)}`, {
        action: 'defer',
        due_date: clean($('floatingDeferDueDateInput')?.value) || null,
        due_day: clean($('floatingDeferDueDayInput')?.value) || null,
        notes: clean($('floatingDeferNotesInput')?.value)
      });

      closeFloatingForm();
      setProof('Debt deferred', proofRow('Debt deferred', 'Committed', 'Backend accepted schedule update', 'positive'));

      toast('Debt deferred.');
      await loadDebts();
      selectDebt(debt.id);
    } catch (err) {
      toast(`Defer failed: ${err.message}`);
      setFloatingProof(proofRow('Defer failed', esc(err.message), 'Backend rejected update', 'danger'));
    }
  }

  function updateRepairButtons() {
    const accountId = clean($('floatingRepairAccountInput')?.value);
    const disabled = !accountId || !state.accounts.length;

    ['floatingRepairDryRunBtn', 'floatingRepairSaveBtn'].forEach(id => {
      const button = $(id);
      if (button) button.disabled = disabled;
    });
  }

  function openRepairForm(id) {
    const debt = findDebtById(id);

    if (!debt) {
      toast(`Debt not loaded: ${id}`);
      return;
    }

    selectDebt(debt.id);

    const rule = debt.kind === 'owed'
      ? 'Select the account money originally left from.'
      : 'Select the account money originally entered into.';

    const body = `
      <div class="sf-debt-pay-help">${esc(rule)}</div>

      <form class="sf-form-grid">
        <label class="sf-field">
          <span>Correct account</span>
          <select class="sf-select" id="floatingRepairAccountInput" ${state.accounts.length ? '' : 'disabled'}>
            ${accountOptions('', 'Choose account…')}
          </select>
        </label>

        <label class="sf-field">
          <span>Movement date</span>
          <input class="sf-input" id="floatingRepairDateInput" type="date" value="${todayISO()}">
        </label>

        <div class="sf-section-actions sf-field--wide">
          <button class="sf-button" id="floatingRepairDryRunBtn" type="button" data-floating-action="repair-dry-run" disabled>Dry-run</button>
          <button class="sf-button sf-button--primary" id="floatingRepairSaveBtn" type="button" data-floating-action="repair-save" disabled>Commit repair</button>
        </div>
      </form>

      <div id="floatingProofPanel" class="sf-debt-proof-card">
        <div class="sf-empty-state">Repair proof will appear here.</div>
      </div>
    `;

    openFloatingForm(`${debt.name} · Repair origin`, 'Explicit origin ledger repair only.', body, { width: '620px' });

    $('floatingRepairAccountInput')?.addEventListener('change', updateRepairButtons);
    updateRepairButtons();
  }

  async function submitRepair(dryRun) {
    const debt = selectedDebt();

    if (!debt) {
      toast('No debt selected.');
      return;
    }

    const accountId = clean($('floatingRepairAccountInput')?.value);

    if (!accountId) {
      toast('Select account first.');
      setFloatingProof(proofRow('Validation failed', 'Select account first.', 'Repair account required', 'danger'));
      return;
    }

    const body = {
      action: 'repair_ledger',
      debt_id: debt.id,
      account_id: accountId,
      date: clean($('floatingRepairDateInput')?.value) || todayISO(),
      idempotency_key: `debt_repair_${debt.id}_${bodySafeDate()}`,
      created_by: VERSION
    };

    toast(dryRun ? 'Running repair dry-run…' : 'Committing repair…');

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? '?dry_run=1' : ''}`, body);

      const proof = `
        ${proofRow(dryRun ? 'Dry-run repair' : 'Repair committed', result.ok ? 'OK' : 'Failed', 'Backend result', result.ok ? 'positive' : 'danger')}
        ${proofRow('Ledger transaction', esc(result.ledger?.transaction_id || result.origin_transaction_id || 'pending'), 'Origin movement row')}
        ${proofRow('Writes performed', String(Boolean(result.writes_performed)), 'Backend truth', result.writes_performed ? 'positive' : 'warning')}
        ${proofRow('Source action', esc(result.ledger?.source_action || 'repair_origin'), 'Structured source')}
      `;

      if (dryRun) {
        setFloatingProof(proof);
        toast('Repair dry-run passed.');
        return;
      }

      closeFloatingForm();
      setProof('Repair committed', proof);

      toast('Repair committed.');
      await loadDebts();
      selectDebt(debt.id);
    } catch (err) {
      toast(`Repair failed: ${err.message}`);
      setFloatingProof(proofRow('Repair failed', esc(err.message), 'Backend rejected repair', 'danger'));
    }
  }

  function handlePageClick(event) {
    const button = event.target.closest('button, a');
    if (!button) return;

    const floatingAction = button.getAttribute('data-floating-action');

    if (floatingAction) {
      event.preventDefault();

      if (floatingAction === 'create-dry-run') submitCreate(true);
      else if (floatingAction === 'create-save') submitCreate(false);
      else if (floatingAction === 'payment-dry-run') submitPayment(true);
      else if (floatingAction === 'payment-save') submitPayment(false);
      else if (floatingAction === 'edit-save') submitEdit();
      else if (floatingAction === 'defer-save') submitDefer();
      else if (floatingAction === 'repair-dry-run') submitRepair(true);
      else if (floatingAction === 'repair-save') submitRepair(false);

      return;
    }

    const filter = button.getAttribute('data-filter');

    if (filter) {
      event.preventDefault();
      setFilter(filter);
      return;
    }

    const id = button.id || '';

    if (id === 'addDebtBtn' || id === 'newDebtBtn') {
      event.preventDefault();
      openCreateForm();
      return;
    }

    if (id === 'refreshDebtsBtn' || id === 'reloadDebtsBtn') {
      event.preventDefault();
      loadDebts();
      return;
    }

    const rowAction = button.getAttribute('data-action');
    const debtId = button.getAttribute('data-debt-id');

    if (!rowAction || !debtId) return;

    event.preventDefault();

    if (rowAction === 'details') selectDebt(debtId);
    else if (rowAction === 'edit') openEditForm(debtId);
    else if (rowAction === 'payment') openPaymentForm(debtId);
    else if (rowAction === 'defer') openDeferForm(debtId);
    else if (rowAction === 'repair') openRepairForm(debtId);
  }

  function wireEvents() {
    if (document._sovereignDebtsEndUserBound) return;
    document._sovereignDebtsEndUserBound = true;

    document.addEventListener('click', handlePageClick);
  }

  function toast(message) {
    const el = $('debtToast');

    if (!el) {
      console.log(message);
      return;
    }

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function init() {
    wireEvents();
    loadDebts();

    window.SovereignDebts = {
      version: VERSION,
      reload: loadDebts,
      state: () => JSON.parse(JSON.stringify(state)),
      openPaymentForm,
      closeFloatingForm,
      submitPayment
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();