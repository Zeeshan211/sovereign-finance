/* ─── transactions.js · Standalone Transactions page · v0.7.2 ─── */
/* Ground Zero repair: compatible with /api/transactions v0.1.1 */

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

  const $ = id => document.getElementById(id);

  const TYPE_IN = new Set(['income', 'borrow']);
  const TYPE_OUT = new Set(['expense', 'cc_spend', 'repay', 'atm']);
  const TYPE_NEUTRAL = new Set(['transfer', 'cc_payment']);

  const TYPE_ICON = {
    expense: '💸',
    income: '💰',
    transfer: '💱',
    cc_payment: '💳',
    cc_spend: '💳',
    borrow: '📥',
    repay: '📤',
    atm: '🏧'
  };

  const TYPE_LABEL = {
    expense: 'Expense',
    income: 'Income',
    transfer: 'Transfer',
    cc_payment: 'CC Payment',
    cc_spend: 'CC Spend',
    borrow: 'Borrow',
    repay: 'Repay',
    atm: 'ATM'
  };

  let allTxns = [];
  let hiddenReversalCount = 0;
  let allAccounts = [];
  let filters = { type: '', account: '', search: '' };

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtPKR(n) {
    const value = Number(n) || 0;
    const sign = value < 0 ? '-' : '';
    return 'Rs ' + sign + Math.abs(value).toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

  function fmtPKR2(n) {
    const value = Number(n) || 0;
    const sign = value < 0 ? '-' : '';
    return 'Rs ' + sign + Math.abs(value).toLocaleString('en-PK', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function toast(msg, kind) {
    const t = $('toast');
    if (!t) return;

    t.textContent = msg;
    t.className = 'toast show ' + (kind === 'err' || kind === 'error' ? 'toast-error' : 'toast-success');

    setTimeout(() => {
      t.className = 'toast';
    }, 3500);
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);

    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'API failed on ' + url);

    return data;
  }

  async function loadAccountsSafe() {
    try {
      const data = await getJSON('/api/accounts');
      allAccounts = data.accounts || [];
    } catch (e) {
      console.warn('[transactions] accounts load failed:', e.message);
      allAccounts = [];
    }

    const accSel = $('filter_account');
    if (!accSel) return;

    const current = accSel.value || '';

    accSel.innerHTML = '<option value="">All accounts</option>' + allAccounts.map(a => {
      const label = [a.icon || '', a.name || a.id].join(' ').trim();
      return `<option value="${escHtml(a.id)}">${escHtml(label)}</option>`;
    }).join('');

    accSel.value = current;
  }

  async function loadAll() {
    const list = $('txn-list') || $('tx-list');

    try {
      if (list) list.innerHTML = '<div class="empty-state-inline">Loading…</div>';

      const txnRes = await getJSON('/api/transactions');

      allTxns = txnRes.transactions || [];
      hiddenReversalCount = Number(txnRes.hidden_reversal_count) || 0;

      await loadAccountsSafe();
      render();
    } catch (e) {
      console.error('[transactions] load failed:', e);

      if ($('t_count')) $('t_count').textContent = '0';
      if ($('t_in')) $('t_in').textContent = 'Rs 0';
      if ($('t_out')) $('t_out').textContent = 'Rs 0';
      if ($('t_net')) $('t_net').textContent = 'Rs 0';
      if ($('t_reversed')) $('t_reversed').textContent = 'ERR';

      if (list) {
        list.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      }
    }
  }

  function applyFilters(txns) {
    let out = txns.slice();

    if (filters.type) {
      out = out.filter(t => t.type === filters.type);
    }

    if (filters.account) {
      out = out.filter(t => t.account_id === filters.account || t.transfer_to_account_id === filters.account);
    }

    if (filters.search) {
      const q = filters.search.toLowerCase();

      out = out.filter(t =>
        String(t.notes || '').toLowerCase().includes(q) ||
        String(t.id || '').toLowerCase().includes(q) ||
        String(t.account_id || '').toLowerCase().includes(q) ||
        String(t.type || '').toLowerCase().includes(q)
      );
    }

    return out;
  }

  function isLegacyTransferIn(t) {
    if (!t || t.type !== 'income') return false;

    const notes = String(t.notes || '').toLowerCase();

    return notes.startsWith('from:') && notes.includes('[linked:');
  }

  function visibleBusinessRows() {
    return allTxns.filter(t => !isLegacyTransferIn(t));
  }

  function render() {
    const visible = applyFilters(visibleBusinessRows());

    const totalIn = visible
      .filter(t => TYPE_IN.has(t.type))
      .reduce((s, t) => s + Number(t.amount || 0), 0);

    const totalOut = visible
      .filter(t => TYPE_OUT.has(t.type))
      .reduce((s, t) => s + Number(t.amount || 0), 0);

    const net = totalIn - totalOut;

    if ($('t_count')) $('t_count').textContent = String(visible.length);
    if ($('t_in')) $('t_in').textContent = fmtPKR(totalIn);
    if ($('t_out')) $('t_out').textContent = fmtPKR(totalOut);

    if ($('t_net')) {
      $('t_net').textContent = fmtPKR(net);
      $('t_net').className = 'stat-value ' + (net >= 0 ? 'positive' : 'negative');
    }

    if ($('t_reversed')) $('t_reversed').textContent = String(hiddenReversalCount);

    const list = $('txn-list') || $('tx-list');
    if (!list) return;

    if (!visible.length) {
      list.innerHTML = '<div class="empty-state-inline">No transactions match filters</div>';
      return;
    }

    list.innerHTML = visible.map(renderRow).join('');

    document.querySelectorAll('button[data-rev]').forEach(btn => {
      btn.addEventListener('click', onReverseClick);
    });
  }

  function renderRow(t) {
    const type = t.type || 'unknown';
    const icon = TYPE_ICON[type] || '📝';
    const label = TYPE_LABEL[type] || type;

    const isIn = TYPE_IN.has(type);
    const isOut = TYPE_OUT.has(type);
    const amtCls = isIn ? 'positive' : isOut ? 'negative' : 'neutral';
    const amtSign = isIn ? '+' : isOut ? '-' : '';

    const title = t.notes ? escHtml(String(t.notes).slice(0, 90)) : escHtml(label);
    const accountFlow = t.transfer_to_account_id
      ? escHtml(t.account_id) + ' → ' + escHtml(t.transfer_to_account_id)
      : escHtml(t.account_id);

    const sub = accountFlow + ' · ' + escHtml(t.date || '') + ' · ' + escHtml(type);

    return `
      <div class="tx-row">
        <div class="tx-left">
          <div class="tx-icon">${icon}</div>
          <div class="tx-info">
            <div class="tx-name">${title}</div>
            <div class="tx-sub">${sub}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center">
          <div class="tx-amount ${amtCls}">${amtSign}${fmtPKR2(t.amount)}<span class="tx-currency">PKR</span></div>
          <button class="dense-action"
            data-rev="${escHtml(t.id)}"
            data-amount="${escHtml(t.amount)}"
            data-type="${escHtml(type)}"
            title="Reverse"
            style="margin-left:10px;color:var(--danger);background:var(--danger-soft);border:1px solid rgba(244,63,94,0.25);cursor:pointer;font-family:inherit">
            ↩ Reverse
          </button>
        </div>
      </div>`;
  }

  async function onReverseClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    const btn = ev.currentTarget;
    const id = btn.getAttribute('data-rev');
    const amount = Number(btn.getAttribute('data-amount')) || 0;
    const type = btn.getAttribute('data-type') || 'transaction';

    const ok = window.confirm(
      'Reverse this transaction?\n\n' +
      'Type: ' + type + '\n' +
      'Amount: ' + fmtPKR(amount) + '\n' +
      'ID: ' + id + '\n\n' +
      'Continue?'
    );

    if (!ok) return;

    btn.disabled = true;
    btn.textContent = '…';

    try {
      const r = await fetch('/api/transactions/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, created_by: 'web-transactions' })
      });

      const data = await r.json();

      if (!data.ok) {
        toast('Reverse failed: ' + (data.error || 'unknown error'), 'err');
        btn.disabled = false;
        btn.textContent = '↩ Reverse';
        return;
      }

      toast('Reversed · snapshot ' + (data.snapshot_id || 'created'));
      await loadAll();
    } catch (e) {
      toast('Network error: ' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '↩ Reverse';
    }
  }

  function init() {
    if ($('filter_type')) {
      $('filter_type').addEventListener('change', e => {
        filters.type = e.target.value;
        render();
      });
    }

    if ($('filter_account')) {
      $('filter_account').addEventListener('change', e => {
        filters.account = e.target.value;
        render();
      });
    }

    if ($('filter_search')) {
      $('filter_search').addEventListener('input', e => {
        filters.search = e.target.value.trim();
        render();
      });
    }

    if ($('refresh_btn')) {
      $('refresh_btn').addEventListener('click', () => {
        loadAll();
        toast('Refreshed');
      });
    }

    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
