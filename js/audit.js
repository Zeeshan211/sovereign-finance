/* js/audit.js
 * Sovereign Finance · Audit Trail UI
 * v0.3.0-audit-health-integrity-ui
 *
 * Contract:
 * - /api/audit owns audit truth.
 * - UI is read-only.
 * - UI renders audit events, health, verify, taxonomy, exports, and entity drilldown.
 * - No POST/PUT/DELETE from this page.
 */

(function () {
  'use strict';

  const VERSION = 'v0.3.0-audit-health-integrity-ui';

  const API_AUDIT = '/api/audit';
  const API_HEALTH = '/api/audit/health';
  const API_VERIFY = '/api/audit/verify';
  const API_ACTIONS = '/api/audit/actions';

  const state = {
    audit: null,
    health: null,
    verify: null,
    actions: null,
    entityAudit: null,
    filters: {
      action: '',
      entity: '',
      kind: '',
      severity: '',
      from: '',
      to: '',
      limit: 100
    },
    loading: false
  };

  const $ = id => document.getElementById(id);

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? '' : String(value);
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function shortHash(value) {
    const text = String(value || '');
    if (!text) return '—';
    return text.length <= 16 ? text : text.slice(0, 10) + '…' + text.slice(-6);
  }

  function shortTime(value) {
    if (!value) return '—';

    try {
      return new Date(value).toLocaleString('en-PK', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return String(value);
    }
  }

  function tone(value) {
    const s = String(value || '').toLowerCase();

    if (['ok', 'pass', 'ready', 'info', 'verified'].includes(s)) return 'good';
    if (['warning', 'warn', 'partial_hash', 'no_hash_chain', 'degraded'].includes(s)) return 'warn';
    if (['critical', 'danger', 'error', 'fail', 'failed', 'tamper_suspect', 'missing'].includes(s)) return 'danger';

    return '';
  }

  function sfTone(value) {
    const t = tone(value);
    if (t === 'good') return 'positive';
    if (t === 'warn') return 'warning';
    if (t === 'danger') return 'danger';
    return '';
  }

  function tag(text, tagTone) {
    return `<span class="audit-tag ${tagTone || ''}">${esc(text)}</span>`;
  }

  function row(title, sub, value, rowTone) {
    return `
      <div class="audit-row">
        <div>
          <div class="audit-row-title">${esc(title)}</div>
          ${sub ? `<div class="audit-row-sub">${esc(sub)}</div>` : ''}
        </div>
        <div class="audit-row-value ${rowTone ? `sf-tone-${esc(rowTone)}` : ''}">
          ${value == null ? '—' : value}
        </div>
      </div>
    `;
  }

  function empty(message) {
    return `<div class="audit-empty">${esc(message)}</div>`;
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

  function buildAuditUrl() {
    const url = new URL(API_AUDIT, window.location.origin);

    if (state.filters.action) url.searchParams.set('action', state.filters.action);
    if (state.filters.entity) url.searchParams.set('entity', state.filters.entity);
    if (state.filters.kind) url.searchParams.set('kind', state.filters.kind);
    if (state.filters.severity) url.searchParams.set('severity', state.filters.severity);
    if (state.filters.from) url.searchParams.set('from', state.filters.from);
    if (state.filters.to) url.searchParams.set('to', state.filters.to);

    url.searchParams.set('limit', String(state.filters.limit || 100));

    return url.pathname + url.search;
  }

  function readFilters() {
    state.filters.action = $('auditActionFilter')?.value.trim() || '';
    state.filters.entity = $('auditEntityFilter')?.value.trim() || '';
    state.filters.kind = $('auditKindFilter')?.value.trim() || '';
    state.filters.severity = $('auditSeverityFilter')?.value.trim() || '';
    state.filters.from = $('auditFromInput')?.value || '';
    state.filters.to = $('auditToInput')?.value || '';
    state.filters.limit = Math.max(1, Math.min(500, num($('auditLimitInput')?.value, 100)));
  }

  async function loadAudit() {
    if (state.loading) return;

    state.loading = true;
    setText('auditHeroStatus', 'Loading');
    setText('auditHeroCopy', 'Reading audit trail…');
    setHTML('auditEventList', empty('Loading audit events…'));

    try {
      const [audit, health, actions] = await Promise.all([
        fetchJSON(buildAuditUrl()),
        fetchJSON(API_HEALTH),
        fetchJSON(API_ACTIONS).catch(() => null)
      ]);

      state.audit = audit;
      state.health = health.health || health;
      state.actions = actions;

      renderAll();
      toast('Audit loaded.');
    } catch (err) {
      setText('auditHeroStatus', 'Failed');
      setText('auditHeroCopy', err.message);
      setHTML('auditEventList', empty('Audit load failed: ' + err.message));
      setHTML('auditHealthPanel', empty('Health failed: ' + err.message));
      setText('auditDebug', err.stack || err.message);
    } finally {
      state.loading = false;
    }
  }

  function renderHero() {
    const audit = state.audit || {};
    const health = state.health || {};
    const status = health.status || audit.health_summary?.status || 'unknown';
    const rowCount = health.row_count ?? audit.health_summary?.row_count ?? audit.count ?? 0;
    const coverage = health.hash_coverage_pct ?? audit.health_summary?.hash_coverage_pct ?? 0;
    const firstBreak = health.first_hash_break || audit.health_summary?.first_hash_break || null;

    setText('auditHeroStatus', String(status).toUpperCase());

    setText(
      'auditHeroCopy',
      firstBreak
        ? `Hash-chain issue detected at event ${firstBreak.id || 'unknown'}. Rows: ${rowCount}. Hash coverage: ${coverage}%.`
        : `Audit rows: ${rowCount}. Hash coverage: ${coverage}%. Writes are blocked from the audit UI.`
    );

    setText('auditVersionPill', audit.version || health.version || VERSION);
    setText('auditHealthPill', `health ${status}`);
    setText('auditHashPill', `hash ${coverage}%`);
    setText('auditFooterVersion', `${VERSION} · backend ${audit.version || health.version || 'unknown'}`);
  }

  function renderMetrics() {
    const health = state.health || {};
    const latest = health.latest_event_at || '—';

    setText('metricAuditRows', String(health.row_count ?? state.audit?.count ?? 0));
    setText('metricHashCoverage', `${num(health.hash_coverage_pct, 0)}%`);
    setText('metricCriticalEvents', String(health.critical_event_count ?? 0));
    setText('metricLatestEvent', latest === '—' ? '—' : shortTime(latest));
    setText('metricIntegrityStatus', health.status || 'unknown');
    setText('metricReadOnly', 'Blocked');
  }

  function renderHealth() {
    const health = state.health || {};
    const checks = health.checks || {};

    setHTML('auditHealthPanel', `
      ${row('Status', 'Audit health classification', health.status || 'unknown', sfTone(health.status))}
      ${row('Audit table', 'audit_log exists', health.audit_table_exists ? 'Yes' : 'No', health.audit_table_exists ? 'positive' : 'danger')}
      ${row('Rows', 'Total audit rows', String(health.row_count ?? 0))}
      ${row('Hashed rows', 'Rows with row_hash', String(health.hashed_row_count ?? 0))}
      ${row('Hash coverage', 'row_hash coverage', `${num(health.hash_coverage_pct, 0)}%`, health.hash_coverage_pct === 100 ? 'positive' : 'warning')}
      ${row('Latest event', 'Newest audit timestamp', health.latest_event_at ? shortTime(health.latest_event_at) : '—')}
      ${row('Latest event ID', 'Newest audit ID', health.latest_event_id || '—')}
      ${row('Critical events', 'Purges, reversals, blocks, failures', String(health.critical_event_count ?? 0), num(health.critical_event_count, 0) ? 'danger' : 'positive')}
      ${row('Hash columns', 'prev_hash + row_hash', checks.hash_columns_present ? 'Present' : 'Missing', checks.hash_columns_present ? 'positive' : 'warning')}
      ${row('Chain verifiable', 'Backend can verify chain', checks.chain_verifiable ? 'Yes' : 'No', checks.chain_verifiable ? 'positive' : 'warning')}
      ${row('POST blocked', 'Audit write protection', checks.post_blocked ? 'Yes' : 'No', checks.post_blocked ? 'positive' : 'danger')}
      ${row('Export available', 'CSV / JSON export', checks.export_available ? 'Yes' : 'No', checks.export_available ? 'positive' : 'warning')}
    `);
  }

  function renderVerify() {
    const verify = state.verify;

    if (!verify) {
      setHTML('auditVerifyPanel', empty('Verification not run yet.'));
      return;
    }

    if (verify.status === 'no_hash_chain') {
      setHTML('auditVerifyPanel', `
        ${row('Status', 'Hash-chain status', 'No hash chain', 'warning')}
        ${row('Reason', 'Backend response', verify.reason || 'row_hash / prev_hash missing')}
        ${row('Next step', 'Backend hardening', verify.next_step || 'Add hash-chain columns and centralized writer.')}
      `);
      return;
    }

    const firstBreak = verify.first_break || null;

    setHTML('auditVerifyPanel', `
      ${row('Verified', 'Hash-chain verification', verify.verified ? 'Yes' : 'No', verify.verified ? 'positive' : 'danger')}
      ${row('Status', 'Backend verification status', verify.status || 'unknown', sfTone(verify.status))}
      ${row('Checked rows', 'Rows scanned by verifier', String(verify.checked ?? 0))}
      ${row('Total scanned', 'Scan limit result', String(verify.total_scanned ?? 0))}
      ${row('Latest verified hash', 'End of verified chain', shortHash(verify.latest_verified_hash))}
      ${firstBreak ? row('First break', firstBreak.reason || 'break', firstBreak.id || 'unknown', 'danger') : ''}
      ${firstBreak?.expected_hash ? row('Expected hash', 'Computed verifier hash', shortHash(firstBreak.expected_hash), 'danger') : ''}
      ${firstBreak?.stored_hash ? row('Stored hash', 'Row stored hash', shortHash(firstBreak.stored_hash), 'danger') : ''}
      ${firstBreak?.expected_prev_hash ? row('Expected prev hash', 'Previous verified hash', shortHash(firstBreak.expected_prev_hash), 'danger') : ''}
      ${firstBreak?.stored_prev_hash ? row('Stored prev hash', 'Row prev_hash', shortHash(firstBreak.stored_prev_hash), 'danger') : ''}
    `);
  }

  function renderActions() {
    const taxonomy = state.actions?.taxonomy || {};
    const keys = Object.keys(taxonomy);

    if (!keys.length) {
      setHTML('auditActionsPanel', empty('Action taxonomy unavailable.'));
      return;
    }

    setHTML('auditActionsPanel', keys.map(group => {
      const actions = Array.isArray(taxonomy[group]) ? taxonomy[group] : [];

      return `
        <div style="margin-bottom:14px;">
          <div class="audit-row-title">${esc(group)}</div>
          <div class="audit-tags" style="margin-top:8px;">
            ${actions.map(action => tag(action)).join('')}
          </div>
        </div>
      `;
    }).join(''));
  }

  function renderEvents() {
    const events = state.audit?.events || state.audit?.rows || [];

    if (!events.length) {
      setHTML('auditEventList', empty('No audit events returned for current filters.'));
      return;
    }

    setHTML('auditEventList', events.map(renderEventCard).join(''));
  }

  function renderEventCard(event) {
    const severity = event.severity || 'info';
    const detailText = event.detail_json
      ? JSON.stringify(event.detail_json, null, 2)
      : event.detail || '';

    const tags = [
      tag(event.action || 'UNKNOWN', tone(severity)),
      event.entity ? tag(event.entity) : '',
      event.kind ? tag(event.kind) : '',
      event.severity ? tag(event.severity, tone(event.severity)) : '',
      event.has_hash ? tag('hashed', 'good') : tag('legacy/no hash', 'warn')
    ].filter(Boolean);

    return `
      <article class="audit-event-card">
        <div class="audit-event-head">
          <div class="audit-icon">${iconForEvent(event)}</div>

          <div>
            <div class="audit-event-title">${esc(event.action || 'UNKNOWN_ACTION')}</div>
            <div class="audit-event-sub">
              ${esc(event.id || 'no id')} · ${esc(event.entity || 'no entity')} ${event.entity_id ? '· ' + esc(event.entity_id) : ''}
            </div>
          </div>

          <div class="audit-time">${esc(shortTime(event.timestamp))}</div>
        </div>

        <div class="audit-tags">${tags.join('')}</div>

        <div>
          ${row('Created by', 'Actor / source', event.created_by || '—')}
          ${row('IP', 'Request origin', event.ip || '—')}
          ${row('Source route', 'API route that generated event', event.source_route || '—')}
          ${row('Source version', 'Route version', event.source_version || '—')}
          ${row('Payload hash', 'Mutation payload hash', shortHash(event.payload_hash))}
          ${row('Prev hash', 'Hash-chain previous row', shortHash(event.prev_hash))}
          ${row('Row hash', 'Hash-chain row hash', shortHash(event.row_hash))}
        </div>

        ${detailText ? `<pre class="audit-code">${esc(detailText)}</pre>` : ''}
      </article>
    `;
  }

  function iconForEvent(event) {
    const action = String(event.action || '').toUpperCase();

    if (action.includes('PURGE')) return '🧨';
    if (action.includes('REVERSE')) return '↩';
    if (action.includes('DEBT')) return '📤';
    if (action.includes('BILL')) return '🧾';
    if (action.includes('SALARY')) return '💰';
    if (action.includes('TRANSFER')) return '⇄';
    if (action.includes('FAIL') || action.includes('BLOCK')) return '⛔';
    if (action.includes('VERIFY')) return '🔐';

    return '📜';
  }

  function renderEntityAudit() {
    const payload = state.entityAudit;

    if (!payload) {
      setHTML('auditEntityPanel', empty('No entity loaded.'));
      return;
    }

    const events = payload.events || [];

    setHTML('auditEntityPanel', `
      ${row('Entity', payload.entity || '—', payload.entity_id || '—')}
      ${row('Events', 'Entity-specific audit rows', String(payload.count ?? events.length))}
      <div style="margin-top:12px;">
        ${events.length ? events.map(renderEventCard).join('') : empty('No events for this entity.')}
      </div>
    `);
  }

  function renderDebug(extra) {
    setText('auditDebug', JSON.stringify({
      version: VERSION,
      filters: state.filters,
      audit: state.audit,
      health: state.health,
      verify: state.verify,
      actions: state.actions,
      entityAudit: state.entityAudit,
      extra: extra || null
    }, null, 2));
  }

  function renderAll() {
    renderHero();
    renderMetrics();
    renderHealth();
    renderVerify();
    renderActions();
    renderEvents();
    renderEntityAudit();
    renderDebug();

    setText('auditFooterVersion', `${VERSION} · backend ${(state.audit && state.audit.version) || (state.health && state.health.version) || 'unknown'}`);
  }

  async function runVerify() {
    setHTML('auditVerifyPanel', empty('Running verification…'));

    try {
      state.verify = await fetchJSON(API_VERIFY);
      renderVerify();
      renderDebug();
      toast('Verification complete.');
    } catch (err) {
      setHTML('auditVerifyPanel', empty('Verify failed: ' + err.message));
      toast('Verify failed.');
    }
  }

  async function loadEntityAudit() {
    const entity = $('entityTypeInput')?.value.trim();
    const entityId = $('entityIdInput')?.value.trim();

    if (!entity || !entityId) {
      toast('Entity and entity ID required.');
      return;
    }

    setHTML('auditEntityPanel', empty('Loading entity audit…'));

    try {
      state.entityAudit = await fetchJSON(`${API_AUDIT}/entity/${encodeURIComponent(entity)}/${encodeURIComponent(entityId)}`);
      renderEntityAudit();
      renderDebug();
    } catch (err) {
      setHTML('auditEntityPanel', empty('Entity audit failed: ' + err.message));
      toast('Entity audit failed.');
    }
  }

  function exportCsv() {
    window.open(buildExportUrl('csv'), '_blank', 'noopener,noreferrer');
  }

  function exportJson() {
    window.open(buildExportUrl('json'), '_blank', 'noopener,noreferrer');
  }

  function buildExportUrl(format) {
    readFilters();

    const path = format === 'csv' ? '/api/audit/export.csv' : '/api/audit/export.json';
    const url = new URL(path, window.location.origin);

    if (state.filters.action) url.searchParams.set('action', state.filters.action);
    if (state.filters.entity) url.searchParams.set('entity', state.filters.entity);
    if (state.filters.kind) url.searchParams.set('kind', state.filters.kind);
    if (state.filters.severity) url.searchParams.set('severity', state.filters.severity);
    if (state.filters.from) url.searchParams.set('from', state.filters.from);
    if (state.filters.to) url.searchParams.set('to', state.filters.to);

    url.searchParams.set('limit', String(Math.min(50000, Math.max(1, state.filters.limit || 10000))));

    return url.pathname + url.search;
  }

  function readFilters() {
    state.filters.action = $('auditActionFilter')?.value.trim() || '';
    state.filters.entity = $('auditEntityFilter')?.value.trim() || '';
    state.filters.kind = $('auditKindFilter')?.value.trim() || '';
    state.filters.severity = $('auditSeverityFilter')?.value.trim() || '';
    state.filters.from = $('auditFromInput')?.value || '';
    state.filters.to = $('auditToInput')?.value || '';
    state.filters.limit = Math.max(1, Math.min(500, num($('auditLimitInput')?.value, 100)));
  }

  function bind() {
    $('refreshAuditBtn')?.addEventListener('click', () => {
      readFilters();
      loadAudit();
    });

    $('applyAuditFiltersBtn')?.addEventListener('click', () => {
      readFilters();
      loadAudit();
    });

    $('verifyAuditBtn')?.addEventListener('click', runVerify);
    $('exportCsvBtn')?.addEventListener('click', exportCsv);
    $('exportJsonBtn')?.addEventListener('click', exportJson);
    $('loadEntityAuditBtn')?.addEventListener('click', loadEntityAudit);
  }

  function toast(message) {
    const el = $('auditToast');
    if (!el) return;

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function init() {
    bind();
    readFilters();
    loadAudit();

    window.SovereignAudit = {
      version: VERSION,
      reload: loadAudit,
      verify: runVerify,
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();