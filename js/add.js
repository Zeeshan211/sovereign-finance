/* Sovereign Finance Add Transaction Form v0.4.6
 *
 * Purpose:
 * - Restore Add Transaction as a real working finance entry page.
 * - Keep the Command Centre as truth/audit, not duplicate page logic.
 * - Always run transaction dry-run before a real save.
 * - Save only when Command Centre allows transaction.save.
 * - Never silently queue offline writes.
 * - Never bind undefined values into D1.
 *
 * Contract:
 * - GET/source loading is safe.
 * - POST dry_run=true performs no D1 transaction write and no audit write.
 * - Real POST is sent only after dry-run passes and Command Centre gate is allowed.
 * - Backend still performs its own Command Centre gate before mutation.
 */
(function () {
  "use strict";

  const VERSION = "v0.4.6";
  const ENFORCED_ACTION = "transaction.save";
  const COMMAND_CENTRE_ENDPOINT = "/api/finance-command-center";
  const TRANSACTIONS_ENDPOINT = "/api/transactions";
  const ACCOUNTS_ENDPOINT = "/api/accounts?debug=1";
  const CATEGORIES_ENDPOINT = "/api/categories";

  let selectedType = "expense";
  let requestedTo = "";
  let requestedFrom = "";
  let accounts = [];
  let categories = [];
  let categoriesLoaded = false;
  let submitting = false;
  let lastPreflight = null;
  let commandCentreLoaded = false;
  let commandCentreError = "";
  let saveGate = blockedGate(
    "Command Centre policy has not loaded yet.",
    "window.SovereignEnforcement",
    "Wait for Command Centre policy to load before real transaction.save."
  );

  const $ = id => document.getElementById(id);

  function todayLocal() {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0")
    ].join("-");
  }

  function cleanString(value, fallback) {
    const raw = value == null ? fallback : value;
    return String(raw == null ? "" : raw).trim();
  }

  function parseRoute() {
    const params = new URLSearchParams(window.location.search || "");
    const type = cleanString(params.get("type"), "").toLowerCase();
    const to = cleanString(params.get("to"), "");
    const from = cleanString(params.get("from"), "");

    if (["expense", "income", "transfer"].includes(type)) selectedType = type;
    if (to) requestedTo = to;
    if (from) requestedFrom = from;
    if (requestedTo && selectedType !== "transfer") selectedType = "transfer";
  }

  function toast(message, kind) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.className = "toast toast-" + (kind || "info");
    el.textContent = message;
    document.body.appendChild(el);

    window.setTimeout(() => el.classList.add("show"), 20);
    window.setTimeout(() => {
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 250);
    }, 3600);
  }

  async function fetchJSON(url, options) {
    const response = await fetch(url, {
      cache: "no-store",
      ...(options || {})
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data) {
      throw new Error((data && data.error) || "HTTP " + response.status);
    }

    if (data.ok === false) {
      throw new Error(data.error || "Request failed.");
    }

    return data;
  }

  function normalizeAccounts(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.accounts)) return raw.accounts;
    if (raw && typeof raw === "object") {
      return Object.keys(raw).map(id => ({ id, ...raw[id] }));
    }
    return [];
  }

  function normalizeCategories(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.categories)) return raw.categories;
    return [];
  }

  function accountName(account) {
    return cleanString(
      account && (account.name || account.label || account.account_name || account.id),
      ""
    );
  }

  function accountKind(account) {
    return cleanString(account && (account.kind || account.type), "").toLowerCase();
  }

  function accountLabel(account) {
    const name = accountName(account);
    const kind = accountKind(account);
    return [name || account.id, kind ? "(" + kind + ")" : ""].filter(Boolean).join(" ");
  }

  function categoryLabel(category) {
    return cleanString(category && (category.name || category.id), "");
  }

  function token(value) {
    return cleanString(value, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function findAccountByRouteKey(value) {
    if (!value) return null;
    const wanted = token(value);

    return accounts.find(account => {
      const id = token(account.id);
      const name = token(accountName(account));
      const kind = token(accountKind(account));

      if (wanted === id || wanted === name || wanted === kind) return true;
      if (wanted === "cc" && (id === "cc" || kind === "cc" || name.includes("credit"))) return true;
      if (wanted === "credit_card" && (kind === "cc" || name.includes("credit"))) return true;
      return false;
    }) || null;
  }

  function blockedGate(reason, source, requiredFix) {
    return {
      action: ENFORCED_ACTION,
      allowed: false,
      status: "blocked",
      level: 3,
      reason: reason || "Command Centre blocked transaction.save.",
      source: source || "enforcement.actions",
      required_fix: requiredFix || "Resolve Command Centre blocker before allowing transaction.save.",
      backend_enforced: true,
      frontend_enforced: true,
      override: { allowed: false, reason_required: true }
    };
  }

  function normalizeGate(raw) {
    if (!raw) {
      return blockedGate(
        "Command Centre returned no action policy for transaction.save.",
        "enforcement.actions",
        "Register transaction.save in Command Centre enforcement actions."
      );
    }

    const allowed = raw.allowed === true;

    return {
      ...raw,
      action: raw.action || ENFORCED_ACTION,
      allowed,
      status: allowed ? "pass" : (raw.status || "blocked"),
      level: Number(raw.level || (allowed ? 0 : 3)),
      reason: allowed
        ? "Command Centre allows transaction.save."
        : (raw.reason || "Command Centre blocked transaction.save."),
      source: raw.source || "enforcement.actions",
      required_fix: allowed
        ? "None."
        : (raw.required_fix || "Resolve Command Centre blocker before allowing transaction.save."),
      backend_enforced: raw.backend_enforced !== false,
      frontend_enforced: true,
      override: raw.override || { allowed: false, reason_required: true }
    };
  }

  function syncEnforcement(snapshot) {
    commandCentreLoaded = Boolean(snapshot && snapshot.loaded);
    commandCentreError = snapshot && snapshot.error ? String(snapshot.error) : "";

    if (!commandCentreLoaded) {
      saveGate = blockedGate(
        commandCentreError || "Command Centre policy is loading. Real save remains blocked until policy is available.",
        "window.SovereignEnforcement",
        "Open Command Centre if this does not load."
      );
      renderEnforcement();
      updateButton();
      return;
    }

    let gate = null;

    if (snapshot && typeof snapshot.findAction === "function") {
      gate = snapshot.findAction(ENFORCED_ACTION);
    }

    if (!gate && snapshot && snapshot.enforcement && Array.isArray(snapshot.enforcement.actions)) {
      gate = snapshot.enforcement.actions.find(item => item && item.action === ENFORCED_ACTION);
    }

    saveGate = normalizeGate(gate);
    renderEnforcement();
    updateButton();
  }

  async function loadCommandCentreFallback() {
    try {
      const data = await fetchJSON(COMMAND_CENTRE_ENDPOINT + "?cb=" + Date.now(), {
        headers: {
          accept: "application/json",
          "x-sovereign-add-page": VERSION
        }
      });

      const actions = data && data.enforcement && Array.isArray(data.enforcement.actions)
        ? data.enforcement.actions
        : [];

      const gate = actions.find(item => item && item.action === ENFORCED_ACTION);

      commandCentreLoaded = true;
      commandCentreError = "";
      saveGate = normalizeGate(gate);
    } catch (err) {
      commandCentreLoaded = false;
      commandCentreError = err.message || String(err);
      saveGate = blockedGate(
        "Command Centre policy could not be loaded. Real save remains blocked.",
        COMMAND_CENTRE_ENDPOINT,
        "Restore Command Centre response before allowing transaction.save."
      );
    }

    renderEnforcement();
    updateButton();
  }

  function ensureEnforcementSubscription() {
    if (window.SovereignEnforcement && typeof window.SovereignEnforcement.subscribe === "function") {
      window.SovereignEnforcement.subscribe(syncEnforcement);

      if (typeof window.SovereignEnforcement.refresh === "function") {
        window.SovereignEnforcement.refresh();
      }

      return;
    }

    loadCommandCentreFallback();
  }

  async function loadAccounts() {
    try {
      const data = await fetchJSON(ACCOUNTS_ENDPOINT);
      accounts = normalizeAccounts(data.accounts || data)
        .filter(account => account && account.id)
        .map(account => ({ ...account, id: cleanString(account.id, "") }));
    } catch (err) {
      console.warn("[add " + VERSION + "] /api/accounts failed:", err.message);

      try {
        if (window.store && typeof window.store.refreshBalances === "function") {
          await window.store.refreshBalances();
          accounts = normalizeAccounts(window.store.accounts || window.store.cachedAccounts || [])
            .filter(account => account && account.id)
            .map(account => ({ ...account, id: cleanString(account.id, "") }));
        }
      } catch (fallbackErr) {
        console.warn("[add " + VERSION + "] store account fallback failed:", fallbackErr.message);
      }
    }

    if (!accounts.length) {
      toast("Accounts failed to load. Add Transaction cannot save without an account.", "error");
    }
  }

  async function loadCategories() {
    categoriesLoaded = false;
    categories = [];

    try {
      const data = await fetchJSON(CATEGORIES_ENDPOINT);
      categories = normalizeCategories(data.categories || data)
        .filter(category => category && category.id)
        .map(category => ({
          ...category,
          id: cleanString(category.id, ""),
          name: cleanString(category.name || category.id, "")
        }));

      categoriesLoaded = true;
    } catch (err) {
      console.warn("[add " + VERSION + "] /api/categories failed:", err.message);
      categories = [];
      categoriesLoaded = false;
    }
  }

  function fillAccounts() {
    const source = $("accountSelect");
    const dest = $("transferToSelect");

    if (source) {
      const previous = source.value;
      source.innerHTML = '<option value="">Pick account...</option>';

      accounts.forEach(account => {
        const option = document.createElement("option");
        option.value = account.id;
        option.textContent = accountLabel(account);
        source.appendChild(option);
      });

      const routeFrom = findAccountByRouteKey(requestedFrom);

      if (routeFrom && Array.from(source.options).some(option => option.value === routeFrom.id)) {
        source.value = routeFrom.id;
      } else if (previous && Array.from(source.options).some(option => option.value === previous)) {
        source.value = previous;
      }
    }

    if (dest) fillTransferDest();
  }

  function fillTransferDest() {
    const dest = $("transferToSelect");
    const source = $("accountSelect");
    if (!dest) return;

    const from = source ? source.value : "";
    const previous = dest.value;

    dest.innerHTML = '<option value="">Pick account...</option>';

    accounts.forEach(account => {
      if (!account || !account.id || account.id === from) return;

      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = accountLabel(account);
      dest.appendChild(option);
    });

    const routeTo = findAccountByRouteKey(requestedTo);

    if (routeTo && routeTo.id !== from && Array.from(dest.options).some(option => option.value === routeTo.id)) {
      dest.value = routeTo.id;
      requestedTo = "";
    } else if (previous && previous !== from && Array.from(dest.options).some(option => option.value === previous)) {
      dest.value = previous;
    }
  }

  function fillCategories() {
    const select = $("categorySelect");
    if (!select) return;

    const previous = select.value;
    select.innerHTML = "";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = categories.length
      ? "No category"
      : categoriesLoaded
        ? "No categories in D1 - save without category"
        : "Categories unavailable - save without category";
    select.appendChild(empty);

    categories.forEach(category => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = categoryLabel(category);
      select.appendChild(option);
    });

    select.value = previous && Array.from(select.options).some(option => option.value === previous)
      ? previous
      : "";
    select.disabled = !categories.length;
  }

  function updateRouteCopy(type) {
    const trustPanel = $("addTrustPanel");
    const trustText = $("addTrustText");
    const safetyText = $("addSafetyText");
    const chip = $("submitClarityChip");

    const copy = {
      expense: {
        panelClass: "add-trust-panel",
        chipClass: "add-chip",
        chip: "Dry-run validates one ledger row",
        trust: "Expense validates account, amount, category, and D1-safe payload before saving.",
        safety: "Expense mode runs preflight first. Real save happens only when Command Centre allows transaction.save."
      },
      income: {
        panelClass: "add-trust-panel income",
        chipClass: "add-chip safe",
        chip: "Dry-run validates one ledger row",
        trust: "Income validates destination account, amount, category, and D1-safe payload before saving.",
        safety: "Income mode runs preflight first. Real save happens only when Command Centre allows transaction.save."
      },
      transfer: {
        panelClass: "add-trust-panel transfer",
        chipClass: "add-chip transfer",
        chip: "Dry-run validates transfer pair",
        trust: "Transfer validates source account, destination account, amount, and linked movement before saving.",
        safety: "Transfer mode runs preflight first. Real save happens only when Command Centre allows transaction.save."
      }
    };

    const item = copy[type] || copy.expense;

    if (trustPanel) trustPanel.className = item.panelClass;
    if (trustText) trustText.textContent = item.trust;
    if (safetyText) safetyText.textContent = item.safety;

    if (chip) {
      chip.className = item.chipClass;
      chip.textContent = item.chip;
    }
  }

  function renderEnforcement() {
    const panel = $("addEnforcementPanel");
    const chip = $("enforcementChip");
    if (!panel) return;

    const allowed = saveGate.allowed === true;
    const preflightPassed = Boolean(lastPreflight && lastPreflight.ok);

    panel.hidden = false;
    panel.classList.toggle("warning", commandCentreLoaded && !allowed);

    const summary = $("addEnforcementSummary");
    const action = $("addBlockedAction");
    const reason = $("addBlockReason");
    const source = $("addBlockSource");
    const fix = $("addRequiredFix");
    const override = $("addOverrideStatus");
    const backend = $("addBackendStatus");

    if (summary) {
      if (allowed && preflightPassed) {
        summary.textContent = "Preflight passed and Command Centre allows transaction.save. Real save is available.";
      } else if (allowed) {
        summary.textContent = "Command Centre allows transaction.save. This page will still run dry-run before saving.";
      } else if (preflightPassed) {
        summary.textContent = "Preflight passed, but real save is still blocked by Command Centre.";
      } else {
        summary.textContent = "This page can run safe preflight. Real save depends on Command Centre transaction.save authority.";
      }
    }

    if (action) action.textContent = saveGate.action || ENFORCED_ACTION;
    if (reason) reason.textContent = allowed ? "Allowed." : (saveGate.reason || "Blocked.");
    if (source) source.textContent = preflightPassed ? "/api/transactions?dry_run=1" : (saveGate.source || "Unknown");
    if (fix) fix.textContent = allowed ? "None." : (saveGate.required_fix || "Resolve blocker.");
    if (override) override.textContent = saveGate.override && saveGate.override.allowed ? "Allowed" : "Not allowed";
    if (backend) backend.textContent = saveGate.backend_enforced === false ? "Frontend only" : "Yes";

    if (chip) {
      chip.hidden = false;
      chip.textContent = allowed
        ? "Command Centre allowed"
        : preflightPassed
          ? "Preflight passed"
          : "Real save gated";
      chip.className = allowed || preflightPassed ? "add-chip safe" : "add-chip blocked";
    }
  }

  function resetPreflight() {
    lastPreflight = null;
    renderEnforcement();
    updateButton();
  }

  function setType(type) {
    selectedType = ["expense", "income", "transfer"].includes(type) ? type : "expense";

    document.querySelectorAll(".type-btn").forEach(button => {
      button.classList.toggle("active", button.dataset.type === selectedType);
    });

    const isTransfer = selectedType === "transfer";
    document.body.classList.toggle("transfer-mode", isTransfer);

    const transferWrap = $("transferToWrap");
    const categoryWrap = $("categoryWrap");
    const fromLabel = $("accountFromLabel");

    if (transferWrap) transferWrap.hidden = !isTransfer;
    if (categoryWrap) categoryWrap.hidden = isTransfer;
    if (fromLabel) fromLabel.textContent = isTransfer ? "From Account" : "Account";

    fillTransferDest();
    updateRouteCopy(selectedType);
    resetPreflight();
  }

  function getFormValidity() {
    const amount = Number(($("amountInput") || {}).value || 0);
    const from = cleanString(($("accountSelect") || {}).value, "");
    const to = cleanString(($("transferToSelect") || {}).value, "");

    if (submitting) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (!from) return false;
    if (selectedType === "transfer" && (!to || to === from)) return false;

    return true;
  }

  function setSubmitText(text) {
    const button = $("submitBtn");
    if (button) button.textContent = text;
  }

  function updateButton() {
    const button = $("submitBtn");
    if (!button) return;

    const valid = getFormValidity();
    button.disabled = !valid;

    if (submitting) {
      setSubmitText(saveGate.allowed ? "Saving..." : "Running Preflight...");
      return;
    }

    if (!valid) {
      setSubmitText("Complete Required Fields");
      return;
    }

    if (saveGate.allowed) {
      setSubmitText("Save Transaction");
      return;
    }

    if (lastPreflight && lastPreflight.ok) {
      setSubmitText("Preflight Passed - Save Still Gated");
      return;
    }

    setSubmitText("Run Safe Preflight");
  }

  function collectPayload() {
    const amount = Number(($("amountInput") || {}).value || 0);
    const accountId = cleanString(($("accountSelect") || {}).value, "");
    const transferToAccountId = cleanString(($("transferToSelect") || {}).value, "");
    const categoryId = cleanString(($("categorySelect") || {}).value, "");
    const date = cleanString(($("dateInput") || {}).value, todayLocal()).slice(0, 10);
    const notes = cleanString(($("notesInput") || {}).value, "").slice(0, 200);

    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than 0.");
    if (!accountId) throw new Error("Pick an account.");

    const payload = {
      date,
      type: selectedType,
      amount,
      account_id: accountId,
      category_id: selectedType === "transfer" ? null : (categoryId || null),
      notes,
      created_by: "web-add-" + VERSION.replace(/^v/, "")
    };

    if (selectedType === "transfer") {
      if (!transferToAccountId) throw new Error("Pick a destination account.");
      if (transferToAccountId === accountId) throw new Error("Source and destination accounts cannot match.");

      payload.transfer_to_account_id = transferToAccountId;
      payload.category_id = null;
    }

    return payload;
  }

  function payloadForDryRun(payload) {
    return {
      ...payload,
      dry_run: true,
      created_by: "web-add-preflight-" + VERSION.replace(/^v/, "")
    };
  }

  async function runDryRun(payload) {
    const response = await fetch(TRANSACTIONS_ENDPOINT + "?dry_run=1&cb=" + Date.now(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sovereign-add-page": VERSION
      },
      body: JSON.stringify(payloadForDryRun(payload))
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok !== true || data.dry_run !== true || data.writes_performed !== false) {
      throw new Error((data && data.error) || "Dry-run failed with HTTP " + response.status);
    }

    return data;
  }

  async function saveTransaction(payload) {
    const response = await fetch(TRANSACTIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sovereign-add-page": VERSION
      },
      body: JSON.stringify({
        ...payload,
        dry_run: false,
        created_by: "web-add-direct-" + VERSION.replace(/^v/, "")
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok !== true) {
      const message = (data && data.error) || "Save failed with HTTP " + response.status;
      const err = new Error(message);
      err.response = data;
      err.status = response.status;
      throw err;
    }

    return data;
  }

  async function refreshStoreAfterSave() {
    if (!window.store) return;

    const jobs = [];

    if (typeof window.store.refreshBalances === "function") jobs.push(window.store.refreshBalances());
    if (typeof window.store.refreshTransactions === "function") jobs.push(window.store.refreshTransactions());
    if (typeof window.store.refreshAuditLog === "function") jobs.push(window.store.refreshAuditLog());

    await Promise.allSettled(jobs);
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;

    let payload;

    try {
      payload = collectPayload();
    } catch (err) {
      toast(err.message || String(err), "error");
      updateButton();
      return;
    }

    submitting = true;
    lastPreflight = null;
    renderEnforcement();
    updateButton();

    try {
      const dryRun = await runDryRun(payload);

      lastPreflight = {
        ok: true,
        at: new Date().toISOString(),
        result: dryRun
      };

      renderEnforcement();

      if (!saveGate.allowed) {
        toast("Preflight passed. Real save is still gated by Command Centre.", "success");
        submitting = false;
        updateButton();
        return;
      }

      setSubmitText("Saving...");

      const result = await saveTransaction(payload);
      await refreshStoreAfterSave();

      const savedId = result.id || (Array.isArray(result.ids) ? result.ids[0] : "");
      const redirect = new URL("/transactions.html", window.location.origin);

      if (savedId) redirect.searchParams.set("saved", savedId);
      if (payload.type) redirect.searchParams.set("type", payload.type);

      toast(payload.type === "transfer" ? "Transfer saved." : "Transaction saved.", "success");

      window.setTimeout(() => {
        window.location.href = redirect.pathname + redirect.search;
      }, 500);
    } catch (err) {
      lastPreflight = {
        ok: false,
        at: new Date().toISOString(),
        error: err.message || String(err)
      };

      console.error("[add " + VERSION + "] submit failed:", err);
      toast(err.message || "Transaction failed.", "error");

      submitting = false;
      renderEnforcement();
      updateButton();
    }
  }

  function wireEvents() {
    document.querySelectorAll(".type-btn").forEach(button => {
      button.addEventListener("click", () => {
        setType(button.dataset.type || "expense");
      });
    });

    ["amountInput", "accountSelect", "transferToSelect", "categorySelect", "dateInput", "notesInput"].forEach(id => {
      const el = $(id);
      if (!el) return;

      el.addEventListener("input", () => {
        resetPreflight();
      });

      el.addEventListener("change", () => {
        if (id === "accountSelect") fillTransferDest();
        resetPreflight();
      });
    });

    const form = $("addForm");
    if (form) form.addEventListener("submit", submit);
  }

  async function init() {
    console.log("[add " + VERSION + "] init");

    parseRoute();

    const dateInput = $("dateInput");
    if (dateInput && !dateInput.value) dateInput.value = todayLocal();

    wireEvents();
    ensureEnforcementSubscription();

    await Promise.all([
      loadAccounts(),
      loadCategories()
    ]);

    fillAccounts();
    fillCategories();
    setType(selectedType);
    renderEnforcement();
    updateButton();

    console.log("[add " + VERSION + "] ready", {
      accounts: accounts.length,
      categories: categories.length,
      categoriesLoaded,
      selectedType,
      commandCentreLoaded,
      saveGate,
      lastPreflight
    });
  }

  window.SovereignAdd = {
    version: VERSION,
    get selectedType() {
      return selectedType;
    },
    accounts: () => accounts.slice(),
    categories: () => categories.slice(),
    gate: () => ({ ...saveGate }),
    commandCentre: () => ({
      loaded: commandCentreLoaded,
      error: commandCentreError,
      gate: { ...saveGate }
    }),
    preflight: async () => {
      const payload = collectPayload();
      const result = await runDryRun(payload);
      lastPreflight = {
        ok: true,
        at: new Date().toISOString(),
        result
      };
      renderEnforcement();
      updateButton();
      return result;
    },
    save: async () => {
      const payload = collectPayload();
      const dryRun = await runDryRun(payload);

      if (!saveGate.allowed) {
        return {
          ok: false,
          dry_run_ok: true,
          blocked: true,
          gate: { ...saveGate },
          proof: dryRun.proof || null
        };
      }

      return saveTransaction(payload);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
