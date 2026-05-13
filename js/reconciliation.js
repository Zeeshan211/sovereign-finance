/* js/reconciliation.js
 * Sovereign Finance · Reconciliation UI
 * v0.2.0-declaration-ui
 *
 * Contract:
 * - /api/reconciliation owns reconciliation truth.
 * - /api/accounts is the computed balance source via backend.
 * - UI saves declarations only.
 * - UI never writes ledger or account adjustments.
 */

(function () {
  'use strict';

  const VERSION = 'v0.2.0-declaration-ui';

  const API_RECON = '/api/reconciliation';
  const API_HEALTH = '/api/reconciliation/health';

  const state = {
    payload: null,
    health: null,
    accounts: [],
    selectedAccountId: '',
    filter: 'all',
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

  function money(value) {
    const n = num(value, 0);
    const sign = n < 0 ? '-' : '';

    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function nowLocalDateTime() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function severityTone(severity) {
    const s = String(severity || '').toLowerCase();

    if (s === 'ok' || s === 'matched') return 'good';
    if (s === 'check' || s === 'not_reconciled') return 'warn';
    if (s === 'investigate' || s === 'source_error') return 'danger';

    return '';
  }

  function sfTone(severity) {
    const tone = severityTone(severity);

    if (tone === 'good') return 'positive';
    if (tone === 'warn') return 'warning';
    if (tone === 'danger') return 'danger';

    return '';
  }

  function tag(text, tone) {
    return `<span class="recon-tag ${tone || ''}">${esc(text)}</span>`;
  }

  function row(title, sub, value, tone) {
    return `
      <div class="recon-row">
        <div>
          <div class="recon-row-title">${esc(title)}</div>
          ${sub ? `<div class="recon-row-sub">${esc(sub)}</div>` : ''}
        </div>
        <div class="recon-row-value ${tone ? `sf-tone-${esc(tone)}` : ''}">
          ${value == null ? '—' : value}
        </div>
      </div>
    `;
  }

  function empty(message) {
    return `<div class="recon-empty">${esc(message)}</div>`;
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options && options.headers ? options.headers : {})
      },
      ...(options || {})
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

  async function postJSON(url, body) {
    return fetchJSON(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
  }

  function selectedAccount() {
    return state.accounts.find(account => String(account.id) === String(state.selectedAccountId)) || null;
  }

  function filterAccounts() {
    return state.accounts.filter(account => {
      const severity = String(account.severity || 'not_reconciled').toLowerCase();

      if (state.filter === 'all') return true;
      return severity === state.filter;
    });
  }

  async function loadReconciliation() {
    if (state.loading) return;

    state.loading = true;
    setText('reconHeroStatus', 'Loading');
    setText('reconHeroCopy', 'Reading /api/reconciliation…');
    setHTML('reconAccountList', empty('Loading reconciliation accounts…'));

    try {
      state.payload = await fetchJSON(API_RECON);
      state.accounts = Array.isArray(state.payload.accounts) ? state.payload.accounts : [];

      try {
        state.health = await fetchJSON(API_HEALTH);
      } catch {
        state.health = null;
      }

      if (!state.selectedAccountId && state.accounts.length) {
        state.selectedAccountId = state.accounts[0].id;
      }

      renderAll();
    } catch (err) {
      setText('reconHeroStatus', 'Failed');
      setText('reconHeroCopy', err.message);
      setHTML('reconAccountList', empty('Reconciliation failed: ' + err.message));
      setHTML('reconHealthPanel', empty('Health unavailable: ' + err.message));
      setText('reconDebug', err.stack || err.message);
    } finally {
      state.loading = false;
    }
  }

  function renderHero() {
    const payload = state.payload || {};
    const summary = payload.summary || {};
    const source = payload.source || '/api/accounts';
    const status = payload.status || 'unknown';

    setText('reconHeroStatus', String(status).toUpperCase());

    setText(
      'reconHeroCopy',
      `${summary.declared_count || 0}/${summary.account_count || 0} accounts declared. Open drift: ${summary.open_drift_count || 0}. Total abs drift: ${money(summary.total_abs_drift || 0)}.`
    );

    setText('reconVersionPill', payload.version || VERSION);
    setText('reconSourcePill', `source ${source}`);
    setText('reconPolicyPill', 'ledger writes blocked');

    setText('reconFooterVersion', `${VERSION} · backend ${payload.version || 'unknown'}`);
  }

  function renderMetrics() {
    const summary = (state.payload && state.payload.summary) || {};

    setText('metricAccountCount', String(summary.account_count ?? state.accounts.length));
    setText('metricDeclaredCount', String(summary.declared_count ?? 0));
    setText('metricSeverityCounts', `${summary.ok_count || 0} / ${summary.check_count || 0} / ${summary.investigate_count || 0}`);
    setText('metricOpenDrift', String(summary.open_drift_count || 0));
    setText('metricTotalAbsDrift', money(summary.total_abs_drift || 0));
    setText('metricLedgerWrites', 'Blocked');
  }

  function renderAccountSelect() {
    const select = $('reconAccountSelect');
    if (!select) return;

    const current = select.value || state.selectedAccountId;

    select.innerHTML = '<option value="">Select account…</option>' + state.accounts.map(account => {
      const label = `${account.name || account.id} · ${money(account.computed_balance ?? account.balance)} · ${account.severity || 'not_reconciled'}`;
      return `<option value="${esc(account.id)}">${esc(label)}</option>`;
    }).join('');

    if (current) select.value = current;
  }

  function renderAccountCard(account) {
    const selected = String(account.id) === String(state.selectedAccountId);
    const severity = account.severity || 'not_reconciled';
    const delta = account.delta;
    const declared = account.declared_balance;
    const computed = account.computed_balance ?? account.balance ?? 0;

    const tags = [
      tag(severity, severityTone(severity)),
      tag(account.type || account.kind || 'account'),
      tag(account.currency || 'PKR')
    ];

    if (account.reconciled) tags.push(tag('declared', 'good'));
    else tags.push(tag('not reconciled', 'warn'));

    if (account.sign_policy) tags.push(tag(account.sign_policy));

    return `
      <article class="recon-account-card ${selected ? 'is-selected' : ''}" data-account-id="${esc(account.id)}">
        <div class="recon-account-head">
          <div class="recon-icon">${account.kind === 'liability' || account.type === 'liability' ? '💳' : '🏦'}</div>

          <div>
            <div class="recon-account-title">${esc(account.name || account.id)}</div>
            <div class="recon-account-sub">${esc(account.id)} · ${esc(account.type || account.kind || 'account')} · ${esc(account.status || 'active')}</div>
          </div>

          <div class="recon-amount">${money(computed)}</div>
        </div>

        <div class="recon-tags">${tags.join('')}</div>

        <div>
          ${row('Computed', 'From /api/accounts', money(computed))}
          ${row('Declared', account.latest_declaration ? `Declared at ${account.latest_declaration.declared_at || '—'}` : 'No declaration saved', declared == null ? '—' : money(declared))}
          ${row('Delta', 'Declared - computed', delta == null ? '—' : money(delta), delta == null ? '' : (Math.abs(delta) >= 1000 ? 'danger' : Math.abs(delta) >= 100 ? 'warning' : 'positive'))}
        </div>

        <div class="recon-card-actions">
          <button class="recon-action primary" type="button" data-select-account="${esc(account.id)}">Declare</button>
          <a class="recon-action" href="/transactions.html?account_id=${encodeURIComponent(account.id)}">Ledger</a>
        </div>
      </article>
    `;
  }

  function renderAccounts() {
    const list = $('reconAccountList');
    if (!list) return;

    const rows = filterAccounts();

    list.innerHTML = rows.length
      ? rows.map(renderAccountCard).join('')
      : empty('No accounts match this filter.');

    list.querySelectorAll('[data-select-account]').forEach(button => {
      button.addEventListener('click', () => {
        selectAccount(button.getAttribute('data-select-account'));
      });
    });
  }

  function selectAccount(accountId) {
    state.selectedAccountId = accountId || '';

    renderAccounts();
    renderAccountSelect();
    renderSelectedAccount();

    const select = $('reconAccountSelect');
    if (select) select.value = state.selectedAccountId;
  }

  function renderSelectedAccount() {
    const account = selectedAccount();

    if (!account) {
      setText('selectedReconTitle', 'No account selected');
      setText('selectedReconSub', 'Select an account, enter bank-app balance, dry-run, then save declaration.');
      setHTML('selectedReconPanel', empty('No account selected.'));
      return;
    }

    setText('selectedReconTitle', account.name || account.id);
    setText('selectedReconSub', `${account.id} · ${account.type || account.kind || 'account'} · ${account.sign_policy || 'standard sign policy'}`);

    setHTML('selectedReconPanel', `
      ${row('Computed balance', 'Backend /api/accounts balance', money(account.computed_balance ?? account.balance), 'info')}
      ${row('Declared balance', account.latest_declaration ? `Last declared ${account.latest_declaration.declared_at || '—'}` : 'No declaration saved', account.declared_balance == null ? '—' : money(account.declared_balance))}
      ${row('Delta', 'Declared - computed', account.delta == null ? '—' : money(account.delta), account.delta == null ? '' : sfTone(account.severity))}
      ${row('Severity', 'Backend threshold classification', account.severity || 'not_reconciled', sfTone(account.severity))}
      ${row('Sign policy', 'How to enter actual balance', account.sign_policy || 'asset_declared_as_positive_available_balance')}
    `);

    const declaredInput = $('declaredBalanceInput');
    if (declaredInput && account.declared_balance != null) {
      declaredInput.value = account.declared_balance;
    }

    const notes = $('reconNotesInput');
    if (notes && account.latest_declaration && account.latest_declaration.notes) {
      notes.value = account.latest_declaration.notes;
    }
  }

  function renderHealth() {
    const health = state.health || {};
    const checks = health.checks || {};
    const source = health.source || {};

    setHTML('reconHealthPanel', `
      ${row('Status', 'Backend reconciliation health', health.status || 'unknown', sfTone(health.status))}
      ${row('Source available', source.endpoint || '/api/accounts', source.ok ? 'Yes' : 'No', source.ok ? 'positive' : 'danger')}
      ${row('Source version', 'Accounts API version', source.version || 'unknown')}
      ${row('Accounts returned', 'Source account count', String(checks.accounts_returned ?? '—'))}
      ${row('Active accounts', 'Active source accounts', String(checks.active_accounts_returned ?? '—'))}
      ${row('Declaration rows', 'Persistent audit rows', String(checks.declaration_rows ?? '—'))}
      ${row('Declared accounts', 'Accounts with declaration', String(checks.declared_accounts ?? '—'))}
      ${row('Open drift count', 'Check + investigate', String(checks.open_drift_count ?? '—'), Number(checks.open_drift_count || 0) ? 'warning' : 'positive')}
      ${row('High drift count', 'Investigate severity', String(checks.high_drift_count ?? '—'), Number(checks.high_drift_count || 0) ? 'danger' : 'positive')}
      ${row('Direct transaction insert', 'Must be disabled', checks.direct_transaction_insert_disabled ? 'Disabled' : 'Not confirmed', checks.direct_transaction_insert_disabled ? 'positive' : 'danger')}
      ${row('Adjustment commit', 'Must be blocked here', checks.adjustment_commit_blocked ? 'Blocked' : 'Not confirmed', checks.adjustment_commit_blocked ? 'positive' : 'danger')}
    `);
  }

  function renderSourcePolicy() {
    const payload = state.payload || {};
    const policy = payload.policy || {};
    const sign = payload.sign_policy || {};

    setHTML('reconSourcePanel', `
      ${row('Computed balance source', 'Backend source endpoint', payload.source || policy.source_endpoint || '/api/accounts')}
      ${row('Source version', 'Accounts API version', payload.source_version || 'unknown')}
      ${row('Formula', 'Drift calculation', policy.delta_formula || 'declared_balance - computed_balance')}
      ${row('OK threshold', 'Absolute delta below this is OK', money(policy.ok_threshold_abs_lt || 100))}
      ${row('Check threshold', 'Absolute delta below this is check', money(policy.check_threshold_abs_lt || 1000))}
      ${row('Ledger write policy', 'Reconciliation endpoint', policy.ledger_write_policy || 'blocked', 'positive')}
      ${row('Adjustment route', 'Must use transactions API later', policy.adjustment_requires_transactions_api ? 'Required' : 'Not confirmed', policy.adjustment_requires_transactions_api ? 'positive' : 'danger')}
      ${row('Asset sign policy', 'Bank/wallet/cash', sign.asset_accounts || 'Declare actual positive available balance.')}
      ${row('Liability sign policy', 'Credit card/outstanding', sign.liability_accounts || 'Declare outstanding as negative balance.')}
    `);
  }

  function renderDebug(extra) {
    setText('reconDebug', JSON.stringify({
      version: VERSION,
      filter: state.filter,
      selectedAccountId: state.selectedAccountId,
      payload: state.payload,
      health: state.health,
      extra: extra || null
    }, null, 2));
  }

  function renderAll() {
    renderHero();
    renderMetrics();
    renderAccountSelect();
    renderAccounts();
    renderSelectedAccount();
    renderHealth();
    renderSourcePolicy();
    renderDebug();

    setText('reconFooterVersion', `${VERSION} · backend ${(state.payload && state.payload.version) || 'unknown'}`);
  }

  function setFilter(filter) {
    state.filter = filter || 'all';

    document.querySelectorAll('[data-filter]').forEach(button => {
      button.classList.toggle('is-active', button.getAttribute('data-filter') === state.filter);
    });

    renderAccounts();
  }

  function buildDeclarationPayload() {
    return {
      account_id: $('reconAccountSelect')?.value || state.selectedAccountId || '',
      declared_balance: $('declaredBalanceInput')?.value,
      declared_at: $('declaredAtInput')?.value || nowLocalDateTime(),
      notes: $('reconNotesInput')?.value || '',
      created_by: 'web-reconciliation'
    };
  }

  function validateDeclarationPayload(body) {
    if (!body.account_id) return 'Select account first.';

    const declared = Number(body.declared_balance);
    if (!Number.isFinite(declared)) return 'Declared balance must be numeric.';

    return null;
  }

  async function dryRunDeclaration() {
    const body = buildDeclarationPayload();
    const error = validateDeclarationPayload(body);

    if (error) {
      toast(error);
      return;
    }

    try {
      const result = await postJSON(`${API_RECON}/declare?dry_run=1`, body);
      renderDeclarationResult(result);
      toast('Declaration dry-run passed.');
    } catch (err) {
      setHTML('declarationResultPanel', empty('Dry-run failed: ' + err.message));
      toast('Dry-run failed.');
    }
  }

  async function saveDeclaration() {
    const body = buildDeclarationPayload();
    const error = validateDeclarationPayload(body);

    if (error) {
      toast(error);
      return;
    }

    try {
      const result = await postJSON(`${API_RECON}/declare`, body);
      renderDeclarationResult(result);
      toast('Declaration saved.');

      await loadReconciliation();

      if (body.account_id) {
        selectAccount(body.account_id);
      }
    } catch (err) {
      setHTML('declarationResultPanel', empty('Save failed: ' + err.message));
      toast('Save failed.');
    }
  }

  function renderDeclarationResult(result) {
    const declaration = result.declaration || {};
    const proof = result.proof || {};
    const checks = Array.isArray(proof.checks) ? proof.checks : [];

    const checkHtml = checks.length
      ? checks.map(check => row(check.check, check.detail || check.source || '', check.status || 'unknown', check.status === 'pass' ? 'positive' : 'danger')).join('')
      : empty('No proof checks returned.');

    setHTML('declarationResultPanel', `
      ${row(result.dry_run ? 'Dry-run' : 'Saved', 'Declaration action', result.ok ? 'OK' : 'Failed', result.ok ? 'positive' : 'danger')}
      ${row('Account', declaration.account_name || declaration.account_id || '—', declaration.account_id || '—')}
      ${row('Computed', 'Backend current balance', money(declaration.computed_balance))}
      ${row('Declared', 'Manual bank-app balance', money(declaration.declared_balance))}
      ${row('Delta', 'Declared - computed', money(declaration.delta), sfTone(declaration.severity))}
      ${row('Severity', 'Threshold policy', declaration.severity || '—', sfTone(declaration.severity))}
      ${row('Writes performed', 'Declaration table only', String(Boolean(result.writes_performed)), result.writes_performed ? 'positive' : 'warning')}
      ${row('Ledger writes', 'Must stay false', String(Boolean(result.ledger_writes_performed)), result.ledger_writes_performed ? 'danger' : 'positive')}
      <div style="margin-top:12px;">${checkHtml}</div>
    `);
  }

  function bind() {
    $('refreshReconBtn')?.addEventListener('click', loadReconciliation);
    $('reloadReconBtn')?.addEventListener('click', loadReconciliation);

    $('dryRunReconBtn')?.addEventListener('click', dryRunDeclaration);
    $('saveReconBtn')?.addEventListener('click', saveDeclaration);

    $('reconAccountSelect')?.addEventListener('change', event => {
      selectAccount(event.target.value);
    });

    document.querySelectorAll('[data-filter]').forEach(button => {
      button.addEventListener('click', () => {
        setFilter(button.getAttribute('data-filter'));
      });
    });

    const declaredAt = $('declaredAtInput');
    if (declaredAt && !declaredAt.value) {
      declaredAt.value = nowLocalDateTime();
    }
  }

  function toast(message) {
    const el = $('reconToast');
    if (!el) return;

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function init() {
    bind();
    loadReconciliation();

    window.SovereignReconciliation = {
      version: VERSION,
      reload: loadReconciliation,
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
