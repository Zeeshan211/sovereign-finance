/**
 * reconciliation.js
 * Sovereign Finance · Reconciliation Page
 * v0.1.0-reconciliation-manual-snapshots
 *
 * Extracted from reconciliation.html inline <script>.
 * Depends on: sf-components.js, sf-shell.js (loaded before this file).
 */

(function () {
  'use strict';

  const VERSION = 'v0.1.0-reconciliation-manual-snapshots';
  const API_RECON = '/api/reconciliation';

  const state = {
    payload: null,
    rows: [],
    exceptions: []
  };

  /* ─── DOM helpers ─────────────────────────────────────────────────────── */

  const $ = id => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ─── Number / money helpers ──────────────────────────────────────────── */

  function num(value, fallback) {
    if (fallback === undefined) fallback = 0;
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function money(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = num(value, NaN);
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + 'Rs ' + Math.abs(n).toLocaleString('en-PK', {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ─── Fetch helpers ───────────────────────────────────────────────────── */

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  /* ─── Tone / label helpers ────────────────────────────────────────────── */

  function diffTone(diff) {
    const d = num(diff, 0);
    if (d === 0) return 'good';
    return 'warn';
  }

  function statusLabel(status) {
    if (status === 'needs_review') return 'Review';
    if (status === 'matched') return 'Matched';
    return 'Pending';
  }

  function statusClass(status) {
    if (status === 'matched') return 'good';
    return 'warn';
  }

  function recommendation(row) {
    const diff = num(row.difference, 0);
    if (row.real_balance === null || row.real_balance === undefined) {
      return 'Enter real statement balance to compare.';
    }
    if (diff === 0) return 'Balances match. No action needed.';
    if (diff < 0) {
      return 'Real balance is lower than app balance. Possible missing expense, fee, withdrawal, transfer out, or duplicate income.';
    }
    return 'Real balance is higher than app balance. Possible missing income, refund, reversal, transfer in, or duplicate expense.';
  }

  /* ─── CSS escape ──────────────────────────────────────────────────────── */

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value || '').replace(/"/g, '\\"');
  }

  /* ─── Render KPIs ─────────────────────────────────────────────────────── */

  function renderKpis(summary) {
    summary = summary || {};
    setText('kpiAppBalance', money(summary.app_balance));
    setText('kpiRealBalance', money(summary.real_balance));
    setText('kpiDifference', money(summary.difference));
    setText('kpiMatched', String(summary.matched_count || 0));
    setText('kpiReview', String(summary.needs_review_count || 0));

    const diff = $('kpiDifference');
    if (diff) {
      diff.classList.remove('good', 'warn', 'danger');
      const d = num(summary.difference, 0);
      diff.classList.add(d === 0 ? 'good' : 'warn');
    }
  }

  /* ─── Detail helper ───────────────────────────────────────────────────── */

  function detail(label, value) {
    return `
      <div class="recon-detail-label">${esc(label)}</div>
      <div class="recon-detail-value">${esc(value)}</div>
    `;
  }

  /* ─── Render rows ─────────────────────────────────────────────────────── */

  function renderRows() {
    const list = $('reconList');
    if (!list) return;

    if (!state.rows.length) {
      list.innerHTML = '<div class="recon-empty">No active asset accounts found.</div>';
      return;
    }

    list.innerHTML = state.rows.map(row => {
      const tone = diffTone(row.difference);
      const realValue = row.real_balance == null ? '' : row.real_balance;

      return `
        <article class="recon-row" data-account-id="${esc(row.account_id)}">
          <button class="recon-row-shell" type="button" data-toggle-recon="${esc(row.account_id)}">
            <div class="recon-icon">🏦</div>

            <div>
              <div class="recon-title-line">${esc(row.account_name)}</div>
              <div class="recon-sub">statement ${esc(row.statement_date || 'not checked')} · ${esc(recommendation(row))}</div>
            </div>

            <div class="recon-amount">${esc(money(row.app_balance))}</div>
            <div class="recon-amount">${esc(row.real_balance == null ? '—' : money(row.real_balance))}</div>
            <div class="recon-amount ${tone}">${esc(row.difference == null ? '—' : money(row.difference))}</div>
            <div class="recon-status-label ${statusClass(row.status)}">${esc(statusLabel(row.status))}</div>
            <div class="recon-caret">▾</div>
          </button>

          <div class="recon-detail">
            <div class="recon-detail-grid">
              ${detail('Account', row.account_name)}
              ${detail('App balance', money(row.app_balance))}
              ${detail('Real balance', row.real_balance == null ? '—' : money(row.real_balance))}
              ${detail('Difference', row.difference == null ? '—' : money(row.difference))}
              ${detail('Status', statusLabel(row.status))}
              ${detail('Last checked', row.last_checked_at || 'Never')}
              ${detail('Recommendation', recommendation(row))}
              ${detail('Notes', row.notes || '—')}
            </div>

            <div class="recon-form-grid">
              <div class="recon-field">
                <label>Statement Date</label>
                <input class="recon-input" type="date" data-recon-date="${esc(row.account_id)}" value="${esc(row.statement_date || todayISO())}">
              </div>

              <div class="recon-field">
                <label>Real Balance</label>
                <input class="recon-input" type="number" step="0.01" data-recon-real="${esc(row.account_id)}" value="${esc(realValue)}" placeholder="Enter bank/wallet balance">
              </div>

              <div class="recon-field">
                <label>Notes</label>
                <input class="recon-input" type="text" data-recon-notes="${esc(row.account_id)}" value="${esc(row.notes || '')}" placeholder="Checked mobile app">
              </div>
            </div>

            <div class="recon-inline-actions">
              <button class="recon-action" type="button" data-dry-run-recon="${esc(row.account_id)}">Dry-run</button>
              <button class="recon-action primary" type="button" data-save-recon="${esc(row.account_id)}">Save Check</button>
              <a class="recon-action" href="/transactions.html?account=${encodeURIComponent(row.account_id)}">Open Ledger</a>
            </div>
          </div>
        </article>
      `;
    }).join('');

    bindRows();
  }

  function bindRows() {
    document.querySelectorAll('[data-toggle-recon]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-toggle-recon');
        const row = document.querySelector(`[data-account-id="${cssEscape(id)}"]`);
        if (!row) return;
        row.classList.toggle('is-open');
      });
    });

    document.querySelectorAll('[data-dry-run-recon]').forEach(button => {
      button.addEventListener('click', () => {
        saveReconciliation(button.getAttribute('data-dry-run-recon'), true);
      });
    });

    document.querySelectorAll('[data-save-recon]').forEach(button => {
      button.addEventListener('click', () => {
        saveReconciliation(button.getAttribute('data-save-recon'), false);
      });
    });
  }

  /* ─── Render exceptions ───────────────────────────────────────────────── */

  function renderExceptions() {
    const panel = $('exceptionPanel');
    if (!panel) return;

    const exceptions = state.exceptions || [];

    setText('exceptionTitle', exceptions.length ? `${exceptions.length} need review` : 'No exceptions');
    setText('exceptionSub', exceptions.length
      ? 'Non-zero balance differences.'
      : 'No account differences found.');

    if (!exceptions.length) {
      panel.innerHTML = '<div class="recon-empty">No exceptions. Matched accounts or pending statements only.</div>';
      return;
    }

    panel.innerHTML = exceptions.map(row => `
      <div class="recon-empty">
        <strong>${esc(row.account_name)}</strong><br>
        Difference: ${esc(money(row.difference))}<br>
        ${esc(recommendation(row))}
      </div>
    `).join('');
  }

  /* ─── Render raw ──────────────────────────────────────────────────────── */

  function renderRaw() {
    const raw = $('reconRaw');
    if (raw) raw.textContent = JSON.stringify(state.payload || {}, null, 2);
  }

  /* ─── Render all ──────────────────────────────────────────────────────── */

  function renderAll(payload) {
    state.payload = payload || {};
    state.rows = Array.isArray(payload.rows) ? payload.rows : [];
    state.exceptions = Array.isArray(payload.exceptions) ? payload.exceptions : [];

    renderKpis(payload.summary || {});
    renderRows();
    renderExceptions();
    renderRaw();

    setText('reconHealth', 'Health OK');
    setText('reconReviewChip', `${payload.summary?.needs_review_count || 0} need review`);
    setText('reconStatusDetail', `${state.rows.length} account${state.rows.length === 1 ? '' : 's'} loaded.`);
    setText('reconVersion', VERSION);
    setText('reconFooterVersion', `reconciliation.html · ${VERSION} · backend ${payload.version || 'unknown'}`);
  }

  /* ─── Build save payload ──────────────────────────────────────────────── */

  function payloadForAccount(accountId) {
    return {
      account_id: accountId,
      statement_date: document.querySelector(`[data-recon-date="${cssEscape(accountId)}"]`)?.value || todayISO(),
      real_balance: num(document.querySelector(`[data-recon-real="${cssEscape(accountId)}"]`)?.value, null),
      notes: document.querySelector(`[data-recon-notes="${cssEscape(accountId)}"]`)?.value || '',
      created_by: 'web-reconciliation-v0.1.0'
    };
  }

  /* ─── Save / dry-run ──────────────────────────────────────────────────── */

  async function saveReconciliation(accountId, dryRun) {
    const payload = payloadForAccount(accountId);

    if (payload.real_balance === null || Number.isNaN(payload.real_balance)) {
      toast('Enter real balance first.');
      return;
    }

    try {
      const result = await postJSON(`${API_RECON}${dryRun ? '?dry_run=1' : ''}`, payload);
      toast(dryRun ? `Dry-run: ${result.recommendation}` : 'Reconciliation saved.');

      if (!dryRun) {
        await loadReconciliation();
      }
    } catch (err) {
      toast(`${dryRun ? 'Dry-run' : 'Save'} failed: ${err.message}`);
    }
  }

  /* ─── Load ────────────────────────────────────────────────────────────── */

  async function loadReconciliation() {
    setText('reconHealth', 'Loading reconciliation');
    setText('reconStatusDetail', 'Reading account balances.');

    const list = $('reconList');
    if (list) list.innerHTML = '<div class="recon-empty">Loading accounts…</div>';

    try {
      const payload = await fetchJSON(API_RECON);
      renderAll(payload);
    } catch (err) {
      setText('reconHealth', 'Reconciliation unavailable');
      setText('reconStatusDetail', err.message);

      if (list) {
        list.innerHTML = `<div class="recon-empty">Reconciliation could not load: ${esc(err.message)}</div>`;
      }

      state.payload = { error: err.message };
      renderRaw();
    }
  }

  /* ─── Toast ───────────────────────────────────────────────────────────── */

  function toast(message) {
    const el = $('reconToast');
    if (!el) return;

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  /* ─── Init ────────────────────────────────────────────────────────────── */

  function init() {
    $('refreshReconBtn')?.addEventListener('click', loadReconciliation);
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
