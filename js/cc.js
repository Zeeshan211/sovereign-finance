/* ─── Sovereign Finance · CC Payoff Planner Page · v0.1.0 · Sub-1D-CC-PLAN Ship 3 ───
 * Wires:
 *   - GET /api/cc/payoff-plan → render summary + per-CC card with scenarios
 *   - Each scenario shows recommended paying account (richest that can cover)
 *   - "Pay this" button on each scenario → opens /add.html with prefilled amount + accounts
 *
 * Read-only page. No mutations from here. Payment execution happens via /add.html (existing flow)
 * which already has snap+audit guarantees.
 *
 * Backend contract (cc/[[path]].js v0.1.0):
 *   GET /api/cc/payoff-plan
 *     → {ok, plans:[{cc_id, cc_name, outstanding, credit_limit, available_credit,
 *                    utilization_pct, days_to_payment_due, scenarios:[
 *                      {id, label, amount, helps_with, fundable,
 *                       achievable_with_balances:[{account_id, account_name, balance, can_cover, gap}]}
 *                    ], paying_accounts_summary:{...}}]}
 */
(function () {
  'use strict';

  if (window._ccInited) return;
  window._ccInited = true;

  const VERSION = 'v0.1.0';
  const $ = id => document.getElementById(id);

  const fmtPKR = n => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-PK');
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }
  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function utilizationClass(pct) {
    if (pct == null) return '';
    if (pct >= 100) return 'negative';
    if (pct >= 90) return 'negative';
    if (pct >= 75) return 'liabilities';
    return 'accent';
  }

  function utilizationBarColor(pct) {
    const cls = utilizationClass(pct);
    if (cls === 'negative') return 'var(--danger,#ef4444)';
    if (cls === 'liabilities') return 'var(--warning,#f59e0b)';
    return 'var(--accent,#22c55e)';
  }

  function dueLabel(days) {
    if (days == null) return 'no due day set';
    if (days === 0) return 'due TODAY';
    if (days === 1) return 'due tomorrow';
    if (days <= 7) return `due in ${days} days · urgent`;
    return `due in ${days} days`;
  }

  function dueClass(days) {
    if (days == null) return '';
    if (days <= 1) return 'negative';
    if (days <= 7) return 'liabilities';
    return 'accent';
  }

  function scenarioIcon(id) {
    return id === 'min' ? '🛟'
         : id === 'to_30_pct' ? '🎯'
         : id === 'to_zero' ? '🆓'
         : '💰';
  }

  /* ─────── Renderers ─────── */
  function renderScenario(scenario, plan) {
    const recommended = scenario.achievable_with_balances.find(a => a.can_cover);
    const fundableBadge = scenario.fundable
      ? `<span class="dense-badge accent" style="font-size:10px;padding:2px 6px;margin-left:6px">fundable</span>`
      : `<span class="dense-badge negative" style="font-size:10px;padding:2px 6px;margin-left:6px">short</span>`;

    const recommendedSource = recommended
      ? `<div class="mini-row-sub" style="font-size:11px;margin-top:4px">
          → fund from <strong>${escHtml(recommended.account_name)}</strong> (Rs ${fmtPKR(recommended.balance).slice(3)} available)
         </div>`
      : `<div class="mini-row-sub negative" style="font-size:11px;margin-top:4px">
          ⚠ no single account covers this — gap of ${fmtPKR(scenario.achievable_with_balances[0]?.gap || 0)} on richest
         </div>`;

    // Build /add.html link with prefilled query params (transfer from richest to CC)
    const addUrl = recommended
      ? `/add.html?type=transfer&amount=${scenario.amount}&from=${encodeURIComponent(recommended.account_id)}&to=${encodeURIComponent(plan.cc_id)}&notes=${encodeURIComponent('CC paydown · ' + scenario.label)}`
      : null;

    return `
      <div class="mini-row" style="border-left:3px solid ${utilizationBarColor(plan.utilization_pct)};padding-left:10px">
        <div class="mini-row-left" style="flex:1">
          <div class="mini-row-name">${scenarioIcon(scenario.id)} ${escHtml(scenario.label)} ${fundableBadge}</div>
          <div class="mini-row-sub" style="margin-top:2px">${escHtml(scenario.helps_with)}</div>
          ${recommendedSource}
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount accent">${fmtPKR(scenario.amount)}</div>
          ${addUrl
            ? `<a href="${addUrl}" class="primary-btn" style="font-size:12px;padding:4px 10px;margin-top:4px;text-decoration:none;display:inline-block">Pay →</a>`
            : `<button class="ghost-btn" disabled style="font-size:12px;padding:4px 10px;margin-top:4px;opacity:0.4">Pay →</button>`
          }
        </div>
      </div>`;
  }

  function renderCCCard(plan) {
    const utilPct = plan.utilization_pct;
    const utilDisplay = utilPct != null ? `${utilPct}% utilized` : 'no credit limit set';
    const utilBarPct = utilPct != null ? Math.min(100, utilPct) : 0;
    const utilBarColor = utilizationBarColor(utilPct);

    const days = plan.days_to_payment_due;
    const dueBadge = `<span class="dense-badge ${dueClass(days)}" style="font-size:11px;padding:3px 8px;margin-left:8px">${escHtml(dueLabel(days))}</span>`;

    const scenariosHTML = plan.scenarios.map(s => renderScenario(s, plan)).join('');

    return `
      <section class="net-worth" style="margin-bottom:8px">
        <div class="nw-label">${escHtml(plan.cc_name)} ${dueBadge}</div>
        <div class="nw-value ${utilizationClass(utilPct)}" style="font-size:32px">
          ${fmtPKR(plan.outstanding).slice(3)}<span class="nw-currency">PKR outstanding</span>
        </div>
        <div style="background:rgba(255,255,255,0.08);border-radius:6px;height:8px;margin-top:10px;overflow:hidden">
          <div style="width:${utilBarPct}%;height:100%;background:${utilBarColor};transition:width 0.3s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-top:6px;opacity:0.7">
          <span>${escHtml(utilDisplay)}</span>
          <span>Rs ${fmtPKR(plan.available_credit || 0).slice(3)} available</span>
        </div>
      </section>

      <div class="section-header">
        <span class="section-label">Payment Scenarios</span>
      </div>
      <div>
        ${scenariosHTML}
      </div>

      <div class="section-header" style="margin-top:16px">
        <span class="section-label">Funding Sources Snapshot</span>
      </div>
      <div class="mini-row" style="opacity:0.85">
        <div class="mini-row-left" style="flex:1">
          <div class="mini-row-name">${plan.paying_accounts_summary.count} active funding accounts</div>
          <div class="mini-row-sub">richest: ${escHtml(plan.paying_accounts_summary.richest_account?.name || '—')}</div>
        </div>
        <div class="mini-row-right">
          <div class="mini-row-amount accent">${fmtPKR(plan.paying_accounts_summary.total_available)}</div>
          <div class="mini-row-sub" style="font-size:10px;margin-top:2px">total available</div>
        </div>
      </div>
    `;
  }

  /* ─────── Loader ─────── */
  async function loadAll() {
    console.log('[cc]', VERSION, 'loadAll start');
    try {
      const r = await fetch('/api/cc/payoff-plan', { cache: 'no-store' });
      const body = await r.json();
      console.log('[cc] /api/cc/payoff-plan', r.status, '→', body.count, 'plans');
      if (!body.ok) throw new Error(body.error || 'cc payload not ok');

      const plans = body.plans || [];
      if (plans.length === 0) {
        setText('cc-summary', 'no CC accounts');
        setHTML('cc-cards-container',
          `<div class="empty-state-inline" style="margin:20px;padding:40px;text-align:center">
            No credit card accounts found.<br>
            <a href="/accounts.html" class="primary-btn" style="margin-top:12px;display:inline-block;text-decoration:none">Add a CC</a>
          </div>`
        );
        return;
      }

      // Summary header
      const totalOutstanding = plans.reduce((s, p) => s + (p.outstanding || 0), 0);
      const urgent = plans.filter(p => p.days_to_payment_due != null && p.days_to_payment_due <= 7).length;
      setText('cc-summary',
        `${plans.length} CC · ${fmtPKR(totalOutstanding)} outstanding${urgent > 0 ? ` · ${urgent} urgent` : ''}`
      );

      // Render each CC plan
      setHTML('cc-cards-container', plans.map(renderCCCard).join('<hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:20px 0">'));
    } catch (e) {
      console.error('[cc] loadAll FAILED:', e);
      setText('cc-summary', 'load failed');
      setHTML('cc-cards-container',
        '<div class="empty-state-inline">Failed: ' + escHtml(e.message) + '</div>'
      );
    }
  }

  /* ─────── Init ─────── */
  function init() {
    console.log('[cc]', VERSION, 'init');
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
