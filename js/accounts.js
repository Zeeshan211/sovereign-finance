/* Sovereign Finance - Accounts Page v0.8.1 - Layer 2 contract restore */
(function () {
  'use strict';

  var VERSION = 'v0.8.1-layer-2';
  var allAccounts = [];
  var archivedOpen = false;

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

  function asNumber(value, fallback) {
    var num = Number(value);
    return Number.isFinite(num) ? num : (fallback == null ? 0 : fallback);
  }

  function fmtPKR(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return 'Rs —';
    return 'Rs ' + num.toLocaleString('en-PK', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (value !== null && value !== undefined && value !== '') return String(value);
    }
    return '';
  }

  function firstNumber() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      var num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  function normalizeAccountsPayload(payload) {
    var raw = payload && payload.accounts;
    if (Array.isArray(raw)) {
      return raw.map(function (row, index) {
        var out = row || {};
        if (!out.id) out.id = out.account_id || out.code || ('account_' + index);
        return out;
      });
    }

    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(function (id) {
        var row = raw[id] || {};
        if (!row.id) row.id = id;
        return row;
      });
    }

    return [];
  }

  function classifyAccount(acct) {
    var explicit = firstText(acct.category, acct.kind, acct.account_kind, acct.side).toLowerCase();
    var type = firstText(acct.type, acct.account_type, acct.subtype).toLowerCase();
    var id = firstText(acct.id).toLowerCase();
    var isCc = Boolean(acct.is_credit_card) || explicit === 'credit_card' || type.indexOf('credit') !== -1 || id.indexOf('cc') !== -1;

    if (explicit === 'asset' || explicit === 'liability') return explicit;
    if (isCc) return 'liability';
    if (type.indexOf('loan') !== -1 || type.indexOf('liability') !== -1 || type.indexOf('payable') !== -1) return 'liability';
    return 'asset';
  }

  function normalizeAccount(acct) {
    var normalized = Object.assign({}, acct || {});
    normalized.id = firstText(normalized.id, normalized.account_id, normalized.code);
    normalized.name = firstText(normalized.name, normalized.label, normalized.account_name, normalized.title, normalized.id, 'Unknown account');
    normalized.category = classifyAccount(normalized);
    normalized.status = firstText(normalized.status, normalized.state, 'active').toLowerCase();
    normalized.icon = firstText(normalized.icon, normalized.emoji, normalized.symbol, normalized.category === 'liability' ? '💳' : '💰');
    normalized.balance = firstNumber(
      normalized.balance,
      normalized.current_balance,
      normalized.amount,
      normalized.available_balance,
      normalized.statement_balance,
      normalized.credit_used
    );
    normalized.balance = normalized.balance === null ? 0 : normalized.balance;
    normalized.creditLimit = firstNumber(normalized.credit_limit, normalized.limit, normalized.card_limit);
    normalized.utilizationPct = firstNumber(normalized.utilization_pct, normalized.utilization, normalized.credit_utilization_pct);
    normalized.daysToDue = firstNumber(normalized.days_to_payment_due, normalized.days_to_due, normalized.payment_due_in_days);
    return normalized;
  }

  function buildMetaTags(acct) {
    var tags = [];
    tags.push('<span class="meta">' + escHtml(acct.category) + '</span>');

    if (acct.status && acct.status !== 'active') {
      tags.push('<span class="meta warn">' + escHtml(acct.status) + '</span>');
    }

    if (acct.creditLimit !== null) {
      tags.push('<span class="meta accent">limit ' + escHtml(fmtPKR(acct.creditLimit)) + '</span>');
    }

    if (acct.utilizationPct !== null) {
      tags.push('<span class="meta ' + (acct.utilizationPct >= 80 ? 'danger' : 'accent') + '">' + escHtml(acct.utilizationPct.toFixed(1) + '% util') + '</span>');
    }

    if (acct.daysToDue !== null) {
      tags.push('<span class="meta ' + (acct.daysToDue <= 3 ? 'warn' : '') + '">' + escHtml(acct.daysToDue + 'd due') + '</span>');
    }

    return tags;
  }

  function renderAccountRow(acct) {
    var tags = buildMetaTags(acct);
    var amountClass = acct.balance < 0 ? 'danger' : '';

    return [
      '<div class="mini-row">',
      '  <div class="mini-row-left">',
      '    <div class="mini-row-icon">' + escHtml(acct.icon) + '</div>',
      '    <div>',
      '      <div class="mini-row-name">' + escHtml(acct.name) + '</div>',
      tags.length ? '      <div class="mini-row-sub">' + tags.join('') + '</div>' : '',
      '    </div>',
      '  </div>',
      '  <div class="mini-row-right">',
      '    <div class="mini-row-amount ' + amountClass + '">' + escHtml(fmtPKR(acct.balance)) + '</div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function setText(id, value) {
    var node = $(id);
    if (node) node.textContent = value;
  }

  function renderList(id, items, emptyText) {
    var node = $(id);
    if (!node) return;
    node.innerHTML = items.length
      ? items.map(renderAccountRow).join('')
      : '<div class="accounts-empty">' + escHtml(emptyText) + '</div>';
  }

  function renderSummary(assets, liabilities, archived, balancesData) {
    var assetsTotal = assets.reduce(function (sum, acct) { return sum + asNumber(acct.balance, 0); }, 0);
    var liabilitiesTotal = liabilities.reduce(function (sum, acct) { return sum + asNumber(acct.balance, 0); }, 0);

    setText('acc-assets-count', String(assets.length));
    setText('acc-assets-total', fmtPKR(assetsTotal));
    setText('acc-liabilities-count', String(liabilities.length));
    setText('acc-liabilities-total', fmtPKR(liabilitiesTotal));
    setText('acc-archived-count', String(archived.length));

    if (balancesData && balancesData.ok) {
      setText('acc-net-worth', fmtPKR(firstNumber(balancesData.net_worth, balancesData.netWorth, 0)));
    } else {
      setText('acc-net-worth', fmtPKR(assetsTotal - Math.abs(liabilitiesTotal)));
    }
  }

  function syncShellKpis() {
    var pairs = [
      ['acc-net-worth', 'acc-net-worth-kpi'],
      ['acc-assets-count', 'acc-assets-count-kpi'],
      ['acc-assets-total', 'acc-assets-total-kpi'],
      ['acc-liabilities-count', 'acc-liabilities-count-kpi'],
      ['acc-liabilities-total', 'acc-liabilities-total-kpi'],
      ['acc-archived-count', 'acc-archived-count-kpi']
    ];

    pairs.forEach(function (pair) {
      var from = $(pair[0]);
      var to = $(pair[1]);
      if (from && to) to.textContent = from.textContent || '—';
    });
  }

  function wireArchivedToggle() {
    var header = $('acc-archived-header');
    var list = $('acc-archived-list');
    var toggle = $('acc-archived-toggle');
    if (!header || !list || !toggle || header.__wired) return;

    header.__wired = true;
    header.addEventListener('click', function () {
      archivedOpen = !archivedOpen;
      list.style.display = archivedOpen ? 'grid' : 'none';
      toggle.textContent = archivedOpen ? 'v' : '>';
    });
  }

  function updateDayCounter() {
    var today = new Date();
    var startOfYear = new Date(today.getFullYear(), 0, 1);
    var dayOfYear = Math.ceil((today - startOfYear) / 86400000);
    var cycleDay = dayOfYear % 90 || 90;
    var remaining = 90 - cycleDay + 1;

    setText('dayNum', String(cycleDay));
    setText('acc-day-count', String(remaining) + ' days left');
  }

  function loadAccounts() {
    return Promise.all([
      fetch('/api/accounts?debug=1', { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }),
      fetch('/api/balances?debug=1', { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var accountsData = results[0];
      var balancesData = results[1];

      if (!accountsData || accountsData.ok === false) {
        throw new Error((accountsData && accountsData.error) || 'Accounts load failed');
      }

      allAccounts = normalizeAccountsPayload(accountsData).map(normalizeAccount);

      var active = allAccounts.filter(function (a) { return a.status !== 'archived' && a.status !== 'deleted'; });
      var archived = allAccounts.filter(function (a) { return a.status === 'archived'; });
      var assets = active.filter(function (a) { return a.category === 'asset'; });
      var liabilities = active.filter(function (a) { return a.category === 'liability'; });

      renderList('acc-assets-list', assets, 'No active asset accounts.');
      renderList('acc-liabilities-list', liabilities, 'No active liability accounts.');
      renderList('acc-archived-list', archived, 'No archived accounts.');
      renderSummary(assets, liabilities, archived, balancesData);
      syncShellKpis();
      wireArchivedToggle();

      console.log('[accounts] version:', VERSION, 'active:', active.length, 'archived:', archived.length);
    }).catch(function (err) {
      console.error('[accounts] load failed:', err);
      renderList('acc-assets-list', [], 'Load failed: ' + err.message);
      renderList('acc-liabilities-list', [], 'Load failed: ' + err.message);
      renderList('acc-archived-list', [], 'Load failed: ' + err.message);
      setText('acc-net-worth', 'Rs —');
      setText('acc-assets-count', '0');
      setText('acc-assets-total', 'Rs —');
      setText('acc-liabilities-count', '0');
      setText('acc-liabilities-total', 'Rs —');
      setText('acc-archived-count', '0');
      syncShellKpis();
    });
  }

  function boot() {
    updateDayCounter();
    wireArchivedToggle();
    loadAccounts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
