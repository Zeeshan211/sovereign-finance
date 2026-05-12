(function () {
  "use strict";

  if (window.SovereignHub && window.SovereignHub.initialized) return;

  const VERSION = "v1.1.0-finance-hub-normalized";
  const DEBUG = new URLSearchParams(window.location.search).get("debug") === "1";

  const ENDPOINTS = {
    balances: "/api/balances",
    forecast: "/api/forecast",
    bills: "/api/bills",
    debts: "/api/debts",
    cc: "/api/cc",
    salary: "/api/salary",
    transactions: "/api/transactions",
    reconciliation: "/api/reconciliation",
    monthlyClose: "/api/monthly-close",
    accounts: "/api/accounts"
  };

  const state = {
    payloads: {},
    errors: {},
    normalized: {}
  };

  const $ = (id) => document.getElementById(id);

  function c() {
    return window.SFComponents || {};
  }

  function esc(value) {
    if (typeof c().escapeHtml === "function") return c().escapeHtml(value);
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[^\d.-]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function firstNumber() {
    for (const value of arguments) {
      const n = asNumber(value);
      if (n !== null) return n;
    }
    return null;
  }

  function firstText() {
    for (const value of arguments) {
      if (value !== null && value !== undefined && value !== "") return String(value);
    }
    return "";
  }

  function money(value) {
    const n = asNumber(value);
    if (n === null) return "Unavailable";
    if (typeof c().money === "function") return c().money(n, { maximumFractionDigits: 2 });

    return "Rs " + n.toLocaleString("en-PK", {
      maximumFractionDigits: 2,
      minimumFractionDigits: n % 1 === 0 ? 0 : 2
    });
  }

  function percent(value) {
    const n = asNumber(value);
    if (n === null) return "—";
    if (typeof c().percent === "function") return c().percent(n);
    return `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? "" : String(value);
  }

  function setPill(id, label, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = label == null ? "" : String(label);
    el.className = "sf-pill" + (tone ? " sf-pill--" + tone : "");
  }

  function sourceVersion(payload) {
    return firstText(
      payload && payload.version,
      payload && payload.api_version,
      payload && payload.contract_version,
      "unknown"
    );
  }

  async function fetchJSON(url) {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-sovereign-hub-page": VERSION
      }
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `HTTP ${res.status}`);
    }

    return payload;
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

  function unwrapObject(payload, keys) {
    if (!payload) return {};
    for (const key of keys) {
      const value = payload[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    }

    if (payload.data) {
      for (const key of keys) {
        const value = payload.data[key];
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      }
    }

    return {};
  }

  function normalizeBalances(payload) {
    const p = payload || {};
    const s = p.summary || {};

    return {
      liquid: firstNumber(p.total_liquid, p.totalLiquid, p.liquid_now, p.liquidNow, s.total_liquid, s.totalLiquid),
      netWorth: firstNumber(p.net_worth, p.netWorth, s.net_worth, s.netWorth),
      trueBurden: firstNumber(p.true_burden, p.trueBurden, s.true_burden, s.trueBurden),
      ccOutstanding: firstNumber(p.cc_outstanding, p.ccOutstanding, p.credit_card_outstanding, s.cc_outstanding, s.ccOutstanding),
      debtPayable: firstNumber(p.debt_payable, p.debtPayable, p.payable_debt, p.payableDebt, s.debt_payable, s.debtPayable),
      receivables: firstNumber(p.receivables, p.receivable_total, p.receivableTotal, s.receivables, s.receivable_total),
      accounts: unwrapObject(p, ["accounts", "by_account", "account_balances"])
    };
  }

  function normalizeForecast(payload) {
    const p = payload || {};
    const current = p.current_position || {};
    const obligations = p.obligations_this_month || {};
    const forecast = p.forecast || {};
    const insights = p.insights || {};
    const salary = p.salary || {};
    const summary = p.summary || {};

    return {
      status: firstText(p.status, p.runway_status, p.safety_status, insights.status, summary.status),
      liquidNow: firstNumber(p.liquidNow, p.liquid_now, current.liquid_now),
      salaryForecast: firstNumber(p.salaryForecast, p.salary_forecast, salary.forecast_eligible_monthly, salary.guaranteed_monthly),
      billsRemaining: firstNumber(p.billsRemaining, p.bills_remaining, obligations.bills_remaining, forecast.bills_remaining),
      debtPayable: firstNumber(p.debtPayable, p.debt_payable, obligations.debt_payable_remaining, current.payable_debt_remaining),
      receivables: firstNumber(p.receivables, obligations.debt_receivable_remaining, current.total_receivables),
      ccOutstanding: firstNumber(p.ccOutstanding, p.cc_outstanding, obligations.cc_outstanding),
      afterRequired: firstNumber(forecast.projected_cash_after_required_obligations, forecast.after_required, p.afterRequired),
      afterDebtPressure: firstNumber(forecast.projected_cash_after_debt_pressure, forecast.ending_liquid, forecast.projected_ending_liquid),
      ifReceivables: firstNumber(forecast.projected_cash_if_receivables_collected, forecast.if_receivables_collected),
      lowestLiquid: firstNumber(p.lowestProjectedBalance, p.lowest_projected_balance, insights.lowest_liquid_amount),
      lowestLiquidDate: firstText(p.lowestProjectedDate, p.lowest_projected_date, insights.lowest_liquid_date),
      firstUnsafeDate: firstText(p.firstUnsafeDate, p.first_unsafe_date, insights.first_crisis_breach_date, insights.first_unsafe_date),
      requiredCash: firstNumber(insights.required_cash_to_avoid_crisis),
      projectionDays: firstNumber(p.projectionDays, p.projection_days, forecast.projection_days)
    };
  }

  function normalizeSalary(payload) {
    const p = payload || {};
    const s = p.summary || {};
    const salary = p.salary || {};

    return {
      guaranteedMonthly: firstNumber(s.guaranteed_monthly, s.guaranteedMonthly, salary.guaranteed_monthly),
      variableMonthly: firstNumber(s.variable_monthly, s.variableMonthly, salary.variable_monthly),
      forecastEligible: firstNumber(s.forecast_eligible_monthly, s.forecastEligibleMonthly, salary.forecast_eligible_monthly),
      variableConfirmed: Boolean(s.variable_confirmed || salary.variable_confirmed)
    };
  }

  function normalizeMonthlyClose(payload) {
    const p = payload || {};
    const readiness = p.audit_readiness || p.readiness || {};
    const summary = p.summary || {};

    const blockers = unwrapArray(readiness, ["blockers", "blocking", "errors"]);
    const warnings = unwrapArray(readiness, ["warnings", "warn"]);

    return {
      status: firstText(p.status, readiness.status, summary.status),
      blockers,
      warnings,
      blockersCount: firstNumber(readiness.blockers_count, readiness.blocker_count, blockers.length) || 0,
      warningsCount: firstNumber(readiness.warnings_count, readiness.warning_count, warnings.length) || 0
    };
  }

  function normalizeReconciliation(payload) {
    const p = payload || {};
    const summary = p.summary || p.reconciliation || {};

    return {
      status: firstText(p.status, summary.status),
      matched: firstNumber(summary.matched, summary.matched_count),
      drifted: firstNumber(summary.drifted, summary.drifted_count),
      stale: firstNumber(summary.stale, summary.stale_count),
      undeclared: firstNumber(summary.undeclared, summary.undeclared_count)
    };
  }

  function normalizeCC(payload) {
    const p = payload || {};
    const cards = unwrapArray(p, ["accounts", "cards", "credit_cards", "data"]);
    const totalOutstanding = firstNumber(
      p.total_outstanding,
      p.cc_outstanding,
      p.outstanding,
      cards.reduce((sum, card) => {
        const outstanding = firstNumber(card.outstanding, card.cc_outstanding);
        if (outstanding !== null) return sum + outstanding;
        const balance = firstNumber(card.balance);
        return sum + Math.max(0, -(balance || 0));
      }, 0)
    );

    const minimumDue = firstNumber(
      p.minimum_due,
      p.total_minimum_due,
      cards.reduce((sum, card) => sum + (firstNumber(card.minimum_payment_amount, card.minimum_due) || 0), 0)
    );

    return { cards, totalOutstanding, minimumDue };
  }

  function normalizeBills(payload) {
    return unwrapArray(payload, ["bills", "items", "rows", "data"])
      .filter((bill) => String(bill.status || "active").toLowerCase() !== "inactive")
      .map((bill) => ({
        name: firstText(bill.name, bill.title, bill.bill_name, "Bill"),
        remaining: firstNumber(bill.remaining, bill.remaining_amount, bill.amount_remaining, bill.balance_due, bill.amount, bill.default_amount),
        paid: firstNumber(bill.paid_this_month, bill.paid, bill.amount_paid),
        due: firstText(bill.due_date, bill.next_due_date, bill.due_day, bill.dueDay, "No due date"),
        status: firstText(bill.status, bill.state, "active")
      }));
  }

  function normalizeDebts(payload) {
    return unwrapArray(payload, ["debts", "items", "rows", "data"])
      .filter((debt) => String(debt.status || "active").toLowerCase() !== "closed")
      .map((debt) => {
        const original = firstNumber(debt.original_amount, debt.amount);
        const paid = firstNumber(debt.paid_amount, debt.paid);
        const remaining = firstNumber(
          debt.remaining,
          debt.remaining_amount,
          debt.outstanding,
          debt.amount_remaining,
          original !== null ? Math.max(0, original - (paid || 0)) : null
        );

        return {
          name: firstText(debt.name, debt.person, debt.counterparty, debt.title, "Debt"),
          kind: firstText(debt.kind, debt.type, debt.direction, "debt"),
          remaining,
          due: firstText(debt.due_date, debt.next_due_date, debt.follow_up_date, debt.due_day, "No due date"),
          status: firstText(debt.status, debt.state, "active")
        };
      });
  }

  function normalizeTransactions(payload) {
    return unwrapArray(payload, ["transactions", "items", "rows", "data"])
      .filter((tx) => {
        const status = String(tx.status || "").toLowerCase();
        const type = String(tx.type || "").toLowerCase();
        return status !== "reversed" && type !== "reversal" && !tx.reversed_at && !tx.reversed_by;
      })
      .map((tx) => ({
        title: cleanTxnTitle(tx),
        type: firstText(tx.type, "transaction"),
        amount: firstNumber(tx.amount),
        date: firstText(tx.date, tx.created_at, tx.timestamp),
        account: firstText(tx.account_name, tx.account, tx.account_id, tx.source_account_id),
        category: firstText(tx.category_name, tx.category, tx.category_id),
        raw: tx
      }))
      .filter((tx) => tx.title)
      .slice(0, 8);
  }

  function cleanTxnTitle(tx) {
    const raw = firstText(tx.merchant, tx.payee, tx.person, tx.title, tx.notes, tx.category, tx.type, "Transaction").trim();

    if (/SF_SHIPMENT|DIRECT_WRITE_TEST|RS1_TEST|CREATE_RECEIVABLE|RECEIVE_RS1/i.test(raw)) return "";

    const cleaned = raw
      .replace(/\s*\|\s*bill_id=.*$/i, "")
      .replace(/\s*\|\s*debt_id=.*$/i, "")
      .replace(/\s*\|\s*notes=.*$/i, "")
      .replace(/\[ATM_FEE_REVERSAL\]\s*/gi, "ATM fee reversal — ")
      .replace(/\[ATM_FEE_PENDING\]\s*/gi, "")
      .replace(/\[linked:[^\]]+\]/gi, "")
      .replace(/merchant=/gi, "")
      .replace(/category=/gi, "")
      .replace(/account=/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    return cleaned || "Transaction";
  }

  function normalizeAccounts(payload, balancesAccounts) {
    const accountRows = unwrapArray(payload, ["accounts", "items", "rows", "data"]);

    if (accountRows.length) {
      return accountRows
        .filter((account) => String(account.status || "active").toLowerCase() !== "archived")
        .map((account) => ({
          id: firstText(account.id, account.account_id),
          name: firstText(account.name, account.label, account.account_name, "Account"),
          type: firstText(account.kind, account.type, "account"),
          balance: firstNumber(account.balance, account.current_balance, account.amount)
        }))
        .filter((account) => account.balance !== null)
        .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    }

    return Object.entries(balancesAccounts || {})
      .map(([id, account]) => ({
        id,
        name: firstText(account && account.name, account && account.label, id),
        type: firstText(account && account.kind, account && account.type, "account"),
        balance: firstNumber(account && account.balance, account && account.current_balance, account && account.amount)
      }))
      .filter((account) => account.balance !== null)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }

  function toneMoney(value, inverse) {
    const n = asNumber(value);
    if (n === null) return "info";
    if (inverse) return n > 0 ? "warning" : "positive";
    if (n < 0) return "danger";
    if (n === 0) return "info";
    return "positive";
  }

  function forecastTone(forecast) {
    const status = String(forecast.status || "").toLowerCase();
    if (status.includes("crisis") || status.includes("danger") || status.includes("unsafe")) return "danger";
    if (status.includes("watch") || status.includes("warning")) return "warning";
    if (status.includes("safe") || status.includes("clear") || status.includes("ok")) return "positive";

    const lowest = asNumber(forecast.lowestLiquid);
    if (lowest !== null && lowest < 0) return "danger";
    if (lowest !== null && lowest < 5000) return "warning";
    return "info";
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
        <div class="sf-row-right ${tone ? `sf-tone-${esc(tone)}` : ""}">${value == null ? "—" : value}</div>
      </${tag}>
    `;
  }

  function emptyState(title, subtitle) {
    if (typeof c().emptyState === "function") return c().emptyState({ title, subtitle });
    return `<div class="sf-empty-state"><div><h3 class="sf-card-title">${esc(title)}</h3><p class="sf-card-subtitle">${esc(subtitle || "")}</p></div></div>`;
  }

  function errorState(title, message) {
    if (typeof c().errorState === "function") return c().errorState({ title, message });
    return `<div class="sf-empty-state sf-tone-danger"><div><h3 class="sf-card-title">${esc(title)}</h3><p class="sf-card-subtitle">${esc(message || "")}</p></div></div>`;
  }

  function renderGlance() {
    const n = state.normalized;

    setText("hub-liquid-now", money(n.liquid));
    setText("hub-net-worth", money(n.netWorth));
    setText("hub-bills-remaining", money(n.billsRemaining));
    setText("hub-debt-payable", money(n.debtPayable));
    setText("hub-receivables", money(n.receivables));
    setText("hub-cc-outstanding", money(n.ccOutstanding));
    setText("hub-next-salary", money(n.salaryForecast));
    setText("hub-lowest-liquid", money(n.lowestLiquid));
    setText("hub-lowest-liquid-sub", n.lowestLiquidDate ? `Forecast low point · ${n.lowestLiquidDate}` : "Forecast low point");

    const tone = forecastTone(n.forecast);
    const label = n.forecast.status || (n.forecast.firstUnsafeDate ? "Watch" : "Loaded");
    setPill("hub-state-pill", label, tone);

    setText("hub-last-loaded", "Last loaded: " + new Date().toLocaleString("en-PK", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }));
  }

  function renderKpis() {
    const n = state.normalized;
    const tone = forecastTone(n.forecast);

    if (!window.SFShell || typeof window.SFShell.setKpis !== "function") return;

    window.SFShell.setKpis([
      {
        title: "Liquid Now",
        kicker: "At a glance",
        valueHtml: money(n.liquid),
        subtitle: "Spendable current position",
        foot: "From /api/balances",
        tone: toneMoney(n.liquid, false)
      },
      {
        title: "Bills Remaining",
        kicker: "Pressure",
        valueHtml: money(n.billsRemaining),
        subtitle: "Current-month bill pressure",
        foot: "From /api/forecast",
        tone: toneMoney(n.billsRemaining, true)
      },
      {
        title: "Debt Payable",
        kicker: "Pressure",
        valueHtml: money(n.debtPayable),
        subtitle: "Outstanding payable side",
        foot: "Forecast / balances",
        tone: toneMoney(n.debtPayable, true)
      },
      {
        title: "Forecast Risk",
        kicker: "Runway",
        valueHtml: n.forecast.firstUnsafeDate ? "Watch" : (n.forecast.status || "Loaded"),
        subtitle: n.forecast.firstUnsafeDate ? `Unsafe: ${n.forecast.firstUnsafeDate}` : `Lowest: ${money(n.lowestLiquid)}`,
        foot: "From /api/forecast",
        tone
      }
    ]);
  }

  function renderAttention() {
    const n = state.normalized;
    const items = [];

    if (n.forecast.firstUnsafeDate) {
      items.push({
        tone: "danger",
        title: "Forecast unsafe date",
        subtitle: `First unsafe date ${n.forecast.firstUnsafeDate}${n.forecast.requiredCash !== null ? " · required cash " + money(n.forecast.requiredCash) : ""}`,
        href: "/forecast.html"
      });
    }

    if (n.monthlyClose.blockersCount > 0) {
      items.push({
        tone: "danger",
        title: "Monthly Close not ready",
        subtitle: `${n.monthlyClose.blockersCount} blocker${n.monthlyClose.blockersCount === 1 ? "" : "s"} found`,
        href: "/monthly-close.html"
      });
    } else if (n.monthlyClose.warningsCount > 0) {
      items.push({
        tone: "warning",
        title: "Monthly Close has warnings",
        subtitle: `${n.monthlyClose.warningsCount} warning${n.monthlyClose.warningsCount === 1 ? "" : "s"} need review`,
        href: "/monthly-close.html"
      });
    }

    const drift = (n.reconciliation.drifted || 0) + (n.reconciliation.stale || 0);
    if (drift > 0) {
      items.push({
        tone: "warning",
        title: "Reconciliation needs review",
        subtitle: `${drift} account${drift === 1 ? "" : "s"} drifted or stale`,
        href: "/reconciliation.html"
      });
    }

    if (n.salary.variableMonthly > 0 && !n.salary.variableConfirmed) {
      items.push({
        tone: "warning",
        title: "Variable salary excluded",
        subtitle: `Variable amount ${money(n.salary.variableMonthly)} is not confirmed for forecast`,
        href: "/salary.html"
      });
    }

    if (n.ccMinimumDue > 0) {
      items.push({
        tone: "warning",
        title: "Credit card minimum due",
        subtitle: `Minimum due ${money(n.ccMinimumDue)}`,
        href: "/cc.html"
      });
    }

    const dueBills = n.bills.filter((bill) => (bill.remaining === null || bill.remaining > 0)).slice(0, 2);
    dueBills.forEach((bill) => {
      items.push({
        tone: "info",
        title: `${bill.name} bill pending`,
        subtitle: `${money(bill.remaining)} · due ${bill.due}`,
        href: "/bills.html"
      });
    });

    if (!items.length) {
      setPill("hub-attention-count", "Clear", "positive");
      setHTML("hub-attention-list", emptyState("No urgent attention item", "No forecast, reconciliation, monthly close, salary, bill, or card item is currently urgent."));
      return;
    }

    setPill("hub-attention-count", `${items.length} item${items.length === 1 ? "" : "s"}`, items.some((i) => i.tone === "danger") ? "danger" : "warning");

    setHTML("hub-attention-list", items.map((item) =>
      rowHtml(item.title, item.subtitle, "Open", item.tone, item.href)
    ).join(""));
  }

  function renderCashPath() {
    const f = state.normalized.forecast;
    const tone = forecastTone(f);

    setPill("hub-forecast-status", f.status || (f.firstUnsafeDate ? "Watch" : "Loaded"), tone);

    setHTML("hub-cash-path", [
      rowHtml("Liquid now", "Current forecast starting point", money(f.liquidNow), toneMoney(f.liquidNow, false)),
      rowHtml("Next salary", "Forecast-eligible salary", money(f.salaryForecast), "positive"),
      rowHtml("Bills remaining", "Forecast bill pressure", money(f.billsRemaining), toneMoney(f.billsRemaining, true)),
      rowHtml("Debt payable", "Forecast payable debt pressure", money(f.debtPayable), toneMoney(f.debtPayable, true)),
      rowHtml("Receivables", "Receivable side", money(f.receivables), "positive"),
      rowHtml("After required obligations", "Projected cash after required obligations", money(f.afterRequired), toneMoney(f.afterRequired, false)),
      rowHtml("After debt pressure", "Projected cash after debt pressure", money(f.afterDebtPressure), toneMoney(f.afterDebtPressure, false)),
      rowHtml("Lowest liquid", f.lowestLiquidDate || "No low date returned", money(f.lowestLiquid), toneMoney(f.lowestLiquid, false)),
      rowHtml("First unsafe date", "Only shown when forecast exposes it", f.firstUnsafeDate || "—", f.firstUnsafeDate ? "danger" : "positive")
    ].join(""));
  }

  function renderReadiness() {
    const m = state.normalized.monthlyClose;
    const r = state.normalized.reconciliation;

    const monthlyTone = m.blockersCount > 0 ? "danger" : m.warningsCount > 0 ? "warning" : "positive";
    const reconIssues = (r.drifted || 0) + (r.stale || 0) + (r.undeclared || 0);
    const reconTone = reconIssues > 0 ? "warning" : "positive";

    setHTML("hub-readiness-panel", [
      rowHtml("Monthly Close", `${m.blockersCount} blockers · ${m.warningsCount} warnings`, m.status || (m.blockersCount ? "Not ready" : "Ready"), monthlyTone, "/monthly-close.html"),
      rowHtml("Reconciliation", `${r.drifted || 0} drifted · ${r.stale || 0} stale · ${r.undeclared || 0} undeclared`, r.status || (reconIssues ? "Review" : "Clear"), reconTone, "/reconciliation.html")
    ].join(""));
  }

  function renderObligations() {
    const bills = state.normalized.bills.slice(0, 6);
    const debts = state.normalized.debts.slice(0, 6);

    setHTML("hub-bills-list", bills.length
      ? bills.map((bill) => rowHtml(bill.name, `Due ${bill.due} · ${bill.status}`, money(bill.remaining), toneMoney(bill.remaining, true), "/bills.html")).join("")
      : emptyState("No bill rows", "No bill rows returned. Top pressure is still shown from forecast when available.")
    );

    setHTML("hub-debts-list", debts.length
      ? debts.map((debt) => rowHtml(debt.name, `${debt.kind} · ${debt.status} · ${debt.due}`, money(debt.remaining), toneMoney(debt.remaining, true), "/debts.html")).join("")
      : emptyState("No active debt rows", "No active debt rows returned. Payable/receivable pressure still comes from forecast or balances.")
    );
  }

  function renderAccountsPreview() {
    const accounts = state.normalized.accounts.slice(0, 6);

    setHTML("hub-accounts-preview", accounts.length
      ? accounts.map((account) => rowHtml(account.name, account.type, money(account.balance), toneMoney(account.balance, false), "/accounts.html")).join("")
      : emptyState("No account preview", "No account rows returned for preview. Open Accounts for source truth.")
    );
  }

  function renderCardPressure() {
    const n = state.normalized;
    const cc = n.cc;

    setHTML("hub-card-pressure", [
      rowHtml("Outstanding", "Card liability pressure", money(n.ccOutstanding), toneMoney(n.ccOutstanding, true), "/cc.html"),
      rowHtml("Minimum due", "From /api/cc when available", money(cc.minimumDue), toneMoney(cc.minimumDue, true), "/cc.html"),
      rowHtml("Cards", "Active card rows returned", String(cc.cards.length), "info", "/cc.html")
    ].join(""));
  }

  function renderActivity() {
    const txns = state.normalized.transactions;

    setHTML("hub-recent-activity", txns.length
      ? txns.map((tx) => {
        const positive = String(tx.type).toLowerCase() === "income";
        const transfer = String(tx.type).toLowerCase() === "transfer";
        const tone = positive ? "positive" : transfer ? "info" : "warning";
        const subtitle = [tx.date, tx.account, tx.category, tx.type].filter(Boolean).join(" · ");
        const value = tx.amount === null ? "—" : money(Math.abs(tx.amount));
        return rowHtml(tx.title, subtitle, value, tone, "/transactions.html");
      }).join("")
      : emptyState("No recent activity", "No clean non-reversed transaction rows returned.")
    );
  }

  function renderSources() {
    const keys = [
      ["balances", "/api/balances"],
      ["forecast", "/api/forecast"],
      ["bills", "/api/bills"],
      ["debts", "/api/debts"],
      ["cc", "/api/cc"],
      ["salary", "/api/salary"],
      ["transactions", "/api/transactions"],
      ["reconciliation", "/api/reconciliation"],
      ["monthlyClose", "/api/monthly-close"],
      ["accounts", "/api/accounts"]
    ];

    const failed = keys.filter(([key]) => state.errors[key]);
    setPill("hub-source-overall", failed.length ? `${failed.length} source issue${failed.length === 1 ? "" : "s"}` : "Sources OK", failed.length ? "warning" : "positive");

    setHTML("hub-source-list", keys.map(([key, label]) => {
      const ok = !state.errors[key];
      const payload = state.payloads[key];
      return rowHtml(
        label,
        ok ? `OK · ${sourceVersion(payload)}` : state.errors[key],
        ok ? "OK" : "FAIL",
        ok ? "positive" : "danger"
      );
    }).join(""));
  }

  function renderDebug() {
    setText("hub-debug-output", JSON.stringify({
      version: VERSION,
      endpoints: ENDPOINTS,
      errors: state.errors,
      normalized: state.normalized,
      payloads: state.payloads
    }, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  function buildNormalized() {
    const balances = normalizeBalances(state.payloads.balances);
    const forecast = normalizeForecast(state.payloads.forecast);
    const salary = normalizeSalary(state.payloads.salary);
    const monthlyClose = normalizeMonthlyClose(state.payloads.monthlyClose);
    const reconciliation = normalizeReconciliation(state.payloads.reconciliation);
    const cc = normalizeCC(state.payloads.cc);
    const bills = normalizeBills(state.payloads.bills);
    const debts = normalizeDebts(state.payloads.debts);
    const transactions = normalizeTransactions(state.payloads.transactions);
    const accounts = normalizeAccounts(state.payloads.accounts, balances.accounts);

    state.normalized = {
      balances,
      forecast,
      salary,
      monthlyClose,
      reconciliation,
      cc,
      bills,
      debts,
      transactions,
      accounts,

      liquid: firstNumber(balances.liquid, forecast.liquidNow),
      netWorth: balances.netWorth,
      trueBurden: balances.trueBurden,
      billsRemaining: firstNumber(forecast.billsRemaining),
      debtPayable: firstNumber(forecast.debtPayable, balances.debtPayable),
      receivables: firstNumber(forecast.receivables, balances.receivables),
      ccOutstanding: firstNumber(balances.ccOutstanding, forecast.ccOutstanding, cc.totalOutstanding),
      salaryForecast: firstNumber(forecast.salaryForecast, salary.forecastEligible),
      lowestLiquid: forecast.lowestLiquid,
      lowestLiquidDate: forecast.lowestLiquidDate,
      ccMinimumDue: cc.minimumDue
    };
  }

  async function loadAll() {
    state.errors = {};
    state.payloads = {};

    const entries = Object.entries(ENDPOINTS);
    const results = await Promise.allSettled(entries.map(([, url]) => fetchJSON(url)));

    results.forEach((result, index) => {
      const key = entries[index][0];
      if (result.status === "fulfilled") {
        state.payloads[key] = result.value;
      } else {
        state.errors[key] = result.reason && result.reason.message ? result.reason.message : "Unknown error";
        state.payloads[key] = null;
      }
    });

    buildNormalized();

    renderGlance();
    renderKpis();
    renderAttention();
    renderCashPath();
    renderReadiness();
    renderObligations();
    renderAccountsPreview();
    renderCardPressure();
    renderActivity();
    renderSources();
    renderDebug();
  }

  function init() {
    window.SovereignHub = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      state: () => JSON.parse(JSON.stringify(state))
    };

    loadAll().catch((error) => {
      state.errors.boot = error.message || String(error);
      setPill("hub-state-pill", "Hub failed", "danger");
      setHTML("hub-attention-list", errorState("Hub load failed", error.message || String(error)));
      renderDebug();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
