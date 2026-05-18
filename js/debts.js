/* js/debts.js
 * Sovereign Finance · Debts UI
 * v0.8.0-shared-shell-rows
 *
 * Contract:
 * - Uses shared shell/components only.
 * - No injected page-owned CSS.
 * - No custom clipped debt-row grid.
 * - Canonical debt writes only:
 *     POST /api/debts
 * - Reversal remains owned by Ledger:
 *     POST /api/transactions/reverse
 */

(function () {
  "use strict";

  const VERSION = "v0.8.0-shared-shell-rows";

  const API_DEBTS = "/api/debts";
  const API_DEBTS_LIST = "/api/debts?include_inactive=1";
  const API_DEBTS_HEALTH = "/api/debts?action=health";
  const API_ADD_CONTEXT = "/api/add/context";
  const API_ACCOUNTS_FALLBACK = "/api/accounts";

  const TERMINAL_STATUSES = new Set([
    "settled",
    "archived",
    "closed",
    "deleted",
    "paid",
    "finished",
    "completed",
    "done"
  ]);

  const state = {
    debts: [],
    accounts: [],
    health: null,
    lastPayload: null,
    selectedDebtId: null,
    filter: "active",
    search: "",
    sort: "due",
    loading: false
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? "" : String(value);
  }

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function isTerminal(status) {
    return TERMINAL_STATUSES.has(String(status || "").trim().toLowerCase());
  }

  function money(value) {
    const n = Number(value || 0);
    const sign = n < 0 ? "-" : "";

    return sign + "Rs " + Math.abs(n).toLocaleString("en-PK", {
      minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function compactDate(value) {
    const raw = String(value || "").slice(0, 10);
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "—";

    const [, month, day] = raw.split("-");
    const months = {
      "01": "Jan",
      "02": "Feb",
      "03": "Mar",
      "04": "Apr",
      "05": "May",
      "06": "Jun",
      "07": "Jul",
      "08": "Aug",
      "09": "Sep",
      "10": "Oct",
      "11": "Nov",
      "12": "Dec"
    };

    return `${Number(day)} ${months[month] || month}`;
  }

  function formatDateTime(value) {
    const raw = String(value || "").trim();
    if (!raw) return "—";

    return raw.replace("T", " ").replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
  }

  function kindLabel(kind) {
    return kind === "owed" ? "Owed to me" : "I owe";
  }

  function kindShort(kind) {
    return kind === "owed" ? "Receivable" : "Payable";
  }

  function toneClass(value) {
    const s = String(value || "").toLowerCase();

    if (["ok", "active", "linked", "scheduled", "paid_off", "settled", "pass"].includes(s)) return "positive";
    if (["warn", "due_soon", "due_today", "no_schedule", "missing_ledger", "paused"].includes(s)) return "warning";
    if (["overdue", "missing", "danger", "blocked", "failed", "closed"].includes(s)) return "danger";

    return "";
  }

  function pill(label, tone) {
    const cls = tone ? ` sf-pill--${esc(tone)}` : "";
    return `<span class="sf-pill${cls}">${esc(label)}</span>`;
  }

  function row(title, sub, value, tone) {
    const cls = tone ? ` sf-tone-${esc(tone)}` : "";

    return `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(title)}</div>
          ${sub ? `<div class="sf-row-subtitle">${esc(sub)}</div>` : ""}
        </div>
        <div class="sf-row-right${cls}">
          ${value == null ? "—" : value}
        </div>
      </div>
    `;
  }

  function empty(message) {
    return `<div class="sf-empty-state">${esc(message)}</div>`;
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

    const text = await response.text();
    let payload = null;

    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
    }

    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && (payload.error || payload.message)) || `HTTP ${response.status}`);
    }

    return payload;
  }

  async function postJSON(url, body) {
    return fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  async function putJSON(url, body) {
    return fetchJSON(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  function normalizeDebt(rowData) {
    const original = num(rowData.original_amount ?? rowData.amount);
    const paid = num(rowData.paid_amount);
    const remaining = num(rowData.remaining_amount, Math.max(0, original - paid));

    return {
      ...rowData,
      id: rowData.id || "",
      name: rowData.name || rowData.title || rowData.label || rowData.id || "Debt",
      kind: rowData.kind === "owed" ? "owed" : "owe",
      original_amount: original,
      paid_amount: paid,
      remaining_amount: remaining,
      status: rowData.status || "active",
      due_status: rowData.due_status || "no_schedule",
      due_date: rowData.due_date || null,
      due_day: rowData.due_day == null ? null : rowData.due_day,
      installment_amount: rowData.installment_amount == null ? null : num(rowData.installment_amount),
      frequency: rowData.frequency || "monthly",
      last_paid_date: rowData.last_paid_date || null,
      next_due_date: rowData.next_due_date || null,
      days_until_due: rowData.days_until_due == null ? null : rowData.days_until_due,
      days_overdue: rowData.days_overdue == null ? null : rowData.days_overdue,
      schedule_missing: Boolean(rowData.schedule_missing),
      ledger_linked: Boolean(rowData.ledger_linked),
      ledger_required: Boolean(rowData.ledger_required),
      ledger_transaction_ids: Array.isArray(rowData.ledger_transaction_ids) ? rowData.ledger_transaction_ids : [],
      ledger_transactions: Array.isArray(rowData.ledger_transactions) ? rowData.ledger_transactions : [],
      origin_state: rowData.origin_state || rowData.ledger_state || "",
      origin_required: Boolean(rowData.origin_required ?? rowData.ledger_required),
      origin_linked: Boolean(rowData.origin_linked ?? rowData.ledger_linked),
      origin_transaction_ids: Array.isArray(rowData.origin_transaction_ids) ? rowData.origin_transaction_ids : [],
      origin_transactions: Array.isArray(rowData.origin_transactions) ? rowData.origin_transactions : [],
      payment_transaction_ids: Array.isArray(rowData.payment_transaction_ids) ? rowData.payment_transaction_ids : [],
      payment_transactions: Array.isArray(rowData.payment_transactions) ? rowData.payment_transactions : [],
      repair_required: Boolean(rowData.repair_required),
      notes: rowData.notes || "",
      created_at: rowData.created_at || null,
      updated_at: rowData.updated_at || null,
      settled_at: rowData.settled_at || null,
      raw: rowData
    };
  }

  function accountRowsFromPayload(payload) {
    if (!payload) return [];
    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (payload.accounts && typeof payload.accounts === "object") return Object.values(payload.accounts);
    if (payload.accounts_by_id && typeof payload.accounts_by_id === "object") return Object.values(payload.accounts_by_id);
    if (Array.isArray(payload.account_list)) return payload.account_list;
    return [];
  }

  async function loadAccounts() {
    try {
      const payload = await fetchJSON(API_ADD_CONTEXT);
      state.accounts = accountRowsFromPayload(payload).filter(Boolean);
    } catch {
      try {
        const fallback = await fetchJSON(API_ACCOUNTS_FALLBACK);
        state.accounts = accountRowsFromPayload(fallback).filter(Boolean);
      } catch {
        state.accounts = [];
      }
    }

    renderAccountOptions();
  }

  async function loadDebts() {
    if (state.loading) return;

    state.loading = true;
    setHTML("debtList", empty("Loading debts…"));

    try {
      await loadAccounts();

      const payload = await fetchJSON(API_DEBTS_LIST);
      state.lastPayload = payload;
      state.debts = (Array.isArray(payload.debts) ? payload.debts : []).map(normalizeDebt);

      try {
        state.health = await fetchJSON(API_DEBTS_HEALTH);
      } catch {
        state.health = null;
      }

      renderAll(payload);
    } catch (err) {
      setHTML("debtList", empty(`Failed to load debts: ${err.message}`));
      setText("metricHealth", "failed");
      renderDebug({ error: err.message });
    } finally {
      state.loading = false;
    }
  }

  function renderAccountOptions() {
    const ids = ["debtAccountInput", "paymentAccountInput", "repairAccountInput"];

    const options = ['<option value="">Select account…</option>'].concat(
      state.accounts.map(account => {
        const id = account.id || account.account_id;
        const name = account.name || account.label || id;
        const balance = account.balance ?? account.current_balance ?? account.amount ?? 0;
        const kind = account.type || account.kind || "account";

        return `<option value="${esc(id)}">${esc(name)} · ${esc(kind)} · ${money(balance)}</option>`;
      })
    ).join("");

    ids.forEach(id => {
      const select = $(id);
      if (!select) return;

      const current = select.value;
      select.innerHTML = options;
      if (current) select.value = current;
    });
  }

  function selectedDebt() {
    return state.debts.find(debt => String(debt.id) === String(state.selectedDebtId)) || null;
  }

  function findDebtById(id) {
    return state.debts.find(debt => String(debt.id) === String(id)) || null;
  }

  function debtRemaining(debt) {
    return num(debt.remaining_amount, Math.max(0, num(debt.original_amount) - num(debt.paid_amount)));
  }

  function debtPaidPct(debt) {
    const original = num(debt.original_amount);
    const paid = num(debt.paid_amount);

    if (!original || original <= 0) return 0;

    return Math.max(0, Math.min(100, (paid / original) * 100));
  }

  function debtOriginLabel(debt) {
    if (debt.ledger_linked) return "Ledger linked";
    if (debt.ledger_required) return "Needs origin repair";

    const notes = String(debt.notes || "").toLowerCase();
    if (notes.includes("movement_now=0")) return "Debt-only";
    if (debt.origin_state === "payment_linked_only") return "Payment-linked only";
    if (debt.origin_state === "legacy_unknown") return "Legacy / no origin";

    return "No origin movement";
  }

  function debtStatusText(debt) {
    if (isTerminal(debt.status)) return debt.status;
    if (debt.due_status === "overdue") return "Overdue";
    if (debt.due_status === "due_today") return "Due today";
    if (debt.due_status === "due_soon") return "Due soon";
    if (debt.ledger_required && !debt.ledger_linked) return "Repair";
    return debt.status || "active";
  }

  function debtSearchHaystack(debt) {
    return [
      debt.id,
      debt.name,
      debt.kind,
      debt.status,
      debt.due_status,
      debt.due_date,
      debt.next_due_date,
      debt.notes,
      debt.origin_state,
      debt.ledger_transaction_ids.join(" "),
      debt.payment_transaction_ids.join(" "),
      debt.ledger_transactions.map(tx => [tx.id, tx.date, tx.type, tx.account_id, tx.notes].join(" ")).join(" "),
      debt.payment_transactions.map(tx => [tx.id, tx.date, tx.type, tx.account_id, tx.notes].join(" ")).join(" ")
    ].join(" ").toLowerCase();
  }

  function compareDebts(a, b) {
    if (state.sort === "created") {
      const ac = String(a.created_at || "");
      const bc = String(b.created_at || "");
      if (ac !== bc) return bc.localeCompare(ac);
      return String(a.id).localeCompare(String(b.id));
    }

    if (state.sort === "amount") return debtRemaining(b) - debtRemaining(a);

    if (state.sort === "name") {
      return String(a.name || "").localeCompare(String(b.name || "")) ||
        String(a.id || "").localeCompare(String(b.id || ""));
    }

    const ad = String(a.next_due_date || a.due_date || "9999-12-31");
    const bd = String(b.next_due_date || b.due_date || "9999-12-31");

    if (ad !== bd) return ad.localeCompare(bd);

    return String(a.name || "").localeCompare(String(b.name || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""));
  }

  function filteredDebts() {
    const query = state.search.toLowerCase();

    return state.debts
      .filter(debt => {
        if (query && !debtSearchHaystack(debt).includes(query)) return false;

        const terminal = isTerminal(debt.status);

        if (state.filter === "all") return true;
        if (state.filter === "active") return !terminal;
        if (state.filter === "owe") return debt.kind === "owe" && !terminal;
        if (state.filter === "owed") return debt.kind === "owed" && !terminal;
        if (state.filter === "due") return !terminal && ["due_today", "due_soon", "overdue"].includes(debt.due_status);
        if (state.filter === "missing_ledger") return !terminal && debt.ledger_required && !debt.ledger_linked;

        return true;
      })
      .sort(compareDebts);
  }

  function renderMetrics(payload) {
    const totals = payload?.totals || {};

    const totalOwe = payload?.total_owe ?? totals.total_owe ??
      state.debts.filter(debt => debt.kind === "owe" && !isTerminal(debt.status))
        .reduce((sum, debt) => sum + debtRemaining(debt), 0);

    const totalOwed = payload?.total_owed ?? totals.total_owed ??
      state.debts.filter(debt => debt.kind === "owed" && !isTerminal(debt.status))
        .reduce((sum, debt) => sum + debtRemaining(debt), 0);

    const dueSoon = payload?.due_soon_count ?? totals.due_soon_count ??
      state.debts.filter(debt => !isTerminal(debt.status) && debt.due_status === "due_soon").length;

    const overdue = payload?.overdue_count ?? totals.overdue_count ??
      state.debts.filter(debt => !isTerminal(debt.status) && debt.due_status === "overdue").length;

    const missingLedger = payload?.repair_required_count ?? totals.repair_required_count ??
      state.debts.filter(debt => !isTerminal(debt.status) && debt.ledger_required && !debt.ledger_linked).length;

    const healthStatus =
      state.health?.status ||
      state.health?.health?.status ||
      payload?.health?.status ||
      payload?.status ||
      "unknown";

    setText("metricOwe", money(totalOwe));
    setText("metricOwed", money(totalOwed));
    setText("metricDueSoon", String(dueSoon));
    setText("metricOverdue", String(overdue));
    setText("metricMissingLedger", String(missingLedger));
    setText("metricHealth", healthStatus);

    setText("debtsVersionPill", payload?.version || VERSION);
    setText("debtsHealthPill", `health ${healthStatus}`);
    setText("debtsLedgerPill", `${missingLedger} needs repair`);
    setText("debtFooterVersion", `${VERSION} · backend ${payload?.version || "unknown"}`);

    if (missingLedger > 0) {
      setText("debtsHeroStatus", "Ledger repair needed");
      setText("debtsHeroCopy", `${missingLedger} debt origin movement is missing a ledger row. Use Repair Ledger on the affected debt.`);
    } else {
      setText("debtsHeroStatus", "Debt truth");
      setText("debtsHeroCopy", "Debt rows and origin ledger links are loaded from backend truth.");
    }
  }

  function renderDebtCard(debt) {
    const selected = String(debt.id) === String(state.selectedDebtId);
    const terminal = isTerminal(debt.status);
    const pct = Math.round(debtPaidPct(debt));
    const tone = toneClass(debtStatusText(debt));
    const dueDate = debt.next_due_date || debt.due_date || "";

    const detailId = `debt-detail-${String(debt.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    return `
      <article class="sf-panel ${selected ? "is-selected" : ""}" data-debt-id="${esc(debt.id)}">
        <div class="sf-section-head">
          <div>
            <p class="sf-section-kicker">${esc(kindShort(debt.kind))} · ${esc(debt.id)}</p>
            <h2 class="sf-section-title">${esc(debt.name)}</h2>
            <p class="sf-section-subtitle">
              ${esc(debtOriginLabel(debt))}
              ${dueDate ? ` · next ${esc(compactDate(dueDate))}` : " · no due date"}
              ${debt.days_overdue ? ` · ${esc(debt.days_overdue)}d overdue` : ""}
            </p>
          </div>

          <div class="sf-section-actions">
            ${pill(debtStatusText(debt), tone)}
            ${pill(`${pct}% paid`, "positive")}
            ${pill(money(debt.remaining_amount), debt.kind === "owed" ? "positive" : "danger")}
          </div>
        </div>

        <div class="sf-section-actions">
          <button class="sf-button" type="button" data-select-debt="${esc(debt.id)}">Details</button>
          <button class="sf-button" type="button" data-toggle-debt="${esc(debt.id)}" aria-controls="${esc(detailId)}">Expand</button>
          <button class="sf-button" type="button" data-edit-debt="${esc(debt.id)}">Edit</button>
          ${!terminal ? `<button class="sf-button sf-button--primary" type="button" data-pay-debt="${esc(debt.id)}">Payment</button>` : ""}
          ${!terminal ? `<button class="sf-button" type="button" data-defer-debt="${esc(debt.id)}">Defer</button>` : ""}
          ${debt.ledger_required && !debt.ledger_linked
            ? `<button class="sf-button" type="button" data-repair-debt="${esc(debt.id)}">Repair Ledger</button>`
            : ""}
          <a class="sf-button" href="/transactions.html">Ledger</a>
        </div>

        <div id="${esc(detailId)}" data-debt-detail="${esc(debt.id)}" hidden>
          ${renderDebtDetailRows(debt)}
        </div>
      </article>
    `;
  }

  function renderDebtDetailRows(debt) {
    return `
      ${row("Original", "Debt principal", money(debt.original_amount))}
      ${row("Paid", "Backend paid amount", money(debt.paid_amount))}
      ${row("Remaining", "Backend remaining", money(debt.remaining_amount), debt.remaining_amount > 0 ? "warning" : "positive")}
      ${row("Due", "Schedule", debt.next_due_date || debt.due_date || "—")}
      ${row("Origin", "Ledger origin state", debtOriginLabel(debt), debt.ledger_linked ? "positive" : debt.ledger_required ? "danger" : "warning")}
      ${row("Origin IDs", "Origin ledger transactions", debt.ledger_transaction_ids.length ? debt.ledger_transaction_ids.join(", ") : "None")}
      ${row("Payment IDs", "Payment ledger transactions", debt.payment_transaction_ids.length ? debt.payment_transaction_ids.join(", ") : "None")}
      ${row("Created", "Backend timestamp", formatDateTime(debt.created_at))}
      ${debt.notes ? row("Notes", "Backend notes", debt.notes) : ""}
    `;
  }

  function renderDebtList() {
    const list = $("debtList");
    if (!list) return;

    const rows = filteredDebts();

    list.innerHTML = rows.length
      ? rows.map(renderDebtCard).join("")
      : empty("No debts match this filter.");

    bindDebtCardActions();
  }

  function bindDebtCardActions() {
    document.querySelectorAll("[data-toggle-debt]").forEach(button => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-toggle-debt");
        const detail = document.querySelector(`[data-debt-detail="${cssEscape(id)}"]`);

        if (detail) detail.hidden = !detail.hidden;

        state.selectedDebtId = id;
        renderSelectedDebt();
        renderDebug();
      });
    });

    document.querySelectorAll("[data-select-debt]").forEach(button => {
      button.addEventListener("click", () => selectDebt(button.getAttribute("data-select-debt")));
    });

    document.querySelectorAll("[data-edit-debt]").forEach(button => {
      button.addEventListener("click", () => openEditPanel(button.getAttribute("data-edit-debt")));
    });

    document.querySelectorAll("[data-pay-debt]").forEach(button => {
      button.addEventListener("click", () => openPaymentModal(button.getAttribute("data-pay-debt")));
    });

    document.querySelectorAll("[data-defer-debt]").forEach(button => {
      button.addEventListener("click", () => openDeferModal(button.getAttribute("data-defer-debt")));
    });

    document.querySelectorAll("[data-repair-debt]").forEach(button => {
      button.addEventListener("click", () => openRepairPanel(button.getAttribute("data-repair-debt")));
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value || "").replace(/"/g, '\\"');
  }

  function selectDebt(id) {
    state.selectedDebtId = id;

    document.querySelectorAll("[data-debt-id]").forEach(card => {
      card.classList.toggle("is-selected", card.getAttribute("data-debt-id") === String(id));
    });

    renderSelectedDebt();
    renderDebug();
  }

  function renderSelectedDebt() {
    const debt = selectedDebt();

    if (!debt) {
      setText("selectedDebtTitle", "No debt selected");
      setText("selectedDebtSub", "Select a debt to inspect schedule, linked ledger rows, and repair options.");
      setHTML("selectedDebtPanel", empty("No debt selected."));
      return;
    }

    setText("selectedDebtTitle", debt.name);
    setText("selectedDebtSub", `${kindLabel(debt.kind)} · ${debt.id}`);

    setHTML("selectedDebtPanel", `
      ${row("Kind", "Money direction", kindLabel(debt.kind), debt.kind === "owed" ? "positive" : "danger")}
      ${row("Original amount", "Debt principal", money(debt.original_amount))}
      ${row("Paid amount", "Settled so far", money(debt.paid_amount))}
      ${row("Remaining", "Backend remaining", money(debt.remaining_amount), debt.remaining_amount > 0 ? "warning" : "positive")}
      ${row("Status", "Debt row status", debt.status || "active")}
      ${row("Due status", "Schedule state", debt.due_status || "no schedule")}
      ${row("Next due", "Computed backend due date", debt.next_due_date || "—")}
      ${row("Origin state", "Ledger origin classifier", debtOriginLabel(debt), debt.ledger_linked ? "positive" : debt.ledger_required ? "danger" : "warning")}
      ${row("Origin transactions", "Origin transaction IDs", debt.ledger_transaction_ids.length ? debt.ledger_transaction_ids.join(", ") : "None")}
      ${row("Payment transactions", "Payment transaction IDs", debt.payment_transaction_ids.length ? debt.payment_transaction_ids.join(", ") : "None")}
      ${debt.notes ? row("Notes", "Backend notes", debt.notes) : ""}
    `);
  }

  function renderEnforcement() {
    setHTML("debtEnforcementPanel", `
      ${row("Canonical route", "All debt writes", "POST /api/debts", "positive")}
      ${row("Debt create rule", "If money moved now", "account_id required", "warning")}
      ${row("I owe", "Origin ledger type", "income into selected account", "positive")}
      ${row("Owed to me", "Origin ledger type", "expense from selected account", "danger")}
      ${row("Payment marker", "I owe payment", "[DEBT_PAYMENT]", "danger")}
      ${row("Receive marker", "Owed-to-me payment", "[DEBT_RECEIVE]", "positive")}
      ${row("Reversal owner", "Only canonical ledger reversal", "POST /api/transactions/reverse", "positive")}
    `);
  }

  function renderDebug(extra) {
    setText("debtDebug", JSON.stringify({
      version: VERSION,
      filter: state.filter,
      search: state.search,
      sort: state.sort,
      selectedDebtId: state.selectedDebtId,
      debts: state.debts,
      accounts: state.accounts,
      health: state.health,
      lastPayload: state.lastPayload,
      extra: extra || null
    }, null, 2));
  }

  function renderAll(payload) {
    renderMetrics(payload || {});
    ensureDebtControls();
    renderDebtList();
    renderSelectedDebt();
    renderEnforcement();
    renderDebug();
  }

  function setFilter(filter) {
    state.filter = filter;

    document.querySelectorAll("[data-filter]").forEach(button => {
      const isActive = button.getAttribute("data-filter") === filter;
      button.classList.toggle("is-active", isActive);
      button.classList.toggle("sf-button--primary", isActive);
    });

    renderDebtList();
    renderDebug();
  }

  function ensureDebtControls() {
    if ($("debtSearchInput") && $("debtSortInput")) return;

    const list = $("debtList");
    if (!list || !list.parentElement) return;

    const controls = document.createElement("div");
    controls.className = "sf-section-actions";
    controls.innerHTML = `
      <input
        id="debtSearchInput"
        class="sf-input"
        type="search"
        placeholder="Search debts, IDs, notes, ledger IDs"
        value="${esc(state.search)}"
      >
      <select id="debtSortInput" class="sf-select">
        <option value="due">Sort: Due date</option>
        <option value="created">Sort: Created</option>
        <option value="amount">Sort: Amount</option>
        <option value="name">Sort: Name</option>
      </select>
    `;

    list.parentElement.insertBefore(controls, list);

    $("debtSearchInput")?.addEventListener("input", event => {
      state.search = event.target.value.trim();
      renderDebtList();
      renderDebug();
    });

    $("debtSortInput")?.addEventListener("change", event => {
      state.sort = event.target.value || "due";
      renderDebtList();
      renderDebug();
    });

    const sort = $("debtSortInput");
    if (sort) sort.value = state.sort;
  }

  function wireFilters() {
    document.querySelectorAll("[data-filter]").forEach(button => {
      button.addEventListener("click", () => setFilter(button.getAttribute("data-filter")));
    });
  }

  function openDebtModal() {
    resetDebtForm();

    const date = $("debtMovementDateInput");
    if (date && !date.value) date.value = todayISO();

    renderAccountOptions();
    updateDebtMovementCopy();
    openModal("debtModal");
  }

  function openModal(id) {
    const el = $(id);
    if (el) el.hidden = false;
  }

  function closeModal(id) {
    const el = $(id);
    if (el) el.hidden = true;
  }

  function resetDebtForm() {
    const form = $("addDebtForm");
    if (form) form.reset();

    const paid = $("debtPaidInput");
    if (paid) paid.value = "0";

    const movement = $("debtMovementNowInput");
    if (movement) movement.checked = true;

    const date = $("debtMovementDateInput");
    if (date) date.value = todayISO();
  }

  function updateDebtMovementCopy() {
    const kind = $("debtKindInput")?.value || "owed";
    const movement = $("debtMovementNowInput");
    const account = $("debtAccountInput");
    const copy = $("debtMovementCopy");

    if (copy) {
      copy.textContent = kind === "owed"
        ? "Owed to me means money leaves the selected account now."
        : "I owe means money enters the selected account now.";
    }

    const enabled = movement ? movement.checked : false;
    if (account) account.disabled = !enabled;
  }

  function buildDebtCreatePayload() {
    const movementNow = Boolean($("debtMovementNowInput")?.checked);
    const kind = $("debtKindInput")?.value || "owed";
    const name = clean($("debtNameInput")?.value);
    const amount = num($("debtOriginalInput")?.value);
    const movementDate = clean($("debtMovementDateInput")?.value) || todayISO();

    return {
      action: "create",
      name,
      kind,
      original_amount: amount,
      paid_amount: num($("debtPaidInput")?.value),
      due_date: clean($("debtDueDateInput")?.value) || null,
      due_day: clean($("debtDueDayInput")?.value) || null,
      installment_amount: clean($("debtInstallmentInput")?.value) || null,
      frequency: $("debtFrequencyInput")?.value || "monthly",
      status: $("debtStatusInput")?.value || "active",
      snowball_order: clean($("debtSnowballInput")?.value) || null,
      movement_now: movementNow,
      money_moved_now: movementNow,
      account_id: movementNow ? clean($("debtAccountInput")?.value) : "",
      movement_date: movementDate,
      notes: clean($("debtNotesInput")?.value),
      idempotency_key: buildClientKey(["debt_create", name, kind, amount, movementNow, movementDate]),
      created_by: "web-debts-v0.8.0"
    };
  }

  function validateDebtCreatePayload(payload) {
    if (!payload.name) return "Debt name required.";
    if (!payload.kind) return "Debt direction required.";
    if (!Number.isFinite(payload.original_amount) || payload.original_amount <= 0) return "Original amount must be greater than 0.";
    if (!Number.isFinite(payload.paid_amount) || payload.paid_amount < 0) return "Paid amount must be 0 or greater.";
    if (payload.paid_amount > payload.original_amount) return "Already paid cannot exceed original amount.";
    if (payload.movement_now && !payload.account_id) return "Select the account money moved through.";
    return null;
  }

  async function dryRunDebtCreate() {
    const payload = buildDebtCreatePayload();
    const error = validateDebtCreatePayload(payload);

    if (error) {
      toast(error);
      return;
    }

    try {
      const result = await postJSON(`${API_DEBTS}?dry_run=1`, payload);
      renderActionResult("Debt create dry-run", result);
      toast("Debt dry-run passed.");
    } catch (err) {
      toast(`Dry-run failed: ${err.message}`);
    }
  }

  async function saveNewDebt() {
    const payload = buildDebtCreatePayload();
    const error = validateDebtCreatePayload(payload);

    if (error) {
      toast(error);
      return;
    }

    const button = $("saveDebtBtn");

    if (button) {
      button.disabled = true;
      button.textContent = "Saving…";
    }

    try {
      const result = await postJSON(API_DEBTS, payload);

      toast(result.origin_transaction_id || result.ledger?.transaction_id
        ? "Debt saved with ledger movement."
        : "Debt saved without money movement.");

      closeModal("debtModal");
      await loadDebts();

      if (result.id) selectDebt(result.id);
    } catch (err) {
      toast(`Debt save failed: ${err.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Save Debt";
      }
    }
  }

  function openEditPanel(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    renderSelectedDebt();

    setHTML("debtActionPanel", `
      ${row("Amount", "Amount mutation is blocked here. Use reversal/re-entry for money correction.", money(debt.original_amount), "warning")}

      <div class="sf-form-grid">
        <label class="sf-field" for="editDueDateInput">
          <span>Due Date</span>
          <input class="sf-input" id="editDueDateInput" type="date" value="${esc(debt.due_date || "")}">
        </label>

        <label class="sf-field" for="editDueDayInput">
          <span>Due Day</span>
          <input class="sf-input" id="editDueDayInput" type="number" min="1" max="31" value="${esc(debt.due_day || "")}">
        </label>

        <label class="sf-field" for="editInstallmentInput">
          <span>Installment Amount</span>
          <input class="sf-input" id="editInstallmentInput" type="number" step="0.01" min="0" value="${esc(debt.installment_amount || "")}">
        </label>

        <label class="sf-field" for="editFrequencyInput">
          <span>Frequency</span>
          <select class="sf-select" id="editFrequencyInput">
            ${["monthly", "weekly", "yearly", "custom"].map(f => `<option value="${f}" ${debt.frequency === f ? "selected" : ""}>${f}</option>`).join("")}
          </select>
        </label>

        <label class="sf-field" for="editNotesInput">
          <span>Notes</span>
          <textarea class="sf-textarea" id="editNotesInput">${esc(debt.notes || "")}</textarea>
        </label>
      </div>

      <div class="sf-section-actions">
        <button class="sf-button sf-button--primary" type="button" id="saveDebtEditBtn">Save Edit</button>
      </div>
    `);

    $("saveDebtEditBtn")?.addEventListener("click", () => submitEditDebt(id));
  }

  async function submitEditDebt(id) {
    try {
      const result = await putJSON(`${API_DEBTS}/${encodeURIComponent(id)}`, {
        due_date: clean($("editDueDateInput")?.value) || null,
        due_day: clean($("editDueDayInput")?.value) || null,
        installment_amount: clean($("editInstallmentInput")?.value) || null,
        frequency: $("editFrequencyInput")?.value || "custom",
        notes: clean($("editNotesInput")?.value)
      });

      renderActionResult("Debt schedule updated", result);
      toast("Debt schedule updated.");
      await loadDebts();
      selectDebt(id);
    } catch (err) {
      setHTML("debtActionPanel", empty(`Edit failed: ${err.message}`));
    }
  }

  function openRepairPanel(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    renderSelectedDebt();

    const copy = debt.kind === "owed"
      ? "Owed to me: choose the source account money left from. Backend writes an expense origin."
      : "I owe: choose the destination account money entered into. Backend writes an income origin.";

    setHTML("debtActionPanel", `
      ${row("Debt", debt.id, `${esc(debt.name)} · ${money(debt.original_amount)}`)}
      ${row("Direction", "Repair rule", debt.kind === "owed" ? "expense" : "income", debt.kind === "owed" ? "danger" : "positive")}

      <div class="sf-form-grid">
        <label class="sf-field" for="repairAccountInput">
          <span>Correct Account</span>
          <select class="sf-select" id="repairAccountInput">
            <option value="">Select account…</option>
          </select>
          <small class="sf-meta-text">${esc(copy)}</small>
        </label>

        <label class="sf-field" for="repairDateInput">
          <span>Movement Date</span>
          <input class="sf-input" id="repairDateInput" type="date" value="${todayISO()}">
        </label>
      </div>

      <div class="sf-section-actions">
        <button class="sf-button" type="button" id="dryRunRepairBtn">Dry-run Repair</button>
        <button class="sf-button sf-button--primary" type="button" id="commitRepairBtn">Commit Repair</button>
      </div>
    `);

    renderAccountOptions();

    $("dryRunRepairBtn")?.addEventListener("click", () => submitRepairLedger(id, true));
    $("commitRepairBtn")?.addEventListener("click", () => submitRepairLedger(id, false));
  }

  async function submitRepairLedger(id, dryRun) {
    const accountId = clean($("repairAccountInput")?.value);

    if (!accountId) {
      toast("Select account first.");
      return;
    }

    const date = clean($("repairDateInput")?.value) || todayISO();

    const body = {
      action: "repair_ledger",
      debt_id: id,
      account_id: accountId,
      date,
      idempotency_key: buildClientKey(["repair_ledger", id, accountId, date]),
      created_by: "web-debts-v0.8.0"
    };

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? "?dry_run=1" : ""}`, body);

      renderActionResult(dryRun ? "Repair dry-run" : "Repair committed", result);
      toast(dryRun ? "Repair dry-run passed." : "Repair committed.");

      if (!dryRun) {
        await loadDebts();
        selectDebt(id);
      }
    } catch (err) {
      setHTML("debtActionPanel", empty(`Repair failed: ${err.message}`));
    }
  }

  function openPaymentModal(id) {
    const debt = findDebtById(id);

    if (!debt) {
      toast(`Cannot open payment. Debt not loaded: ${id}`);
      return;
    }

    state.selectedDebtId = debt.id;
    renderSelectedDebt();

    const hidden = $("paymentDebtIdInput");
    if (hidden) hidden.value = debt.id;

    const amountInput = $("paymentAmountInput");
    if (amountInput) amountInput.value = debt.installment_amount || debt.remaining_amount || "";

    const dateInput = $("paymentDateInput");
    if (dateInput) dateInput.value = todayISO();

    const notesInput = $("paymentNotesInput");
    if (notesInput) notesInput.value = `${debt.name} · debt payment`;

    const direction = $("paymentDirectionInput");
    if (direction) direction.value = "auto";

    const subtitle = document.querySelector("#paymentModal .sf-section-subtitle");
    if (subtitle) {
      subtitle.textContent = `Debt ID: ${debt.id} · ${kindLabel(debt.kind)} · remaining ${money(debt.remaining_amount)}`;
    }

    renderAccountOptions();
    openModal("paymentModal");
  }

  async function savePayment(dryRun) {
    const hiddenDebtId = clean($("paymentDebtIdInput")?.value);
    const debtId = hiddenDebtId || state.selectedDebtId;
    const debt = findDebtById(debtId);

    if (!debtId) {
      toast("No debt selected.");
      return;
    }

    if (!debt) {
      toast(`Selected debt is not loaded in UI state: ${debtId}`);
      return;
    }

    const amount = num($("paymentAmountInput")?.value);
    const date = clean($("paymentDateInput")?.value) || todayISO();
    const accountId = clean($("paymentAccountInput")?.value);

    const body = {
      action: "payment",
      debt_id: debt.id,
      amount,
      date,
      account_id: accountId,
      direction: $("paymentDirectionInput")?.value || "auto",
      notes: clean($("paymentNotesInput")?.value),
      idempotency_key: buildClientKey(["debt_payment", debt.id, amount, accountId, date]),
      created_by: "web-debts-v0.8.0"
    };

    if (!body.amount || body.amount <= 0) {
      toast("Payment amount must be greater than 0.");
      return;
    }

    if (!body.account_id) {
      toast("Select payment account.");
      return;
    }

    const button = dryRun ? $("dryRunPaymentBtn") : $("savePaymentBtn");

    if (button) {
      button.disabled = true;
      button.textContent = dryRun ? "Dry-running…" : "Saving…";
    }

    try {
      const result = await postJSON(`${API_DEBTS}${dryRun ? "?dry_run=1" : ""}`, body);

      if (dryRun) {
        renderActionResult("Payment dry-run", result);
        toast("Payment dry-run passed.");
        return;
      }

      toast("Payment saved.");
      closeModal("paymentModal");
      await loadDebts();
      selectDebt(debt.id);
    } catch (err) {
      toast(`Payment failed: ${err.message}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = dryRun ? "Dry-run Payment" : "Save Payment";
      }
    }
  }

  function openDeferModal(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    if ($("deferDebtIdInput")) $("deferDebtIdInput").value = id;
    if ($("deferDueDateInput")) $("deferDueDateInput").value = debt.due_date || "";
    if ($("deferDueDayInput")) $("deferDueDayInput").value = debt.due_day || "";
    if ($("deferNotesInput")) $("deferNotesInput").value = debt.notes || "";

    openModal("deferModal");
  }

  async function saveDefer() {
    const id = clean($("deferDebtIdInput")?.value);

    if (!id) {
      toast("No debt selected.");
      return;
    }

    try {
      const result = await putJSON(`${API_DEBTS}/${encodeURIComponent(id)}`, {
        due_date: clean($("deferDueDateInput")?.value) || null,
        due_day: clean($("deferDueDayInput")?.value) || null,
        notes: clean($("deferNotesInput")?.value)
      });

      renderActionResult("Debt deferred", result);
      toast("Debt deferred.");
      closeModal("deferModal");
      await loadDebts();
      selectDebt(id);
    } catch (err) {
      toast(`Defer failed: ${err.message}`);
    }
  }

  function renderActionResult(title, result) {
    const ledger = result.ledger || result.proof?.ledger || {};
    const account = result.account || result.proof?.account || {};
    const forecast = result.forecast || result.proof?.forecast || {};
    const payment = result.payment || {};
    const proof = result.proof || {};

    setHTML("debtActionPanel", `
      ${row(title, "Backend result", result.ok ? "OK" : "Failed", result.ok ? "positive" : "danger")}
      ${row("Contract", "Backend contract version", result.contract_version || "—")}
      ${row("Writes performed", "Backend truth", String(Boolean(result.writes_performed)), result.writes_performed ? "positive" : "warning")}
      ${row("Ledger created", "Money movement", String(Boolean(ledger.created)), ledger.created ? "positive" : "warning")}
      ${row("Ledger transaction", "Transaction ID", ledger.transaction_id || result.transaction_id || result.origin_transaction_id || result.payment_transaction_id || "—")}
      ${row("Ledger type", "Expected movement", ledger.type || result.payment_transaction?.type || "—", ledger.type === "income" ? "positive" : ledger.type === "expense" ? "danger" : "")}
      ${row("Marker", "Debt ledger marker", ledger.marker || proof.marker || "—")}
      ${row("Account delta", "Ledger-derived impact", account.account_delta == null ? "—" : money(account.account_delta), account.account_delta > 0 ? "positive" : account.account_delta < 0 ? "danger" : "")}
      ${row("Payment", "Payment row", payment.payment_id || result.payment_id || "—")}
      ${row("Forecast", "Should reflect", String(Boolean(forecast.should_reflect)), forecast.should_reflect ? "positive" : "warning")}
      ${row("Proof action", "Backend proof", proof.action || result.action || "—")}
    `);

    renderDebug({ lastActionResult: result });
  }

  function wireModalButtons() {
    $("addDebtBtn")?.addEventListener("click", openDebtModal);
    $("newDebtBtn")?.addEventListener("click", openDebtModal);
    $("refreshDebtsBtn")?.addEventListener("click", loadDebts);
    $("reloadDebtsBtn")?.addEventListener("click", loadDebts);

    $("closeDebtModalBtn")?.addEventListener("click", () => closeModal("debtModal"));
    $("dryRunDebtBtn")?.addEventListener("click", dryRunDebtCreate);
    $("saveDebtBtn")?.addEventListener("click", saveNewDebt);

    $("debtKindInput")?.addEventListener("change", updateDebtMovementCopy);
    $("debtMovementNowInput")?.addEventListener("change", updateDebtMovementCopy);

    $("closePaymentModalBtn")?.addEventListener("click", () => closeModal("paymentModal"));
    $("dryRunPaymentBtn")?.addEventListener("click", () => savePayment(true));
    $("savePaymentBtn")?.addEventListener("click", () => savePayment(false));

    $("closeDeferModalBtn")?.addEventListener("click", () => closeModal("deferModal"));
    $("saveDeferBtn")?.addEventListener("click", saveDefer);
  }

  function toast(message) {
    const el = $("debtToast");
    if (!el) return;

    el.textContent = message;
    el.classList.add("show");

    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove("show"), 3000);
  }

  function buildClientKey(parts) {
    return parts
      .concat(Date.now())
      .join("|")
      .toLowerCase()
      .replace(/[^a-z0-9|._-]+/g, "_")
      .slice(0, 180);
  }

  function init() {
    wireFilters();
    wireModalButtons();

    const movementDate = $("debtMovementDateInput");
    if (movementDate && !movementDate.value) movementDate.value = todayISO();

    window.SovereignDebts = {
      version: VERSION,
      canonical_route: API_DEBTS,
      reload: loadDebts,
      state: () => JSON.parse(JSON.stringify(state))
    };

    loadDebts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
