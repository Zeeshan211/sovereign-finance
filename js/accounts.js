(function () {
  "use strict";

  if (window.SovereignAccounts && window.SovereignAccounts.initialized) return;

  const VERSION = "v1.0.0-readonly-shared-ui";
  const ACCOUNTS_ENDPOINT = "/api/accounts";
  const BALANCES_ENDPOINT = "/api/balances";

  let accountsPayload = null;
  let balancesPayload = null;
  let normalized = {
    active: [],
    assets: [],
    liabilities: [],
    archived: []
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

  function round2(value) {
    return Math.round(asNumber(value, 0) * 100) / 100;
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
    if (el) el.hidden = !!hidden;
  }

  function setPill(id, label, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = label == null ? "" : String(label);
    el.className = "sf-pill" + (tone ? " sf-pill--" + tone : "");
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-sovereign-accounts-page": VERSION
      }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data) {
      throw new Error((data && data.error) || "HTTP " + response.status);
    }

    if (data.ok === false) {
      throw new Error(data.error || "Request failed");
    }

    return data;
  }

  function unwrapAccounts(payload) {
    if (!payload) return [];

    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;

    if (payload.data && Array.isArray(payload.data.accounts)) {
      return payload.data.accounts;
    }

    return [];
  }

  function unwrapArchived(payload, allAccounts) {
    if (!payload) return [];

    const direct =
      Array.isArray(payload.archived) ? payload.archived :
      Array.isArray(payload.archived_accounts) ? payload.archived_accounts :
      Array.isArray(payload.archivedAccounts) ? payload.archivedAccounts :
      payload.data && Array.isArray(payload.data.archived) ? payload.data.archived :
      payload.data && Array.isArray(payload.data.archived_accounts) ? payload.data.archived_accounts :
      null;

    if (direct) return direct;

    return (allAccounts || []).filter(account => isArchived(account));
  }

  function isArchived(account) {
    const status = String(account.status || "").toLowerCase();
    return Boolean(
      status === "archived" ||
      account.archived_at ||
      account.deleted_at ||
      account.is_archived === true ||
      account.archived === true
    );
  }

  function isLiability(account) {
    const type = String(account.type || "").toLowerCase();
    const kind = String(account.kind || "").toLowerCase();
    return type === "liability" || kind === "cc" || kind === "credit_card";
  }

  function accountId(account) {
    return account.id || account.account_id || "";
  }

  function accountName(account) {
    return account.name || account.label || account.account_name || accountId(account) || "Account";
  }

  function accountKindLabel(account) {
    const kind = String(account.kind || account.type || "account").replace(/_/g, " ");
    return kind.replace(/\b\w/g, ch => ch.toUpperCase());
  }

  function accountBalance(account) {
    if (account.balance != null) return asNumber(account.balance, 0);
    if (account.current_balance != null) return asNumber(account.current_balance, 0);
    if (account.amount != null) return asNumber(account.amount, 0);
    return 0;
  }

  function liabilityOutstanding(account) {
    if (account.cc_outstanding != null) return asNumber(account.cc_outstanding, 0);
    if (account.outstanding != null) return asNumber(account.outstanding, 0);

    const balance = accountBalance(account);
    return Math.max(0, -balance);
  }

  function normalize(payload) {
    const all = unwrapAccounts(payload);
    const archived = unwrapArchived(payload, all);

    const archivedIds = new Set(archived.map(accountId).filter(Boolean));

    const active = all.filter(account => {
      const id = accountId(account);
      if (id && archivedIds.has(id)) return false;
      return !isArchived(account);
    });

    const assets = active.filter(account => !isLiability(account));
    const liabilities = active.filter(account => isLiability(account));

    return {
      all,
      active,
      assets,
      liabilities,
      archived
    };
  }

  function sourceVersion(payload) {
    return payload && (payload.version || payload.api_version || payload.contract_version || "unknown");
  }

  function balancesSummary(payload) {
    const data = payload || {};

    return {
      netWorth:
        data.net_worth ??
        data.netWorth ??
        data.summary?.net_worth ??
        data.summary?.netWorth,

      liquid:
        data.total_liquid ??
        data.totalLiquid ??
        data.liquid_now ??
        data.summary?.total_liquid ??
        data.summary?.totalLiquid,

      ccOutstanding:
        data.cc_outstanding ??
        data.ccOutstanding ??
        data.credit_card_outstanding ??
        data.summary?.cc_outstanding ??
        data.summary?.ccOutstanding,

      trueBurden:
        data.true_burden ??
        data.trueBurden ??
        data.summary?.true_burden ??
        data.summary?.trueBurden
    };
  }

  function statusTextForAccount(account) {
    const status = account.status || "active";
    const type = account.type || "asset";
    const kind = account.kind || "account";
    const currency = account.currency || "PKR";

    return `${accountKindLabel({ kind })} · ${String(type).replace(/_/g, " ")} · ${status} · ${currency}`;
  }

  function ccMeta(account) {
    const items = [];

    if (account.credit_limit != null) {
      items.push("Limit " + money(account.credit_limit));
    }

    if (account.available_credit != null) {
      items.push("Available " + money(account.available_credit));
    }

    const utilization =
      account.cc_utilization_pct ??
      account.utilization_pct ??
      account.credit_utilization_pct;

    if (utilization != null && Number.isFinite(Number(utilization))) {
      items.push("Utilization " + percent(utilization));
    }

    const dueDays =
      account.days_to_payment_due ??
      account.days_until_payment_due ??
      account.payment_due_days;

    if (dueDays != null && Number.isFinite(Number(dueDays))) {
      const n = Number(dueDays);
      if (n < 0) items.push("Overdue " + Math.abs(n) + "d");
      else if (n === 0) items.push("Due today");
      else items.push("Due in " + n + "d");
    }

    if (account.cc_status_label) {
      items.push(account.cc_status_label);
    }

    return items;
  }

  function toneForBalance(value, liability) {
    const n = asNumber(value, 0);

    if (liability) {
      return n > 0 ? "warning" : "positive";
    }

    if (n < 0) return "danger";
    if (n === 0) return "info";
    return "positive";
  }

  function rowHtml(account, options) {
    const opts = options || {};
    const liability = !!opts.liability;
    const balance = liability ? liabilityOutstanding(account) : accountBalance(account);
    const tone = toneForBalance(balance, liability);
    const id = accountId(account);
    const metaParts = liability ? ccMeta(account) : [];

    return `
      <div class="sf-finance-row" data-account-id="${esc(id)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(accountName(account))}</div>
          <div class="sf-row-subtitle">${esc(statusTextForAccount(account))}</div>
          ${
            metaParts.length
              ? `<div class="sf-row-subtitle">${metaParts.map(esc).join(" · ")}</div>`
              : ""
          }
        </div>
        <div class="sf-row-right">
          <div class="sf-tone-${tone}">${money(balance)}</div>
          <div class="sf-row-subtitle">${liability ? "outstanding" : "balance"}</div>
        </div>
      </div>
    `;
  }

  function emptyState(title, subtitle, actionHtml) {
    const c = components();
    if (typeof c.emptyState === "function") {
      return c.emptyState({ title, subtitle, actionHtml });
    }

    return `
      <div class="sf-empty-state">
        <div>
          <h3 class="sf-card-title">${esc(title)}</h3>
          <p class="sf-card-subtitle">${esc(subtitle || "")}</p>
          ${actionHtml ? `<div class="sf-empty-action">${actionHtml}</div>` : ""}
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

  function renderAccountLists() {
    const assets = normalized.assets || [];
    const liabilities = normalized.liabilities || [];

    const assetTotal = round2(assets.reduce((sum, account) => sum + accountBalance(account), 0));
    const liabilityTotal = round2(liabilities.reduce((sum, account) => sum + liabilityOutstanding(account), 0));

    setPill("acc-assets-count", `${assets.length} account${assets.length === 1 ? "" : "s"}`, "info");
    setPill("acc-assets-total", money(assetTotal), assetTotal > 0 ? "positive" : "info");

    setPill("acc-liabilities-count", `${liabilities.length} account${liabilities.length === 1 ? "" : "s"}`, "info");
    setPill("acc-liabilities-total", money(liabilityTotal), liabilityTotal > 0 ? "warning" : "positive");

    setHTML(
      "acc-assets-list",
      assets.length
        ? assets.map(account => rowHtml(account, { liability: false })).join("")
        : emptyState("No asset accounts", "No active asset accounts were returned by /api/accounts.")
    );

    setHTML(
      "acc-liabilities-list",
      liabilities.length
        ? liabilities.map(account => rowHtml(account, { liability: true })).join("")
        : emptyState("No liabilities", "No active liability accounts were returned by /api/accounts.")
    );
  }

  function renderArchived() {
    const archived = normalized.archived || [];
    const panel = $("acc-archived-panel");
    const toggle = $("acc-archived-toggle");
    const list = $("acc-archived-list");

    if (!panel || !toggle || !list) return;

    if (!archived.length) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    setPill("acc-archived-count", `${archived.length} archived`, "info");

    list.innerHTML = archived.map(account => {
      const liability = isLiability(account);
      return rowHtml(account, { liability });
    }).join("");

    list.hidden = true;
    toggle.textContent = "Show archived";
    toggle.setAttribute("aria-expanded", "false");

    toggle.onclick = function () {
      const nextHidden = !list.hidden;
      list.hidden = nextHidden;
      toggle.textContent = nextHidden ? "Show archived" : "Hide archived";
      toggle.setAttribute("aria-expanded", String(!nextHidden));
    };
  }

  function renderBalances() {
    if (!balancesPayload) {
      setText("acc-net-worth", "Unavailable");
      setText("acc-liquid", "Unavailable");
      setText("acc-cc-outstanding", "Unavailable");
      setText("acc-true-burden", "Unavailable");
      return;
    }

    const summary = balancesSummary(balancesPayload);

    setText("acc-net-worth", summary.netWorth == null ? "Unavailable" : money(summary.netWorth));
    setText("acc-liquid", summary.liquid == null ? "Unavailable" : money(summary.liquid));
    setText("acc-cc-outstanding", summary.ccOutstanding == null ? "Unavailable" : money(summary.ccOutstanding));
    setText("acc-true-burden", summary.trueBurden == null ? "Unavailable" : money(summary.trueBurden));
  }

  function updateShellKpis() {
    const activeCount = normalized.active.length;
    const summary = balancesSummary(balancesPayload);

    const balancesOk = !!balancesPayload;
    const accountsOk = !!accountsPayload;

    const kpis = [
      {
        title: "Net Worth",
        kicker: "Balances API",
        valueHtml: balancesOk && summary.netWorth != null ? money(summary.netWorth) : "Unavailable",
        subtitle: balancesOk ? "From /api/balances" : "Balances API failed",
        foot: "No frontend fallback",
        tone: balancesOk ? toneForBalance(summary.netWorth, false) : "danger"
      },
      {
        title: "Liquid Assets",
        kicker: "Balances API",
        valueHtml: balancesOk && summary.liquid != null ? money(summary.liquid) : "Unavailable",
        subtitle: "Asset-side cash position",
        foot: "Canonical top metric",
        tone: balancesOk ? toneForBalance(summary.liquid, false) : "danger"
      },
      {
        title: "CC Outstanding",
        kicker: "Balances API",
        valueHtml: balancesOk && summary.ccOutstanding != null ? money(summary.ccOutstanding) : "Unavailable",
        subtitle: "Credit-card pressure",
        foot: "Liability truth",
        tone: balancesOk && asNumber(summary.ccOutstanding, 0) > 0 ? "warning" : balancesOk ? "positive" : "danger"
      },
      {
        title: "Active Accounts",
        kicker: "Accounts API",
        valueHtml: accountsOk ? String(activeCount) : "Unavailable",
        subtitle: accountsOk ? "From /api/accounts" : "Accounts API failed",
        foot: "Read-only inventory",
        tone: accountsOk ? "info" : "danger"
      }
    ];

    if (window.SFShell && typeof window.SFShell.setKpis === "function") {
      window.SFShell.setKpis(kpis);
    }
  }

  function renderSourceStatus(accountsOk, balancesOk, accountsError, balancesError) {
    const now = new Date();

    setPill(
      "acc-source-status",
      accountsOk && balancesOk ? "Sources OK" : "Source issue",
      accountsOk && balancesOk ? "positive" : "danger"
    );

    setText(
      "acc-accounts-api-status",
      accountsOk ? `OK · ${sourceVersion(accountsPayload)}` : `Failed · ${accountsError || "unknown"}`
    );

    setText(
      "acc-balances-api-status",
      balancesOk ? `OK · ${sourceVersion(balancesPayload)}` : `Failed · ${balancesError || "unknown"}`
    );

    const accStatus = $("acc-accounts-api-status");
    if (accStatus) accStatus.className = "sf-row-right " + (accountsOk ? "sf-tone-positive" : "sf-tone-danger");

    const balStatus = $("acc-balances-api-status");
    if (balStatus) balStatus.className = "sf-row-right " + (balancesOk ? "sf-tone-positive" : "sf-tone-danger");

    setText("acc-last-loaded", now.toLocaleString("en-PK", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }));
  }

  function renderDebug() {
    const debug = {
      page_version: VERSION,
      mode: "read-only",
      endpoints: {
        accounts: ACCOUNTS_ENDPOINT,
        balances: BALANCES_ENDPOINT
      },
      contract: {
        account_rows_source: "/api/accounts",
        net_worth_source: "/api/balances",
        frontend_net_worth_fallback: false,
        writes_enabled: false,
        dry_run_enabled: false,
        correction_path: "Reconciliation + Audit Trail; D1 console only as last-resort repair outside this page"
      },
      normalized_counts: {
        all: normalized.all ? normalized.all.length : 0,
        active: normalized.active.length,
        assets: normalized.assets.length,
        liabilities: normalized.liabilities.length,
        archived: normalized.archived.length
      },
      normalized_accounts: normalized,
      accounts_payload: accountsPayload,
      balances_payload: balancesPayload
    };

    setText("acc-debug-output", JSON.stringify(debug, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function renderAccountsError(message) {
    setHTML(
      "acc-assets-list",
      errorState("Accounts API failed", message || "Could not load /api/accounts.")
    );

    setHTML(
      "acc-liabilities-list",
      errorState("Accounts API failed", "Liability rows cannot render without /api/accounts.")
    );

    setPill("acc-assets-count", "Unavailable", "danger");
    setPill("acc-assets-total", "Unavailable", "danger");
    setPill("acc-liabilities-count", "Unavailable", "danger");
    setPill("acc-liabilities-total", "Unavailable", "danger");
    setHidden("acc-archived-panel", true);
  }

  function renderBalancesError(message) {
    setText("acc-net-worth", "Unavailable");
    setText("acc-liquid", "Unavailable");
    setText("acc-cc-outstanding", "Unavailable");
    setText("acc-true-burden", "Unavailable");

    const summaryPanel = $("acc-summary-title");
    if (summaryPanel) {
      const parent = summaryPanel.closest(".sf-panel");
      if (parent && !parent.querySelector(".acc-balances-error")) {
        const div = document.createElement("div");
        div.className = "acc-balances-error sf-empty-state sf-tone-danger";
        div.innerHTML = `
          <div>
            <h3 class="sf-card-title">Balances source unavailable</h3>
            <p class="sf-card-subtitle">${esc(message || "Could not load /api/balances.")}</p>
            <p class="sf-card-subtitle">Net worth is not recalculated in the frontend.</p>
          </div>
        `;
        parent.appendChild(div);
      }
    }
  }

  async function loadAll() {
    setPill("acc-source-status", "Loading", "info");
    setText("acc-accounts-api-status", "Loading");
    setText("acc-balances-api-status", "Loading");

    setHTML("acc-assets-list", loadingState("Loading assets", "Reading /api/accounts."));
    setHTML("acc-liabilities-list", loadingState("Loading liabilities", "Reading /api/accounts."));

    let accountsOk = false;
    let balancesOk = false;
    let accountsError = "";
    let balancesError = "";

    const [accountsResult, balancesResult] = await Promise.allSettled([
      fetchJSON(ACCOUNTS_ENDPOINT),
      fetchJSON(BALANCES_ENDPOINT)
    ]);

    if (accountsResult.status === "fulfilled") {
      accountsPayload = accountsResult.value;
      normalized = normalize(accountsPayload);
      accountsOk = true;
      renderAccountLists();
      renderArchived();
    } else {
      accountsPayload = null;
      normalized = {
        active: [],
        assets: [],
        liabilities: [],
        archived: []
      };
      accountsError = accountsResult.reason && accountsResult.reason.message
        ? accountsResult.reason.message
        : "Unknown error";
      renderAccountsError(accountsError);
    }

    if (balancesResult.status === "fulfilled") {
      balancesPayload = balancesResult.value;
      balancesOk = true;
      renderBalances();
    } else {
      balancesPayload = null;
      balancesError = balancesResult.reason && balancesResult.reason.message
        ? balancesResult.reason.message
        : "Unknown error";
      renderBalancesError(balancesError);
    }

    renderSourceStatus(accountsOk, balancesOk, accountsError, balancesError);
    updateShellKpis();
    renderDebug();
  }

  function init() {
    window.SovereignAccounts = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      accountsPayload: () => accountsPayload,
      balancesPayload: () => balancesPayload,
      normalized: () => normalized
    };

    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
