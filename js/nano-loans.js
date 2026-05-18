/* js/nano-loans.js
 * Sovereign Finance · Nano Loans Frontend Binding
 * v0.2.0-nano-loans-frontend-binding
 *
 * Contract:
 * - Frontend does not calculate authoritative balances.
 * - Frontend submits nano-loan intent only.
 * - Backend owns loan liability and ledger rows.
 * - Nano loan principal is borrowed money, not income.
 * - Shared shell only: this file renders sf-* rows/cards into existing containers.
 */

(function () {
  "use strict";

  if (window.SovereignNanoLoans && window.SovereignNanoLoans.initialized) return;

  const VERSION = "v0.2.0-nano-loans-frontend-binding";
  const API_NANO = "/api/nano-loans";
  const API_BALANCES = "/api/balances";

  const state = {
    payload: null,
    health: null,
    balances: null,
    submitting: false
  };

  const $ = id => document.getElementById(id);

  function components() {
    return window.SFComponents || {};
  }

  function esc(value) {
    const c = components();

    if (typeof c.escapeHtml === "function") {
      return c.escapeHtml(value);
    }

    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const c = components();

    if (typeof c.money === "function") {
      return c.money(value, { maximumFractionDigits: 2 });
    }

    const n = Number(value);
    if (!Number.isFinite(n)) return "—";

    return "Rs " + n.toLocaleString("en-PK", {
      maximumFractionDigits: 2,
      minimumFractionDigits: n % 1 === 0 ? 0 : 2
    });
  }

  function percent(value) {
    const c = components();

    if (typeof c.percent === "function") return c.percent(value);

    const n = Number(value);
    if (!Number.isFinite(n)) return "—";

    return n.toFixed(n % 1 === 0 ? 0 : 1) + "%";
  }

  function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? "" : String(value);
  }

  function setValue(id, value) {
    const el = $(id);
    if (el && !el.value) el.value = value == null ? "" : String(value);
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  function setPill(id, label, tone) {
    const el = $(id);
    if (!el) return;

    el.textContent = label == null ? "" : String(label);
    el.className = "sf-pill" + (tone ? " sf-pill--" + tone : "");
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(options && options.headers ? options.headers : {})
      },
      ...(options || {})
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || "HTTP " + response.status);
    }

    return data;
  }

  function accountId(account) {
    return account && (account.id || account.account_id) || "";
  }

  function accountName(account) {
    return account && (account.name || account.account_name || account.label || accountId(account)) || "Account";
  }

  function accountLabel(account) {
    if (!account) return "—";
    return `${account.icon || ""} ${accountName(account)}`.trim();
  }

  function getAccountBalance(accountIdValue) {
    if (!state.balances || !state.balances.accounts) return null;

    const row = state.balances.accounts[accountIdValue];
    if (!row) return null;

    return row.balance ?? row.current_balance ?? row.amount ?? null;
  }

  function sourceAccounts() {
    const payload = state.payload || {};

    if (Array.isArray(payload.source_accounts)) {
      return payload.source_accounts;
    }

    if (Array.isArray(payload.accounts)) {
      return payload.accounts.filter(account => String(account.type || "").toLowerCase() === "asset");
    }

    return [];
  }

  function fillAccountSelect(id, accounts, fallbackLabel) {
    const select = $(id);
    if (!select) return;

    const current = select.value;

    select.innerHTML = [
      `<option value="">${esc(fallbackLabel || "Select account")}</option>`
    ].concat(accounts.map(account => {
      const idValue = accountId(account);
      const balance = getAccountBalance(idValue);
      const suffix = balance == null ? "" : ` · ${money(balance)}`;

      return `<option value="${esc(idValue)}">${esc(accountLabel(account) + suffix)}</option>`;
    })).join("");

    if (current) select.value = current;
  }

  function activeLoans() {
    const payload = state.payload || {};
    if (Array.isArray(payload.active_loans)) return payload.active_loans;
    if (Array.isArray(payload.loans)) {
      return payload.loans.filter(loan => String(loan.status || "").toLowerCase() === "active");
    }
    return [];
  }

  function closedLoans() {
    const payload = state.payload || {};
    if (Array.isArray(payload.closed_loans)) return payload.closed_loans;
    if (Array.isArray(payload.loans)) {
      return payload.loans.filter(loan => String(loan.status || "").toLowerCase() === "closed");
    }
    return [];
  }

  function summary() {
    const payload = state.payload || {};
    return payload.summary || {};
  }

  function renderKpis() {
    const s = summary();
    const h = state.health || {};
    const healthStatus = h.status || "unknown";

    setText("nano-kpi-active-count", s.active_count ?? activeLoans().length);
    setText("nano-kpi-remaining", money(s.remaining ?? s.nano_loan_outstanding ?? 0));
    setText("nano-kpi-total-owed", money(s.total_owed ?? 0));
    setText("nano-kpi-repaid", money(s.total_repaid ?? 0));
    setText("nano-kpi-cooloff", money(s.cool_off_fees ?? 0));
    setText("nano-kpi-health", healthStatus);

    setPill(
      "nano-source-status",
      state.payload ? `Nano API ${state.payload.version || "loaded"}` : "Loading",
      state.payload ? "positive" : "info"
    );

    setPill(
      "nano-health-status",
      healthStatus === "pass" ? "Health PASS" : `Health ${healthStatus}`,
      healthStatus === "pass" ? "positive" : "warning"
    );

    if (window.SFShell && typeof window.SFShell.setKpis === "function") {
      window.SFShell.setKpis([
        {
          title: "Active Loans",
          kicker: "Nano Loans",
          valueHtml: String(s.active_count ?? activeLoans().length),
          subtitle: "Open liability records",
          foot: "Source: /api/nano-loans",
          tone: "info"
        },
        {
          title: "Outstanding",
          kicker: "Nano Liability",
          valueHtml: money(s.remaining ?? s.nano_loan_outstanding ?? 0),
          subtitle: "Not income; borrowed principal/fees",
          foot: "True burden input",
          tone: asNumber(s.remaining ?? s.nano_loan_outstanding, 0) > 0 ? "warning" : "positive"
        },
        {
          title: "Total Owed",
          kicker: "Contract",
          valueHtml: money(s.total_owed ?? 0),
          subtitle: "Principal + fees",
          foot: "Active loans only",
          tone: "warning"
        },
        {
          title: "Health",
          kicker: "Backend",
          valueHtml: healthStatus.toUpperCase(),
          subtitle: "nano_loans.health",
          foot: "Read-only check",
          tone: healthStatus === "pass" ? "positive" : "warning"
        }
      ]);
    }
  }

  function loanRemaining(loan) {
    if (loan.remaining_amount != null) return asNumber(loan.remaining_amount, 0);

    return Math.max(
      0,
      asNumber(loan.total_owed, 0) - asNumber(loan.repaid_amount, 0)
    );
  }

  function loanProgress(loan) {
    if (loan.progress_pct != null) return asNumber(loan.progress_pct, 0);

    const total = asNumber(loan.total_owed, 0);
    if (total <= 0) return 0;

    return Math.max(0, Math.min(100, (asNumber(loan.repaid_amount, 0) / total) * 100));
  }

  function loanTitle(loan) {
    return loan.app_name || loan.app_code || loan.name || loan.id || "Nano Loan";
  }

  function loanMeta(loan) {
    return [
      loan.date || "",
      loan.source_account_id ? `source ${loan.source_account_id}` : "",
      loan.shape ? `shape ${loan.shape}` : "",
      loan.cool_off_due ? `due ${loan.cool_off_due}` : ""
    ].filter(Boolean).join(" · ");
  }

  function loanRowHtml(loan, options) {
    const opts = options || {};
    const remaining = loanRemaining(loan);
    const progress = loanProgress(loan);
    const isClosed = String(loan.status || "").toLowerCase() === "closed";

    return `
      <div class="sf-finance-row" data-loan-id="${esc(loan.id || "")}">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(loanTitle(loan))}</div>
          <div class="sf-row-subtitle">${esc(loanMeta(loan))}</div>
          <div class="sf-row-subtitle">
            Principal ${esc(money(loan.principal_amount))} · Owed ${esc(money(loan.total_owed))} · Repaid ${esc(money(loan.repaid_amount))}
          </div>
          <div class="sf-row-subtitle">Progress ${esc(percent(progress))}</div>
          ${
            opts.actions && !isClosed
              ? `<div class="sf-section-meta">
                  <button class="sf-button" type="button" data-nano-action="repay" data-loan-id="${esc(loan.id || "")}">Repay</button>
                </div>`
              : ""
          }
        </div>
        <div class="sf-row-right ${remaining > 0 ? "sf-tone-warning" : "sf-tone-positive"}">
          ${money(remaining)}
          <div class="sf-row-subtitle">${esc(isClosed ? "closed" : "remaining")}</div>
        </div>
      </div>
    `;
  }

  function emptyState(title, subtitle) {
    const c = components();

    if (typeof c.emptyState === "function") {
      return c.emptyState({ title, subtitle });
    }

    return `
      <div class="sf-empty-state">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(subtitle || "")}</p>
        </div>
      </div>
    `;
  }

  function loadingState(title, subtitle) {
    const c = components();

    if (typeof c.loadingState === "function") {
      return c.loadingState({ title, subtitle });
    }

    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(subtitle || "")}</p>
        </div>
      </div>
    `;
  }

  function errorState(title, message) {
    const c = components();

    if (typeof c.errorState === "function") {
      return c.errorState({ title, message });
    }

    return `
      <div class="sf-empty-state sf-tone-danger">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(message || "")}</p>
        </div>
      </div>
    `;
  }

  function renderLoanLists() {
    const active = activeLoans();
    const closed = closedLoans();

    setHTML(
      "nano-active-list",
      active.length
        ? active.map(loan => loanRowHtml(loan, { actions: true })).join("")
        : emptyState("No active nano loans", "No active nano-loan liability records are currently open.")
    );

    setHTML(
      "nano-closed-list",
      closed.length
        ? closed.map(loan => loanRowHtml(loan, { actions: false })).join("")
        : emptyState("No closed nano loans", "Closed nano loans will appear here after repayment.")
    );
  }

  function renderHealth() {
    if (!state.health) {
      setHTML("nano-health-output", loadingState("Health loading", "Reading /api/nano-loans?action=health."));
      return;
    }

    const status = state.health.status || "unknown";
    const counts = state.health.counts || {};
    const checks = state.health.checks || {};

    const rows = [
      ["Status", status],
      ["Loans", counts.loans ?? "—"],
      ["Active", counts.active_loans ?? "—"],
      ["Closed", counts.closed_loans ?? "—"],
      ["Origin rows exist", checks.origin_rows_exist],
      ["Origin amounts match", checks.origin_amounts_match_principal],
      ["Repayment sums match", checks.repayment_sums_match],
      ["Status consistent", checks.loan_status_consistent_with_remaining],
      ["Push to CC guarded", checks.push_to_cc_guarded]
    ];

    setHTML(
      "nano-health-output",
      rows.map(([label, value]) => `
        <div class="sf-dense-row">
          <span>${esc(label)}</span>
          <strong class="${value === true || value === "pass" ? "sf-tone-positive" : value === false ? "sf-tone-danger" : ""}">
            ${esc(String(value))}
          </strong>
        </div>
      `).join("")
    );

    if (status !== "pass") {
      setText("nano-health-debug-output", JSON.stringify(state.health, null, 2));
    }
  }

  function renderDebug() {
    const debug = {
      page_version: VERSION,
      endpoint: API_NANO,
      balance_endpoint: API_BALANCES,
      contract: {
        principal_received_is_income: false,
        backend_write_owner: "/api/nano-loans",
        liability_source: "nano_loans",
        account_balance_source: "transactions_canonical",
        push_to_cc_guarded_until_cc_contract: true
      },
      payload: state.payload,
      health: state.health,
      balances: state.balances
    };

    setText("nano-debug-output", JSON.stringify(debug, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function applyDefaults() {
    const defaults = state.payload && state.payload.defaults || {};

    setValue("nano-source-account", defaults.source_account_id || "easypaisa");
    setValue("nano-date", todayISO());
    setValue("nano-shape", "A");
  }

  function readCreateForm() {
    return {
      app_name: $("nano-app-name") ? $("nano-app-name").value.trim() : "",
      app_code: $("nano-app-code") ? $("nano-app-code").value.trim() : "",
      source_account_id: $("nano-source-account") ? $("nano-source-account").value : "",
      principal_amount: $("nano-principal") ? asNumber($("nano-principal").value, 0) : 0,
      cool_off_fee: $("nano-cooloff-fee") ? asNumber($("nano-cooloff-fee").value, 0) : 0,
      total_owed: $("nano-total-owed") ? asNumber($("nano-total-owed").value, 0) : 0,
      shape: $("nano-shape") ? $("nano-shape").value : "A",
      cool_off_due: $("nano-cooloff-due") ? $("nano-cooloff-due").value : "",
      date: $("nano-date") && $("nano-date").value ? $("nano-date").value : todayISO(),
      notes: $("nano-notes") ? $("nano-notes").value.trim() : "",
      created_by: "web-nano-loans",
      idempotency_key: "nano_" + Date.now()
    };
  }

  function normalizeCreatePayload(payload) {
    const out = { ...payload };

    if (!out.total_owed || out.total_owed < out.principal_amount) {
      out.total_owed = asNumber(out.principal_amount, 0) + asNumber(out.cool_off_fee, 0);
    }

    return out;
  }

  function validateCreatePayload(payload) {
    if (!payload.app_name) return "App/lender name is required.";
    if (!payload.source_account_id) return "Source account is required.";
    if (!Number.isFinite(Number(payload.principal_amount)) || Number(payload.principal_amount) <= 0) {
      return "Principal amount must be greater than 0.";
    }
    if (!Number.isFinite(Number(payload.cool_off_fee)) || Number(payload.cool_off_fee) < 0) {
      return "Cool-off fee cannot be negative.";
    }
    if (!Number.isFinite(Number(payload.total_owed)) || Number(payload.total_owed) < Number(payload.principal_amount)) {
      return "Total owed cannot be less than principal.";
    }
    if (!payload.date) return "Date is required.";

    return "";
  }

  async function submitCreate(event) {
    if (event) event.preventDefault();
    if (state.submitting) return;

    const payload = normalizeCreatePayload(readCreateForm());
    const error = validateCreatePayload(payload);

    if (error) {
      showResult(false, error);
      return;
    }

    state.submitting = true;
    setDisabled("nano-submit", true);
    setText("nano-submit-label", "Saving…");
    showResult(true, "Submitting nano-loan liability…");

    try {
      const response = await fetchJSON(API_NANO, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      showResult(true, buildCreateSuccess(response));
      clearCreateForm();
      await loadAll();
    } catch (err) {
      showResult(false, err.message || String(err));
    } finally {
      state.submitting = false;
      setDisabled("nano-submit", false);
      setText("nano-submit-label", "Create nano loan");
    }
  }

  function buildCreateSuccess(response) {
    return [
      "Nano loan recorded.",
      response.loan_id ? `Loan: ${response.loan_id}` : "",
      response.txn_in_id ? `Ledger: ${response.txn_in_id}` : "",
      response.liability ? `Outstanding: ${money(response.liability.remaining_amount)}` : ""
    ].filter(Boolean).join(" ");
  }

  function clearCreateForm() {
    ["nano-app-name", "nano-app-code", "nano-principal", "nano-cooloff-fee", "nano-total-owed", "nano-cooloff-due", "nano-notes"].forEach(id => {
      const el = $(id);
      if (el) el.value = "";
    });
  }

  async function repayLoan(loanId) {
    const loan = activeLoans().find(row => String(row.id) === String(loanId));
    if (!loan) {
      showResult(false, "Loan not found in active list.");
      return;
    }

    const amountInput = window.prompt(
      `Repay amount for ${loanTitle(loan)}. Remaining: ${money(loanRemaining(loan))}`,
      String(loanRemaining(loan))
    );

    if (amountInput == null) return;

    const amount = asNumber(amountInput, 0);

    if (!(amount > 0)) {
      showResult(false, "Repay amount must be greater than 0.");
      return;
    }

    const accountId = loan.source_account_id || "easypaisa";

    showResult(true, "Submitting nano-loan repayment…");

    try {
      const response = await fetchJSON(`${API_NANO}/${encodeURIComponent(loanId)}/repay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount,
          account_id: accountId,
          date: todayISO(),
          notes: "[NANO_LOAN_REPAY] frontend repayment",
          created_by: "web-nano-loans",
          idempotency_key: "nano_repay_" + Date.now()
        })
      });

      showResult(true, buildRepaySuccess(response));
      await loadAll();
    } catch (err) {
      showResult(false, err.message || String(err));
    }
  }

  function buildRepaySuccess(response) {
    return [
      "Nano loan repayment recorded.",
      response.repay_txn_id ? `Ledger: ${response.repay_txn_id}` : "",
      response.remaining != null ? `Remaining: ${money(response.remaining)}` : "",
      response.status ? `Status: ${response.status}` : ""
    ].filter(Boolean).join(" ");
  }

  function showResult(ok, message) {
    const el = $("nano-result");
    if (!el) return;

    el.hidden = false;
    el.className = "sf-debug-text " + (ok ? "sf-tone-positive" : "sf-tone-danger");
    el.textContent = message;
  }

  function bindEvents() {
    const form = $("nano-form");

    if (form) {
      form.addEventListener("submit", submitCreate);
    }

    const submit = $("nano-submit");
    if (submit) {
      submit.addEventListener("click", submitCreate);
    }

    const refresh = $("nano-refresh");
    if (refresh) {
      refresh.addEventListener("click", loadAll);
    }

    document.addEventListener("click", function (event) {
      const btn = event.target.closest("[data-nano-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-nano-action");
      const loanId = btn.getAttribute("data-loan-id");

      if (action === "repay" && loanId) {
        repayLoan(loanId);
      }
    });
  }

  async function loadAll() {
    setPill("nano-source-status", "Loading", "info");
    setHTML("nano-active-list", loadingState("Loading active loans", "Reading /api/nano-loans."));
    setHTML("nano-closed-list", loadingState("Loading closed loans", "Reading /api/nano-loans."));
    setHTML("nano-health-output", loadingState("Loading health", "Reading /api/nano-loans?action=health."));

    try {
      const [payloadResult, healthResult, balancesResult] = await Promise.allSettled([
        fetchJSON(API_NANO),
        fetchJSON(API_NANO + "?action=health"),
        fetchJSON(API_BALANCES)
      ]);

      if (payloadResult.status === "fulfilled") {
        state.payload = payloadResult.value;
      } else {
        throw payloadResult.reason;
      }

      state.health = healthResult.status === "fulfilled" ? healthResult.value : null;
      state.balances = balancesResult.status === "fulfilled" ? balancesResult.value : null;

      fillAccountSelect("nano-source-account", sourceAccounts(), "Source account");
      applyDefaults();
      renderKpis();
      renderLoanLists();
      renderHealth();
      renderDebug();
    } catch (err) {
      state.payload = null;
      state.health = null;

      setPill("nano-source-status", "Nano API failed", "danger");
      setHTML("nano-active-list", errorState("Nano Loans API failed", err.message || String(err)));
      setHTML("nano-closed-list", errorState("Closed loans unavailable", "Could not load Nano Loans API."));
      setHTML("nano-health-output", errorState("Health unavailable", "Could not load Nano Loans health."));
    }
  }

  function init() {
    window.SovereignNanoLoans = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      submitCreate,
      repayLoan,
      payload: () => state.payload,
      health: () => state.health,
      balances: () => state.balances
    };

    setText("nano-js-version", VERSION);
    setText("nano-footer-version", `v0.2.0 · Nano Loans · ${VERSION}`);

    bindEvents();
    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
