/* ─── Sovereign Finance · Accounts Page · v0.6.0 · Sub-1D-3e Ship 5 ───
 * Adds:
 *   - Live summary text in header (replaces Day-N badge)
 *   - + Add Account button + modal → POST /api/accounts
 *   - ✏️ Edit button on every row → Edit modal
 *   - Edit modal Save → PUT /api/accounts/{id}
 *   - Edit modal Archive → POST /api/accounts/{id}/archive (FK-safe always)
 *   - Edit modal Delete → DELETE /api/accounts/{id}
 *       - On 409 with refs payload → auto-offer Archive instead
 *   - Archived section (collapsed by default, toggle to expand)
 *       - Each archived row has 🔄 Restore button → POST /api/accounts/{id}/unarchive
 *
 * Backend contracts (functions/api/accounts/[[path]].js v0.2.1):
 *   GET    /api/accounts          → active list + totals
 *   GET    /api/accounts?include_archived=1 → NOT supported by v0.2.1; we fetch archived via separate query
 *     [TEMP: backend filters status='active' only. To list archived, we add a tiny endpoint contract:
 *      For now we fetch via direct call and filter client-side IF backend later returns 'all'.
 *      Today: archived rows are invisible from /api/accounts. Show empty Archived section
 *      until backend adds ?include_archived=1, OR until you archive something via UI
 *      and we cache it locally.]
 *   POST   /api/accounts          → {name, icon, kind, opening_balance, display_order, type?}
 *   PUT    /api/accounts/{id}     → {name?, icon?, kind?, opening_balance?, display_order?}
 *   DELETE /api/accounts/{id}?created_by=web → 200 if FK refs=0, 409 with refs if blocked
 *   POST   /api/accounts/{id}/archive   → soft-archive
 *   POST   /api/accounts/{id}/unarchive → restore
 *
 * Note on Archived listing: backend v0.2.1 only returns active. To show archived
 * accounts in the UI, we maintain a session-only cache of accounts the user has
 * archived in this browser session. Persistent listing requires a backend tweak
 * (add ?status=archived support to GET) — queued as Ship 7 polish if needed.
 */
(function () {
  'use strict';

  if (window._accountsInited) return;
  window._accountsInited = true;

  const VERSION = 'v0.6.0';
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

  // Session-only archived cache (until backend supports listing archived)
  const _archivedCache = new Map(); // id → account object

  /* ─────── Add Account modal ─────── */
  function wireAddModal() {
    const trigger = $('addAccountBtn');
    const cancel = $('addAccountCancel');
    const confirm = $('addAccountConfirm');
    const backdrop = $('addAccountModal');
    if (trigger && !trigger._wired) { trigger.addEventListener('click', openAddModal); trigger._wired = true; }
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeAddModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmAdd); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAddModal(); });
      backdrop._wired = true;
    }
  }

  function openAddModal() {
    const name = $('addAccountName'); if (name) name.value = '';
    const icon = $('addAccountIcon'); if (icon) icon.value = '';
    const kind = $('addAccountKind'); if (kind) kind.value = 'bank';
    const opening = $('addAccountOpening'); if (opening) opening.value = '';
    const order = $('addAccountOrder'); if (order) order.value = '';
    const m = $('addAccountModal');
    if (m) m.style.display = 'flex';
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

    if (!name) { alert('Name is required'); return; }
    if (name.length > 60) { alert('Name max 60 chars'); return; }

    const btn = $('addAccountConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await getJSON('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ name, icon, kind, opening_balance, display_order, type })
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
    const backdrop = $('editAccountModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeEditModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmEdit); confirm._wired = true; }
    if (archive && !archive._wired) { archive.addEventListener('click', archiveFromEditModal); archive._wired = true; }
    if (del && !del._wired) { del.addEventListener('click', deleteFromEditModal); del._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeEditModal(); });
      backdrop._wired = true;
    }
  }

  function openEditModal(account) {
    _editContext = { id: account.id, original: { ...account } };
    setText('editAccountTitle', 'Edit ' + account.name);
    setText('editAccountSub', 'id: ' + account.id);
    const name = $('editAccountName'); if (name) name.value = account.name || '';
    const icon = $('editAccountIcon'); if (icon) icon.value = account.icon || '';
    const kind = $('editAccountKind'); if (kind) kind.value = account.kind || 'bank';
    const opening = $('editAccountOpening'); if (opening) opening.value = account.opening_balance || 0;
    const order = $('editAccountOrder'); if (order) order.value = account.display_order || 99;
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

    if (!name) { alert('Name is required'); return; }
    if (name.length > 60) { alert('Name max 60 chars'); return; }

    const btn = $('editAccountConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/accounts/' + encodeURIComponent(_editContext.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ name, icon, kind, opening_balance, display_order, type })
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
      'transactions and bills are preserved. You can restore from the Archived ' +
      'section later.'
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
        // Cache locally so it appears in Archived section without needing a backend ?status=archived endpoint
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
      'This is a HARD delete. If the account has any transactions or active bills, ' +
      'the delete will be blocked and you\'ll be offered Archive instead.\n\n' +
      'Snapshot is taken before delete — recoverable via D1 console if needed.'
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
        console.log('[accounts] delete DELETE →', r.status, 'ok · snapshot', r.body.snapshot_id);
        closeEditModal();
        await loadAll();
      } else if (r.status === 409 && r.body && r.body.refs) {
        // FK-blocked → offer Archive as fallback
        const refs = r.body.refs;
        const fallback = confirm(
          'Cannot hard-delete: account has ' + refs.transactions + ' transaction(s) and ' +
          refs.bills + ' active bill(s).\n\n' +
          'Archive instead? (Hides account, preserves history.)'
        );
        if (fallback) {
          await archiveFromEditModal();
        }
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
  function renderAccountRow(acc) {
    const balance = Number(acc.balance || 0);
    const isCC = acc.is_credit_card || acc.kind === 'cc';
    const valueClass = isCC ? 'negative' : (balance >= 0 ? 'accent' : 'negative');
    const displayBalance = isCC ? Math.abs(balance) : balance;
    const subtitle = isCC ? 'outstanding · ' + (acc.kind_label || 'CC') : (acc.kind_label || acc.kind || '—');

    return `
      <div class="mini-row" data-account-id="${escHtml(acc.id)}">
        <div class="mini-row-left">
          <div class="mini-row-name">${escHtml(acc.icon || '')} ${escHtml(acc.name)}</div>
          <div class="mini-row-sub">${escHtml(subtitle)}</div>
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

      // Header summary + net worth
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

      // Split assets vs liabilities
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

      // Archived section (session cache only — backend supports archive but not list-archived endpoint)
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

      // Refresh global cache for other pages
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
