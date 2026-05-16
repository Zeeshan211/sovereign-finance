/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.9.0-cycle-aware
 *
 * Live backend contract (consumed verbatim):
 *   /api/bills            v0.8.0-bills-engine-root-contract
 *     top:   ok, version, month, expected_this_cycle, paid_this_cycle,
 *            remaining, paid_count, partial_count, unpaid_count,
 *            ledger_reversed_excluded_count, count, bills,
 *            current_cycle, health, rules, contract
 *     bill:  id, name, amount, due_day, due_date, frequency,
 *            category_id, default_account_id, last_paid_date,
 *            last_paid_account_id, status, deleted_at, notes,
 *            created_at, updated_at, current_cycle, ledger_linked,
 *            ledger_reversed_excluded_count
 *   /api/bills/health     v1.2.0-bills-health-contract-aligned
 *     health: status, payment_rows, orphan_count,
 *             active_payment_reversed_txn_mismatch_count,
 *             missing_reversal_txn_count,
 *             duplicate_bill_month_amount_count,
 *             amount_mismatch_count, table_state, columns
 *
 * UI rules:
 *   - Frontend displays backend truth; no money recalculation.
 *   - Shared sf-* vocabulary only; no foreign panels.
 *   - All static HTML IDs in bills.html honored exactly.
 *
 * Behaviour for unknown backend support:
 *   - "Add New Bill" submits to POST /api/bills and shows backend's real reply.
 *   - "Repair Bills Health" submits to POST /api/bills/repair likewise.
 *   - If backend rejects, the user sees the verbatim backend error — no
 *     hardcoded "not supported" message. Honest contract probing.
 */
