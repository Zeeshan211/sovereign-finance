/* Sovereign Finance - Accounts Page v0.8.0 - Shell migration */

(function () {
  'use strict';

  var VERSION = 'v0.8.0-shell-migration';
  var allAccounts = [];

  function $(id) {
    return document.getElementById(id);
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtPKR(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return 'Rs —';
    return 'Rs ' + num.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function normalizeAccountsPayload(payload) {
    var raw = payload && payload.accounts;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(function (id) {
        var row = raw[id] || {};
        if (!row.id) row.id = id;
        return row;
      });
    }
    return [];
  }

  function renderAccountRow(acct) {
    var icon = acct.icon || (acct.category === 'asset' ? '💰' : '💳');
    var name = acct.name || acct.label || acct.id || 'Unknown';
    var category = acct.category || 'account';
    var status = acct.status || 'active';
    var showBalance = Number(acct.balance) || 0;
    var balanceCls = showBalance < 0 ? 'danger' : '';

    var metaTags = [];
    if (category) metaTags.push('<span class="meta">' + escHtml(category) + '</span>');
    if (status && status !== 'active') metaTags.push('<span class="meta warn">' + escHtml(status) + '</span>');

    var html = '';
    html += '<div class="mini-row">';
    html += '  <div class="mini-row-left">';
    html += '    <div class="mini-row-icon">' + escHtml(icon) + '</div>';
    html += '    <div>';
    html += '      <div class="mini-row-name">' + escHtml(name) + '</div>';
    if (metaTags.length) {
      html += '      <div class="mini-row-sub">' + metaTags.join('') + '</div>';
    }
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="mini-row-right">';
    html += '    <div class="mini-row-amount ' + balanceCls + '">' + fmtPKR(showBalance) + '</div>';
    html += '  </div>';
    html += '</div>';
    return html;
  }

  function loadAccounts() {
    Promise.all([
      fetch('/api/accounts?debug=1', { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }),
      fetch('/api/balances?debug=1', { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var accountsData = results[0];
      var balancesData = results[1];

      console.log('[accounts] /api/accounts ok:', accountsData.ok, 'count:', accountsData.accounts ? (Array.isArray(accountsData.accounts) ? accountsData.accounts.length : Object.keys(accountsData.accounts).length) : 0);
      console.log('[accounts] /api/balances ok:', balancesData.ok);

      if (!accountsData.ok) {
        if ($('acc-assets-list')) $('acc-assets-list').innerHTML = '<div class="accounts-empty">Error: ' + escHtml(accountsData.error || 'Unknown') + '</div>';
        return;
      }

      allAccounts = normalizeAccountsPayload(accountsData);

      var active = allAccounts.filter(function (a) { return a.status !== 'archived' && a.status !== 'deleted'; });
      var archived = allAccounts.filter(function (a) { return a.status === 'archived'; });

      var assets = active.filter(function (a) { return a.category === 'asset'; });
      var liabilities = active.filter(function (a) { return a.category === 'liability'; });

      var assetsTotal = assets.reduce(function (sum, a) { return sum + (Number(a.balance) || 0); }, 0);
      var liabilitiesTotal = liabilities.reduce(function (sum, a) { return sum + (Number(a.balance) || 0); }, 0);

      if ($('acc-assets-count')) $('acc-assets-count').textContent = String(assets.length);
      if ($('acc-assets-total')) $('acc-assets-total').textContent = fmtPKR(assetsTotal);
      if ($('acc-liabilities-count')) $('acc-liabilities-count').textContent = String(liabilities.length);
      if ($('acc-liabilities-total')) $('acc-liabilities-total').textContent = fmtPKR(liabilitiesTotal);
      if ($('acc-archived-count')) $('acc-archived-count').textContent = String(archived.length);

      if ($('acc-assets-list')) {
        $('acc-assets-list').innerHTML = assets.length
          ? assets.map(renderAccountRow).join('')
          : '<div class="accounts-empty">No active asset accounts.</div>';
      }

      if ($('acc-liabilities-list')) {
        $('acc-liabilities-list').innerHTML = liabilities.length
          ? liabilities.map(renderAccountRow).join('')
          : '<div class="accounts-empty">No active liability accounts.</div>';
      }

      if ($('acc-archived-list')) {
        $('acc-archived-list').innerHTML = archived.length
          ? archived.map(renderAccountRow).join('')
          : '<div class="accounts-empty">No archived accounts.</div>';
      }

      if (balancesData.ok) {
        var netWorth = Number(balancesData.net_worth) || 0;
        if ($('acc-net-worth')) $('acc-net-worth').textContent = fmtPKR(netWorth);
      }

      wireArchivedToggle();
    }).catch(function (err) {
      console.error('[accounts] load failed:', err);
      if ($('acc-assets-list')) $('acc-assets-list').innerHTML = '<div class="accounts-empty">Load failed: ' + escHtml(err.message) + '</div>';
    });
  }

  function wireArchivedToggle() {
    var header = $('acc-archived-header');
    var list = $('acc-archived-list');
    var toggle = $('acc-archived-toggle');

    if (!header || !list || !toggle) return;

    header.addEventListener('click', function () {
      var isHidden = list.style.display === 'none';
      list.style.display = isHidden ? 'grid' : 'none';
      toggle.textContent = isHidden ? 'v' : '>';
    });
  }

  function updateDayCounter() {
    var today = new Date();
    var startOfYear = new Date(today.getFullYear(), 0, 1);
    var dayOfYear = Math.ceil((today - startOfYear) / (1000 * 60 * 60 * 24));
    var cycleDay = dayOfYear % 90 || 90;
    var remaining = 90 - cycleDay + 1;

    if ($('dayNum')) $('dayNum').textContent = String(cycleDay);
    if ($('acc-day-count')) $('acc-day-count').textContent = String(remaining) + ' days left';
  }

  function boot() {
    console.log('[accounts] version:', VERSION);
    updateDayCounter();
    loadAccounts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
