(function () {
  "use strict";

  if (window.SovereignAdd && window.SovereignAdd.initialized) return;

  const VERSION = "v1.5.2-add-dryrun-commit-transfer-fix";

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
      kind: "direct",
      copy: "International auto-computes FX fee, excise, advance tax, PRA, and bank charge from configured rates. Engine writes one ledger row per component, all linked under one package id."
    }
  };

  const COMPONENT_LABELS = {
    base: "Base purchase",
    fx_fee: "FX fee",
    excise: "Excise duty",
    advance_tax: "Advance tax",
    pra: "PRA / extra tax",
    bank_charge: "Bank charge"
  };

  const state = {
    context: null,
    accounts: [],
    categories: [],
    merchants: [],
    intlRateConfig: null,
    selectedMode: "expense",
    intlSubtype: "foreign",
    preview: null,
    intlPreview: null,
    fxLookup: null,
    dryRun: null,
    save: null,
    dirtySinceDryRun: false,
    loading: false,
    fxLoading: false,
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
    el.hidden = false;
  }

  async function getJSON(url) {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" }
    });

    const json = await res.json().catch(() => null);

    if (!res.ok || !json || json.ok === false) {
      throw apiError(json, res.status);
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
      throw apiError(json, res.status);
    }

    return json;
  }

  function apiError(json, status) {
    const message =
      (json && json.error) ||
      (json && json.message) ||
      "HTTP " + status;

    const err = new Error(message);
    err.status = status;
    err.payload = json || null;
    return err;
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
    const base = {
      mode: backendMode(),
      ui_mode: state.selectedMode,
      date: $("add-date")?.value || today(),
      amount: num($("add-amount")?.value, 0),
      account_id: $("add-account")?.value || "",
      transfer_to_account_id: $("add-destination-account")?.value || "",
      category_id: $("add-category")?.value || "",
      merchant: $("add-merchant")?.value || "",
      reference: $("add-reference")?.value || "",
      notes: $("add-notes")?.value || ""
    };

    if (isInternational()) {
      base.subtype = state.intlSubtype;

      const bankChargeRaw = $("add-intl-bank-charge")?.value;
      if (bankChargeRaw !== undefined && bankChargeRaw !== "") {
        base.bank_charge_override = num(bankChargeRaw, 0);
      }

      base.include_pra = !!$("add-intl-include-pra")?.checked;

      if (state.intlSubtype === "foreign") {
        base.foreign_amount = num($("add-intl-foreign-amount")?.value, 0);
        base.foreign_currency = ($("add-intl-currency")?.value || "USD").toUpperCase();

        const fxRateRaw = $("add-intl-fx-rate")?.value;
        if (fxRateRaw !== undefined && fxRateRaw !== "") {
          base.fx_rate = num(fxRateRaw, 0);
        }
      } else {
        base.pkr_amount = num($("add-intl-pkr-amount")?.value, 0);
      }
    }

    return base;
  }

  function dryRunRequiresOverride() {
    return !!(state.dryRun && state.dryRun.ok && state.dryRun.requires_override === true);
  }

  function dryRunPayloadHash() {
    return state.dryRun && state.dryRun.payload_hash ? String(state.dryRun.payload_hash) : "";
  }

  function getProofCheck(name) {
    const checks = state.dryRun?.proof?.checks || [];
    return checks.find((check) => check && check.check === name) || null;
  }

  function getExpectedWrites() {
    if (!state.dryRun) return [];

    if (Array.isArray(state.dryRun.expected_writes)) {
      return state.dryRun.expected_writes;
    }

    const expected = state.dryRun.proof?.expected_writes;

    if (expected && typeof expected === "object") {
      return Object.entries(expected).map(([model, rows]) => ({
        model,
        rows
      }));
    }

    const proof = state.dryRun.proof || {};

    if (proof.expected_transaction_rows != null || proof.expected_audit_rows != null) {
      return [
        {
          model: "transactions",
          rows: proof.expected_transaction_rows ?? "?"
        },
        {
          model: "audit",
          rows: proof.expected_audit_rows ?? "?"
        }
      ];
    }

    return [];
  }

  function saveWrittenLabel() {
    if (!state.save?.ok) return "—";

    const written = state.save.written || {};

    if (isInternational()) {
      return `Package ${written.intl_package_id || state.save.intl_package_id || "—"} · ${written.row_count || state.save.row_count || 0} rows`;
    }

    if (Array.isArray(state.save.ids) && state.save.ids.length) {
      return `transfer ${state.save.ids.join(" → ")}`;
    }

    if (state.save.id && state.save.linked_id) {
      return `transfer ${state.save.id} → ${state.save.linked_id}`;
    }

    if (written.transaction_id) {
      return `txn ${written.transaction_id}`;
    }

    if (state.save.transaction_id) {
      return `txn ${state.save.transaction_id}`;
    }

    if (state.save.id) {
      return `txn ${state.save.id}`;
    }

    return "Saved";
  }

  function validateLocal(payload) {
    const errors = [];

    if (isInternational()) {
      if (!payload.date) errors.push("Date is required.");
      if (!payload.account_id) errors.push("Account is required.");
      if (!payload.category_id) errors.push("Category is required.");

      if (payload.subtype === "foreign") {
        if (!Number.isFinite(payload.foreign_amount) || payload.foreign_amount <= 0) {
          errors.push("Foreign amount must be greater than zero.");
        }
        if (!payload.foreign_currency || !/^[A-Z]{3}$/.test(payload.foreign_currency)) {
          errors.push("Valid currency code is required.");
        }
      } else if (payload.subtype === "pkr_base") {
        if (!Number.isFinite(payload.pkr_amount) || payload.pkr_amount <= 0) {
          errors.push("PKR amount must be greater than zero.");
        }
      } else {
        errors.push("Invalid subtype.");
      }

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

  function denseRow(title, value, tone) {
    return `
      <div class="sf-dense-row">
        <div>${esc(title)}</div>
        <div class="${tone ? `sf-tone-${esc(tone)}` : ""}" style="font-weight:700;">${value == null ? "—" : value}</div>
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

  function populateIntlCurrencyFromConfig() {
    const select = $("add-intl-currency");
    if (!select) return;

    const cfg = state.intlRateConfig;
    if (cfg && cfg.default_currency) {
      const found = Array.from(select.options).find((o) => o.value === cfg.default_currency);
      if (found && !select.value) select.value = cfg.default_currency;
    }
  }

  function applyIntlSubtypeFields() {
    const isForeign = state.intlSubtype === "foreign";

    setHidden("add-intl-foreign-fields", !isForeign);
    setHidden("add-intl-pkr-fields", isForeign);

    document.querySelectorAll("[data-intl-subtype]").forEach((btn) => {
      const active = btn.getAttribute("data-intl-subtype") === state.intlSubtype;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  }

  function applyModeFields() {
    const currentMode = state.selectedMode;
    const transfer = currentMode === "transfer";
    const international = currentMode === "international";
    const income = currentMode === "income";

    setHidden("add-destination-field", !transfer);
    setHidden("add-category-field", transfer);
    setHidden("add-international-fields", !international);
    setHidden("add-amount", international);
    setHidden("add-amount-field", international);

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

    setPill("add-selected-mode-pill", mode().label, "positive");
    setPill("add-route-pill", international ? "Package writer" : "Direct save", "positive");

    document.querySelectorAll("[data-add-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.getAttribute("data-add-mode") === state.selectedMode);
    });

    if (international) {
      applyIntlSubtypeFields();

      if (state.intlRateConfig) {
        setPill("add-intl-rates-pill",
          `Rates · FX ${state.intlRateConfig.fx_fee_pct}% · Tax ${state.intlRateConfig.advance_tax_pct}%`,
          "info"
        );
      } else {
        setPill("add-intl-rates-pill", "Rates · unavailable", "danger");
      }
    }

    setPill("add-form-status", "Waiting", "info");
  }

  function renderSourceState() {
    const status = state.context?.source_status || {};
    const canWrite = !!state.context?.can_direct_write;

    setPill("add-source-overall", canWrite ? "Ready" : "Blocked", canWrite ? "positive" : "danger");

    setHTML("add-source-list", [
      row("/api/accounts", status.accounts || "unknown", `${state.accounts.length} loaded`, status.accounts === "ok" ? "positive" : "danger"),
      row("/api/categories", status.categories || "unknown", `${state.categories.length} loaded`, status.categories === "ok" ? "positive" : "danger"),
      row("/api/merchants", status.merchants || "optional", `${state.merchants.length} loaded`, status.merchants === "ok" ? "positive" : "info"),
      row("/api/intl-rates", status.intl_rates || "optional", state.intlRateConfig ? "Loaded" : "Not loaded", status.intl_rates === "ok" ? "positive" : "info")
    ].join(""));
  }

  function renderLiveImpact() {
    const payload = readForm();

    if (isInternational()) {
      const source = findAccount(payload.account_id);
      if (!source) {
        setHTML("add-live-impact", empty("Waiting for input", "Choose account to preview the impact."));
        return;
      }

      const totalPkr = state.intlPreview?.total_pkr ?? null;

      if (totalPkr == null || totalPkr <= 0) {
        setHTML("add-live-impact", empty("Waiting for amount", "Enter amount and FX rate (or auto-fetch) to preview the package impact."));
        return;
      }

      setHTML("add-live-impact", [
        row(accountName(source), "Current balance", money(accountBalance(source)), "info"),
        row("Package total", "All components combined", "- " + money(totalPkr), "warning"),
        row("After", "Backend remains final truth", money(accountBalance(source) - totalPkr), "warning")
      ].join(""));
      return;
    }

    const amount = payload.amount;

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

    setHTML("add-live-impact", [
      row(accountName(source), "Current balance", money(accountBalance(source)), "info"),
      row("Change", "Expense decreases account", "- " + money(amount), "warning"),
      row("After", "Preview only", money(accountBalance(source) - amount), "warning")
    ].join(""));
  }

  function renderIntlPackagePreview() {
    if (!isInternational()) {
      setHidden("add-intl-package-preview", true);
      return;
    }

    const preview = state.intlPreview;

    if (!preview || !preview.components || preview.components.length === 0) {
      setHidden("add-intl-package-preview", true);
      return;
    }

    setHidden("add-intl-package-preview", false);

    const rowsHtml = preview.components.map((c) => {
      const label = COMPONENT_LABELS[c.component] || c.component;
      return denseRow(label, money(c.amount), c.component === "base" ? "info" : "warning");
    }).join("");

    setHTML("add-intl-package-rows", rowsHtml);

    const meta = [];
    meta.push(`Subtype: ${preview.subtype === "foreign" ? "Foreign currency" : "PKR-base"}`);
    if (preview.subtype === "foreign" && preview.foreign_amount && preview.fx_rate) {
      meta.push(`${preview.foreign_amount} ${preview.foreign_currency} × ${preview.fx_rate.toFixed(4)}`);
    }
    meta.push(`${preview.components.length} ledger row${preview.components.length === 1 ? "" : "s"}`);

    setText("add-intl-package-meta", meta.join(" · "));
    setText("add-intl-package-total", money(preview.total_pkr));

    if (state.fxLookup) {
      const sourceLabel =
        state.fxLookup.source === "user_override" ? "User override" :
        state.fxLookup.source === "cache" ? "Cache (fresh)" :
        state.fxLookup.source === "fresh_fetch" ? "Fresh fetch" :
        state.fxLookup.source === "cache_stale_provider_failed" ? "Cache (stale)" :
        state.fxLookup.source === "forced_refresh" ? "Forced refresh" :
        state.fxLookup.source || "—";

      const tone = state.fxLookup.stale ? "warning" : "info";
      setPill("add-intl-fx-source-pill", `FX · ${sourceLabel}`, tone);
    } else {
      const pill = $("add-intl-fx-source-pill");
      if (pill) pill.hidden = true;
    }
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

    if (isInternational() && state.intlPreview) {
      const fees = (state.intlPreview.fx_fee_pkr || 0) +
                   (state.intlPreview.excise_pkr || 0) +
                   (state.intlPreview.advance_tax_pkr || 0) +
                   (state.intlPreview.pra_pkr || 0) +
                   (state.intlPreview.bank_charge_pkr || 0);

      if (fees > 0) {
        items.push(row(
          "Auto-computed fees & taxes",
          "Engine added these from configured rates. No manual entry needed.",
          money(fees),
          "info"
        ));
      }
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
      const total = state.intlPreview?.total_pkr;
      const rows = [
        row("Mode", "International package writer", "International", "positive"),
        row("Subtype", "How the bank charged you", state.intlSubtype === "foreign" ? "Foreign currency" : "PKR-base", "info"),
        row("Date", "Transaction date", payload.date, "info"),
        row("Account", payload.account_id || "missing", accountLabel(payload.account_id), payload.account_id ? "info" : "danger"),
        row("Category", payload.category_id || "missing", categoryLabel(payload.category_id), payload.category_id ? "info" : "danger")
      ];

      if (state.intlSubtype === "foreign") {
        rows.push(row("Foreign amount", payload.foreign_currency || "—", payload.foreign_amount ? `${payload.foreign_amount} ${payload.foreign_currency}` : "missing", payload.foreign_amount ? "info" : "danger"));
        rows.push(row("FX rate", "PKR per 1 unit", payload.fx_rate ? payload.fx_rate.toFixed(4) : "auto-fetch on preview", payload.fx_rate ? "info" : "warning"));
      } else {
        rows.push(row("PKR amount", "Bank-charged in PKR", payload.pkr_amount ? money(payload.pkr_amount) : "missing", payload.pkr_amount ? "info" : "danger"));
      }

      if (total != null && total > 0) {
        rows.push(row("Package total", "Auto-computed by backend", money(total), "warning"));
      }

      rows.push(row("Expected ledger shape", "Backend remains final truth",
        state.intlPreview ? `1 package + ${state.intlPreview.components?.length || 0} rows` : "—",
        "info"));

      if (errors.length) {
        rows.push(row("Blocked", errors.join(" · "), "Fix", "danger"));
      } else if (!state.intlPreview) {
        rows.push(row("Waiting", "Backend preview pending", "—", "warning"));
      } else {
        rows.push(row("Ready for dry-run", "Backend validation still required", "Ready", "positive"));
      }

      setHTML("add-review-panel", rows.join(""));
      setPill("add-form-status", errors.length ? "Blocked" : (state.intlPreview ? "Ready" : "Waiting"), errors.length ? "danger" : (state.intlPreview ? "positive" : "warning"));
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
    if (!state.dryRun) {
      setHTML("add-dryrun-panel", empty("Dry-run not run", "Click Run Dry-Run after inputs are valid."));
      return;
    }

    if (!state.dryRun.ok) {
      setHTML("add-dryrun-panel", errorBlock("Dry-run failed", state.dryRun.error || "Backend rejected payload."));
      return;
    }

    const balance = getProofCheck("balance_projection");
    const expected = getExpectedWrites();
    const route = state.dryRun.route || "transactions";
    const blocked = dryRunRequiresOverride();

    const expectedHtml = expected.length
      ? expected.map((w) => row(`Write: ${w.model}`, "Expected by backend", String(w.rows ?? w.transaction_rows ?? "?"), "info")).join("")
      : "";

    const lines = [
      row("Dry-run", "Backend validation", blocked ? "Blocked" : "Passed", blocked ? "danger" : "positive"),
      row("Writes performed", "Must be false", String(state.dryRun.writes_performed), state.dryRun.writes_performed === false ? "positive" : "danger"),
      row("Payload hash", "Required for commit", state.dryRun.payload_hash ? state.dryRun.payload_hash.slice(0, 12) + "…" : "Missing", state.dryRun.payload_hash ? "positive" : "danger"),
      row("Route", "Owner writer", route, "info")
    ];

    if (blocked) {
      lines.push(row(
        "Override required",
        state.dryRun.override_reason || "Backend requires override",
        "Save disabled",
        "danger"
      ));
    }

    if (balance) {
      lines.push(row(
        "Source balance",
        balance.account_id || "source account",
        `${money(balance.current_balance)} → ${money(balance.projected_balance)}`,
        balance.status === "blocked" ? "danger" : "positive"
      ));

      if (balance.transfer_target) {
        lines.push(row(
          "Destination balance",
          balance.transfer_target.account_id || "destination account",
          `${money(balance.transfer_target.current_balance)} → ${money(balance.transfer_target.projected_balance)}`,
          "positive"
        ));
      }

      if (balance.skipped_inactive_transaction_count != null) {
        lines.push(row(
          "Inactive rows skipped",
          "Reversed/reversal rows excluded from balance guard",
          String(balance.skipped_inactive_transaction_count),
          "info"
        ));
      }
    }

    setHTML("add-dryrun-panel", lines.concat(expectedHtml).join(""));
  }

  function renderSave() {
    if (state.save?.ok) {
      setHTML("add-save-panel", [
        row("Save", "Backend commit", "Saved", "positive"),
        row("Written", "Source of truth", saveWrittenLabel(), "info"),
        row("Ledger", "Review written rows", `<a class="sf-button" href="/transactions.html">Open Ledger</a>`, "info"),
        row("Again", "Reset form for another entry", `<button class="sf-button" type="button" id="add-another">Add Another</button>`, "info")
      ].join(""));

      const again = $("add-another");
      if (again) again.addEventListener("click", resetForm);
      return;
    }

    if (state.save && state.save.ok === false) {
      const response = state.save.response;
      const detail = response
        ? `${state.save.error || "Save failed"}${response.next_step ? " · " + response.next_step : ""}`
        : state.save.error || "Backend rejected commit.";

      setHTML("add-save-panel", errorBlock("Save failed", detail));
      return;
    }

    if (canSave()) {
      setHTML("add-save-panel", [
        row("Save ready", "Dry-run passed and payload is unchanged", "Ready", "positive"),
        row("Commit rule", "Commit requires payload hash", "Locked", "positive")
      ].join(""));
      return;
    }

    if (dryRunRequiresOverride()) {
      setHTML("add-save-panel", errorBlock(
        "Save blocked",
        `Backend requires override: ${state.dryRun.override_reason || "blocked balance projection"}. Override is intentionally disabled in this UI.`
      ));
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
      intlSubtype: state.intlSubtype,
      intlRateConfig: state.intlRateConfig,
      context: state.context,
      preview: state.preview,
      intlPreview: state.intlPreview,
      fxLookup: state.fxLookup,
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
    if (!isDirectMode()) return false;
    if (validateLocal(readForm()).length > 0) return false;
    if (isInternational() && !state.intlPreview) return false;
    return true;
  }

  function canSave() {
    return isDirectMode() &&
      state.dryRun?.ok === true &&
      !!dryRunPayloadHash() &&
      !dryRunRequiresOverride() &&
      !state.dirtySinceDryRun;
  }

  function updateButtons() {
    setDisabled("add-run-dryrun", !canDryRun() || state.loading);
    setDisabled("add-confirm-save", !canSave() || state.loading);
    setDisabled("add-intl-fx-fetch", state.fxLoading);

    const save = $("add-confirm-save");
    if (save) {
      save.textContent = state.loading ? "Working…" : "Confirm Save";
    }

    const dry = $("add-run-dryrun");
    if (dry) {
      dry.textContent = state.loading ? "Working…" : "Run Dry-Run";
    }

    if ($("add-intl-fx-fetch")) {
      $("add-intl-fx-fetch").textContent = state.fxLoading ? "Fetching…" : "Auto-fetch";
    }
  }

  function renderAll() {
    applyModeFields();
    renderSourceState();
    renderLiveImpact();
    renderIntlPackagePreview();
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
      state.intlRateConfig = context.intl_rate_config || null;
      delete state.errors.context;
      populateSelects();
      populateIntlCurrencyFromConfig();
    } catch (err) {
      state.context = {
        can_direct_write: false,
        source_status: {
          accounts: "failed",
          categories: "failed",
          merchants: "failed",
          intl_rates: "failed"
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

      if (isInternational()) {
        state.intlPreview = state.preview.package_preview || null;
        state.fxLookup = state.preview.fx_lookup || null;
      } else {
        state.intlPreview = null;
        state.fxLookup = null;
      }
    } catch (err) {
      state.preview = null;

      if (isInternational()) {
        state.intlPreview = null;
        state.fxLookup = null;
      }

      state.errors.preview = err.message;
    }

    if (renderAfter) renderAll();
  }

  async function fetchFxRate() {
    if (state.fxLoading) return;

    const currency = ($("add-intl-currency")?.value || "USD").toUpperCase();

    state.fxLoading = true;
    updateButtons();

    try {
      const data = await getJSON(`/api/intl-rates/fx?from=${encodeURIComponent(currency)}&to=PKR`);
      const rate = num(data.rate, 0);

      if (rate > 0 && $("add-intl-fx-rate")) {
        $("add-intl-fx-rate").value = rate.toFixed(4);
        invalidateDryRun();
      }

      state.fxLookup = {
        source: data.source,
        rate,
        fetched_at: data.fetched_at,
        stale: data.stale === true,
        provider: data.provider
      };

      delete state.errors.fx;
    } catch (err) {
      state.errors.fx = err.message;
    } finally {
      state.fxLoading = false;
      renderAll();
    }
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
    state.save = null;
    setHTML("add-save-panel", empty("Saving", "Calling /api/add/commit."));
    updateButtons();

    try {
      const payload = {
        ...readForm(),
        dry_run_payload_hash: dryRunPayloadHash(),
        payload_hash: dryRunPayloadHash()
      };

      state.save = await postJSON("/api/add/commit", payload);
      delete state.errors.save;
      state.dirtySinceDryRun = false;
    } catch (err) {
      state.save = {
        ok: false,
        error: err.message,
        response: err.payload || null
      };
      state.errors.save = err.message;
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  let previewTimer = null;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => runPreview(), 200);
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
    state.intlPreview = null;
    state.fxLookup = null;
    state.dryRun = null;
    state.save = null;
    state.dirtySinceDryRun = false;

    renderAll();
    schedulePreview();
  }

  function setIntlSubtype(nextSubtype) {
    if (nextSubtype !== "foreign" && nextSubtype !== "pkr_base") return;

    state.intlSubtype = nextSubtype;
    state.intlPreview = null;
    state.fxLookup = null;
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
    state.intlPreview = null;
    state.fxLookup = null;
    state.dryRun = null;
    state.save = null;
    state.dirtySinceDryRun = false;
    state.intlSubtype = "foreign";

    setMode("expense");
  }

  function bindEvents() {
    document.querySelectorAll("[data-add-mode]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.getAttribute("data-add-mode")));
    });

    document.querySelectorAll("[data-intl-subtype]").forEach((button) => {
      button.addEventListener("click", () => setIntlSubtype(button.getAttribute("data-intl-subtype")));
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
      "add-intl-foreign-amount",
      "add-intl-currency",
      "add-intl-fx-rate",
      "add-intl-pkr-amount",
      "add-intl-bank-charge",
      "add-intl-include-pra"
    ].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", invalidateDryRun);
      el.addEventListener("change", invalidateDryRun);
    });

    const fxFetch = $("add-intl-fx-fetch");
    if (fxFetch) fxFetch.addEventListener("click", fetchFxRate);

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
      confirmSave,
      fetchFxRate,
      setMode,
      setIntlSubtype
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