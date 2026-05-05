/* ─── Sovereign Finance · Accounts Page v0.7.1 · DOM ID FIX ─── */
/*
 * Changes vs v0.7.0:
 *   - Targets REAL IDs from deployed accounts.html (acc-* prefix):
 *       acc-net-worth (was account-net-worth)
 *       acc-assets-list + acc-liabilities-list (split, was single account-list)
 *       acc-assets-count + acc-assets-total (was summary-asset-count)
 *       acc-liabilities-count + acc-liabilities-total (NEW separate)
 *       acc-archived-list + acc-archived-count + acc-archived-toggle (NEW)
 *   - Renders assets and liabilities into SEPARATE sections matching new layout
 *   - Renders archived section collapsible
 *   - Uses /api/accounts (already correct math after Ship 1 v0.2.3)
 *
 * PRESERVED from v0.7.0:
 *   - Add Account modal (all addAccount* IDs match)
 *   - Edit Account modal (all editAccount* IDs match)
 *   - Archive/Delete flows
 *   - CC enrichment display
 *   - Validation logic
 */

(function () {
  'use strict';

  console.log('[accounts] v0.7.1 init');

  const $ = id => document.getElementById(id);

  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs —';
    const sign = amount < 0 ? '-' : '';
    const abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ─── DOM refs (read once on init) ─── */
  let netWorthEl, assetsCountEl, assetsTotalEl, assetsListEl;
  let liabCountEl, liabTotalEl, liabListEl;
  let archivedHeaderEl, archivedCountEl, archivedToggleEl, archivedListEl;
  let archivedExpanded = false;

  function bindDOMRefs() {
    netWorthEl = $('acc-net-worth');
    assetsCountEl = $('acc-assets-count');
    assetsTotalEl = $('acc-assets-total');
    assetsListEl = $('acc-assets-list');
    liabCountEl = $('acc-liabilities-count');
    liabTotalEl = $('acc-liabilities-total');
    liabListEl = $('acc-liabilities-list');
    archivedHeaderEl = $('acc-archived-header');
    archivedCountEl = $('acc-archived-count');
    archivedToggleEl = $('acc-archived-toggle');
    archivedListEl = $('acc-archived-list');
  }

  /* ─── Render account row ─── */
  function renderAccountRow(acct, isLiability) {
    const balance = Number(acct.balance) || 0;
    const balanceCls = isLiability
      ? (balance < 0 ? 'value danger' : 'value')
      : (balance < 0 ? 'value danger' : 'value');
    const showBalance = isLiability ? Math.abs(balance) : balance;

    let ccBadge = '';
    if (acct.is_credit_card && acct.utilization_pct != null) {
      const pct = acct.utilization_pct;
      const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'accent';
      ccBadge = `<span class="meta ${cls}">${pct}% used</span>`;
    }

    let dueBadge = '';
    if (acct.is_credit_card && acct.days_to_payment_due != null) {
      const days = acct.days_to_payment_due;
      const dueText = days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days}d`;
      const cls = days <= 2 ? 'danger' : days <= 7 ? 'warn' : '';
      dueBadge = `<span class="meta ${cls}">${dueText}</span>`;
    }

    return `
      <div class="mini-row" data-account-id="${escapeHtml(acct.id)}">
        <div class="mini-row-left">
          <div class="mini-row-icon">${escapeHtml(acct.icon || '🏦')}</div>
          <div class="mini-row-meta">
            <div class="mini-row-name">${escapeHtml(acct.name)}</div>
            <div class="mini-row-sub">
              <span class="meta">${escapeHtml(acct.kind_label || acct.kind)}</span>
              ${ccBadge}
              ${dueBadge}
            </div>
          </div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount ${balanceCls}">${fmtPKR(showBalance)}</div>
          <button class="ghost-btn edit-account-btn" data-account-id="${escapeHtml(acct.id)}" style="font-size:12px;padding:4px 10px;margin-top:4px" title="Edit / Archive / Delete">✏️</button>
        </div>
      </div>
    `;
  }

  /* ─── Render archived row (read-only display) ─── */
  function renderArchivedRow(acct) {
    return `
      <div class="mini-row archived-row" data-account-id="${escapeHtml(acct.id)}">
        <div class="mini-row-left">
          <div class="mini-row-icon" style="opacity:0.5">${escapeHtml(acct.icon || '🏦')}</div>
          <div class="mini-row-meta">
            <div class="mini-row-name" style="opacity:0.7">${escapeHtml(acct.name)}</div>
            <div class="mini-row-sub">
              <span class="meta">${escapeHtml(acct.kind_label || acct.kind)} · archived</span>
            </div>
          </div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount" style="opacity:0.6">${fmtPKR(Math.abs(Number(acct.balance) || 0))}</div>
        </div>
      </div>
    `;
  }

  /* ─── Main load + render ─── */
  async function loadAll() {
    console.log('[accounts] v0.7.1 loadAll start');
    try {
      const r = await fetch('/api/accounts?cb=' + Date.now());
      const data = await r.json();
      console.log('[accounts] /api/accounts ' + r.status + ' →', data.accounts?.length, 'accounts');

      if (!data.ok) {
        console.warn('[accounts] API error:', data.error);
        if (assetsListEl) assetsListEl.innerHTML = '<div class="mini-row"><span class="meta">Error: ' + escapeHtml(data.error || 'Unknown') + '</span></div>';
        return;
      }

      const accounts = data.accounts || [];
      const active = accounts.filter(a => a.status !== 'archived' && a.status !== 'deleted');
      const archived = accounts.filter(a => a.status === 'archived');

      const assets = active.filter(a => a.type === 'asset').sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
      const liabilities = active.filter(a => a.type === 'liability').sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

      // Render assets list
      if (assetsListEl) {
        if (assets.length === 0) {
          assetsListEl.innerHTML = '<div class="mini-row"><span class="meta">No active asset accounts.</span></div>';
        } else {
          assetsListEl.innerHTML = assets.map(a => renderAccountRow(a, false)).join('');
        }
      }

      // Render liabilities list
      if (liabListEl) {
        if (liabilities.length === 0) {
          liabListEl.innerHTML = '<div class="mini-row"><span class="meta">No liability accounts.</span></div>';
        } else {
          liabListEl.innerHTML = liabilities.map(a => renderAccountRow(a, true)).join('');
        }
      }

      // Render archived list
      if (archivedListEl) {
        if (archived.length === 0) {
          archivedListEl.innerHTML = '<div class="mini-row"><span class="meta">No archived accounts.</span></div>';
        } else {
          archivedListEl.innerHTML = archived.map(renderArchivedRow).join('');
        }
      }

      // Compute totals
      const assetsTotal = assets.reduce((s, a) => s + (Number(a.balance) || 0), 0);
      const liabTotal = liabilities.reduce((s, a) => s + (Number(a.balance) || 0), 0);
      const netWorth = assetsTotal + liabTotal;

      // Update summary
      if (assetsCountEl) assetsCountEl.textContent = assets.length;
      if (assetsTotalEl) assetsTotalEl.textContent = fmtPKR(assetsTotal);
      if (liabCountEl) liabCountEl.textContent = liabilities.length;
      if (liabTotalEl) liabTotalEl.textContent = fmtPKR(Math.abs(liabTotal));
      if (netWorthEl) netWorthEl.textContent = fmtPKR(netWorth);
      if (archivedCountEl) archivedCountEl.textContent = archived.length;

      // Wire edit buttons (delegated each render)
      document.querySelectorAll('.edit-account-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.preventDefault();
          const id = btn.getAttribute('data-account-id');
          const acct = accounts.find(a => a.id === id);
          if (acct) openEditModal(acct);
        });
      });

      console.log('[accounts] render complete · assets:', assets.length, '· liabs:', liabilities.length, '· archived:', archived.length, '· net worth:', netWorth);

    } catch (e) {
      console.error('[accounts] loadAll failed:', e);
      if (assetsListEl) assetsListEl.innerHTML = '<div class="mini-row"><span class="meta">Failed to load. Check console.</span></div>';
    }
  }

  /* ─── Add Account modal ─── */
  function openAddModal() {
    const m = $('addAccountModal');
    if (!m) return;
    m.style.display = 'flex';
    ['addAccountName', 'addAccountIcon', 'addAccountOpening', 'addAccountOrder',
     'addAccountCreditLimit', 'addAccountMinPayment', 'addAccountStatementDay', 'addAccountDueDay'].forEach(id => {
      const el = $(id);
      if (el) el.value = '';
    });
    const kindSel = $('addAccountKind');
    if (kindSel) kindSel.value = 'bank';
    toggleAddCCBlock();
  }

  function closeAddModal() {
    const m = $('addAccountModal');
    if (m) m.style.display = 'none';
  }

  function toggleAddCCBlock() {
    const kind = $('addAccountKind')?.value;
    const block = $('addAccountCCBlock');
    if (block) block.style.display = (kind === 'cc') ? 'block' : 'none';
  }

  async function submitAddAccount() {
    const btn = $('addAccountConfirm');
    const name = $('addAccountName')?.value?.trim();
    const icon = $('addAccountIcon')?.value?.trim();
    const kind = $('addAccountKind')?.value;
    const opening = parseFloat($('addAccountOpening')?.value || '0');
    const order = parseInt($('addAccountOrder')?.value || '0', 10);

    if (!name || !kind) {
      alert('Name and kind are required.');
      return;
    }

    const type = kind === 'cc' ? 'liability' : 'asset';
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30);

    const body = {
      id, name, icon: icon || null, kind, type,
      opening_balance: opening || 0,
      display_order: order || 0,
      created_by: 'web-account-create'
    };

    if (kind === 'cc') {
      body.credit_limit = parseFloat($('addAccountCreditLimit')?.value || '0') || null;
      body.min_payment_amount = parseFloat($('addAccountMinPayment')?.value || '0') || null;
      body.statement_day = parseInt($('addAccountStatementDay')?.value || '0', 10) || null;
      body.payment_due_day = parseInt($('addAccountDueDay')?.value || '0', 10) || null;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const r = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (data.ok) {
        closeAddModal();
        loadAll();
      } else {
        alert('Add failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Account'; }
    }
  }

  /* ─── Edit Account modal ─── */
  let _editContext = null;

  function openEditModal(acct) {
    _editContext = acct;
    const m = $('editAccountModal');
    if (!m) return;
    m.style.display = 'flex';

    if ($('editAccountTitle')) $('editAccountTitle').textContent = 'Edit ' + acct.name;
    if ($('editAccountSub')) $('editAccountSub').textContent = (acct.kind_label || acct.kind) + ' · ' + (acct.id);
    if ($('editAccountName')) $('editAccountName').value = acct.name || '';
    if ($('editAccountIcon')) $('editAccountIcon').value = acct.icon || '';
    if ($('editAccountKind')) $('editAccountKind').value = acct.kind || 'bank';
    if ($('editAccountOpening')) $('editAccountOpening').value = acct.opening_balance || 0;
    if ($('editAccountOrder')) $('editAccountOrder').value = acct.display_order || 0;
    if ($('editAccountCreditLimit')) $('editAccountCreditLimit').value = acct.credit_limit || '';
    if ($('editAccountMinPayment')) $('editAccountMinPayment').value = acct.min_payment_amount || '';
    if ($('editAccountStatementDay')) $('editAccountStatementDay').value = acct.statement_day || '';
    if ($('editAccountDueDay')) $('editAccountDueDay').value = acct.payment_due_day || '';

    const ccBlock = $('editAccountCCBlock');
    if (ccBlock) ccBlock.style.display = (acct.kind === 'cc') ? 'block' : 'none';
  }

  function closeEditModal() {
    const m = $('editAccountModal');
    if (m) m.style.display = 'none';
    _editContext = null;
  }

  async function submitEditAccount() {
    if (!_editContext) return;
    const btn = $('editAccountConfirm');
    const id = _editContext.id;

    const body = {
      name: $('editAccountName')?.value?.trim(),
      icon: $('editAccountIcon')?.value?.trim() || null,
      opening_balance: parseFloat($('editAccountOpening')?.value || '0') || 0,
      display_order: parseInt($('editAccountOrder')?.value || '0', 10),
      created_by: 'web-account-edit'
    };

    if (_editContext.kind === 'cc') {
      body.credit_limit = parseFloat($('editAccountCreditLimit')?.value || '0') || null;
      body.min_payment_amount = parseFloat($('editAccountMinPayment')?.value || '0') || null;
      body.statement_day = parseInt($('editAccountStatementDay')?.value || '0', 10) || null;
      body.payment_due_day = parseInt($('editAccountDueDay')?.value || '0', 10) || null;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await fetch('/api/accounts/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (data.ok) {
        closeEditModal();
        loadAll();
      } else {
        alert('Save failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  async function archiveAccount() {
    if (!_editContext) return;
    if (!confirm('Archive ' + _editContext.name + '? It will move to the archived section.')) return;
    const id = _editContext.id;
    try {
      const r = await fetch('/api/accounts/' + encodeURIComponent(id) + '?action=archive&created_by=web-account-archive', { method: 'DELETE' });
      const data = await r.json();
      if (data.ok) {
        closeEditModal();
        loadAll();
      } else {
        alert('Archive failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Archive failed: ' + e.message);
    }
  }

  async function deleteAccount() {
    if (!_editContext) return;
    if (!confirm('PERMANENTLY DELETE ' + _editContext.name + '?\n\nThis is a soft delete (data preserved in DB) but the account will not appear anywhere in the app.')) return;
    const id = _editContext.id;
    try {
      const r = await fetch('/api/accounts/' + encodeURIComponent(id) + '?action=delete&created_by=web-account-delete', { method: 'DELETE' });
      const data = await r.json();
      if (data.ok) {
        closeEditModal();
        loadAll();
      } else {
        alert('Delete failed: ' + (data.error || 'HTTP ' + r.status));
      }
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  /* ─── Archived toggle ─── */
  function toggleArchived() {
    archivedExpanded = !archivedExpanded;
    if (archivedListEl) archivedListEl.style.display = archivedExpanded ? 'block' : 'none';
    if (archivedToggleEl) archivedToggleEl.textContent = archivedExpanded ? '▾' : '▸';
  }

  /* ─── Init ─── */
  function init() {
    bindDOMRefs();

    // Wire add button
    const addBtn = $('addAccountBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);

    // Wire add modal buttons
    const addCancel = $('addAccountCancel');
    if (addCancel) addCancel.addEventListener('click', closeAddModal);
    const addConfirm = $('addAccountConfirm');
    if (addConfirm) addConfirm.addEventListener('click', submitAddAccount);
    const addKind = $('addAccountKind');
    if (addKind) addKind.addEventListener('change', toggleAddCCBlock);

    // Wire edit modal buttons
    const editCancel = $('editAccountCancel');
    if (editCancel) editCancel.addEventListener('click', closeEditModal);
    const editConfirm = $('editAccountConfirm');
    if (editConfirm) editConfirm.addEventListener('click', submitEditAccount);
    const editArchive = $('editAccountArchive');
    if (editArchive) editArchive.addEventListener('click', archiveAccount);
    const editDelete = $('editAccountDelete');
    if (editDelete) editDelete.addEventListener('click', deleteAccount);

    // Wire archived toggle
    if (archivedHeaderEl) archivedHeaderEl.addEventListener('click', toggleArchived);

    // Initial load
    loadAll();

    // Refresh every 60s
    setInterval(loadAll, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
