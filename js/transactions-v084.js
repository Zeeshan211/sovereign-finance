/* js/transactions-v084.js
 * Sovereign Finance · Ledger Console
 * v0.8.8-ledger-renderer-style-restored
 *
 * Fixes:
 * - Restores scoped ledger card/button styling.
 * - Keeps card title isolated from page hero .ledger-title.
 * - Keeps transfer pair amount as one leg only.
 * - Keeps shortened note titles.
 * - Does not touch backend.
 */

(function () {
  'use strict';

  const VERSION = 'v0.8.8-ledger-renderer-style-restored';

  const API_TRANSACTIONS = '/api/transactions?include_reversed=1&limit=500';
  const API_ACCOUNTS = '/api/add/context';
  const API_HEALTH = '/api/transactions/health';

  const state = {
    rows: [],
    groups: [],
    accounts: new Map(),
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

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function truncate(value, max) {
    const text = String(value || '').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function money(value, unsigned = false) {
    const n = Number(value || 0);
    const sign = !unsigned && n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function normalizeType(type) {
    return String(type || '').trim().toLowerCase();
  }

  function amountOf(row) {
    const type = normalizeType(row.type);

    if (type === 'transfer') {
      return Number(row.amount ?? row.pkr_amount ?? row.display_amount ?? 0);
    }

    return Number(row.pkr_amount ?? row.amount ?? row.display_amount ?? 0);
  }

  function absAmount(row) {
    return Math.abs(amountOf(row));
  }

  function signedAmount(row) {
    const type = normalizeType(row.type);
    const amount = absAmount(row);

    if (['income', 'salary', 'opening', 'borrow', 'debt_in'].includes(type)) {
      return amount;
    }

    return -amount;
  }

  function typeLabel(type) {
    const raw = String(type || '').replace(/_/g, ' ');
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Transaction';
  }

  function shortId(id) {
    const value = String(id || '');
    return value.length <= 14 ? value : value.slice(-12);
  }

  function accountLabel(id) {
    const account = state.accounts.get(String(id || ''));
    if (!account) return id || '—';

    return `${account.icon || ''} ${account.name || account.id || id}`.trim();
  }

  function parseLinkedId(notes) {
    const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
    return match ? match[1].trim() : null;
  }

  function isReversalRow(row) {
    const notes = String(row.notes || '').toUpperCase();

    return !!(
      row.is_reversal === true ||
      notes.includes('[REVERSAL OF ')
    );
  }

  function isReversedOriginal(row) {
    const notes = String(row.notes || '').toUpperCase();

    return !!(
      row.is_reversed === true ||
      row.reversed_by ||
      row.reversed_at ||
      notes.includes('[REVERSED BY ')
    );
  }

  function isInactive(row) {
    return isReversalRow(row) || isReversedOriginal(row);
  }

  function rowTitle(row) {
    if (isReversalRow(row)) return 'Reversal row';
    if (isReversedOriginal(row)) return 'Reversed original';

    const notes = String(row.notes || '').trim();

    if (/^merchant=/i.test(notes)) {
      return truncate(
        notes.replace(/^merchant=/i, '').split('|')[0].trim() || typeLabel(row.type),
        42
      );
    }

    if (/^Debt received:/i.test(notes)) return 'Debt received';
    if (/^Debt payment:/i.test(notes)) return 'Debt payment';
    if (/^Debt given:/i.test(notes)) return 'Debt given';
    if (/^Bill payment:/i.test(notes)) return 'Bill payment';
    if (/^\[INTL /i.test(notes)) return 'International charge';
    if (/^From:/i.test(notes) || /^To:/i.test(notes)) return 'Transfer';

    return notes ? truncate(notes, 48) : typeLabel(row.type);
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });

    const text = await response.text();

    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
    }

    if (!response.ok) {
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    }

    if (!payload) {
      throw new Error(`Empty JSON response from ${url}: HTTP ${response.status}`);
    }

    return payload;
  }

  function normalizeTransactionRows(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.transactions)) return payload.transactions;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.result)) return payload.result;
    return [];
  }

  function normalizeAccounts(payload) {
    if (!payload) return [];

    if (Array.isArray(payload.accounts)) return payload.accounts;

    if (payload.accounts && typeof payload.accounts === 'object') {
      return Object.entries(payload.accounts).map(([id, row]) => ({
        id,
        ...(row || {})
      }));
    }

    return [];
  }

  function groupKey(row) {
    if (row.intl_package_id) return `intl:${row.intl_package_id}`;

    const linked = row.linked_txn_id || parseLinkedId(row.notes);

    if (linked) {
      return `pair:${[String(row.id), String(linked)].sort().join('::')}`;
    }

    return `single:${row.id}`;
  }

  function buildGroups(rows) {
    const map = new Map();

    for (const row of rows) {
      const key = groupKey(row);

      if (!map.has(key)) {
        map.set(key, {
          key,
          type: key.startsWith('intl:')
            ? 'intl_package'
            : key.startsWith('pair:')
              ? 'linked_pair'
              : 'single',
          rows: []
        });
      }

      map.get(key).rows.push(row);
    }

    return Array.from(map.values())
      .map(decorateGroup)
      .sort((a, b) => {
        const ad = String(a.date || '');
        const bd = String(b.date || '');

        if (ad !== bd) return bd.localeCompare(ad);

        const ac = String(a.created_at || '');
        const bc = String(b.created_at || '');

        if (ac !== bc) return bc.localeCompare(ac);

        return String(b.key).localeCompare(String(a.key));
      });
  }

  function decorateGroup(group) {
    const rows = group.rows.slice().sort((a, b) => {
      const ac = String(a.created_at || '');
      const bc = String(b.created_at || '');

      if (ac !== bc) return bc.localeCompare(ac);

      return String(b.id).localeCompare(String(a.id));
    });

    const primary = choosePrimaryRow(group.type, rows);
    const amount = groupDisplayAmount(group.type, rows);
    const hasReversal = rows.some(isReversalRow);
    const hasReversedOriginal = rows.some(isReversedOriginal);
    const inactive = rows.every(isInactive);
    const reverseEligible = rows.some(row => row.reverse_eligible === true && !isInactive(row));

    return {
      ...group,
      rows,
      primary,
      amount,
      date: primary.date || rows[0]?.date || '',
      created_at: primary.created_at || rows[0]?.created_at || '',
      inactive,
      has_reversal: hasReversal,
      has_reversed_original: hasReversedOriginal,
      reverse_eligible: reverseEligible && !hasReversal && !hasReversedOriginal,
      reverse_block_reason: hasReversal || hasReversedOriginal ? 'reverse blocked' : null
    };
  }

  function choosePrimaryRow(groupType, rows) {
    if (groupType === 'linked_pair') {
      return rows.find(row => normalizeType(row.type) === 'transfer') ||
        rows.find(row => signedAmount(row) < 0) ||
        rows[0];
    }

    if (groupType === 'intl_package') {
      return rows.find(row => String(row.notes || '').includes('[INTL BASE]')) ||
        rows.find(row => normalizeType(row.type) === 'expense') ||
        rows[0];
    }

    return rows[0];
  }

  function groupDisplayAmount(groupType, rows) {
    if (groupType === 'intl_package') {
      return rows
        .filter(row => !isInactive(row))
        .reduce((sum, row) => sum + absAmount(row), 0);
    }

    if (groupType === 'linked_pair') {
      const atmOut = rows.find(row => String(row.id || '').startsWith('atmout_'));
      if (atmOut) return absAmount(atmOut);

      const transferOut = rows.find(row => normalizeType(row.type) === 'transfer');
      if (transferOut) return absAmount(transferOut);

      const negative = rows.find(row => signedAmount(row) < 0);
      if (negative) return absAmount(negative);

      return Math.max(...rows.map(absAmount));
    }

    return absAmount(rows[0]);
  }

  function groupTitle(group) {
    if (group.type === 'intl_package') return 'International package';

    if (group.type === 'linked_pair') {
      const out = group.rows.find(row => normalizeType(row.type) === 'transfer') ||
        group.rows.find(row => signedAmount(row) < 0);

      const linkedId = out && (out.linked_txn_id || parseLinkedId(out.notes));

      const inbound = group.rows.find(row => row.id !== out?.id && (!linkedId || row.id === linkedId)) ||
        group.rows.find(row => row.id !== out?.id);

      if (out && inbound) {
        return `${accountLabel(out.account_id)} → ${accountLabel(inbound.account_id)}`;
      }

      return 'Linked ledger pair';
    }

    return rowTitle(group.primary);
  }

  function groupSubtitle(group) {
    if (group.type === 'single') {
      const row = group.primary;
      return `${row.date || '—'} · ${accountLabel(row.account_id)} · ${typeLabel(row.type)} · ${shortId(row.id)}`;
    }

    return `${group.date || '—'} · ${group.rows.map(row => row.id).join(', ')}`;
  }

  function groupIcon(group) {
    if (group.type === 'intl_package') return '🌐';
    if (group.type === 'linked_pair') return '⇄';

    const type = normalizeType(group.primary.type);

    if (type === 'income') return '💰';
    if (type === 'transfer') return '⇄';
    if (type === 'atm') return '🏧';
    if (type === 'repay' || type === 'debt_out') return '📤';

    return '💸';
  }

  function groupAmountText(group) {
    if (group.type === 'linked_pair') return money(group.amount, true);
    if (group.type === 'intl_package') return money(-group.amount);
    return money(signedAmount(group.primary));
  }

  function groupAmountClass(group) {
    if (group.type === 'linked_pair') return 'neutral';
    if (group.type === 'intl_package') return 'negative';

    const signed = signedAmount(group.primary);

    if (signed > 0) return 'positive';
    if (signed < 0) return 'negative';

    return 'neutral';
  }

  function tag(text, tone) {
    return `<span class="ledger-tag ${tone || ''}">${esc(text)}</span>`;
  }

  function rowMatchesFilters(row) {
    const q = state.filters.search.toLowerCase();

    const haystack = [
      row.id,
      row.date,
      row.type,
      row.account_id,
      row.transfer_to_account_id,
      row.category_id,
      row.notes,
      row.linked_txn_id,
      row.intl_package_id
    ].join(' ').toLowerCase();

    if (q && !haystack.includes(q)) return false;
    if (state.filters.account && row.account_id !== state.filters.account) return false;
    if (state.filters.type && normalizeType(row.type) !== state.filters.type) return false;

    if (state.filters.status === 'reverse_eligible' && row.reverse_eligible !== true) return false;
    if (state.filters.status === 'reverse_blocked' && row.reverse_eligible === true) return false;
    if (state.filters.status === 'reversed' && !isInactive(row)) return false;

    return true;
  }

  function groupMatchesFilters(group) {
    if (state.filters.status === 'grouped' && group.type === 'single') return false;
    return group.rows.some(rowMatchesFilters);
  }

  function filteredGroups() {
    return state.groups.filter(groupMatchesFilters);
  }

  function filteredRows() {
    return state.rows.filter(rowMatchesFilters);
  }

  function renderMetrics(items) {
    let moneyIn = 0;
    let moneyOut = 0;
    let reverseEligible = 0;

    for (const group of items) {
      if (group.reverse_eligible) reverseEligible += 1;

      if (group.type === 'linked_pair') continue;

      if (group.type === 'intl_package') {
        if (!group.inactive) moneyOut += group.amount;
        continue;
      }

      const row = group.primary;
      if (isInactive(row)) continue;

      const signed = signedAmount(row);

      if (signed > 0) moneyIn += signed;
      if (signed < 0) moneyOut += Math.abs(signed);
    }

    setText('visibleItems', String(items.length));
    setText('moneyIn', items.length ? money(moneyIn, true) : '—');
    setText('moneyOut', items.length ? money(moneyOut, true) : '—');
    setText('netMovement', items.length ? money(moneyIn - moneyOut) : '—');
    setText('reverseEligible', items.length ? String(reverseEligible) : '—');
    setText('t_reversed', `${state.rows.filter(isReversalRow).length} hidden reversal rows.`);
  }

  function renderList() {
    const container = $('txn-list');
    if (!container) return;

    const view = state.filters.view || 'grouped';

    if (view === 'raw') {
      const rows = filteredRows();
      const groupsForMetrics = buildGroups(rows);

      renderMetrics(groupsForMetrics);

      container.innerHTML = rows.length
        ? rows.map(renderRawRow).join('')
        : '<div class="ledger-empty">No ledger rows match current filters.</div>';

      bindRowActions(container);
      return;
    }

    const groups = filteredGroups();

    renderMetrics(groups);

    container.innerHTML = groups.length
      ? groups.map(renderGroupCard).join('')
      : '<div class="ledger-empty">No ledger activity matches current filters.</div>';

    bindRowActions(container);
  }

  function renderGroupCard(group) {
    if (group.type === 'single') return renderRawRow(group.primary);

    const tags = [
      tag(group.type === 'intl_package' ? 'intl package' : 'linked pair'),
      tag(`${group.rows.length} rows`),
      tag(group.date || '—')
    ];

    if (group.has_reversal || group.has_reversed_original || group.inactive) {
      tags.push(tag('reversed / voided', 'warn'));
      tags.push(tag('reverse blocked', 'danger'));
    } else if (group.reverse_eligible) {
      tags.push(tag('reverse eligible', 'good'));
    } else {
      tags.push(tag('reverse blocked', 'warn'));
    }

    return `
      <article class="ledger-group-card ${group.inactive ? 'is-voided' : ''}" data-group-key="${esc(group.key)}">
        <div class="ledger-main-line">
          <div class="ledger-icon">${groupIcon(group)}</div>

          <div class="ledger-copy-block">
            <div class="ledger-card-title">${esc(groupTitle(group))}</div>
            <div class="ledger-sub">${esc(groupSubtitle(group))}</div>
          </div>

          <div class="ledger-amount ${groupAmountClass(group)}">${groupAmountText(group)}</div>
        </div>

        <div class="ledger-tags">${tags.join('')}</div>

        <div class="ledger-actions">
          <button class="ledger-action" type="button" data-toggle-group="${esc(group.key)}">Expand</button>
          <button
            class="ledger-action reverse"
            type="button"
            data-reverse-id="${esc(group.primary.id)}"
            ${group.reverse_eligible ? '' : 'disabled'}>
            ↩ Reverse group
          </button>
        </div>

        <div class="ledger-children" data-children="${esc(group.key)}">
          ${group.rows.map(renderChildRow).join('')}
        </div>
      </article>
    `;
  }

  function renderRawRow(row) {
    const inactive = isInactive(row);
    const signed = signedAmount(row);

    const tags = [
      tag(typeLabel(row.type)),
      tag(row.account_id || 'no account'),
      tag(row.category_id || 'no category')
    ];

    if (isReversalRow(row)) {
      tags.push(tag('reversal row', 'warn'));
      tags.push(tag('reverse blocked', 'danger'));
    } else if (isReversedOriginal(row)) {
      tags.push(tag('reversed original', 'warn'));
      tags.push(tag('already_reversed', 'danger'));
    } else if (row.reverse_eligible) {
      tags.push(tag('reverse eligible', 'good'));
    } else {
      tags.push(tag('reverse blocked', 'warn'));
    }

    return `
      <article class="ledger-row ${inactive ? 'is-voided' : ''}" data-row-id="${esc(row.id)}">
        <div class="ledger-main-line">
          <div class="ledger-icon">${groupIcon({ type: 'single', primary: row })}</div>

          <div class="ledger-copy-block">
            <div class="ledger-card-title">${esc(rowTitle(row))}</div>
            <div class="ledger-sub">${esc(row.date || '—')} · ${esc(accountLabel(row.account_id))} · ${esc(typeLabel(row.type))} · ${esc(shortId(row.id))}</div>
          </div>

          <div class="ledger-amount ${signed >= 0 ? 'positive' : 'negative'}">${money(signed)}</div>
        </div>

        <div class="ledger-tags">${tags.join('')}</div>

        <div class="ledger-actions">
          <button
            class="ledger-action reverse"
            type="button"
            data-reverse-id="${esc(row.id)}"
            ${row.reverse_eligible && !inactive ? '' : 'disabled'}>
            ↩ Reverse
          </button>
        </div>
      </article>
    `;
  }

  function renderChildRow(row) {
    const signed = signedAmount(row);

    return `
      <div class="ledger-child-row">
        <div>
          <strong>${esc(shortId(row.id))}</strong>
          · ${esc(accountLabel(row.account_id))}
          · ${esc(typeLabel(row.type))}
          · ${esc(truncate(row.notes || '', 90))}
        </div>
        <div>${money(signed)}</div>
      </div>
    `;
  }

  function bindRowActions(container) {
    container.querySelectorAll('[data-toggle-group]').forEach(button => {
      button.addEventListener('click', () => {
        const key = button.getAttribute('data-toggle-group');
        const card = container.querySelector(`[data-group-key="${cssEscape(key)}"]`);
        if (card) card.classList.toggle('is-open');
      });
    });

    container.querySelectorAll('[data-reverse-id]').forEach(button => {
      button.addEventListener('click', event => {
        const id = event.currentTarget.getAttribute('data-reverse-id');
        openReversePanel(id);
      });
    });

    container.querySelectorAll('[data-row-id]').forEach(card => {
      card.addEventListener('click', event => {
        if (event.target.closest('button')) return;
        showDetail(card.getAttribute('data-row-id'));
      });
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value || '').replace(/"/g, '\\"');
  }

  function showDetail(id) {
    const row = state.rows.find(item => item.id === id);
    const panel = $('detailPanel');

    if (!panel || !row) return;

    panel.innerHTML = `<pre class="ledger-detail-pre">${esc(JSON.stringify(row, null, 2))}</pre>`;
  }

  function openReversePanel(id) {
    const panel = $('reversePanel');

    if (!panel) {
      toast('Reverse panel missing on page.', 'error');
      return;
    }

    const row = state.rows.find(item => item.id === id);

    if (!row || isInactive(row) || row.reverse_eligible !== true) {
      toast('Reverse blocked for this row.', 'error');
      return;
    }

    panel.hidden = false;
    panel.innerHTML = `
      <div class="ledger-reverse-panel">
        <div class="sf-section-head" style="margin-bottom:0;">
          <div>
            <p class="sf-section-kicker">Append-only reversal</p>
            <h2 class="sf-section-title">Reverse ledger movement</h2>
            <p class="sf-section-subtitle">This creates reversal rows. It does not delete history.</p>
          </div>
        </div>

        <div class="ledger-reverse-target">
          <div class="ledger-reverse-title">${esc(rowTitle(row))}</div>
          <div class="ledger-reverse-meta">${esc(accountLabel(row.account_id))} · ${money(absAmount(row), true)} · ${esc(row.date || '')}</div>
          <div class="ledger-reverse-meta">Transaction ID: <strong>${esc(id)}</strong></div>
        </div>

        <div>
          <label class="sf-section-kicker" for="reverseReasonInput">Reason required</label>
          <textarea id="reverseReasonInput" class="ledger-reverse-textarea" maxlength="500" placeholder="Reason for reversal"></textarea>
        </div>

        <div id="reversePanelError" class="ledger-reverse-error" hidden></div>

        <div class="ledger-reverse-actions">
          <button class="ledger-action" type="button" id="cancelReverseBtn">Cancel</button>
          <button class="ledger-action reverse" type="button" id="confirmReverseBtn">Confirm reversal</button>
        </div>
      </div>
    `;

    $('cancelReverseBtn')?.addEventListener('click', closeReversePanel);
    $('confirmReverseBtn')?.addEventListener('click', () => confirmReverse(id));

    setTimeout(() => $('reverseReasonInput')?.focus(), 30);

    panel.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  function closeReversePanel() {
    const panel = $('reversePanel');
    if (!panel) return;

    panel.hidden = true;
    panel.innerHTML = '';
  }

  async function confirmReverse(id) {
    const reason = $('reverseReasonInput')?.value.trim() || '';
    const error = $('reversePanelError');
    const button = $('confirmReverseBtn');

    if (!reason) {
      if (error) {
        error.hidden = false;
        error.textContent = 'Reason is required.';
      }
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Reversing…';
    }

    try {
      await reverseTransaction(id, reason);
      closeReversePanel();
      toast('Reversed.');
      await loadAll();
    } catch (err) {
      if (error) {
        error.hidden = false;
        error.textContent = err.message;
      }

      if (button) {
        button.disabled = false;
        button.textContent = 'Confirm reversal';
      }
    }
  }

  async function reverseTransaction(id, reason) {
    const attempts = [
      {
        url: `/api/transactions/${encodeURIComponent(id)}/reverse`,
        body: { reason, created_by: 'web-ledger' }
      },
      {
        url: '/api/transactions/reverse',
        body: { id, reason, created_by: 'web-ledger' }
      },
      {
        url: `/api/transactions/${encodeURIComponent(id)}`,
        body: { action: 'reverse', reason, created_by: 'web-ledger' }
      }
    ];

    let lastError = null;

    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(attempt.body)
        });

        const payload = await response.json().catch(() => null);

        if (response.ok && payload && payload.ok !== false) return payload;

        lastError = new Error((payload && payload.error) || ('HTTP ' + response.status));
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Reverse failed.');
  }

  function renderAccountsFilter() {
    const select = $('accountFilter');
    if (!select) return;

    const current = select.value;

    const options = ['<option value="">All accounts</option>']
      .concat(Array.from(state.accounts.values()).map(account => {
        return `<option value="${esc(account.id)}">${esc(accountLabel(account.id))}</option>`;
      }));

    select.innerHTML = options.join('');
    select.value = current;
  }

  function bindFilters() {
    $('searchInput')?.addEventListener('input', event => {
      state.filters.search = event.target.value.trim();
      renderList();
    });

    $('accountFilter')?.addEventListener('change', event => {
      state.filters.account = event.target.value;
      renderList();
    });

    $('typeFilter')?.addEventListener('change', event => {
      state.filters.type = event.target.value;
      renderList();
    });

    $('statusFilter')?.addEventListener('change', event => {
      state.filters.status = event.target.value;
      renderList();
    });

    $('filter_view')?.addEventListener('change', event => {
      state.filters.view = event.target.value || 'grouped';
      renderList();
    });

    $('refresh_btn')?.addEventListener('click', loadAll);
  }

  async function loadAccounts() {
    try {
      const payload = await fetchJSON(API_ACCOUNTS);
      const accounts = normalizeAccounts(payload);

      state.accounts = new Map(
        accounts
          .filter(account => account && (account.id || account.account_id))
          .map(account => [String(account.id || account.account_id), {
            ...account,
            id: account.id || account.account_id
          }])
      );
    } catch {
      state.accounts = new Map();
    }

    renderAccountsFilter();
  }

  async function loadTransactions() {
    const payload = await fetchJSON(API_TRANSACTIONS);
    const rows = normalizeTransactionRows(payload);

    state.rows = rows.map(row => ({
      ...row,
      id: row.id || row.transaction_id,
      amount: Number(row.amount ?? row.display_amount ?? 0),
      pkr_amount: Number(row.pkr_amount ?? row.amount ?? row.display_amount ?? 0)
    })).filter(row => row.id);

    state.groups = buildGroups(state.rows);
  }

  async function loadHealth() {
    try {
      const payload = await fetchJSON(API_HEALTH);
      const health = payload.health || payload;

      const status = String(health.status || 'ok').toUpperCase();
      const detail = health.summary ||
        `active ${health.active_count ?? health.active ?? '—'} · reversals ${health.reversal_count ?? health.reversals ?? '—'} · orphan links ${health.orphan_link_count ?? health.orphan_links ?? '—'}`;

      setText('ledgerHealth', `Health ${status}`);
      setText('healthStatus', status);
      setText('healthDetail', detail);
    } catch {
      setText('ledgerHealth', 'Ledger loaded');
      setText('healthStatus', 'Unknown');
      setText('healthDetail', `${state.rows.length} rows loaded. Health endpoint unavailable.`);
    }
  }

  async function loadAll() {
    const container = $('txn-list');

    try {
      setText('ledgerHealth', 'Loading ledger…');
      setText('healthDetail', 'Reading backend ledger rows.');

      if (container) {
        container.innerHTML = '<div class="ledger-empty">Loading ledger rows…</div>';
      }

      await loadAccounts();
      await loadTransactions();
      await loadHealth();

      renderList();
    } catch (err) {
      if (container) {
        container.innerHTML = `<div class="ledger-empty">Failed: ${esc(err.message)}</div>`;
      }

      setText('ledgerHealth', 'Ledger failed');
      setText('healthStatus', 'Failed');
      setText('healthDetail', err.message);
      renderMetrics([]);
    }
  }

  function toast(message, kind) {
    let el = $('ledgerToast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'ledgerToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.className = 'toast show ' + (kind === 'error' ? 'toast-error' : 'toast-success');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.className = 'toast';
    }, 3000);
  }

  function injectStyles() {
    if ($('ledger-renderer-style')) return;

    const style = document.createElement('style');
    style.id = 'ledger-renderer-style';
    style.textContent = `
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

      .ledger-copy-block {
        min-width: 0;
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

      .ledger-card-title {
        color: var(--sf-text);
        font-size: 14px;
        line-height: 1.25;
        font-weight: 900;
        letter-spacing: normal;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ledger-sub {
        margin-top: 4px;
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

      .ledger-detail-pre {
        white-space: pre-wrap;
        overflow: auto;
        max-height: 480px;
        border-radius: 16px;
        padding: 14px;
        background: var(--sf-surface-2);
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.5;
      }

      .ledger-reverse-panel {
        display: grid;
        gap: 14px;
      }

      .ledger-reverse-target {
        border: 1px solid var(--sf-border-subtle);
        border-radius: 16px;
        background: var(--sf-surface-1);
        padding: 14px;
      }

      .ledger-reverse-title {
        color: var(--sf-text);
        font-size: 16px;
        font-weight: 950;
      }

      .ledger-reverse-meta {
        margin-top: 6px;
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .ledger-reverse-textarea {
        width: 100%;
        min-height: 96px;
        border: 1px solid var(--sf-border);
        border-radius: 16px;
        background: var(--sf-surface-1);
        color: var(--sf-text);
        padding: 12px 13px;
        font: inherit;
        resize: vertical;
        outline: none;
      }

      .ledger-reverse-error {
        color: var(--sf-danger);
        font-size: 13px;
        font-weight: 800;
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

      @media (max-width: 760px) {
        .ledger-main-line {
          grid-template-columns: 38px minmax(0, 1fr);
        }

        .ledger-amount {
          grid-column: 2;
          text-align: left;
        }

        .ledger-actions {
          justify-content: stretch;
        }

        .ledger-action {
          flex: 1;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    injectStyles();

    setText('ledgerJsVersion', VERSION);
    setText('ledgerFooterVersion', `v0.8.8 · transactions · ${VERSION}`);

    bindFilters();
    loadAll();

    window.SovereignLedger = {
      version: VERSION,
      reload: loadAll,
      state: () => JSON.parse(JSON.stringify({
        rows: state.rows,
        groups: state.groups,
        filters: state.filters
      }))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();