/* Sovereign Finance - Accounts Page v0.7.2 - Full rewrite, syntax-safe */
/* Fetches /api/balances for net worth (Pattern 4 single source of truth) */
/* Reads /api/accounts for per-account balances */
/* All DOM IDs verified live from accounts.html */

(function () {
  'use strict';

  var VERSION = 'v0.7.2';
  console.log('[accounts] ' + VERSION + ' init');

  function $(id) { return document.getElementById(id); }

  function fmtPKR(amount) {
    if (amount == null || isNaN(amount)) return 'Rs -';
    var sign = amount < 0 ? '-' : '';
    var abs = Math.abs(amount);
    return 'Rs ' + sign + abs.toLocaleString('en-PK', { maximumFractionDigits: 0 });
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* DOM refs */
  var netWorthEl, assetsCountEl, assetsTotalEl, assetsListEl;
  var liabCountEl, liabTotalEl, liabListEl;
  var archivedHeaderEl, archivedCountEl, archivedToggleEl, archivedListEl;
  var archivedExpanded = false;

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

  /* Render account row using string concat (no nested template literals) */
  function renderAccountRow(acct, isLiability) {
    var balance = Number(acct.balance) || 0;
    var showBalance = isLiability ? Math.abs(balance) : balance;
    var balanceCls = balance < 0 ? 'value danger' : 'value';

    var ccBadge = '';
    if (acct.is_credit_card && acct.utilization_pct != null) {
      var pct = acct.utilization_pct;
      var cls = pct >= 90 ? 'danger' : (pct >= 70 ? 'warn' : 'accent');
      ccBadge = '<span class="meta ' + cls + '">' + pct + '% used</span>';
    }

    var dueBadge = '';
    if (acct.is_credit_card && acct.days_to_payment_due != null) {
      var days = acct.days_to_payment_due;
      var dueText;
      if (days === 0) dueText = 'due today';
      else if (days === 1) dueText = 'due tomorrow';
      else dueText = 'due in ' + days + 'd';
      var dueCls = days <= 2 ? 'danger' : (days <= 7 ? 'warn' : '');
      dueBadge = '<span class="meta ' + dueCls + '">' + dueText + '</span>';
    }

    var html = '';
    html += '<div class="mini-row" data-account-id="' + escHtml(acct.id) + '">';
    html += '<div class="mini-row-left">';
    html += '<div class="mini-row-icon">' + escHtml(acct.icon || '') + '</div>';
    html += '<div class="mini-row-meta">';
    html += '<div class="mini-row-name">' + escHtml(acct.name) + '</div>';
    html += '<div class="mini-row-sub">';
    html += '<span class="meta">' + escHtml(acct.kind_label || acct.kind) + '</span>';
    html += ccBadge;
    html += dueBadge;
    html += '</div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="mini-row-right">';
    html += '<div class="mini-row-amount ' + balanceCls + '">' + fmtPKR(showBalance) + '</div>';
    html += '<button class="ghost-btn edit-account-btn" data-account-id="' + escHtml(acct.id) + '" style="font-size:12px;padding:4px 10px;margin-top:4px" title="Edit">edit</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderArchivedRow(acct) {
    var html = '';
    html += '<div class="mini-row archived-row" data-account-id="' + escHtml(acct.id) + '">';
    html += '<div class="mini-row-left">';
    html += '<div class="mini-row-icon" style="opacity:0.5">' + escHtml(acct.icon || '') + '</div>';
    html += '<div class="mini-row-meta">';
    html += '<div class="mini-row-name" style="opacity:0.7">' + escHtml(acct.name) + '</div>';
    html += '<div class="mini-row-sub"><span class="meta">' + escHtml(acct.kind_label || acct.kind) + ' archived</span></div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="mini-row-right">';
    html += '<div class="mini-row-amount" style="opacity:0.6">' + fmtPKR(Math.abs(Number(acct.balance) || 0)) + '</div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  /* Main load + render */
  function loadAll() {
    console.log('[accounts] ' + VERSION + ' loadAll start');
    var allAccounts = [];

    fetch('/api/accounts?cb=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        console.log('[accounts] /api/accounts ' + (data.ok ? 'ok' : 'err') + ' count: ' + (data.accounts ? data.accounts.length : 0));
        if (!data.ok) {
          if (assetsListEl) assetsListEl.innerHTML = '<div class="mini-row"><span class="meta">Error: ' + escHtml(data.error || 'Unknown') + '</span></div>';
          return;
        }

        allAccounts = data.accounts || [];
        var active = allAccounts.filter(function (a) { return a.status !== 'archived' && a.status !== 'deleted'; });
        var archived = allAccounts.filter(function (a) { return a.status === 'archived'; });

        var assets = active.filter(function (a) { return a.type === 'asset'; })
          .sort(function (a, b) { return (a.display_order || 0) - (b.display_order || 0); });
        var liabilities = active.filter(function (a) { return a.type === 'liability'; })
          .sort(function (a, b) { return (a.display_order || 0) - (b.display_order || 0); });

        // Render assets
        if (assetsListEl) {
          if (assets.length === 0) {
            assetsListEl.innerHTML = '<div class="mini-row"><span class="meta">No active asset accounts.</span></div>';
          } else {
            assetsListEl.innerHTML = assets.map(function (a) { return renderAccountRow(a, false); }).join('');
          }
        }

        // Render liabilities
        if (liabListEl) {
          if (liabilities.length === 0) {
            liabListEl.innerHTML = '<div class="mini-row"><span class="meta">No liability accounts.</span></div>';
          } else {
            liabListEl.innerHTML = liabilities.map(function (a) { return renderAccountRow(a, true); }).join('');
          }
        }

        // Render archived
        if (archivedListEl) {
          if (archived.length === 0) {
            archivedListEl.innerHTML = '<div class="mini-row"><span class="meta">No archived accounts.</span></div>';
          } else {
            archivedListEl.innerHTML = archived.map(renderArchivedRow).join('');
          }
        }

        // Sub-totals from per-account balances
        var assetsTotal = assets.reduce(function (s, a) { return s + (Number(a.balance) || 0); }, 0);
        var liabTotal = liabilities.reduce(function (s, a) { return s + (Number(a.balance) || 0); }, 0);

        if (assetsCountEl) assetsCountEl.textContent = assets.length;
        if (assetsTotalEl) assetsTotalEl.textContent = fmtPKR(assetsTotal);
        if (liabCountEl) liabCountEl.textContent = liabilities.length;
        if (liabTotalEl) liabTotalEl.textContent = fmtPKR(Math.abs(liabTotal));
        if (archivedCountEl) archivedCountEl.textContent = archived.length;

        // Wire edit buttons
        var btns = document.querySelectorAll('.edit-account-btn');
        for (var i = 0; i < btns.length; i++) {
          (function (btn) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              var id = btn.getAttribute('data-account-id');
              var acct = null;
              for (var j = 0; j < allAccounts.length; j++) {
                if (allAccounts[j].id === id) { acct = allAccounts[j]; break; }
              }
              if (acct) openEditModal(acct);
            });
          })(btns[i]);
        }

        // Net worth from /api/balances (single source of truth)
        return fetch('/api/balances?cb=' + Date.now())
          .then(function (r) { return r.json(); })
          .then(function (bd) {
            if (bd.ok && bd.net_worth != null) {
              if (netWorthEl) netWorthEl.textContent = fmtPKR(bd.net_worth);
              console.log('[accounts] net worth from /api/balances: ' + bd.net_worth);
            } else {
              // Fallback: local sum if balances endpoint fails
              if (netWorthEl) netWorthEl.textContent = fmtPKR(assetsTotal + liabTotal);
              console.warn('[accounts] /api/balances failed, using local sum');
            }
          })
          .catch(function (e) {
            if (netWorthEl) netWorthEl.textContent = fmtPKR(assetsTotal + liabTotal);
            console.warn('[accounts] /api/balances threw: ' + e.message);
          });
      })
      .catch(function (e) {
        console.error('[accounts] loadAll failed: ' + e.message);
        if (assetsListEl) assetsListEl.innerHTML = '<div class="mini-row"><span class="meta">Failed to load. Check console.</span></div>';
      });
  }

  /* Add Account modal */
  function openAddModal() {
    var m = $('addAccountModal');
    if (!m) return;
    m.style.display = 'flex';
    var ids = ['addAccountName', 'addAccountIcon', 'addAccountOpening', 'addAccountOrder', 'addAccountCreditLimit', 'addAccountMinPayment', 'addAccountStatementDay', 'addAccountDueDay'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.value = '';
    }
    var kindSel = $('addAccountKind');
    if (kindSel) kindSel.value = 'bank';
    toggleAddCCBlock();
  }

  function closeAddModal() {
    var m = $('addAccountModal');
    if (m) m.style.display = 'none';
  }

  function toggleAddCCBlock() {
    var kindSel = $('addAccountKind');
    var kind = kindSel ? kindSel.value : '';
    var block = $('addAccountCCBlock');
    if (block) block.style.display = (kind === 'cc') ? 'block' : 'none';
  }

  function submitAddAccount() {
    var btn = $('addAccountConfirm');
    var nameEl = $('addAccountName');
    var name = nameEl ? (nameEl.value || '').trim() : '';
    var iconEl = $('addAccountIcon');
    var icon = iconEl ? (iconEl.value || '').trim() : '';
    var kindEl = $('addAccountKind');
    var kind = kindEl ? kindEl.value : '';
    var openingEl = $('addAccountOpening');
    var opening = openingEl ? parseFloat(openingEl.value || '0') : 0;
    var orderEl = $('addAccountOrder');
    var order = orderEl ? parseInt(orderEl.value || '0', 10) : 0;

    if (!name || !kind) {
      alert('Name and kind are required.');
      return;
    }

    var type = kind === 'cc' ? 'liability' : 'asset';
    var id = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30);

    var body = {
      id: id,
      name: name,
      icon: icon || null,
      kind: kind,
      type: type,
      opening_balance: opening || 0,
      display_order: order || 0,
      created_by: 'web-account-create'
    };

    if (kind === 'cc') {
      var clEl = $('addAccountCreditLimit');
      var mpEl = $('addAccountMinPayment');
      var sdEl = $('addAccountStatementDay');
      var ddEl = $('addAccountDueDay');
      body.credit_limit = clEl ? (parseFloat(clEl.value || '0') || null) : null;
      body.min_payment_amount = mpEl ? (parseFloat(mpEl.value || '0') || null) : null;
      body.statement_day = sdEl ? (parseInt(sdEl.value || '0', 10) || null) : null;
      body.payment_due_day = ddEl ? (parseInt(ddEl.value || '0', 10) || null) : null;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

    fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          closeAddModal();
          loadAll();
        } else {
          alert('Add failed: ' + (data.error || 'request error'));
        }
      })
      .catch(function (e) { alert('Add failed: ' + e.message); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Add Account'; }
      });
  }

  /* Edit Account modal */
  var _editContext = null;

  function openEditModal(acct) {
    _editContext = acct;
    var m = $('editAccountModal');
    if (!m) return;
    m.style.display = 'flex';

    var titleEl = $('editAccountTitle');
    if (titleEl) titleEl.textContent = 'Edit ' + acct.name;
    var subEl = $('editAccountSub');
    if (subEl) subEl.textContent = (acct.kind_label || acct.kind) + ' - ' + acct.id;

    var nameEl = $('editAccountName');
    if (nameEl) nameEl.value = acct.name || '';
    var iconEl = $('editAccountIcon');
    if (iconEl) iconEl.value = acct.icon || '';
    var kindEl = $('editAccountKind');
    if (kindEl) kindEl.value = acct.kind || 'bank';
    var openingEl = $('editAccountOpening');
    if (openingEl) openingEl.value = acct.opening_balance || 0;
    var orderEl = $('editAccountOrder');
    if (orderEl) orderEl.value = acct.display_order || 0;
    var clEl = $('editAccountCreditLimit');
    if (clEl) clEl.value = acct.credit_limit || '';
    var mpEl = $('editAccountMinPayment');
    if (mpEl) mpEl.value = acct.min_payment_amount || '';
    var sdEl = $('editAccountStatementDay');
    if (sdEl) sdEl.value = acct.statement_day || '';
    var ddEl = $('editAccountDueDay');
    if (ddEl) ddEl.value = acct.payment_due_day || '';

    var ccBlock = $('editAccountCCBlock');
    if (ccBlock) ccBlock.style.display = (acct.kind === 'cc') ? 'block' : 'none';
  }

  function closeEditModal() {
    var m = $('editAccountModal');
    if (m) m.style.display = 'none';
    _editContext = null;
  }

  function submitEditAccount() {
    if (!_editContext) return;
    var btn = $('editAccountConfirm');
    var id = _editContext.id;

    var nameEl = $('editAccountName');
    var iconEl = $('editAccountIcon');
    var openingEl = $('editAccountOpening');
    var orderEl = $('editAccountOrder');

    var body = {
      name: nameEl ? (nameEl.value || '').trim() : '',
      icon: iconEl ? ((iconEl.value || '').trim() || null) : null,
      opening_balance: openingEl ? (parseFloat(openingEl.value || '0') || 0) : 0,
      display_order: orderEl ? parseInt(orderEl.value || '0', 10) : 0,
      created_by: 'web-account-edit'
    };

    if (_editContext.kind === 'cc') {
      var clEl = $('editAccountCreditLimit');
      var mpEl = $('editAccountMinPayment');
      var sdEl = $('editAccountStatementDay');
      var ddEl = $('editAccountDueDay');
      body.credit_limit = clEl ? (parseFloat(clEl.value || '0') || null) : null;
      body.min_payment_amount = mpEl ? (parseFloat(mpEl.value || '0') || null) : null;
      body.statement_day = sdEl ? (parseInt(sdEl.value || '0', 10) || null) : null;
      body.payment_due_day = ddEl ? (parseInt(ddEl.value || '0', 10) || null) : null;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    fetch('/api/accounts/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          closeEditModal();
          loadAll();
        } else {
          alert('Save failed: ' + (data.error || 'request error'));
        }
      })
      .catch(function (e) { alert('Save failed: ' + e.message); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      });
  }

  function archiveAccount() {
    if (!_editContext) return;
    if (!confirm('Archive ' + _editContext.name + '?')) return;
    var id = _editContext.id;
    fetch('/api/accounts/' + encodeURIComponent(id) + '?action=archive&created_by=web-account-archive', { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          closeEditModal();
          loadAll();
        } else {
          alert('Archive failed: ' + (data.error || 'request error'));
        }
      })
      .catch(function (e) { alert('Archive failed: ' + e.message); });
  }

  function deleteAccount() {
    if (!_editContext) return;
    if (!confirm('PERMANENTLY DELETE ' + _editContext.name + '? This is a soft delete (data preserved in DB).')) return;
    var id = _editContext.id;
    fetch('/api/accounts/' + encodeURIComponent(id) + '?action=delete&created_by=web-account-delete', { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          closeEditModal();
          loadAll();
        } else {
          alert('Delete failed: ' + (data.error || 'request error'));
        }
      })
      .catch(function (e) { alert('Delete failed: ' + e.message); });
  }

  function toggleArchived() {
    archivedExpanded = !archivedExpanded;
    if (archivedListEl) archivedListEl.style.display = archivedExpanded ? 'block' : 'none';
    if (archivedToggleEl) archivedToggleEl.textContent = archivedExpanded ? 'v' : '>';
  }

  function init() {
    bindDOMRefs();

    var addBtn = $('addAccountBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);

    var addCancel = $('addAccountCancel');
    if (addCancel) addCancel.addEventListener('click', closeAddModal);
    var addConfirm = $('addAccountConfirm');
    if (addConfirm) addConfirm.addEventListener('click', submitAddAccount);
    var addKind = $('addAccountKind');
    if (addKind) addKind.addEventListener('change', toggleAddCCBlock);

    var editCancel = $('editAccountCancel');
    if (editCancel) editCancel.addEventListener('click', closeEditModal);
    var editConfirm = $('editAccountConfirm');
    if (editConfirm) editConfirm.addEventListener('click', submitEditAccount);
    var editArchive = $('editAccountArchive');
    if (editArchive) editArchive.addEventListener('click', archiveAccount);
    var editDelete = $('editAccountDelete');
    if (editDelete) editDelete.addEventListener('click', deleteAccount);

    if (archivedHeaderEl) archivedHeaderEl.addEventListener('click', toggleArchived);

    loadAll();
    setInterval(loadAll, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
