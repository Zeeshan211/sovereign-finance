/* ─── Sovereign Finance · Debts Page · v0.4.2 · Sub-1D-3c-fix3 ───
 * Same as v0.4.1 + verbose console.log checkpoints throughout init/load/render.
 * If anything breaks, F12 Console tells us exactly which step failed.
 *
 * Once we identify the bug, v0.4.3 will remove the logs.
 */

(function () {
  'use strict';

  console.log('[debts] v0.4.2 script loaded');

  document.addEventListener('DOMContentLoaded', () => {
    console.log('[debts] DOMContentLoaded fired');
    initDebtsPage().catch(err => {
      console.error('[debts] init crashed:', err);
    });
  });

  let liveAccounts = [];

  async function initDebtsPage() {
    console.log('[debts] initDebtsPage start');
    console.log('[debts] window.store exists?', !!window.store);
    console.log('[debts] window.store.cachedDebts?', window.store && window.store.cachedDebts);

    injectAddButtons();
    console.log('[debts] add buttons injected');

    await loadAll();
    console.log('[debts] initDebtsPage done');
  }

  function injectAddButtons() {
    const headers = document.querySelectorAll('.section-header');
    console.log('[debts] found', headers.length, 'section-header elements');
    headers.forEach((header, i) => {
      const label = header.querySelector('.section-label');
      if (!label) {
        console.log('[debts]   header', i, 'has no .section-label, skipping');
        return;
      }
      const labelText = (label.textContent || '').toLowerCase();
      console.log('[debts]   header', i, 'label =', JSON.stringify(labelText));
      let kind = null;
      if (labelText.includes('snowball')) kind = 'owe';
      else if (labelText.includes('receivable')) kind = 'owed';
      if (!kind) {
        console.log('[debts]   skipping (label not snowball/receivable)');
        return;
      }
      if (header.querySelector('.add-debt-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'dense-action add-debt-btn';
      btn.textContent = '+ Add';
      btn.addEventListener('click', () => onAddClick(kind));
      header.appendChild(btn);
      console.log('[debts]   added + Add button for kind =', kind);
    });
  }

  async function loadAll() {
    console.log('[debts] loadAll start');
    try {
      console.log('[debts] fetching /api/debts and /api/balances in parallel');
      const [debtsRes, balRes] = await Promise.all([
        fetch('/api/debts', { cache: 'no-store' }).then(r => {
          console.log('[debts] /api/debts status =', r.status);
          return r.json();
        }),
        fetch('/api/balances', { cache: 'no-store' }).then(r => {
          console.log('[debts] /api/balances status =', r.status);
          return r.json();
        })
      ]);

      console.log('[debts] debtsRes.ok?', debtsRes.ok, 'count?', debtsRes.count);
      console.log('[debts] balRes.ok?', balRes.ok);

      if (!debtsRes.ok) {
        throw new Error('debts API: ' + (debtsRes.error || 'unknown'));
      }

      window.store.cachedDebts = debtsRes.debts || [];
      liveAccounts = balRes.ok ? (balRes.accounts || []) : [];
      console.log('[debts] cached', window.store.cachedDebts.length, 'debts;', liveAccounts.length, 'accounts');

      renderStats(debtsRes);
      console.log('[debts] renderStats done');

      renderLists(debtsRes.debts || []);
      console.log('[debts] renderLists done');
    } catch (err) {
      console.error('[debts] loadAll failed:', err);
      const oweList  = document.getElementById('owe-list');
      const owedList = document.getElementById('owed-list');
      const msg = `<div class="empty-state-inline">Failed: ${escHtml(err.message)}</div>`;
      if (oweList)  oweList.innerHTML  = msg;
      if (owedList) owedList.innerHTML = msg;
    }
  }

  function renderStats(d) {
    console.log('[debts] renderStats called with', d.count, 'debts');
    const owe  = (d.debts || []).filter(x => x.kind === 'owe');
    const owed = (d.debts || []).filter(x => x.kind === 'owed');

    const set = (id, val) => {
      const el = document.getElementById(id);
      console.log('[debts]   setting #' + id + ' (exists?', !!el, ') =', val);
      if (el) el.textContent = val;
    };

    set('total-owe',  fmtPKR(d.total_owe || 0));
    set('owe-count',  `${owe.length} debt${owe.length === 1 ? '' : 's'}`);
    set('total-owed', fmtPKR(d.total_owed || 0));
    set('owed-count', `${owed.length} receivable${owed.length === 1 ? '' : 's'}`);

    const snowballOrder = document.getElementById('snowball-order');
    console.log('[debts]   #snowball-order exists?', !!snowballOrder);
    if (snowballOrder) {
      const activeOwe = owe.filter(x => (x.original_amount || 0) - (x.paid_amount || 0) > 0)
                          .sort((a, b) => (a.snowball_order || 99) - (b.snowball_order || 99));
      if (activeOwe.length === 0) {
        snowballOrder.textContent = 'all paid 🎉';
      } else {
        snowballOrder.textContent = activeOwe.map((d, i) => `${i + 1}. ${d.name}`).slice(0, 3).join(' · ');
      }
    }
  }

  function renderLists(debts) {
    const owe  = debts.filter(d => d.kind === 'owe');
    const owed = debts.filter(d => d.kind === 'owed');
    console.log('[debts] renderLists: owe=' + owe.length + ' owed=' + owed.length);
    renderOne(owe,  document.getElementById('owe-list'),  'owe');
    renderOne(owed, document.getElementById('owed-list'), 'owed');
  }

  function renderOne(list, container, kind) {
    console.log('[debts]   renderOne kind=' + kind + ' list=' + list.length + ' container exists?', !!container);
    if (!container) {
      console.warn('[debts]   ⚠ container for kind=' + kind + ' NOT FOUND in DOM');
      return;
    }
    if (list.length === 0) {
      const msg = kind === 'owe'
        ? 'No debts owed. 🎉 Click + Add above to track one.'
        : 'No receivables. Click + Add above to track money owed to you.';
      container.innerHTML = `<div class="empty-state-inline">${msg}</div>`;
      return;
    }

    list = list.slice().sort((a, b) => (a.snowball_order || 99) - (b.snowball_order || 99));

    container.innerHTML = list.map(d => {
      const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
      const pct = d.original_amount > 0
        ? Math.min(100, Math.round(((d.paid_amount || 0) / d.original_amount) * 100))
        : 0;
      const fullyPaid = remaining <= 0.01;
      const cls = kind === 'owe' ? 'negative' : 'positive';
      const arrow = kind === 'owe' ? '↓' : '↑';
      const safeId = escHtml(d.id);

      const payBtn = fullyPaid
        ? `<button class="dense-action" disabled style="opacity:0.4;cursor:not-allowed">paid ✓</button>`
        : `<button class="dense-action" data-act="pay" data-id="${safeId}" title="Log a payment">+ Pay</button>`;

      return `
        <div class="debt-row" data-debt-id="${safeId}" style="padding:12px 14px;border-bottom:1px solid var(--border);background:var(--bg-elev-1);border-radius:8px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escHtml(d.name)}</div>
              <div class="muted" style="font-size:12px;margin-top:2px">
                ${arrow} ${kind === 'owe' ? 'You owe' : 'Owed to you'} · #${d.snowball_order || '—'}${d.notes ? ' · ' + escHtml(d.notes.slice(0, 60)) : ''}
              </div>
            </div>
            <div style="text-align:right;white-space:nowrap">
              <div class="${cls}" style="font-weight:700;font-variant-numeric:tabular-nums">Rs ${fmtPKRfull(remaining)}</div>
              <div class="muted" style="font-size:11px">${pct}% paid · of Rs ${fmtPKR(d.original_amount)}</div>
            </div>
          </div>
          <div style="height:6px;background:var(--bg-elev-2);border-radius:3px;margin-top:8px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${cls === 'negative' ? '#ef4444' : '#10b981'};transition:width 0.3s"></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end;flex-wrap:wrap">
            ${payBtn}
            <button class="dense-action" data-act="edit"   data-id="${safeId}" title="Edit fields">✎ Edit</button>
            <button class="dense-action" data-act="delete" data-id="${safeId}" title="Soft-delete (audit-safe)" style="color:#ef4444">🗑 Delete</button>
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', onActionClick);
    });
    console.log('[debts]   rendered', list.length, kind, 'rows');
  }

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

  async function onAddClick(kind) {
    const label = kind === 'owe' ? 'a new DEBT you owe' : 'a new RECEIVABLE (someone owes you)';
    const name = window.prompt(`Add ${label}:\n\nName (e.g. "CRED-7" or "Hassan loan"):`);
    if (!name || !name.trim()) return;

    const amountRaw = window.prompt('Original amount (PKR):');
    if (amountRaw === null) return;
    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount <= 0) { toast('❌ Invalid amount', 'err'); return; }

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
      if (!d.ok) { toast('❌ ' + (d.error || 'Add failed'), 'err'); return; }
      toast(`✅ Added ${d.name} · #${d.snowball_order}`);
      await loadAll();
    } catch (e) {
      toast('❌ Network error: ' + e.message, 'err');
    }
  }

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

    const assets = liveAccounts.filter(a => a.type === 'asset');
    const accountList = assets
      .map((a, i) => `${i + 1}. ${a.icon || '🏦'} ${a.name} (Rs ${fmtPKR(a.balance)})`)
      .join('\n');
    const accountRaw = window.prompt(`Pay from which account? Type the NUMBER:\n\n${accountList}`, '1');
    if (accountRaw === null) return;
    const accIdx = parseInt(accountRaw, 10) - 1;
    if (isNaN(accIdx) || accIdx < 0 || accIdx >= assets.length) { toast('❌ Invalid account', 'err'); return; }
    const accountId = assets[accIdx].id;

    const notes = window.prompt('Notes (optional):', '') || '';

    try {
      const r = await fetch(`/api/debts/${encodeURIComponent(id)}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, account_id: accountId, notes: notes.trim(), created_by: 'web-debts' })
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
      `6. Mark fully paid`,
      '1'
    );
    if (choice === null) return;

    const updates = {};
    switch (choice.trim()) {
      case '1': { const v = window.prompt('New name:', debt.name); if (v === null || !v.trim()) return; updates.name = v.trim(); break; }
      case '2': { const v = window.prompt('New original amount:', String(debt.original_amount)); if (v === null) return; const n = parseFloat(v); if (isNaN(n) || n <= 0) { toast('❌ Invalid', 'err'); return; } updates.original_amount = n; break; }
      case '3': { const v = window.prompt('New paid amount:', String(debt.paid_amount)); if (v === null) return; const n = parseFloat(v); if (isNaN(n) || n < 0) { toast('❌ Invalid', 'err'); return; } updates.paid_amount = n; break; }
      case '4': { const v = window.prompt('New snowball order:', String(debt.snowball_order || '')); if (v === null) return; const n = parseInt(v, 10); if (isNaN(n) || n <= 0) { toast('❌ Invalid', 'err'); return; } updates.snowball_order = n; break; }
      case '5': { const v = window.prompt('Notes:', debt.notes || ''); if (v === null) return; updates.notes = v; break; }
      case '6': { if (!window.confirm(`Mark "${debt.name}" as fully paid?`)) return; updates.paid_amount = debt.original_amount; break; }
      default: toast('❌ Invalid choice', 'err'); return;
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
    } catch (e) { toast('❌ Network error: ' + e.message, 'err'); }
  }

  async function onDeleteClick(id) {
    const debt = (window.store.cachedDebts || []).find(d => d.id === id);
    if (!debt) { toast('❌ Debt not found', 'err'); return; }

    const ok = window.confirm(
      `Soft-delete "${debt.name}"?\n\n` +
      `Sets status='deleted'. Audit trail preserved. Continue?`
    );
    if (!ok) return;

    try {
      const r = await fetch(`/api/debts/${encodeURIComponent(id)}?created_by=web-debts`, { method: 'DELETE' });
      const d = await r.json();
      if (!d.ok) { toast('❌ ' + (d.error || 'Delete failed'), 'err'); return; }
      toast(`✅ Deleted · snap ${d.snapshot_id}`);
      await loadAll();
    } catch (e) { toast('❌ Network error: ' + e.message, 'err'); }
  }

  function fmtPKR(n) { return Math.round(Number(n) || 0).toLocaleString('en-PK'); }
  function fmtPKRfull(n) { return Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
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
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
  }
})();
