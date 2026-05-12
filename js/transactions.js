/* ─── transactions.js · Sovereign Finance Ledger Console · v0.8.0 ───
 *
 * Frontend rule:
 * - Backend owns truth.
 * - UI only renders backend metadata.
 * - No direct edit/delete.
 * - Reversal requires reason.
 * - Intl packages and linked pairs are grouped from backend fields.
 */

window.editTransaction = function () {
  alert('Editing is disabled to preserve the audit trail.\n\nUse Reverse to correct a transaction.');
  return false;
};

window.deleteTransaction = function () {
  alert('Direct delete is disabled to preserve the audit trail.\n\nUse Reverse to correct a transaction.');
  return false;
};

(function () {
  'use strict';

  const API_TXNS = '/api/transactions?limit=500';
  const API_TXNS_ALL = '/api/transactions?include_reversed=1&limit=500';
  const API_HEALTH = '/api/transactions/health';
  const API_ACCOUNTS = '/api/accounts';
  const API_REVERSE = '/api/transactions/reverse';

  const TYPE_IN = new Set(['income', 'borrow', 'salary', 'opening', 'debt_in']);
  const TYPE_OUT = new Set(['expense', 'cc_spend', 'repay', 'atm', 'debt_out']);
  const TYPE_NEUTRAL = new Set(['transfer', 'cc_payment']);

  const TYPE_ICON = {
    expense: '💸',
    income: '💰',
    transfer: '⇄',
    cc_payment: '💳',
    cc_spend: '💳',
    borrow: '📥',
    repay: '📤',
    atm: '🏧',
    salary: '🏦',
    opening: '📌',
    debt_in: '↘',
    debt_out: '↗'
  };

  const TYPE_LABEL = {
    expense: 'Expense',
    income: 'Income',
    transfer: 'Transfer',
    cc_payment: 'CC Payment',
    cc_spend: 'CC Spend',
    borrow: 'Borrow',
    repay: 'Repay',
    atm: 'ATM',
    salary: 'Salary',
    opening: 'Opening',
    debt_in: 'Debt In',
    debt_out: 'Debt Out'
  };

  const state = {
    txns: [],
    allRows: [],
    accounts: [],
    health: null,
    hiddenReversalCount: 0,
    includeReversed: false,
    filters: {
      search: '',
      account: '',
      type: '',
      status: '',
      view: 'grouped'
    }
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

  function money(value, decimals) {
    const n = Number(value) || 0;
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: decimals ? 2 : 0,
      maximumFractionDigits: decimals ? 2 : 0
    });
  }

  function signedAmount(txn) {
    const amount = Number(txn.display_amount || txn.pkr_amount || txn.amount || 0);
    const type = String(txn.type || '').toLowerCase();

    if (TYPE_IN.has(type)) return amount;
    if (TYPE_OUT.has(type)) return -amount;
    if (type === 'transfer') return -amount;

    return amount;
  }

  function accountLabel(id) {
    const account = state.accounts.find(a => a.id === id);

    if (!account) return id || 'Unknown';

    return [account.icon || '', account.name || account.id].join(' ').trim();
  }

  function typeLabel(type) {
    return TYPE_LABEL[type] || String(type || 'unknown').replace(/_/g, ' ');
  }

  function typeIcon(type) {
    return TYPE_ICON[type] || '•';
  }

  function toast(message, kind) {
    let el = $('toast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.className = 'toast show ' + (kind === 'error' || kind === 'err' ? 'toast-error' : 'toast-success');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.className = 'toast';
    }, 3200);
  }

  async function getJSON(url) {
    const response = await fetch(url, {
      cache: 'no-store'
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ('HTTP ' + response.status));
    }

    return data;
  }

  function injectStyles() {
    if ($('ledger-console-style')) return;

    const style = document.createElement('style');
    style.id = 'ledger-console-style';
    style.textContent = `
      .ledger-console-list {
        display: grid;
        gap: 12px;
      }

      .ledger-row,
      .ledger-group-card {
        border: 1px solid var(--sf-border-subtle);
        border-radius: 18px;
        background: var(--sf-surface-1);
        padding: 14px;
        display: grid;
        gap: 10px;
      }

      .ledger-row.is-voided,
      .ledger-group-card.is-voided {
        opacity: .62;
        border-style: dashed;
      }

      .ledger-main-line {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
      }

      .ledger-icon {
        width: 40px;
        height: 40px;
        border-radius: 14px;
        display: grid;
        place-items: center;
        background: var(--sf-accent-soft);
        color: var(--sf-accent-strong);
        font-weight: 900;
      }

      .ledger-title {
        color: var(--sf-text);
        font-size: 14px;
        font-weight: 900;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ledger-sub {
        margin-top: 4px;
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.35;
      }

      .ledger-amount {
        color: var(--sf-text);
        text-align: right;
        font-size: 15px;
        font-weight: 900;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .ledger-amount.positive {
        color: var(--sf-positive);
      }

      .ledger-amount.negative {
        color: var(--sf-danger);
      }

      .ledger-amount.neutral {
        color: var(--sf-text-soft);
      }

      .ledger-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .ledger-tag {
        border: 1px solid var(--sf-border-subtle);
        border-radius: 999px;
        background: var(--sf-surface-2);
        color: var(--sf-text-muted);
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 800;
      }

      .ledger-tag.good {
        background: var(--sf-positive-soft);
        color: var(--sf-positive);
        border-color: rgba(83, 215, 167, .28);
      }

      .ledger-tag.warn {
        background: var(--sf-warning-soft);
        color: var(--sf-warning);
        border-color: rgba(241, 184, 87, .28);
      }

      .ledger-tag.danger {
        background: var(--sf-danger-soft);
        color: var(--sf-danger);
        border-color: rgba(255, 127, 138, .28);
      }

      .ledger-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }

      .ledger-action {
        border: 1px solid var(--sf-border);
        border-radius: 999px;
        background: var(--sf-surface-2);
        color: var(--sf-text-soft);
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 900;
        cursor: pointer;
      }

      .ledger-action.reverse {
        background: var(--sf-danger-soft);
        color: var(--sf-danger);
        border-color: rgba(255, 127, 138, .28);
      }

      .ledger-action:disabled {
        opacity: .45;
        cursor: not-allowed;
      }

      .ledger-children {
        display: none;
        border-top: 1px solid var(--sf-border-subtle);
        padding-top: 10px;
        gap: 8px;
      }

      .ledger-group-card.is-open .ledger-children {
        display: grid;
      }

      .ledger-child-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--sf-surface-2);
        color: var(--sf-text-muted);
        font-size: 12px;
      }

      .ledger-empty,
      .empty-state-inline {
        border: 1px dashed var(--sf-border);
        border-radius: 18px;
        padding: 20px;
        color: var(--sf-text-muted);
        background: var(--sf-surface-1);
      }

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

  function listContainer() {
    let el =
      $('txn-list') ||
      $('tx-list') ||
      $('ledger-list') ||
      $('activity-list') ||
      document.querySelector('[data-ledger-list]') ||
      document.querySelector('[data-transactions-list]');

    if (el) return el;

    const main =
      document.querySelector('main .sf-page-content') ||
      document.querySelector('main') ||
      document.body;

    el = document.createElement('div');
    el.id = 'txn-list';
    el.className = 'ledger-console-list';

    const panel = document.createElement('section');
    panel.className = 'sf-panel';
    panel.innerHTML = `
      <div class="sf-section-head">
        <div>
          <p class="sf-section-kicker">Activity</p>
          <h2 class="sf-section-title">Latest movements</h2>
          <p class="sf-section-subtitle">Injected ledger list because the page shell did not expose the expected container.</p>
        </div>
      </div>
    `;

    panel.appendChild(el);
    main.appendChild(panel);

    return el;
  }

  function setText(ids, value) {
    for (const id of ids) {
      const el = $(id);

      if (el) {
        el.textContent = value;
      }
    }
  }

  function setClass(ids, className) {
    for (const id of ids) {
      const el = $(id);

      if (el) {
        el.className = className;
      }
    }
  }

  async function loadAccounts() {
    try {
      const data = await getJSON(API_ACCOUNTS);
      state.accounts = data.accounts || [];
    } catch (err) {
      state.accounts = [];
      console.warn('[ledger] account load failed:', err.message);
    }

    fillAccountFilter();
  }

  function fillAccountFilter() {
    const select =
      $('filter_account') ||
      $('accountFilter') ||
      $('ledgerAccountFilter');

    if (!select) return;

    const current = select.value || '';

    select.innerHTML = '<option value="">All accounts</option>' + state.accounts.map(account => {
      const label = [account.icon || '', account.name || account.id].join(' ').trim();
      return `<option value="${esc(account.id)}">${esc(label)}</option>`;
    }).join('');

    select.value = current;
  }

  async function loadHealth() {
    try {
      const data = await getJSON(API_HEALTH);
      state.health = data.health || null;
    } catch (err) {
      state.health = null;
      console.warn('[ledger] health load failed:', err.message);
    }

    renderHealth();
  }

  async function loadTransactions() {
    const list = listContainer();

    list.classList.add('ledger-console-list');
    list.innerHTML = '<div class="ledger-empty">Loading ledger…</div>';

    const url = state.includeReversed ? API_TXNS_ALL : API_TXNS;
    const data = await getJSON(url);

    state.txns = data.transactions || [];
    state.hiddenReversalCount = Number(data.hidden_reversal_count) || 0;

    render();
  }

  async function loadAll() {
    try {
      await Promise.all([
        loadAccounts(),
        loadHealth()
      ]);

      await loadTransactions();
    } catch (err) {
      console.error('[ledger] load failed:', err);
      listContainer().innerHTML = '<div class="ledger-empty">Failed: ' + esc(err.message) + '</div>';
      toast('Ledger load failed: ' + err.message, 'error');
    }
  }

  function matchesSearch(txn, q) {
    if (!q) return true;

    const haystack = [
      txn.id,
      txn.date,
      txn.type,
      txn.account_id,
      txn.transfer_to_account_id,
      txn.category_id,
      txn.notes,
      txn.group_id,
      txn.group_type,
      txn.intl_package_id
    ].join(' ').toLowerCase();

    return haystack.includes(q);
  }

  function matchesType(txn, type) {
    if (!type) return true;

    const t = String(txn.type || '').toLowerCase();
    const category = String(txn.category_id || '').toLowerCase();
    const notes = String(txn.notes || '').toLowerCase();

    if (type === 'international') {
      return txn.group_type === 'intl_package' ||
        !!txn.intl_package_id ||
        notes.includes('[intl');
    }

    if (type === 'debt') {
      return t === 'repay' ||
        t === 'borrow' ||
        category.includes('debt') ||
        notes.includes('debt_id=');
    }

    if (type === 'bill') {
      return category.includes('bill') ||
        notes.includes('bill_id=') ||
        notes.includes('bill payment');
    }

    if (type === 'reversed') {
      return txn.is_reversed || txn.is_reversal;
    }

    return t === type;
  }

  function matchesStatus(txn, status) {
    if (!status) return true;

    if (status === 'reverse_eligible') return txn.reverse_eligible === true;
    if (status === 'reverse_blocked') return txn.reverse_eligible === false;
    if (status === 'grouped') return txn.group_type && txn.group_type !== 'single';
    if (status === 'reversed') return txn.is_reversed || txn.is_reversal;

    return true;
  }

  function filteredRows() {
    const q = state.filters.search.toLowerCase();

    return state.txns.filter(txn => {
      if (state.filters.account) {
        const accountMatch =
          txn.account_id === state.filters.account ||
          txn.transfer_to_account_id === state.filters.account;

        if (!accountMatch) return false;
      }

      if (!matchesType(txn, state.filters.type)) return false;
      if (!matchesStatus(txn, state.filters.status)) return false;
      if (!matchesSearch(txn, q)) return false;

      return true;
    });
  }

  function buildDisplayItems(rows) {
    if (state.filters.view === 'raw') {
      return rows.map(row => ({
        kind: 'row',
        id: row.id,
        row
      }));
    }

    const used = new Set();
    const items = [];

    const packageMap = new Map();

    for (const row of rows) {
      if (row.intl_package_id || row.group_type === 'intl_package') {
        const key = row.intl_package_id || row.group_id;

        if (!key) continue;

        if (!packageMap.has(key)) packageMap.set(key, []);
        packageMap.get(key).push(row);
      }
    }

    for (const [packageId, packageRows] of packageMap.entries()) {
      packageRows.forEach(row => used.add(row.id));

      items.push({
        kind: 'group',
        group_type: 'intl_package',
        id: packageId,
        rows: packageRows
      });
    }

    const byId = new Map(rows.map(row => [row.id, row]));

    for (const row of rows) {
      if (used.has(row.id)) continue;

      if (row.group_type === 'linked_pair' && row.group_id && byId.has(row.group_id)) {
        const mate = byId.get(row.group_id);
        const key = [row.id, mate.id].sort().join('::');

        if (used.has(key)) continue;

        used.add(row.id);
        used.add(mate.id);
        used.add(key);

        items.push({
          kind: 'group',
          group_type: detectLinkedGroupType([row, mate]),
          id: key,
          rows: [row, mate]
        });

        continue;
      }

      used.add(row.id);

      items.push({
        kind: 'row',
        id: row.id,
        row
      });
    }

    return items.sort((a, b) => {
      const ad = itemDate(a);
      const bd = itemDate(b);

      if (ad !== bd) return bd.localeCompare(ad);

      return itemCreatedAt(b).localeCompare(itemCreatedAt(a));
    });
  }

  function detectLinkedGroupType(rows) {
    const joined = rows.map(r => String(r.notes || '') + ' ' + String(r.type || '')).join(' ').toLowerCase();

    if (joined.includes('[atm_withdraw]')) return 'atm_withdrawal';
    if (joined.includes('cc paydown') || joined.includes('alfalah cc')) return 'cc_payment_pair';

    return 'linked_pair';
  }

  function itemDate(item) {
    if (item.kind === 'row') return String(item.row.date || '');
    return String(item.rows[0] && item.rows[0].date || '');
  }

  function itemCreatedAt(item) {
    if (item.kind === 'row') return String(item.row.created_at || '');
    return String(item.rows[0] && item.rows[0].created_at || '');
  }

  function render() {
    const rows = filteredRows();
    const items = buildDisplayItems(rows);

    renderMetrics(rows, items);
    renderHealth();

    const list = listContainer();
    list.classList.add('ledger-console-list');

    if (!items.length) {
      list.innerHTML = '<div class="ledger-empty">No transactions match current filters.</div>';
      return;
    }

    list.innerHTML = items.map(renderItem).join('');

    list.querySelectorAll('[data-toggle-group]').forEach(button => {
      button.addEventListener('click', () => {
        const card = button.closest('.ledger-group-card');
        if (!card) return;

        card.classList.toggle('is-open');
        button.textContent = card.classList.contains('is-open') ? 'Collapse' : 'Expand';
      });
    });

    list.querySelectorAll('[data-reverse-id]').forEach(button => {
      button.addEventListener('click', onReverse);
    });
  }

  function renderMetrics(rows, items) {
    const totalIn = rows
      .filter(txn => TYPE_IN.has(String(txn.type || '').toLowerCase()))
      .reduce((sum, txn) => sum + Number(txn.display_amount || txn.amount || 0), 0);

    const totalOut = rows
      .filter(txn => TYPE_OUT.has(String(txn.type || '').toLowerCase()) || txn.type === 'transfer')
      .reduce((sum, txn) => sum + Number(txn.display_amount || txn.amount || 0), 0);

    const net = rows.reduce((sum, txn) => sum + signedAmount(txn), 0);
    const reverseEligible = rows.filter(txn => txn.reverse_eligible === true).length;

    setText(['t_count', 'ledgerCount', 'activityCount'], String(items.length));
    setText(['t_in', 'moneyIn', 'ledgerMoneyIn'], money(totalIn));
    setText(['t_out', 'moneyOut', 'ledgerMoneyOut'], money(totalOut));
    setText(['t_net', 'netMovement', 'ledgerNet'], money(net));
    setText(['t_reversed', 'reversalCount', 'hiddenReversalCount'], String(state.hiddenReversalCount));
    setText(['reverseEligible', 'reverse_eligible_count'], String(reverseEligible));

    setClass(['t_net', 'netMovement', 'ledgerNet'], 'sf-metric-value ' + (net >= 0 ? 'sf-tone-positive' : 'sf-tone-danger'));
  }

  function renderHealth() {
    if (!state.health) {
      setText(['ledgerHealth', 'healthStatus', 'health-status'], 'Health unavailable');
      return;
    }

    const status = state.health.status || 'unknown';
    const detail =
      status.toUpperCase() +
      ' · active ' + (state.health.active_count || 0) +
      ' · reversals ' + (state.health.reversal_count || 0) +
      ' · orphan links ' + ((state.health.orphan_linked_rows || []).length);

    setText(['ledgerHealth', 'healthStatus', 'health-status'], detail);
    setText(['healthVerification', 'healthDetail'], detail);
  }

  function renderItem(item) {
    if (item.kind === 'group') return renderGroup(item);

    return renderRow(item.row);
  }

  function renderGroup(item) {
    const rows = item.rows || [];
    const first = rows[0] || {};
    const total = rows.reduce((sum, row) => sum + Math.abs(Number(row.display_amount || row.amount || 0)), 0);
    const anyReversed = rows.some(row => row.is_reversed);
    const canReverse = rows.some(row => row.reverse_eligible);
    const target = rows.find(row => row.reverse_eligible) || first;

    const title = groupTitle(item.group_type, rows);
    const sub = groupSub(item.group_type, rows);
    const amountClass = groupAmountClass(item.group_type, rows);

    return `
      <article class="ledger-group-card ${anyReversed ? 'is-voided' : ''}">
        <div class="ledger-main-line">
          <div class="ledger-icon">${groupIcon(item.group_type)}</div>
          <div>
            <div class="ledger-title">${esc(title)}</div>
            <div class="ledger-sub">${esc(sub)}</div>
          </div>
          <div class="ledger-amount ${amountClass}">${money(total, true)}</div>
        </div>

        <div class="ledger-tags">
          <span class="ledger-tag warn">${esc(item.group_type.replace(/_/g, ' '))}</span>
          <span class="ledger-tag">${rows.length} rows</span>
          <span class="ledger-tag">${esc(first.date || '')}</span>
          ${anyReversed ? '<span class="ledger-tag danger">reversed / voided</span>' : ''}
          ${canReverse ? '<span class="ledger-tag good">reverse eligible</span>' : '<span class="ledger-tag danger">reverse blocked</span>'}
        </div>

        <div class="ledger-children">
          ${rows.map(renderChildRow).join('')}
        </div>

        <div class="ledger-actions">
          <button class="ledger-action" type="button" data-toggle-group="1">Expand</button>
          <button
            class="ledger-action reverse"
            type="button"
            data-reverse-id="${esc(target.id)}"
            ${canReverse ? '' : 'disabled'}
            title="${canReverse ? 'Reverse this group' : esc(target.reverse_block_reason || 'Reverse blocked')}">
            ↩ Reverse group
          </button>
        </div>
      </article>
    `;
  }

  function renderRow(txn) {
    const type = String(txn.type || 'unknown').toLowerCase();
    const signed = signedAmount(txn);
    const isIn = signed > 0;
    const isOut = signed < 0;
    const amountClass = isIn ? 'positive' : isOut ? 'negative' : 'neutral';
    const amountPrefix = isIn ? '+' : isOut ? '-' : '';
    const title = rowTitle(txn);
    const sub = rowSub(txn);
    const voided = txn.is_reversed || txn.is_reversal;

    return `
      <article class="ledger-row ${voided ? 'is-voided' : ''}">
        <div class="ledger-main-line">
          <div class="ledger-icon">${esc(typeIcon(type))}</div>
          <div>
            <div class="ledger-title">${esc(title)}</div>
            <div class="ledger-sub">${esc(sub)}</div>
          </div>
          <div class="ledger-amount ${amountClass}">${amountPrefix}${money(Math.abs(Number(txn.display_amount || txn.amount || 0)), true)}</div>
        </div>

        <div class="ledger-tags">
          <span class="ledger-tag">${esc(typeLabel(type))}</span>
          <span class="ledger-tag">${esc(txn.account_id || '')}</span>
          ${txn.category_id ? '<span class="ledger-tag">' + esc(txn.category_id) + '</span>' : '<span class="ledger-tag warn">no category</span>'}
          ${txn.is_reversal ? '<span class="ledger-tag danger">reversal row</span>' : ''}
          ${txn.is_reversed ? '<span class="ledger-tag danger">reversed original</span>' : ''}
          ${txn.reverse_eligible ? '<span class="ledger-tag good">reverse eligible</span>' : '<span class="ledger-tag danger">' + esc(txn.reverse_block_reason || 'reverse blocked') + '</span>'}
        </div>

        <div class="ledger-actions">
          <button
            class="ledger-action reverse"
            type="button"
            data-reverse-id="${esc(txn.id)}"
            ${txn.reverse_eligible ? '' : 'disabled'}
            title="${txn.reverse_eligible ? 'Reverse this row' : esc(txn.reverse_block_reason || 'Reverse blocked')}">
            ↩ Reverse
          </button>
        </div>
      </article>
    `;
  }

  function renderChildRow(txn) {
    const type = String(txn.type || 'unknown').toLowerCase();
    const signed = signedAmount(txn);
    const amountClass = signed > 0 ? 'positive' : signed < 0 ? 'negative' : 'neutral';
    const prefix = signed > 0 ? '+' : signed < 0 ? '-' : '';

    return `
      <div class="ledger-child-row">
        <div>
          <strong>${esc(typeLabel(type))}</strong>
          · ${esc(txn.account_id || '')}
          · ${esc(txn.category_id || 'no category')}
          · ${esc((txn.notes || '').slice(0, 90))}
        </div>
        <div class="ledger-amount ${amountClass}">${prefix}${money(Math.abs(Number(txn.display_amount || txn.amount || 0)), true)}</div>
      </div>
    `;
  }

  function rowTitle(txn) {
    if (txn.is_reversal) return 'Reversal row';
    if (txn.is_reversed) return 'Reversed original';
    if (txn.notes) return String(txn.notes).slice(0, 110);

    return typeLabel(txn.type);
  }

  function rowSub(txn) {
    const parts = [
      txn.date || '',
      accountLabel(txn.account_id),
      typeLabel(txn.type)
    ];

    if (txn.group_type && txn.group_type !== 'single') {
      parts.push(String(txn.group_type).replace(/_/g, ' '));
    }

    if (txn.id) {
      parts.push(String(txn.id).slice(-10));
    }

    return parts.filter(Boolean).join(' · ');
  }

  function groupTitle(groupType, rows) {
    if (groupType === 'intl_package') {
      return 'International package';
    }

    if (groupType === 'atm_withdrawal') {
      return 'ATM withdrawal package';
    }

    if (groupType === 'cc_payment_pair') {
      return 'Credit card payment pair';
    }

    const transfer = rows.find(row => row.type === 'transfer');
    const income = rows.find(row => row.type === 'income');

    if (transfer && income) {
      return accountLabel(transfer.account_id) + ' → ' + accountLabel(income.account_id);
    }

    return 'Linked ledger pair';
  }

  function groupSub(groupType, rows) {
    const first = rows[0] || {};
    const ids = rows.map(row => row.id).filter(Boolean).join(', ');

    if (groupType === 'intl_package') {
      const packageId = first.intl_package_id || first.group_id || 'package';
      return (first.date || '') + ' · ' + packageId + ' · ' + ids;
    }

    return (first.date || '') + ' · ' + ids;
  }

  function groupIcon(groupType) {
    if (groupType === 'intl_package') return '🌐';
    if (groupType === 'atm_withdrawal') return '🏧';
    if (groupType === 'cc_payment_pair') return '💳';

    return '⇄';
  }

  function groupAmountClass(groupType, rows) {
    if (groupType === 'intl_package') return 'negative';

    const totalSigned = rows.reduce((sum, row) => sum + signedAmount(row), 0);

    if (totalSigned > 0) return 'positive';
    if (totalSigned < 0) return 'negative';

    return 'neutral';
  }

  async function onReverse(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const id = button.getAttribute('data-reverse-id');

    if (!id) {
      toast('Reverse failed: missing transaction id', 'error');
      return;
    }

    const txn = state.txns.find(row => row.id === id);

    if (txn && txn.reverse_eligible === false) {
      toast('Reverse blocked: ' + (txn.reverse_block_reason || 'not eligible'), 'error');
      return;
    }

    const reason = window.prompt(
      'Reason required for reversal.\n\nTransaction ID:\n' + id + '\n\nEnter reason:'
    );

    if (!reason || !reason.trim()) {
      toast('Reverse cancelled: reason required', 'error');
      return;
    }

    const confirmed = window.confirm(
      'Reverse this ledger item?\n\n' +
      'ID: ' + id + '\n' +
      'Reason: ' + reason.trim() + '\n\n' +
      'This creates append-only reversal rows. It does not delete history.'
    );

    if (!confirmed) return;

    button.disabled = true;
    button.textContent = 'Reversing…';

    try {
      const response = await fetch(API_REVERSE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id,
          reason: reason.trim(),
          created_by: 'web-ledger'
        })
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ('HTTP ' + response.status));
      }

      toast('Reversed · ' + (data.reversal_ids || []).join(', '));
      await loadAll();
    } catch (err) {
      toast('Reverse failed: ' + err.message, 'error');
      button.disabled = false;
      button.textContent = '↩ Reverse';
    }
  }

  function bindInput(idCandidates, eventName, handler) {
    for (const id of idCandidates) {
      const el = $(id);

      if (el) {
        el.addEventListener(eventName, handler);
        return el;
      }
    }

    return null;
  }

  function bindFilters() {
    bindInput(['filter_search', 'ledgerSearch', 'searchInput'], 'input', event => {
      state.filters.search = event.target.value.trim();
      render();
    });

    bindInput(['filter_account', 'accountFilter', 'ledgerAccountFilter'], 'change', event => {
      state.filters.account = event.target.value;
      render();
    });

    bindInput(['filter_type', 'typeFilter', 'ledgerTypeFilter'], 'change', event => {
      state.filters.type = event.target.value;
      render();
    });

    bindInput(['filter_status', 'statusFilter', 'ledgerStatusFilter'], 'change', event => {
      state.filters.status = event.target.value;
      render();
    });

    bindInput(['filter_view', 'viewFilter', 'ledgerViewFilter'], 'change', event => {
      state.filters.view = event.target.value || 'grouped';
      render();
    });

    bindInput(['refresh_btn', 'refreshBtn', 'ledgerRefresh'], 'click', () => {
      loadAll();
      toast('Refreshing ledger');
    });

    document.querySelectorAll('[data-ledger-view]').forEach(button => {
      button.addEventListener('click', () => {
        state.filters.view = button.dataset.ledgerView || 'grouped';

        document.querySelectorAll('[data-ledger-view]').forEach(btn => {
          btn.classList.toggle('is-active', btn === button);
        });

        render();
      });
    });

    document.querySelectorAll('[data-include-reversed]').forEach(button => {
      button.addEventListener('click', async () => {
        state.includeReversed = !state.includeReversed;
        button.classList.toggle('is-active', state.includeReversed);
        await loadTransactions();
      });
    });
  }

  function init() {
    injectStyles();
    bindFilters();
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