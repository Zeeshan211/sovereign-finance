/* js/merchants.js
 * Sovereign Finance · Merchants & Payees Frontend Binding
 * v0.2.0-merchants-counterparty-frontend
 *
 * Contract:
 * - Frontend does not mutate money.
 * - Merchants are classification/rules only.
 * - Backend owns merchant validation, seed, match, and health.
 * - Shared shell only: renders sf-* rows into existing containers.
 */

(function () {
  "use strict";

  if (window.SovereignMerchants && window.SovereignMerchants.initialized) return;

  const VERSION = "v0.2.0-merchants-counterparty-frontend";

  const API_MERCHANTS = "/api/merchants";
  const API_HEALTH = "/api/merchants?action=health";
  const API_CATEGORIES = "/api/categories";
  const API_ACCOUNTS = "/api/accounts";
  const API_BALANCES = "/api/balances";

  const state = {
    payload: null,
    health: null,
    categories: [],
    accounts: [],
    selectedId: "",
    submitting: false
  };

  const $ = id => document.getElementById(id);

  function components() {
    return window.SFComponents || {};
  }

  function esc(value) {
    const c = components();

    if (typeof c.escapeHtml === "function") return c.escapeHtml(value);

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

  function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
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
    if (el) el.value = value == null ? "" : String(value);
  }

  function setChecked(id, checked) {
    const el = $(id);
    if (el) el.checked = !!checked;
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

  function merchants() {
    const payload = state.payload || {};
    return Array.isArray(payload.merchants) ? payload.merchants : [];
  }

  function summary() {
    return (state.payload && state.payload.summary) || {};
  }

  function categoryId(category) {
    return category && (category.id || category.category_id) || "";
  }

  function categoryName(category) {
    return category && (category.name || category.label || categoryId(category)) || "Category";
  }

  function accountId(account) {
    return account && (account.id || account.account_id) || "";
  }

  function accountName(account) {
    return account && (account.name || account.label || account.account_name || accountId(account)) || "Account";
  }

  function accountLabel(account) {
    if (!account) return "—";
    return `${account.icon || ""} ${accountName(account)}`.trim();
  }

  function unwrapCategories(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.categories)) return payload.categories;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.data && Array.isArray(payload.data.categories)) return payload.data.categories;
    return [];
  }

  function unwrapAccounts(payload) {
    if (!payload) return [];

    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (Array.isArray(payload.account_list)) return payload.account_list;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.data && Array.isArray(payload.data.accounts)) return payload.data.accounts;

    if (payload.accounts && typeof payload.accounts === "object") {
      return Object.entries(payload.accounts).map(([id, row]) => ({
        id,
        ...(row || {})
      }));
    }

    return [];
  }

  function normalizeAliases(value) {
    if (Array.isArray(value)) {
      return value.map(item => String(item || "").trim()).filter(Boolean);
    }

    if (value == null || value === "") return [];

    const raw = String(value).trim();

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeAliases(parsed);
    } catch {
      /* keep parsing as comma string */
    }

    return raw.split(",").map(item => item.trim()).filter(Boolean);
  }

  function aliasesText(value) {
    return normalizeAliases(value).join(", ");
  }

  function boolText(value) {
    return value ? "Yes" : "No";
  }

  function toneForType(type) {
    const t = String(type || "").toLowerCase();

    if (t === "person") return "warning";
    if (t === "loan_provider") return "danger";
    if (t === "biller") return "info";
    if (t === "bank" || t === "wallet" || t === "payment_rail") return "info";

    return "positive";
  }

  function moduleLabel(value) {
    const raw = String(value || "transactions");
    return raw.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
  }

  function renderKpis() {
    const s = summary();
    const h = state.health || {};
    const healthStatus = h.status || "unknown";

    const total = s.total ?? merchants().length;
    const autoApply = s.auto_apply_allowed ?? merchants().filter(m => m.auto_apply_allowed).length;
    const review = s.review_required ?? merchants().filter(m => m.review_required).length;
    const seedCount = state.payload && state.payload.seed_count != null ? state.payload.seed_count : "—";

    setText("merchants-kpi-total", total);
    setText("merchants-kpi-auto", autoApply);
    setText("merchants-kpi-review", review);
    setText("merchants-kpi-seed", seedCount);
    setText("merchants-kpi-health", healthStatus);

    setPill(
      "merchants-source-status",
      state.payload ? `Merchants API ${state.payload.version || "loaded"}` : "Loading",
      state.payload ? "positive" : "info"
    );

    setPill(
      "merchants-health-status",
      healthStatus === "pass" ? "Health PASS" : `Health ${healthStatus}`,
      healthStatus === "pass" ? "positive" : healthStatus === "unknown" ? "info" : "warning"
    );

    if (window.SFShell && typeof window.SFShell.setKpis === "function") {
      window.SFShell.setKpis([
        {
          title: "Merchants & Payees",
          kicker: "Rules",
          valueHtml: String(total),
          subtitle: "Classification records",
          foot: "No money mutation",
          tone: "info"
        },
        {
          title: "Auto-Apply",
          kicker: "Safe Defaults",
          valueHtml: String(autoApply),
          subtitle: "Can suggest defaults",
          foot: "Exact/alias match only",
          tone: "positive"
        },
        {
          title: "Review Required",
          kicker: "Controls",
          valueHtml: String(review),
          subtitle: "People/ambiguous payees",
          foot: "Do not auto-post",
          tone: review > 0 ? "warning" : "positive"
        },
        {
          title: "Health",
          kicker: "Backend",
          valueHtml: String(healthStatus).toUpperCase(),
          subtitle: "merchants.health",
          foot: "Read-only check",
          tone: healthStatus === "pass" ? "positive" : "warning"
        }
      ]);
    }
  }

  function fillCategorySelect() {
    const select = $("merchant-category");
    if (!select) return;

    const current = select.value;

    select.innerHTML = [
      '<option value="">No default category</option>'
    ].concat(state.categories.map(category => {
      const id = categoryId(category);
      return `<option value="${esc(id)}">${esc(categoryName(category))}</option>`;
    })).join("");

    if (current) select.value = current;
  }

  function fillAccountSelect() {
    const select = $("merchant-account");
    if (!select) return;

    const current = select.value;

    select.innerHTML = [
      '<option value="">No default account</option>'
    ].concat(state.accounts.map(account => {
      const id = accountId(account);
      return `<option value="${esc(id)}">${esc(accountLabel(account))}</option>`;
    })).join("");

    if (current) select.value = current;
  }

  function merchantRowHtml(merchant) {
    const type = merchant.counterparty_type || "merchant";
    const tone = toneForType(type);
    const aliases = normalizeAliases(merchant.aliases);
    const isSelected = String(state.selectedId || "") === String(merchant.id || "");

    return `
      <button class="sf-finance-row${isSelected ? " is-active" : ""}" type="button" data-merchant-action="select" data-merchant-id="${esc(merchant.id)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(merchant.name || merchant.id || "Merchant")}</div>
          <div class="sf-row-subtitle">
            ${esc(type.replace(/_/g, " "))} · ${esc(moduleLabel(merchant.default_module))} · learned ${esc(merchant.learned_count || 0)}
          </div>
          ${
            aliases.length
              ? `<div class="sf-row-subtitle">Aliases: ${esc(aliases.slice(0, 4).join(", "))}${aliases.length > 4 ? "…" : ""}</div>`
              : ""
          }
          <div class="sf-row-subtitle">
            Category: ${esc(merchant.default_category_id || "—")} · Account: ${esc(merchant.default_account_id || "—")} · PRA: ${esc(boolText(merchant.is_pra_required))}
          </div>
        </div>
        <div class="sf-row-right sf-tone-${tone}">
          ${esc(merchant.review_required ? "Review" : "Auto")}
        </div>
      </button>
    `;
  }

  function renderMerchantList() {
    const rows = merchants();

    setHTML(
      "merchants-list",
      rows.length
        ? rows.map(merchantRowHtml).join("")
        : emptyState("No merchants yet", "Use seed preview or create your first merchant/payee rule.")
    );
  }

  function renderSelectedMerchant() {
    const merchant = merchants().find(row => String(row.id) === String(state.selectedId));

    if (!merchant) {
      setHTML(
        "merchant-selected-detail",
        emptyState("No merchant selected", "Select a merchant/payee row to edit, touch, or delete it.")
      );
      return;
    }

    setHTML(
      "merchant-selected-detail",
      `
        <div class="sf-list">
          <div class="sf-dense-row"><span>ID</span><strong>${esc(merchant.id)}</strong></div>
          <div class="sf-dense-row"><span>Name</span><strong>${esc(merchant.name)}</strong></div>
          <div class="sf-dense-row"><span>Type</span><strong>${esc(merchant.counterparty_type || "merchant")}</strong></div>
          <div class="sf-dense-row"><span>Module</span><strong>${esc(moduleLabel(merchant.default_module))}</strong></div>
          <div class="sf-dense-row"><span>Category</span><strong>${esc(merchant.default_category_id || "—")}</strong></div>
          <div class="sf-dense-row"><span>Account</span><strong>${esc(merchant.default_account_id || "—")}</strong></div>
          <div class="sf-dense-row"><span>PRA Required</span><strong>${esc(boolText(merchant.is_pra_required))}</strong></div>
          <div class="sf-dense-row"><span>Learned Count</span><strong>${esc(merchant.learned_count || 0)}</strong></div>
          <div class="sf-dense-row"><span>Auto Apply</span><strong>${esc(boolText(merchant.auto_apply_allowed))}</strong></div>
          <div class="sf-dense-row"><span>Review Required</span><strong>${esc(boolText(merchant.review_required))}</strong></div>
        </div>

        <div class="sf-section-meta" style="margin-top: var(--sf-space-4);">
          <button class="sf-button" type="button" data-merchant-action="edit" data-merchant-id="${esc(merchant.id)}">Edit in form</button>
          <button class="sf-button" type="button" data-merchant-action="touch" data-merchant-id="${esc(merchant.id)}">Touch</button>
          <button class="sf-button sf-tone-danger" type="button" data-merchant-action="delete" data-merchant-id="${esc(merchant.id)}">Delete</button>
        </div>
      `
    );
  }

  function renderHealth() {
    if (!state.health) {
      setHTML("merchants-health-output", loadingState("Health loading", "Reading /api/merchants?action=health."));
      return;
    }

    const status = state.health.status || "unknown";
    const counts = state.health.counts || {};
    const checks = state.health.checks || {};

    const rows = [
      ["Status", status],
      ["Merchants", counts.merchants ?? "—"],
      ["Seed Counterparties", counts.seed_counterparties ?? "—"],
      ["Duplicate Names OK", checks.duplicate_names_ok],
      ["Duplicate Aliases OK", checks.duplicate_aliases_ok],
      ["Category Refs OK", checks.category_refs_ok],
      ["Account Refs OK", checks.account_refs_ok],
      ["PRA Flags OK", checks.pra_flags_ok],
      ["Money Mutation Allowed", checks.money_mutation_allowed]
    ];

    setHTML(
      "merchants-health-output",
      rows.map(([label, value]) => `
        <div class="sf-dense-row">
          <span>${esc(label)}</span>
          <strong class="${value === true || value === "pass" || value === false && label === "Money Mutation Allowed" ? "sf-tone-positive" : value === false ? "sf-tone-danger" : ""}">
            ${esc(String(value))}
          </strong>
        </div>
      `).join("")
    );

    setText("merchants-health-debug-output", JSON.stringify(state.health, null, 2));
  }

  function matchResultHtml(result) {
    if (!result || !result.matched) {
      return `
        <div class="sf-empty-state">
          <div>
            <h3 class="sf-card-title">No confident match</h3>
            <p class="sf-card-subtitle">The row should be reviewed manually before posting.</p>
          </div>
        </div>
      `;
    }

    const m = result.merchant || {};

    return `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(m.name || "Matched merchant")}</div>
          <div class="sf-row-subtitle">
            ${esc(m.counterparty_type || "merchant")} · ${esc(moduleLabel(m.default_module))} · confidence ${esc(result.confidence)}
          </div>
          <div class="sf-row-subtitle">
            Category: ${esc(m.default_category_id || "—")} · Account: ${esc(m.default_account_id || "—")} · PRA: ${esc(boolText(m.is_pra_required))}
          </div>
          <div class="sf-row-subtitle">
            Match type: ${esc(result.match_type || "—")} · Review required: ${esc(boolText(result.review_required))}
          </div>
        </div>
        <div class="sf-row-right ${result.review_required ? "sf-tone-warning" : "sf-tone-positive"}">
          ${esc(result.review_required ? "Review" : "Auto")}
        </div>
      </div>

      ${
        Array.isArray(result.suggestions) && result.suggestions.length
          ? `<div class="sf-list" style="margin-top: var(--sf-space-3);">
              ${result.suggestions.slice(0, 5).map(item => `
                <div class="sf-dense-row">
                  <span>${esc(item.name)} · ${esc(item.counterparty_type || "merchant")}</span>
                  <strong>${esc(item.confidence || "—")}</strong>
                </div>
              `).join("")}
            </div>`
          : ""
      }
    `;
  }

  async function runMatch(event) {
    if (event) event.preventDefault();

    const text = $("merchant-match-text") ? $("merchant-match-text").value.trim() : "";

    if (!text) {
      showResult(false, "Paste statement text first.");
      return;
    }

    setHTML("merchant-match-result", loadingState("Matching", "Reading /api/merchants/match."));

    try {
      const result = await fetchJSON(API_MERCHANTS + "/match", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text })
      });

      setHTML("merchant-match-result", matchResultHtml(result));
    } catch (err) {
      setHTML("merchant-match-result", errorState("Match failed", err.message || String(err)));
    }
  }

  async function previewSeed(event) {
    if (event) event.preventDefault();

    setHTML("merchant-seed-output", loadingState("Seed preview", "Checking missing seed records."));

    try {
      const result = await fetchJSON(API_MERCHANTS + "/seed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "seed", dry_run: true })
      });

      setHTML("merchant-seed-output", seedResultHtml(result));
    } catch (err) {
      setHTML("merchant-seed-output", errorState("Seed preview failed", err.message || String(err)));
    }
  }

  async function commitSeed(event) {
    if (event) event.preventDefault();

    const ok = window.confirm(
      "Insert missing seed merchants/payees? This does not mutate money, but it will add classification records."
    );

    if (!ok) return;

    setHTML("merchant-seed-output", loadingState("Seeding merchants", "Creating missing merchant/payee rules."));

    try {
      const result = await fetchJSON(API_MERCHANTS + "/seed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ action: "seed", dry_run: false })
      });

      setHTML("merchant-seed-output", seedResultHtml(result));
      await loadAll();
    } catch (err) {
      setHTML("merchant-seed-output", errorState("Seed failed", err.message || String(err)));
    }
  }

  function seedResultHtml(result) {
    const rows = Array.isArray(result.insertable) ? result.insertable : [];

    return `
      <div class="sf-list">
        <div class="sf-dense-row"><span>Dry run</span><strong>${esc(boolText(result.dry_run))}</strong></div>
        <div class="sf-dense-row"><span>Insertable</span><strong>${esc(result.insertable_count ?? 0)}</strong></div>
        <div class="sf-dense-row"><span>Inserted</span><strong>${esc(result.inserted_count ?? 0)}</strong></div>
        <div class="sf-dense-row"><span>Skipped existing</span><strong>${esc(result.skipped_existing_count ?? 0)}</strong></div>
      </div>

      ${
        rows.length
          ? `<div class="sf-list" style="margin-top: var(--sf-space-3);">
              ${rows.slice(0, 12).map(row => `
                <div class="sf-finance-row">
                  <div class="sf-row-left">
                    <div class="sf-row-title">${esc(row.name || row.id)}</div>
                    <div class="sf-row-subtitle">${esc(row.counterparty_type || "merchant")} · ${esc(moduleLabel(row.default_module))}</div>
                  </div>
                  <div class="sf-row-right ${row.review_required ? "sf-tone-warning" : "sf-tone-positive"}">
                    ${esc(row.review_required ? "Review" : "Auto")}
                  </div>
                </div>
              `).join("")}
            </div>`
          : `<p class="sf-card-subtitle">No seed records need insertion.</p>`
      }
    `;
  }

  function readForm() {
    return {
      id: $("merchant-id") ? $("merchant-id").value.trim() : "",
      name: $("merchant-name") ? $("merchant-name").value.trim() : "",
      aliases: $("merchant-aliases") ? $("merchant-aliases").value.trim() : "",
      default_category_id: $("merchant-category") ? $("merchant-category").value : "",
      default_account_id: $("merchant-account") ? $("merchant-account").value : "",
      is_pra_required: $("merchant-pra") ? $("merchant-pra").checked : false
    };
  }

  function validateForm(payload) {
    if (!payload.name) return "Merchant/payee name is required.";
    return "";
  }

  async function submitForm(event) {
    if (event) event.preventDefault();
    if (state.submitting) return;

    const payload = readForm();
    const error = validateForm(payload);

    if (error) {
      showResult(false, error);
      return;
    }

    const isUpdate = !!state.selectedId;
    const url = isUpdate
      ? `${API_MERCHANTS}/${encodeURIComponent(state.selectedId)}`
      : API_MERCHANTS;

    state.submitting = true;
    setDisabled("merchant-submit", true);
    setText("merchant-submit-label", isUpdate ? "Updating…" : "Creating…");
    showResult(true, isUpdate ? "Updating merchant/payee…" : "Creating merchant/payee…");

    try {
      const result = await fetchJSON(url, {
        method: isUpdate ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      showResult(true, `${isUpdate ? "Updated" : "Created"} ${result.merchant && result.merchant.name ? result.merchant.name : "merchant/payee"}.`);
      clearForm();
      await loadAll();
    } catch (err) {
      showResult(false, err.message || String(err));
    } finally {
      state.submitting = false;
      setDisabled("merchant-submit", false);
      setText("merchant-submit-label", "Save merchant");
    }
  }

  function clearForm() {
    state.selectedId = "";

    ["merchant-id", "merchant-name", "merchant-aliases"].forEach(id => setValue(id, ""));
    setValue("merchant-category", "");
    setValue("merchant-account", "");
    setChecked("merchant-pra", false);
    setText("merchant-form-mode", "Create mode");
    setText("merchant-submit-label", "Save merchant");

    renderMerchantList();
    renderSelectedMerchant();
  }

  function fillFormFromMerchant(id) {
    const merchant = merchants().find(row => String(row.id) === String(id));
    if (!merchant) return;

    state.selectedId = merchant.id;

    setValue("merchant-id", merchant.id || "");
    setValue("merchant-name", merchant.name || "");
    setValue("merchant-aliases", aliasesText(merchant.aliases));
    setValue("merchant-category", merchant.default_category_id || "");
    setValue("merchant-account", merchant.default_account_id || "");
    setChecked("merchant-pra", merchant.is_pra_required);
    setText("merchant-form-mode", `Edit mode · ${merchant.id}`);
    setText("merchant-submit-label", "Update merchant");

    renderMerchantList();
    renderSelectedMerchant();
  }

  async function touchMerchant(id) {
    if (!id) return;

    try {
      const result = await fetchJSON(`${API_MERCHANTS}/${encodeURIComponent(id)}/touch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          source: "manual",
          created_by: "web-merchants"
        })
      });

      showResult(true, `Touched ${id}: ${result.previous_count} → ${result.new_count}.`);
      await loadAll();
    } catch (err) {
      showResult(false, err.message || String(err));
    }
  }

  async function deleteMerchant(id) {
    if (!id) return;

    const ok = window.confirm(`Delete/archive merchant ${id}? This does not mutate money.`);

    if (!ok) return;

    try {
      const result = await fetchJSON(`${API_MERCHANTS}/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });

      showResult(true, `Deleted ${id} using ${result.delete_mode || "delete"} mode.`);
      clearForm();
      await loadAll();
    } catch (err) {
      showResult(false, err.message || String(err));
    }
  }

  function showResult(ok, message) {
    const el = $("merchant-result");
    if (!el) return;

    el.hidden = false;
    el.className = "sf-debug-text " + (ok ? "sf-tone-positive" : "sf-tone-danger");
    el.textContent = message;
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

  function renderDebug() {
    const debug = {
      page_version: VERSION,
      endpoint: API_MERCHANTS,
      contract: {
        money_mutation_allowed: false,
        classification_only: true,
        add_transaction_autofill: true,
        ledger_display_normalization: true,
        bills_biller_matching: true,
        nano_loan_provider_matching: true,
        atm_rail_matching: true,
        reconciliation_statement_matching: true
      },
      payload: state.payload,
      health: state.health,
      categories: state.categories,
      accounts: state.accounts
    };

    setText("merchants-debug-output", JSON.stringify(debug, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function bindEvents() {
    const form = $("merchant-form");
    if (form) form.addEventListener("submit", submitForm);

    const submit = $("merchant-submit");
    if (submit) submit.addEventListener("click", submitForm);

    const clear = $("merchant-clear");
    if (clear) clear.addEventListener("click", clearForm);

    const refresh = $("merchants-refresh");
    if (refresh) refresh.addEventListener("click", loadAll);

    const matchForm = $("merchant-match-form");
    if (matchForm) matchForm.addEventListener("submit", runMatch);

    const matchButton = $("merchant-match-submit");
    if (matchButton) matchButton.addEventListener("click", runMatch);

    const seedPreview = $("merchant-seed-preview");
    if (seedPreview) seedPreview.addEventListener("click", previewSeed);

    const seedCommit = $("merchant-seed-commit");
    if (seedCommit) seedCommit.addEventListener("click", commitSeed);

    document.addEventListener("click", function (event) {
      const btn = event.target.closest("[data-merchant-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-merchant-action");
      const id = btn.getAttribute("data-merchant-id");

      if (action === "select") {
        state.selectedId = id || "";
        renderMerchantList();
        renderSelectedMerchant();
      }

      if (action === "edit") fillFormFromMerchant(id);
      if (action === "touch") touchMerchant(id);
      if (action === "delete") deleteMerchant(id);
    });
  }

  async function loadAll() {
    setPill("merchants-source-status", "Loading", "info");
    setHTML("merchants-list", loadingState("Loading merchants", "Reading /api/merchants."));
    setHTML("merchant-selected-detail", loadingState("Loading detail", "Preparing selected merchant panel."));
    setHTML("merchants-health-output", loadingState("Loading health", "Reading /api/merchants?action=health."));

    try {
      const [payloadResult, healthResult, categoryResult, accountResult, balancesResult] = await Promise.allSettled([
        fetchJSON(API_MERCHANTS),
        fetchJSON(API_HEALTH),
        fetchJSON(API_CATEGORIES),
        fetchJSON(API_ACCOUNTS),
        fetchJSON(API_BALANCES)
      ]);

      if (payloadResult.status === "fulfilled") {
        state.payload = payloadResult.value;
      } else {
        throw payloadResult.reason;
      }

      state.health = healthResult.status === "fulfilled" ? healthResult.value : null;

      state.categories = categoryResult.status === "fulfilled"
        ? unwrapCategories(categoryResult.value)
        : [];

      if (accountResult.status === "fulfilled") {
        state.accounts = unwrapAccounts(accountResult.value);
      } else if (balancesResult.status === "fulfilled") {
        state.accounts = unwrapAccounts(balancesResult.value);
      } else {
        state.accounts = [];
      }

      fillCategorySelect();
      fillAccountSelect();
      renderKpis();
      renderMerchantList();
      renderSelectedMerchant();
      renderHealth();
      renderDebug();
    } catch (err) {
      state.payload = null;
      state.health = null;

      setPill("merchants-source-status", "Merchants API failed", "danger");
      setHTML("merchants-list", errorState("Merchants API failed", err.message || String(err)));
      setHTML("merchant-selected-detail", errorState("Merchant detail unavailable", "Could not load merchant data."));
      setHTML("merchants-health-output", errorState("Health unavailable", "Could not load merchant health."));
    }
  }

  function init() {
    window.SovereignMerchants = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      runMatch,
      previewSeed,
      commitSeed,
      payload: () => state.payload,
      health: () => state.health,
      merchants: () => merchants(),
      categories: () => state.categories,
      accounts: () => state.accounts
    };

    setText("merchants-js-version", VERSION);
    setText("merchants-footer-version", `v0.2.0 · Merchants · ${VERSION}`);

    bindEvents();
    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
