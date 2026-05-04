/* ─── Sovereign Finance · Debts Page · v0.4.0 · Sub-1D-3c-F3 ───
 * Full CRUD + Pay action.
 *
 * Existing v0.0.7 was read-only.
 * v0.4.0 adds:
 *   - Stats row (total owe / owed / count)
 *   - "+ Add Debt" button → POST /api/debts (audit-wired)
 *   - Per-row [Pay] [Edit] [Delete] buttons
 *   - Pay      → POST /api/debts/{id}/pay (atomic txn + paid bump + audit)
 *   - Edit     → PUT  /api/debts/{id}     (snapshot + audit)
 *   - Delete   → DELETE /api/debts/{id}   (soft-delete + snapshot + audit)
 *
 * UX: uses native prompt()/confirm() for now (lightweight, mobile-friendly).
 * Polished modals can come later as a separate UX pass.
 *
 * Cache-bust: every API read uses { cache: 'no-store' }.
 */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', initDebtsPage);

  let liveAccounts = [];

  /* ─── INIT ─── */
  async function initDebtsPage() {
    /* Wire "+ Add Debt" button if present */
    const addBtn = document.getElementById('addDebtBtn');
    if (addBtn) addBtn.addEventListener('click', onAddClick);

    /* Wire optional kind filter */
    const filterBtns = document.querySelectorAll('.debts-filter');
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderDebts(btn.dataset.filter);
      });
    });

    await loadAll();
  }

  /* ─── LOAD ─── */
  async function loadAll() {
    try {
      const [debtsRes, balRes] = await Promise.all([
        fetch('/api/debts', { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/balances', { cache: 'no-store' }).then(r => r.json())
      ]);

      if (!debtsRes.ok) throw new Error(debtsRes.error || 'debts failed');

      window.store.cachedDebts = debtsRes.debts || [];
      liveAccounts = balRes.ok ? (balRes.accounts || []) : [];

      renderStats(debtsRes);
      renderDebts(getActiveFilter());
    } catch (err) {
      const list = document.getElementById('debtsList');
      if (list) list.innerHTML = `<div class="empty-state-inline">Failed: ${escHtml(err.message)}</div>`;
    }
  }

  /* ─── STATS ROW ─── */
  function renderStats(d) {
    const totalOweEl  = document.getElementById('debts-total-owe');
    const totalOwedEl = document.getElementById('debts-total-owed');
    const countEl     = document.getElementById('debts-count');
    if (totalOweEl)  totalOweEl.textContent  = fmtPKR(d.total_owe || 0);
    if (totalOwedEl) totalOwedEl.textContent = fmtPKR(d.total_owed || 0);
    if (countEl)     countEl.textContent     = String(d.count || 0);
  }

  function getActiveFilter() {
    const active = document.querySelector('.debts-filter.active');
    return active ? active.dataset.filter : 'all';
  }

  /* ─── RENDER LIST ─── */
  function renderDebts(filter) {
    const list = document.getElementById('debtsList');
    if (!list) return;
    const debts = (window.store.cachedDebts || []).filter(d => {
      if (filter === 'owe')  return d.kind === 'owe';
      if (filter === 'owed') return d.kind === 'owed';
      return true;
    });

    if (debts.length === 0) {
      list.innerHTML = '<div class="empty-state-inline">No debts in this view 🎉</div>';
      return;
    }

    list.innerHTML = debts.map(d => {
      const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
      const pct = d.original_amount > 0
        ? Math.round(((d.paid_amount || 0) / d.original_amount) * 100)
        : 0;
      const fullyPaid = remaining <= 0.01;
      const cls = d.kind === 'owe' ? 'negative' : 'positive';
      const arrow = d.kind === 'owe' ? '↓' : '↑';

      const safeId = escHtml(d.id);
      const payBtn = fullyPaid
        ? `<button class="dense-action" disabled style="opacity:0.4;cursor:not-allowed">paid ✓</button>`
        : `<button class="dense-action" data-act="pay" data-id="${safeId}" title="Log a payment">+ Pay</button>`;

      return `
        <div class="debt-row" data-debt-id="${safeId}">
          <div class="debt-header">
            <div>
              <div class="debt-name">${escHtml(d.name)}</div>
              <div class="debt-kind muted">${arrow} ${d.kind === 'owe' ? 'You owe' : 'Owed to you'} · #${d.snowball_order || '—'}${d.notes ? ' · ' + escHtml(d.notes.slice(0, 60)) : ''}</div>
            </div>
            <div class="debt-amounts" style="text-align:right">
              <div class="debt-remaining ${cls}">${fmtPKRfull(remaining)}<span class="amount-currency">PKR</span></div>
              <div class="debt-original muted">${pct}% paid · of ${fmtPKR(d.original_amount)}</div>
            </div>
          </div>
          <div class="progress-bar" style="margin-top:8px">
            <div class="progress-fill ${cls}" style="width:${pct}%"></div>
          </div>
          <div class="debt-actions" style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">
            ${payBtn}
            <button class="dense-action" data-act="edit"   data-id="${safeId}" title="Edit fields">✎ Edit</button>
            <button class="dense-action" data-act="delete" data-id="${safeId}" title="Soft-delete (audit-safe)" style="color:var(--danger)">🗑 Delete</button>
          </div>
        </div>`;
    }).join('');

    /* Wire row buttons */
    list.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', onActionClick);
    });
  }

  /* ─── ACTIONS ─── */
  async function onActionClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const act = btn.getAttribute('data-act');
    const id  = btn.getAttribute('data-id');
    if (act === 'pay')    return onPayClick(id);
    if (act === 'edit')   return onEditClick(id);
    if (act === 'delete') return onDeleteClick(id);
  }

  /* ─── + ADD DEBT ─── */
  async function onAddClick() {
    const name = window.prompt('Debt name (e.g. "CRED-7" or "Hassan loan"):');
    if (!name || !name.trim()) return;

    const kindRaw = window.prompt('Type: owe or owed (default: owe)\n· "owe" = you owe money to them\n· "owed" = they owe money to you', 'owe');
    if (kindRaw === null) return;
    const kind = kindRaw.trim().toLowerCase() === 'owed' ? 'owed' : 'owe';

    const amountRaw = window.prompt('Original amount (PKR):');
    if (amountRaw === null) return;
    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount <= 0) {
      toast('❌ Invalid amount', 'err');
      return;
    }

    const paidRaw = window.prompt('Already paid so far (PKR, default 0):', '0');
    if (paidRaw === null) return;
    const paid = Math.max(0, parseFloat(paidRaw) || 0);

    const notes = window.prompt('Notes (optional):', '') || '';

    try {
      const r = await fetch('/api/debts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          original_amount: amount,
          paid_amount: paid,
          notes: notes.trim(),
          created_by: 'web-debts'
        })
      });
      const d = await r.json();
      if (!d.ok) {
        toast('❌ ' + (d.error || 'Add failed'), 'err');
        return;
      }
      toast(`✅ Added ${d.name} · #${d.snowball_order}`);
      await loadAll();
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    }
  }

  /* ─── PAY ─── */
  async function onPayClick(id) {
    const debt = (window.store.cachedDebts || []).find(d => d.id === id);
    if (!debt) { toast('❌ Debt not found', 'err'); return; }
    const remaining = (debt.original_amount || 0) - (debt.paid_amount || 0);

    const amountRaw = window.prompt(
      `Pay how much to "${debt.name}"?\nRemaining: Rs ${fmtPKR(remaining)}`,
      String(Math.min(remaining, 1000))
    );
    if (amountRaw === null) return;
    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount <= 0) { toast('❌ Invalid amount', 'err'); return; }
    if (amount > remaining + 0.01) { toast(`❌ Max ${remaining} for this debt`, 'err'); return; }

    const accountList = liveAccounts
      .filter(a => a.type === 'asset')
      .map((a, i) => `${i + 1}. ${a.icon || '🏦'} ${a.name} (Rs ${fmtPKR(a.balance)})`)
      .join('\n');
    const accountRaw = window.prompt(
      `Pay from which account? Type the NUMBER:\n\n${accountList}`,
      '1'
    );
    if (accountRaw === null) return;
    const accIdx = parseInt(accountRaw, 10) - 1;
    const assets = liveAccounts.filter(a => a.type === 'asset');
    if (isNaN(accIdx) || accIdx < 0 || accIdx >= assets.length) {
      toast('❌ Invalid account choice', 'err');
      return;
    }
    const accountId = assets[accIdx].id;

    const notes = window.prompt('Notes (optional):', '') || '';

    try {
      const r = await fetch(`/api/debts/${encodeURIComponent(id)}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          account_id: accountId,
          notes: notes.trim(),
          created_by: 'web-debts'
        })
      });
      const d = await r.json();
      if (!d.ok) { toast('❌ ' + (d.error || 'Pay failed'), 'err'); return; }
      const status = d.fully_paid ? '🎉 FULLY PAID' : `Rs ${fmtPKR(d.remaining_after)} left`;
      toast(`✅ Paid Rs ${fmtPKR(amount)} · ${status}`);
      await loadAll();
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    }
  }

  /* ─── EDIT ─── */
  async function onEditClick(id) {
    const debt = (window.store.cachedDebts || []).find(d => d.id === id);
    if (!debt) { toast('❌ Debt not found', 'err'); return; }

    const choice = window.prompt(
      `Edit which field of "${debt.name}"? Type the NUMBER:\n\n` +
      `1. Name (current: ${debt.name})\n` +
      `2. Original amount (current: Rs ${fmtPKR(debt.original_amount)})\n` +
      `3. Paid amount (current: Rs ${fmtPKR(debt.paid_amount)})\n` +
      `4. Snowball order (current: ${debt.snowball_order})\n` +
      `5. Notes (current: ${debt.notes || '—'})\n` +
      `6. Mark fully paid (sets paid = original)`,
      '1'
    );
    if (choice === null) return;

    const updates = {};
    switch (choice.trim()) {
      case '1': {
        const v = window.prompt('New name:', debt.name);
        if (v === null || !v.trim()) return;
        updates.name = v.trim();
        break;
      }
      case '2': {
        const v = window.prompt('New original amount (PKR):', String(debt.original_amount));
        if (v === null) return;
        const n = parseFloat(v);
        if (isNaN(n) || n <= 0) { toast('❌ Invalid', 'err'); return; }
        updates.original_amount = n;
        break;
      }
      case '3': {
        const v = window.prompt('New paid amount (PKR):', String(debt.paid_amount));
        if (v === null) return;
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) { toast('❌ Invalid', 'err'); return; }
        updates.paid_amount = n;
        break;
      }
      case '4': {
        const v = window.prompt('New snowball order:', String(debt.snowball_order || ''));
        if (v === null) return;
        const n = parseInt(v, 10);
        if (isNaN(n) || n <= 0) { toast('❌ Invalid', 'err'); return; }
        updates.snowball_order = n;
        break;
      }
      case '5': {
        const v = window.prompt('Notes:', debt.notes || '');
        if (v === null) return;
        updates.notes = v;
        break;
      }
      case '6': {
        if (!window.confirm(`Mark "${debt.name}" as fully paid (Rs ${fmtPKR(debt.original_amount)})?`)) return;
        updates.paid_amount = debt.original_amount;
        break;
      }
      default:
        toast('❌ Invalid choice', 'err');
        return;
    }

    updates.created_by = 'web-debts';

    try {
      const r = await fetch(`/api/debts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const d = await r.json();
      if (!d.ok) { toast('❌ ' + (d.error || 'Edit failed'), 'err'); return; }
      toast(`✅ Updated · snap ${d.snapshot_id}`);
      await loadAll();
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    }
  }

  /* ─── DELETE (soft) ─── */
  async function onDeleteClick(id) {
    const debt = (window.store.cachedDebts || []).find(d => d.id === id);
    if (!debt) { toast('❌ Debt not found', 'err'); return; }

    const ok = window.confirm(
      `Soft-delete "${debt.name}"?\n\n` +
      `This sets status='deleted' (the record + audit trail are KEPT).\n` +
      `It hides from the Debts list but remains in snapshots/audit log.\n\n` +
      `Continue?`
    );
    if (!ok) return;

    try {
      const r = await fetch(`/api/debts/${encodeURIComponent(id)}?created_by=web-debts`, {
        method: 'DELETE'
      });
      const d = await r.json();
      if (!d.ok) { toast('❌ ' + (d.error || 'Delete failed'), 'err'); return; }
      toast(`✅ Deleted · snap ${d.snapshot_id}`);
      await loadAll();
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    }
  }

  /* ─── HELPERS ─── */
  function fmtPKR(n) {
    return Math.round(Number(n) || 0).toLocaleString('en-PK');
  }
  function fmtPKRfull(n) {
    return Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'toast toast-' + (kind === 'err' || kind === 'error' ? 'error' : 'success');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }
})();
