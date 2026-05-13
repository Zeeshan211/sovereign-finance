/* js/forecast.js
 * Sovereign Finance · Forecast UI
 * v1.0.0-forecast-contract-renderer
 *
 * Rules:
 * - /api/forecast owns forecast truth.
 * - UI does not recalculate runway, crisis, bills, debts, salary, or CC.
 * - UI renders backend proof, source status, crisis attribution, and projections.
 * - Designed to be loaded by forecast.html after backend v0.9.0-source-contract-hardening.
 */

(function () {
  'use strict';

  const VERSION = 'v1.0.0-forecast-contract-renderer';
  const API_FORECAST = '/api/forecast';

  const state = {
    payload: null,
    loading: false,
    mode: 'normal',
    crisisFloor: 5000,
    days: 90,
    months: 6
  };

  const $ = id => document.getElementById(id);

  function firstEl(ids) {
    for (const id of ids) {
      const el = $(id);
      if (el) return el;
    }
    return null;
  }

  function setText(ids, value) {
    const el = Array.isArray(ids) ? firstEl(ids) : $(ids);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(ids, value) {
    const el = Array.isArray(ids) ? firstEl(ids) : $(ids);
    if (el) el.innerHTML = value == null ? '' : String(value);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function money(value) {
    const n = num(value, 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function pct(value) {
    return num(value, 0).toLocaleString('en-PK', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }) + '%';
  }

  function shortDate(value) {
    if (!value) return '—';
    return String(value).slice(0, 10);
  }

  function tone(status) {
    const s = String(status || '').toLowerCase();

    if (['ready', 'safe', 'ok', 'pass', 'received', 'api'].includes(s)) return 'good';
    if (['watch', 'degraded', 'warn', 'warning', 'estimated_outstanding_5pct'].includes(s)) return 'warn';
    if (['crisis', 'danger', 'source_error', 'fail', 'failed', 'error'].includes(s)) return 'danger';

    return '';
  }

  function sfTone(status) {
    const t = tone(status);
    if (t === 'good') return 'positive';
    if (t === 'warn') return 'warning';
    if (t === 'danger') return 'danger';
    return 'info';
  }

  function tag(text, tagTone) {
    return `<span class="forecast-tag ${tagTone || ''}">${esc(text)}</span>`;
  }

  function row(title, subtitle, value, rowTone) {
    return `
      <div class="forecast-row">
        <div>
          <div class="forecast-row-title">${esc(title)}</div>
          ${subtitle ? `<div class="forecast-row-sub">${esc(subtitle)}</div>` : ''}
        </div>
        <div class="forecast-row-value ${rowTone ? `sf-tone-${esc(rowTone)}` : ''}">
          ${value == null ? '—' : value}
        </div>
      </div>
    `;
  }

  function empty(message) {
    return `<div class="forecast-empty">${esc(message)}</div>`;
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json'
      }
    });

    const text = await response.text();

    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
    }

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    }

    return payload;
  }

  function forecastUrl() {
    const url = new URL(API_FORECAST, window.location.origin);
    url.searchParams.set('mode', state.mode);
    url.searchParams.set('crisis_floor', String(state.crisisFloor));
    url.searchParams.set('days', String(state.days));
    url.searchParams.set('months', String(state.months));
    return url.pathname + url.search;
  }

  function payload() {
    return state.payload || {};
  }

  function insights() {
    return payload().insights || {};
  }

  function compatibility() {
    return payload().compatibility || {};
  }

  function forecast() {
    return payload().forecast || {};
  }

  function currentPosition() {
    return payload().current_position || {};
  }

  function salary() {
    return payload().salary || {};
  }

  function bills() {
    return Array.isArray(payload().bills) ? payload().bills : [];
  }

  function debts() {
    return payload().debts || { payable: [], receivable: [] };
  }

  function creditCard() {
    return payload().credit_card || {};
  }

  function sourcePolicy() {
    return payload().source_policy || {};
  }

  function crisisAnalysis() {
    return payload().crisis_analysis || {};
  }

  function dailyProjection() {
    return Array.isArray(payload().daily_projection) ? payload().daily_projection : [];
  }

  function monthlyProjection() {
    return Array.isArray(payload().monthly_projection) ? payload().monthly_projection : [];
  }

  function renderHero() {
    const p = payload();
    const i = insights();
    const policy = sourcePolicy();

    const status = p.status || i.status || 'unknown';
    const firstBreach = i.first_crisis_breach_date || 'none';
    const lowestDate = i.lowest_liquid_date || '—';
    const lowestAmount = i.lowest_liquid_amount;

    setText(['forecastHeroStatus', 'forecastStatus', 'forecast_state'], String(status).toUpperCase());
    setText(
      ['forecastHeroCopy', 'forecastSubtitle'],
      `First breach: ${firstBreach}. Lowest liquid: ${money(lowestAmount)} on ${lowestDate}. Source policy: ${policy.status || 'unknown'}.`
    );

    setText(['forecastVersionPill'], p.version || VERSION);
    setText(['forecastModePill'], `mode ${p.forecast_meta?.mode || state.mode}`);
    setText(['forecastSourcePill'], `sources ${policy.status || 'unknown'}`);
  }

  function renderMetrics() {
    const i = insights();
    const s = salary();
    const cc = creditCard();
    const comp = compatibility();

    setText(['metricNextSalary', 'nextSalary'], money(s.forecast_eligible_monthly));
    setText(['metricGuaranteedSalary', 'guaranteedSalary'], money(s.guaranteed_monthly));
    setText(['metricVariableSalary', 'variableSalary'], money(s.variable_monthly));
    setText(['metricLowestLiquid', 'lowestLiquid'], money(i.lowest_liquid_amount));
    setText(['metricLowestDate', 'lowestDate'], shortDate(i.lowest_liquid_date));
    setText(['metricFirstBreach', 'firstBreach'], i.first_crisis_breach_date || 'None');
    setText(['metricDebtFree', 'debtFree'], i.debt_free_date || '—');
    setText(['metricCashNeeded', 'cashNeeded'], money(i.required_cash_to_avoid_crisis));
    setText(['metricCcMinimum'], money(cc.minimum_due));
    setText(['metricCcSource'], cc.minimum_due_source || 'unknown');

    const debtFree = comp.debt_free_forecast || {};
    setText(['metricDebtRemaining'], money(debtFree.total_debt_remaining));
  }

  function renderCrisisAnalysis() {
    const analysis = crisisAnalysis();
    const first = analysis.first_breach;
    const lowest = analysis.lowest;

    const html = `
      ${row('Forecast status', 'Backend runway status', String(payload().status || insights().status || 'unknown').toUpperCase(), sfTone(payload().status || insights().status))}
      ${row('Crisis floor', 'Configured floor', money(analysis.crisis_floor ?? payload().forecast_meta?.crisis_floor), 'info')}
      ${row('Cash needed', 'Required cash to avoid crisis floor breach', money(analysis.required_cash_to_avoid_crisis), analysis.required_cash_to_avoid_crisis > 0 ? 'danger' : 'positive')}
      ${first ? renderDayProof('First breach', first) : row('First breach', 'No breach in horizon', 'None', 'positive')}
      ${lowest ? renderDayProof('Lowest liquid day', lowest) : row('Lowest liquid day', 'No projection row returned', '—', 'warning')}
      ${renderTopDrivers(analysis.top_drivers || [])}
    `;

    setHTML(['crisisAnalysisPanel', 'crisisPanel'], html);
  }

  function renderDayProof(title, day) {
    const events = Array.isArray(day.events) ? day.events : [];

    return `
      <div class="forecast-proof-card">
        <div class="forecast-proof-title">${esc(title)} · ${esc(day.date || '—')}</div>
        <div class="forecast-proof-grid">
          ${row('Opening', 'Start of day liquid', money(day.opening_liquid), 'info')}
          ${row('Inflows', 'Required inflows', money(day.inflows), 'positive')}
          ${row('Optional inflows', 'Receivables upside', money(day.optional_inflows), 'info')}
          ${row('Outflows', 'Required outflows', money(day.outflows), 'danger')}
          ${row('Closing', 'End of day liquid', money(day.closing_liquid), day.closing_liquid < day.crisis_floor ? 'danger' : 'positive')}
          ${row('Gap to floor', 'Closing minus crisis floor', money(day.gap_to_crisis_floor), day.gap_to_crisis_floor < 0 ? 'danger' : 'positive')}
        </div>
        <div class="forecast-events">
          ${events.length ? events.map(renderEvent).join('') : empty('No events on this day.')}
        </div>
      </div>
    `;
  }

  function renderTopDrivers(drivers) {
    if (!drivers.length) return empty('No outflow drivers returned.');

    return `
      <div class="forecast-proof-card">
        <div class="forecast-proof-title">Top outflow drivers</div>
        ${drivers.map(driver => row(driver.type, 'Required outflow category', money(driver.amount), 'danger')).join('')}
      </div>
    `;
  }

  function renderEvent(event) {
    const direction = String(event.direction || '');
    const eventTone = direction.includes('outflow') ? 'danger' : direction.includes('optional') ? 'warn' : 'good';

    return `
      <div class="forecast-event">
        <div>
          <div class="forecast-event-title">${esc(event.label || event.type || 'event')}</div>
          <div class="forecast-event-sub">${esc(event.date || '')} · ${esc(event.source || '')} · ${esc(event.direction || '')}</div>
        </div>
        <div class="forecast-event-amount ${eventTone}">${money(event.amount)}</div>
      </div>
    `;
  }

  function renderWaterfall() {
    const pos = currentPosition();
    const f = forecast();
    const obligations = payload().obligations_this_month || {};
    const s = salary();

    const html = `
      ${row('Liquid now', 'From canonical balance source', money(pos.liquid_now), 'info')}
      ${row('Next salary', 'forecast_eligible_monthly', money(s.forecast_eligible_monthly), 'positive')}
      ${row('Bills remaining', 'From /api/bills current_cycle.remaining', money(obligations.bills_remaining), obligations.bills_remaining > 0 ? 'warning' : 'positive')}
      ${row('CC minimum', obligations.cc_minimum_due_source || 'minimum source unknown', money(obligations.cc_minimum_due), obligations.cc_minimum_due > 0 ? 'warning' : 'positive')}
      ${row('Debt payable remaining', 'Debt pressure', money(obligations.debt_payable_remaining), obligations.debt_payable_remaining > 0 ? 'danger' : 'positive')}
      ${row('Receivable upside', 'Optional inflow only', money(obligations.debt_receivable_remaining), 'info')}
      ${row('After required obligations', 'Liquid + salary - bills - CC minimum', money(f.projected_cash_after_required_obligations), f.projected_cash_after_required_obligations < 0 ? 'danger' : 'positive')}
      ${row('After debt pressure', 'Required forecast after debt pressure', money(f.projected_cash_after_debt_pressure), f.projected_cash_after_debt_pressure < 0 ? 'danger' : 'positive')}
      ${row('If receivables collected', 'Optional upside included', money(f.projected_cash_if_receivables_collected), 'info')}
    `;

    setHTML(['waterfallPanel', 'forecastWaterfall'], html);
  }

  function renderTimeline() {
    const rows = dailyProjection().slice(0, 45);

    if (!rows.length) {
      setHTML(['timelinePanel', 'dailyTimeline'], empty('No daily projection returned.'));
      return;
    }

    const html = rows.map(day => {
      const dayTone = tone(day.status);
      const events = Array.isArray(day.events) ? day.events : [];

      return `
        <article class="forecast-day-card ${dayTone}">
          <div class="forecast-day-head">
            <div>
              <div class="forecast-day-title">${esc(day.date)}</div>
              <div class="forecast-day-sub">${events.length} event${events.length === 1 ? '' : 's'} · ${esc(day.status || 'unknown')}</div>
            </div>
            <div class="forecast-day-amount">${money(day.closing_liquid)}</div>
          </div>
          <div class="forecast-day-bar">
            <span style="width:${barWidth(day.closing_liquid, day.crisis_floor)}%"></span>
          </div>
          <div class="forecast-tags">
            ${tag(`floor ${money(day.crisis_floor)}`, '')}
            ${tag(`gap ${money(day.gap_to_crisis_floor)}`, day.gap_to_crisis_floor < 0 ? 'danger' : 'good')}
            ${events.slice(0, 3).map(event => tag(event.type || 'event', event.direction === 'outflow' ? 'danger' : 'good')).join('')}
          </div>
        </article>
      `;
    }).join('');

    setHTML(['timelinePanel', 'dailyTimeline'], html);
  }

  function barWidth(closing, floor) {
    const c = num(closing, 0);
    const f = Math.max(1, num(floor, 5000));
    return Math.max(4, Math.min(100, (c / (f * 4)) * 100));
  }

  function renderMonthly() {
    const rows = monthlyProjection();

    if (!rows.length) {
      setHTML(['monthlyPanel', 'monthlyProjection'], empty('No monthly projection returned.'));
      return;
    }

    const html = rows.map(month => `
      <article class="forecast-month-card">
        <div class="forecast-month-head">
          <div>
            <div class="forecast-month-title">${esc(month.label || month.month)}</div>
            <div class="forecast-month-sub">${esc(month.month)} · ${esc(month.mode || 'projection')}</div>
          </div>
          <div class="forecast-month-amount">${money(month.closing_liquid)}</div>
        </div>
        <div class="forecast-month-grid">
          ${row('Opening', 'Starting liquid', money(month.opening_liquid), 'info')}
          ${row('Salary', 'Monthly inflow', money(month.salary), 'positive')}
          ${row('Bills', 'Monthly bill pressure', money(month.bills), month.bills > 0 ? 'warning' : 'positive')}
          ${row('CC minimum', 'Credit card pressure', money(month.cc_minimum), month.cc_minimum > 0 ? 'warning' : 'positive')}
          ${row('Debt payment', 'Applied from surplus above floor', money(month.debt_payment_applied_from_surplus), month.debt_payment_applied_from_surplus > 0 ? 'danger' : 'info')}
          ${row('Debt remaining', 'After applied payment', money(month.debt_remaining), month.debt_remaining > 0 ? 'warning' : 'positive')}
        </div>
      </article>
    `).join('');

    setHTML(['monthlyPanel', 'monthlyProjection'], html);
  }

  function renderPosition() {
    const pos = currentPosition();
    const accounts = Array.isArray(pos.accounts) ? pos.accounts : [];

    const accountHtml = accounts.length
      ? accounts.map(account => row(account.name || account.id, `${account.id} · ${account.type || account.kind || 'account'}`, money(account.balance), account.balance < 0 ? 'danger' : 'info')).join('')
      : empty('No accounts returned.');

    setHTML(['positionPanel', 'currentPositionPanel'], `
      ${row('Liquid now', 'Canonical balance source', money(pos.liquid_now), pos.liquid_now < 0 ? 'danger' : 'positive')}
      ${row('Net worth', 'From balance source', money(pos.net_worth), pos.net_worth < 0 ? 'danger' : 'positive')}
      ${row('True burden', 'Debt / liability pressure', money(pos.true_burden), 'warning')}
      ${row('CC outstanding', 'Credit card liability', money(pos.cc_outstanding), pos.cc_outstanding > 0 ? 'danger' : 'positive')}
      ${row('Payable debt', 'Debt owed', money(pos.payable_debt_remaining), pos.payable_debt_remaining > 0 ? 'danger' : 'positive')}
      ${row('Receivables', 'Money owed to you', money(pos.total_receivables), 'info')}
      <div class="forecast-section-mini-title">Accounts</div>
      ${accountHtml}
    `);
  }

  function renderSalaryBridge() {
    const s = salary();

    setHTML(['salaryBridgePanel', 'forecastSalaryPanel'], `
      ${row('Forecast eligible', 'Amount used by Forecast', money(s.forecast_eligible_monthly), 'positive')}
      ${row('Guaranteed salary', 'Guaranteed monthly', money(s.guaranteed_monthly), 'positive')}
      ${row('Variable salary', `confirmed: ${String(s.variable_confirmed)}`, money(s.variable_monthly), s.variable_confirmed ? 'warning' : 'info')}
      ${row('WFH allowance', `${s.wfh_usd || 0} USD @ ${s.wfh_fx_rate || 0}`, money(s.wfh_allowance), 'info')}
      ${row('MBO', s.mbo_included ? 'Included' : 'Not included', money(s.mbo_amount), s.mbo_included ? 'warning' : 'info')}
      ${row('Tax rate', 'Effective / input tax rate', pct(s.effective_tax_rate), 'info')}
      ${row('Salary date', 'Next forecast inflow date', shortDate(s.forecast_date), 'info')}
      ${s.current_month ? row('Current month salary', s.current_month.month || '', `${s.current_month.status || 'unknown'} · received ${money(s.current_month.received || 0)}`, sfTone(s.current_month.status)) : ''}
    `);
  }

  function renderObligations() {
    const b = bills();
    const d = debts();
    const cc = creditCard();

    const billHtml = b.length
      ? b.map(bill => `
          <div class="forecast-obligation-card">
            <div class="forecast-obligation-head">
              <div>
                <div class="forecast-obligation-title">${esc(bill.name || bill.id)}</div>
                <div class="forecast-obligation-sub">${esc(bill.due_date || '—')} · ${esc(bill.current_cycle_status || bill.status || 'unknown')}</div>
              </div>
              <div class="forecast-obligation-amount">${money(bill.remaining_amount)}</div>
            </div>
            <div class="forecast-tags">
              ${tag(`amount ${money(bill.amount)}`)}
              ${tag(`paid ${money(bill.paid_amount)}`, 'good')}
              ${tag(`remaining ${money(bill.remaining_amount)}`, bill.remaining_amount > 0 ? 'warn' : 'good')}
              ${bill.ledger_reversed_excluded_count ? tag(`${bill.ledger_reversed_excluded_count} ledger reversed excluded`, 'danger') : ''}
              ${bill.ignored_payment_count ? tag(`${bill.ignored_payment_count} ignored`, 'warn') : ''}
            </div>
          </div>
        `).join('')
      : empty('No bills returned.');

    const payable = Array.isArray(d.payable) ? d.payable : [];
    const receivable = Array.isArray(d.receivable) ? d.receivable : [];

    const debtHtml = `
      <div class="forecast-section-mini-title">Payable debts</div>
      ${payable.length ? payable.map(debt => row(debt.name || debt.id, debt.due_date || 'No due date', money(debt.remaining_amount), 'danger')).join('') : empty('No payable debts.')}
      <div class="forecast-section-mini-title">Receivables</div>
      ${receivable.length ? receivable.map(debt => row(debt.name || debt.id, debt.due_date || 'No due date', money(debt.remaining_amount), 'info')).join('') : empty('No receivables.')}
    `;

    setHTML(['obligationsPanel', 'forecastObligationsPanel'], `
      <div class="forecast-section-mini-title">Bills</div>
      ${billHtml}
      <div class="forecast-section-mini-title">Credit card</div>
      ${row('Outstanding', 'Credit card balance', money(cc.outstanding), cc.outstanding > 0 ? 'danger' : 'positive')}
      ${row('Minimum due', cc.minimum_due_source || 'source unknown', money(cc.minimum_due), cc.minimum_due_source === 'api' ? 'warning' : 'danger')}
      ${row('Due date', 'Payment due date', shortDate(cc.due_date), 'info')}
      ${debtHtml}
    `);
  }

  function renderSources() {
    const sources = Array.isArray(payload().sources) ? payload().sources : [];
    const policy = sourcePolicy();
    const proof = payload().proof || {};

    const sourcesHtml = sources.length
      ? sources.map(source => `
          <div class="forecast-source-card ${source.ok ? 'ok' : 'bad'}">
            <div class="forecast-source-head">
              <div>
                <div class="forecast-source-title">${esc(source.path)}</div>
                <div class="forecast-source-sub">HTTP ${esc(source.status)} · ${esc(source.version || 'no version')}</div>
              </div>
              <div>${tag(source.ok ? 'ok' : 'failed', source.ok ? 'good' : 'danger')}</div>
            </div>
            ${source.parse_error ? `<div class="forecast-source-error">${esc(source.parse_error)}</div>` : ''}
          </div>
        `).join('')
      : empty('No source status returned.');

    const checks = Array.isArray(proof.checks) ? proof.checks : [];
    const checksHtml = checks.length
      ? checks.map(check => row(check.check, check.detail || '', check.status || 'unknown', sfTone(check.status))).join('')
      : empty('No proof checks returned.');

    setHTML(['sourcesPanel', 'sourceHealthPanel'], `
      ${row('Source policy', 'Forecast readiness from required/optional sources', policy.status || 'unknown', sfTone(policy.status))}
      ${row('Required failed', 'Required sources unavailable', (policy.required_failed || []).join(', ') || 'None', (policy.required_failed || []).length ? 'danger' : 'positive')}
      ${row('Optional failed', 'Optional sources unavailable', (policy.optional_failed || []).join(', ') || 'None', (policy.optional_failed || []).length ? 'warning' : 'positive')}
      <div class="forecast-section-mini-title">Sources</div>
      ${sourcesHtml}
      <div class="forecast-section-mini-title">Proof</div>
      ${checksHtml}
    `);
  }

  function renderDebug() {
    setText(['debugPanel', 'forecastDebug'], JSON.stringify(state.payload, null, 2));
  }

  function renderAll() {
    renderHero();
    renderMetrics();
    renderCrisisAnalysis();
    renderWaterfall();
    renderTimeline();
    renderMonthly();
    renderPosition();
    renderSalaryBridge();
    renderObligations();
    renderSources();
    renderDebug();

    setText(['forecastFooterVersion'], `${VERSION} · backend ${payload().version || 'unknown'}`);
  }

  async function loadForecast() {
    if (state.loading) return;

    state.loading = true;
    setText(['forecastHeroStatus', 'forecastStatus'], 'LOADING');
    setText(['forecastHeroCopy', 'forecastSubtitle'], 'Reading /api/forecast…');

    try {
      state.payload = await fetchJSON(forecastUrl());
      renderAll();
      toast('Forecast loaded.');
    } catch (err) {
      setText(['forecastHeroStatus', 'forecastStatus'], 'FAILED');
      setText(['forecastHeroCopy', 'forecastSubtitle'], err.message);

      setHTML(['crisisAnalysisPanel', 'crisisPanel'], empty('Forecast failed: ' + err.message));
      setHTML(['debugPanel', 'forecastDebug'], esc(err.stack || err.message));
    } finally {
      state.loading = false;
    }
  }

  function readControls() {
    const mode = firstEl(['forecastModeSelect', 'modeSelect', 'forecast_mode']);
    if (mode && mode.value) state.mode = mode.value;

    const floor = firstEl(['crisisFloorInput', 'forecastCrisisFloor', 'crisis_floor']);
    if (floor && floor.value) state.crisisFloor = num(floor.value, state.crisisFloor);

    const days = firstEl(['forecastDaysInput', 'forecast_days']);
    if (days && days.value) state.days = num(days.value, state.days);

    const months = firstEl(['forecastMonthsInput', 'forecast_months']);
    if (months && months.value) state.months = num(months.value, state.months);
  }

  function bindControls() {
    const refresh = firstEl(['refreshForecastBtn', 'forecastRefreshBtn', 'refresh_btn']);
    if (refresh) {
      refresh.addEventListener('click', () => {
        readControls();
        loadForecast();
      });
    }

    const mode = firstEl(['forecastModeSelect', 'modeSelect', 'forecast_mode']);
    if (mode) {
      mode.value = state.mode;
      mode.addEventListener('change', () => {
        readControls();
        loadForecast();
      });
    }

    const floor = firstEl(['crisisFloorInput', 'forecastCrisisFloor', 'crisis_floor']);
    if (floor) {
      floor.value = String(state.crisisFloor);
      floor.addEventListener('change', () => {
        readControls();
        loadForecast();
      });
    }
  }

  function injectStyles() {
    if ($('forecast-renderer-style')) return;

    const style = document.createElement('style');
    style.id = 'forecast-renderer-style';
    style.textContent = `
      .forecast-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: start;
        padding: 11px 0;
        border-bottom: 1px solid var(--sf-border-subtle);
      }

      .forecast-row:last-child {
        border-bottom: 0;
      }

      .forecast-row-title {
        color: var(--sf-text);
        font-size: 14px;
        font-weight: 900;
        line-height: 1.25;
      }

      .forecast-row-sub {
        margin-top: 4px;
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .forecast-row-value {
        color: var(--sf-text);
        font-weight: 950;
        text-align: right;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      .forecast-empty {
        border: 1px dashed var(--sf-border);
        border-radius: 18px;
        padding: 18px;
        color: var(--sf-text-muted);
        background: var(--sf-surface-1);
        line-height: 1.5;
      }

      .forecast-tag {
        border: 1px solid var(--sf-border-subtle);
        border-radius: 999px;
        background: var(--sf-surface-2);
        color: var(--sf-text-muted);
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 850;
      }

      .forecast-tag.good {
        background: var(--sf-positive-soft);
        color: var(--sf-positive);
        border-color: rgba(83, 215, 167, .28);
      }

      .forecast-tag.warn {
        background: var(--sf-warning-soft);
        color: var(--sf-warning);
        border-color: rgba(241, 184, 87, .28);
      }

      .forecast-tag.danger {
        background: var(--sf-danger-soft);
        color: var(--sf-danger);
        border-color: rgba(255, 127, 138, .28);
      }

      .forecast-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }

      .forecast-proof-card,
      .forecast-day-card,
      .forecast-month-card,
      .forecast-obligation-card,
      .forecast-source-card {
        border: 1px solid var(--sf-border-subtle);
        border-radius: 18px;
        background: var(--sf-surface-1);
        padding: 14px;
        display: grid;
        gap: 10px;
        margin-bottom: 12px;
      }

      .forecast-proof-card.danger,
      .forecast-day-card.danger,
      .forecast-source-card.bad {
        border-color: rgba(255, 127, 138, .32);
      }

      .forecast-proof-title,
      .forecast-section-mini-title {
        color: var(--sf-text);
        font-size: 14px;
        font-weight: 950;
        margin: 10px 0 4px;
      }

      .forecast-proof-grid,
      .forecast-month-grid {
        display: grid;
        gap: 0;
      }

      .forecast-event,
      .forecast-day-head,
      .forecast-month-head,
      .forecast-obligation-head,
      .forecast-source-head {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: start;
      }

      .forecast-event-title,
      .forecast-day-title,
      .forecast-month-title,
      .forecast-obligation-title,
      .forecast-source-title {
        color: var(--sf-text);
        font-size: 14px;
        font-weight: 950;
        line-height: 1.25;
      }

      .forecast-event-sub,
      .forecast-day-sub,
      .forecast-month-sub,
      .forecast-obligation-sub,
      .forecast-source-sub,
      .forecast-source-error {
        margin-top: 4px;
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .forecast-source-error {
        color: var(--sf-danger);
      }

      .forecast-event-amount,
      .forecast-day-amount,
      .forecast-month-amount,
      .forecast-obligation-amount {
        font-weight: 950;
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: nowrap;
      }

      .forecast-event-amount.good { color: var(--sf-positive); }
      .forecast-event-amount.warn { color: var(--sf-warning); }
      .forecast-event-amount.danger { color: var(--sf-danger); }

      .forecast-day-bar {
        height: 10px;
        border-radius: 999px;
        background: var(--sf-surface-2);
        overflow: hidden;
        border: 1px solid var(--sf-border-subtle);
      }

      .forecast-day-bar span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--sf-danger), var(--sf-warning), var(--sf-positive));
      }

      .forecast-toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 9999;
        transform: translateY(18px);
        opacity: 0;
        pointer-events: none;
        transition: .2s ease;
        border: 1px solid var(--sf-border);
        border-radius: 16px;
        padding: 12px 14px;
        background: var(--sf-card-strong);
        color: var(--sf-text);
        box-shadow: var(--sf-shadow-md);
        font-weight: 850;
      }

      .forecast-toast.show {
        transform: translateY(0);
        opacity: 1;
      }

      @media (max-width: 760px) {
        .forecast-row,
        .forecast-event,
        .forecast-day-head,
        .forecast-month-head,
        .forecast-obligation-head,
        .forecast-source-head {
          grid-template-columns: 1fr;
        }

        .forecast-row-value,
        .forecast-event-amount,
        .forecast-day-amount,
        .forecast-month-amount,
        .forecast-obligation-amount {
          text-align: left;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function toast(message) {
    let el = $('forecastToast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'forecastToast';
      el.className = 'forecast-toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function init() {
    injectStyles();
    bindControls();
    readControls();
    loadForecast();

    window.SovereignForecast = {
      version: VERSION,
      reload: loadForecast,
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
