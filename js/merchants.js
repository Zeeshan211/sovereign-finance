/* Sovereign Finance - Merchants Page v0.1.0 */
/* No template literals, string concat only, syntax-safe */
/* Connects to /api/merchants CRUD + /api/categories + window.store.cachedAccounts */

(function () {
  'use strict';

  var VERSION = 'v0.1.0';
  console.log('[merchants] ' + VERSION + ' init');

  function $(id) { return document.getElementById(id); }

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtAgo(ms) {
    if (!ms) return 'just now';
    var sec = Math.floor(ms / 1000);
    if (sec < 60) return 'just now';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    var day = Math.floor(hr / 24);
    return day + 'd ago';
  }

  /* DOM refs */
  var summaryCountEl, summaryHitsEl, summaryPraEl;
  var listEl, freshnessEl;
  var lastFetchedAt = null;
  var allMerchants = [];
  var cachedCategories = [];

  function bindDOMRefs() {
    summaryCountEl = $('merch-count');
    summaryHitsEl = $('merch-learned-total');
    summaryPraEl = $('merch-pra-count');
    listEl = $('merch-list');
    freshnessEl = $('merch-freshness');
  }

  function updateFreshness() {
    if (!freshnessEl || !lastFetchedAt) return;
    var ago = Date.now() - lastFetchedAt;
    freshnessEl.textContent = 'Live - ' + fmtAgo(ago);
  }

  /* Render merchant row */
  function renderMerchantRow(m) {
    var hits = Number(m.learned_count) || 0;
    var pra = m.is_pra_required ? '<span class="meta warn">PRA</span>' : '';
    var aliasesText = m.aliases ? ' - aka: ' + escHtml(m.aliases) : '';

    var html = '';
    html += '<div class="mini-row" data-merch-id="' + escHtml(m.id) + '">';
    html += '<div class="mini-row-left">';
    html += '<div class="mini-row-meta">';
    html += '<div class="mini-row-name">' + escHtml(m.name) + '</div>';
    html += '<div class="mini-row-sub">';
    html += '<span class="meta">' + escHtml(m.default_category_id || 'no category') + '</span>';
    html += pra;
    if (aliasesText) html += '<span class="meta">' + aliasesText + '</span>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
    html += '<div class="mini-row-right">';
    html += '<div class="mini-row-amount value">' + hits + ' hits</div>';
    html += '<button class="ghost-btn edit-merch-btn" data-merch-id="' + escHtml(m.id) + '" style="font-size:11px;padding:3px 8px;margin-top:4px">edit</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  /* Load all merchants */
  function loadAll() {
    console.log('[merchants] loadAll start');

    fetch('/api/merchants?cb=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          console.warn('[merchants] api error: ' + data.error);
          if (listEl) listEl.innerHTML = '<div class="mini-row"><span class="meta">Error: ' + escHtml(data.error || 'Unknown') + '</span></div>';
          return;
        }

        allMerchants = data.merchants || [];
        console.log('[merchants] /api/merchants ok, count: ' + allMerchants.length);

        // Render summary
        if (summaryCountEl) summaryCountEl.textContent = allMerchants.length;
        var totalHits = allMerchants.reduce(function (s, m) { return s + (Number(m.learned_count) || 0); }, 0);
        if (summaryHitsEl) summaryHitsEl.textContent = totalHits;
        var praCount = allMerchants.filter(function (m) { return m.is_pra_required; }).length;
        if (summaryPraEl) summaryPraEl.textContent = praCount;

        // Render list
        if (listEl) {
          if (allMerchants.length === 0) {
            listEl.innerHTML = '<div class="mini-row"><span class="meta">No merchants yet. Click + Add to create one.</span></div>';
          } else {
            // Sort by hits desc, then name asc
            var sorted = allMerchants.slice().sort(function (a, b) {
              var hA = Number(a.learned_count) || 0;
              var hB = Number(b.learned_count) || 0;
              if (hB !== hA) return hB - hA;
              return (a.name || '').localeCompare(b.name || '');
            });
            listEl.innerHTML = sorted.map(renderMerchantRow).join('');
          }
        }

        // Wire edit buttons
        var btns = document.querySelectorAll('.edit-merch-btn');
        for (var i = 0; i < btns.length; i++) {
          (function (btn) {
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              var id = btn.getAttribute('data-merch-id');
              var m = null;
              for (var j = 0; j < allMerchants.length; j++) {
                if (allMerchants[j].id === id) { m = allMerchants[j]; break; }
              }
              if (m) openEditModal(m);
            });
          })(btns[i]);
        }

        lastFetchedAt = Date.now();
        updateFreshness();
      })
      .catch(function (e) {
        console.error('[merchants] loadAll failed: ' + e.message);
        if (listEl) listEl.innerHTML = '<div class="mini-row"><span class="meta">Failed to load. Check console.</span></div>';
      });
  }

  /* Categories dropdown population */
  function loadCategories() {
    fetch('/api/categories?cb=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        cachedCategories = (d.categories || []);
      })
      .catch(function (e) {
        console.warn('[merchants] categories load failed: ' + e.message);
        cachedCategories = [];
      });
  }

  function populateCategoryDropdown(elId, selectedId) {
    var sel = $(elId);
    if (!sel) return;
    var html = '<option value="">Select category</option>';
    for (var i = 0; i < cachedCategories.length; i++) {
      var c = cachedCategories[i];
      var sel2 = (c.id === selectedId) ? ' selected' : '';
      html += '<option value="' + escHtml(c.id) + '"' + sel2 + '>' + escHtml(c.name) + '</option>';
    }
    sel.innerHTML = html;
  }

  function populateAccountDropdown(elId, selectedId) {
    var sel = $(elId);
    if (!sel) return;
    var accounts = (window.store && window.store.cachedAccounts) || [];
    var html = '<option value="">Select account</option>';
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      var sel2 = (a.id === selectedId) ? ' selected' : '';
      html += '<option value="' + escHtml(a.id) + '"' + sel2 + '>' + escHtml((a.icon || '') + ' ' + a.name) + '</option>';
    }
    sel.innerHTML = html;
  }

  /* Add Modal */
  function openAddModal() {
    var m = $('addMerchModal');
    if (!m) return;
    m.style.display = 'flex';
    var ids = ['addMerchName', 'addMerchAliases'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.value = '';
    }
    var pra = $('addMerchPra');
    if (pra) pra.checked = false;
    populateCategoryDropdown('addMerchCategory');
    populateAccountDropdown('addMerchAccount');
  }

  function closeAddModal() {
    var m = $('addMerchModal');
    if (m) m.style.display = 'none';
  }

  function submitAdd() {
    var btn = $('addMerchConfirm');
    var nameEl = $('addMerchName');
    var aliasesEl = $('addMerchAliases');
    var catEl = $('addMerchCategory');
    var accEl = $('addMerchAccount');
    var praEl = $('addMerchPra');

    var name = nameEl ? (nameEl.value || '').trim() : '';
    var aliases = aliasesEl ? (aliasesEl.value || '').trim() : '';
    var defaultCategoryId = catEl ? (catEl.value || null) : null;
    var defaultAccountId = accEl ? (accEl.value || null) : null;
    var isPraRequired = praEl ? praEl.checked : false;

    if (!name) {
      alert('Name is required.');
      return;
    }

    var body = {
      name: name,
      aliases: aliases || null,
      default_category_id: defaultCategoryId,
      default_account_id: defaultAccountId,
      is_pra_required: isPraRequired,
      created_by: 'web-merchant-create'
    };

    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }

    fetch('/api/merchants', {
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
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
      });
  }

  /* Edit Modal */
  var _editContext = null;

  function openEditModal(m) {
    _editContext = m;
    var modal = $('editMerchModal');
    if (!modal) return;
    modal.style.display = 'flex';

    var titleEl = $('editMerchTitle');
    if (titleEl) titleEl.textContent = 'Edit ' + m.name;
    var subEl = $('editMerchSub');
    if (subEl) subEl.textContent = (Number(m.learned_count) || 0) + ' hits - id: ' + m.id;

    var nameEl = $('editMerchName');
    if (nameEl) nameEl.value = m.name || '';
    var aliasesEl = $('editMerchAliases');
    if (aliasesEl) aliasesEl.value = m.aliases || '';
    var praEl = $('editMerchPra');
    if (praEl) praEl.checked = !!m.is_pra_required;

    populateCategoryDropdown('editMerchCategory', m.default_category_id);
    populateAccountDropdown('editMerchAccount', m.default_account_id);
  }

  function closeEditModal() {
    var modal = $('editMerchModal');
    if (modal) modal.style.display = 'none';
    _editContext = null;
  }

  function submitEdit() {
    if (!_editContext) return;
    var btn = $('editMerchConfirm');
    var id = _editContext.id;

    var nameEl = $('editMerchName');
    var aliasesEl = $('editMerchAliases');
    var catEl = $('editMerchCategory');
    var accEl = $('editMerchAccount');
    var praEl = $('editMerchPra');

    var body = {
      name: nameEl ? (nameEl.value || '').trim() : '',
      aliases: aliasesEl ? ((aliasesEl.value || '').trim() || null) : null,
      default_category_id: catEl ? (catEl.value || null) : null,
      default_account_id: accEl ? (accEl.value || null) : null,
      is_pra_required: praEl ? praEl.checked : false,
      created_by: 'web-merchant-edit'
    };

    if (!body.name) {
      alert('Name cannot be empty.');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    fetch('/api/merchants/' + encodeURIComponent(id), {
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

  function deleteMerchant() {
    if (!_editContext) return;
    if (!confirm('PERMANENTLY DELETE merchant "' + _editContext.name + '"?')) return;
    var id = _editContext.id;
    fetch('/api/merchants/' + encodeURIComponent(id) + '?created_by=web-merchant-delete', { method: 'DELETE' })
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

  /* Init */
  function init() {
    bindDOMRefs();

    // Refresh accounts cache
    if (window.store && window.store.refreshBalances) {
      try { window.store.refreshBalances(); } catch (_) { }
    }

    // Load categories then load merchants
    loadCategories();
    loadAll();

    // Wire add button
    var addBtn = $('addMerchBtn');
    if (addBtn) addBtn.addEventListener('click', openAddModal);

    // Wire add modal
    var addCancel = $('addMerchCancel');
    if (addCancel) addCancel.addEventListener('click', closeAddModal);
    var addConfirm = $('addMerchConfirm');
    if (addConfirm) addConfirm.addEventListener('click', submitAdd);

    // Wire edit modal
    var editCancel = $('editMerchCancel');
    if (editCancel) editCancel.addEventListener('click', closeEditModal);
    var editConfirm = $('editMerchConfirm');
    if (editConfirm) editConfirm.addEventListener('click', submitEdit);
    var editDelete = $('editMerchDelete');
    if (editDelete) editDelete.addEventListener('click', deleteMerchant);

    // Refresh every 60s
    setInterval(loadAll, 60000);
    // Refresh freshness label every 30s
    setInterval(updateFreshness, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
