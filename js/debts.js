/* js/debts.js
 * Sovereign Finance · Debts UI
 * v0.8.0-shared-shell-rows
 *
 * Rules:
 * - No injected CSS.
 * - No custom debt row grid.
 * - No stale money routes.
 * - Canonical create/payment/repair route: POST /api/debts
 * - Canonical schedule/status update route: PUT /api/debts/:id
 * - Health route: GET /api/debts?action=health
 */

(function () {
  'use strict';

  const VERSION = 'v0.8.0-shared-shell-rows';

  const API_DEBTS = '/api/debts';
  const API_DEBTS_HEALTH = '/api/debts?action=health';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
    debts: [],
    accounts: [],
    lastPayload: null,
    health: null,
    selectedDebtId: null,
    filter: 'active',
    search: '',
    sort: 'due',
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

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
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

  function kindLabel(kind) {
    return kind === 'owed' ? 'Owed to me' : 'I owe';
  }

  function kindBucket(kind) {
    return kind === 'owed' ? 'Receivable' : 'Payable';
  }

  function tone(value) {
    const s = String(value || '').toLowerCase();

    if (['pass', 'ok', 'active', 'settled', 'linked', 'scheduled', 'paid_off'].includes(s)) return 'positive';
    if (['warn', 'paused', 'due_today', 'due_soon', 'no_schedule', 'payment_linked_only'].includes(s)) return 'warning';
    if (['overdue', 'failed', 'danger', 'blocked', 'ledger_missing'].includes(s)) return 'danger';

    return '';
  }

  function pill(text, toneName) {
    const cls = ['sf-pill'];
    if (toneName) cls.push(`sf-tone-${toneName}`);

    return `<span class="${cls.join(' ')}">${esc(text)}</span>`;
  }

  function fieldRow(label, sub, value, toneName) {
    const valueClass = toneName ? ` sf-tone-${toneName}` : '';

    return `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(label)}</div>
          ${sub ? `<div class="sf-row-subtitle">${esc(sub)}</div>` : ''}
        </div>
        <div class="sf-row-right${valueClass}">${value == null ? '—' : value}</div>
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

  function selectedDebt() {
    return state.debts.find(debt => String(debt.id) === String(state.selectedDebtId)) || null;
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

  function accountRowsFromPayload(payload) {
    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (payload.accounts && typeof payload.accounts === 'object') return Object.values(payload.accounts);
    if (payload.accounts_by_id && typeof payload.accounts_by_id === 'object') return Object.values(payload.accounts_by_id);
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

    renderAccountOptions();
  }

  async function loadDebts() {
    if (state.loading) return;

    state.loading = true;
    setHTML('debtList', `<div class="sf-empty-state">Loading debts…</div>`);

    try {
      await loadAccounts();

      const payload = await fetchJSON(API_DEBTS);
      state.lastPayload = payload;
      state.debts = (Array.isArray(payload.debts) ? payload.debts : []).map(normalizeDebt);

      try {
        state.health = await fetchJSON(API_DEBTS_HEALTH);
      } catch {
        state.health = null;
      }

      renderAll();
    } catch (err) {
      setHTML('debtList', `<div class="sf-empty-state">Failed to load debts: ${esc(err.message)}</div>`);
      setText('metricHealth', 'failed');
      renderDebug({ error: err.message });
    } finally {
      state.loading = false;
    }
  }

  function renderAccountOptions() {
    const ids = ['debtAccountInput', 'paymentAccountInput', 'repairAccountInput'];

    const options = ['<option value="">Select account…</option>'].concat(
      state.accounts.map(account => {
        const id = account.id || account.account_id;
        const name = account.name || account.label || id;
        const balance = account.balance ?? account.current_balance ?? account.amount ?? 0;
        const kind = account.type || account.kind || 'account';

        return `<option value="${esc(id)}">${esc(name)} · ${esc(kind)} · ${money(balance)}</option>`;
      })
    ).join('');

    ids.forEach(id => {
      const select = $(id);
      if (!select) return;

      const current = select.value;
      select.innerHTML = options;
      if (current) select.value = current;
    });
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
      <article class="sf-finance-row ${selected ? 'is-selected' : ''}" data-debt-id="${esc(debt.id)}">
        <button class="sf-row-left" type="button" data-select-debt="${esc(debt.id)}">
          <div class="sf-row-title">${esc(debt.name)}</div>
          <div class="sf-row-subtitle">${esc(subtitleForDebt(debt))}</div>
          <div class="sf-section-actions">
            ${pill(kindLabel(debt.kind), debt.kind === 'owed' ? 'positive' : 'danger')}
            ${pill(statusLabel(debt), tone(statusLabel(debt)))}
            ${pill(originLabel(debt), originTone)}
            ${debt.due_status ? pill(debt.due_status.replace(/_/g, ' '), tone(debt.due_status)) : ''}
            ${pill(`${pct}% paid`, pct >= 100 ? 'positive' : 'warning')}
          </div>
        </button>

        <div class="sf-row-right">
          <div class="sf-metric-value">${money(debt.remaining_amount)}</div>
          <div class="sf-card-subtitle">Remaining</div>
          <div class="sf-section-actions">
            <button class="sf-button" type="button" data-select-debt="${esc(debt.id)}">Details</button>
            <button class="sf-button" type="button" data-edit-debt="${esc(debt.id)}">Edit</button>
            <button class="sf-button sf-button--primary" type="button" data-pay-debt="${esc(debt.id)}">Payment</button>
            <button class="sf-button" type="button" data-defer-debt="${esc(debt.id)}">Defer</button>
            ${(debt.repair_required || (debt.origin_required && !debt.origin_linked))
              ? `<button class="sf-button" type="button" data-repair-debt="${esc(debt.id)}">Repair</button>`
              : ''}
          </div>
        </div>
      </article>
    `;
  }

  function renderDebtList() {
    const list = $('debtList');
    if (!list) return;

    const rows = filteredDebts();

    list.innerHTML = rows.length
      ? rows.map(renderDebtRow).join('')
      : `<div class="sf-empty-state">No debts match this filter.</div>`;

    bindDebtRowActions();
  }

  function bindDebtRowActions() {
    document.querySelectorAll('[data-select-debt]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selectDebt(button.getAttribute('data-select-debt'));
      });
    });

    document.querySelectorAll('[data-edit-debt]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openEditPanel(button.getAttribute('data-edit-debt'));
      });
    });

    document.querySelectorAll('[data-pay-debt]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openPaymentModal(button.getAttribute('data-pay-debt'));
      });
    });

    document.querySelectorAll('[data-defer-debt]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openDeferModal(button.getAttribute('data-defer-debt'));
      });
    });

    document.querySelectorAll('[data-repair-debt]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        openRepairPanel(button.getAttribute('data-repair-debt'));
      });
    });
  }

  function selectDebt(id) {
    state.selectedDebtId = id;

    document.querySelectorAll('[data-debt-id]').forEach(row => {
      row.classList.toggle('is-selected', row.getAttribute('data-debt-id') === String(id));
    });

    renderSelectedDebt();
    renderDebug();
  }

  function renderSelectedDebt() {
    const debt = selectedDebt();

    if (!debt) {
      setText('selectedDebtTitle', 'No debt selected');
      setText('selectedDebtSub', 'Select a debt to inspect schedule, linked ledger rows, and repair options.');
      setHTML('selectedDebtPanel', `<div class="sf-empty-state">No debt selected.</div>`);
      return;
    }

    setText('selectedDebtTitle', debt.name);
    setText('selectedDebtSub', `${kindLabel(debt.kind)} · ${debt.id}`);

    setHTML('selectedDebtPanel', `
      ${fieldRow('Kind', 'Debt direction', kindLabel(debt.kind), debt.kind === 'owed' ? 'positive' : 'danger')}
      ${fieldRow('Original amount', 'Principal', money(debt.original_amount))}
      ${fieldRow('Paid amount', 'Backend paid amount', money(debt.paid_amount))}
      ${fieldRow('Remaining', 'Backend remaining amount', money(debt.remaining_amount), debt.remaining_amount > 0 ? 'warning' : 'positive')}
      ${fieldRow('Status', 'Debt row status', esc(debt.status || 'active'), tone(debt.status))}
      ${fieldRow('Due status', 'Schedule state', esc(debt.due_status || 'no schedule'), tone(debt.due_status))}
      ${fieldRow('Next due', 'Computed due date', esc(formatDate(debt.next_due_date || debt.due_date)))}
      ${fieldRow('Origin state', 'Ledger origin classifier', esc(originLabel(debt)), debt.origin_linked ? 'positive' : ((debt.repair_required || debt.origin_required) ? 'danger' : 'warning'))}
      ${fieldRow('Origin ledger IDs', 'Linked origin transaction IDs', esc(debt.origin_transaction_ids.length ? debt.origin_transaction_ids.join(', ') : 'None'))}
      ${fieldRow('Payment ledger IDs', 'Linked payment transaction IDs', esc(debt.payment_transaction_ids.length ? debt.payment_transaction_ids.join(', ') : 'None'))}
      ${fieldRow('Created', 'Debt created timestamp', esc(formatDateTime(debt.created_at)))}
      ${debt.notes ? fieldRow('Notes', 'Backend notes', esc(debt.notes)) : ''}
    `);
  }

  function renderEnforcement() {
    setHTML('debtEnforcementPanel', `
      ${fieldRow('Canonical backend', 'Money owner', 'POST /api/debts', 'positive')}
      ${fieldRow('Create action', 'Create debt record', 'action=create')}
      ${fieldRow('Payment action', 'Pay/receive through one route', 'action=payment', 'positive')}
      ${fieldRow('Owe payment', 'User pays someone back', '[DEBT_PAYMENT] · expense', 'danger')}
      ${fieldRow('Owed receive', 'Someone pays user back', '[DEBT_RECEIVE] · income', 'positive')}
      ${fieldRow('Repair action', 'Explicit only', 'action=repair_ledger', 'warning')}
      ${fieldRow('Reversal owner', 'Do not reverse from Debts stale route', 'POST /api/transactions/reverse', 'warning')}
    `);
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

    const filterRow = document.querySelector('.debt-filter-row') || document.querySelector('.sf-section-actions');
    if (!filterRow) return;

    const controls = document.createElement('div');
    controls.className = 'sf-section-actions';
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

  function wireFilters() {
    document.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => setFilter(button.getAttribute('data-filter')));
    });
  }

  function openModal(id) {
    const el = $(id);
    if (el) el.hidden = false;
  }

  function closeModal(id) {
    const el = $(id);
    if (el) el.hidden = true;
  }

  function resetDebtForm() {
    const form = $('addDebtForm');
    if (form) form.reset();

    const paid = $('debtPaidInput');
    if (paid) paid.value = '0';

    const movement = $('debtMovementNowInput');
    if (movement) movement.checked = false;

    const date = $('debtMovementDateInput');
    if (date) date.value = todayISO();
  }

  function openDebtModal() {
    resetDebtForm();
    renderAccountOptions();
    updateDebtMovementCopy();
    openModal('debtModal');
  }

  function updateDebtMovementCopy() {
    const kind = $('debtKindInput')?.value || 'owed';
    const movement = $('debtMovementNowInput');
    const account = $('debtAccountInput');
    const copy = $('debtMovementCopy');

    if (copy) {
      copy.textContent = kind === 'owed'
        ? 'Owed to me means money leaves the selected account now.'
        : 'I owe means money enters the selected account now.';
    }

    const enabled = movement ? movement.checked : false;
    if (account) account.disabled = !enabled;
  }

  function buildDebtCreatePayload() {
    const movementNow = Boolean($('debtMovementNowInput')?.checked);
    const kindValue = $('debtKindInput')?.value || 'owed';

    return {
      action: 'create',
      name: clean($('debtNameInput')?.value),
      kind: kindValue,
      original_amount: num($('debtOriginalInput')?.value),
      paid_amount: num($('debtPaidInput')?.value),
      due_date: clean($('debtDueDateInput')?.value) || null,
      due_day: clean($('debtDueDayInput')?.value) || null,
      installment_amount: clean($('debtInstallmentInput')?.value) || null,
      frequency: $('debtFrequencyInput')?.value || 'monthly',
      status: $('debtStatusInput')?.value || 'active',
      snowball_order: clean($('debtSnowballInput')?.value) || null,
      movement_now: movementNow,
      account_id: movementNow ? clean($('debtAccountInput')?.value) : '',
      movement_date: clean($('debtMovementDateInput')?.value) || todayISO(),
      notes: clean($('debtNotesInput')?.value),
      idempotency_key: `debt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

  async function dryRunDebtCreate() {
    const payload = buildDebtCreatePayload();
    const error = validateDebtCreatePayload(payload);

    if (error) {
      toast(error);
      return;
    }

    try {
      const result = await postJSON(`${API_DEBTS}?dry_run=1`, payload);

      setHTML('debtActionPanel', `
        ${fieldRow('Dry-run', 'Debt create validation', result.ok ? 'Passed' : 'Failed', result.ok ? 'positive' : 'danger')}
        ${fieldRow('Contract', 'Backend version', esc(result.contract_version || '—'))}
        ${fieldRow('Ledger created', 'Expected money movement', String(Boolean(result.ledger?.created)), result.ledger?.created ? 'positive' : 'warning')}
        ${fieldRow('Transaction type', 'Expected ledger type', esc(result.ledger?.type || 'none'))}
        ${fieldRow('Account delta', 'Ledger-derived account impact', result.ledger?.account_delta == null ? '0' : String(result.ledger.account_delta))}
      `);

      toast('Debt dry-run passed.');
    } catch (err) {
      toast(`Dry-run failed: ${err.message}`);
    }
  }

  async function saveNewDebt() {
    const payload = buildDebtCreatePayload();
    const error = validateDebtCreatePayload(payload);

    if (error) {
      toast(error);
      return;
    }

    const button = $('saveDebtBtn');

    if (button) {
      button.disabled = true;
      button.textContent = 'Saving…';
    }

    try {
      const result = await postJSON(API_DEBTS, payload);

      toast(result.ledger?.created
        ? 'Debt saved with ledger movement.'
        : 'Debt saved without money movement.');

      closeModal('debtModal');
      await loadDebts();

      if (result.debt?.id || result.id) selectDebt(result.debt?.id || result.id);
    } catch (err) {
      toast(`Debt save failed: ${err.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Save Debt';
      }
    }
  }

  function openEditPanel(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    renderSelectedDebt();

    setHTML('debtActionPanel', `
      <form class="sf-form-grid">
        ${fieldRow('Amount', 'Amount mutation blocked in UI until backend supports safe principal correction.', money(debt.original_amount), 'warning')}

        <label class="sf-field">
          <span>Due Date</span>
          <input class="sf-input" id="editDueDateInput" type="date" value="${esc(debt.due_date || '')}">
        </label>

        <label class="sf-field">
          <span>Due Day</span>
          <input class="sf-input" id="editDueDayInput" type="number" min="1" max="31" value="${esc(debt.due_day || '')}">
        </label>

        <label class="sf-field">
          <span>Installment Amount</span>
          <input class="sf-input" id="editInstallmentInput" type="number" step="0.01" min="0" value="${esc(debt.installment_amount || '')}">
        </label>

        <label class="sf-field">
          <span>Frequency</span>
          <select class="sf-select" id="editFrequencyInput">
            ${['monthly', 'weekly', 'yearly', 'custom'].map(f => `<option value="${f}" ${debt.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </label>

        <label class="sf-field">
          <span>Notes</span>
          <textarea class="sf-textarea" id="editNotesInput">${esc(debt.notes || '')}</textarea>
        </label>

        <div class="sf-section-actions">
          <button class="sf-button sf-button--primary" type="button" id="saveDebtEditBtn">Save Edit</button>
        </div>
      </form>
    `);

    $('saveDebtEditBtn')?.addEventListener('click', () => submitEditDebt(id));
  }

  async function submitEditDebt(id) {
    try {
      await putJSON(`${API_DEBTS}/${encodeURIComponent(id)}`, {
        due_date: clean($('editDueDateInput')?.value) || null,
        due_day: clean($('editDueDayInput')?.value) || null,
        installment_amount: clean($('editInstallmentInput')?.value) || null,
        frequency: $('editFrequencyInput')?.value || 'custom',
        notes: clean($('editNotesInput')?.value)
      });

      toast('Debt schedule updated.');
      await loadDebts();
      selectDebt(id);
    } catch (err) {
      setHTML('debtActionPanel', `<div class="sf-empty-state">Edit failed: ${esc(err.message)}</div>`);
    }
  }

  function openRepairPanel(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    renderSelectedDebt();
    renderAccountOptions();

    const rule = debt.kind === 'owed'
      ? 'Owed to me: select the account money originally left from.'
      : 'I owe: select the account money originally entered into.';

    setHTML('debtActionPanel', `
      <form class="sf-form-grid">
        ${fieldRow('Debt', debt.id, `${esc(debt.name)} · ${money(debt.original_amount)}`)}
        ${fieldRow('Repair rule', rule, debt.kind === 'owed' ? 'expense origin' : 'income origin', debt.kind === 'owed' ? 'danger' : 'positive')}

        <label class="sf-field">
          <span>Correct Account</span>
          <select class="sf-select" id="repairAccountInput">
            <option value="">Select account…</option>
          </select>
        </label>

        <label class="sf-field">
          <span>Movement Date</span>
          <input class="sf-input" id="repairDateInput" type="date" value="${todayISO()}">
        </label>

        <div class="sf-section-actions">
          <button class="sf-button" type="button" id="dryRunRepairBtn">Dry-run Repair</button>
          <button class="sf-button sf-button--primary" type="button" id="commitRepairBtn">Commit Repair</button>
        </div>
      </form>
    `);

    renderAccountOptions();

    $('dryRunRepairBtn')?.addEventListener('click', () => submitRepairLedger(id, true));
    $('commitRepairBtn')?.addEventListener('click', () => submitRepairLedger(id, false));
  }

  async function submitRepairLedger(id, dryRun) {
    const accountId = clean($('repairAccountInput')?.value);

    if (!accountId) {
      toast('Select account first.');
      return;
    }

    const body = {
      action: 'repair_ledger',
      debt_id: id,
      account_id: accountId,
      date: clean($('repairDateInput')?.value) || todayISO(),
      idempotency_key: `debt_repair_${id}_${Date.now()}`,
      created_by: VERSION
    };

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? '?dry_run=1' : ''}`, body);

      setHTML('debtActionPanel', `
        ${fieldRow(dryRun ? 'Dry-run repair' : 'Repair committed', 'Backend result', result.ok ? 'OK' : 'Failed', result.ok ? 'positive' : 'danger')}
        ${fieldRow('Ledger transaction', 'Origin movement row', esc(result.ledger?.transaction_id || result.origin_transaction_id || 'pending'))}
        ${fieldRow('Writes performed', 'Backend truth', String(Boolean(result.writes_performed)), result.writes_performed ? 'positive' : 'warning')}
        ${fieldRow('Source action', 'Structured source', esc(result.ledger?.source_action || 'repair_origin'))}
      `);

      toast(dryRun ? 'Repair dry-run passed.' : 'Repair committed.');

      if (!dryRun) {
        await loadDebts();
        selectDebt(id);
      }
    } catch (err) {
      setHTML('debtActionPanel', `<div class="sf-empty-state">Repair failed: ${esc(err.message)}</div>`);
    }
  }

  function openPaymentModal(id) {
    const debt = findDebtById(id);

    if (!debt) {
      toast(`Cannot open payment. Debt not loaded: ${id}`);
      return;
    }

    state.selectedDebtId = debt.id;
    renderSelectedDebt();

    const hidden = $('paymentDebtIdInput');
    if (hidden) hidden.value = debt.id;

    const amountInput = $('paymentAmountInput');
    if (amountInput) amountInput.value = debt.installment_amount || debt.remaining_amount || '';

    const dateInput = $('paymentDateInput');
    if (dateInput) dateInput.value = todayISO();

    const notesInput = $('paymentNotesInput');
    if (notesInput) notesInput.value = `${debt.name} · debt payment`;

    const subtitle = document.querySelector('#paymentModal .sf-section-subtitle');
    if (subtitle) {
      subtitle.textContent = `Debt ID: ${debt.id} · ${kindLabel(debt.kind)} · remaining ${money(debt.remaining_amount)}`;
    }

    renderAccountOptions();
    openModal('paymentModal');
  }

  async function savePayment(dryRun) {
    const hiddenDebtId = clean($('paymentDebtIdInput')?.value);
    const debtId = hiddenDebtId || state.selectedDebtId;
    const debt = findDebtById(debtId);

    if (!debtId) {
      toast('No debt selected.');
      return;
    }

    if (!debt) {
      toast(`Selected debt is not loaded in UI state: ${debtId}`);
      return;
    }

    const body = {
      action: 'payment',
      debt_id: debt.id,
      amount: num($('paymentAmountInput')?.value),
      date: clean($('paymentDateInput')?.value) || todayISO(),
      account_id: clean($('paymentAccountInput')?.value),
      notes: clean($('paymentNotesInput')?.value),
      idempotency_key: `debtpay_${debt.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_by: VERSION
    };

    if (!body.amount || body.amount <= 0) {
      toast('Payment amount must be greater than 0.');
      return;
    }

    if (!body.account_id) {
      toast('Select payment account.');
      return;
    }

    const button = dryRun ? $('dryRunPaymentBtn') : $('savePaymentBtn');

    if (button) {
      button.disabled = true;
      button.textContent = dryRun ? 'Dry-running…' : 'Saving…';
    }

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? '?dry_run=1' : ''}`, body);

      if (dryRun) {
        setHTML('debtActionPanel', `
          ${fieldRow('Dry-run payment', 'Backend route', result.ok ? 'Passed' : 'Failed', result.ok ? 'positive' : 'danger')}
          ${fieldRow('Endpoint', 'Canonical route', 'POST /api/debts')}
          ${fieldRow('Marker', 'Debt transaction marker', esc(result.ledger?.marker || '—'))}
          ${fieldRow('Transaction type', 'Expected account impact', esc(result.ledger?.type || '—'), result.ledger?.type === 'income' ? 'positive' : 'danger')}
          ${fieldRow('Account delta', 'Ledger-derived account impact', result.ledger?.account_delta == null ? '—' : String(result.ledger.account_delta))}
          ${fieldRow('Paid after', 'Debt state after payment', money(result.proof?.paid_amount_after || result.debt?.paid_amount || 0))}
          ${fieldRow('Status after', 'Debt status after payment', esc(result.proof?.status_after || result.debt?.status || '—'))}
        `);

        toast('Payment dry-run passed.');
        return;
      }

      toast('Payment saved.');
      closeModal('paymentModal');
      await loadDebts();
      selectDebt(debt.id);
    } catch (err) {
      toast(`Payment failed: ${err.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = dryRun ? 'Dry-run Payment' : 'Save Payment';
      }
    }
  }

  function openDeferModal(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    const debtInput = $('deferDebtIdInput');
    const dueDate = $('deferDueDateInput');
    const dueDay = $('deferDueDayInput');
    const notes = $('deferNotesInput');

    if (debtInput) debtInput.value = id;
    if (dueDate) dueDate.value = debt.due_date || '';
    if (dueDay) dueDay.value = debt.due_day || '';
    if (notes) notes.value = debt.notes || '';

    openModal('deferModal');
  }

  async function saveDefer() {
    const id = clean($('deferDebtIdInput')?.value);

    if (!id) {
      toast('No debt selected.');
      return;
    }

    try {
      await putJSON(`${API_DEBTS}/${encodeURIComponent(id)}`, {
        due_date: clean($('deferDueDateInput')?.value) || null,
        due_day: clean($('deferDueDayInput')?.value) || null,
        notes: clean($('deferNotesInput')?.value)
      });

      toast('Debt deferred.');
      closeModal('deferModal');
      await loadDebts();
      selectDebt(id);
    } catch (err) {
      toast(`Defer failed: ${err.message}`);
    }
  }

  function wireModalButtons() {
    $('addDebtBtn')?.addEventListener('click', openDebtModal);
    $('newDebtBtn')?.addEventListener('click', openDebtModal);
    $('refreshDebtsBtn')?.addEventListener('click', loadDebts);
    $('reloadDebtsBtn')?.addEventListener('click', loadDebts);

    $('closeDebtModalBtn')?.addEventListener('click', () => closeModal('debtModal'));
    $('dryRunDebtBtn')?.addEventListener('click', dryRunDebtCreate);
    $('saveDebtBtn')?.addEventListener('click', saveNewDebt);

    $('debtKindInput')?.addEventListener('change', updateDebtMovementCopy);
    $('debtMovementNowInput')?.addEventListener('change', updateDebtMovementCopy);

    $('closePaymentModalBtn')?.addEventListener('click', () => closeModal('paymentModal'));
    $('dryRunPaymentBtn')?.addEventListener('click', () => savePayment(true));
    $('savePaymentBtn')?.addEventListener('click', () => savePayment(false));

    $('closeDeferModalBtn')?.addEventListener('click', () => closeModal('deferModal'));
    $('saveDeferBtn')?.addEventListener('click', saveDefer);
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
    wireFilters();
    wireModalButtons();

    const movementDate = $('debtMovementDateInput');
    if (movementDate && !movementDate.value) movementDate.value = todayISO();

    updateDebtMovementCopy();
    loadDebts();

    window.SovereignDebts = {
      version: VERSION,
      reload: loadDebts,
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
