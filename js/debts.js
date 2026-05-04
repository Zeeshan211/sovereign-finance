/* ─── Sovereign Finance · Debts Page · v0.4.5 · Sub-1D-3c F5 ───
 * Adds:
 *   - ✏️ Edit button on every debt + receivable row
 *   - Edit modal (debts.html v0.3.3) wired: populate from row, PUT on save
 *   - Delete button inside Edit modal → confirm() → soft-delete via DELETE
 *
 * Backend contracts (debts/[[path]].js v0.2.0):
 *   PUT    /api/debts/{id}                → {name?, kind?, original_amount?, paid_amount?, notes?}
 *   DELETE /api/debts/{id}?created_by=web → soft-delete (status='deleted', snapshot + audit)
 */
(function () {
  'use strict';

  if (window._debtsInited) return;
  window._debtsInited = true;

  const VERSION = 'v0.4.5';
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

  /* ─────── + Add buttons ─────── */
  function injectAddButtons() {
    const headers = document.querySelectorAll('.section-header');
    console.log('[debts] inject + Add into', headers.length, 'section headers');
    headers.forEach(h => {
      if (h.querySelector('.add-debt-btn')) return;
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
        body: JSON.stringify({ name, original_amount: amount, kind, notes: notes || undefined })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[debts] addDebt POST →', r.status, 'ok');
        closeAddDebtModal();
        await loadAll();
      } else {
        alert('Add failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Debt'; }
    }
  }

  /* ─────── Edit Debt modal ─────── */
  let _editContext = null;

  function wireEditDebtModal() {
    const cancel = $('editDebtCancel');
    const confirm = $('editDebtConfirm');
    const del = $('editDebtDelete');
    const kindSel = $('editDebtKind');
    const backdrop = $('editDebtModal');
    if (cancel && !cancel._wired) {
      cancel.addEventListener('click', closeEditDebtModal);
      cancel._wired = true;
    }
    if (confirm && !confirm._wired) {
      confirm.addEventListener('click', confirmEditDebt);
      confirm._wired = true;
    }
    if (del && !del._wired) {
      del.addEventListener('click', deleteDebtFromEditModal);
      del._wired = true;
    }
    if (kindSel && !kindSel._wired) {
      kindSel.addEventListener('change', () => {
        const t = $('editDebtTitle');
        if (t) t.textContent = kindSel.value === 'owed' ? 'Edit Receivable' : 'Edit Debt';
      });
      kindSel._wired = true;
    }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) closeEditDebtModal();
      });
      backdrop._wired = true;
    }
  }

  function openEditDebtModal(debt) {
    _editContext = { id: debt.id, original: { ...debt } };
    const title = $('editDebtTitle');
    const sub = $('editDebtSub');
    const name = $('editDebtName');
    const kindSel = $('editDebtKind');
    const amt = $('editDebtAmount');
    const paid = $('editDebtPaid');
    const notes = $('editDebtNotes');
    if (title) title.textContent = debt.kind === 'owed' ? 'Edit Receivable' : 'Edit Debt';
    if (sub) sub.textContent = 'id: ' + debt.id;
    if (name) name.value = debt.name || '';
    if (kindSel) kindSel.value = debt.kind === 'owed' ? 'owed' : 'owe';
    if (amt) amt.value = debt.original_amount || 0;
    if (paid) paid.value = debt.paid_amount || 0;
    if (notes) notes.value = debt.notes || '';
    const m = $('editDebtModal');
    if (m) m.style.display = 'flex';
  }

  function closeEditDebtModal() {
    _editContext = null;
    const m = $('editDebtModal');
    if (m) m.style.display = 'none';
  }

  async function confirmEditDebt() {
    if (!_editContext) return;
    const name = (($('editDebtName') || {}).value || '').trim();
    const kind = (($('editDebtKind') || {}).value || 'owe');
    const amount = Number(($('editDebtAmount') || {}).value || 0);
    const paid = Number(($('editDebtPaid') || {}).value || 0);
    const notes = (($('editDebtNotes') || {}).value || '').trim();

    if (!name) { alert('Name is required'); return; }
    if (name.length > 80) { alert('Name max 80 chars'); return; }
    if (!amount || amount <= 0) { alert('Amount must be greater than 0'); return; }
    if (paid < 0) { alert('Paid cannot be negative'); return; }
    if (paid > amount) { alert('Paid cannot exceed Original Amount'); return; }

    const btn = $('editDebtConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/debts/' + encodeURIComponent(_editContext.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          name,
          kind,
          original_amount: amount,
          paid_amount: paid,
          notes
        })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[debts] editDebt PUT →', r.status, 'ok · fields', r.body.updated_fields);
        closeEditDebtModal();
        await loadAll();
      } else {
        alert('Save failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  async function deleteDebtFromEditModal() {
    if (!_editContext) return;
    const name = _editContext.original.name || _editContext.id;
    const ok = confirm(
      'Delete "' + name + '"?\n\n' +
      'This soft-deletes the debt (status set to "deleted"). ' +
      'A snapshot is taken before the change — recoverable via D1 console if needed. ' +
      'Row will disappear from this page.'
    );
    if (!ok) return;

    const btn = $('editDebtDelete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      const r = await getJSON(
        '/api/debts/' + encodeURIComponent(_editContext.id) + '?created_by=web',
        { method: 'DELETE', cache: 'no-store' }
      );
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[debts] deleteDebt DELETE →', r.status, 'ok · snapshot', r.body.snapshot_id);
        closeEditDebtModal();
        await loadAll();
      } else {
        alert('Delete failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Delete failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
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
        alert('Pay failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
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
          <div style="display:flex;gap:6px;margin-top:4px;justify-content:flex-end">
            <button class="primary-btn pay-btn" data-debt-id="${escHtml(d.id)}"
                    style="font-size:12px;padding:4px 10px">Pay</button>
            <button class="ghost-btn edit-btn" data-debt-id="${escHtml(d.id)}"
                    style="font-size:12px;padding:4px 10px" title="Edit / Delete">✏️</button>
          </div>
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
          <button class="ghost-btn edit-btn" data-debt-id="${escHtml(d.id)}"
                  style="font-size:12px;padding:4px 10px;margin-top:4px" title="Edit / Delete">✏️</button>
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
      oweContainer.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.debtId;
          const d = debts.find(x => x.id === id);
          if (d) openEditDebtModal(d);
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
        owedContainer.querySelectorAll('.edit-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.debtId;
            const d = debts.find(x => x.id === id);
            if (d) openEditDebtModal(d);
          });
        });
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
    wireEditDebtModal();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
