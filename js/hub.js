// ════════════════════════════════════════════════════════════════════
// hub.js — Hub page: Add Txn form + summaries + accounts + debts + bills + recent
// LOCKED · Sub-1D-2c · v0.0.5
//
// Loaders: balances, accounts, debts, bills, transactions, categories
// Form: addTxnForm POST → /api/transactions (audit auto-fires server-side)
// Toast: success / error feedback
// Auto-refresh on submit success
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── helpers ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmtPKR = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
  const fmtPKR2 = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => new Date().toISOString().slice(0, 10);

  function toast(msg, kind = 'ok') {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + (kind === 'err' ? 'err' : 'ok');
    setTimeout(() => { t.className = 'toast'; }, 3500);
  }

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
    return r.json();
  }

  // ─── LOADERS ──────────────────────────────────────────────────────
  async function loadBalances() {
    try {
      const d = await getJSON('/api/balances');
      if (!d.ok) throw new Error(d.error || 'balances failed');

      $('m_networth').textContent = fmtPKR(d.net_worth);
      $('m_liquid').textContent   = fmtPKR(d.total_liquid_assets);
      $('m_cc').textContent       = fmtPKR(d.cc_outstanding);
      $('m_debts').textContent    = fmtPKR(d.total_owe || d.total_debts || 0);

      const grid = $('accountsList');
      const accts = (d.accounts || []).filter(a => a.type === 'asset' || a.kind === 'cc');
      if (!accts.length) {
        grid.innerHTML = '<div class="empty">No accounts</div>';
      } else {
        grid.innerHTML = accts.map(a => `
          <div class="acct-card ${a.kind === 'cc' ? 'liab' : 'asset'}">
            <div class="acct-icon">${a.icon || '🏦'}</div>
            <div class="acct-name">${a.name}</div>
            <div class="acct-bal">${fmtPKR2(a.balance ?? 0)}</div>
          </div>
        `).join('');
      }
    } catch (e) {
      $('m_networth').textContent = '—';
      $('m_liquid').textContent   = '—';
      $('m_cc').textContent       = '—';
      $('m_debts').textContent    = '—';
      $('accountsList').innerHTML = '<div class="err">Failed to load: ' + e.message + '</div>';
    }
  }

  async function loadDebts() {
    try {
      const d = await getJSON('/api/debts');
      if (!d.ok) throw new Error(d.error || 'debts failed');
      const owe = (d.debts || []).filter(x => x.kind === 'owe' && x.status === 'active');
      owe.sort((a, b) => (b.original_amount - b.paid_amount) - (a.original_amount - a.paid_amount));
      const top = owe.slice(0, 5);

      $('topDebts').innerHTML = top.length ? top.map(x => {
        const remaining = (x.original_amount || 0) - (x.paid_amount || 0);
        const pct = x.original_amount ? Math.min(100, Math.round((x.paid_amount / x.original_amount) * 100)) : 0;
        return `
          <div class="debt-row">
            <div class="debt-name">${x.name}</div>
            <div class="debt-bar"><div class="debt-fill" style="width:${pct}%"></div></div>
            <div class="debt-amt">${fmtPKR(remaining)} <small>of ${fmtPKR(x.original_amount)}</small></div>
          </div>`;
      }).join('') : '<div class="empty">No active debts 🎉</div>';
    } catch (e) {
      $('topDebts').innerHTML = '<div class="err">Failed: ' + e.message + '</div>';
    }
  }

  async function loadBills() {
    try {
      const d = await getJSON('/api/bills');
      if (!d.ok) throw new Error(d.error || 'bills failed');
      const bills = d.bills || [];
      const sorted = bills.slice().sort((a, b) => (a.due_day || 99) - (b.due_day || 99));
      const upcoming = sorted.slice(0, 6);

      $('billsDue').innerHTML = upcoming.length ? upcoming.map(b => `
        <div class="bill-row">
          <div class="bill-name">${b.name}</div>
          <div class="bill-day">Day ${b.due_day || '—'}</div>
          <div class="bill-amt">${fmtPKR(b.amount)}</div>
        </div>`).join('') : '<div class="empty">No bills configured</div>';
    } catch (e) {
      $('billsDue').innerHTML = '<div class="err">Failed: ' + e.message + '</div>';
    }
  }

  async function loadRecentTxns() {
    try {
      const d = await getJSON('/api/transactions');
      if (!d.ok) throw new Error(d.error || 'txns failed');
      const txns = (d.transactions || []).slice(0, 10);

      $('recentTxns').innerHTML = txns.length ? `
        <table class="txn-table">
          <thead><tr><th>Date</th><th>Type</th><th>Account</th><th>Notes</th><th class="r">Amount</th></tr></thead>
          <tbody>
            ${txns.map(t => `
              <tr class="t-${t.type}">
                <td>${t.date}</td>
                <td>${t.type}</td>
                <td>${t.account_id}${t.transfer_to_account_id ? ' → ' + t.transfer_to_account_id : ''}</td>
                <td class="ellip">${(t.notes || '').slice(0, 40)}</td>
                <td class="r">${fmtPKR2(t.amount)}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No transactions yet</div>';
    } catch (e) {
      $('recentTxns').innerHTML = '<div class="err">Failed: ' + e.message + '</div>';
    }
  }

  // ─── DROPDOWN POPULATORS (form) ───────────────────────────────────
  async function populateAccounts() {
    try {
      const d = await getJSON('/api/balances');
      const accts = d.accounts || [];
      const opts = '<option value="">— select —</option>' +
        accts.map(a => `<option value="${a.id}">${a.icon || ''} ${a.name}</option>`).join('');
      $('f_account').innerHTML = opts;
      $('f_transferTo').innerHTML = '<option value="">— select destination —</option>' +
        accts.map(a => `<option value="${a.id}">${a.icon || ''} ${a.name}</option>`).join('');
    } catch (e) {
      // silent — form still works with manual ids if needed
    }
  }

  async function populateCategories() {
    // Categories endpoint not built yet (Sub-1D-2d). For now, hardcode the seeded list.
    const cats = [
      ['other',        '🎯 Other'],
      ['food',         '🍔 Food'],
      ['transport',    '🚗 Transport'],
      ['bills',        '🏠 Bills'],
      ['health',       '💊 Health'],
      ['learning',     '📚 Learning'],
      ['personal',     '👕 Personal'],
      ['sadqah',       '🎁 Sadqah/Zakat'],
      ['family',       '💝 Family'],
      ['tech',         '📱 Tech'],
      ['rent',         '🏘️ Rent'],
      ['internet',     '🌐 Internet'],
      ['mobile_plan',  '📞 Mobile Plan'],
      ['debt_payment', '💸 Debt Payment'],
      ['salary',       '💰 Salary'],
      ['transfer',     '💱 Transfer'],
      ['cc_payment',   '💳 CC Payment'],
      ['cc_spend',     '💳 CC Spend'],
      ['atm_wd',       '🏧 ATM Withdraw'],
      ['atm_fee',      '🏧 ATM Fee'],
      ['intl_sub',     '🌐 Intl Subscription'],
      ['fx_fee',       '🏦 FX Fee'],
      ['biller',       '🏦 Biller Charge']
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
      if (!dest) {
        toast('Transfer needs a destination account', 'err');
        btn.disabled = false; btn.textContent = 'Add Transaction';
        return;
      }
      if (dest === payload.account_id) {
        toast('Source and destination cannot be the same', 'err');
        btn.disabled = false; btn.textContent = 'Add Transaction';
        return;
      }
      payload.transfer_to_account_id = dest;
    }

    try {
      const r = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await r.json();

      if (!d.ok) {
        toast('❌ ' + (d.error || 'Save failed'), 'err');
      } else {
        toast(`✅ Saved · ${fmtPKR(payload.amount)} · ${type}` + (d.audited ? '' : ' (audit log skipped)'));
        $('addTxnForm').reset();
        $('f_date').value = today();
        $('f_transferLabel').style.display = 'none';
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
    $('f_transferLabel').style.display = (t === 'transfer') ? '' : 'none';
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