(function () {
  'use strict';

  const VERSION = 'v0.9.0-cycle-aware';
  const API_BILLS = '/api/bills';
  const API_BILLS_HEALTH = '/api/bills/health';
  const API_ACCOUNTS = '/api/accounts';

  const state = {
    payload: null,
    health: null,
    accounts: [],
    selectedBillId: null,
    loading: false,
    lastLoadedAt: null,
    actionsBound: false
  };

  const $  = (id) => document.getElementById(id);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setText(id, v) { const el = $(id); if (el) el.textContent = v == null ? '' : String(v); }
  function setHTML(id, v) { const el = $(id); if (el) el.innerHTML  = v == null ? '' : String(v); }
  function clean(v, fb = '') { return String(v == null ? fb : v).trim(); }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function currentMonth() { return new Date().toISOString().slice(0, 7); }
  function money(v) {
    const n = Number(v || 0);
    return 'Rs ' + n.toLocaleString('en-PK', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }
  function pill(text, tone) {
    const c = tone ? ` sf-pill--${esc(tone)}` : '';
    return `<span class="sf-pill${c}">${esc(text)}</span>`;
  }
  function toneForCycleStatus(s) {
    const v = String(s || '').toLowerCase();
    if (v === 'paid') return 'positive';
    if (v === 'partial') return 'warning';
    if (v === 'unpaid' || v === 'overdue') return 'danger';
    if (v === 'deleted') return 'danger';
    if (v === 'paused') return 'warning';
    return 'info';
  }
  function bills() {
    const arr = state.payload?.bills;
    return Array.isArray(arr) ? arr : [];
  }
  function activeBills() {
    return bills().filter((b) => b.status !== 'deleted');
  }
  function billCycleStatus(bill) {
    if (bill?.current_cycle?.status) return bill.current_cycle.status;
    if (bill?.payment_status) return bill.payment_status;
    if (bill?.last_paid_date && String(bill.last_paid_date).slice(0, 7) === currentMonth()) return 'paid';
    return 'unpaid';
  }

  async function fetchJSON(url, options) {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options?.headers || {}) },
      ...(options || {})
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; }
    catch { throw new Error(`Non-JSON from ${url}: HTTP ${res.status}`); }
    if (!res.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${res.status}`);
    }
    return payload;
  }
  const postJSON   = (u, b) => fetchJSON(u, { method: 'POST',   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const putJSON    = (u, b) => fetchJSON(u, { method: 'PUT',    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  const deleteJSON = (u)    => fetchJSON(u, { method: 'DELETE' });

  function accountRowsFromPayload(p) {
    if (!p) return [];
    if (Array.isArray(p.accounts)) return p.accounts;
    if (p.accounts && typeof p.accounts === 'object') return Object.values(p.accounts);
    if (Array.isArray(p.account_list)) return p.account_list;
    return [];
  }
  async function loadAccounts() {
    try {
      const p = await fetchJSON(API_ACCOUNTS);
      state.accounts = accountRowsFromPayload(p).filter(Boolean);
    } catch {
      state.accounts = [];
    }
    populateAccountSelects();
  }
  function populateAccountSelects() {
    const selects = qa('[data-bills-account-select]');
    if (!selects.length) return;
    const opts = ['<option value="">Choose account</option>'].concat(
      state.accounts.map((a) => {
        const id = a.id || a.account_id || '';
        const name = a.name || a.label || id;
        return `<option value="${esc(id)}">${esc(name)}</option>`;
      })
    ).join('');
    selects.forEach((sel) => {
      const current = sel.value;
      sel.innerHTML = opts;
      if (current) sel.value = current;
    });
  }

  async function loadBills() {
    if (state.loading) return;
    state.loading = true;
    setText('bills-state-pill', 'Loading');
    try {
      await loadAccounts();
      const month = currentMonth();
      state.payload = await fetchJSON(`${API_BILLS}?month=${encodeURIComponent(month)}`);
      try {
        const hp = await fetchJSON(API_BILLS_HEALTH);
        state.health = hp.health || null;
      } catch (err) {
        state.health = { status: 'unavailable', error: err.message };
      }
      state.lastLoadedAt = new Date();
      renderAll();
      setText('bills-state-pill', 'Loaded');
    } catch (err) {
      setText('bills-state-pill', 'Failed');
      setHTML('bills-list', `<div class="sf-empty-state sf-tone-danger"><div><h3 class="sf-card-title">Bills failed to load</h3><p class="sf-card-subtitle">${esc(err.message)}</p></div></div>`);
      setHTML('bills-health-panel', `<div class="sf-empty-state sf-tone-danger"><div><h3 class="sf-card-title">Health unavailable</h3><p class="sf-card-subtitle">${esc(err.message)}</p></div></div>`);
      renderHeaderPills();
      renderDebug();
    } finally {
      state.loading = false;
    }
  }

  function renderHeaderPills() {
    const last = state.lastLoadedAt
      ? `Last loaded: ${state.lastLoadedAt.toLocaleTimeString()}`
      : 'Last loaded: never';
    setText('bills-last-loaded', last);
    setText('bills-count-pill', `${state.payload?.count ?? activeBills().length} active bills`);
    const h = state.health?.status || 'unknown';
    setText('bills-health-pill', `health ${h}`);
  }

  // In-page Bills Summary — backend truth only.
  function renderSummary() {
    const p = state.payload || {};
    setText('bills-expected-this-cycle', money(p.expected_this_cycle ?? 0));
    setText('bills-paid-this-cycle', money(p.paid_this_cycle ?? 0));
    setText('bills-remaining', money(p.remaining ?? 0));
    setText('bills-status-counts', `${p.paid_count ?? 0} / ${p.partial_count ?? 0} / ${p.unpaid_count ?? 0}`);
    setText('bills-ledger-reversed-excluded', String(p.ledger_reversed_excluded_count ?? 0));
    setText('bills-health-status', state.health?.status || 'unknown');
  }

  // Shell KPI tiles — refresh via SFShell.setKpis (canonical pattern).
  function renderShellKpis() {
    if (!window.SFShell || typeof window.SFShell.setKpis !== 'function') return;
    const p = state.payload || {};
    const h = state.health?.status || 'unknown';
    const healthTone = h === 'pass' ? 'positive' : h === 'warn' ? 'warning' : h === 'unavailable' ? 'danger' : 'info';
    const remainingTone = Number(p.remaining || 0) > 0 ? 'warning' : 'positive';
    try {
      window.SFShell.setKpis([
        { title: 'Expected This Cycle', kicker: 'Bills',
          value: money(p.expected_this_cycle ?? 0),
          subtitle: `Total expected bills for ${p.month || currentMonth()}`,
          foot: `From /api/bills · backend ${p.version || 'unknown'}` },
        { title: 'Paid This Cycle', kicker: 'Ledger-linked',
          value: money(p.paid_this_cycle ?? 0),
          subtitle: `${p.paid_count ?? 0} paid · ${p.partial_count ?? 0} partial`,
          foot: 'Reversed ledger payments excluded',
          tone: 'positive' },
        { title: 'Remaining', kicker: 'Pressure',
          value: money(p.remaining ?? 0),
          subtitle: `${p.unpaid_count ?? 0} unpaid bills this cycle`,
          foot: 'Backend current_cycle truth',
          tone: remainingTone },
        { title: 'Bills Health', kicker: 'Integrity',
          value: h,
          subtitle: 'Payment and ledger consistency',
          foot: 'From /api/bills/health',
          tone: healthTone }
      ]);
    } catch (err) {
      console.warn('[bills.js] shell KPI refresh failed', err);
    }
  }

  function renderBillsList() {
    const list = $('bills-list');
    if (!list) return;
    const rows = bills();
    if (!rows.length) {
      list.innerHTML = `<div class="sf-empty-state"><div><h3 class="sf-card-title">No bills</h3><p class="sf-card-subtitle">Backend returned an empty bills array.</p></div></div>`;
      return;
    }
    list.innerHTML = rows.map(renderBillRow).join('');
    qa('[data-bill-row]', list).forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedBillId = row.getAttribute('data-bill-row');
        renderBillsList();
        renderSelected();
        prefillPaymentForm();
      });
    });
  }

  function renderBillRow(bill) {
    const selected = String(bill.id) === String(state.selectedBillId);
    const cycle = bill.current_cycle || {};
    const status = bill.status === 'deleted' ? 'deleted' : billCycleStatus(bill);
    const tone = toneForCycleStatus(status);
    const subBits = [
      `Due day ${bill.due_day || '—'}`,
      bill.frequency || 'monthly',
      `acct ${bill.last_paid_account_id || bill.default_account_id || '—'}`,
      `cat ${bill.category_id || '—'}`
    ];
    if (bill.last_paid_date) subBits.push(`last paid ${bill.last_paid_date}`);
    if (bill.ledger_linked) subBits.push('ledger linked');
    const cyclePaid = cycle.paid_amount;
    const cycleRem  = cycle.remaining_amount;
    const cycleLine = (cyclePaid != null || cycleRem != null)
      ? `<div class="sf-row-subtitle">${esc(`paid ${money(cyclePaid ?? 0)} · remaining ${money(cycleRem ?? 0)}`)}</div>`
      : '';
    return `
      <div class="sf-finance-row${selected ? ' is-selected' : ''}" data-bill-row="${esc(bill.id)}" role="button" tabindex="0">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(bill.name || bill.id)}</div>
          <div class="sf-row-subtitle">${esc(subBits.join(' · '))}</div>
          ${cycleLine}
        </div>
        <div class="sf-row-right">
          ${money(bill.amount)} &middot; ${pill(status, tone)}
        </div>
      </div>
    `;
  }

  function renderSelected() {
    const panel = $('bills-selected-panel');
    if (!panel) return;
    const bill = bills().find((b) => String(b.id) === String(state.selectedBillId));
    if (!bill) {
      panel.innerHTML = `<div class="sf-loading-state"><div><h3 class="sf-card-title">No bill selected</h3><p class="sf-card-subtitle">Select a bill from the list.</p></div></div>`;
      return;
    }
    const cycle = bill.current_cycle || {};
    const rows = [
      ['Bill ID',           bill.id],
      ['Name',              bill.name || '—'],
      ['Amount',            money(bill.amount)],
      ['Cycle status',      billCycleStatus(bill)],
      ['Cycle paid',        money(cycle.paid_amount ?? 0)],
      ['Cycle remaining',   money(cycle.remaining_amount ?? 0)],
      ['Due day',           bill.due_day != null ? String(bill.due_day) : '—'],
      ['Due date',          bill.due_date || '—'],
      ['Frequency',         bill.frequency || '—'],
      ['Category',          bill.category_id || '—'],
      ['Default account',   bill.default_account_id || '—'],
      ['Last paid date',    bill.last_paid_date || '—'],
      ['Last paid account', bill.last_paid_account_id || '—'],
      ['Ledger linked',     bill.ledger_linked ? 'Yes' : 'No'],
      ['Reversed excluded', String(bill.ledger_reversed_excluded_count ?? 0)],
      ['Status',            bill.status || 'active']
    ];
    const rowsHtml = rows.map(([label, value]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left"><div class="sf-row-title">${esc(label)}</div></div>
        <div class="sf-row-right">${esc(value)}</div>
      </div>
    `).join('');
    panel.innerHTML = `
      ${rowsHtml}
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">Actions</div>
          <div class="sf-row-subtitle">PUT /api/bills/:id · DELETE /api/bills/:id</div>
        </div>
        <div class="sf-row-right">
          <button class="sf-button" type="button" data-edit-bill="${esc(bill.id)}">Edit amount</button>
          <button class="sf-button" type="button" data-delete-bill="${esc(bill.id)}">Soft-delete</button>
        </div>
      </div>
    `;
    qa('[data-edit-bill]', panel).forEach((b) => b.addEventListener('click', () => editBillAmount(bill)));
    qa('[data-delete-bill]', panel).forEach((b) => b.addEventListener('click', () => softDeleteBill(bill)));
  }

  async function editBillAmount(bill) {
    const next = window.prompt(`Edit amount for "${bill.name}" (current: ${bill.amount}):`, String(bill.amount ?? ''));
    if (next == null) return;
    const numeric = Number(next);
    if (!Number.isFinite(numeric) || numeric < 0) { window.alert('Amount must be a non-negative number.'); return; }
    try {
      await putJSON(`${API_BILLS}/${encodeURIComponent(bill.id)}`, { amount: numeric });
      state.selectedBillId = bill.id;
      await loadBills();
    } catch (err) { window.alert(`Edit failed: ${err.message}`); }
  }
  async function softDeleteBill(bill) {
    if (!window.confirm(`Soft-delete bill "${bill.name}"? Status will be set to 'deleted'.`)) return;
    try {
      await deleteJSON(`${API_BILLS}/${encodeURIComponent(bill.id)}`);
      state.selectedBillId = null;
      await loadBills();
    } catch (err) { window.alert(`Delete failed: ${err.message}`); }
  }

  function prefillPaymentForm() {
    const bill = bills().find((b) => String(b.id) === String(state.selectedBillId));
    const nameInput = $('bill-payment-name');
    const amountInput = $('bill-payment-amount');
    const dateInput = $('bill-payment-date');
    const accountSel = $('bill-payment-account');
    const stateSpan = $('bills-payment-state');
    if (!bill) {
      if (nameInput) nameInput.value = '';
      if (stateSpan) stateSpan.textContent = 'Select bill';
      return;
    }
    if (nameInput) nameInput.value = `${bill.name} (${bill.id})`;
    const cycleRemaining = bill.current_cycle?.remaining_amount;
    if (amountInput && !amountInput.value) amountInput.value = (cycleRemaining != null ? cycleRemaining : bill.amount) || '';
    if (dateInput && !dateInput.value) dateInput.value = todayISO();
    if (accountSel && !accountSel.value) accountSel.value = bill.default_account_id || '';
    if (stateSpan) stateSpan.textContent = 'Ready';
  }

  function renderHealthPanel() {
    const panel = $('bills-health-panel');
    if (!panel) return;
    const h = state.health || {};
    const rows = [
      ['Status',                          String(h.status || 'unknown'),
        h.status === 'pass' ? 'positive' : h.status === 'warn' ? 'warning' : 'danger'],
      ['Payment rows scanned',            String(h.payment_rows ?? h.payment_count ?? '—')],
      ['Orphan payments (no txn)',        String(h.orphan_count ?? 0), Number(h.orphan_count) ? 'danger' : 'positive'],
      ['Active payments w/ reversed txn', String(h.active_payment_reversed_txn_mismatch_count ?? 0), Number(h.active_payment_reversed_txn_mismatch_count) ? 'danger' : 'positive'],
      ['Reversed missing reversal txn',   String(h.missing_reversal_txn_count ?? 0), Number(h.missing_reversal_txn_count) ? 'danger' : 'positive'],
      ['Duplicate bill/month/amount',     String(h.duplicate_bill_month_amount_count ?? 0), Number(h.duplicate_bill_month_amount_count) ? 'warning' : 'positive'],
      ['Amount mismatches',               String(h.amount_mismatch_count ?? 0), Number(h.amount_mismatch_count) ? 'danger' : 'positive'],
      ['Table state',                     String(h.table_state ?? '—')]
    ];
    panel.innerHTML = rows.map(([label, value, tone]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left"><div class="sf-row-title">${esc(label)}</div></div>
        <div class="sf-row-right${tone ? ' sf-tone-' + esc(tone) : ''}">${esc(value)}</div>
      </div>
    `).join('');
  }

  function renderDebug() {
    setText('bills-debug-output', JSON.stringify({
      uiVersion: VERSION,
      backendVersion: state.payload?.version,
      month: state.payload?.month,
      totals: {
        expected: state.payload?.expected_this_cycle,
        paid: state.payload?.paid_this_cycle,
        remaining: state.payload?.remaining
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
    renderDebug();
    prefillPaymentForm();
  }

  // ---- Add New Bill — POST /api/bills, let backend decide -----------------
  function wireAddForm() {
    const form = $('bills-add-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const stateSpan = $('bills-add-state');
      const payload = {
        name: clean($('bill-add-name')?.value),
        amount: Number($('bill-add-amount')?.value || 0),
        due_day: Number($('bill-add-due-day')?.value || 0) || null,
        frequency: clean($('bill-add-frequency')?.value) || 'monthly',
        default_account_id: clean($('bill-add-default-account')?.value) || null,
        category_id: clean($('bill-add-category')?.value) || 'bills_utilities',
        notes: clean($('bill-add-notes')?.value) || null,
        created_by: 'bills-ui-' + VERSION
      };
      if (!payload.name) { if (stateSpan) stateSpan.textContent = 'Name required'; window.alert('Bill name is required.'); return; }
      if (!Number.isFinite(payload.amount) || payload.amount <= 0) { if (stateSpan) stateSpan.textContent = 'Bad amount'; window.alert('Expected amount must be greater than zero.'); return; }
      if (stateSpan) stateSpan.textContent = 'Saving';
      try {
        const res = await postJSON(API_BILLS, payload);
        if (stateSpan) stateSpan.textContent = 'Saved';
        form.reset();
        const newId = res?.bill?.id || res?.id || null;
        if (newId) state.selectedBillId = newId;
        await loadBills();
      } catch (err) {
        if (stateSpan) stateSpan.textContent = 'Failed';
        window.alert(`Add Bill failed:\n\n${err.message}\n\nThis message is the backend's verbatim response. If the route does not accept POST /api/bills yet, that's a backend-phase task.`);
      }
    });
  }

  // ---- Pay Selected Bill — POST /api/bills/:id/pay ------------------------
  function wirePaymentForm() {
    const form = $('bills-payment-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const bill = bills().find((b) => String(b.id) === String(state.selectedBillId));
      const stateSpan = $('bills-payment-state');
      if (!bill) { if (stateSpan) stateSpan.textContent = 'Select a bill'; window.alert('Select a bill from the list before recording a payment.'); return; }
      const amount = Number($('bill-payment-amount')?.value || 0);
      const paid_date = clean($('bill-payment-date')?.value) || todayISO();
      const account = clean($('bill-payment-account')?.value);
      const notes = clean($('bill-payment-notes')?.value);
      if (!Number.isFinite(amount) || amount <= 0) { if (stateSpan) stateSpan.textContent = 'Bad amount'; window.alert('Payment amount must be greater than zero.'); return; }
      if (!account) { if (stateSpan) stateSpan.textContent = 'Account required'; window.alert('Pick the account the payment was made from.'); return; }
      if (stateSpan) stateSpan.textContent = 'Saving';
      try {
        await postJSON(`${API_BILLS}/${encodeURIComponent(bill.id)}/pay`, {
          paid_date,
          amount,
          account_id: account,
          notes,
          created_by: 'bills-ui-' + VERSION
        });
        if (stateSpan) stateSpan.textContent = 'Saved';
        form.reset();
        state.selectedBillId = bill.id;
        await loadBills();
      } catch (err) {
        if (stateSpan) stateSpan.textContent = 'Failed';
        window.alert(`Pay Bill failed:\n\n${err.message}`);
      }
    });
    $('bill-payment-clear')?.addEventListener('click', () => {
      const stateSpan = $('bills-payment-state');
      if (stateSpan) stateSpan.textContent = 'Cleared';
    });
  }

  // ---- Shell actions — delegated, survive shell re-mounts -----------------
  function wireShellActionsOnce() {
    if (state.actionsBound) return;
    state.actionsBound = true;
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#bills-refresh-btn')) { event.preventDefault(); loadBills(); return; }
      if (target.closest('#bills-repair-btn')) {
        event.preventDefault();
        try {
          const res = await postJSON(`${API_BILLS}/repair`, {});
          window.alert(`Repair OK:\n\n${JSON.stringify(res, null, 2)}`);
          await loadBills();
        } catch (err) {
          window.alert(`Repair failed:\n\n${err.message}\n\nIf the backend has no /api/bills/repair endpoint at v0.8.0, this is the verbatim backend reply.`);
        }
      }
    });
  }

  function init() {
    wireShellActionsOnce();
    wireAddForm();
    wirePaymentForm();
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
