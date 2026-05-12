(function () {
  "use strict";

  if (window.SovereignAdd && window.SovereignAdd.initialized) return;

  const VERSION = "v1.2.0-add-four-mode-live-impact";

  const MODES = {
    expense: {
      label: "Expense",
      backend: "expense",
      kind: "direct",
      copy: "Expense decreases the selected source account and requires a category."
    },
    income: {
      label: "Income",
      backend: "income",
      kind: "direct",
      copy: "Income increases the selected account and requires a category."
    },
    transfer: {
      label: "Transfer",
      backend: "transfer",
      kind: "direct",
      copy: "Transfer moves money from source account to destination account. Category is not used."
    },
    international: {
      label: "International",
      backend: "international_purchase",
      kind: "preview",
      copy: "International shows package impact preview only until the backend package writer is shipped."
    }
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
    if (typeof sf().money === "function") return sf().money(n, { maximumFractionDigits: 2 });
    return "Rs " + n.toLocaleString("en-PK", {
      maximumFractionDigits: 2,
      minimumFractionDigits: n % 1 === 0 ? 0 : 2
    });
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? "" : String(value);
  }

  function setHidden(id, hidden) {
    const el = $(id);
    if (!el) return;
    el.hidden = !!hidden;
    el.style.display = hidden ? "none" : "";
    el.setAttribute("aria-hidden", String(!!hidden));
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

  function mode() {
    return MODES[state.selectedMode] || MODES.expense;
  }

  function backendMode() {
    return mode().backend;
  }

  function isDirectMode() {
    return mode().kind === "direct";
  }

  function isInternational() {
    return state.selectedMode === "international";
  }

  function accountId(account) {
    return account.id || account.account_id || "";
  }

  function accountName(account) {
    return account.name || account.label || account.account_name || accountId(account) || "Account";
  }

  function accountBalance(account) {
    return num(account.balance ?? account.current_balance ?? account.amount, 0);
  }

  function findAccount(id) {
    return state.accounts.find((account) => String(accountId(account)) === String(id));
  }

  function accountLabel(id) {
    const account = findAccount(id);
    return account ? accountName(account) : id || "—";
  }

  function categoryId(category) {
    return category.id || category.category_id || "";
  }

  function categoryName(category) {
    return category.name || category.label || categoryId(category) || "Category";
  }

  function findCategory(id) {
    return state.categories.find((category) => String(categoryId(category)) === String(id));
  }

  function categoryLabel(id) {
    const category = findCategory(id);
    return category ? categoryName(category) : id || "—";
  }

  function readForm() {
    return {
      mode: backendMode(),
      ui_mode: state.selectedMode,
      date: $("add-date")?.value || today(),
      amount: num($("add-amount")?.value, 0),
      account_id: $("add-account")?.value || "",
      transfer_to_account_id: $("add-destination-account")?.value || "",
      category_id: $("add-category")?.value || "",
      merchant: $("add-merchant")?.value || "",
      reference: $("add-reference")?.value || "",
      notes: $("add-notes")?.value || "",
      fx_fee: num($("add-fx-fee")?.value, 0),
      excise: num($("add-excise")?.value, 0),
      advance_tax: num($("add-advance-tax")?.value, 0),
      pra: num($("add-pra")?.value, 0)
    };
  }

  function internationalTotal(payload) {
    return num(payload.amount) +
      num(payload.fx_fee) +
      num(payload.excise) +
      num(payload.advance_tax) +
      num(payload.pra);
  }

  function effectiveImpactAmount(payload) {
    return isInternational() ? internationalTotal(payload) : payload.amount;
  }

  function validateLocal(payload) {
    const errors = [];

    if (isInternational()) {
      if (!payload.date) errors.push("Date is required.");
      if (!Number.isFinite(payload.amount) || payload.amount <= 0) errors.push("Base amount must be greater than zero.");
      if (!payload.account_id) errors.push("Account is required.");
      if (!payload.category_id) errors.push("Category is required.");
      return errors;
    }

    if (!state.context?.can_direct_write) {
      errors.push("Live accounts/categories are required before direct save.");
    }

    if (!payload.date) errors.push("Date is required.");
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) errors.push("Amount must be greater than zero.");
    if (!payload.account_id) errors.push("Source account is required.");

    if (payload.mode === "transfer") {
      if (!payload.transfer_to_account_id) errors.push("Destination account is required for transfer.");
      if (
        payload.account_id &&
        payload.transfer_to_account_id &&
        payload.account_id === payload.transfer_to_account_id
      ) {
        errors.push("Source and destination accounts cannot match.");
      }
    } else if (!payload.category_id) {
      errors.push("Category is required.");
    }

    return errors;
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
    const selectedAccount = $("add-account")?.value || "";
    const selectedDestination = $("add-destination-account")?.value || "";
    const selectedCategory = $("add-category")?.value || "";

    const accountOptions = [
      `<option value="">Select account…</option>`,
      ...state.accounts.map((account) => {
        const id = accountId(account);
        const label = `${accountName(account)} · ${account.kind || account.type || "account"} · ${money(accountBalance(account))}`;
        return `<option value="${esc(id)}">${esc(label)}</option>`;
      })
    ].join("");

    const categoryOptions = [
      `<option value="">Select category…</option>`,
      ...state.categories.map((category) => {
        const id = categoryId(category);
        const label = `${categoryName(category)}${category.type ? " · " + category.type : ""}`;
        return `<option value="${esc(id)}">${esc(label)}</option>`;
      })
    ].join("");

    setHTML("add-account", accountOptions);
    setHTML("add-destination-account", accountOptions);
    setHTML("add-category", categoryOptions);

    if ($("add-account")) $("add-account").value = selectedAccount;
    if ($("add-destination-account")) $("add-destination-account").value = selectedDestination;
    if ($("add-category")) $("add-category").value = selectedCategory;
  }

  function applyModeFields() {
    const currentMode = state.selectedMode;
    const transfer = currentMode === "transfer";
    const international = currentMode === "international";
    const expense = currentMode === "expense";
    const income = currentMode === "income";

    setHidden("add-destination-field", !transfer);
    setHidden("add-category-field", transfer);
    setHidden("add-international-fields", !international);

    const destination = $("add-destination-account");
    if (destination) {
      destination.disabled = !transfer;
      destination.required = transfer;
      if (!transfer) destination.value = "";
    }

    const category = $("add-category");
    if (category) {
      category.disabled = transfer;
      category.required = !transfer;
      if (transfer) category.value = "";
    }

    setText("add-account-label", transfer ? "Source account" : income ? "Receiving account" : "Source account");
    setText("add-account-help",
      transfer
        ? "Money leaves this account."
        : income
          ? "Money enters this account."
          : "Money leaves this account."
    );

    setText("add-merchant-label",
      income
        ? "Source / payer"
        : transfer
          ? "Transfer label"
          : international
            ? "Merchant"
            : "Merchant / person"
    );

    setText("add-form-copy", mode().copy);

    setPill("add-selected-mode-pill", mode().label, international ? "warning" : "positive");
    setPill("add-route-pill", international ? "Preview only" : "Direct save", international ? "warning" : "positive");

    document.querySelectorAll("[data-add-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.getAttribute("data-add-mode") === state.selectedMode);
    });

    if (expense || income || transfer || international) {
      setPill("add-form-status", "Waiting", "info");
    }
  }

  function renderSourceState() {
    const status = state.context?.source_status || {};
    const canWrite = !!state.context?.can_direct_write;

    setPill("add-source-overall", canWrite ? "Ready" : "Blocked", canWrite ? "positive" : "danger");

    setHTML("add-source-list", [
      row("/api/accounts", status.accounts || "unknown", `${state.accounts.length} loaded`, status.accounts === "ok" ? "positive" : "danger"),
      row("/api/categories", status.categories || "unknown", `${state.categories.length} loaded`, status.categories === "ok" ? "positive" : "danger"),
      row("/api/merchants", status.merchants || "optional", `${state.merchants.length} loaded`, status.merchants === "ok" ? "positive" : "info")
    ].join(""));
  }

  function renderLiveImpact() {
    const payload = readForm();
    const amount = effectiveImpactAmount(payload);

    if (!payload.account_id || !Number.isFinite(amount) || amount <= 0) {
      setHTML("add-live-impact", empty("Waiting for input", "Choose account and amount to preview the account impact."));
      return;
    }

    const source = findAccount(payload.account_id);
    if (!source) {
      setHTML("add-live-impact", errorBlock("Source account not found", "Reload the page or check /api/add/context."));
      return;
    }

    if (payload.mode === "transfer") {
      const destination = findAccount(payload.transfer_to_account_id);

      if (!payload.transfer_to_account_id || !destination) {
        setHTML("add-live-impact", [
          row(accountName(source), "Current source balance", money(accountBalance(source)), "info"),
          row("Change", "Transfer source impact", "- " + money(amount), "warning"),
          row("After", "Source after transfer", money(accountBalance(source) - amount), "warning"),
          row("Destination", "Select destination account", "Missing", "danger")
        ].join(""));
        return;
      }

      setHTML("add-live-impact", [
        row(accountName(source), "Current source balance", money(accountBalance(source)), "info"),
        row("Source change", "Money leaves source", "- " + money(amount), "warning"),
        row("Source after", "Preview only", money(accountBalance(source) - amount), "warning"),
        row(accountName(destination), "Current destination balance", money(accountBalance(destination)), "info"),
        row("Destination change", "Money enters destination", "+ " + money(amount), "positive"),
        row("Destination after", "Preview only", money(accountBalance(destination) + amount), "positive")
      ].join(""));
      return;
    }

    if (payload.mode === "income") {
      setHTML("add-live-impact", [
        row(accountName(source), "Current balance", money(accountBalance(source)), "info"),
        row("Change", "Income increases account", "+ " + money(amount), "positive"),
        row("After", "Preview only", money(accountBalance(source) + amount), "positive")
      ].join(""));
      return;
    }

    if (isInternational()) {
      setHTML("add-live-impact", [
        row(accountName(source), "Current balance", money(accountBalance(source)), "info"),
        row("Base purchase", "International base amount", "- " + money(payload.amount), "warning"),
        row("FX fee", "Package fee preview", "- " + money(payload.fx_fee), payload.fx_fee > 0 ? "warning" : "info"),
        row("Excise duty", "Package tax preview", "- " + money(payload.excise), payload.excise > 0 ? "warning" : "info"),
        row("Advance tax", "Package tax preview", "- " + money(payload.advance_tax), payload.advance_tax > 0 ? "warning" : "info"),
        row("PRA / extra tax", "Package extra preview", "- " + money(payload.pra), payload.pra > 0 ? "warning" : "info"),
        row("Total impact", "Preview only", "- " + money(amount), "danger"),
        row("After", "Preview only", money(accountBalance(source) - amount), "warning")
      ].join(""));
      return;
    }

    setHTML("add-live-impact", [
      row(accountName(source), "Current balance", money(accountBalance(source)), "info"),
      row("Change", "Expense decreases account", "- " + money(amount), "warning"),
      row("After", "Preview only", money(accountBalance(source) - amount), "warning")
    ].join(""));
  }

  function renderSmartAssist() {
    const payload = readForm();
    const items = [];

    if (payload.merchant) {
      const needle = payload.merchant.toLowerCase();

      const match = state.merchants.find((merchant) => {
        const aliases = Array.isArray(merchant.aliases) ? merchant.aliases : [];
        const haystack = [
          merchant.name,
          merchant.merchant,
          merchant.label,
          ...aliases
        ].filter(Boolean).join(" ").toLowerCase();

        return haystack.includes(needle) || needle.includes(String(merchant.name || "").toLowerCase());
      });

      if (match) {
        items.push(row(
          "Merchant suggestion",
          `${match.name || match.merchant || "Matched merchant"}${match.default_category_id ? " · " + match.default_category_id : ""}`,
          "Review",
          "info"
        ));
      } else {
        items.push(row("Merchant", "No stored merchant match yet", "Manual", "info"));
      }
    }

    if (state.selectedMode === "income" && payload.amount >= 50000) {
      items.push(row(
        "Salary detector",
        "Looks like salary-sized income. Record income here; salary source updates belong to Salary.",
        "Advisory",
        "warning"
      ));
    }

    if (isInternational()) {
      items.push(row(
        "International package",
        "Multi-row package write is not enabled yet. This page previews total account impact only.",
        "Preview",
        "warning"
      ));
    }

    if (!items.length) {
      setHTML("add-smart-assist", empty("No suggestions yet", "Enter merchant, amount, or choose International."));
      return;
    }

    setHTML("add-smart-assist", items.join(""));
  }

  function renderReview() {
    const payload = readForm();
    const errors = validateLocal(payload);

    if (isInternational()) {
      const rows = [
        row("Mode", "International preview", "International", "warning"),
        row("Date", "Transaction date", payload.date, "info"),
        row("Account", payload.account_id || "missing", accountLabel(payload.account_id), payload.account_id ? "info" : "danger"),
        row("Category", payload.category_id || "missing", categoryLabel(payload.category_id), payload.category_id ? "info" : "danger"),
        row("Base amount", "Purchase amount", money(payload.amount), "warning"),
        row("Package total", "Base + fees + taxes", money(internationalTotal(payload)), "danger"),
        row("Save status", "Backend package writer not shipped", "Preview only", "warning")
      ];

      if (errors.length) rows.push(row("Blocked", errors.join(" · "), "Fix", "danger"));

      setHTML("add-review-panel", rows.join(""));
      setPill("add-form-status", errors.length ? "Blocked" : "Preview", errors.length ? "danger" : "warning");
      return;
    }

    const errorsTone = errors.length ? "danger" : "positive";
    const expected = payload.mode === "transfer"
      ? "linked transfer movement"
      : "1 transaction row";

    const rows = [
      row("Mode", "Direct save through /api/add", mode().label, "positive"),
      row("Date", "Transaction date", payload.date, "info"),
      row("Amount", "Positive amount", money(payload.amount), "info"),
      row("Source account", payload.account_id || "missing", accountLabel(payload.account_id), payload.account_id ? "info" : "danger")
    ];

    if (payload.mode === "transfer") {
      rows.push(row(
        "Destination account",
        payload.transfer_to_account_id || "missing",
        accountLabel(payload.transfer_to_account_id),
        payload.transfer_to_account_id ? "info" : "danger"
      ));
    } else {
      rows.push(row(
        "Category",
        payload.category_id || "missing",
        categoryLabel(payload.category_id),
        payload.category_id ? "info" : "danger"
      ));
    }

    rows.push(row("Expected ledger shape", "Backend remains final truth", expected, "info"));

    if (errors.length) {
      rows.push(row("Blocked", errors.join(" · "), "Fix", "danger"));
    } else {
      rows.push(row("Ready for dry-run", "Backend validation still required", "Ready", "positive"));
    }

    setHTML("add-review-panel", rows.join(""));
    setPill("add-form-status", errors.length ? "Blocked" : "Ready", errorsTone);
  }

  function renderDryRun() {
    if (isInternational()) {
      setHTML("add-dryrun-panel", empty("Dry-run unavailable", "International direct write needs the backend package writer first."));
      return;
    }

    if (!state.dryRun) {
      setHTML("add-dryrun-panel", empty("Dry-run not run", "A valid direct-mode payload is required."));
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
    if (isInternational()) {
      setHTML("add-save-panel", empty("Save not available", "International package save will be enabled after backend package writer ships."));
      return;
    }

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

    if (canSave()) {
      setHTML("add-save-panel", [
        row("Save ready", "Dry-run passed and payload is unchanged", "Ready", "positive"),
        row("Commit rule", "Commit requires payload hash", "Locked", "positive")
      ].join(""));
      return;
    }

    setHTML("add-save-panel", empty(
      "Save blocked",
      state.dirtySinceDryRun ? "Form changed after dry-run. Run dry-run again." : "Run backend dry-run first."
    ));
  }

  function renderDebug() {
    setText("add-debug-output", JSON.stringify({
      version: VERSION,
      selectedMode: state.selectedMode,
      backendMode: backendMode(),
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
    applyModeFields();
    renderSourceState();
    renderLiveImpact();
    renderSmartAssist();
    renderReview();
    renderDryRun();
    renderSave();
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
      delete state.errors.context;
      populateSelects();
    } catch (err) {
      state.context = {
        can_direct_write: false,
        source_status: {
          accounts: "failed",
          categories: "failed",
          merchants: "failed"
        }
      };
      state.errors.context = err.message;
      setHTML("add-source-list", errorBlock("Add context failed", err.message));
    }

    renderAll();
    await runPreview(false);
  }

  async function runPreview(renderAfter = true) {
    const payload = readForm();

    try {
      state.preview = await postJSON("/api/add/preview", payload);
      delete state.errors.preview;
    } catch (err) {
      state.preview = null;
      state.errors.preview = err.message;
    }

    if (renderAfter) renderAll();
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
    updateButtons();

    try {
      state.dryRun = await postJSON("/api/add/dry-run", readForm());
      delete state.errors.dryRun;
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
      state.save = await postJSON("/api/add/commit", {
        ...readForm(),
        dry_run_payload_hash: state.dryRun.payload_hash
      });
      delete state.errors.save;
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

  let previewTimer = null;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => runPreview(), 150);
  }

  function invalidateDryRun() {
    if (state.dryRun && !state.save?.ok) {
      state.dirtySinceDryRun = true;
    }

    state.save = null;
    renderAll();
    schedulePreview();
  }

  function setMode(nextMode) {
    if (!MODES[nextMode]) nextMode = "expense";

    state.selectedMode = nextMode;
    state.preview = null;
    state.dryRun = null;
    state.save = null;
    state.dirtySinceDryRun = false;

    renderAll();
    schedulePreview();
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
    document.querySelectorAll("[data-add-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.getAttribute("data-add-mode")));
    });

    [
      "add-date",
      "add-amount",
      "add-account",
      "add-destination-account",
      "add-category",
      "add-merchant",
      "add-reference",
      "add-notes",
      "add-fx-fee",
      "add-excise",
      "add-advance-tax",
      "add-pra"
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
    loadContext();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
