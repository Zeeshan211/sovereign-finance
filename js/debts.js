/* ─── Sovereign Finance · Debts Page · v0.4.4 · Sub-1D-3c F4 ───
 * Adds:
 *   - Wire #addDebtModal (Add Debt form ships in debts.html v0.3.2)
 *   - + Add buttons now open the modal (was placeholder alert)
 *   - Title swaps "Add Debt" / "Add Receivable" based on kind dropdown
 *   - Validates → POST /api/debts → reload on success
 *
 * Fixes from v0.4.3:
 *   - confirmPay() was sending body.dt_local but backend reads body.date,
 *     causing Pay to silently always use today's date instead of user's
 *     selected date. Renamed field to match backend contract.
 *
 * Backend contract verified (debts/[[path]].js v0.2.0):
 *   POST /api/debts        → {name, original_amount, kind?, paid_amount?, notes?}
 *   POST /api/debts/{id}/pay → {amount, account_id, date?, notes?}
 */
(function () {
  'use strict';

  if (window._debtsInited) return;
  window._debtsInited = true;

  const VERSION = 'v0.4.4';
  const $ = id => document.getElementById(id);

  const fmtPKR = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-PK');
  const fmtCount = (n, label) => (Number(n) || 0) + ' ' + label;
  const todayLocal = () => {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  };
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function getJSON(url, opts) {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    if (!r.ok && !opts) throw new Error('HTTP ' + r.status + ' on ' + url);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  function setStat(elId, value) {
    const el = $(elId);
    if (!el) return;
    const numeric = Number(value) || 0;
    if (window.animateNumber) {
      window.animateNumber(el, numeric, { format: n => fmtPKR(n) });
    } else {
      el.textContent = fmtPKR(numeric);
    }
  }

  /* ─────── + Add buttons (now open Add Debt modal) ─────── */
  function injectAddButtons() {
    const headers = document.querySelectorAll('.section-header');
    console.log('[debts] inject + Add into', headers.length, 'section headers');
    headers.forEach(h => {
      if (h.querySelector('.add-debt-btn')) return; // idempotent
      const label = (h.querySelector('.section-label')?.textContent || '').trim().toLowerCase();
      const kind = label === 'receivables' ? 'owed' : 'owe';
      const btn = document.createElement('button');
      btn.className = 'ghost-btn add-debt-btn';
      btn.style.marginLeft = 'auto';
      btn.style.fontSize = '12px';
      btn.style.padding = '4px 10px';
      btn.textContent = '+ Add';
      btn.dataset.kind = kind;
      btn.addEventListener('click', () => openAddDebtModal(kind));
      h.appendChild(btn);
    });
  }

  /* ─────── Add Debt modal ─────── */
  function wireAddDebtModal() {
    const cancel = $('addDebtCancel');
    const confirm = $('addDebtConfirm');
    const kindSel = $('addDebtKind');
    const backdrop = $('addDebtModal');
    if (cancel && !cancel._wired) {
      cancel.addEventListener('click', closeAddDebtModal);
      cancel._wired = true;
    }
    if (confirm && !confirm._wired) {
      confirm.addEventListener('click', confirmAddDebt);
      confirm._wired = true;
    }
    if (kindSel && !kindSel._wired) {
      kindSel.addEventListener('change', () => {
        const t = $('addDebtTitle');
        if (t) t.textContent = kindSel.value === 'owed' ? 'Add Receivable' : 'Add Debt';
      });
      kindSel._wired = true;
    }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) closeAddDebtModal();
      });
      backdrop._wired = true;
    }
  }

  function openAddDebtModal(kind) {
    const k = kind === 'owed' ? 'owed' : 'owe';
    const title = $('addDebtTitle');
    const name = $('addDebtName');
    const kindSel = $('addDebtKind');
    const amt = $('addDebtAmount');
    const notes = $('addDebtNotes');
    if (title) title.textContent = k === 'owed' ? 'Add Receivable' : 'Add Debt';
    if (name) name.value = '';
    if (kindSel) kindSel.value = k;
    if (amt) amt.value = '';
    if (notes) notes.value = '';
    const m = $('addDebtModal');
    if (m) m.style.display = 'flex';
    if (name) setTimeout(() => name.focus(), 50);
  }

  function closeAddDebtModal() {
    const m = $('addDebtModal');
    if (m) m.style.display = 'none';
  }

  async function confirmAddDebt() {
    const name = (($('addDebtName') || {}).value || '').trim();
    const kind = (($('addDebtKind') || {}).value || 'owe');
    const amount = Number(($('addDebtAmount') || {}).value || 0);
    const notes = (($('addDebtNotes') || {}).value || '').trim();

    if (!name) { alert('Name is required'); return; }
    if (name.length > 80) { alert('Name max 80 chars'); return; }
    if (!amount || amount <= 0) { alert('Amount must be greater than 0'); return; }

    const btn = $('addDebtConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await getJSON('/api/debts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          name,
          original_amount: amount,
          kind,
          notes: notes || undefined
        })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[debts] addDebt POST →', r.status, 'ok');
        closeAddDebtModal();
        await loadAll();
      } else {
        const err = (r.body && r.body.error) ? r.body.error : 'HTTP ' + r.status;
        alert('Add failed: ' + err);
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Debt'; }
    }
  }

  /* ─────── Pay modal ─────── */
  let _payContext = null;

  function wirePayModal() {
    const cancel = $('payCancel');
    const confirm = $('payConfirm');
    const backdrop = $('payModal');
    if (cancel && !cancel._wired) {
      cancel.addEventListener('click', closePayModal);
      cancel._wired = true;
    }
    if (confirm && !confirm._wired) {
      confirm.addEventListener('click', confirmPay);
      confirm._wired = true;
    }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) closePayModal();
      });
      backdrop._wired = true;
    }
  }

  function populatePayAccounts() {
    const sel = $('payAccount');
    if (!sel) return;
    const accounts = (window.store && window.store.cachedAccounts) || [];
    if (!accounts.length) {
      sel.innerHTML = '<option value="">⚠ no accounts loaded — refresh the page</option>';
      return;
    }
    sel.innerHTML = accounts
      .map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name)} (${escHtml(a.id)})</option>`)
      .join('');
  }

  function openPayModal(debt) {
    const remaining = (debt.original_amount || 0) - (debt.paid_amount || 0);
    _payContext = { id: debt.id, name: debt.name, remaining };
    const t = $('payModalTitle');
    const sub = $('payModalSub');
    const amt = $('payAmount');
    const date = $('payDate');
    if (t) t.textContent = 'Pay ' + debt.name;
    if (sub) sub.textContent = 'Remaining ' + fmtPKR(remaining);
    if (amt) amt.value = remaining > 0 ? remaining : '';
    if (date) date.value = todayLocal();
    populatePayAccounts();
    const m = $('payModal');
    if (m) m.style.display = 'flex';
  }

  function closePayModal() {
    _payContext = null;
    const m = $('payModal');
    if (m) m.style.display = 'none';
  }

  async function confirmPay() {
    if (!_payContext) return;
    const amt = Number(($('payAmount') || {}).value || 0);
    const accountId = ($('payAccount') || {}).value || '';
    const date = ($('payDate') || {}).value || todayLocal();
    if (!amt || amt <= 0) { alert('Enter a valid amount'); return; }
    if (!accountId) { alert('Select an account'); return; }
    const btn = $('payConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Paying…'; }
    try {
      // FIX v0.4.4: backend reads body.date (not dt_local). v0.4.3 silently dropped user's selected date.
      const r = await getJSON('/api/debts/' + encodeURIComponent(_payContext.id) + '/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ amount: amt, account_id: accountId, date: date })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[debts] pay POST →', r.status, 'ok · txn', r.body.txn_id);
        closePayModal();
        await loadAll();
      } else {
        alert('Pay failed: ' + (r.body && r.body.error ? r.body.error : 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Pay failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
    }
  }

  /* ─────── Renderers ─────── */
  function renderStats(debts, balances) {
    const owe = debts.filter(d => d.kind === 'owe' && d.status === 'active');
    const owed = debts.filter(d => d.kind === 'owed' && d.status === 'active');
    const totalOwe = owe.reduce((s, d) => s + ((d.original_amount || 0) - (d.paid_amount || 0)), 0);
    const totalOwed = owed.reduce((s, d) => s + ((d.original_amount || 0) - (d.paid_amount || 0)), 0);
    const cc = balances && balances.cc_outstanding ? Math.abs(Number(balances.cc_outstanding)) : 0;
    const burden = totalOwe + cc;

    setStat('debts-total-owe', totalOwe);
    setStat('debts-total-owed', totalOwed);
    setStat('debts-net-burden', burden);

    const oweCnt = $('debts-owe-count');
    if (oweCnt) oweCnt.textContent = fmtCount(owe.length, owe.length === 1 ? 'debt' : 'debts');
    const owedCnt = $('debts-owed-count');
    if (owedCnt) owedCnt.textContent = fmtCount(owed.length, owed.length === 1 ? 'receivable' : 'receivables');

    const summary = $('debts-summary');
    if (summary) {
      summary.textContent = 'Owing ' + fmtPKR(totalOwe) +
        (owed.length ? ' · Receiving ' + fmtPKR(totalOwed) : '');
    }
  }

  function renderOweRow(d) {
    const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
    const paidPct = d.original_amount > 0
      ? Math.min(100, Math.round((d.paid_amount || 0) / d.original_amount * 100))
      : 0;
    return `
      <div class="mini-row" data-debt-id="${escHtml(d.id)}">
        <div class="mini-row-left">
          <div class="mini-row-name">${escHtml(d.name)}</div>
          <div class="mini-row-sub">${paidPct}% paid · of ${fmtPKR(d.original_amount)}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount negative">${fmtPKR(remaining)}</div>
          <button class="primary-btn pay-btn" data-debt-id="${escHtml(d.id)}"
                  style="font-size:12px;padding:4px 10px;margin-top:4px">Pay</button>
        </div>
      </div>`;
  }

  function renderOwedRow(d) {
    const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
    return `
      <div class="mini-row" data-debt-id="${escHtml(d.id)}">
        <div class="mini-row-left">
          <div class="mini-row-name">${escHtml(d.name)}</div>
          <div class="mini-row-sub">of ${fmtPKR(d.original_amount)}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount accent">${fmtPKR(remaining)}</div>
        </div>
      </div>`;
  }

  function renderLists(debts) {
    const owe = debts
      .filter(d => d.kind === 'owe' && d.status === 'active')
      .sort((a, b) =>
        (a.snowball_order != null && b.snowball_order != null)
          ? a.snowball_order - b.snowball_order
          : ((b.original_amount - b.paid_amount) - (a.original_amount - a.paid_amount))
      );
    const owed = debts
      .filter(d => d.kind === 'owed' && d.status === 'active')
      .sort((a, b) => (b.original_amount - b.paid_amount) - (a.original_amount - a.paid_amount));

    const oweContainer = $('debts-owe-list');
    if (oweContainer) {
      oweContainer.innerHTML = owe.length
        ? owe.map(renderOweRow).join('')
        : '<div class="empty-state-inline">No active debts 🎉</div>';
      oweContainer.querySelectorAll('.pay-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.debtId;
          const d = debts.find(x => x.id === id);
          if (d) openPayModal(d);
        });
      });
    }

    const owedContainer = $('debts-owed-list');
    const owedHeader = $('receivables-header');
    if (owed.length === 0) {
      if (owedContainer) owedContainer.innerHTML = '';
      if (owedHeader) owedHeader.style.display = 'none';
    } else {
      if (owedHeader) owedHeader.style.display = '';
      if (owedContainer) {
        owedContainer.innerHTML = owed.map(renderOwedRow).join('');
      }
    }
  }

  /* ─────── Loader ─────── */
  async function loadAll() {
    console.log('[debts]', VERSION, 'loadAll start');
    try {
      const [debtsR, balR] = await Promise.all([
        fetch('/api/debts', { cache: 'no-store' }),
        fetch('/api/balances', { cache: 'no-store' })
      ]);
      console.log('[debts] /api/debts', debtsR.status, '/api/balances', balR.status);
      const debtsBody = await debtsR.json();
      const balBody = await balR.json();

      if (!debtsBody.ok) throw new Error(debtsBody.error || 'debts payload not ok');

      const debts = debtsBody.debts || [];
      const balances = balBody.ok ? balBody : {};

      if (window.store) {
        window.store.cachedDebts = debts;
        if (balBody.accounts) window.store.cachedAccounts = balBody.accounts;
      }

      renderStats(debts, balances);
      renderLists(debts);
      console.log('[debts] render complete:', debts.length, 'debts');
    } catch (e) {
      console.error('[debts] loadAll FAILED:', e);
      const owe = $('debts-owe-list');
      if (owe) owe.innerHTML = '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>';
      const sum = $('debts-summary');
      if (sum) sum.textContent = 'load failed';
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[debts]', VERSION, 'init');
    injectAddButtons();
    wirePayModal();
    wireAddDebtModal();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
