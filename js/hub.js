// ════════════════════════════════════════════════════════════════════
// hub.js — Hub renderer using design system v0.7.4 classes
// LOCKED · Sub-1D-2d (UI fix) · v0.0.7
//
// All output uses ONLY existing CSS classes:
//   .net-worth · .stats-row · .stat-card · .account-row · .debt-row
//   .tx-row · .mini-row · .hub-panel · .toast · .form-* · .primary-btn
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── helpers ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const today = () => new Date().toISOString().slice(0, 10);
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
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
    return r.json();
  }

  // Type → emoji icon for tx rows / categories where icon missing
  const TYPE_ICON = {
    expense: '💸', income: '💰', transfer: '💱',
    cc_payment: '💳', cc_spend: '💳',
    borrow: '📥', repay: '📤',
    atm: '🏧'
  };
  // Type → tx-amount color class
  const TYPE_AMT_CLASS = {
    income: 'positive', borrow: 'positive',
    expense: 'negative', repay: 'negative', cc_spend: 'negative', atm: 'negative',
    transfer: 'neutral', cc_payment: 'neutral'
  };

  // ─── LOADERS ──────────────────────────────────────────────────────
  async function loadBalances() {
    try {
      const d = await getJSON('/api/balances');
      if (!d.ok) throw new Error(d.error || 'balances failed');

      // Hero
      const nw = Number(d.net_worth || 0);
      $('m_networth').className = 'nw-value ' + (nw < 0 ? 'negative' : 'positive');
      $('m_networth').innerHTML = fmtPKR(nw) + '<span class="nw-currency">PKR</span>';

      $('m_liquid').textContent = fmtPKR(d.total_liquid_assets);
      $('m_cc').textContent     = fmtPKR(d.cc_outstanding);
      $('m_debts').textContent  = fmtPKR(d.total_owe || d.total_debts || 0);

      // Accounts
      const accts = d.accounts || [];
      const list  = $('acc-assets-list');
      let totalAssets = 0;

      if (!accts.length) {
        list.innerHTML = '<div class="empty-state-inline">No accounts</div>';
      } else {
        list.innerHTML = accts.map(a => {
          const bal = Number(a.balance ?? 0);
          if (a.type === 'asset') totalAssets += bal;
          const cls = bal > 0 ? 'positive' : (bal < 0 ? 'negative' : 'zero');
          const kindLabel = a.kind === 'cc' ? 'Credit Card' :
                            a.kind === 'cash' ? 'Cash' :
                            a.kind === 'wallet' ? 'Wallet' :
                            a.kind === 'prepaid' ? 'Prepaid' :
                            a.kind === 'bank' ? 'Bank' : (a.kind || '');
          return `
            <div class="account-row">
              <div class="account-left">
                <div class="account-icon">${escHtml(a.icon || '🏦')}</div>
                <div class="account-info">
                  <div class="account-name">${escHtml(a.name)}</div>
                  <div class="account-kind">${escHtml(kindLabel)}</div>
                </div>
              </div>
              <div class="account-balance ${cls}">${fmtPKR2(bal)}<span class="balance-currency">PKR</span></div>
            </div>`;
        }).join('');
      }

      $('acc-total-assets').textContent = fmtPKR(totalAssets);
    } catch (e) {
      $('m_networth').textContent = '—';
      $('acc-assets-list').innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  async function loadDebts() {
    try {
      const d = await getJSON('/api/debts');
      if (!d.ok) throw new Error(d.error || 'debts failed');
      const owe = (d.debts || []).filter(x => x.kind === 'owe' && x.status === 'active');
      owe.sort((a, b) => (b.original_amount - b.paid_amount) - (a.original_amount - a.paid_amount));
      const top = owe.slice(0, 5);

      if (!top.length) {
        $('topDebts').innerHTML = '<div class="empty-state-inline">No active debts 🎉</div>';
        return;
      }

      $('topDebts').innerHTML = top.map(x => {
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
      $('topDebts').innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  async function loadBills() {
    try {
      const d = await getJSON('/api/bills');
      if (!d.ok) throw new Error(d.error || 'bills failed');

      const today = new Date();
      const todayDay = today.getDate();
      const bills = (d.bills || []).map(b => {
        const due = b.due_day || 99;
        const days = due >= todayDay ? (due - todayDay) : (30 - todayDay + due);
        return { ...b, daysUntil: days };
      });

      const upcoming = bills.slice().sort((a, b) => a.daysUntil - b.daysUntil).slice(0, 6);
      const dueSoonCount = bills.filter(b => b.daysUntil <= 7).length;
      $('m_bills_count').textContent = String(dueSoonCount);

      if (!upcoming.length) {
        $('billsDue').innerHTML = '<div class="empty-state-inline">No bills</div>';
        return;
      }

      $('billsDue').innerHTML = upcoming.map(b => {
        const dotClass = b.daysUntil <= 0 ? 'bill-status-overdue-dot' :
                         b.daysUntil <= 3 ? 'bill-status-due-today-dot' :
                         b.daysUntil <= 7 ? 'bill-status-due-soon-dot' :
                         'bill-status-upcoming-dot';
        return `
          <div class="mini-row">
            <div class="mini-row-left">
              <span class="bill-status-dot ${dotClass}" style="display:inline-block;width:8px;height:8px;border-radius:50%"></span>
              <div>
                <div class="mini-row-name">${escHtml(b.name)}</div>
                <div class="mini-row-sub">Day ${b.due_day || '—'} · ${b.daysUntil === 0 ? 'today' : b.daysUntil + 'd'}</div>
              </div>
            </div>
            <div class="mini-row-right">
              <div class="mini-row-amount">${fmtPKR(b.amount)}</div>
            </div>
          </div>`;
      }).join('');
    } catch (e) {
      $('billsDue').innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      $('m_bills_count').textContent = '—';
    }
  }

  async function loadRecentTxns() {
    try {
      const d = await getJSON('/api/transactions');
      if (!d.ok) throw new Error(d.error || 'txns failed');
      const txns = (d.transactions || []).slice(0, 12);

      if (!txns.length) {
        $('recentTxns').innerHTML = '<div class="empty-state-inline">No transactions yet</div>';
        return;
      }

      $('recentTxns').innerHTML = txns.map(t => {
        const isReversed   = !!t.reversed_by;
        const isReverseRow = t.notes && t.notes.startsWith('REVERSAL of ');
        const icon = TYPE_ICON[t.type] || '📝';
        const amtCls = TYPE_AMT_CLASS[t.type] || 'neutral';
        const amtSign = (t.type === 'expense' || t.type === 'cc_spend' || t.type === 'repay' || t.type === 'atm') ? '−' : (t.type === 'income' || t.type === 'borrow') ? '+' : '';
        const sub = (isReversed ? '⊘ reversed · ' : isReverseRow ? '↩ reversal · ' : '')
                  + escHtml(t.account_id)
                  + (t.transfer_to_account_id ? ' → ' + escHtml(t.transfer_to_account_id) : '')
                  + ' · ' + escHtml(t.date);
        const titleNote = t.notes ? escHtml(t.notes.slice(0, 60)) : escHtml(t.type);
        const opacity = isReversed ? ';opacity:0.55;text-decoration:line-through' : '';
        const canReverse = !isReversed && !isReverseRow;
        const action = canReverse
          ? `<button class="dense-action" data-rev="${escHtml(t.id)}" data-amount="${t.amount}" data-type="${escHtml(t.type)}" title="Reverse this transaction" style="margin-left:10px;color:var(--danger);background:var(--danger-soft);border:1px solid rgba(244,63,94,0.25);cursor:pointer;font-family:inherit">↩</button>`
          : '';

        return `
          <div class="tx-row" style="${opacity}">
            <div class="tx-left">
              <div class="tx-icon">${icon}</div>
              <div class="tx-info">
                <div class="tx-name">${titleNote}</div>
                <div class="tx-sub">${sub}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center">
              <div class="tx-amount ${amtCls}">${amtSign}${fmtPKR(t.amount)}<span class="tx-currency">PKR</span></div>
              ${action}
            </div>
          </div>`;
      }).join('');

      // Wire reverse buttons
      document.querySelectorAll('button[data-rev]').forEach(btn => {
        btn.addEventListener('click', onReverseClick);
      });
    } catch (e) {
      $('recentTxns').innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── REVERSE HANDLER ──────────────────────────────────────────────
  async function onReverseClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const id     = btn.getAttribute('data-rev');
    const amount = parseFloat(btn.getAttribute('data-amount')) || 0;
    const type   = btn.getAttribute('data-type');

    const ok = window.confirm(
      `Reverse this transaction?\n\n` +
      `Type: ${type}\nAmount: ${fmtPKR(amount)}\nID: ${id}\n\n` +
      `This will:\n` +
      `• Snapshot the database first\n` +
      `• Insert opposite transaction\n` +
      `• Mark original as reversed\n` +
      `• Restore debt if applicable\n\nContinue?`
    );
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = '…';

    try {
      const r = await fetch('/api/transactions/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, created_by: 'web-hub' })
      });
      const data = await r.json();
      if (!data.ok) {
        toast('❌ ' + (data.error || 'Reverse failed'), 'err');
        btn.disabled = false; btn.textContent = '↩';
        return;
      }
      let msg = `✅ Reversed · snap ${data.snapshot_id}`;
      if (data.debt_restored) msg += ` · ${data.debt_restored.name} +${fmtPKR(data.debt_restored.amount_restored)}`;
      toast(msg);
      await Promise.all([loadBalances(), loadRecentTxns(), loadDebts()]);
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
      btn.disabled = false; btn.textContent = '↩';
    }
  }

  // ─── DROPDOWN POPULATORS ──────────────────────────────────────────
  async function populateAccounts() {
    try {
      const d = await getJSON('/api/balances');
      const accts = d.accounts || [];
      const opts = '<option value="">— select —</option>' +
        accts.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.icon || '')} ${escHtml(a.name)}</option>`).join('');
      $('f_account').innerHTML = opts;
      $('f_transferTo').innerHTML = '<option value="">— select destination —</option>' +
        accts.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.icon || '')} ${escHtml(a.name)}</option>`).join('');
    } catch (e) {}
  }

  function populateCategories() {
    const cats = [
      ['other', '🎯 Other'], ['food', '🍔 Food'], ['transport', '🚗 Transport'],
      ['bills', '🏠 Bills'], ['health', '💊 Health'], ['learning', '📚 Learning'],
      ['personal', '👕 Personal'], ['sadqah', '🎁 Sadqah/Zakat'], ['family', '💝 Family'],
      ['tech', '📱 Tech'], ['rent', '🏘️ Rent'], ['internet', '🌐 Internet'],
      ['mobile_plan', '📞 Mobile Plan'], ['debt_payment', '💸 Debt Payment'],
      ['salary', '💰 Salary'], ['transfer', '💱 Transfer'], ['cc_payment', '💳 CC Payment'],
      ['cc_spend', '💳 CC Spend'], ['atm_wd', '🏧 ATM Withdraw'], ['atm_fee', '🏧 ATM Fee'],
      ['intl_sub', '🌐 Intl Subscription'], ['fx_fee', '🏦 FX Fee'], ['biller', '🏦 Biller Charge']
    ];
    $('f_category').innerHTML = cats.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }

  // ─── FORM SUBMIT ──────────────────────────────────────────────────
  async function onSubmit(ev) {
    ev.preventDefault();
    const btn = $('f_submit');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const type = $('f_type').value;
    const payload = {
      date:        $('f_date').value || today(),
      type,
      amount:      parseFloat($('f_amount').value),
      account_id:  $('f_account').value,
      category_id: $('f_category').value || 'other',
      notes:       $('f_notes').value.trim(),
      created_by:  'web-hub'
    };

    if (type === 'transfer') {
      const dest = $('f_transferTo').value;
      if (!dest) { toast('Transfer needs a destination', 'err'); btn.disabled = false; btn.textContent = 'Add Transaction'; return; }
      if (dest === payload.account_id) { toast('Source and destination must differ', 'err'); btn.disabled = false; btn.textContent = 'Add Transaction'; return; }
      payload.transfer_to_account_id = dest;
    }

    try {
      const r = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!data.ok) {
        toast('❌ ' + (data.error || 'Save failed'), 'err');
      } else {
        toast(`✅ Saved · ${fmtPKR(payload.amount)} · ${type}`);
        $('addTxnForm').reset();
        $('f_date').value = today();
        $('f_transferWrap').style.display = 'none';
        await Promise.all([loadBalances(), loadRecentTxns()]);
      }
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add Transaction';
    }
  }

  function onTypeChange() {
    const t = $('f_type').value;
    $('f_transferWrap').style.display = (t === 'transfer') ? '' : 'none';
  }

  // ─── INIT ─────────────────────────────────────────────────────────
  function init() {
    $('f_date').value = today();
    populateAccounts();
    populateCategories();
    $('f_type').addEventListener('change', onTypeChange);
    $('addTxnForm').addEventListener('submit', onSubmit);

    loadBalances();
    loadDebts();
    loadBills();
    loadRecentTxns();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
