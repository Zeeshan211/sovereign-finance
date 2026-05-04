/* ─── Sovereign Finance · Debts Page · v0.4.3 · Sub-1D-3c F3 fix ───
 * Renders /debts.html using the EXISTING HTML IDs (verified 2026-05-04):
 *   #debts-summary · #debts-total-owe · #debts-owe-count
 *   #debts-total-owed · #debts-owed-count · #debts-net-burden
 *   #debts-owe-list · #debts-owed-list · #receivables-header
 *   #payModal + payAmount/payAccount/payDate/payCancel/payConfirm
 *
 * Bug fix from v0.4.2: every selector resolved to false because v0.4.0–v0.4.2
 * targeted IDs that don't exist in the HTML (#total-owe, #snowball-order, etc.).
 * Runtime trace from operator confirmed Pattern 3 (frontend ID mismatch).
 *
 * What ships in this version:
 *   - Summary cards render (You Owe / They Owe You) with animated numbers
 *   - Snowball list renders sorted by remaining balance DESC
 *   - Receivables list renders or section is hidden if empty
 *   - Pay modal wires to POST /api/debts/{id}/pay (backend already live)
 *   - "+ Add" buttons in section headers preserved (placeholder until F4/F5 ships forms)
 *
 * Deferred to next iteration (Sub-1D-3c F4/F5): Add Debt form, Edit Debt form,
 * Delete confirmation. No HTML for those exists yet; do not invent UI here.
 */
(function () {
  'use strict';

  if (window._debtsInited) return;
  window._debtsInited = true;

  const VERSION = 'v0.4.3';
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

  /* ─────── + Add buttons (preserved from v0.4.2, placeholder until form HTML) ─────── */
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
      btn.addEventListener('click', () => {
        // F4 will replace this with a real Add Debt modal
        alert('Add Debt form ships in Sub-1D-3c F4 — backend POST is already live.');
      });
      h.appendChild(btn);
    });
  }

  /* ─────── Pay modal ─────── */
  let _payContext = null; // { id, name, remaining }

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
        body: JSON.stringify({ amount: amt, account_id: accountId, dt_local: date })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        closePayModal();
        await loadAll(); // refresh in place — no full page reload
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

  function reloadDebts() { return loadAll(); }

  /* ─────── Init ─────── */
  function init() {
    console.log('[debts]', VERSION, 'init');
    document.querySelectorAll('.day-badge').forEach(el => {
      // keep #debts-summary visible (it's inside .day-badge) — only hide stale Day-N labels elsewhere
    });
    injectAddButtons();
    wirePayModal();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

