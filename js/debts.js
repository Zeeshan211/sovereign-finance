/* js/debts.js
 * Sovereign Finance · Debts UI
 * v0.6.2-ledger-aware-ui
 *
 * Contract:
 * - Backend owns debt truth.
 * - Debt creation with money moved now must send movement_now + account_id.
 * - Owed-to-me writes debt_out through backend and reduces selected source account.
 * - I-owe writes debt_in through backend and increases selected destination account.
 * - Missing origin ledger is repaired through /api/debts/repair-ledger.
 * - UI does not fake amount/account edits unsupported by backend.
 */

(function () {
  'use strict';

  const VERSION = 'v0.6.2-ledger-aware-ui';

  const API_DEBTS = '/api/debts';
  const API_DEBTS_HEALTH = '/api/debts/health';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
    debts: [],
    accounts: [],
    health: null,
    selectedDebtId: null,
    filter: 'active',
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
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function kindLabel(kind) {
    return kind === 'owed' ? 'Owed to me' : 'I owe';
  }

  function kindTone(kind) {
    return kind === 'owed' ? 'good' : 'danger';
  }

  function toneClass(value) {
    const s = String(value || '').toLowerCase();

    if (['ok', 'active', 'linked', 'scheduled', 'paid_off', 'pass'].includes(s)) return 'good';
    if (['warn', 'due_soon', 'no_schedule', 'missing_ledger', 'paused'].includes(s)) return 'warn';
    if (['overdue', 'missing', 'danger', 'blocked', 'failed', 'closed'].includes(s)) return 'danger';

    return '';
  }

  function tag(text, tone) {
    return `<span class="debt-tag ${tone || ''}">${esc(text)}</span>`;
  }

  function blocker(text, tone) {
    return `<span class="${tone || ''}">${esc(text)}</span>`;
  }

  function row(title, sub, value, tone) {
    return `
      <div class="debt-row">
        <div>
          <div class="debt-row-title">${esc(title)}</div>
          ${sub ? `<div class="debt-row-sub">${esc(sub)}</div>` : ''}
        </div>
        <div class="debt-row-value ${tone ? `sf-tone-${esc(tone)}` : ''}">
          ${value == null ? '—' : value}
        </div>
      </div>
    `;
  }

  function modal(id) {
    return $(id);
  }

  function openModal(id) {
    const el = modal(id);
    if (el) el.hidden = false;
  }

  function closeModal(id) {
    const el = modal(id);
    if (el) el.hidden = true;
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  async function putJSON(url, body) {
    return fetchJSON(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function selectedDebt() {
    return state.debts.find(debt => String(debt.id) === String(state.selectedDebtId)) || null;
  }

  function debtRemaining(debt) {
    return num(debt.remaining_amount, Math.max(0, num(debt.original_amount) - num(debt.paid_amount)));
  }

  function debtPaidPct(debt) {
    const original = num(debt.original_amount);
    const paid = num(debt.paid_amount);

    if (!original || original <= 0) return 0;

    return Math.max(0, Math.min(100, paid / original * 100));
  }

  function normalizeDebt(row) {
    return {
      ...row,
      id: row.id || '',
      name: row.name || row.title || row.label || row.id || 'Debt',
      kind: row.kind === 'owed' ? 'owed' : 'owe',
      original_amount: num(row.original_amount ?? row.amount),
      paid_amount: num(row.paid_amount),
      remaining_amount: num(row.remaining_amount, Math.max(0, num(row.original_amount ?? row.amount) - num(row.paid_amount))),
      status: row.status || 'active',
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
      ledger_linked: Boolean(row.ledger_linked),
      ledger_required: Boolean(row.ledger_required),
      ledger_transaction_ids: Array.isArray(row.ledger_transaction_ids) ? row.ledger_transaction_ids : [],
      ledger_transactions: Array.isArray(row.ledger_transactions) ? row.ledger_transactions : [],
      notes: row.notes || '',
      raw: row
    };
  }

  function accountRowsFromPayload(payload) {
    if (Array.isArray(payload.accounts)) return payload.accounts;

    if (payload.accounts && typeof payload.accounts === 'object') {
      return Object.values(payload.accounts);
    }

    if (payload.accounts_by_id && typeof payload.accounts_by_id === 'object') {
      return Object.values(payload.accounts_by_id);
    }

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
    setHTML('debtList', '<div class="debt-empty">Loading debts…</div>');

    try {
      await loadAccounts();

      const payload = await fetchJSON(API_DEBTS);
      state.debts = (Array.isArray(payload.debts) ? payload.debts : []).map(normalizeDebt);

      try {
        state.health = await fetchJSON(API_DEBTS_HEALTH);
      } catch {
        state.health = null;
      }

      renderAll(payload);
    } catch (err) {
      setHTML('debtList', `<div class="debt-empty">Failed to load debts: ${esc(err.message)}</div>`);
      setText('metricHealth', 'failed');
      renderDebug({ error: err.message });
    } finally {
      state.loading = false;
    }
  }

  function renderAccountOptions() {
    const ids = [
      'debtAccountInput',
      'paymentAccountInput',
      'repairAccountInput'
    ];

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

  function filteredDebts() {
    return state.debts.filter(debt => {
      if (state.filter === 'all') return true;
      if (state.filter === 'active') return debt.status === 'active';
      if (state.filter === 'owe') return debt.kind === 'owe' && debt.status === 'active';
      if (state.filter === 'owed') return debt.kind === 'owed' && debt.status === 'active';
      if (state.filter === 'due') return ['due_today', 'due_soon', 'overdue'].includes(debt.due_status);
      if (state.filter === 'missing_ledger') return debt.ledger_required && !debt.ledger_linked;
      return true;
    });
  }

  function renderMetrics(payload) {
    const totalOwe = payload?.total_owe ?? state.debts
      .filter(debt => debt.kind === 'owe' && debt.status === 'active')
      .reduce((sum, debt) => sum + debtRemaining(debt), 0);

    const totalOwed = payload?.total_owed ?? state.debts
      .filter(debt => debt.kind === 'owed' && debt.status === 'active')
      .reduce((sum, debt) => sum + debtRemaining(debt), 0);

    const dueSoon = payload?.due_soon_count ?? state.debts.filter(debt => debt.due_status === 'due_soon').length;
    const overdue = payload?.overdue_count ?? state.debts.filter(debt => debt.due_status === 'overdue').length;
    const missingLedger = payload?.ledger_missing_count ?? state.debts.filter(debt => debt.ledger_required && !debt.ledger_linked).length;
    const healthStatus = state.health?.status || payload?.health?.status || 'unknown';

    setText('metricOwe', money(totalOwe));
    setText('metricOwed', money(totalOwed));
    setText('metricDueSoon', String(dueSoon));
    setText('metricOverdue', String(overdue));
    setText('metricMissingLedger', String(missingLedger));
    setText('metricHealth', healthStatus);

    setText('debtsVersionPill', payload?.version || VERSION);
    setText('debtsHealthPill', `health ${healthStatus}`);
    setText('debtsLedgerPill', `${missingLedger} missing ledger`);
    setText('debtFooterVersion', `${VERSION} · backend ${payload?.version || 'unknown'}`);

    if (missingLedger > 0) {
      setText('debtsHeroStatus', 'Ledger repair needed');
      setText('debtsHeroCopy', `${missingLedger} debt origin movement is missing a ledger row. Use Repair Ledger on the affected debt.`);
    } else {
      setText('debtsHeroStatus', 'Debt truth');
      setText('debtsHeroCopy', 'Debt rows and origin ledger links are loaded from backend truth.');
    }
  }

  function renderDebtTags(debt) {
    const tags = [];

    tags.push(tag(kindLabel(debt.kind), kindTone(debt.kind)));
    tags.push(tag(debt.status || 'active', toneClass(debt.status)));
    tags.push(tag(debt.due_status || 'no schedule', toneClass(debt.due_status)));

    if (debt.ledger_linked) {
      tags.push(tag('ledger linked', 'good'));
    } else if (debt.ledger_required) {
      tags.push(tag('ledger missing', 'danger'));
    } else {
      tags.push(tag('no origin movement', 'warn'));
    }

    if (debt.next_due_date) tags.push(tag(`next ${debt.next_due_date}`));
    if (debt.days_overdue) tags.push(tag(`${debt.days_overdue}d overdue`, 'danger'));
    if (debt.days_until_due != null && debt.due_status === 'due_soon') tags.push(tag(`${debt.days_until_due}d left`, 'warn'));

    return tags.join('');
  }

  function renderDebtBlockers(debt) {
    const blocks = [];

    if (debt.ledger_linked && debt.ledger_transaction_ids.length) {
      blocks.push(blocker(`ledger ${debt.ledger_transaction_ids.join(', ')}`, 'good'));
    }

    if (debt.ledger_required && !debt.ledger_linked) {
      blocks.push(blocker('origin ledger missing', 'danger'));
    }

    if (debt.schedule_missing && debt.status === 'active') {
      blocks.push(blocker('schedule missing', 'warn'));
    }

    if (!blocks.length) return '';

    return `<div class="debt-blockers">${blocks.join('')}</div>`;
  }

  function renderDebtCard(debt) {
    const selected = String(debt.id) === String(state.selectedDebtId);
    const pct = debtPaidPct(debt);

    return `
      <article class="debt-card ${selected ? 'is-selected' : ''}" data-debt-id="${esc(debt.id)}">
        <div class="debt-head">
          <div class="debt-icon">${debt.kind === 'owed' ? '📥' : '📤'}</div>

          <div>
            <div class="debt-title">${esc(debt.name)}</div>
            <div class="debt-sub">${esc(debt.id)} · ${esc(debt.next_due_date || debt.due_date || 'no due date')}</div>
          </div>

          <div class="debt-amount">${money(debt.remaining_amount)}</div>
        </div>

        <div>
          <div class="debt-progress" style="--paid-pct:${pct}%;">
            <div class="debt-progress-fill"></div>
          </div>
          <div class="debt-progress-copy">
            <span>Paid ${money(debt.paid_amount)}</span>
            <span>Original ${money(debt.original_amount)}</span>
          </div>
        </div>

        <div class="debt-tags">${renderDebtTags(debt)}</div>
        ${renderDebtBlockers(debt)}

        <div class="debt-card-actions">
          <button class="debt-action" type="button" data-select-debt="${esc(debt.id)}">Details</button>
          <button class="debt-action primary" type="button" data-edit-debt="${esc(debt.id)}">Edit</button>
          <button class="debt-action" type="button" data-pay-debt="${esc(debt.id)}">Payment</button>
          <button class="debt-action" type="button" data-defer-debt="${esc(debt.id)}">Defer</button>
          ${debt.ledger_required && !debt.ledger_linked ? `<button class="debt-action danger" type="button" data-repair-debt="${esc(debt.id)}">Repair Ledger</button>` : ''}
        </div>
      </article>
    `;
  }

  function renderDebtList() {
    const list = $('debtList');
    if (!list) return;

    const rows = filteredDebts();

    list.innerHTML = rows.length
      ? rows.map(renderDebtCard).join('')
      : '<div class="debt-empty">No debts match this filter.</div>';

    bindDebtCardActions();
  }

  function bindDebtCardActions() {
    document.querySelectorAll('[data-select-debt]').forEach(button => {
      button.addEventListener('click', () => selectDebt(button.getAttribute('data-select-debt')));
    });

    document.querySelectorAll('[data-edit-debt]').forEach(button => {
      button.addEventListener('click', () => openEditPanel(button.getAttribute('data-edit-debt')));
    });

    document.querySelectorAll('[data-pay-debt]').forEach(button => {
      button.addEventListener('click', () => openPaymentModal(button.getAttribute('data-pay-debt')));
    });

    document.querySelectorAll('[data-defer-debt]').forEach(button => {
      button.addEventListener('click', () => openDeferModal(button.getAttribute('data-defer-debt')));
    });

    document.querySelectorAll('[data-repair-debt]').forEach(button => {
      button.addEventListener('click', () => openRepairPanel(button.getAttribute('data-repair-debt')));
    });
  }

  function selectDebt(id) {
    state.selectedDebtId = id;
    renderDebtList();
    renderSelectedDebt();
  }

  function renderSelectedDebt() {
    const debt = selectedDebt();

    if (!debt) {
      setText('selectedDebtTitle', 'No debt selected');
      setText('selectedDebtSub', 'Select a debt to inspect schedule, linked ledger rows, and repair options.');
      setHTML('selectedDebtPanel', '<div class="debt-empty">No debt selected.</div>');
      return;
    }

    setText('selectedDebtTitle', debt.name);
    setText('selectedDebtSub', `${kindLabel(debt.kind)} · ${debt.id}`);

    setHTML('selectedDebtPanel', `
      ${row('Kind', 'Money direction', kindLabel(debt.kind), debt.kind === 'owed' ? 'positive' : 'danger')}
      ${row('Original amount', 'Debt principal', money(debt.original_amount))}
      ${row('Paid amount', 'Settled so far', money(debt.paid_amount))}
      ${row('Remaining', 'Backend remaining', money(debt.remaining_amount), debt.remaining_amount > 0 ? 'warning' : 'positive')}
      ${row('Status', 'Debt row status', debt.status || 'active')}
      ${row('Due status', 'Schedule state', debt.due_status || 'no schedule')}
      ${row('Next due', 'Computed backend due date', debt.next_due_date || '—')}
      ${row('Installment', 'Planned amount', debt.installment_amount == null ? '—' : money(debt.installment_amount))}
      ${row('Ledger linked', 'Origin movement', debt.ledger_linked ? 'Yes' : 'No', debt.ledger_linked ? 'positive' : 'danger')}
      ${row('Ledger transactions', 'Origin transaction IDs', debt.ledger_transaction_ids.length ? debt.ledger_transaction_ids.join(', ') : 'None')}
      ${debt.notes ? row('Notes', 'Backend notes', debt.notes) : ''}
    `);
  }

  function renderEnforcement() {
    setHTML('debtEnforcementPanel', `
      ${row('Debt create rule', 'If money moved now', 'account_id required', 'warning')}
      ${row('Owed to me', 'Backend ledger type', 'debt_out', 'danger')}
      ${row('I owe', 'Backend ledger type', 'debt_in', 'positive')}
      ${row('Atomicity', 'Backend contract', 'debt + ledger batch', 'positive')}
    `);
  }

  function renderDebug(extra) {
    setText('debtDebug', JSON.stringify({
      version: VERSION,
      filter: state.filter,
      selectedDebtId: state.selectedDebtId,
      debts: state.debts,
      accounts: state.accounts,
      health: state.health,
      extra: extra || null
    }, null, 2));
  }

  function renderAll(payload) {
    renderMetrics(payload || {});
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
  }

  function wireFilters() {
    document.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => setFilter(button.getAttribute('data-filter')));
    });
  }

  function openDebtModal() {
    resetDebtForm();

    const date = $('debtMovementDateInput');
    if (date && !date.value) date.value = todayISO();

    renderAccountOptions();
    updateDebtMovementCopy();
    openModal('debtModal');
  }

  function closeDebtModal() {
    closeModal('debtModal');
  }

  function resetDebtForm() {
    const form = $('addDebtForm');
    if (form) form.reset();

    const paid = $('debtPaidInput');
    if (paid) paid.value = '0';

    const movement = $('debtMovementNowInput');
    if (movement) movement.checked = true;

    const date = $('debtMovementDateInput');
    if (date) date.value = todayISO();
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
    const kind = $('debtKindInput')?.value || 'owed';

    return {
      name: clean($('debtNameInput')?.value),
      kind,
      original_amount: num($('debtOriginalInput')?.value),
      paid_amount: num($('debtPaidInput')?.value),
      due_date: clean($('debtDueDateInput')?.value) || null,
      due_day: clean($('debtDueDayInput')?.value) || null,
      installment_amount: clean($('debtInstallmentInput')?.value) || null,
      frequency: $('debtFrequencyInput')?.value || 'monthly',
      status: $('debtStatusInput')?.value || 'active',
      snowball_order: clean($('debtSnowballInput')?.value) || null,
      movement_now: movementNow,
      money_moved_now: movementNow,
      account_id: movementNow ? clean($('debtAccountInput')?.value) : '',
      movement_date: clean($('debtMovementDateInput')?.value) || todayISO(),
      notes: clean($('debtNotesInput')?.value),
      created_by: 'web-debts-v0.6.2'
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
        ${row('Dry-run', 'Debt create validation', result.ok ? 'Passed' : 'Failed', result.ok ? 'positive' : 'danger')}
        ${row('Expected debt rows', 'Backend proof', String(result.proof?.expected_debt_rows ?? '—'))}
        ${row('Expected ledger rows', 'Backend proof', String(result.proof?.expected_ledger_rows ?? '—'), result.proof?.expected_ledger_rows ? 'positive' : 'warning')}
        ${row('Write model', 'Backend contract', result.proof?.write_model || '—')}
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

      toast(result.ledger_transaction_id
        ? 'Debt saved with ledger movement.'
        : 'Debt saved without money movement.');

      closeDebtModal();
      await loadDebts();

      if (result.id) selectDebt(result.id);
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
      <form class="debt-form">
        ${row('Amount', 'Amount mutation is intentionally blocked in UI until backend supports safe amount+ledger correction.', money(debt.original_amount), 'warning')}

        <div class="debt-form-grid">
          <div class="debt-field">
            <label for="editDueDateInput">Due Date</label>
            <input class="debt-input" id="editDueDateInput" type="date" value="${esc(debt.due_date || '')}" />
          </div>

          <div class="debt-field">
            <label for="editDueDayInput">Due Day</label>
            <input class="debt-input" id="editDueDayInput" type="number" min="1" max="31" value="${esc(debt.due_day || '')}" />
          </div>

          <div class="debt-field">
            <label for="editInstallmentInput">Installment Amount</label>
            <input class="debt-input" id="editInstallmentInput" type="number" step="0.01" min="0" value="${esc(debt.installment_amount || '')}" />
          </div>

          <div class="debt-field">
            <label for="editFrequencyInput">Frequency</label>
            <select class="debt-select" id="editFrequencyInput">
              ${['monthly', 'weekly', 'yearly', 'custom'].map(f => `<option value="${f}" ${debt.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
          </div>

          <div class="debt-field debt-span-2">
            <label for="editNotesInput">Notes</label>
            <textarea class="debt-textarea" id="editNotesInput">${esc(debt.notes || '')}</textarea>
          </div>
        </div>

        <div class="debt-card-actions">
          <button class="debt-action primary" type="button" id="saveDebtEditBtn">Save Edit</button>
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
      setHTML('debtActionPanel', `<div class="debt-empty">Edit failed: ${esc(err.message)}</div>`);
    }
  }

  function openRepairPanel(id) {
    state.selectedDebtId = id;
    const debt = selectedDebt();
    if (!debt) return;

    renderSelectedDebt();
    renderAccountOptions();

    const copy = debt.kind === 'owed'
      ? 'Owed to me: choose the source account money left from. Backend writes debt_out and reduces this account.'
      : 'I owe: choose the destination account money entered into. Backend writes debt_in and increases this account.';

    setHTML('debtActionPanel', `
      <form class="debt-form">
        ${row('Debt', debt.id, `${esc(debt.name)} · ${money(debt.original_amount)}`)}
        ${row('Direction', 'Repair rule', debt.kind === 'owed' ? 'debt_out' : 'debt_in', debt.kind === 'owed' ? 'danger' : 'positive')}

        <div class="debt-field">
          <label for="repairAccountInput">Correct Account</label>
          <select class="debt-select" id="repairAccountInput">
            <option value="">Select account…</option>
          </select>
          <div class="debt-row-sub">${esc(copy)}</div>
        </div>

        <div class="debt-field">
          <label for="repairDateInput">Movement Date</label>
          <input class="debt-input" id="repairDateInput" type="date" value="${todayISO()}" />
        </div>

        <div class="debt-card-actions">
          <button class="debt-action" type="button" id="dryRunRepairBtn">Dry-run Repair</button>
          <button class="debt-action primary" type="button" id="commitRepairBtn">Commit Repair</button>
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
      debt_id: id,
      account_id: accountId,
      date: clean($('repairDateInput')?.value) || todayISO(),
      created_by: 'web-debts-v0.6.2'
    };

    try {
      const url = dryRun ? `${API_DEBTS}/repair-ledger?dry_run=1` : `${API_DEBTS}/repair-ledger`;
      const result = await postJSON(url, body);

      setHTML('debtActionPanel', `
        ${row(dryRun ? 'Dry-run repair' : 'Repair committed', 'Backend result', result.ok ? 'OK' : 'Failed', result.ok ? 'positive' : 'danger')}
        ${row('Ledger transaction', 'Origin movement row', result.ledger_transaction_id || result.proof?.ledger_transaction_id || 'pending')}
        ${row('Writes performed', 'Backend truth', String(Boolean(result.writes_performed)), result.writes_performed ? 'positive' : 'warning')}
        ${row('Rule', 'Money model', result.proof?.rule || result.proof?.write_model || '—')}
      `);

      toast(dryRun ? 'Repair dry-run passed.' : 'Repair committed.');

      if (!dryRun) {
        await loadDebts();
        selectDebt(id);
      }
    } catch (err) {
      setHTML('debtActionPanel', `<div class="debt-empty">Repair failed: ${esc(err.message)}</div>`);
    }
  }

  function openPaymentModal(id) {
    state.selectedDebtId = id;
    const debt = selectedDebt();

    if (!debt) return;

    $('paymentDebtIdInput').value = id;
    $('paymentAmountInput').value = debt.installment_amount || debt.remaining_amount || '';
    $('paymentDateInput').value = todayISO();
    $('paymentNotesInput').value = `${debt.name} · debt payment`;
    renderAccountOptions();

    openModal('paymentModal');
  }

  async function savePayment(dryRun) {
    const debtId = clean($('paymentDebtIdInput')?.value);

    if (!debtId) {
      toast('No debt selected.');
      return;
    }

    const body = {
      debt_id: debtId,
      amount: num($('paymentAmountInput')?.value),
      date: clean($('paymentDateInput')?.value) || todayISO(),
      account_id: clean($('paymentAccountInput')?.value),
      direction: $('paymentDirectionInput')?.value || 'auto',
      notes: clean($('paymentNotesInput')?.value),
      created_by: 'web-debts-v0.6.2'
    };

    if (!body.amount || body.amount <= 0) {
      toast('Payment amount must be greater than 0.');
      return;
    }

    if (!body.account_id) {
      toast('Select payment account.');
      return;
    }

    const attempts = [
      `${API_DEBTS}/payment${dryRun ? '?dry_run=1' : ''}`,
      `${API_DEBTS}/pay${dryRun ? '?dry_run=1' : ''}`,
      `${API_DEBTS}/${encodeURIComponent(debtId)}/payment${dryRun ? '?dry_run=1' : ''}`
    ];

    let lastError = null;

    for (const url of attempts) {
      try {
        await postJSON(url, body);
        toast(dryRun ? 'Payment dry-run passed.' : 'Payment saved.');
        if (!dryRun) {
          closeModal('paymentModal');
          await loadDebts();
          selectDebt(debtId);
        }
        return;
      } catch (err) {
        lastError = err;
      }
    }

    toast(`Payment endpoint unavailable: ${lastError ? lastError.message : 'unknown error'}`);
  }

  function openDeferModal(id) {
    state.selectedDebtId = id;
    const debt = selectedDebt();

    if (!debt) return;

    $('deferDebtIdInput').value = id;
    $('deferDueDateInput').value = debt.due_date || '';
    $('deferDueDayInput').value = debt.due_day || '';
    $('deferNotesInput').value = debt.notes || '';

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

    $('closeDebtModalBtn')?.addEventListener('click', closeDebtModal);
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

    if (!el) return;

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