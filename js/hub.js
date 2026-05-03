// ════════════════════════════════════════════════════════════════════
// hub.js — Hub page: Add Txn form + summaries + accounts + debts + bills + recent + reverse
// LOCKED · Sub-1D-2d · v0.0.6
//
// CHANGES from v0.0.5:
//   - Recent Transactions table now has Reverse column
//   - Reversed rows shown with strikethrough + "REVERSED" tag
//   - Reverse rows (linked back to original) shown with ↩ tag
//   - Click Reverse → confirm dialog → POST /api/transactions/reverse → toast + refresh
// ════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── helpers ──────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmtPKR = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { maximumFractionDigits: 0 });
  const fmtPKR2 = n => 'Rs ' + (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = () => new Date().toISOString().slice(0, 10);
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
            <div class="acct-icon">${escHtml(a.icon || '🏦')}</div>
            <div class="acct-name">${escHtml(a.name)}</div>
            <div class="acct-bal">${fmtPKR2(a.balance ?? 0)}</div>
          </div>
        `).join('');
      }
    } catch (e) {
      $('m_networth').textContent = '—';
      $('m_liquid').textContent   = '—';
      $('m_cc').textContent       = '—';
      $('m_debts').textContent    = '—';
      $('accountsList').innerHTML = '<div class="err">Failed to load: ' + escHtml(e.message) + '</div>';
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
            <div class="debt-name">${escHtml(x.name)}</div>
            <div class="debt-bar"><div class="debt-fill" style="width:${pct}%"></div></div>
            <div class="debt-amt">${fmtPKR(remaining)} <small>of ${fmtPKR(x.original_amount)}</small></div>
          </div>`;
      }).join('') : '<div class="empty">No active debts 🎉</div>';
    } catch (e) {
      $('topDebts').innerHTML = '<div class="err">Failed: ' + escHtml(e.message) + '</div>';
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
          <div class="bill-name">${escHtml(b.name)}</div>
          <div class="bill-day">Day ${b.due_day || '—'}</div>
          <div class="bill-amt">${fmtPKR(b.amount)}</div>
        </div>`).join('') : '<div class="empty">No bills configured</div>';
    } catch (e) {
      $('billsDue').innerHTML = '<div class="err">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  async function loadRecentTxns() {
    try {
      const d = await getJSON('/api/transactions');
      if (!d.ok) throw new Error(d.error || 'txns failed');
      const txns = (d.transactions || []).slice(0, 15);

      if (!txns.length) {
        $('recentTxns').innerHTML = '<div class="empty">No transactions yet</div>';
        return;
      }

      const rows = txns.map(t => {
        const isReversed = !!t.reversed_by;
        const isReverseRow = t.notes && t.notes.startsWith('REVERSAL of ');
        const rowClass = `t-${t.type}` + (isReversed ? ' reversed' : '') + (isReverseRow ? ' is-reversal' : '');
        const tag = isReversed ? '<span class="badge rev">REVERSED</span>' :
                    isReverseRow ? '<span class="badge rev-link">↩ reversal</span>' : '';
        const action = (isReversed || isReverseRow)
          ? '<span class="muted">—</span>'
          : `<button class="btn-mini btn-danger" data-rev="${escHtml(t.id)}" data-amount="${t.amount}" data-type="${escHtml(t.type)}">↩ Reverse</button>`;

        return `
          <tr class="${rowClass}">
            <td>${escHtml(t.date)}</td>
            <td>${escHtml(t.type)} ${tag}</td>
            <td>${escHtml(t.account_id)}${t.transfer_to_account_id ? ' → ' + escHtml(t.transfer_to_account_id) : ''}</td>
            <td class="ellip" title="${escHtml(t.notes || '')}">${escHtml((t.notes || '').slice(0, 40))}</td>
            <td class="r">${fmtPKR2(t.amount)}</td>
            <td class="r">${action}</td>
          </tr>`;
      }).join('');

      $('recentTxns').innerHTML = `
        <table class="txn-table">
          <thead><tr>
            <th>Date</th><th>Type</th><th>Account</th><th>Notes</th>
            <th class="r">Amount</th><th class="r">Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;

      // Wire reverse buttons
      document.querySelectorAll('button[data-rev]').forEach(btn => {
        btn.addEventListener('click', onReverseClick);
      });
    } catch (e) {
      $('recentTxns').innerHTML = '<div class="err">Failed: ' + escHtml(e.message) + '</div>';
    }
  }

  // ─── REVERSE HANDLER ──────────────────────────────────────────────
  async function onReverseClick(ev) {
    const btn = ev.currentTarget;
    const id     = btn.getAttribute('data-rev');
    const amount = parseFloat(btn.getAttribute('data-amount')) || 0;
    const type   = btn.getAttribute('data-type');

    const confirmed = window.confirm(
      `Reverse this transaction?\n\n` +
      `Type: ${type}\nAmount: ${fmtPKR(amount)}\nID: ${id}\n\n` +
      `This will:\n` +
      `• Snapshot the database first\n` +
      `• Insert an opposite transaction\n` +
      `• Mark the original as reversed\n` +
      `• Restore debt balance if applicable\n\n` +
      `Continue?`
    );
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = 'Reversing…';

    try {
      const r = await fetch('/api/transactions/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, created_by: 'web-hub' })
      });
      const d = await r.json();

      if (!d.ok) {
        toast('❌ ' + (d.error || 'Reverse failed'), 'err');
        btn.disabled = false;
        btn.textContent = '↩ Reverse';
        return;
      }

      let msg = `✅ Reversed · snapshot ${d.snapshot_id}`;
      if (d.debt_restored) {
        msg += ` · debt ${d.debt_restored.name} restored ${fmtPKR(d.debt_restored.amount_restored)}`;
      }
      toast(msg);
      await Promise.all([loadBalances(), loadRecentTxns(), loadDebts()]);
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '↩ Reverse';
    }
  }

  // ─── DROPDOWN POPULATORS (form) ───────────────────────────────────
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
