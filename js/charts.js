/* Sovereign Finance — Charts v0.1.1 — Ship 2c
 * Wires 6 charts to existing APIs (transactions, balances, merchants, snapshots).
 * Defensive: handles empty data, missing Chart.js, missing snapshots.
 * v0.1.1: capped boot() retry at 10 attempts each for Chart.js + store; surfaces error in badge instead of bashing forever.
 * No template literals (locked rule).
 */
(function () {
  var VERSION = 'v0.1.1';
  console.log('[charts] script loaded ' + VERSION);

  var CC_LIMIT = 100000; // TODO: replace with real Alfalah CC limit; /api/balances does not expose this yet
  var MAX_CHART_RETRIES = 10; // 10 × 500ms = 5s
  var MAX_STORE_RETRIES = 10; // 10 × 200ms = 2s

  var PALETTE = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#ec4899', '#84cc16', '#f97316', '#14b8a6'];
  var INCOME_COLOR = '#10b981';
  var EXPENSE_COLOR = '#ef4444';
  var ACCENT_COLOR = '#06b6d4';
  var MUTED_COLOR  = '#1f2937';
  var TEXT_COLOR   = '#e5e7eb';
  var ERROR_COLOR  = '#ef4444';

  function fmtPKR(n) {
    if (typeof window.fmt === 'function') {
      try { return window.fmt(n); } catch (e) {}
    }
    if (n == null || isNaN(n)) return '—';
    return 'Rs ' + Math.round(Number(n)).toLocaleString('en-PK');
  }

  function ymd(d) {
    if (!d) return '';
    if (typeof d === 'string') return d.slice(0, 10);
    try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  function ymKey(d) { return ymd(d).slice(0, 7); }

  function setSummary(text, isError) {
    var summary = document.getElementById('charts-summary');
    if (!summary) return;
    summary.textContent = text;
    summary.style.color = isError ? ERROR_COLOR : '';
  }

  function emptyState(canvasId, msg) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var parent = canvas.parentElement;
    parent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:' +
      TEXT_COLOR + ';opacity:0.6;font-size:13px;text-align:center;padding:8px;">' + msg + '</div>';
  }

  function ensureChart(canvasId, configFn, emptyMsg) {
    if (typeof Chart === 'undefined') {
      emptyState(canvasId, 'Chart.js failed to load');
      return null;
    }
    var canvas = document.getElementById(canvasId);
    if (!canvas) {
      console.warn('[charts] canvas not found: ' + canvasId);
      return null;
    }
    try {
      var cfg = configFn();
      if (!cfg) {
        emptyState(canvasId, emptyMsg || 'No data');
        return null;
      }
      return new Chart(canvas, cfg);
    } catch (e) {
      console.warn('[charts] render failed for ' + canvasId + ':', e.message);
      emptyState(canvasId, 'Render error — see console');
      return null;
    }
  }

  function baseOpts() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: TEXT_COLOR, font: { size: 11 } } },
        tooltip: { backgroundColor: '#0f172a', titleColor: TEXT_COLOR, bodyColor: TEXT_COLOR, borderColor: ACCENT_COLOR, borderWidth: 1 }
      },
      scales: {
        x: { ticks: { color: TEXT_COLOR, font: { size: 10 } }, grid: { color: MUTED_COLOR, display: false } },
        y: { ticks: { color: TEXT_COLOR, font: { size: 10 }, callback: function (v) { return fmtPKR(v); } }, grid: { color: MUTED_COLOR } }
      }
    };
  }

  function renderSpendingByCategory(txns, cats) {
    return ensureChart('chart-spending-by-category', function () {
      var thisMonth = new Date().toISOString().slice(0, 7);
      var byCat = {};
      txns.forEach(function (t) {
        if (t.type !== 'expense') return;
        if (ymKey(t.date) !== thisMonth) return;
        var cid = t.category_id || 'other';
        byCat[cid] = (byCat[cid] || 0) + Math.abs(Number(t.amount) || 0);
      });
      var entries = Object.keys(byCat).map(function (cid) {
        var cat = (cats || []).find(function (c) { return c.id === cid; });
        return { name: cat ? cat.name : cid, value: byCat[cid] };
      });
      entries.sort(function (a, b) { return b.value - a.value; });
      if (entries.length === 0) return null;
      return {
        type: 'doughnut',
        data: {
          labels: entries.map(function (e) { return e.name; }),
          datasets: [{
            data: entries.map(function (e) { return e.value; }),
            backgroundColor: entries.map(function (_, i) { return PALETTE[i % PALETTE.length]; }),
            borderColor: '#050816',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { color: TEXT_COLOR, font: { size: 11 }, boxWidth: 12 } },
            tooltip: { callbacks: { label: function (ctx) { return ctx.label + ': ' + fmtPKR(ctx.raw); } } }
          }
        }
      };
    }, 'No expenses this month');
  }

  function renderIncomeVsExpense(txns) {
    return ensureChart('chart-income-vs-expense', function () {
      var months = [];
      var now = new Date();
      for (var i = 5; i >= 0; i--) {
        var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(d.toISOString().slice(0, 7));
      }
      var income = months.map(function () { return 0; });
      var expense = months.map(function () { return 0; });
      txns.forEach(function (t) {
        var idx = months.indexOf(ymKey(t.date));
        if (idx === -1) return;
        var amt = Math.abs(Number(t.amount) || 0);
        if (t.type === 'income') income[idx] += amt;
        else if (t.type === 'expense') expense[idx] += amt;
      });
      var allZero = income.every(function (v) { return v === 0; }) && expense.every(function (v) { return v === 0; });
      if (allZero) return null;
      return {
        type: 'bar',
        data: {
          labels: months.map(function (m) { return m.slice(5) + '/' + m.slice(2, 4); }),
          datasets: [
            { label: 'Income', data: income, backgroundColor: INCOME_COLOR },
            { label: 'Expense', data: expense, backgroundColor: EXPENSE_COLOR }
          ]
        },
        options: baseOpts()
      };
    }, 'No data in last 6 months');
  }

  function renderCCUtil(balances) {
    return ensureChart('chart-cc-utilization', function () {
      var outstanding = Math.abs(Number(balances && balances.cc) || 0);
      if (outstanding === 0) return null;
      var available = Math.max(0, CC_LIMIT - outstanding);
      var pct = Math.min(100, (outstanding / CC_LIMIT) * 100);
      var fill = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : ACCENT_COLOR;
      return {
        type: 'doughnut',
        data: {
          labels: ['Outstanding', 'Available'],
          datasets: [{
            data: [outstanding, available],
            backgroundColor: [fill, MUTED_COLOR],
            borderColor: '#050816',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { position: 'bottom', labels: { color: TEXT_COLOR, font: { size: 11 } } },
            tooltip: { callbacks: { label: function (ctx) { return ctx.label + ': ' + fmtPKR(ctx.raw); } } },
            title: { display: true, text: pct.toFixed(1) + '% utilized · limit ' + fmtPKR(CC_LIMIT) + ' (placeholder)', color: TEXT_COLOR, font: { size: 12 } }
          }
        }
      };
    }, 'No CC outstanding');
  }

  function renderTopMerchants(merchants) {
    return ensureChart('chart-top-merchants', function () {
      if (!merchants || merchants.length === 0) return null;
      var sorted = merchants.slice().sort(function (a, b) {
        return (b.learned_count || 0) - (a.learned_count || 0);
      }).slice(0, 10);
      var allZero = sorted.every(function (m) { return (m.learned_count || 0) === 0; });
      if (allZero) return null;
      return {
        type: 'bar',
        data: {
          labels: sorted.map(function (m) { return m.name; }),
          datasets: [{
            label: 'Learned uses',
            data: sorted.map(function (m) { return m.learned_count || 0; }),
            backgroundColor: ACCENT_COLOR
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: function (ctx) { return ctx.raw + ' uses'; } } }
          },
          scales: {
            x: { ticks: { color: TEXT_COLOR, font: { size: 10 }, precision: 0 }, grid: { color: MUTED_COLOR } },
            y: { ticks: { color: TEXT_COLOR, font: { size: 10 } }, grid: { display: false } }
          }
        }
      };
    }, 'No merchants yet — add via /merchants.html');
  }

  function renderNetWorthTrajectory(snapshots) {
    return ensureChart('chart-net-worth-trajectory', function () {
      if (!snapshots || snapshots.length < 2) return null;
      var sorted = snapshots.slice().sort(function (a, b) {
        var aT = a.created_at || a.timestamp || '';
        var bT = b.created_at || b.timestamp || '';
        return aT < bT ? -1 : aT > bT ? 1 : 0;
      });
      var labels = sorted.map(function (s) { return ymd(s.created_at || s.timestamp); });
      var data = sorted.map(function (s) {
        if (s.net_worth != null) return Number(s.net_worth);
        if (s.netWorth != null) return Number(s.netWorth);
        var assets = Number(s.total_assets || 0);
        var liab   = Number(s.total_liabilities || 0);
        return assets - liab;
      });
      var allZero = data.every(function (v) { return v === 0 || isNaN(v); });
      if (allZero) return null;
      return {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Net Worth',
            data: data,
            borderColor: ACCENT_COLOR,
            backgroundColor: 'rgba(6, 182, 212, 0.15)',
            fill: true,
            tension: 0.25,
            pointRadius: 3,
            pointBackgroundColor: ACCENT_COLOR
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: function (ctx) { return fmtPKR(ctx.raw); } } }
          },
          scales: {
            x: { ticks: { color: TEXT_COLOR, font: { size: 10 } }, grid: { color: MUTED_COLOR, display: false } },
            y: { ticks: { color: TEXT_COLOR, font: { size: 10 }, callback: function (v) { return fmtPKR(v); } }, grid: { color: MUTED_COLOR } }
          }
        }
      };
    }, 'Need at least 2 snapshots to plot trajectory');
  }

  function renderDailySpend(txns) {
    return ensureChart('chart-daily-spend-heatmap', function () {
      var days = [];
      var now = new Date();
      for (var i = 29; i >= 0; i--) {
        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
      }
      var totals = days.map(function () { return 0; });
      txns.forEach(function (t) {
        if (t.type !== 'expense') return;
        var idx = days.indexOf(ymd(t.date));
        if (idx === -1) return;
        totals[idx] += Math.abs(Number(t.amount) || 0);
      });
      if (totals.every(function (v) { return v === 0; })) return null;
      var max = Math.max.apply(null, totals);
      var colors = totals.map(function (v) {
        if (v === 0) return MUTED_COLOR;
        var alpha = 0.3 + (v / max) * 0.7;
        return 'rgba(239, 68, 68, ' + alpha.toFixed(2) + ')';
      });
      return {
        type: 'bar',
        data: {
          labels: days.map(function (d) { return d.slice(5); }),
          datasets: [{ label: 'Spend', data: totals, backgroundColor: colors }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: function (ctx) { return fmtPKR(ctx.raw); } } }
          },
          scales: {
            x: { ticks: { color: TEXT_COLOR, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }, grid: { color: MUTED_COLOR, display: false } },
            y: { ticks: { color: TEXT_COLOR, font: { size: 10 }, callback: function (v) { return fmtPKR(v); } }, grid: { color: MUTED_COLOR } }
          }
        }
      };
    }, 'No spend in last 30 days');
  }

  async function boot(chartAttempt, storeAttempt) {
    chartAttempt = chartAttempt || 0;
    storeAttempt = storeAttempt || 0;

    if (chartAttempt === 0 && storeAttempt === 0) {
      setSummary(VERSION + ' · loading…', false);
    }

    if (typeof Chart === 'undefined') {
      if (chartAttempt >= MAX_CHART_RETRIES) {
        var msg = 'Chart.js failed to load after ' + MAX_CHART_RETRIES + ' retries (5s)';
        console.warn('[charts] ' + msg + ' — giving up');
        setSummary(VERSION + ' · ' + msg, true);
        return;
      }
      console.warn('[charts] Chart.js not available, retry ' + (chartAttempt + 1) + '/' + MAX_CHART_RETRIES);
      setTimeout(function () { boot(chartAttempt + 1, storeAttempt); }, 500);
      return;
    }

    if (!window.store) {
      if (storeAttempt >= MAX_STORE_RETRIES) {
        var msg2 = 'window.store not ready after ' + MAX_STORE_RETRIES + ' retries (2s)';
        console.warn('[charts] ' + msg2 + ' — giving up');
        setSummary(VERSION + ' · ' + msg2, true);
        return;
      }
      console.warn('[charts] window.store not ready, retry ' + (storeAttempt + 1) + '/' + MAX_STORE_RETRIES);
      setTimeout(function () { boot(chartAttempt, storeAttempt + 1); }, 200);
      return;
    }

    try {
      var results = await Promise.all([
        store.refreshTransactions(),
        store.refreshBalances(),
        store.refreshCategories(),
        fetch('/api/merchants', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; }),
        fetch('/api/snapshots', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; })
      ]);

      var txns      = results[0] || [];
      var balances  = store.totals || {};
      var cats      = store.cachedCategories || [];
      var merchants = (results[3] && results[3].merchants) || [];
      var snapshots = (results[4] && (results[4].snapshots || results[4].rows)) || [];

      console.log('[charts] data loaded — txns:', txns.length, '· merchants:', merchants.length, '· snapshots:', snapshots.length, '· cc:', balances.cc);

      renderSpendingByCategory(txns, cats);
      renderIncomeVsExpense(txns);
      renderCCUtil(balances);
      renderTopMerchants(merchants);
      renderNetWorthTrajectory(snapshots);
      renderDailySpend(txns);

      setSummary(VERSION + ' · ' + txns.length + ' txns · ' + snapshots.length + ' snapshots', false);
    } catch (e) {
      console.warn('[charts] boot failed:', e.message);
      setSummary(VERSION + ' · error: ' + e.message, true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { boot(0, 0); }, 100); });
  } else {
    setTimeout(function () { boot(0, 0); }, 100);
  }
})();
