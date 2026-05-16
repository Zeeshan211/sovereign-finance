/* js/bills.js
 * Sovereign Finance · Bills UI
 * v0.10.2-honest-errors
 *
 * Delta vs v0.10.1:
 *   - fetchJSON extracts payload.error.message verbatim from backend
 *   - On failure, raw response body logged to console for diagnostics
 *   - Add modal: due_day defaults to today's day (no nulls into NOT NULL columns)
 *   - Add modal: category_id always sent, notes never null
 *   - submitAddBill logs payload + raw error
 * All v0.10.1 hero compression, chip flex, modal/toast/expand/sort/search preserved.
 */
(function () {
  'use strict';

  const VERSION = 'v0.10.2-honest-errors';
  const API_BILLS = '/api/bills';
  const API_BILLS_HEALTH = '/api/bills/health';
  const API_ACCOUNTS = '/api/accounts';
  const SEARCH_DEBOUNCE_MS = 180;

  const state = {
    payload: null, health: null, accounts: [],
    selectedBillId: null, expandedBillIds: new Set(),
    loading: false, lastLoadedAt: null, actionsBound: false,
    filter: 'all', sort: 'due_day_asc', search: '', activeModal: null
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
  function todayISO()   { return new Date().toISOString().slice(0, 10); }
  function todayDay()   { return new Date().getDate(); }
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
  function debounce(fn, ms) {
    let t = null;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }
  function bills() {
    const arr = state.payload?.bills;
    return Array.isArray(arr) ? arr : [];
  }
  function activeBills() { return bills().filter((b) => b.status !== 'deleted'); }
  function billCycleStatus(bill) {
    if (bill?.current_cycle?.status) return bill.current_cycle.status;
    if (bill?.payment_status) return bill.payment_status;
    if (bill?.last_paid_date && String(bill.last_paid_date).slice(0, 7) === currentMonth()) return 'paid';
    return 'unpaid';
  }
  function dueDateForBill(bill) {
    if (bill?.due_date) return bill.due_date;
    const day = Number(bill?.due_day || 0);
    if (!day) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, 28));
    return d.toISOString().slice(0, 10);
  }
  function daysUntilDue(bill) {
    const iso = dueDateForBill(bill);
    if (!iso) return null;
    const due = new Date(iso + 'T00:00:00');
    const today = new Date(todayISO() + 'T00:00:00');
    return Math.round((due - today) / 86400000);
  }
  function paidPercent(bill) {
    const expected = Number(bill?.amount || bill?.current_cycle?.expected_amount || 0);
    const paid = Number(bill?.current_cycle?.paid_amount || 0);
    if (!expected || expected <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((paid / expected) * 100)));
  }

  /**
   * ─── HONEST ERROR EXTRACTION ───
   * Backend always wraps errors as { ok:false, version, error:{ code, message } }.
   * Pull the human-readable message verbatim. Log raw response on failure so the
   * user can see exactly what came back.
   */
  function extractErrorMessage(payload, status, rawText) {
    if (payload && payload.error) {
      const e = payload.error;
      if (typeof e === 'string') return e;
      if (e.message) return e.code ? `${e.code}: ${e.message}` : e.message;
      if (e.code) return e.code;
      try { return JSON.stringify(e); } catch (_) { return String(e); }
    }
    if (payload && payload.message) return payload.message;
    if (rawText && rawText.length && rawText.length < 400) return `HTTP ${status}: ${rawText}`;
    return `HTTP ${status}`;
  }
  async function fetchJSON(url, options) {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(options?.headers || {}) },
      ...(options || {})
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok || !payload || payload.ok === false) {
      // Console diagnostic so user can paste exact backend response
      try {
        console.error('[bills.js] fetch failed', {
          url, status: res.status, payload, rawText: text.slice(0, 800)
        });
      } catch (_) {}
      throw new Error(extractErrorMessage(payload, res.status, text));
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
    } catch { state.accounts = []; }
    populateAccountSelects();
  }
  function accountOptionsHtml(selectedId) {
    return ['<option value="">Choose account</option>'].concat(
      state.accounts.map((a) => {
        const id = a.id || a.account_id || '';
        const name = a.name || a.label || id;
        const sel = String(id) === String(selectedId || '') ? ' selected' : '';
        return `<option value="${esc(id)}"${sel}>${esc(name)}</option>`;
      })
    ).join('');
  }
  function populateAccountSelects() {
    qa('[data-bills-account-select]').forEach((sel) => {
      const current = sel.value;
      sel.innerHTML = accountOptionsHtml(current);
      if (current) sel.value = current;
    });
  }
  function accountName(id) {
    if (!id) return '—';
    const found = state.accounts.find((a) => String(a.id || a.account_id) === String(id));
    return found ? (found.name || found.label || id) : id;
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
      toast(`Load failed: ${err.message}`, 'danger');
    } finally {
      state.loading = false;
    }
  }

  function applyToolbar(rows) {
    let out = rows.slice();
    const f = state.filter;
    const inWeek = (b) => { const d = daysUntilDue(b); return d != null && d >= 0 && d <= 7; };
    if (f === 'unpaid')             out = out.filter((b) => billCycleStatus(b) === 'unpaid' && b.status !== 'deleted');
    else if (f === 'partial')       out = out.filter((b) => billCycleStatus(b) === 'partial' && b.status !== 'deleted');
    else if (f === 'paid')          out = out.filter((b) => billCycleStatus(b) === 'paid' && b.status !== 'deleted');
    else if (f === 'due_this_week') out = out.filter((b) => b.status !== 'deleted' && inWeek(b));
    else if (f === 'ledger_reversed') out = out.filter((b) => Number(b.ledger_reversed_excluded_count || 0) > 0);
    else if (f === 'deleted')       out = out.filter((b) => b.status === 'deleted');
    else                            out = out.filter((b) => b.status !== 'deleted');

    const q = state.search.trim().toLowerCase();
    if (q) {
      out = out.filter((b) => {
        const fields = [b.id, b.name, b.notes, b.category_id, b.default_account_id, b.last_paid_account_id]
          .map((v) => String(v == null ? '' : v).toLowerCase());
        return fields.some((s) => s.includes(q));
      });
    }

    const s = state.sort;
    const cmp = (a, b, key, dir = 1) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
    };
    if (s === 'amount_desc')           out.sort((a, b) => cmp(a, b, 'amount', -1));
    else if (s === 'name_asc')         out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    else if (s === 'last_paid_desc')   out.sort((a, b) => cmp(a, b, 'last_paid_date', -1));
    else if (s === 'created_desc')     out.sort((a, b) => cmp(a, b, 'created_at', -1));
    else                               out.sort((a, b) => (Number(a.due_day || 99) - Number(b.due_day || 99)));
    return out;
  }
  function setFilter(f) {
    state.filter = f;
    qa('[data-bills-filter]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-bills-filter') === f);
    });
    setText('bills-filter-pill', f.replace(/_/g, ' '));
    renderBillsList();
  }
  function setSort(s)   { state.sort = s; renderBillsList(); }
  function setSearch(q) { state.search = q || ''; renderBillsList(); }

  function wireToolbar() {
    const toolbar = $('bills-toolbar');
    if (toolbar && toolbar.hasAttribute('hidden')) toolbar.removeAttribute('hidden');
    qa('[data-bills-filter]').forEach((btn) => {
      btn.addEventListener('click', () => setFilter(btn.getAttribute('data-bills-filter')));
    });
    const search = $('bills-search-input');
    if (search) search.addEventListener('input', debounce((e) => setSearch(e.target.value), SEARCH_DEBOUNCE_MS));
    const sort = $('bills-sort-select');
    if (sort) sort.addEventListener('change', (e) => setSort(e.target.value));
  }

  function renderHeaderPills() {
    const last = state.lastLoadedAt ? `Last loaded: ${state.lastLoadedAt.toLocaleTimeString()}` : 'Last loaded: never';
    setText('bills-last-loaded', last);
    const total = state.payload?.count ?? activeBills().length;
    setText('bills-count-pill', `${total} bills`);
    const h = state.health?.status || 'unknown';
    setText('bills-health-pill', `health ${h}`);
  }

  function renderSummary() {
    const p = state.payload || {};
    setText('bills-expected-this-cycle', money(p.expected_this_cycle ?? 0));
    setText('bills-paid-this-cycle', money(p.paid_this_cycle ?? 0));
    setText('bills-remaining', money(p.remaining ?? 0));
    setText('bills-status-counts', `${p.paid_count ?? 0} / ${p.partial_count ?? 0} / ${p.unpaid_count ?? 0}`);
    setText('bills-ledger-reversed-excluded', String(p.ledger_reversed_excluded_count ?? 0));
    setText('bills-health-status', state.health?.status || 'unknown');
  }

  function renderShellKpis() {
    if (!window.SFShell || typeof window.SFShell.setKpis !== 'function') return;
    const p = state.payload || {};
    const h = state.health?.status || 'unknown';
    const healthTone   = h === 'pass' ? 'positive' : h === 'warn' ? 'warning' : h === 'unavailable' ? 'danger' : 'info';
    const remainingTone = Number(p.remaining || 0) > 0 ? 'warning' : 'positive';
    try {
      window.SFShell.setKpis([
        { title: 'Expected', kicker: 'Cycle', value: money(p.expected_this_cycle ?? 0),
          subtitle: p.month || currentMonth(), foot: `Backend ${p.version || 'unknown'}` },
        { title: 'Paid', kicker: 'Ledger-linked', value: money(p.paid_this_cycle ?? 0),
          subtitle: `${p.paid_count ?? 0} paid · ${p.partial_count ?? 0} partial`, foot: 'Reversed excluded', tone: 'positive' },
        { title: 'Remaining', kicker: 'Pressure', value: money(p.remaining ?? 0),
          subtitle: `${p.unpaid_count ?? 0} unpaid`, foot: 'Backend cycle truth', tone: remainingTone },
        { title: 'Health', kicker: 'Integrity', value: h,
          subtitle: 'Payment / ledger', foot: '/api/bills/health', tone: healthTone }
      ]);
    } catch (err) { console.warn('[bills.js] shell KPI refresh failed', err); }
  }

  function dueLabel(bill) {
    const iso = dueDateForBill(bill);
    if (!iso) return 'no due day';
    const d = daysUntilDue(bill);
    if (d == null) return iso;
    if (d === 0) return 'due today';
    if (d > 0)   return `in ${d}d · ${iso.slice(5)}`;
    return `${Math.abs(d)}d overdue · ${iso.slice(5)}`;
  }
  function billIcon(bill) {
    const cat = String(bill.category_id || '').toLowerCase();
    if (cat.includes('rent') || cat.includes('home') || cat.includes('house')) return '🏠';
    if (cat.includes('internet') || cat.includes('utility') || cat.includes('utilities')) return '💡';
    if (cat.includes('school') || cat.includes('edu')) return '🎓';
    if (cat.includes('subscription')) return '📺';
    if (cat.includes('insurance')) return '🛡️';
    if (cat.includes('phone') || cat.includes('mobile')) return '📱';
    if (cat.includes('family') || cat.includes('help')) return '👨‍👩‍👧';
    return '🧾';
  }
  function renderBillsList() {
    const list = $('bills-list');
    if (!list) return;
    const all = bills();
    if (!all.length) {
      list.innerHTML = `<div class="sf-empty-state"><div><h3 class="sf-card-title">No bills</h3><p class="sf-card-subtitle">Backend returned an empty bills array.</p></div></div>`;
      return;
    }
    const filtered = applyToolbar(all);
    if (!filtered.length) {
      list.innerHTML = `<div class="sf-empty-state"><div><h3 class="sf-card-title">No bills match</h3><p class="sf-card-subtitle">Filter “${esc(state.filter)}”${state.search ? ` + search “${esc(state.search)}”` : ''} returned 0 of ${all.length}.</p></div></div>`;
      return;
    }
    list.innerHTML = filtered.map(renderBillRow).join('');

    qa('[data-bill-row-shell]', list).forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-bill-action]')) return;
        toggleExpand(row.getAttribute('data-bill-row-shell'));
      });
    });
    qa('[data-bill-action="pay"]',     list).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openPayModal(b.getAttribute('data-bill-id')); }));
    qa('[data-bill-action="edit"]',    list).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(b.getAttribute('data-bill-id')); }));
    qa('[data-bill-action="defer"]',   list).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openDeferModal(b.getAttribute('data-bill-id')); }));
    qa('[data-bill-action="delete"]',  list).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); softDeleteBill(b.getAttribute('data-bill-id')); }));
    qa('[data-bill-action="restore"]', list).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); restoreBill(b.getAttribute('data-bill-id')); }));
  }
  function toggleExpand(id) {
    if (state.expandedBillIds.has(String(id))) state.expandedBillIds.delete(String(id));
    else state.expandedBillIds.add(String(id));
    state.selectedBillId = id;
    renderBillsList();
    renderSelected();
    prefillPaymentForm();
  }
  function renderBillRow(bill) {
    const id = String(bill.id);
    const expanded = state.expandedBillIds.has(id);
    const status = bill.status === 'deleted' ? 'deleted' : billCycleStatus(bill);
    const tone = toneForCycleStatus(status);
    const pct = paidPercent(bill);
    const cycle = bill.current_cycle || {};
    const tags = [];
    if (bill.ledger_linked) tags.push(pill('ledger', 'info'));
    const reversed = Number(bill.ledger_reversed_excluded_count || 0);
    if (reversed > 0) tags.push(pill(`reversed ${reversed}`, 'warning'));
    if (bill.status === 'paused') tags.push(pill('paused', 'warning'));
    const detail = expanded ? renderInlineDetail(bill, cycle) : '';
    return `
      <div class="bill-card${expanded ? ' is-open' : ''}" data-bill-card="${esc(id)}">
        <div class="bill-row-shell" data-bill-row-shell="${esc(id)}" role="button" tabindex="0" aria-expanded="${expanded}">
          <div class="bill-row-icon">${billIcon(bill)}</div>
          <div class="bill-row-main">
            <div class="bill-row-title">${esc(bill.name || bill.id)}</div>
            <div class="bill-row-sub">${esc(dueLabel(bill))} · ${esc(bill.frequency || 'monthly')} · ${esc(accountName(bill.last_paid_account_id || bill.default_account_id))}</div>
            <div class="bill-progress"><div class="bill-progress-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="bill-row-amount">${money(bill.amount)}</div>
          <div class="bill-row-status">${pill(status, tone)}${tags.length ? ' ' + tags.join(' ') : ''}</div>
          <div class="bill-row-caret" aria-hidden="true">${expanded ? '▾' : '▸'}</div>
        </div>
        ${detail}
      </div>
    `;
  }
  function renderInlineDetail(bill, cycle) {
    const cells = [
      ['Bill ID',         esc(bill.id)],
      ['Amount',          money(bill.amount)],
      ['Cycle paid',      money(cycle.paid_amount ?? 0)],
      ['Cycle remaining', money(cycle.remaining_amount ?? 0)],
      ['Due day',         bill.due_day != null ? String(bill.due_day) : '—'],
      ['Due date',        esc(bill.due_date || dueDateForBill(bill) || '—')],
      ['Frequency',       esc(bill.frequency || '—')],
      ['Category',        esc(bill.category_id || '—')],
      ['Default account', esc(accountName(bill.default_account_id))],
      ['Last paid',       esc(bill.last_paid_date || '—')],
      ['Last paid acct',  esc(accountName(bill.last_paid_account_id))],
      ['Ledger linked',   bill.ledger_linked ? 'Yes' : 'No'],
      ['Reversed excl',   String(bill.ledger_reversed_excluded_count ?? 0)],
      ['Status',          esc(bill.status || 'active')]
    ];
    const isDeleted = bill.status === 'deleted';
    const actions = isDeleted
      ? `<button class="sf-button" type="button" data-bill-action="restore" data-bill-id="${esc(bill.id)}">Restore</button>`
      : `
        <button class="sf-button sf-button--primary" type="button" data-bill-action="pay"    data-bill-id="${esc(bill.id)}">Pay</button>
        <button class="sf-button"                    type="button" data-bill-action="edit"   data-bill-id="${esc(bill.id)}">Edit</button>
        <button class="sf-button"                    type="button" data-bill-action="defer"  data-bill-id="${esc(bill.id)}">Defer</button>
        <button class="sf-button"                    type="button" data-bill-action="delete" data-bill-id="${esc(bill.id)}">Soft-delete</button>
      `;
    const notes = bill.notes ? `<div class="bill-inline-notes">${esc(bill.notes)}</div>` : '';
    return `
      <div class="bill-inline-detail">
        <div class="bill-inline-grid">
          ${cells.map(([k, v]) => `<div class="bill-inline-cell"><span class="bill-inline-k">${esc(k)}</span><span class="bill-inline-v">${v}</span></div>`).join('')}
        </div>
        ${notes}
        <div class="bill-inline-actions">${actions}</div>
      </div>
    `;
  }

  function renderSelected() {
    const panel = $('bills-selected-panel');
    if (!panel) return;
    const bill = bills().find((b) => String(b.id) === String(state.selectedBillId));
    if (!bill) {
      panel.innerHTML = `<div class="sf-loading-state"><div><h3 class="sf-card-title">No bill selected</h3><p class="sf-card-subtitle">Click a bill to expand its detail. The sidebar tracks the last selection.</p></div></div>`;
      return;
    }
    const cycle = bill.current_cycle || {};
    const rows = [
      ['Name',            bill.name || '—'],
      ['Cycle status',    billCycleStatus(bill)],
      ['Amount',          money(bill.amount)],
      ['Cycle paid',      money(cycle.paid_amount ?? 0)],
      ['Cycle remaining', money(cycle.remaining_amount ?? 0)],
      ['Due',             dueLabel(bill)],
      ['Last paid',       bill.last_paid_date || '—'],
      ['Default account', accountName(bill.default_account_id)],
      ['Status',          bill.status || 'active']
    ];
    panel.innerHTML = rows.map(([k, v]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left"><div class="sf-row-title">${esc(k)}</div></div>
        <div class="sf-row-right">${esc(v)}</div>
      </div>
    `).join('');
  }

  function renderHealthPanel() {
    const panel = $('bills-health-panel');
    if (!panel) return;
    const h = state.health || {};
    const rows = [
      ['Status',                          String(h.status || 'unknown'),
        h.status === 'pass' ? 'positive' : h.status === 'warn' ? 'warning' : 'danger'],
      ['Payment rows scanned',            String(h.payment_rows ?? '—')],
      ['Orphan payments (no txn)',        String(h.orphan_count ?? 0), Number(h.orphan_count) ? 'danger' : 'positive'],
      ['Active payments w/ reversed txn', String(h.active_payment_reversed_txn_mismatch_count ?? 0), Number(h.active_payment_reversed_txn_mismatch_count) ? 'danger' : 'positive'],
      ['Reversed missing reversal txn',   String(h.missing_reversal_txn_count ?? 0), Number(h.missing_reversal_txn_count) ? 'danger' : 'positive'],
      ['Duplicate bill/month/amount',     String(h.duplicate_bill_month_amount_count ?? 0), Number(h.duplicate_bill_month_amount_count) ? 'warning' : 'positive'],
      ['Amount mismatches',               String(h.amount_mismatch_count ?? 0), Number(h.amount_mismatch_count) ? 'danger' : 'positive'],
      ['Table state',                     String(h.table_state ?? '—')]
    ];
    panel.innerHTML = rows.map(([k, v, t]) => `
      <div class="sf-finance-row">
        <div class="sf-row-left"><div class="sf-row-title">${esc(k)}</div></div>
        <div class="sf-row-right${t ? ' sf-tone-' + esc(t) : ''}">${esc(v)}</div>
      </div>
    `).join('');
  }

  function renderDebug() {
    setText('bills-debug-output', JSON.stringify({
      uiVersion: VERSION, backendVersion: state.payload?.version, month: state.payload?.month,
      filter: state.filter, sort: state.sort, search: state.search,
      totals: { expected: state.payload?.expected_this_cycle, paid: state.payload?.paid_this_cycle, remaining: state.payload?.remaining },
      counts: { bills: bills().length, active: activeBills().length, paid: state.payload?.paid_count, partial: state.payload?.partial_count, unpaid: state.payload?.unpaid_count, ledger_reversed_excluded: state.payload?.ledger_reversed_excluded_count },
      health: state.health, selectedBillId: state.selectedBillId,
      expanded: Array.from(state.expandedBillIds), lastLoadedAt: state.lastLoadedAt
    }, null, 2));
  }

  function renderAll() {
    renderHeaderPills(); renderShellKpis(); renderSummary();
    renderBillsList(); renderSelected(); renderHealthPanel(); renderDebug();
    prefillPaymentForm();
  }

  function prefillPaymentForm() {
    const bill = bills().find((b) => String(b.id) === String(state.selectedBillId));
    const nameInput = $('bill-payment-name'); const amountInput = $('bill-payment-amount');
    const dateInput = $('bill-payment-date'); const accountSel = $('bill-payment-account');
    const stateSpan = $('bills-payment-state');
    if (!bill) { if (nameInput) nameInput.value = ''; if (stateSpan) stateSpan.textContent = 'Select bill'; return; }
    if (nameInput) nameInput.value = `${bill.name} (${bill.id})`;
    const cycleRemaining = bill.current_cycle?.remaining_amount;
    if (amountInput && !amountInput.value) amountInput.value = (cycleRemaining != null ? cycleRemaining : bill.amount) || '';
    if (dateInput && !dateInput.value)   dateInput.value = todayISO();
    if (accountSel && !accountSel.value) accountSel.value = bill.default_account_id || '';
    if (stateSpan) stateSpan.textContent = 'Ready';
  }
  function wireInlineForms() {
    const addForm = $('bills-add-form');
    if (addForm) addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitAddBill(formToAddPayload(addForm), $('bills-add-state'));
    });
    const payForm = $('bills-payment-form');
    if (payForm) payForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bill = bills().find((b) => String(b.id) === String(state.selectedBillId));
      if (!bill) { toast('Select a bill first.', 'warning'); return; }
      await submitPay(bill, formToPayPayload(payForm), $('bills-payment-state'));
    });
    $('bill-payment-clear')?.addEventListener('click', () => setText('bills-payment-state', 'Cleared'));
    const section = $('bills-inline-forms-section');
    if (section && !section.hasAttribute('hidden')) section.setAttribute('hidden', '');
  }

  /**
   * ─── ADD-BILL PAYLOAD: SAFE DEFAULTS ───
   * Backend createBill writes the row through filterToColumns(), so unknown
   * keys are stripped — safe. But it does NOT null-coalesce against NOT NULL
   * columns. We send safe defaults so a blank due_day / category does not
   * collide with NOT NULL constraints in production.
   */
  function formToAddPayload(form) {
    const name = clean(form.elements.name?.value);
    const amount = Number(form.elements.amount?.value || 0);
    const due_day = Number(form.elements.due_day?.value || 0) || todayDay();
    const frequency = clean(form.elements.frequency?.value) || 'monthly';
    const default_account_id = clean(form.elements.default_account_id?.value) || null;
    const category_id = clean(form.elements.category_id?.value) || 'bills_utilities';
    const notes = clean(form.elements.notes?.value) || '';
    return {
      name, amount, due_day, frequency, default_account_id, category_id, notes,
      created_by: 'bills-ui-' + VERSION
    };
  }
  function formToPayPayload(form) {
    return {
      amount: Number(form.elements.amount?.value || 0),
      paid_date: clean(form.elements.paid_date?.value) || todayISO(),
      account_id: clean(form.elements.account_id?.value),
      notes: clean(form.elements.notes?.value) || '',
      created_by: 'bills-ui-' + VERSION
    };
  }

  async function submitAddBill(payload, stateSpan) {
    if (!payload.name) { toast('Bill name required.', 'warning'); return; }
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) { toast('Expected amount must be > 0.', 'warning'); return; }
    if (stateSpan) stateSpan.textContent = 'Saving';
    try {
      console.log('[bills.js] add payload', payload);
      const res = await postJSON(API_BILLS, payload);
      console.log('[bills.js] add response', res);
      const newId = res?.bill?.id || res?.id || null;
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
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) { toast('Payment amount must be > 0.', 'warning'); return; }
    if (!payload.account_id) { toast('Pick the payment account.', 'warning'); return; }
    if (stateSpan) stateSpan.textContent = 'Saving';
    try {
      await postJSON(`${API_BILLS}/pay`, {
        bill_id: bill.id,
        amount: payload.amount,
        account_id: payload.account_id,
        date: payload.paid_date,
        notes: payload.notes,
        created_by: 'bills-ui-' + VERSION
      });
      if (stateSpan) stateSpan.textContent = 'Saved';
      closeModal('pay');
      state.selectedBillId = bill.id;
      await loadBills();
      toast(`Paid ${money(payload.amount)} on "${bill.name}".`, 'positive');
    } catch (err) {
      if (stateSpan) stateSpan.textContent = 'Failed';
      toast(`Pay failed: ${err.message}`, 'danger');
    }
  }
  async function submitEdit(bill, updates) {
    try {
      await postJSON(`${API_BILLS}/update`, { bill_id: bill.id, ...updates });
      closeModal('edit');
      state.selectedBillId = bill.id;
      await loadBills();
      toast(`Updated "${bill.name}".`, 'positive');
    } catch (err) { toast(`Edit failed: ${err.message}`, 'danger'); }
  }
  async function submitDefer(bill, payload) {
    try {
      await postJSON(`${API_BILLS}/defer`, { bill_id: bill.id, ...payload });
      closeModal('defer');
      state.selectedBillId = bill.id;
      await loadBills();
      toast(`Deferred "${bill.name}".`, 'positive');
    } catch (err) { toast(`Defer failed: ${err.message}`, 'danger'); }
  }
  async function softDeleteBill(billId) {
    const bill = bills().find((b) => String(b.id) === String(billId));
    if (!bill) return;
    if (!window.confirm(`Soft-delete "${bill.name}"? Status will be 'deleted'.`)) return;
    try {
      await postJSON(`${API_BILLS}/update`, { bill_id: bill.id, status: 'deleted' });
      if (String(state.selectedBillId) === String(billId)) state.selectedBillId = null;
      state.expandedBillIds.delete(String(billId));
      await loadBills();
      toast(`Soft-deleted "${bill.name}".`, 'positive');
    } catch (err) { toast(`Delete failed: ${err.message}`, 'danger'); }
  }
  async function restoreBill(billId) {
    const bill = bills().find((b) => String(b.id) === String(billId));
    if (!bill) return;
    try {
      await postJSON(`${API_BILLS}/update`, { bill_id: bill.id, status: 'active' });
      await loadBills();
      toast(`Restored "${bill.name}".`, 'positive');
    } catch (err) { toast(`Restore failed: ${err.message}`, 'danger'); }
  }

  function openModal(name, bodyHtml) {
    const el = $(`bills-${name}-modal`);
    const body = $(`bills-${name}-modal-body`);
    if (!el || !body) return false;
    body.innerHTML = bodyHtml;
    el.removeAttribute('hidden');
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
    state.activeModal = name;
    populateAccountSelects();
    const focusable = body.querySelector('input, select, textarea, button');
    if (focusable) try { focusable.focus(); } catch (_) {}
    return true;
  }
  function closeModal(name) {
    const target = name || state.activeModal;
    if (!target) return;
    const el = $(`bills-${target}-modal`);
    if (!el) return;
    el.setAttribute('hidden', '');
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
    const body = $(`bills-${target}-modal-body`);
    if (body) body.innerHTML = '';
    state.activeModal = null;
  }
  function wireModalChrome() {
    qa('[data-bills-modal-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-bills-modal-close')));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.activeModal) closeModal();
    });
  }
  function openAddModal() {
    const dDay = todayDay();
    openModal('add', `
      <form class="sf-form-grid" data-bills-modal-form="add">
        <label class="sf-field sf-span-12"><span>Bill name</span><input name="name" type="text" autocomplete="off" placeholder="Internet Bill, Rent, School Fee" required></label>
        <label class="sf-field sf-span-6"><span>Expected amount (Rs)</span><input name="amount" type="number" inputmode="decimal" min="0" step="0.01" required></label>
        <label class="sf-field sf-span-6"><span>Due day (1–31)</span><input name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${dDay}" required></label>
        <label class="sf-field sf-span-6"><span>Frequency</span>
          <select name="frequency"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="custom">Custom</option></select>
        </label>
        <label class="sf-field sf-span-6"><span>Default account</span>
          <select name="default_account_id" data-bills-account-select><option value="">Choose when paying</option></select>
        </label>
        <label class="sf-field sf-span-12"><span>Category</span><input name="category_id" type="text" value="bills_utilities" required></label>
        <label class="sf-field sf-span-12"><span>Notes</span><textarea name="notes" rows="2" placeholder="Optional note"></textarea></label>
        <div class="sf-form-actions sf-span-12">
          <button class="sf-button sf-button--primary" type="submit">Add Bill</button>
          <button class="sf-button" type="button" data-bills-modal-close="add">Cancel</button>
        </div>
      </form>
    `);
    const form = qa('[data-bills-modal-form="add"]')[0];
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitAddBill(formToAddPayload(form), null);
    });
  }
  function openPayModal(billIdOverride) {
    const targetId = billIdOverride != null ? billIdOverride : state.selectedBillId;
    const bill = bills().find((b) => String(b.id) === String(targetId));
    if (!bill) { toast('Select a bill first.', 'warning'); return; }
    state.selectedBillId = bill.id;
    const cycle = bill.current_cycle || {};
    const defaultAmount = cycle.remaining_amount != null ? cycle.remaining_amount : bill.amount;
    openModal('pay', `
      <div class="bill-modal-context">
        <div class="bill-modal-context-title">${esc(bill.name)}</div>
        <div class="bill-modal-context-sub">${esc(dueLabel(bill))} · expected ${money(bill.amount)} · remaining ${money(cycle.remaining_amount ?? 0)}</div>
      </div>
      <form class="sf-form-grid" data-bills-modal-form="pay">
        <label class="sf-field sf-span-6"><span>Payment amount</span><input name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(defaultAmount ?? '')}" required></label>
        <label class="sf-field sf-span-6"><span>Payment date</span><input name="paid_date" type="date" value="${esc(todayISO())}"></label>
        <label class="sf-field sf-span-12"><span>Pay from account</span>
          <select name="account_id" data-bills-account-select required><option value="">Choose account</option></select>
        </label>
        <label class="sf-field sf-span-12"><span>Notes</span><textarea name="notes" rows="2" placeholder="Optional payment note"></textarea></label>
        <div class="sf-form-actions sf-span-12">
          <button class="sf-button sf-button--primary" type="submit">Confirm Payment</button>
          <button class="sf-button" type="button" data-bills-modal-close="pay">Cancel</button>
        </div>
      </form>
    `);
    const sel = $('bills-pay-modal-body').querySelector('select[name="account_id"]');
    if (sel) sel.value = bill.default_account_id || '';
    const form = qa('[data-bills-modal-form="pay"]')[0];
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitPay(bill, formToPayPayload(form), null);
    });
  }
  function openEditModal(billId) {
    const bill = bills().find((b) => String(b.id) === String(billId));
    if (!bill) return;
    openModal('edit', `
      <div class="bill-modal-context">
        <div class="bill-modal-context-title">${esc(bill.name)}</div>
        <div class="bill-modal-context-sub">id ${esc(bill.id)} · status ${esc(bill.status || 'active')}</div>
      </div>
      <form class="sf-form-grid" data-bills-modal-form="edit">
        <label class="sf-field sf-span-12"><span>Bill name</span><input name="name" type="text" value="${esc(bill.name || '')}"></label>
        <label class="sf-field sf-span-6"><span>Expected amount</span><input name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(bill.amount ?? '')}"></label>
        <label class="sf-field sf-span-6"><span>Due day</span><input name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${esc(bill.due_day ?? '')}"></label>
        <label class="sf-field sf-span-6"><span>Frequency</span>
          <select name="frequency">
            ${['monthly','weekly','custom'].map((f) => `<option value="${f}"${f === (bill.frequency || 'monthly') ? ' selected' : ''}>${f}</option>`).join('')}
          </select>
        </label>
        <label class="sf-field sf-span-6"><span>Default account</span>
          <select name="default_account_id" data-bills-account-select><option value="">Choose when paying</option></select>
        </label>
        <label class="sf-field sf-span-12"><span>Category</span><input name="category_id" type="text" value="${esc(bill.category_id || '')}"></label>
        <label class="sf-field sf-span-12"><span>Notes</span><textarea name="notes" rows="2">${esc(bill.notes || '')}</textarea></label>
        <label class="sf-field sf-span-12"><span>Status</span>
          <select name="status">
            ${['active','paused','deleted'].map((s) => `<option value="${s}"${s === (bill.status || 'active') ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <div class="sf-form-actions sf-span-12">
          <button class="sf-button sf-button--primary" type="submit">Save Changes</button>
          <button class="sf-button" type="button" data-bills-modal-close="edit">Cancel</button>
        </div>
      </form>
    `);
    const sel = $('bills-edit-modal-body').querySelector('select[name="default_account_id"]');
    if (sel) sel.value = bill.default_account_id || '';
    const form = qa('[data-bills-modal-form="edit"]')[0];
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const updates = {
        name: clean(form.elements.name?.value),
        amount: Number(form.elements.amount?.value || 0),
        due_day: Number(form.elements.due_day?.value || 0) || null,
        frequency: clean(form.elements.frequency?.value) || 'monthly',
        default_account_id: clean(form.elements.default_account_id?.value) || null,
        category_id: clean(form.elements.category_id?.value) || null,
        notes: clean(form.elements.notes?.value) || '',
        status: clean(form.elements.status?.value) || 'active'
      };
      await submitEdit(bill, updates);
    });
  }
  function openDeferModal(billId) {
    const bill = bills().find((b) => String(b.id) === String(billId));
    if (!bill) return;
    openModal('defer', `
      <div class="bill-modal-context">
        <div class="bill-modal-context-title">${esc(bill.name)}</div>
        <div class="bill-modal-context-sub">current due day ${esc(bill.due_day ?? '—')}</div>
      </div>
      <form class="sf-form-grid" data-bills-modal-form="defer">
        <label class="sf-field sf-span-12"><span>New due day</span><input name="due_day" type="number" inputmode="numeric" min="1" max="31" value="${esc(bill.due_day ?? '')}"></label>
        <label class="sf-field sf-span-12"><span>Notes</span><textarea name="notes" rows="2" placeholder="Why are you deferring?"></textarea></label>
        <div class="sf-form-actions sf-span-12">
          <button class="sf-button sf-button--primary" type="submit">Defer</button>
          <button class="sf-button" type="button" data-bills-modal-close="defer">Cancel</button>
        </div>
      </form>
    `);
    const form = qa('[data-bills-modal-form="defer"]')[0];
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const due_day = Number(form.elements.due_day?.value || 0) || null;
      const notes = clean(form.elements.notes?.value);
      if (!due_day) { toast('Provide a new due day (1–31).', 'warning'); return; }
      await submitDefer(bill, { due_day, notes });
    });
  }

  let toastTimer = null;
  function toast(message, tone) {
    const el = $('bills-toast');
    if (!el) { console.log('[bills-toast]', message); return; }
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

  function wireShellActionsOnce() {
    if (state.actionsBound) return;
    state.actionsBound = true;
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#bills-refresh-btn'))         { event.preventDefault(); loadBills(); return; }
      if (target.closest('#bills-open-add-modal-btn'))  { event.preventDefault(); openAddModal(); return; }
      if (target.closest('#bills-open-pay-modal-btn'))  { event.preventDefault(); openPayModal(); return; }
      if (target.closest('#bills-repair-btn')) {
        event.preventDefault();
        try {
          const res = await postJSON(`${API_BILLS}/repair`, {});
          toast(`Repair OK · ${JSON.stringify(res?.summary || res || {}).slice(0, 120)}`, 'positive');
          await loadBills();
        } catch (err) {
          toast(`Repair: ${err.message}`, 'danger');
        }
      }
    });
  }

  function injectStyles() {
    const old = document.querySelector('style[data-bills-styles]');
    if (old) old.remove();
    const css = `
      body:has(#bills-toolbar) .sf-shell-hero,
      body:has(#bills-toolbar) .sf-page-hero,
      body:has(#bills-toolbar) [data-sf-hero],
      body:has(#bills-toolbar) header[role="banner"] { padding-block: 14px !important; }
      body:has(#bills-toolbar) .sf-shell-hero .sf-section-subtitle,
      body:has(#bills-toolbar) .sf-page-hero .sf-section-subtitle,
      body:has(#bills-toolbar) [data-sf-hero] .sf-section-subtitle { margin-top: 4px !important; font-size: 12px !important; opacity: .7 !important; }
      body:has(#bills-toolbar) .sf-shell-hero h1,
      body:has(#bills-toolbar) .sf-page-hero h1,
      body:has(#bills-toolbar) [data-sf-hero] h1 { font-size: 26px !important; line-height: 1.1 !important; margin: 0 !important; }
      body:has(#bills-toolbar) .sf-kpi-strip,
      body:has(#bills-toolbar) .sf-kpi-grid,
      body:has(#bills-toolbar) [data-sf-kpis] { padding-block: 8px !important; gap: 10px !important; }
      body:has(#bills-toolbar) .sf-metric-card,
      body:has(#bills-toolbar) .sf-kpi-card,
      body:has(#bills-toolbar) [data-sf-kpi] { padding: 10px 12px !important; min-height: 0 !important; }
      body:has(#bills-toolbar) .sf-metric-card .sf-metric-value,
      body:has(#bills-toolbar) .sf-kpi-card .sf-metric-value,
      body:has(#bills-toolbar) [data-sf-kpi] .sf-metric-value { font-size: 20px !important; line-height: 1.15 !important; margin: 2px 0 !important; }
      body:has(#bills-toolbar) .sf-metric-card .sf-metric-title,
      body:has(#bills-toolbar) .sf-metric-card .sf-metric-kicker,
      body:has(#bills-toolbar) .sf-metric-card .sf-metric-subtitle,
      body:has(#bills-toolbar) .sf-metric-card .sf-metric-foot { font-size: 11px !important; line-height: 1.2 !important; opacity: .7 !important; }
      body:has(#bills-toolbar) .sf-shell-actions,
      body:has(#bills-toolbar) [data-sf-actions] { gap: 6px !important; padding-block: 6px !important; }
      body:has(#bills-toolbar) .sf-shell-actions .sf-button,
      body:has(#bills-toolbar) [data-sf-actions] .sf-button { padding: 6px 12px !important; font-size: 12px !important; min-height: 30px !important; }

      #bills-filter-chips { display: flex !important; flex-wrap: wrap !important; gap: 8px !important; align-items: center !important; }
      #bills-filter-chips > .sf-button { display: inline-flex !important; width: auto !important; flex: 0 0 auto !important; }
      #bills-toolbar .sf-form-grid { row-gap: 10px !important; }
      #bills-toolbar { padding: 12px 14px !important; }
      #bills-toolbar .sf-section-head { margin-bottom: 8px !important; }
      #bills-toolbar .sf-section-title { font-size: 14px !important; }
      #bills-toolbar .sf-section-subtitle { display: none !important; }
      #bills-toolbar .sf-section-kicker { font-size: 10px !important; }

      .bill-card { border: 1px solid var(--sf-border, rgba(255,255,255,0.08)); border-radius: var(--sf-radius-md, 14px); background: var(--sf-surface, rgba(255,255,255,0.03)); margin-bottom: 8px; transition: border-color 120ms ease; }
      .bill-card:hover { border-color: var(--sf-border-strong, rgba(255,255,255,0.18)); }
      .bill-card.is-open { border-color: var(--sf-accent, #6ea8ff); background: var(--sf-surface-strong, rgba(255,255,255,0.05)); }
      .bill-row-shell { display: grid; grid-template-columns: 34px minmax(220px, 1.6fr) 110px 86px 20px; gap: 12px; align-items: center; padding: 10px 14px; cursor: pointer; }
      .bill-row-icon { font-size: 20px; line-height: 1; text-align: center; }
      .bill-row-main { min-width: 0; }
      .bill-row-title { font-weight: 600; font-size: 14px; line-height: 1.25; color: var(--sf-text, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bill-row-sub { font-size: 12px; opacity: 0.7; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bill-row-amount { font-weight: 600; font-size: 14px; text-align: right; }
      .bill-row-status { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
      .bill-row-caret { font-size: 12px; opacity: 0.5; text-align: center; }
      .bill-progress { margin-top: 6px; height: 4px; background: var(--sf-track, rgba(255,255,255,0.08)); border-radius: 999px; overflow: hidden; }
      .bill-progress-fill { height: 100%; background: var(--sf-accent, #6ea8ff); transition: width 200ms ease; }
      .bill-inline-detail { padding: 0 14px 14px; border-top: 1px solid var(--sf-border, rgba(255,255,255,0.08)); }
      .bill-inline-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; padding: 12px 0; }
      .bill-inline-cell { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--sf-track, rgba(255,255,255,0.04)); border-radius: 8px; }
      .bill-inline-k { font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.04em; }
      .bill-inline-v { font-size: 13px; font-weight: 500; }
      .bill-inline-notes { font-size: 12px; opacity: 0.75; margin: 6px 0 10px; padding: 8px 10px; background: var(--sf-track, rgba(255,255,255,0.04)); border-radius: 8px; white-space: pre-wrap; }
      .bill-inline-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; }
      .sf-button--chip { padding: 6px 12px; font-size: 12px; border-radius: 999px; }
      .sf-button--chip.is-active { background: var(--sf-accent, #6ea8ff); color: var(--sf-on-accent, #0b0f1a); border-color: transparent; }
      .sf-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px 16px; }
      .sf-modal[hidden] { display: none !important; }
      .sf-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); }
      .sf-modal-card { position: relative; width: min(560px, 100%); max-height: 88vh; overflow: auto; background: var(--sf-surface-strong, #131826); border: 1px solid var(--sf-border, rgba(255,255,255,0.12)); border-radius: var(--sf-radius-lg, 16px); padding: 18px 18px 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
      .bill-modal-context { padding: 10px 12px; margin-bottom: 12px; background: var(--sf-track, rgba(255,255,255,0.04)); border-radius: 10px; }
      .bill-modal-context-title { font-weight: 600; font-size: 14px; }
      .bill-modal-context-sub { font-size: 12px; opacity: 0.7; margin-top: 2px; }
      .sf-toast { position: fixed; right: 16px; bottom: 16px; z-index: 1100; padding: 10px 14px; background: var(--sf-surface-strong, #131826); border: 1px solid var(--sf-border, rgba(255,255,255,0.18)); border-radius: 10px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); transform: translateY(8px); opacity: 0; transition: transform 180ms ease, opacity 180ms ease; max-width: 380px; white-space: pre-wrap; }
      .sf-toast.is-open { transform: translateY(0); opacity: 1; }
      .sf-toast--positive { border-color: rgba(80,200,120,0.6); }
      .sf-toast--warning  { border-color: rgba(240,180,80,0.6); }
      .sf-toast--danger   { border-color: rgba(240,90,90,0.7); }
      @media (max-width: 640px) {
        .bill-row-shell { grid-template-columns: 28px 1fr 92px 18px; row-gap: 4px; }
        .bill-row-amount { grid-column: 3 / 4; }
        .bill-row-status { grid-column: 1 / 4; justify-content: flex-start; }
        .bill-row-caret  { grid-column: 4 / 5; }
      }
    `;
    const style = document.createElement('style');
    style.setAttribute('data-bills-styles', VERSION);
    style.textContent = css;
    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
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
      state: () => JSON.parse(JSON.stringify(state, (k, v) => v instanceof Set ? Array.from(v) : v))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
