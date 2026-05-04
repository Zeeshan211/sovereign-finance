// ════════════════════════════════════════════════════════════════════
// hub.js — Hub renderer · v0.1.0 · Sub-1D-3-PARITY-recovery
//
// PURPOSE: Read-only dashboard. Targets EXISTING index.html IDs:
//   hub-net-worth · hub-liquid · hub-cc · hub-debts · hub-burden
//   hub-recent-tx · hub-top-debts · hub-due-soon
//
// Add/Edit txn lives on /add.html. Reverse lives on /transactions.html.
// Hub is dashboard-only.
//
// CHANGES from v0.0.11:
//   - Reverted target IDs to match existing index.html (form was never compatible)
//   - Added True Burden = CC outstanding + Personal Debts
//   - Cache-bust on every API call
//   - Uses window.animateNumber if numbers.js loaded, otherwise plain set
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const fmtPKR = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
  const fmtPKR2 = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
    return r.json();
  }

  // Set a stat — uses animation if available, otherwise plain
  function setStat(elId, value, currencyHtml) {
    const el = $(elId);
    if (!el) return;
    const numeric = Number(value) || 0;
    const text = Math.round(numeric).toLocaleString('en-PK');

    if (window.animateNumber) {
      // numbers.js available — animate the numeric portion, keep currency suffix
      window.animateNumber(el, numeric, {
        format: n => Math.round(n).toLocaleString('en-PK') + (currencyHtml || '')
      });
    } else {
      el.innerHTML = text + (currencyHtml || '');
    }
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

  // ─── BALANCES ──────────────────────────────────────────────────────
  async function loadBalances() {
    try {
      const d = await getJSON('/api/balances');
      if (!d.ok) throw new Error(d.error || 'balances failed');

      const networth = Number(d.net_worth || 0);
      const liquid   = Number(d.total_liquid_assets || 0);
      const cc       = Number(d.cc_outstanding || 0);
      const debts    = Number(d.total_owe || d.total_debts || 0);
      const burden   = cc + debts;

      const nwEl = $('hub-net-worth');
      if (nwEl) {
        nwEl.className = 'nw-value counter ' + (networth < 0 ? 'negative' : 'positive');
      }

      setStat('hub-net-worth', networth, '<span class="nw-currency">PKR</span>');
      setStat('hub-liquid',   liquid);
      setStat('hub-cc',       cc);
      setStat('hub-debts',    debts);
      setStat('hub-burden',   burden);
    } catch (e) {
      console.warn('[hub] loadBalances failed:', e.message);
      ['hub-net-worth','hub-liquid','hub-cc','hub-debts','hub-burden'].forEach(id => {
        const el = $(id); if (el) el.textContent = '—';
      });
    }
  }

  // ─── RECENT TRANSACTIONS ───────────────────────────────────────────
  async function loadRecentTxns() {
    const container = $('hub-recent-tx');
    if (!container) return;
    try {
      const d = await getJSON('/api/transactions');
      if (!d.ok) throw new Error(d.error || 'txns failed');

      const allTxns = d.transactions || [];
      const txnById = {};
      allTxns.forEach(t => { txnById[t.id] = t; });

      // Hide IN-half of transfer pairs (rendered as part of OUT row)
      const hideIds = new Set();
      allTxns.forEach(t => {
        if (t.linked_txn_id && t.type === 'income') {
          const partner = txnById[t.linked_txn_id];
          if (partner && partner.type === 'transfer') hideIds.add(t.id);
        }
      });

      const visible = allTxns.filter(t => !hideIds.has(t.id)).slice(0, 8);

      if (!visible.length) {
        container.innerHTML = '<div class="empty-state-inline">No transactions yet</div>';
        return;
      }

      container.innerHTML = visible.map(t => {
        const isReversed   = !!t.reversed_by;
        const isReverseRow = t.notes && t.notes.startsWith('REVERSAL of ');
        const isTransferOut = t.type === 'transfer' && t.linked_txn_id;
        const icon = TYPE_ICON[t.type] || '📝';
        const amtCls = TYPE_AMT_CLASS[t.type] || 'neutral';
        const amtSign = (t.type === 'expense' || t.type === 'cc_spend' || t.type === 'repay' || t.type === 'atm') ? '−'
                      : (t.type === 'income' || t.type === 'borrow') ? '+' : '';
        const flagText = isReversed ? '⊘ reversed · ' : isReverseRow ? '↩ reversal · ' : '';
        const accountFlow = isTransferOut
          ? `${escHtml(t.account_id)} → ${escHtml(t.transfer_to_account_id)}`
          : escHtml(t.account_id) + (t.transfer_to_account_id ? ' → ' + escHtml(t.transfer_to_account_id) : '');
        const subText = flagText + accountFlow + ' · ' + escHtml(t.date);
        const titleNote = isTransferOut ? 'Transfer'
                        : (t.notes ? escHtml(t.notes.slice(0, 60)) : escHtml(t.type));
        const opacity = isReversed ? ';opacity:0.55;text-decoration:line-through' : '';

        return `
          <div class="tx-row" style="${opacity}">
            <div class="tx-left">
              <div class="tx-icon">${icon}</div>
              <div class="tx-info">
                <div class="tx-name">${titleNote}</div>
                <div class="tx-sub">${subText}</div>
              </div>
            </div>
            <div class="tx-amount ${amtCls}">${amtSign}${fmtPKR(t.amount)}<span class="tx-currency">PKR</span></div>
          </div>`;
      }).join('');
    } catch (e) {
      container.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── TOP DEBTS ─────────────────────────────────────────────────────
  async function loadDebts() {
    const container = $('hub-top-debts');
    if (!container) return;
    try {
      const d = await getJSON('/api/debts');
      if (!d.ok) throw new Error(d.error || 'debts failed');
      const owe = (d.debts || []).filter(x => x.kind === 'owe' && x.status === 'active');
      owe.sort((a, b) => (b.original_amount - b.paid_amount) - (a.original_amount - a.paid_amount));
      const top = owe.slice(0, 5);

      if (!top.length) {
        container.innerHTML = '<div class="empty-state-inline">No active debts 🎉</div>';
        return;
      }

      container.innerHTML = top.map(x => {
        const remaining = (x.original_amount || 0) - (x.paid_amount || 0);
        return `
          <a href="/debts.html" class="mini-row">
            <div class="mini-row-left">
              <div class="mini-row-name">${escHtml(x.name)}</div>
            </div>
            <div class="mini-row-right">
              <div class="mini-row-amount negative">${fmtPKR(remaining)}</div>
              <div class="mini-row-sub">remaining</div>
            </div>
          </a>`;
      }).join('');
    } catch (e) {
      container.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── BILLS DUE SOON ────────────────────────────────────────────────
  async function loadBills() {
    const container = $('hub-due-soon');
    if (!container) return;
    try {
      const d = await getJSON('/api/bills');
      if (!d.ok) throw new Error(d.error || 'bills failed');

      const bills = (d.bills || []).filter(b => !b.paidThisPeriod);
      const upcoming = bills.slice().sort((a, b) => {
        const sortKey = b => {
          if (b.status === 'overdue') return -100;
          if (b.status === 'due-today') return -50;
          if (b.status === 'due-soon') return 0;
          return (b.due_day || 99);
        };
        return sortKey(a) - sortKey(b);
      }).slice(0, 6);

      if (!upcoming.length) {
        container.innerHTML = '<div class="empty-state-inline">All bills paid for this period 🎉</div>';
        return;
      }

      container.innerHTML = upcoming.map(b => {
        const dotClass = b.status === 'overdue' ? 'bill-status-overdue-dot' :
                         b.status === 'due-today' ? 'bill-status-due-today-dot' :
                         b.status === 'due-soon' ? 'bill-status-due-soon-dot' :
                         'bill-status-upcoming-dot';
        return `
          <a href="/bills.html" class="mini-row">
            <div class="mini-row-left">
              <span class="bill-status-dot ${dotClass}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px"></span>
              <div>
                <div class="mini-row-name">${escHtml(b.name)}</div>
                <div class="mini-row-sub">${escHtml(b.daysLabel || '')}</div>
              </div>
            </div>
            <div class="mini-row-right">
              <div class="mini-row-amount">${fmtPKR(b.amount)}</div>
            </div>
          </a>`;
      }).join('');
    } catch (e) {
      container.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── INIT ─────────────────────────────────────────────────────────
  function init() {
    // Hide the legacy "Day X of 90" badge if present
    const dayBadge = document.querySelector('.day-badge');
    if (dayBadge) dayBadge.style.display = 'none';

    loadBalances();
    loadRecentTxns();
    loadDebts();
    loadBills();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
