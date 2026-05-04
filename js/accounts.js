/* ─── Sovereign Finance · Accounts Page · v0.7.0 · Sub-1D-4e Ship 9 ───
 * Adds CC validation UI (Sub-1D-4e finishes here):
 *   - Add modal: CC fields block toggles when kind === 'cc'
 *   - Edit modal: CC fields block toggles when kind === 'cc' + pre-populates from row
 *   - Liability row renderer: shows utilization%, status_label, days-to-due, available credit
 *   - Both Add/Edit POST/PUT now send credit_limit, min_payment_amount, statement_day, payment_due_day
 *
 * Backend contracts (accounts/[[path]].js v0.2.2):
 *   POST /api/accounts → ...prev fields + credit_limit?, min_payment_amount?, statement_day?, payment_due_day?
 *   PUT  /api/accounts/{id} → same allowlist + 4 new
 *   GET response: each account has cc_utilization_pct, available_credit, days_to_payment_due, cc_status_label, outstanding (for CC) or null (for non-CC)
 */
(function () {
  'use strict';

  if (window._accountsInited) return;
  window._accountsInited = true;

  const VERSION = 'v0.7.0';
  const $ = id => document.getElementById(id);

  const fmtPKR = n => Math.round(Number(n) || 0).toLocaleString('en-PK');
  const fmtPKRSigned = n => {
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : '';
    return sign + 'Rs ' + Math.abs(Math.round(v)).toLocaleString('en-PK');
  };
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function getJSON(url, opts) {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, opts || {}));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }
  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  const _archivedCache = new Map();

  /* ─────── CC field block toggle helper ─────── */
  function toggleCCBlock(blockId, kind) {
    const block = $(blockId);
    if (!block) return;
    block.style.display = (kind === 'cc') ? '' : 'none';
  }

  /* ─────── Add Account modal ─────── */
  function wireAddModal() {
    const trigger = $('addAccountBtn');
    const cancel = $('addAccountCancel');
    const confirm = $('addAccountConfirm');
    const kindSel = $('addAccountKind');
    const backdrop = $('addAccountModal');
    if (trigger && !trigger._wired) { trigger.addEventListener('click', openAddModal); trigger._wired = true; }
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeAddModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmAdd); confirm._wired = true; }
    if (kindSel && !kindSel._wired) {
      kindSel.addEventListener('change', () => toggleCCBlock('addAccountCCBlock', kindSel.value));
      kindSel._wired = true;
    }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAddModal(); });
      backdrop._wired = true;
    }
  }

  function openAddModal() {
    const fields = {
      addAccountName: '', addAccountIcon: '', addAccountKind: 'bank',
      addAccountOpening: '', addAccountOrder: '',
      addAccountCreditLimit: '', addAccountMinPayment: '',
      addAccountStatementDay: '', addAccountDueDay: '',
    };
    Object.entries(fields).forEach(([id, v]) => {
      const el = $(id);
      if (el) el.value = v;
    });
    toggleCCBlock('addAccountCCBlock', 'bank');
    const m = $('addAccountModal');
    if (m) m.style.display = 'flex';
    const name = $('addAccountName');
    if (name) setTimeout(() => name.focus(), 50);
  }

  function closeAddModal() {
    const m = $('addAccountModal');
    if (m) m.style.display = 'none';
  }

  async function confirmAdd() {
    const name = (($('addAccountName') || {}).value || '').trim();
    const icon = (($('addAccountIcon') || {}).value || '').trim() || '🏦';
    const kind = ($('addAccountKind') || {}).value || 'bank';
    const opening_balance = Number(($('addAccountOpening') || {}).value || 0);
    const display_order = Number(($('addAccountOrder') || {}).value || 99);
    const type = kind === 'cc' ? 'liability' : 'asset';

    const payload = { name, icon, kind, opening_balance, display_order, type };
    if (kind === 'cc') {
      const cl = ($('addAccountCreditLimit') || {}).value;
      const mp = ($('addAccountMinPayment') || {}).value;
      const sd = ($('addAccountStatementDay') || {}).value;
      const dd = ($('addAccountDueDay') || {}).value;
      if (cl !== '') payload.credit_limit = Number(cl);
      if (mp !== '') payload.min_payment_amount = Number(mp);
      if (sd !== '') payload.statement_day = Number(sd);
      if (dd !== '') payload.payment_due_day = Number(dd);
    }

    if (!name) { alert('Name is required'); return; }
    if (name.length > 60) { alert('Name max 60 chars'); return; }

    const btn = $('addAccountConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await getJSON('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload)
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[accounts] add POST →', r.status, 'ok ·', r.body.id);
        closeAddModal();
        await loadAll();
      } else {
        alert('Add failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Account'; }
    }
  }

  /* ─────── Edit Account modal ─────── */
  let _editContext = null;

  function wireEditModal() {
    const cancel = $('editAccountCancel');
    const confirm = $('editAccountConfirm');
    const archive = $('editAccountArchive');
    const del = $('editAccountDelete');
    const kindSel = $('editAccountKind');
    const backdrop = $('editAccountModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeEditModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmEdit); confirm._wired = true; }
    if (archive && !archive._wired) { archive.addEventListener('click', archiveFromEditModal); archive._wired = true; }
    if (del && !del._wired) { del.addEventListener('click', deleteFromEditModal); del._wired = true; }
    if (kindSel && !kindSel._wired) {
      kindSel.addEventListener('change', () => toggleCCBlock('editAccountCCBlock', kindSel.value));
      kindSel._wired = true;
    }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeEditModal(); });
      backdrop._wired = true;
    }
  }

  function openEditModal(account) {
    _editContext = { id: account.id, original: { ...account } };
    setText('editAccountTitle', 'Edit ' + account.name);
    setText('editAccountSub', 'id: ' + account.id);
    const setVal = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
    setVal('editAccountName', account.name || '');
    setVal('editAccountIcon', account.icon || '');
    setVal('editAccountKind', account.kind || 'bank');
    setVal('editAccountOpening', account.opening_balance || 0);
    setVal('editAccountOrder', account.display_order || 99);
    // CC fields (will be hidden if kind !== 'cc')
    setVal('editAccountCreditLimit', account.credit_limit);
    setVal('editAccountMinPayment', account.min_payment_amount);
    setVal('editAccountStatementDay', account.statement_day);
    setVal('editAccountDueDay', account.payment_due_day);
    toggleCCBlock('editAccountCCBlock', account.kind);
    const m = $('editAccountModal');
    if (m) m.style.display = 'flex';
  }

  function closeEditModal() {
    _editContext = null;
    const m = $('editAccountModal');
    if (m) m.style.display = 'none';
  }

  async function confirmEdit() {
    if (!_editContext) return;
    const name = (($('editAccountName') || {}).value || '').trim();
    const icon = (($('editAccountIcon') || {}).value || '').trim();
    const kind = ($('editAccountKind') || {}).value || 'bank';
    const opening_balance = Number(($('editAccountOpening') || {}).value || 0);
    const display_order = Number(($('editAccountOrder') || {}).value || 99);
    const type = kind === 'cc' ? 'liability' : 'asset';

    const payload = { name, icon, kind, opening_balance, display_order, type };

    // CC fields — always send (even if hidden) to preserve null/clear semantics
    // Send null when empty so backend can clear the value
    const ccFields = {
      credit_limit: 'editAccountCreditLimit',
      min_payment_amount: 'editAccountMinPayment',
      statement_day: 'editAccountStatementDay',
      payment_due_day: 'editAccountDueDay',
    };
    Object.entries(ccFields).forEach(([apiName, elId]) => {
      const el = $(elId);
      if (!el) return;
      const v = el.value;
      if (kind === 'cc') {
        // For CC: send number or null
        payload[apiName] = (v === '' || v == null) ? null : Number(v);
      } else {
        // For non-CC: explicitly null out CC fields (clean if user changed type away from CC)
        payload[apiName] = null;
      }
    });

    if (!name) { alert('Name is required'); return; }
    if (name.length > 60) { alert('Name max 60 chars'); return; }

    const btn = $('editAccountConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/accounts/' + encodeURIComponent(_editContext.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload)
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[accounts] edit PUT →', r.status, 'ok · fields', r.body.updated_fields);
        closeEditModal();
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

  async function archiveFromEditModal() {
    if (!_editContext) return;
    const name = _editContext.original.name || _editContext.id;
    const ok = confirm(
      'Archive "' + name + '"?\n\n' +
      'Archived accounts are hidden from the main list but their historical ' +
      'transactions and bills are preserved.'
    );
    if (!ok) return;

    const btn = $('editAccountArchive');
    if (btn) { btn.disabled = true; btn.textContent = 'Archiving…'; }
    try {
      const r = await getJSON('/api/accounts/' + encodeURIComponent(_editContext.id) + '/archive', {
        method: 'POST',
        cache: 'no-store',
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[accounts] archive POST →', r.status, 'ok · snapshot', r.body.snapshot_id);
        _archivedCache.set(_editContext.id, { ..._editContext.original, status: 'archived' });
        closeEditModal();
        await loadAll();
      } else {
        alert('Archive failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Archive failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Archive'; }
    }
  }

  async function deleteFromEditModal() {
    if (!_editContext) return;
    const name = _editContext.original.name || _editContext.id;
    const ok = confirm(
      'Delete "' + name + '" permanently?\n\n' +
      'If account has transactions/bills, delete will be blocked and Archive offered instead.'
    );
    if (!ok) return;

    const btn = $('editAccountDelete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      const r = await getJSON(
        '/api/accounts/' + encodeURIComponent(_editContext.id) + '?created_by=web',
        { method: 'DELETE', cache: 'no-store' }
      );
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[accounts] delete DELETE →', r.status, 'ok');
        closeEditModal();
        await loadAll();
      } else if (r.status === 409 && r.body && r.body.refs) {
        const refs = r.body.refs;
        const fallback = confirm(
          'Cannot hard-delete: ' + refs.transactions + ' txn(s) + ' + refs.bills + ' active bill(s).\n\n' +
          'Archive instead?'
        );
        if (fallback) await archiveFromEditModal();
      } else {
        alert('Delete failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Delete failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
    }
  }

  /* ─────── Archived section ─────── */
  function wireArchivedToggle() {
    const t = $('acc-archived-toggle');
    if (t && !t._wired) {
      t.addEventListener('click', () => {
        const list = $('acc-archived-list');
        if (!list) return;
        const showing = list.style.display !== 'none';
        list.style.display = showing ? 'none' : '';
        t.textContent = showing ? 'Show' : 'Hide';
      });
      t._wired = true;
    }
  }

  async function unarchiveAccount(id) {
    const ok = confirm('Restore this account to active?');
    if (!ok) return;
    try {
      const r = await getJSON('/api/accounts/' + encodeURIComponent(id) + '/unarchive', {
        method: 'POST',
        cache: 'no-store',
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        _archivedCache.delete(id);
        await loadAll();
      } else {
        alert('Restore failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Restore failed: ' + e.message);
    }
  }

  /* ─────── Renderers ─────── */
  function ccStatusClass(label) {
    if (label === 'over limit' || label === 'critical') return 'negative';
    if (label === 'warning') return 'liabilities';
    if (label === 'healthy') return 'accent';
    return '';
  }

  function renderAccountRow(acc) {
    const balance = Number(acc.balance || 0);
    const isCC = acc.is_credit_card || acc.kind === 'cc';
    const valueClass = isCC ? 'negative' : (balance >= 0 ? 'accent' : 'negative');
    const displayBalance = isCC ? Math.abs(balance) : balance;

    let subtitle;
    if (isCC) {
      // CC subtitle: outstanding · utilization · days to due
      const parts = ['outstanding · ' + (acc.kind_label || 'CC')];
      if (acc.cc_utilization_pct != null) {
        parts.push(acc.cc_utilization_pct + '% used');
      }
      if (acc.days_to_payment_due != null) {
        const d = acc.days_to_payment_due;
        parts.push(d === 0 ? 'due today' : (d === 1 ? 'due tomorrow' : `due in ${d}d`));
      }
      subtitle = parts.join(' · ');
    } else {
      subtitle = acc.kind_label || acc.kind || '—';
    }

    const ccBadge = isCC && acc.cc_status_label
      ? `<span class="dense-badge ${ccStatusClass(acc.cc_status_label)}" style="font-size:10px;padding:2px 6px;margin-left:6px">${escHtml(acc.cc_status_label)}</span>`
      : '';

    const ccUtilBar = isCC && acc.cc_utilization_pct != null
      ? `<div style="background:rgba(255,255,255,0.08);border-radius:4px;height:4px;margin-top:6px;overflow:hidden">
          <div style="width:${Math.min(100, acc.cc_utilization_pct)}%;height:100%;background:var(--${ccStatusClass(acc.cc_status_label) === 'negative' ? 'danger' : ccStatusClass(acc.cc_status_label) === 'liabilities' ? 'warning' : 'accent'},#22c55e);transition:width 0.3s"></div>
        </div>`
      : '';

    const availCredit = isCC && acc.available_credit != null
      ? `<div class="mini-row-sub" style="font-size:11px;margin-top:2px">Rs ${fmtPKR(acc.available_credit)} available</div>`
      : '';

    return `
      <div class="mini-row" data-account-id="${escHtml(acc.id)}">
        <div class="mini-row-left" style="flex:1">
          <div class="mini-row-name">${escHtml(acc.icon || '')} ${escHtml(acc.name)}${ccBadge}</div>
          <div class="mini-row-sub">${escHtml(subtitle)}</div>
          ${ccUtilBar}
          ${availCredit}
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount ${valueClass}">${fmtPKRSigned(displayBalance * (isCC ? -1 : 1))}</div>
          <button class="ghost-btn edit-account-btn" data-account-id="${escHtml(acc.id)}"
                  style="font-size:12px;padding:4px 10px;margin-top:4px" title="Edit / Archive / Delete">✏️</button>
        </div>
      </div>`;
  }

  function renderArchivedRow(acc) {
    return `
      <div class="mini-row" data-account-id="${escHtml(acc.id)}" style="opacity:0.6">
        <div class="mini-row-left">
          <div class="mini-row-name">${escHtml(acc.icon || '')} ${escHtml(acc.name)}</div>
          <div class="mini-row-sub">archived · ${escHtml(acc.kind_label || acc.kind || '—')}</div>
        </div>
        <div class="mini-row-right">
          <button class="primary-btn unarchive-btn" data-account-id="${escHtml(acc.id)}"
                  style="font-size:12px;padding:4px 10px">🔄 Restore</button>
        </div>
      </div>`;
  }

  function attachRowHandlers(allActiveAccounts) {
    document.querySelectorAll('.edit-account-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.accountId;
        const a = allActiveAccounts.find(x => x.id === id);
        if (a) openEditModal(a);
      });
    });
    document.querySelectorAll('.unarchive-btn').forEach(btn => {
      btn.addEventListener('click', () => unarchiveAccount(btn.dataset.accountId));
    });
  }

  /* ─────── Main load ─────── */
  async function loadAll() {
    console.log('[accounts]', VERSION, 'loadAll start');
    try {
      const r = await fetch('/api/accounts', { cache: 'no-store' });
      const body = await r.json();
      console.log('[accounts] /api/accounts', r.status, '→', body.count, 'accounts');
      if (!body.ok) throw new Error(body.error || 'accounts payload not ok');

      const accounts = body.accounts || [];
      const totals = body.totals || {};

      setText('acc-summary',
        accounts.length + ' active · ' +
        (Object.values(totals).filter(v => v !== 0).length) + ' positions'
      );
      const nw = $('acc-net-worth');
      if (nw) {
        const v = Number(totals.net_worth || 0);
        nw.innerHTML = fmtPKR(Math.abs(v)) + '<span class="nw-currency">PKR</span>';
        nw.classList.toggle('positive', v >= 0);
        nw.classList.toggle('negative', v < 0);
      }

      const assets = accounts.filter(a => !(a.is_credit_card || a.kind === 'cc'));
      const liabilities = accounts.filter(a => a.is_credit_card || a.kind === 'cc');
      const assetsTotal = assets.reduce((s, a) => s + (Number(a.balance) || 0), 0);
      const liabilitiesTotal = liabilities.reduce((s, a) => s + Math.abs(Number(a.balance) || 0), 0);

      setText('acc-assets-count', assets.length + ' Asset' + (assets.length === 1 ? '' : 's'));
      setText('acc-assets-total', 'Rs ' + fmtPKR(assetsTotal));
      setHTML('acc-assets-list',
        assets.length
          ? assets.map(renderAccountRow).join('')
          : '<div class="empty-state-inline">No assets yet — click + Add above.</div>'
      );

      setText('acc-liabilities-count', liabilities.length + ' Liabilit' + (liabilities.length === 1 ? 'y' : 'ies'));
      setText('acc-liabilities-total', '-Rs ' + fmtPKR(liabilitiesTotal));
      setHTML('acc-liabilities-list',
        liabilities.length
          ? liabilities.map(renderAccountRow).join('')
          : '<div class="empty-state-inline">No liabilities.</div>'
      );

      const archived = Array.from(_archivedCache.values());
      const archHeader = $('acc-archived-header');
      const archList = $('acc-archived-list');
      if (archived.length) {
        if (archHeader) archHeader.style.display = '';
        setText('acc-archived-count', archived.length + ' Archived');
        if (archList) archList.innerHTML = archived.map(renderArchivedRow).join('');
      } else {
        if (archHeader) archHeader.style.display = 'none';
        if (archList) archList.innerHTML = '';
      }

      attachRowHandlers(accounts);

      if (window.store) {
        window.store.cachedAccounts = accounts;
      }
    } catch (e) {
      console.error('[accounts] loadAll FAILED:', e);
      setText('acc-summary', 'load failed');
      setHTML('acc-assets-list', '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>');
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[accounts]', VERSION, 'init');
    wireAddModal();
    wireEditModal();
    wireArchivedToggle();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
