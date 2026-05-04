/* ─── Sovereign Finance · Reconciliation Page · v0.1.0 · Sub-1D-5d Ship 5 ───
 * Wires:
 *   - GET /api/reconciliation → render summary + latest-per-account + history
 *   - + Declare Balance → modal with LIVE diff preview → POST /api/reconciliation
 *   - 📝 Note button on each declaration → modal → POST /api/reconciliation/{id}/note
 *
 * Backend contracts (reconciliation/[[path]].js v0.1.0):
 *   GET  /api/reconciliation
 *     → {ok, declarations:[...], accounts_latest:[...], declarations_count, accounts_with_declarations, clean_count, drifted_count}
 *   POST /api/reconciliation
 *     → {account_id, declared_balance, notes?}
 *   POST /api/reconciliation/{id}/note
 *     → {note}
 *
 * The "live diff preview" inside Declare modal needs current D1 balance per account.
 * We pull from window.store.cachedAccounts (refreshed at page load).
 */
(function () {
  'use strict';

  if (window._reconInited) return;
  window._reconInited = true;

  const VERSION = 'v0.1.0';
  const $ = id => document.getElementById(id);

  const fmtPKR = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-PK');
  const fmtPKRSigned = n => {
    const v = Number(n) || 0;
    if (v === 0) return 'Rs 0';
    const sign = v < 0 ? '−' : '+';
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

  function fmtRelativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    const now = new Date();
    const mins = Math.floor((now - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
    return then.toISOString().slice(0, 10);
  }

  /* ─────── Account dropdown ─────── */
  function populateAccountSelect(selectId, defaultValue) {
    const sel = $(selectId);
    if (!sel) return;
    const accounts = (window.store && (window.store.cachedAccounts || window.store.accounts)) || [];
    if (!accounts.length) {
      sel.innerHTML = '<option value="">⚠ no accounts loaded — refresh page</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Select account —</option>' + accounts
      .map(a => `<option value="${escHtml(a.id)}" data-balance="${a.balance || 0}"${a.id === defaultValue ? ' selected' : ''}>${escHtml(a.name)} (${escHtml(a.id)})</option>`)
      .join('');
  }

  function getCachedBalance(accountId) {
    const accounts = (window.store && (window.store.cachedAccounts || window.store.accounts)) || [];
    const acc = accounts.find(a => a.id === accountId);
    return acc ? Number(acc.balance || 0) : null;
  }

  /* ─────── Declare Balance Modal ─────── */
  function wireDeclareModal() {
    const trigger = $('declareBtn');
    const cancel = $('declareCancel');
    const confirm = $('declareConfirm');
    const accSel = $('declareAccount');
    const balInp = $('declareBalance');
    const backdrop = $('declareModal');
    if (trigger && !trigger._wired) { trigger.addEventListener('click', openDeclareModal); trigger._wired = true; }
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeDeclareModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmDeclare); confirm._wired = true; }
    if (accSel && !accSel._wired) { accSel.addEventListener('change', updateDeclarePreview); accSel._wired = true; }
    if (balInp && !balInp._wired) { balInp.addEventListener('input', updateDeclarePreview); balInp._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeDeclareModal(); });
      backdrop._wired = true;
    }
  }

  function openDeclareModal(prefilledAccountId) {
    populateAccountSelect('declareAccount', prefilledAccountId || '');
    const bal = $('declareBalance'); if (bal) bal.value = '';
    const notes = $('declareNotes'); if (notes) notes.value = '';
    const preview = $('declarePreview'); if (preview) preview.style.display = 'none';
    const m = $('declareModal');
    if (m) m.style.display = 'flex';
    if (prefilledAccountId) updateDeclarePreview();
  }

  function closeDeclareModal() {
    const m = $('declareModal');
    if (m) m.style.display = 'none';
  }

  function updateDeclarePreview() {
    const accId = ($('declareAccount') || {}).value || '';
    const declaredVal = ($('declareBalance') || {}).value;
    const preview = $('declarePreview');
    if (!preview) return;
    if (!accId || declaredVal === '' || declaredVal == null) {
      preview.style.display = 'none';
      return;
    }
    const d1 = getCachedBalance(accId);
    if (d1 == null) {
      preview.style.display = 'none';
      return;
    }
    const declared = Number(declaredVal);
    const diff = declared - d1;
    setText('declarePreviewD1', fmtPKR(d1));
    setText('declarePreviewDeclared', fmtPKR(declared));
    const diffEl = $('declarePreviewDiff');
    if (diffEl) {
      diffEl.textContent = fmtPKRSigned(diff) + (Math.abs(diff) < 1 ? ' · ✓ in sync' : ' · drift');
      diffEl.className = Math.abs(diff) < 1 ? 'accent' : 'negative';
    }
    preview.style.display = '';
  }

  async function confirmDeclare() {
    const account_id = ($('declareAccount') || {}).value || '';
    const declared_balance_raw = ($('declareBalance') || {}).value;
    const notes = (($('declareNotes') || {}).value || '').trim() || null;

    if (!account_id) { alert('Select an account'); return; }
    if (declared_balance_raw === '' || declared_balance_raw == null) { alert('Enter the real balance'); return; }
    const declared_balance = Number(declared_balance_raw);
    if (isNaN(declared_balance)) { alert('Balance must be a number'); return; }

    const btn = $('declareConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Declaring…'; }
    try {
      const r = await getJSON('/api/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ account_id, declared_balance, notes })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[recon] declare POST →', r.status, 'ok ·', r.body.id, '· diff', r.body.diff_amount);
        closeDeclareModal();
        await loadAll();
      } else {
        alert('Declare failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Declare failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Declare'; }
    }
  }

  /* ─────── Note Modal ─────── */
  let _noteContext = null;

  function wireNoteModal() {
    const cancel = $('noteCancel');
    const confirm = $('noteConfirm');
    const backdrop = $('noteModal');
    if (cancel && !cancel._wired) { cancel.addEventListener('click', closeNoteModal); cancel._wired = true; }
    if (confirm && !confirm._wired) { confirm.addEventListener('click', confirmNote); confirm._wired = true; }
    if (backdrop && !backdrop._wired) {
      backdrop.addEventListener('click', e => { if (e.target === backdrop) closeNoteModal(); });
      backdrop._wired = true;
    }
  }

  function openNoteModal(declaration) {
    _noteContext = { id: declaration.id, account_name: declaration.account_name };
    setText('noteModalTitle', 'Add Note');
    setText('noteModalSub', `${declaration.account_name} · declared ${fmtPKR(declaration.declared_balance)} · ${fmtRelativeTime(declaration.declared_at)}`);
    const t = $('noteText'); if (t) t.value = '';
    const m = $('noteModal');
    if (m) m.style.display = 'flex';
    if (t) setTimeout(() => t.focus(), 50);
  }

  function closeNoteModal() {
    _noteContext = null;
    const m = $('noteModal');
    if (m) m.style.display = 'none';
  }

  async function confirmNote() {
    if (!_noteContext) return;
    const note = (($('noteText') || {}).value || '').trim();
    if (!note) { alert('Note is required'); return; }

    const btn = $('noteConfirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await getJSON('/api/reconciliation/' + encodeURIComponent(_noteContext.id) + '/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ note })
      });
      if (r.status >= 200 && r.status < 300 && r.body && r.body.ok) {
        console.log('[recon] note POST →', r.status, 'ok');
        closeNoteModal();
        await loadAll();
      } else {
        alert('Note failed: ' + ((r.body && r.body.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Note failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Append Note'; }
    }
  }

  /* ─────── Renderers ─────── */
  function renderLatestRow(d) {
    const cleanBadge = d.is_clean
      ? '<span class="dense-badge accent" style="font-size:11px;padding:3px 8px">✓ in sync</span>'
      : '<span class="dense-badge negative" style="font-size:11px;padding:3px 8px">drift ' + fmtPKRSigned(d.live_diff_vs_current_d1) + '</span>';
    return `
      <div class="mini-row" data-recon-id="${escHtml(d.id)}">
        <div class="mini-row-left" style="flex:1">
          <div class="mini-row-name">${escHtml(d.account_name)} ${cleanBadge}</div>
          <div class="mini-row-sub">declared ${fmtPKR(d.declared_balance)} · D1 ${fmtPKR(d.current_d1_balance)} · ${escHtml(fmtRelativeTime(d.declared_at))}</div>
          ${d.notes ? `<div class="mini-row-sub" style="font-size:11px;opacity:0.7;margin-top:2px;white-space:pre-wrap">${escHtml(d.notes)}</div>` : ''}
        </div>
        <div class="mini-row-right">
          <button class="primary-btn redeclare-btn" data-account-id="${escHtml(d.account_id)}"
                  style="font-size:12px;padding:4px 10px">↻ Redeclare</button>
          <button class="ghost-btn note-btn" data-recon-id="${escHtml(d.id)}"
                  style="font-size:12px;padding:4px 10px;margin-top:4px" title="Add note">📝</button>
        </div>
      </div>`;
  }

  function renderHistoryRow(d) {
    const statusClass = d.is_clean ? 'accent' : 'negative';
    return `
      <div class="mini-row" data-recon-id="${escHtml(d.id)}">
        <div class="mini-row-left" style="flex:1">
          <div class="mini-row-name">${escHtml(d.account_name)} <span class="${statusClass}" style="font-size:11px">${fmtPKRSigned(d.diff_at_declaration)}</span></div>
          <div class="mini-row-sub">declared ${fmtPKR(d.declared_balance)} · D1 was ${fmtPKR((d.declared_balance || 0) - (d.diff_at_declaration || 0))} · ${escHtml(fmtRelativeTime(d.declared_at))}</div>
        </div>
        <div class="mini-row-right">
          <button class="ghost-btn note-btn" data-recon-id="${escHtml(d.id)}"
                  style="font-size:12px;padding:4px 10px" title="Add note">📝</button>
        </div>
      </div>`;
  }

  function attachRowHandlers(latestList, historyList) {
    document.querySelectorAll('.redeclare-btn').forEach(btn => {
      btn.addEventListener('click', () => openDeclareModal(btn.dataset.accountId));
    });
    document.querySelectorAll('.note-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.reconId;
        const found = (latestList || []).find(d => d.id === id) || (historyList || []).find(d => d.id === id);
        if (found) openNoteModal(found);
      });
    });
  }

  /* ─────── Loader ─────── */
  async function loadAll() {
    console.log('[recon]', VERSION, 'loadAll start');
    try {
      // Refresh accounts cache for the dropdown + live preview balances
      if (window.store && window.store.refreshBalances) {
        try { await window.store.refreshBalances(); } catch (_) { /* non-fatal */ }
      }
      const r = await fetch('/api/reconciliation', { cache: 'no-store' });
      const body = await r.json();
      console.log('[recon] /api/reconciliation', r.status, '→', body.declarations_count, 'declarations');
      if (!body.ok) throw new Error(body.error || 'reconciliation payload not ok');

      const latest = body.accounts_latest || [];
      const history = body.declarations || [];

      // Header summary
      setText('recon-summary',
        body.declarations_count + ' declaration(s) · ' +
        body.clean_count + '/' + body.accounts_with_declarations + ' clean'
      );
      setText('recon-clean-count', body.clean_count);
      setText('recon-drifted-count', body.drifted_count);

      // Latest per account
      if (latest.length) {
        setHTML('recon-latest-list', latest.map(renderLatestRow).join(''));
      } else {
        setHTML('recon-latest-list', '<div class="empty-state-inline">No declarations yet — click + Declare Balance above to start.</div>');
      }

      // Full history
      if (history.length) {
        setHTML('recon-history-list', history.map(renderHistoryRow).join(''));
      } else {
        setHTML('recon-history-list', '<div class="empty-state-inline">History will appear here as you declare.</div>');
      }

      attachRowHandlers(latest, history);
    } catch (e) {
      console.error('[recon] loadAll FAILED:', e);
      setText('recon-summary', 'load failed');
      setHTML('recon-latest-list', '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>');
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[recon]', VERSION, 'init');
    wireDeclareModal();
    wireNoteModal();
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
