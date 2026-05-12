(function () {
  "use strict";

  if (window.SovereignHub && window.SovereignHub.initialized) return;

  const VERSION = "v1.0.0-shared-ui-readonly";
  const ENDPOINTS = {
    balances: "/api/balances",
    forecast: "/api/forecast",
    transactions: "/api/transactions",
    bills: "/api/bills",
    debts: "/api/debts"
  };

  let state = {
    balances: null,
    forecast: null,
    transactions: null,
    bills: null,
    debts: null,
    errors: {}
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

  function setStatus(id, label, ok) {
    const el = $(id);
    if (!el) return;

    el.textContent = label == null ? "" : String(label);
    el.className = "sf-row-right " + (ok ? "sf-tone-positive" : "sf-tone-danger");
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
        "x-sovereign-hub-page": VERSION
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

  function sourceVersion(payload) {
    return payload && (payload.version || payload.api_version || payload.contract_version || "unknown");
  }

  function firstValue(obj, keys) {
    for (const key of keys) {
      if (obj && obj[key] != null) return obj[key];
    }

    return undefined;
  }

  function balancesSummary(payload) {
    const p = payload || {};
    const s = p.summary || {};

    return {
      liquid: firstValue(p, ["total_liquid", "totalLiquid", "liquid_now", "liquidNow"]) ?? firstValue(s, ["total_liquid", "totalLiquid", "liquid_now", "liquidNow"]),
      netWorth: firstValue(p, ["net_worth", "netWorth"]) ?? firstValue(s, ["net_worth", "netWorth"]),
      trueBurden: firstValue(p, ["true_burden", "trueBurden"]) ?? firstValue(s, ["true_burden", "trueBurden"]),
      ccOutstanding: firstValue(p, ["cc_outstanding", "ccOutstanding", "credit_card_outstanding"]) ?? firstValue(s, ["cc_outstanding", "ccOutstanding", "credit_card_outstanding"]),
      debtPayable: firstValue(p, ["debt_payable", "debtPayable", "payable_debt", "payableDebt"]) ?? firstValue(s, ["debt_payable", "debtPayable", "payable_debt", "payableDebt"]),
      receivables: firstValue(p, ["receivables", "receivable_total", "receivableTotal"]) ?? firstValue(s, ["receivables", "receivable_total", "receivableTotal"])
    };
  }

  function forecastSummary(payload) {
    const p = payload || {};
    const s = p.summary || {};
    const data = p.forecast || p.data || {};

    const src = Object.assign({}, data, s, p);

    return {
      status: firstValue(src, ["status", "runway_status", "runwayStatus", "safety_status", "safetyStatus"]),
      liquidNow: firstValue(src, ["liquidNow", "liquid_now"]),
      salaryForecast: firstValue(src, ["salaryForecast", "salary_forecast"]),
      billsRemaining: firstValue(src, ["billsRemaining", "bills_remaining"]),
      debtPayable: firstValue(src, ["debtPayable", "debt_payable"]),
      receivables: firstValue(src, ["receivables"]),
      ccOutstanding: firstValue(src, ["ccOutstanding", "cc_outstanding"]),
      lowestProjectedBalance: firstValue(src, ["lowestProjectedBalance", "lowest_projected_balance", "lowestBalance", "lowest_balance"]),
      firstUnsafeDate: firstValue(src, ["firstUnsafeDate", "first_unsafe_date", "unsafeDate", "unsafe_date"]),
      projectionDays: firstValue(src, ["projectionDays", "projection_days", "days"])
    };
  }

  function unwrapArray(payload, keys) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;

    for (const key of keys) {
      if (Array.isArray(payload[key])) return payload[key];
    }

    if (payload.data) {
      if (Array.isArray(payload.data)) return payload.data;

      for (const key of keys) {
        if (Array.isArray(payload.data[key])) return payload.data[key];
      }
    }

    return [];
  }

  function normalizeTransactions(payload) {
    return unwrapArray(payload, ["transactions", "items", "rows"])
      .filter(txn => {
        const status = String(txn.status || "").toLowerCase();
        const type = String(txn.type || "").toLowerCase();
        return status !== "reversed" && type !== "reversal";
      });
  }

  function normalizeBills(payload) {
    return unwrapArray(payload, ["bills", "items", "rows"]);
  }

  function normalizeDebts(payload) {
    return unwrapArray(payload, ["debts", "items", "rows"]);
  }

  function toneForMoney(value, inverse) {
    const n = asNumber(value, 0);
    if (inverse) return n > 0 ? "warning" : "positive";
    if (n < 0) return "danger";
    if (n === 0) return "info";
    return "positive";
  }

  function forecastTone(summary) {
    const status = String(summary.status || "").toLowerCase();

    if (status.includes("unsafe") || status.includes("critical") || status.includes("danger")) return "danger";
    if (status.includes("watch") || status.includes("warning")) return "warning";
    if (status.includes("safe") || status.includes("clear") || status.includes("ok")) return "positive";

    const lowest = Number(summary.lowestProjectedBalance);
    if (Number.isFinite(lowest) && lowest < 0) return "danger";
    if (Number.isFinite(lowest) && lowest < 5000) return "warning";

    return "info";
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
          ${subtitle ? `<p class="sf-card-subtitle">${esc(subtitle)}</p>` : ""}
          ${actionHtml ? `<div class="sf-empty-action">${actionHtml}</div>` : ""}
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

  function rowHtml(title, subtitle, value, tone, href) {
    const tag = href ? "a" : "div";
    const hrefAttr = href ? ` href="${esc(href)}"` : "";

    return `
      <${tag} class="sf-finance-row"${hrefAttr}>
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(title)}</div>
          ${subtitle ? `<div class="sf-row-subtitle">${esc(subtitle)}</div>` : ""}
        </div>
        <div class="sf-row-right ${tone ? "sf-tone-" + esc(tone) : ""}">
          ${value == null ? "—" : value}
        </div>
      </${tag}>
    `;
  }

  function dateLabel(value) {
    if (!value) return "No date";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleDateString("en-PK", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  }

  function todayDay() {
    return new Date().getDate();
  }

  function daysUntilDay(day) {
    const d = Number(day);
    if (!Number.isFinite(d) || d < 1 || d > 31) return null;

    const today = new Date();
    const current = today.getDate();

    if (d >= current) return d - current;

    const next = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    return (next - current) + d;
  }

  function billAmount(bill) {
    return firstValue(bill, ["remaining", "remaining_amount", "amount_remaining", "amount", "default_amount"]) ?? 0;
  }

  function debtOutstanding(debt) {
    if (debt.outstanding != null) return asNumber(debt.outstanding, 0);
    if (debt.remaining != null) return asNumber(debt.remaining, 0);
    if (debt.remaining_amount != null) return asNumber(debt.remaining_amount, 0);

    const original = asNumber(debt.original_amount ?? debt.amount, 0);
    const paid = asNumber(debt.paid_amount ?? debt.paid, 0);

    return Math.max(0, original - paid);
  }

  function renderBalances() {
    if (!state.balances) {
      setText("hub-liquid", "Unavailable");
      setText("hub-net-worth", "Unavailable");
      setText("hub-true-burden", "Unavailable");
      setText("hub-cc-outstanding", "Unavailable");
      return;
    }

    const b = balancesSummary(state.balances);

    setText("hub-liquid", b.liquid == null ? "Unavailable" : money(b.liquid));
    setText("hub-net-worth", b.netWorth == null ? "Unavailable" : money(b.netWorth));
    setText("hub-true-burden", b.trueBurden == null ? "Unavailable" : money(b.trueBurden));
    setText("hub-cc-outstanding", b.ccOutstanding == null ? "Unavailable" : money(b.ccOutstanding));
    setText("hub-debt-payable", b.debtPayable == null ? "Unavailable" : money(b.debtPayable));
    setText("hub-receivables", b.receivables == null ? "Unavailable" : money(b.receivables));
    setText("hub-cc-pressure", b.ccOutstanding == null ? "Unavailable" : money(b.ccOutstanding));
  }

  function renderForecast() {
    if (!state.forecast) {
      setPill("hub-forecast-pill", "Unavailable", "danger");
      setHTML("hub-forecast-panel", errorState("Forecast unavailable", state.errors.forecast || "Could not load /api/forecast."));
      return;
    }

    const f = forecastSummary(state.forecast);
    const tone = forecastTone(f);
    const label = f.status || (f.firstUnsafeDate ? "Watch" : "Loaded");

    setPill("hub-forecast-pill", label, tone);

    const rows = [
      rowHtml("Runway Status", "Forecast API status", esc(label), tone),
      rowHtml("Lowest Projected Balance", "Lowest visible projected cash position", f.lowestProjectedBalance == null ? "—" : money(f.lowestProjectedBalance), toneForMoney(f.lowestProjectedBalance, false)),
      rowHtml("First Unsafe Date", "Only shown when forecast exposes it", esc(f.firstUnsafeDate || "—"), f.firstUnsafeDate ? "danger" : "positive"),
      rowHtml("Salary Forecast", "Expected salary input from salary source", f.salaryForecast == null ? "—" : money(f.salaryForecast), "info"),
      rowHtml("Bills Remaining", "Forecast bill pressure", f.billsRemaining == null ? "—" : money(f.billsRemaining), toneForMoney(f.billsRemaining, true)),
      rowHtml("Projection Days", "Forecast horizon", f.projectionDays == null ? "—" : esc(String(f.projectionDays)), "info")
    ];

    setHTML("hub-forecast-panel", rows.join(""));

    if (f.billsRemaining != null) {
      setText("hub-bills-remaining", money(f.billsRemaining));
    }
  }

  function renderTransactions() {
    if (!state.transactions) {
      setHTML("hub-recent-transactions", errorState("Transactions unavailable", state.errors.transactions || "Could not load /api/transactions."));
      return;
    }

    const rows = normalizeTransactions(state.transactions).slice(0, 5);

    if (!rows.length) {
      setHTML("hub-recent-transactions", emptyState("No recent transactions", "No visible non-reversed ledger rows returned."));
      return;
    }

    setHTML("hub-recent-transactions", rows.map(txn => {
      const title = txn.merchant || txn.payee || txn.title || txn.notes || txn.category || txn.type || "Transaction";
      const subtitle = [
        dateLabel(txn.date || txn.created_at || txn.timestamp),
        txn.type,
        txn.account || txn.account_id || txn.source_account_id
      ].filter(Boolean).join(" · ");

      const amount = asNumber(txn.amount, 0);
      const tone = String(txn.type || "").toLowerCase() === "income" ? "positive" : amount < 0 ? "danger" : "warning";

      return rowHtml(title, subtitle, money(Math.abs(amount)), tone, "/transactions.html");
    }).join(""));
  }

  function renderBills() {
    if (!state.bills) {
      setHTML("hub-due-bills", errorState("Bills unavailable", state.errors.bills || "Could not load /api/bills."));
      return;
    }

    const bills = normalizeBills(state.bills)
      .filter(bill => String(bill.status || "active").toLowerCase() !== "inactive")
      .map(bill => {
        const dueDay = bill.due_day ?? bill.dueDay;
        const days = daysUntilDay(dueDay);
        return Object.assign({}, bill, { _daysUntilDue: days });
      })
      .filter(bill => bill._daysUntilDue == null || bill._daysUntilDue <= 7)
      .sort((a, b) => {
        const da = a._daysUntilDue == null ? 999 : a._daysUntilDue;
        const db = b._daysUntilDue == null ? 999 : b._daysUntilDue;
        return da - db;
      })
      .slice(0, 5);

    if (!bills.length) {
      setHTML("hub-due-bills", emptyState("No bills due soon", "No bill pressure inside the next seven days."));
      return;
    }

    setHTML("hub-due-bills", bills.map(bill => {
      const name = bill.name || bill.title || bill.label || "Bill";
      const days = bill._daysUntilDue;
      const subtitle = days == null
        ? "Due day missing"
        : days === 0
          ? "Due today"
          : days === 1
            ? "Due tomorrow"
            : `Due in ${days}d`;

      return rowHtml(name, subtitle, money(billAmount(bill)), days != null && days <= 2 ? "danger" : "warning", "/bills.html");
    }).join(""));
  }

  function renderDebts() {
    if (!state.debts) {
      setHTML("hub-top-debts", errorState("Debts unavailable", state.errors.debts || "Could not load /api/debts."));
      return;
    }

    const debts = normalizeDebts(state.debts)
      .filter(debt => String(debt.status || "active").toLowerCase() !== "closed")
      .map(debt => Object.assign({}, debt, { _outstanding: debtOutstanding(debt) }))
      .filter(debt => debt._outstanding > 0)
      .sort((a, b) => b._outstanding - a._outstanding)
      .slice(0, 5);

    if (!debts.length) {
      setHTML("hub-top-debts", emptyState("No active debt pressure", "No outstanding active debts returned."));
      return;
    }

    setHTML("hub-top-debts", debts.map(debt => {
      const name = debt.name || debt.person || debt.counterparty || debt.title || "Debt";
      const kind = debt.kind || debt.type || "debt";
      const due = debt.due_date || debt.due_day || debt.dueDay;
      const subtitle = [kind, due ? "Due " + due : ""].filter(Boolean).join(" · ");

      return rowHtml(name, subtitle, money(debt._outstanding), "warning", "/debts.html");
    }).join(""));
  }

  function renderObligationFallbacks() {
    const b = balancesSummary(state.balances);
    const f = forecastSummary(state.forecast);

    if (!state.forecast && !state.balances) {
      setText("hub-bills-remaining", "Unavailable");
      setText("hub-debt-payable", "Unavailable");
      setText("hub-receivables", "Unavailable");
      setText("hub-cc-pressure", "Unavailable");
      return;
    }

    if (f.billsRemaining != null) setText("hub-bills-remaining", money(f.billsRemaining));
    else if (!$("hub-bills-remaining")?.textContent || $("hub-bills-remaining").textContent === "Loading") {
      setText("hub-bills-remaining", "Unavailable");
    }

    if (b.debtPayable != null) setText("hub-debt-payable", money(b.debtPayable));
    if (b.receivables != null) setText("hub-receivables", money(b.receivables));
    if (b.ccOutstanding != null) setText("hub-cc-pressure", money(b.ccOutstanding));
  }

  function updateShellKpis() {
    const b = balancesSummary(state.balances);
    const f = forecastSummary(state.forecast);

    const balancesOk = !!state.balances;
    const forecastOk = !!state.forecast;
    const fTone = forecastOk ? forecastTone(f) : "danger";

    const kpis = [
      {
        title: "Liquid",
        kicker: "Balances API",
        valueHtml: balancesOk && b.liquid != null ? money(b.liquid) : "Unavailable",
        subtitle: balancesOk ? "From /api/balances" : "Balances API failed",
        foot: "No frontend rebuild",
        tone: balancesOk ? toneForMoney(b.liquid, false) : "danger"
      },
      {
        title: "Net Worth",
        kicker: "Balances API",
        valueHtml: balancesOk && b.netWorth != null ? money(b.netWorth) : "Unavailable",
        subtitle: "Formula-layer truth",
        foot: "No local fallback",
        tone: balancesOk ? toneForMoney(b.netWorth, false) : "danger"
      },
      {
        title: "True Burden",
        kicker: "Balances API",
        valueHtml: balancesOk && b.trueBurden != null ? money(b.trueBurden) : "Unavailable",
        subtitle: "Debt + receivable pressure",
        foot: "Canonical top metric",
        tone: balancesOk ? toneForMoney(b.trueBurden, false) : "danger"
      },
      {
        title: "Forecast",
        kicker: "Forecast API",
        valueHtml: forecastOk ? esc(f.status || (f.firstUnsafeDate ? "Watch" : "Loaded")) : "Unavailable",
        subtitle: forecastOk && f.firstUnsafeDate ? "Unsafe: " + f.firstUnsafeDate : "Runway and safety view",
        foot: "From /api/forecast",
        tone: fTone
      }
    ];

    if (window.SFShell && typeof window.SFShell.setKpis === "function") {
      window.SFShell.setKpis(kpis);
    }
  }

  function renderSourceStatus(results) {
    const balancesOk = results.balances.status === "fulfilled";
    const forecastOk = results.forecast.status === "fulfilled";
    const transactionsOk = results.transactions.status === "fulfilled";
    const billsOk = results.bills.status === "fulfilled";
    const debtsOk = results.debts.status === "fulfilled";

    const allOk = balancesOk && forecastOk && transactionsOk && billsOk && debtsOk;

    setPill("hub-source-status", allOk ? "Sources OK" : "Source issue", allOk ? "positive" : "warning");

    setStatus("hub-balances-status", balancesOk ? `OK · ${sourceVersion(state.balances)}` : `Failed · ${state.errors.balances}`, balancesOk);
    setStatus("hub-forecast-status", forecastOk ? `OK · ${sourceVersion(state.forecast)}` : `Failed · ${state.errors.forecast}`, forecastOk);
    setStatus("hub-transactions-status", transactionsOk ? `OK · ${sourceVersion(state.transactions)}` : `Failed · ${state.errors.transactions}`, transactionsOk);
    setStatus("hub-obligations-status", billsOk && debtsOk ? "OK" : "Partial", billsOk && debtsOk);

    setText("hub-last-loaded", new Date().toLocaleString("en-PK", {
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
      endpoints: ENDPOINTS,
      contract: {
        top_metrics_source: "/api/balances",
        forecast_source: "/api/forecast",
        write_enabled: false,
        frontend_net_worth_rebuild: false,
        hub_role: "route and summarize only"
      },
      errors: state.errors,
      balances_payload: state.balances,
      forecast_payload: state.forecast,
      transactions_payload: state.transactions,
      bills_payload: state.bills,
      debts_payload: state.debts
    };

    setText("hub-debug-output", JSON.stringify(debug, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function applyResult(name, result) {
    if (result.status === "fulfilled") {
      state[name] = result.value;
      delete state.errors[name];
      return;
    }

    state[name] = null;
    state.errors[name] = result.reason && result.reason.message
      ? result.reason.message
      : "Unknown error";
  }

  async function loadAll() {
    setPill("hub-source-status", "Loading", "info");

    const rawResults = await Promise.allSettled([
      fetchJSON(ENDPOINTS.balances),
      fetchJSON(ENDPOINTS.forecast),
      fetchJSON(ENDPOINTS.transactions),
      fetchJSON(ENDPOINTS.bills),
      fetchJSON(ENDPOINTS.debts)
    ]);

    const results = {
      balances: rawResults[0],
      forecast: rawResults[1],
      transactions: rawResults[2],
      bills: rawResults[3],
      debts: rawResults[4]
    };

    applyResult("balances", results.balances);
    applyResult("forecast", results.forecast);
    applyResult("transactions", results.transactions);
    applyResult("bills", results.bills);
    applyResult("debts", results.debts);

    renderBalances();
    renderForecast();
    renderTransactions();
    renderBills();
    renderDebts();
    renderObligationFallbacks();
    renderSourceStatus(results);
    updateShellKpis();
    renderDebug();
  }

  function init() {
    window.SovereignHub = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      state: () => JSON.parse(JSON.stringify(state))
    };

    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
