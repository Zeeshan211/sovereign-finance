/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.12.0-shared-dialog-contract-ui
 *
 * Banking-grade frontend rules:
 * - No injected CSS.
 * - No page-owned modal system.
 * - Use shared sf-dialog modals from bills.html.
 * - Frontend displays backend truth only.
 * - Bill create = obligation only.
 * - Bill payment = POST /api/bills action=payment.
 * - Advance payment = selected future bill_month.
 * - Account balance remains ledger-derived.
 */

(function () {
  'use strict';

  const VERSION = 'v0.12.0-shared-dialog-contract-ui';

  const API_BILLS = '/api/bills';
  const API_BILLS_HEALTH = '/api/bills/health';
  const API_ACCOUNTS = '/api/accounts';
  const SEARCH_DEBOUNCE_MS = 180;

  const state = {
    payload: null,
    health: null,
    accounts: [],
    selectedBillId: null,
    expandedBillIds: new Set(),
    loading: false,
    lastLoadedAt: null,
    actionsBound: false,
    listActionsBound: false,
    filter: 'all',
    sort: 'due_day_asc',
    search: '',
    activeModal: null
  };

  const $ = id => document.getElementById(id);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clean(value, fallback = '') {
    return String(value == null ? fallback : value).trim();
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
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function currentMonth() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function addMonths(monthText, offset) {
    const [year, month] = String(monthText).split('-').map(Number);
    const date = new Date(year, month - 1 + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabel(monthText) {
    const [year, month] = String(monthText).split('-').map(Number);
    if (!year || !month) return monthText || '—';
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric'
    });
  }

  function nextCycleOptions(count) {
    const current = currentMonth();
    const out = [];

    for (let i = 0; i <= count; i += 1) {
      const value = addMonths(current, i);
      out.push({
        value,
        label: i === 0 ? `${monthLabel(value)} · current cycle` : `${monthLabel(value)} · advance +${i}`
      });
    }

    return out;
  }

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function pill(text, tone) {
    const cls = ['sf-pill'];
    if (tone) cls.push(`sf-pill--${tone}`);
    return `<span class="${cls.join(' ')}">${esc(text)}</span>`;
  }

  function toneForCycleStatus(status) {
    const value = String(status || '').toLowerCase();

    if (value === 'paid') return 'positive';
    if (value === 'partial') return 'warning';
    if (value === 'unpaid' || value === 'overdue') return 'danger';
    if (value === 'deleted' || value === 'archived') return 'danger';
    if (value === 'paused') return 'warning';

    return 'info';
  }

  function debounce(fn, ms) {
    let timer = null;

    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function bills() {
    return Array.isArray(state.payload?.bills) ? state.payload.bills : [];
  }

  function activeBills() {
    return bills().filter(bill => bill.status !== 'deleted' && bill.status !== 'archived');
  }

  function selectedBill() {
    return bills().find(bill => String(bill.id) === String(state.selectedBillId)) || null;
  }

  function billCycleStatus(bill) {
    return bill?.current_cycle?.status || bill?.payment_status || 'unpaid';
  }

  function dueDateForBill(bill) {
    if (bill?.due_date) return bill.due_date;

    const day = Number(bill?.due_day || 0);
    if (!day) return null;

    const [year, month] = currentMonth().split('-').map(Number);
    const maxDay = new Date(year, month, 0).getDate();
    const safeDay = Math.min(day, maxDay);

    return `${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
  }

  function daysUntilDue(bill) {
    const due = dueDateForBill(bill);
    if (!due) return null;

    const dueDate = new Date(due + 'T00:00:00');
    const today = new Date(todayISO() + 'T00:00:00');

    return Math.round((dueDate - today) / 86400000);
  }

  function dueLabel(bill) {
    const due = dueDateForBill(bill);
    if (!due) return 'no due day';

    const days = daysUntilDue(bill);
    if (days == null) return due;
    if (days === 0) return 'due today';
    if (days > 0) return `in ${days}d · ${due.slice(5)}`;

    return `${Math.abs(days)}d overdue · ${due.slice(5)}`;
  }

  function paidPercent(bill) {
    const expected = Number(bill?.current_cycle?.expected ?? bill?.current_cycle?.amount ?? bill?.amount ?? 0);
    const paid = Number(bill?.current_cycle?.paid ?? bill?.current_cycle?.paid_amount ?? 0);

    if (!expected || expected <= 0) return 0;

    return Math.max(0, Math.min(100, Math.round((paid / expected) * 100)));
  }

  function extractErrorMessage(payload, status, rawText) {
    if (payload?.error) {
      if (typeof payload.error === 'string') return payload.error;
      if (payload.error.message) return payload.error.code ? `${payload.error.code}: ${payload.error.message}` : payload.error.message;
      if (payload.error.code) return payload.error.code;
    }

    if (payload?.message) return payload.message;
    if (payload?.code && payload?.error) return `${payload.code}: ${payload.error}`;
    if (payload?.error) return String(payload.error);
    if (rawText && rawText.length < 400) return `HTTP ${status}: ${rawText}`;

    return `HTTP ${status}`;
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options?.headers || {})
      },
      ...(options || {})
    });

    const rawText = await response.text();
    let payload = null;

    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error(extractErrorMessage(payload, response.status, rawText));
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

  function accountRowsFromPayload(payload) {
    if (!payload) return [];
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

    populateAccountSelects();
  }

  async function loadBills() {
    if (state.loading) return;

    state.loading = true;
    setText('bills-state-pill', 'Loading');

    try {
      await loadAccounts();

      const month = currentMonth();
      state.payload = await fetchJSON(`${API_BILLS}?month=${encodeURIComponent(month)}&include_inactive=1`);

      try {
        const healthPayload = await fetchJSON(API_BILLS_HEALTH);
        state.health = healthPayload.health || healthPayload || null;
      } catch (err) {
        state.health = { status: 'unavailable', error: err.message };
      }

      state.lastLoadedAt = new Date();

      renderAll();
      setText('bills-state-pill', 'Loaded');
    } catch (err) {
      setText('bills-state-pill', 'Failed');
      setHTML('bills-list', `
        <div class="sf-empty-state sf-tone-danger">
          <div>
            <h3 class="sf-card-title">Bills failed to load</h3>
            <p class="sf-card-subtitle">${esc(err.message)}</p>
          </div>
        </div>
      `);
      setHTML('bills-health-panel', `
        <div class="sf-empty-state sf-tone-danger">
          <div>
            <h3 class="sf-card-title">Health unavailable</h3>
            <p class="sf-card-subtitle">${esc(err.message)}</p>
          </div>
        </div>
      `);
      renderHeaderPills();
      renderDebug();
      toast(`Load failed: ${err.message}`, 'danger');
    } finally {
      state.loading = false;
    }
  }

  function accountOptionsHtml(selectedId) {
    return ['<option value="">Choose account</option>'].concat(
      state.accounts.map(account => {
        const id = account.id || account.account_id || '';
        const name = account.name || account.label || id;
        const balance = account.balance ?? account.current_balance ?? account.amount ?? 0;
        const selected = String(id) === String(selectedId || '') ? ' selected' : '';

        return `<option value="${esc(id)}"${selected}>${esc(name)} · ${money(balance)}</option>`;
      })
    ).join('');
  }

  function populateAccountSelects() {
    qa('[data-bills-account-select]').forEach(select => {
      const current = select.value;
      select.innerHTML = accountOptionsHtml(current);
      if (current) select.value = current;
    });
  }

  function accountName(id) {
    if (!id) return '—';

    const found = state.accounts.find(account => String(account.id || account.account_id) === String(id));

    return found ? (found.name || found.label || id) : id;
  }

  function applyToolbar(rows) {
    let out = rows.slice();
    const filter = state.filter;

    const inWeek = bill => {
      const days = daysUntilDue(bill);
      return days != null && days >= 0 && days <= 7;
    };

    if (filter === 'unpaid') out = out.filter(bill => billCycleStatus(bill) === 'unpaid' && bill.status !== 'deleted');
    else if (filter === 'partial') out = out.filter(bill => billCycleStatus(bill) === 'partial' && bill.status !== 'deleted');
    else if (filter === 'paid') out = out.filter(bill => billCycleStatus(bill) === 'paid' && bill.status !== 'deleted');
    else if (filter === 'due_this_week') out = out.filter(bill => bill.status !== 'deleted' && inWeek(bill));
    else if (filter === 'ledger_reversed') out = out.filter(bill => Number(bill.ledger_reversed_excluded_count || 0) > 0);
    else if (filter === 'deleted') out = out.filter(bill => bill.status === 'deleted');
    else out = out.filter(bill => bill.status !== 'deleted');

    const query = state.search.trim().toLowerCase();

    if (query) {
      out = out.filter(bill => {
        const fields = [
          bill.id,
          bill.name,
          bill.notes,
          bill.category_id,
          bill.default_account_id,
          bill.last_paid_account_id
        ].map(value => String(value == null ? '' : value).toLowerCase());

        return fields.some(value => value.includes(query));
      });
    }

    const sort = state.sort;

    if (sort === 'amount_desc') {
      out.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    } else if (sort === 'name_asc') {
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    } else if (sort === 'last_paid_desc') {
      out.sort((a, b) => String(b.last_paid_date || '').localeCompare(String(a.last_paid_date || '')));
    } else if (sort === 'created_desc') {
      out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    } else {
      out.sort((a, b) => Number(a.due_day || 99) - Number(b.due_day || 99));
    }

    return out;
  }

  function setFilter(filter) {
    state.filter = filter;

    qa('[data-bills-filter]').forEach(button => {
      button.classList.toggle('is-active', button.getAttribute('data-bills-filter') === filter);
    });

    setText('bills-filter-pill', filter.replace(/_/g, ' '));
    renderBillsList();
    renderDebug();
  }

  function setSort(sort) {
    state.sort = sort;
    renderBillsList();
    renderDebug();
  }

  function setSearch(query) {
    state.search = query || '';
    renderBillsList();
    renderDebug();
  }

  function renderHeaderPills() {
    const lastLoaded = state.lastLoadedAt ? `Last loaded: ${state.lastLoadedAt.toLocaleTimeString()}` : 'Last loaded: never';
    const health = state.health?.status || 'unknown';
    const total = state.payload?.count ?? activeBills().length;

    setText('bills-last-loaded', lastLoaded);
    setText('bills-count-pill', `${total} bills`);
    setText('bills-health-pill', `health ${health}`);
  }

  function renderSummary() {
    const payload = state.payload || {};

    setText('bills-expected-this-cycle', money(payload.expected_this_cycle ?? 0));
    setText('bills-paid-this-cycle', money(payload.paid_this_cycle ?? 0));
    setText('bills-remaining', money(payload.remaining ?? 0));
    setText('bills-status-counts', `${payload.paid_count ?? 0} / ${payload.partial_count ?? 0} / ${payload.unpaid_count ?? 0}`);
    setText('bills-ledger-reversed-excluded', String(payload.ledger_reversed_excluded_count ?? 0));
    setText('bills-health-status', state.health?.status || 'unknown');
  }

  function renderShellKpis() {
    if (!window.SFShell || typeof window.SFShell.setKpis !== 'function') return;

    const payload = state.payload || {};
    const health = state.health?.status || 'unknown';
    const healthTone = health === 'pass' ? 'positive' : health === 'warn' ? 'warning' : health === 'unavailable' ? 'danger' : 'info';
    const remainingTone = Number(payload.remaining || 0) > 0 ? 'warning' : 'positive';

    try {
      window.SFShell.setKpis([
        {
          title: 'Expected',
          kicker: 'Cycle',
          value: money(payload.expected_this_cycle ?? 0),
          subtitle: payload.month || currentMonth(),
          foot: `Backend ${payload.version || 'unknown'}`
        },
        {
          title: 'Paid',
          kicker: 'Ledger-linked',
          value: money(payload.paid_this_cycle ?? 0),
          subtitle: `${payload.paid_count ?? 0} paid · ${payload.partial_count ?? 0} partial`,
          foot: 'Reversed excluded',
          tone: 'positive'
        },
        {
          title: 'Remaining',
          kicker: 'Pressure',
          value: money(payload.remaining ?? 0),
          subtitle: `${payload.unpaid_count ?? 0} unpaid`,
          foot: 'Backend cycle truth',
          tone: remainingTone
        },
        {
          title: 'Health',
          kicker: 'Integrity',
          value: health,
          subtitle: 'Payment / ledger',
          foot: '/api/bills/health',
          tone: healthTone
        }
      ]);
    } catch (err) {
      console.warn('[bills.js] shell KPI refresh failed', err);
    }
  }

  function renderBillsList() {
    const list = $('bills-list');
    if (!list) return;

    const all = bills();

    if (!all.length) {
      list.innerHTML = `
        <div class="sf-empty-state">
          <div>
            <h3 class="sf-card-title">No bills</h3>
            <p class="sf-card-subtitle">Backend returned an empty bills array.</p>
          </div>
        </div>
      `;
      return;
    }

    const filtered = applyToolbar(all);

    if (!filtered.length) {
      list.innerHTML = `
        <div class="sf-empty-state">
          <div>
            <h3 class="sf-card-title">No bills match</h3>
            <p class="sf-card-subtitle">Filter “${esc(state.filter)}”${state.search ? ` + search “${esc(state.search)}”` : ''} returned 0 of ${all.length}.</p>
          </div>
        </div>
      `;
      return;
    }

    list.innerHTML = filtered.map(renderBillRow).join('');
    bindListActions();
  }

  function renderBillRow(bill) {
  const id = String(bill.id);
  const expanded = state.expandedBillIds.has(id);
  const status = bill.status === 'deleted' ? 'deleted' : billCycleStatus(bill);
  const tone = toneForCycleStatus(status);
  const percent = paidPercent(bill);
  const cycle = bill.current_cycle || {};
  const reversed = Number(bill.ledger_reversed_excluded_count || 0);
  const advance = Number(bill.advance_paid_amount || 0);
  const remaining = cycle.remaining ?? cycle.remaining_amount ?? 0;
  const paid = cycle.paid ?? cycle.paid_amount ?? 0;

  const tags = [
    pill(status, tone)
  ];

  if (bill.ledger_linked) tags.push(pill('ledger', 'info'));
  if (advance > 0) tags.push(pill(`advance ${money(advance)}`, 'positive'));
  if (reversed > 0) tags.push(pill(`reversed ${reversed}`, 'warning'));
  if (bill.status === 'paused') tags.push(pill('paused', 'warning'));

  return `
    <article class="sf-finance-row ${expanded ? 'is-open' : ''}" data-bill-row="${esc(id)}">
      <div class="sf-row-left">
        <div class="sf-row-title">${esc(bill.name || bill.id)}</div>
        <div class="sf-row-subtitle">
          ${esc(dueLabel(bill))} · ${esc(bill.frequency || 'monthly')} · ${esc(accountName(bill.last_paid_account_id || bill.default_account_id))}
        </div>

        <div class="sf-section-actions">
          ${tags.join('')}
          ${pill(`${percent}% paid`, percent >= 100 ? 'positive' : percent > 0 ? 'warning' : 'danger')}
        </div>
      </div>

      <div class="sf-row-right">
        <div>${money(bill.amount)}</div>
        <div class="sf-row-subtitle">Paid ${money(paid)} · Remaining ${money(remaining)}</div>

        <div class="sf-section-actions">
          <button class="sf-button" type="button" data-bill-action="details" data-bill-id="${esc(id)}">${expanded ? 'Hide' : 'Details'}</button>
          ${bill.status === 'deleted'
            ? `<button class="sf-button sf-button--primary" type="button" data-bill-action="restore" data-bill-id="${esc(id)}">Restore</button>`
            : `
              <button class="sf-button sf-button--primary" type="button" data-bill-action="pay" data-bill-id="${esc(id)}">Pay</button>
              <button class="sf-button" type="button" data-bill-action="edit" data-bill-id="${esc(id)}">Edit</button>
              <button class="sf-button" type="button" data-bill-action="defer" data-bill-id="${esc(id)}">Defer</button>
              <button class="sf-button" type="button" data-bill-action="delete" data-bill-id="${esc(id)}">Soft-delete</button>
            `}
        </div>
      </div>
    </article>

    ${expanded ? renderInlineDetail(bill, cycle) : ''}
  `;
}

  function renderInlineDetail(bill, cycle) {
  const rows = [
    ['Bill ID', bill.id],
    ['Expected', money(bill.amount)],
    ['Cycle paid', money(cycle.paid ?? cycle.paid_amount ?? 0)],
    ['Remaining', money(cycle.remaining ?? cycle.remaining_amount ?? 0)],
    ['Advance paid', money(bill.advance_paid_amount ?? 0)],
    ['Advance count', String(bill.advance_payment_count ?? 0)],
    ['Due day', bill.due_day != null ? String(bill.due_day) : '—'],
    ['Due date', bill.due_date || dueDateForBill(bill) || '—'],
    ['Frequency', bill.frequency || '—'],
    ['Category', bill.category_id || '—'],
    ['Default account', accountName(bill.default_account_id)],
    ['Last paid', bill.last_paid_date || '—'],
    ['Last paid acct', accountName(bill.last_paid_account_id)],
    ['Ledger linked', bill.ledger_linked ? 'Yes' : 'No'],
    ['Reversed excluded', String(bill.ledger_reversed_excluded_count ?? 0)],
    ['Status', bill.status || 'active']
  ];

  const future = Array.isArray(bill.next_paid_cycles) ? bill.next_paid_cycles : [];

  return `
    <section class="sf-panel" data-bill-detail="${esc(bill.id)}">
      <div class="sf-section-head">
        <div>
          <p class="sf-section-kicker">Bill detail</p>
          <h3 class="sf-section-title">${esc(bill.name || bill.id)}</h3>
          <p class="sf-section-subtitle">Backend cycle proof and linked ledger state.</p>
        </div>
      </div>

      <div class="sf-secondary-grid">
        ${rows.map(([key, value]) => `
          <div class="sf-dense-row">
            <span class="sf-row-subtitle">${esc(key)}</span>
            <strong>${esc(value)}</strong>
          </div>
        `).join('')}
      </div>

      ${bill.notes ? `
        <div class="sf-empty-state">
          ${esc(bill.notes)}
        </div>
      ` : ''}

      ${future.length ? `
        <div class="sf-dense-grid">
          <div class="sf-section-head">
            <div>
              <p class="sf-section-kicker">Future cycles</p>
              <h3 class="sf-section-title">Paid in advance</h3>
            </div>
          </div>

          ${future.map(cycleRow => `
            <div class="sf-finance-row">
              <div class="sf-row-left">
                <div class="sf-row-title">${esc(monthLabel(cycleRow.month))}</div>
                <div class="sf-row-subtitle">${esc(cycleRow.payment_count)} payment${cycleRow.payment_count === 1 ? '' : 's'}</div>
              </div>
              <div class="sf-row-right">${money(cycleRow.paid_amount)}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </section>
  `;
}

  function bindListActions() {
    const list = $('bills-list');
    if (!list || state.listActionsBound) return;

    state.listActionsBound = true;

    list.addEventListener('click', event => {
      const actionButton = event.target.closest('[data-bill-action]');
      const row = event.target.closest('[data-bill-row]');

      if (actionButton) {
        event.preventDefault();
        event.stopPropagation();

        const action = actionButton.getAttribute('data-bill-action');
        const billId = actionButton.getAttribute('data-bill-id');

        if (action === 'details') toggleExpand(billId);
        if (action === 'pay') openPayModal(billId);
        if (action === 'edit') openEditModal(billId);
        if (action === 'defer') openDeferModal(billId);
        if (action === 'delete') softDeleteBill(billId);
        if (action === 'restore') restoreBill(billId);

        return;
      }

      if (row) {
        toggleExpand(row.getAttribute('data-bill-row'));
      }
    });
  }

  function toggleExpand(id) {
    const key = String(id);

    if (state.expandedBillIds.has(key)) state.expandedBillIds.delete(key);
    else state.expandedBillIds.add(key);

    state.selectedBillId = id;

    renderBillsList();
    renderSelected();
    prefillPaymentForm();
    renderDebug();
  }

  function renderSelected() {
    const panel = $('bills-selected-panel');
    if (!panel) return;

    const bill = selectedBill();

    if (!bill) {
      panel.innerHTML = `
        <div class="sf-loading-state">
          <div>
            <h3 class="sf-card-title">No bill selected</h3>
            <p class="sf-card-subtitle">Click a bill to expand its detail.</p>
          </div>
        </div>
      `;
      return;
    }

    const cycle = bill.current_cycle || {};

    const rows = [
      ['Name', bill.name || '—'],
      ['Cycle status', billCycleStatus(bill)],
      ['Amount', money(bill.amount)],
      ['Cycle paid', money(cycle.paid ?? cycle.paid_amount ?? 0)],
      ['Cycle remaining', money(cycle.remaining ?? cycle.remaining_amount ?? 0)],
      ['Advance paid', money(bill.advance_paid_amount ?? 0)],
      ['Advance cycles', String((bill.next_paid_cycles || []).length)],
      ['Due', dueLabel(bill)],
      ['Last paid', bill.last_paid_date || '—'],
      ['Default account', accountName(bill.default_account_id)],
      ['Status', bill.status || 'active']
    ];

    panel.innerHTML = rows.map(([key, value]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(key)}</div>
        </div>
        <div class="sf-row-right">${esc(value)}</div>
      </div>
    `).join('');
  }

  function renderHealthPanel() {
    const panel = $('bills-health-panel');
    if (!panel) return;

    const health = state.health || {};

    const rows = [
      ['Status', String(health.status || 'unknown'), health.status === 'pass' ? 'positive' : health.status === 'warn' ? 'warning' : 'danger'],
      ['Payment rows scanned', String(health.payment_rows ?? '—')],
      ['Orphan payments', String(health.orphan_count ?? health.orphans?.length ?? 0), Number(health.orphan_count ?? health.orphans?.length ?? 0) ? 'danger' : 'positive'],
      ['Active payments w/ reversed txn', String(health.active_payment_reversed_txn_mismatch_count ?? health.active_payment_reversed_txn_mismatch?.length ?? 0), Number(health.active_payment_reversed_txn_mismatch_count ?? health.active_payment_reversed_txn_mismatch?.length ?? 0) ? 'danger' : 'positive'],
      ['Missing reversal txn', String(health.missing_reversal_txn_count ?? health.missing_reversal_txn?.length ?? 0), Number(health.missing_reversal_txn_count ?? health.missing_reversal_txn?.length ?? 0) ? 'danger' : 'positive'],
      ['Duplicate bill/month/amount', String(health.duplicate_bill_month_amount_count ?? health.duplicate_bill_month_amount?.length ?? 0), Number(health.duplicate_bill_month_amount_count ?? health.duplicate_bill_month_amount?.length ?? 0) ? 'warning' : 'positive'],
      ['Amount mismatches', String(health.amount_mismatch_count ?? health.amount_mismatches?.length ?? 0), Number(health.amount_mismatch_count ?? health.amount_mismatches?.length ?? 0) ? 'danger' : 'positive']
    ];

    panel.innerHTML = rows.map(([key, value, tone]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(key)}</div>
        </div>
        <div class="sf-row-right${tone ? ` sf-tone-${esc(tone)}` : ''}">${esc(value)}</div>
      </div>
    `).join('');
  }

  function renderAdvanceSection() {
    const section = $('bills-advance-section');
    const body = $('bills-advance-body');
    if (!section || !body) return;

    const total = Number(state.payload?.advance_paid_total || 0);
    const countTotal = Number(state.payload?.advance_payment_count_total || 0);
    const billsWithAdvance = bills().filter(bill => Number(bill.advance_paid_amount || 0) > 0);

    if (total <= 0 || !billsWithAdvance.length) {
      section.hidden = true;
      body.innerHTML = '';
      return;
    }

    section.hidden = false;
    setText('bills-advance-pill', `${money(total)} · ${countTotal} payments`);

    body.innerHTML = billsWithAdvance.map(bill => {
      const future = Array.isArray(bill.next_paid_cycles) ? bill.next_paid_cycles : [];

      return `
        <div class="sf-panel">
          <div class="sf-section-head">
            <div>
              <p class="sf-section-kicker">Advance bill</p>
              <h3 class="sf-section-title">${esc(bill.name)}</h3>
              <p class="sf-section-subtitle">Expected per cycle ${money(bill.amount)} · default ${esc(accountName(bill.default_account_id))}</p>
            </div>
            <div class="sf-section-meta">
              ${pill(money(bill.advance_paid_amount), 'positive')}
            </div>
          </div>

          <div class="sf-dense-grid">
            ${future.map(cycleRow => `
              <div class="sf-finance-row">
                <div class="sf-row-left">
                  <div class="sf-row-title">${esc(monthLabel(cycleRow.month))}</div>
                  <div class="sf-row-subtitle">${esc(cycleRow.payment_count)} payment${cycleRow.payment_count === 1 ? '' : 's'}</div>
                </div>
                <div class="sf-row-right">${money(cycleRow.paid_amount)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDebug() {
    setText('bills-debug-output', JSON.stringify({
      uiVersion: VERSION,
      backendVersion: state.payload?.version,
      contractVersion: state.payload?.contract_version,
      month: state.payload?.month,
      filter: state.filter,
      sort: state.sort,
      search: state.search,
      totals: {
        expected: state.payload?.expected_this_cycle,
        paid: state.payload?.paid_this_cycle,
        remaining: state.payload?.remaining
      },
      advance: {
        total: state.payload?.advance_paid_total,
        count: state.payload?.advance_payment_count_total
      },
      counts: {
        bills: bills().length,
        active: activeBills().length,
        paid: state.payload?.paid_count,
        partial: state.payload?.partial_count,
        unpaid: state.payload?.unpaid_count,
        ledger_reversed_excluded: state.payload?.ledger_reversed_excluded_count
      },
      health: state.health,
      selectedBillId: state.selectedBillId,
      expanded: Array.from(state.expandedBillIds),
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
    renderAdvanceSection();
    renderDebug();
    prefillPaymentForm();
  }

  function prefillPaymentForm() {
    const bill = selectedBill();

    const nameInput = $('bill-payment-name');
    const amountInput = $('bill-payment-amount');
    const dateInput = $('bill-payment-date');
    const accountSelect = $('bill-payment-account');
    const stateSpan = $('bills-payment-state');

    if (!bill) {
      if (nameInput) nameInput.value = '';
      if (stateSpan) stateSpan.textContent = 'Select bill';
      return;
    }

    const cycle = bill.current_cycle || {};
    const remaining = cycle.remaining ?? cycle.remaining_amount;

    if (nameInput) nameInput.value = `${bill.name} (${bill.id})`;
    if (amountInput && !amountInput.value) amountInput.value = remaining != null ? remaining : bill.amount || '';
    if (dateInput && !dateInput.value) dateInput.value = todayISO();
    if (accountSelect && !accountSelect.value) accountSelect.value = bill.default_account_id || '';
    if (stateSpan) stateSpan.textContent = 'Ready';
  }

  function openDialog(name, bodyHtml) {
    const dialog = $(`bills-${name}-modal`);
    const body = $(`bills-${name}-modal-body`);

    if (!dialog || !body) return false;

    body.innerHTML = bodyHtml;
    state.activeModal = name;
    populateAccountSelects();

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.removeAttribute('hidden');
    }

    requestAnimationFrame(() => {
      const first = body.querySelector('input, select, textarea, button');
      if (first && typeof first.focus === 'function') {
        first.focus({ preventScroll: true });
      }
    });

    return true;
  }

  function closeModal(name) {
    const target = name || state.activeModal;
    if (!target) return;

    const dialog = $(`bills-${target}-modal`);
    if (!dialog) return;

    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.setAttribute('hidden', '');
    }

    const body = $(`bills-${target}-modal-body`);
    if (body) body.innerHTML = '';

    state.activeModal = null;
  }

  function formToAddPayload(form) {
    return {
      action: 'create',
      name: clean(form.elements.name?.value),
      amount: num(form.elements.amount?.value),
      due_day: num(form.elements.due_day?.value, 0) || null,
      frequency: clean(form.elements.frequency?.value) || 'monthly',
      default_account_id: clean(form.elements.default_account_id?.value) || null,
      category_id: clean(form.elements.category_id?.value) || 'bills_utilities',
      notes: clean(form.elements.notes?.value) || '',
      idempotency_key: `bill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_by: 'bills-ui-' + VERSION
    };
  }

  function formToPayPayload(form) {
    return {
      action: 'payment',
      amount: num(form.elements.amount?.value),
      date: clean(form.elements.paid_date?.value) || todayISO(),
      bill_month: clean(form.elements.bill_month?.value) || currentMonth(),
      account_id: clean(form.elements.account_id?.value),
      notes: clean(form.elements.notes?.value) || '',
      idempotency_key: `billpay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      created_by: 'bills-ui-' + VERSION
    };
  }

  async function submitAddBill(payload, stateSpan) {
    if (!payload.name) {
      toast('Bill name required.', 'warning');
      return;
    }

    if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      toast('Expected amount must be greater than 0.', 'warning');
      return;
    }

    if (stateSpan) stateSpan.textContent = 'Saving';

    try {
      const result = await postJSON(API_BILLS, payload);
      const newId = result?.bill?.id || result?.id || null;

      if (newId) state.selectedBillId = newId;
      if (stateSpan) stateSpan.textContent = 'Saved';

      closeModal('add');
      await loadBills();

      toast(`Bill added: ${payload.name}`, 'positive');
    } catch (err) {
      if (stateSpan) stateSpan.textContent = 'Failed';
      toast(`Add failed: ${err.message}`, 'danger');
    }
  }

  async function submitPay(bill, payload, stateSpan) {
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      toast('Payment amount must be greater than 0.', 'warning');
      return;
    }

    if (!payload.account_id) {
      toast('Pick the payment account.', 'warning');
      return;
    }

    if (stateSpan) stateSpan.textContent = 'Saving';

    try {
      await postJSON(API_BILLS, {
        ...payload,
        bill_id: bill.id
      });

      if (stateSpan) stateSpan.textContent = 'Saved';

      closeModal('pay');
      state.selectedBillId = bill.id;
      await loadBills();

      const isAdvance = payload.bill_month && payload.bill_month !== currentMonth();
      toast(`${isAdvance ? 'Advance' : 'Cycle'} payment ${money(payload.amount)} on "${bill.name}" for ${monthLabel(payload.bill_month || currentMonth())}.`, 'positive');
    } catch (err) {
      if (stateSpan) stateSpan.textContent = 'Failed';
      toast(`Pay failed: ${err.message}`, 'danger');
    }
  }

  async function submitEdit(bill, updates) {
    try {
      await postJSON(API_BILLS, {
        action: 'update',
        bill_id: bill.id,
        ...updates
      });

      closeModal('edit');
      state.selectedBillId = bill.id;
      await loadBills();

      toast(`Updated "${bill.name}".`, 'positive');
    } catch (err) {
      toast(`Edit failed: ${err.message}`, 'danger');
    }
  }

  async function submitDefer(bill, payload) {
    try {
      await postJSON(API_BILLS, {
        action: 'defer',
        bill_id: bill.id,
        ...payload
      });

      closeModal('defer');
      state.selectedBillId = bill.id;
      await loadBills();

      toast(`Deferred "${bill.name}".`, 'positive');
    } catch (err) {
      toast(`Defer failed: ${err.message}`, 'danger');
    }
  }

  async function softDeleteBill(billId) {
    const bill = bills().find(row => String(row.id) === String(billId));
    if (!bill) return;

    if (!window.confirm(`Soft-delete "${bill.name}"? Status will become deleted.`)) return;

    try {
      await postJSON(API_BILLS, {
        action: 'update',
        bill_id: bill.id,
        status: 'deleted'
      });

      if (String(state.selectedBillId) === String(billId)) state.selectedBillId = null;
      state.expandedBillIds.delete(String(billId));

      await loadBills();
      toast(`Soft-deleted "${bill.name}".`, 'positive');
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'danger');
    }
  }

  async function restoreBill(billId) {
    const bill = bills().find(row => String(row.id) === String(billId));
    if (!bill) return;

    try {
      await postJSON(API_BILLS, {
        action: 'update',
        bill_id: bill.id,
        status: 'active'
      });

      await loadBills();
      toast(`Restored "${bill.name}".`, 'positive');
    } catch (err) {
      toast(`Restore failed: ${err.message}`, 'danger');
    }
  }

  function openAddModal() {
    openDialog('add', `
      <form class="sf-dialog-grid" data-bills-modal-form="add">
        <label class="sf-field sf-field--wide">
          <span class="sf-label">Bill name</span>
          <input class="sf-input" name="name" type="text" autocomplete="off" placeholder="Internet Bill, Rent, School Fee" required>
        </label>

        <label class="sf-field">
          <span class="sf-label">Expected amount</span>
          <input class="sf-input" name="amount" type="number" inputmode="decimal" min="0" step="0.01" required>
        </label>

        <label class="sf-field">
          <span class="sf-label">Due day</span>
          <input class="sf-input" name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${new Date().getDate()}" required>
        </label>

        <label class="sf-field">
          <span class="sf-label">Frequency</span>
          <select class="sf-select" name="frequency">
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <label class="sf-field">
          <span class="sf-label">Default account</span>
          <select class="sf-select" name="default_account_id" data-bills-account-select>
            <option value="">Choose when paying</option>
          </select>
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Category</span>
          <input class="sf-input" name="category_id" type="text" value="bills_utilities" required>
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Notes</span>
          <textarea class="sf-textarea" name="notes" rows="2" placeholder="Optional note"></textarea>
        </label>

        <div class="sf-dialog-note">
          Bill creation creates the obligation only. No ledger row and no account movement happens here.
        </div>

        <div class="sf-dialog-footer sf-field--wide">
          <div class="sf-dialog-footer-copy">Save creates the bill obligation.</div>
          <div class="sf-section-actions">
            <button class="sf-button" type="button" data-bills-modal-close="add">Cancel</button>
            <button class="sf-button sf-button--primary" type="submit">Add Bill</button>
          </div>
        </div>
      </form>
    `);

    const form = qa('[data-bills-modal-form="add"]')[0];
    if (form) {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        await submitAddBill(formToAddPayload(form), null);
      });
    }
  }

  function openPayModal(billIdOverride) {
    const targetId = billIdOverride != null ? billIdOverride : state.selectedBillId;
    const bill = bills().find(row => String(row.id) === String(targetId));

    if (!bill) {
      toast('Select a bill first.', 'warning');
      return;
    }

    state.selectedBillId = bill.id;

    const cycle = bill.current_cycle || {};
    const remaining = cycle.remaining ?? cycle.remaining_amount;
    const defaultAmount = remaining != null && remaining > 0 ? remaining : bill.amount;
    const cycleOptions = nextCycleOptions(3)
      .map(option => `<option value="${option.value}"${option.value === currentMonth() ? ' selected' : ''}>${esc(option.label)}</option>`)
      .join('');

    openDialog('pay', `
      <div class="sf-dialog-note">
        <strong>${esc(bill.name)}</strong><br>
        ${esc(dueLabel(bill))} · expected ${money(bill.amount)} · current remaining ${money(remaining ?? 0)}
        ${Number(bill.advance_paid_amount || 0) > 0 ? ` · advance ${money(bill.advance_paid_amount)}` : ''}
      </div>

      <form class="sf-dialog-grid" data-bills-modal-form="pay">
        <label class="sf-field sf-field--wide">
          <span class="sf-label">Pay for cycle</span>
          <select class="sf-select" name="bill_month" required>${cycleOptions}</select>
        </label>

        <label class="sf-field">
          <span class="sf-label">Payment amount</span>
          <input class="sf-input" name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(defaultAmount ?? '')}" required>
        </label>

        <label class="sf-field">
          <span class="sf-label">Payment date</span>
          <input class="sf-input" name="paid_date" type="date" value="${esc(todayISO())}">
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Pay from account</span>
          <select class="sf-select" name="account_id" data-bills-account-select required>
            <option value="">Choose account</option>
          </select>
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Notes</span>
          <textarea class="sf-textarea" name="notes" rows="2" placeholder="Optional payment note"></textarea>
        </label>

        <div class="sf-dialog-note">
          Current cycle payment reduces this month’s remaining bill pressure. Future cycle payment becomes paid in advance.
        </div>

        <div class="sf-dialog-footer sf-field--wide">
          <div class="sf-dialog-footer-copy">Backend creates ledger expense + bill payment proof.</div>
          <div class="sf-section-actions">
            <button class="sf-button" type="button" data-bills-modal-close="pay">Cancel</button>
            <button class="sf-button sf-button--primary" type="submit">Confirm Payment</button>
          </div>
        </div>
      </form>
    `);

    const form = qa('[data-bills-modal-form="pay"]')[0];

    if (form) {
      const accountSelect = form.querySelector('select[name="account_id"]');
      if (accountSelect) accountSelect.value = bill.default_account_id || '';

      const cycleSelect = form.querySelector('select[name="bill_month"]');
      const amountInput = form.querySelector('input[name="amount"]');

      if (cycleSelect && amountInput) {
        cycleSelect.addEventListener('change', () => {
          amountInput.value = cycleSelect.value !== currentMonth() ? bill.amount || '' : defaultAmount || '';
        });
      }

      form.addEventListener('submit', async event => {
        event.preventDefault();
        await submitPay(bill, formToPayPayload(form), null);
      });
    }
  }

  function openEditModal(billId) {
    const bill = bills().find(row => String(row.id) === String(billId));
    if (!bill) return;

    openDialog('edit', `
      <div class="sf-dialog-note">
        Editing updates the bill obligation only. It does not rewrite historical payment rows.
      </div>

      <form class="sf-dialog-grid" data-bills-modal-form="edit">
        <label class="sf-field sf-field--wide">
          <span class="sf-label">Bill name</span>
          <input class="sf-input" name="name" type="text" value="${esc(bill.name || '')}">
        </label>

        <label class="sf-field">
          <span class="sf-label">Expected amount</span>
          <input class="sf-input" name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(bill.amount ?? '')}">
        </label>

        <label class="sf-field">
          <span class="sf-label">Due day</span>
          <input class="sf-input" name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${esc(bill.due_day ?? '')}">
        </label>

        <label class="sf-field">
          <span class="sf-label">Frequency</span>
          <select class="sf-select" name="frequency">
            ${['monthly', 'weekly', 'custom'].map(freq => `<option value="${freq}"${freq === (bill.frequency || 'monthly') ? ' selected' : ''}>${freq}</option>`).join('')}
          </select>
        </label>

        <label class="sf-field">
          <span class="sf-label">Default account</span>
          <select class="sf-select" name="default_account_id" data-bills-account-select>
            <option value="">Choose when paying</option>
          </select>
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Category</span>
          <input class="sf-input" name="category_id" type="text" value="${esc(bill.category_id || '')}">
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Notes</span>
          <textarea class="sf-textarea" name="notes" rows="2">${esc(bill.notes || '')}</textarea>
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Status</span>
          <select class="sf-select" name="status">
            ${['active', 'paused', 'deleted'].map(status => `<option value="${status}"${status === (bill.status || 'active') ? ' selected' : ''}>${status}</option>`).join('')}
          </select>
        </label>

        <div class="sf-dialog-footer sf-field--wide">
          <div class="sf-dialog-footer-copy">No ledger movement occurs during edit.</div>
          <div class="sf-section-actions">
            <button class="sf-button" type="button" data-bills-modal-close="edit">Cancel</button>
            <button class="sf-button sf-button--primary" type="submit">Save Changes</button>
          </div>
        </div>
      </form>
    `);

    const form = qa('[data-bills-modal-form="edit"]')[0];

    if (form) {
      const accountSelect = form.querySelector('select[name="default_account_id"]');
      if (accountSelect) accountSelect.value = bill.default_account_id || '';

      form.addEventListener('submit', async event => {
        event.preventDefault();

        await submitEdit(bill, {
          name: clean(form.elements.name?.value),
          amount: num(form.elements.amount?.value),
          due_day: num(form.elements.due_day?.value, 0) || null,
          frequency: clean(form.elements.frequency?.value) || 'monthly',
          default_account_id: clean(form.elements.default_account_id?.value) || null,
          category_id: clean(form.elements.category_id?.value) || null,
          notes: clean(form.elements.notes?.value) || '',
          status: clean(form.elements.status?.value) || 'active'
        });
      });
    }
  }

  function openDeferModal(billId) {
    const bill = bills().find(row => String(row.id) === String(billId));
    if (!bill) return;

    openDialog('defer', `
      <div class="sf-dialog-note">
        <strong>${esc(bill.name)}</strong><br>
        Current due day: ${esc(bill.due_day ?? '—')}. Defer only updates schedule fields.
      </div>

      <form class="sf-dialog-grid" data-bills-modal-form="defer">
        <label class="sf-field sf-field--wide">
          <span class="sf-label">New due day</span>
          <input class="sf-input" name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${esc(bill.due_day ?? '')}">
        </label>

        <label class="sf-field sf-field--wide">
          <span class="sf-label">Notes</span>
          <textarea class="sf-textarea" name="notes" rows="2" placeholder="Why are you deferring?"></textarea>
        </label>

        <div class="sf-dialog-footer sf-field--wide">
          <div class="sf-dialog-footer-copy">Use Pay when money moved. Use Defer only for deadline changes.</div>
          <div class="sf-section-actions">
            <button class="sf-button" type="button" data-bills-modal-close="defer">Cancel</button>
            <button class="sf-button sf-button--primary" type="submit">Defer</button>
          </div>
        </div>
      </form>
    `);

    const form = qa('[data-bills-modal-form="defer"]')[0];

    if (form) {
      form.addEventListener('submit', async event => {
        event.preventDefault();

        const dueDay = num(form.elements.due_day?.value, 0) || null;
        const notes = clean(form.elements.notes?.value);

        if (!dueDay) {
          toast('Provide a new due day between 1 and 31.', 'warning');
          return;
        }

        await submitDefer(bill, {
          due_day: dueDay,
          notes
        });
      });
    }
  }

  function wireToolbar() {
    qa('[data-bills-filter]').forEach(button => {
      button.addEventListener('click', () => setFilter(button.getAttribute('data-bills-filter')));
    });

    const search = $('bills-search-input');
    if (search) {
      search.addEventListener('input', debounce(event => setSearch(event.target.value), SEARCH_DEBOUNCE_MS));
    }

    const sort = $('bills-sort-select');
    if (sort) {
      sort.addEventListener('change', event => setSort(event.target.value));
    }
  }

  function wireInlineForms() {
    const section = $('bills-inline-forms-section');
    if (section && !section.hasAttribute('hidden')) section.setAttribute('hidden', '');

    const addForm = $('bills-add-form');
    if (addForm) {
      addForm.addEventListener('submit', async event => {
        event.preventDefault();
        await submitAddBill(formToAddPayload(addForm), $('bills-add-state'));
      });
    }

    const payForm = $('bills-payment-form');
    if (payForm) {
      payForm.addEventListener('submit', async event => {
        event.preventDefault();

        const bill = selectedBill();
        if (!bill) {
          toast('Select a bill first.', 'warning');
          return;
        }

        await submitPay(bill, formToPayPayload(payForm), $('bills-payment-state'));
      });
    }

    $('bill-payment-clear')?.addEventListener('click', () => setText('bills-payment-state', 'Cleared'));
  }

  function wireModalChrome() {
    document.addEventListener('click', event => {
      const closeButton = event.target.closest('[data-bills-modal-close]');
      if (!closeButton) return;

      event.preventDefault();
      closeModal(closeButton.getAttribute('data-bills-modal-close'));
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.activeModal) closeModal();
    });
  }

  function wireShellActionsOnce() {
    if (state.actionsBound) return;
    state.actionsBound = true;

    document.addEventListener('click', async event => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest('#bills-refresh-btn')) {
        event.preventDefault();
        loadBills();
        return;
      }

      if (target.closest('#bills-open-add-modal-btn')) {
        event.preventDefault();
        openAddModal();
        return;
      }

      if (target.closest('#bills-open-pay-modal-btn')) {
        event.preventDefault();
        openPayModal();
        return;
      }

      if (target.closest('#bills-repair-btn')) {
        event.preventDefault();

        try {
          const result = await postJSON(API_BILLS, {
            action: 'repair_reversed_payments'
          });

          toast(`Repair OK · ${(result?.bad_payments_repaired ?? result?.bad_payments_found ?? 0)} repaired`, 'positive');
          await loadBills();
        } catch (err) {
          toast(`Repair failed: ${err.message}`, 'danger');
        }
      }
    });
  }

  let toastTimer = null;

  function toast(message, tone) {
    const el = $('bills-toast');

    if (!el) {
      console.log('[bills-toast]', message);
      return;
    }

    el.textContent = message;
    el.className = 'sf-toast';

    if (tone) el.classList.add(`sf-toast--${tone}`);

    el.removeAttribute('hidden');
    requestAnimationFrame(() => el.classList.add('is-open'));

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('is-open');
      setTimeout(() => el.setAttribute('hidden', ''), 220);
    }, 4500);
  }

  function init() {
    wireShellActionsOnce();
    wireModalChrome();
    wireToolbar();
    wireInlineForms();
    loadBills();

    window.SovereignBills = {
      version: VERSION,
      reload: loadBills,
      openAdd: openAddModal,
      openPay: () => openPayModal(),
      state: () => JSON.parse(JSON.stringify(state, (key, value) => value instanceof Set ? Array.from(value) : value))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
