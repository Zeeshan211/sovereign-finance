(function () {
  "use strict";

  if (window.SovereignAdd && window.SovereignAdd.initialized) return;

  const VERSION = "v1.0.0-add-orchestrator-ui";

  const DIRECT_MODES = new Set(["expense", "income", "transfer"]);

  const MODE_MAP = {
    expense: { label: "Expense", kind: "direct", backend: "expense", ownerUrl: null },
    income: { label: "Income", kind: "direct", backend: "income", ownerUrl: null },
    transfer: { label: "Transfer", kind: "direct", backend: "transfer", ownerUrl: null },

    salary: { label: "Salary Income", kind: "advisory", backend: "salary_income", ownerUrl: "/salary.html" },
    international: { label: "International Purchase", kind: "advisory", backend: "international_purchase", ownerUrl: null },

    bill_payment: { label: "Bill Payment", kind: "routed", backend: "bill_payment", ownerUrl: "/bills.html" },
    debt_given: { label: "Debt Given", kind: "routed", backend: "debt_given", ownerUrl: "/debts.html" },
    debt_received: { label: "Debt Received", kind: "routed", backend: "debt_received", ownerUrl: "/debts.html" },
    cc_payment: { label: "CC Payment", kind: "routed", backend: "cc_payment", ownerUrl: "/cc.html" },
    cc_spend: { label: "CC Spend", kind: "routed", backend: "cc_spend", ownerUrl: "/cc.html" },
    atm_withdrawal: { label: "ATM Withdrawal", kind: "routed", backend: "atm_withdrawal", ownerUrl: "/atm.html" }
  };

  const state = {
    context: null,
    accounts: [],
    categories: [],
    merchants: [],
    selectedMode: "expense",
    preview: null,
    dryRun: null,
    save: null,
    dirtySinceDryRun: false,
    loading: false,
    errors: {}
  };

  const $ = (id) => document.getElementById(id);

  function sf() {
    return window.SFComponents || {};
  }

  function esc(value) {
    if (typeof sf().escapeHtml === "function") return sf().escapeHtml(value);
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (typeof sf().money === "function") {
      return sf().money(n, { maximumFractionDigits: 2 });
    }
    return "Rs " + n.toLocaleString("en-PK", {
      maximumFractionDigits: 2,
      minimumFractionDigits: n % 1 === 0 ? 0 : 2
    });
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? "" : String(value);
  }

  function setDisabled(id, disabled) {
    const el = $(id);
    if (el) el.disabled = !!disabled;
  }

  function setPill(id, label, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = label || "";
    el.className = "sf-pill" + (tone ? " sf-pill--" + tone : "");
  }

  async function getJSON(url) {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" }
    });

    const json = await res.json().catch(() => null);

    if (!res.ok || !json || json.ok === false) {
      throw new Error((json && json.error) || "HTTP " + res.status);
    }

    return json;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body || {})
    });

    const json = await res.json().catch(() => null);

    if (!res.ok || !json || json.ok === false) {
      const err = new Error((json && json.error) || "HTTP " + res.status);
      err.status = res.status;
      err.payload = json;
      throw err;
    }

    return json;
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function selectedModeSpec() {
    return MODE_MAP[state.selectedMode] || MODE_MAP.expense;
  }

  function canonicalMode() {
    return selectedModeSpec().backend;
  }

  function isDirectMode() {
    return DIRECT_MODES.has(canonicalMode());
  }

  function readForm() {
    return {
      mode: canonicalMode(),
      date: $("add-date")?.value || today(),
      amount: Number($("add-amount")?.value || 0),
      account_id: $("add-account")?.value || "",
      transfer_to_account_id: $("add-destination-account")?.value || "",
      category_id: $("add-category")?.value || "",
      merchant: $("add-merchant")?.value || "",
      reference: $("add-reference")?.value || "",
      notes: $("add-notes")?.value || ""
    };
  }

  function validateLocal(payload) {
    const errors = [];
    const spec = selectedModeSpec();

    if (!state.context?.can_direct_write && spec.kind === "direct") {
      errors.push("Live accounts/categories are required before direct save.");
    }

    if (!payload.date) errors.push("Date is required.");
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      errors.push("Amount must be greater than zero.");
    }

    if (spec.kind === "direct") {
      if (!payload.account_id) errors.push("Source account is required.");

      if (payload.mode === "transfer") {
        if (!payload.transfer_to_account_id) errors.push("Destination account is required for transfer.");
        if (payload.account_id && payload.transfer_to_account_id && payload.account_id === payload.transfer_to_account_id) {
          errors.push("Source and destination accounts cannot match.");
        }
      } else if (!payload.category_id) {
        errors.push("Category is required for expense/income.");
      }
    }

    return errors;
  }

  function accountLabel(id) {
    const account = state.accounts.find((a) => String(a.id) === String(id));
    return account ? `${account.name || account.id}` : id || "—";
  }

  function categoryLabel(id) {
    const category = state.categories.find((c) => String(c.id) === String(id));
    return category ? `${category.name || category.id}` : id || "—";
  }

  function row(title, subtitle, value, tone) {
    return `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(title)}</div>
          ${subtitle ? `<div class="sf-row-subtitle">${esc(subtitle)}</div>` : ""}
        </div>
        <div class="sf-row-right ${tone ? `sf-tone-${esc(tone)}` : ""}">
          ${value == null ? "—" : value}
        </div>
      </div>
    `;
  }

  function empty(title, subtitle) {
    if (typeof sf().emptyState === "function") return sf().emptyState({ title, subtitle });
    return `
      <div class="sf-empty-state">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(subtitle || "")}</p>
        </div>
      </div>
    `;
  }

  function errorBlock(title, message) {
    if (typeof sf().errorState === "function") return sf().errorState({ title, message });
    return `
      <div class="sf-empty-state sf-tone-danger">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(message || "")}</p>
        </div>
      </div>
    `;
  }

  function populateSelects() {
    const accountOptions = [
      `<option value="">Select account…</option>`,
      ...state.accounts.map((a) => {
        const label = `${a.name || a.id} · ${a.kind || a.type || "account"}`;
        return `<option value="${esc(a.id)}">${esc(label)}</option>`;
      })
    ].join("");

    const categoryOptions = [
      `<option value="">Select category…</option>`,
      ...state.categories.map((c) => {
        const label = `${c.name || c.id}${c.type ? " · " + c.type : ""}`;
        return `<option value="${esc(c.id)}">${esc(label)}</option>`;
      })
    ].join("");

    setHTML("add-account", accountOptions);
    setHTML("add-destination-account", accountOptions);
    setHTML("add-category", categoryOptions);
  }

  function renderSourceState() {
    const status = state.context?.source_status || {};
    const canWrite = !!state.context?.can_direct_write;

    setPill("add-source-overall", canWrite ? "Ready" : "Blocked", canWrite ? "positive" : "danger");

    setHTML("add-source-list", [
      row("/api/accounts", status.accounts || "unknown", state.accounts.length + " loaded", status.accounts === "ok" ? "positive" : "danger"),
      row("/api/categories", status.categories || "unknown", state.categories.length + " loaded", status.categories === "ok" ? "positive" : "danger"),
      row("/api/merchants", status.merchants || "optional", state.merchants.length + " loaded", status.merchants === "ok" ? "positive" : "info")
    ].join(""));
  }

  function renderKpis() {
    const spec = selectedModeSpec();
    const sourcesReady = !!state.context?.can_direct_write;

    setText("add-kpi-mode", spec.label);
    setText("add-kpi-sources", sourcesReady ? "Ready" : "Blocked");
    setText("add-kpi-sources-sub", sourcesReady ? "Accounts + categories loaded" : "Live sources required");
    setText("add-kpi-dryrun", state.dryRun?.ok ? "Passed" : state.dryRun ? "Failed" : "Not run");
    setText("add-kpi-save", state.save?.ok ? "Saved" : canSave() ? "Ready" : "Blocked");

    setPill("add-selected-mode-pill", spec.label, spec.kind === "direct" ? "info" : spec.kind === "routed" ? "warning" : "info");
    setPill("add-route-pill", spec.kind === "direct" ? "Direct save" : spec.kind === "routed" ? "Routed" : "Advisory", spec.kind === "direct" ? "positive" : "warning");
  }

  function renderMode() {
    document.querySelectorAll("[data-add-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-add-mode") === state.selectedMode);
    });

    const destinationField = $("add-destination-field");
    if (destinationField) destinationField.hidden = canonicalMode() !== "transfer";

    const category = $("add-category");
    if (category) category.disabled = canonicalMode() === "transfer";

    renderKpis();
  }

  function renderSmartAssist() {
    const payload = readForm();
    const spec = selectedModeSpec();
    const items = [];

    if (payload.merchant) {
      const matched = state.merchants.find((m) => {
        const hay = [
          m.name,
          m.merchant,
          m.label,
          ...(Array.isArray(m.aliases) ? m.aliases : [])
        ].filter(Boolean).join(" ").toLowerCase();

        return hay.includes(payload.merchant.toLowerCase()) || payload.merchant.toLowerCase().includes(String(m.name || "").toLowerCase());
      });

      if (matched) {
        items.push(row(
          "Merchant suggestion",
          `${matched.name || matched.merchant || "Matched merchant"}${matched.default_category_id ? " · " + matched.default_category_id : ""}`,
          "Review",
          "info"
        ));
      } else {
        items.push(row("Merchant", "No stored merchant match yet", "Manual", "info"));
      }
    }

    if ((canonicalMode() === "income" || canonicalMode() === "salary_income") && payload.amount >= 50000) {
      items.push(row(
        "Salary detector",
        "Looks like salary-sized income. Record income here; salary source updates belong to Salary.",
        "Advisory",
        "warning"
      ));
    }

    if (state.selectedMode === "international") {
      items.push(row(
        "International preview",
        "Package writer is not enabled yet. Use preview only; no multi-row save from Add.",
        "Preview",
        "warning"
      ));
    }

    if (spec.kind === "routed") {
      items.push(row(
        "Owner workflow",
        `${spec.label} is routed to its owner page to preserve linked records.`,
        "Route",
        "warning"
      ));
    }

    if (!items.length) {
      setHTML("add-smart-assist", empty("No suggestions yet", "Enter merchant, amount, or choose an advisory/routed mode."));
      return;
    }

    setHTML("add-smart-assist", items.join(""));
  }

  function renderReview() {
    const payload = readForm();
    const spec = selectedModeSpec();
    const errors = validateLocal(payload);

    if (spec.kind === "routed") {
      setHTML("add-review-panel", [
        row("Mode", "Routed advanced workflow", spec.label, "warning"),
        row("Owner page", "No write from Add in this shipment", `<a class="sf-button" href="${esc(spec.ownerUrl)}">Open</a>`, "info")
      ].join(""));
      return;
    }

    if (spec.kind === "advisory") {
      setHTML("add-review-panel", [
        row("Mode", "Advisory only", spec.label, "warning"),
        row("Backend mode", "Preview only unless switched to direct mode", canonicalMode(), "info"),
        row("Amount", "Input amount", money(payload.amount), "info")
      ].join(""));
      return;
    }

    const expected = payload.mode === "transfer"
      ? "linked transfer movement"
      : "1 transaction row";

    const html = [
      row("Mode", "Direct save through /api/add", spec.label, "positive"),
      row("Endpoint", "Backend orchestrator", "/api/add/dry-run → /api/add/commit", "info"),
      row("Date", "Transaction date", payload.date, "info"),
      row("Amount", "Positive amount", money(payload.amount), "info"),
      row("Source account", payload.account_id, accountLabel(payload.account_id), "info"),
      payload.mode === "transfer"
        ? row("Destination account", payload.transfer_to_account_id, accountLabel(payload.transfer_to_account_id), "info")
        : row("Category", payload.category_id, categoryLabel(payload.category_id), "info"),
      row("Expected ledger shape", "Backend remains final truth", expected, "info")
    ];

    if (errors.length) {
      html.push(row("Blocked", errors.join(" · "), "Fix", "danger"));
    }

    setHTML("add-review-panel", html.join(""));
  }

  function renderDryRun() {
    if (!state.dryRun) {
      setHTML("add-dryrun-panel", empty("Dry-run not run", "Build a valid direct-mode payload first."));
      return;
    }

    if (!state.dryRun.ok) {
      setHTML("add-dryrun-panel", errorBlock("Dry-run failed", state.dryRun.error || "Backend rejected payload."));
      return;
    }

    setHTML("add-dryrun-panel", [
      row("Dry-run", "Backend validation", "Passed", "positive"),
      row("Writes performed", "Must be false", String(state.dryRun.writes_performed), state.dryRun.writes_performed === false ? "positive" : "danger"),
      row("Payload hash", "Required for commit", state.dryRun.payload_hash ? state.dryRun.payload_hash.slice(0, 12) + "…" : "Missing", state.dryRun.payload_hash ? "positive" : "danger"),
      row("Route", "Owner writer", state.dryRun.route || "transactions", "info")
    ].join(""));
  }

  function renderSave() {
    if (state.save?.ok) {
      setHTML("add-save-panel", [
        row("Save", "Backend commit", "Saved", "positive"),
        row("Ledger", "Review written rows", `<a class="sf-button" href="/transactions.html">Open Ledger</a>`, "info"),
        row("Again", "Reset form for another entry", `<button class="sf-button" type="button" id="add-another">Add Another</button>`, "info")
      ].join(""));

      const again = $("add-another");
      if (again) again.addEventListener("click", resetForm);
      return;
    }

    if (state.dryRun?.ok && !state.dirtySinceDryRun) {
      setHTML("add-save-panel", [
        row("Save ready", "Dry-run passed and payload is unchanged", "Ready", "positive"),
        row("Commit rule", "Commit requires payload hash", "Locked", "positive")
      ].join(""));
      return;
    }

    setHTML("add-save-panel", empty("Save blocked", state.dirtySinceDryRun ? "Form changed after dry-run. Run dry-run again." : "Run backend dry-run first."));
  }

  function renderDebug() {
    setText("add-debug-output", JSON.stringify({
      version: VERSION,
      selectedMode: state.selectedMode,
      canonicalMode: canonicalMode(),
      context: state.context,
      preview: state.preview,
      dryRun: state.dryRun,
      save: state.save,
      dirtySinceDryRun: state.dirtySinceDryRun,
      form: readForm(),
      errors: state.errors
    }, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function canPreview() {
    const spec = selectedModeSpec();
    const payload = readForm();

    if (spec.kind === "routed" || spec.kind === "advisory") return true;

    return validateLocal(payload).length === 0;
  }

  function canDryRun() {
    return isDirectMode() && validateLocal(readForm()).length === 0;
  }

  function canSave() {
    return isDirectMode() && state.dryRun?.ok && !!state.dryRun.payload_hash && !state.dirtySinceDryRun;
  }

  function updateButtons() {
    setDisabled("add-run-dryrun", !canDryRun() || state.loading);
    setDisabled("add-confirm-save", !canSave() || state.loading);
  }

  function renderAll() {
    renderMode();
    renderSourceState();
    renderSmartAssist();
    renderReview();
    renderDryRun();
    renderSave();
    renderKpis();
    renderDebug();
    updateButtons();
  }

  async function loadContext() {
    setPill("add-source-overall", "Loading", "info");

    try {
      const context = await getJSON("/api/add/context");
      state.context = context;
      state.accounts = Array.isArray(context.accounts) ? context.accounts : [];
      state.categories = Array.isArray(context.categories) ? context.categories : [];
      state.merchants = Array.isArray(context.merchants) ? context.merchants : [];
      state.errors.context = null;

      populateSelects();
    } catch (err) {
      state.context = { can_direct_write: false, source_status: { accounts: "failed", categories: "failed", merchants: "failed" } };
      state.errors.context = err.message;
      setHTML("add-source-list", errorBlock("Add context failed", err.message));
    }

    renderAll();
  }

  async function runPreview() {
    const payload = readForm();

    try {
      state.preview = await postJSON("/api/add/preview", payload);
      state.errors.preview = null;
    } catch (err) {
      state.preview = null;
      state.errors.preview = err.message;
    }

    renderAll();
  }

  async function runDryRun() {
    if (!canDryRun()) {
      renderAll();
      return;
    }

    state.loading = true;
    state.dryRun = null;
    state.save = null;
    state.dirtySinceDryRun = false;
    setHTML("add-dryrun-panel", empty("Running dry-run", "Calling /api/add/dry-run."));
    renderKpis();
    updateButtons();

    try {
      const payload = readForm();
      state.dryRun = await postJSON("/api/add/dry-run", payload);
      state.errors.dryRun = null;
    } catch (err) {
      state.dryRun = {
        ok: false,
        error: err.message,
        response: err.payload || null
      };
      state.errors.dryRun = err.message;
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  async function confirmSave() {
    if (!canSave()) {
      renderAll();
      return;
    }

    state.loading = true;
    setHTML("add-save-panel", empty("Saving", "Calling /api/add/commit."));
    updateButtons();

    try {
      const payload = readForm();
      state.save = await postJSON("/api/add/commit", {
        ...payload,
        dry_run_payload_hash: state.dryRun.payload_hash
      });
      state.errors.save = null;
    } catch (err) {
      state.save = {
        ok: false,
        error: err.message,
        response: err.payload || null
      };
      state.errors.save = err.message;
      setHTML("add-save-panel", errorBlock("Save failed", err.message));
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  function invalidateDryRun() {
    if (state.dryRun && !state.save?.ok) {
      state.dirtySinceDryRun = true;
    }
    state.save = null;
    runPreview();
    renderAll();
  }

  function setMode(mode) {
    if (!MODE_MAP[mode]) mode = "expense";
    state.selectedMode = mode;
    state.preview = null;
    state.dryRun = null;
    state.save = null;
    state.dirtySinceDryRun = false;
    runPreview();
    renderAll();
  }

  function resetForm() {
    const form = $("add-form");
    if (form) form.reset();

    const date = $("add-date");
    if (date) date.value = today();

    state.preview = null;
    state.dryRun = null;
    state.save = null;
    state.dirtySinceDryRun = false;
    setMode("expense");
  }

  function bindEvents() {
    document.querySelectorAll("[data-add-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.getAttribute("data-add-mode")));
    });

    [
      "add-date",
      "add-amount",
      "add-account",
      "add-destination-account",
      "add-category",
      "add-merchant",
      "add-reference",
      "add-notes"
    ].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", invalidateDryRun);
      el.addEventListener("change", invalidateDryRun);
    });

    const dryRun = $("add-run-dryrun");
    if (dryRun) dryRun.addEventListener("click", runDryRun);

    const save = $("add-confirm-save");
    if (save) save.addEventListener("click", confirmSave);
  }

  function initDefaults() {
    const date = $("add-date");
    if (date && !date.value) date.value = today();
  }

  function init() {
    window.SovereignAdd = {
      initialized: true,
      version: VERSION,
      reload: loadContext,
      state: () => JSON.parse(JSON.stringify(state)),
      runDryRun,
      confirmSave
    };

    initDefaults();
    bindEvents();
    renderAll();
    loadContext().then(runPreview);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
