// ════════════════════════════════════════════════════════════════════
// transactions.js — Standalone Transactions page · v0.7.1 · Sub-1D-3-RESHIP
//
// Reverse-only pattern (no Edit, no Delete buttons)
// Hides IN-half of transfer pairs (renders OUT-half as "From → To")
// Excludes reversed rows from In/Out totals
// Cache-busts every API read
// Stubs window.editTransaction + window.deleteTransaction for any cached HTML
// ════════════════════════════════════════════════════════════════════

window.editTransaction = function (id) {
  alert('Editing is disabled to preserve the audit trail.\n\n' +
        'To correct this transaction, scroll to find it and click the ↩ Reverse button.\n' +
        'To enter a new transaction, use the ➕ Add page.');
  console.warn('[transactions] legacy editTransaction(' + id + ') blocked');
  return false;
};
window.deleteTransaction = function (id) {
  alert('Direct delete is disabled to preserve the audit trail.\n\n' +
        'To remove a wrong transaction, click the ↩ Reverse button on its row.');
  console.warn('[transactions] legacy deleteTransaction(' + id + ') blocked');
  return false;
};

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const fmtPKR = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
  const fmtPKR2 = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, kind = 'success') {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + (kind === 'err' || kind === 'error' ? 'toast-error' : 'toast-success');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
    return r.json();
  }

  const TYPE_ICON = {
    expense: '💸', income: '💰', transfer: '💱',
    cc_payment: '💳', cc_spend: '💳',
    borrow: '📥', repay: '📤', atm: '🏧'
  };
  const TYPE_AMT_CLASS = {
    income: 'positive', borrow: 'positive',
    expense: 'negative', repay: 'negative', cc_spend: 'negative', atm: 'negative',
    transfer: 'neutral', cc_payment: 'neutral'
  };
  const TYPE_LABEL = {
    expense: 'Expense', income: 'Income', transfer: 'Transfer',
    cc_payment: 'CC Payment', cc_spend: 'CC Spend',
    borrow: 'Borrow', repay: 'Repay', atm: 'ATM'
  };

  let allTxns = [];
  let allAccounts = [];
  let filters = { type: '', account: '', search: '' };

  async function loadAll() {
    try {
      const [txnRes, balRes] = await Promise.all([
        getJSON('/api/transactions'),
        getJSON('/api/balances')
      ]);
      if (!txnRes.ok) throw new Error(txnRes.error || 'txns failed');
      if (!balRes.ok) throw new Error(balRes.error || 'balances failed');

      allTxns = txnRes.transactions || [];
      allAccounts = balRes.accounts || [];

      const accSel = $('filter_account');
      if (accSel && accSel.options.length <= 1) {
        accSel.innerHTML = '<option value="">All accounts</option>' +
          allAccounts.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.icon || '')} ${escHtml(a.name)}</option>`).join('');
      }

      render();
    } catch (e) {
      const list = $('txn-list') || $('tx-list');
      if (list) list.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  function applyFilters(txns) {
    let out = txns;
    if (filters.type) out = out.filter(t => t.type === filters.type);
    if (filters.account) {
      out = out.filter(t => t.account_id === filters.account || t.transfer_to_account_id === filters.account);
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      out = out.filter(t =>
        (t.notes || '').toLowerCase().includes(q) ||
        (t.id || '').toLowerCase().includes(q) ||
        (t.account_id || '').toLowerCase().includes(q)
      );
    }
    return out;
  }

  function render() {
    const txnById = {};
    allTxns.forEach(t => { txnById[t.id] = t; });
    const hideIds = new Set();
    allTxns.forEach(t => {
      if (t.linked_txn_id && t.type === 'income') {
        const partner = txnById[t.linked_txn_id];
        if (partner && partner.type === 'transfer') hideIds.add(t.id);
      }
    });

    const visible = applyFilters(allTxns.filter(t => !hideIds.has(t.id)));

    const totalIn = visible
      .filter(t => !t.reversed_by && (t.type === 'income' || t.type === 'borrow'))
      .reduce((s, t) => s + Number(t.amount || 0), 0);
    const totalOut = visible
      .filter(t => !t.reversed_by && (t.type === 'expense' || t.type === 'cc_spend' || t.type === 'repay' || t.type === 'atm'))
      .reduce((s, t) => s + Number(t.amount || 0), 0);
    const txCount = visible.length;
    const reversedCount = visible.filter(t => t.reversed_by).length;

    if ($('t_count'))    $('t_count').textContent = String(txCount);
    if ($('t_in'))       $('t_in').textContent = fmtPKR(totalIn);
    if ($('t_out'))      $('t_out').textContent = fmtPKR(totalOut);
    if ($('t_net')) {
      const net = totalIn - totalOut;
      $('t_net').textContent = fmtPKR(net);
      $('t_net').className = 'stat-value ' + (net >= 0 ? 'positive' : 'negative');
    }
    if ($('t_reversed')) $('t_reversed').textContent = String(reversedCount);

    const list = $('txn-list') || $('tx-list');
    if (!list) return;

    if (!visible.length) {
      list.innerHTML = '<div class="empty-state-inline">No transactions match filters</div>';
      return;
    }

    list.innerHTML = visible.map(t => {
      const isReversed   = !!t.reversed_by;
      const isReverseRow = t.notes && t.notes.startsWith('REVERSAL of ');
      const isTransferOut = t.type === 'transfer' && t.linked_txn_id;
      const icon = TYPE_ICON[t.type] || '📝';
      const amtCls = TYPE_AMT_CLASS[t.type] || 'neutral';
      const amtSign = (t.type === 'expense' || t.type === 'cc_spend' || t.type === 'repay' || t.type === 'atm') ? '−'
                    : (t.type === 'income' || t.type === 'borrow') ? '+'
                    : '';
      const accountFlow = isTransferOut
        ? `${escHtml(t.account_id)} → ${escHtml(t.transfer_to_account_id)}`
        : escHtml(t.account_id) + (t.transfer_to_account_id ? ' → ' + escHtml(t.transfer_to_account_id) : '');
      const flagText = isReversed ? '⊘ reversed · ' : isReverseRow ? '↩ reversal · ' : '';
      const subText = flagText + accountFlow + ' · ' + escHtml(t.date);
      const titleNote = isTransferOut ? 'Transfer' : (t.notes ? escHtml(t.notes.slice(0, 80)) : (TYPE_LABEL[t.type] || t.type));
      const opacity = isReversed ? ';opacity:0.55;text-decoration:line-through' : '';
      const canReverse = !isReversed && !isReverseRow;
      const action = canReverse
        ? `<button class="dense-action" data-rev="${escHtml(t.id)}" data-amount="${t.amount}" data-type="${escHtml(t.type)}" data-pair="${isTransferOut ? '1' : '0'}" title="Reverse" style="margin-left:10px;color:var(--danger);background:var(--danger-soft);border:1px solid rgba(244,63,94,0.25);cursor:pointer;font-family:inherit">↩ Reverse</button>`
        : '';

      return `
        <div class="tx-row" style="${opacity}">
          <div class="tx-left">
            <div class="tx-icon">${icon}</div>
            <div class="tx-info">
              <div class="tx-name">${titleNote}</div>
              <div class="tx-sub">${subText}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center">
            <div class="tx-amount ${amtCls}">${amtSign}${fmtPKR2(t.amount)}<span class="tx-currency">PKR</span></div>
            ${action}
          </div>
        </div>`;
    }).join('');

    document.querySelectorAll('button[data-rev]').forEach(btn => {
      btn.addEventListener('click', onReverseClick);
    });
  }

  async function onReverseClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const id     = btn.getAttribute('data-rev');
    const amount = parseFloat(btn.getAttribute('data-amount')) || 0;
    const type   = btn.getAttribute('data-type');
    const isPair = btn.getAttribute('data-pair') === '1';

    const ok = window.confirm(
      `Reverse this ${isPair ? 'TRANSFER PAIR' : 'transaction'}?\n\n` +
      `Type: ${type}\nAmount: ${fmtPKR(amount)}\nID: ${id}\n\nContinue?`
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
        toast('❌ ' + (data.error || 'Reverse failed'), 'err');
        btn.disabled = false; btn.textContent = '↩ Reverse';
        return;
      }
      let msg = `✅ Reversed${data.partner_id ? ' pair' : ''} · snap ${data.snapshot_id}`;
      if (data.debt_restored) msg += ` · ${data.debt_restored.name} +${fmtPKR(data.debt_restored.amount_restored)}`;
      toast(msg);
      await loadAll();
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
      btn.disabled = false; btn.textContent = '↩ Reverse';
    }
  }

  function init() {
    if ($('filter_type'))    $('filter_type').addEventListener('change', e => { filters.type = e.target.value; render(); });
    if ($('filter_account')) $('filter_account').addEventListener('change', e => { filters.account = e.target.value; render(); });
    if ($('filter_search'))  $('filter_search').addEventListener('input', e => { filters.search = e.target.value.trim(); render(); });
    if ($('refresh_btn'))    $('refresh_btn').addEventListener('click', () => { loadAll(); toast('Refreshed'); });

    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
