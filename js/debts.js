/* js/debts.js
 * Sovereign Finance · Debts UI
 * v0.7.0-debts-contract-ui
 *
 * Contract:
 * - Frontend calls canonical route only:
 *     POST /api/debts
 * - No /api/debts/:id/pay
 * - No /api/debts/:id/receive
 * - No debt payment reversal route from Debts UI.
 * - Reversal remains canonical through Ledger:
 *     POST /api/transactions/reverse
 * - Frontend displays backend proof; it does not calculate authoritative money truth.
 */

(function () {
  "use strict";

  const VERSION = "v0.7.0-debts-contract-ui";

  const API_DEBTS = "/api/debts";
  const API_DEBTS_LIST = "/api/debts?include_inactive=1";
  const API_DEBTS_HEALTH = "/api/debts?action=health";
  const API_ACCOUNTS_PRIMARY = "/api/add/context";
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

    return raw
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "")
      .replace(/Z$/, "");
  }

  function kindLabel(kind) {
    return kind === "owed" ? "Owed to me" : "I owe";
  }

  function kindShort(kind) {
    return kind === "owed" ? "Receivable" : "Payable";
  }

  function kindTone(kind) {
    return kind === "owed" ? "good" : "danger";
  }

  function toneClass(value) {
    const s = String(value || "").toLowerCase();

    if (["ok", "active", "linked", "scheduled", "paid_off", "settled", "pass"].includes(s)) return "good";
    if (["warn", "due_soon", "due_today", "no_schedule", "missing_ledger", "paused"].includes(s)) return "warn";
    if (["overdue", "missing", "danger", "blocked", "failed", "closed"].includes(s)) return "danger";

    return "";
  }

  function tag(text, tone) {
    return `<span class="debt-tag ${tone || ""}">${esc(text)}</span>`;
  }

  function blocker(text, tone) {
    return `<span class="${tone || ""}">${esc(text)}</span>`;
  }

  function row(title, sub, value, tone) {
    return `
      <div class="debt-row">
        <div>
          <div class="debt-row-title">${esc(title)}</div>
          ${sub ? `<div class="debt-row-sub">${esc(sub)}</div>` : ""}
        </div>
        <div class="debt-row-value ${tone ? `sf-tone-${esc(tone)}` : ""}">
          ${value == null ? "—" : value}
        </div>
      </div>
    `;
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
      const message = payload && (payload.error || payload.message)
        ? payload.error || payload.message
        : `HTTP ${response.status}`;
      throw new Error(message);
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

  function normalizeDebt(row) {
    const original = num(row.original_amount ?? row.amount);
    const paid = num(row.paid_amount);
    const remaining = num(row.remaining_amount, Math.max(0, original - paid));

    return {
      ...row,
      id: row.id || "",
      name: row.name || row.title || row.label || row.id || "Debt",
      kind: row.kind === "owed" ? "owed" : "owe",
      original_amount: original,
      paid_amount: paid,
      remaining_amount: remaining,
      status: row.status || "active",
      due_status: row.due_status || "no_schedule",
      due_date: row.due_date || null,
      due_day: row.due_day == null ? null : row.due_day,
      installment_amount: row.installment_amount == null ? null : num(row.installment_amount),
      frequency: row.frequency || "monthly",
      last_paid_date: row.last_paid_date || null,
      next_due_date: row.next_due_date || null,
      days_until_due: row.days_until_due == null ? null : row.days_until_due,
      days_overdue: row.days_overdue == null ? null : row.days_overdue,
      schedule_missing: Boolean(row.schedule_missing),
      ledger_linked: Boolean(row.ledger_linked),
      ledger_required: Boolean(row.ledger_required),
      ledger_transaction_ids: Array.isArray(row.ledger_transaction_ids) ? row.ledger_transaction_ids : [],
      ledger_transactions: Array.isArray(row.ledger_transactions) ? row.ledger_transactions : [],
      origin_state: row.origin_state || row.ledger_state || "",
      origin_required: Boolean(row.origin_required ?? row.ledger_required),
      origin_linked: Boolean(row.origin_linked ?? row.ledger_linked),
      origin_transaction_ids: Array.isArray(row.origin_transaction_ids) ? row.origin_transaction_ids : [],
      origin_transactions: Array.isArray(row.origin_transactions) ? row.origin_transactions : [],
      payment_transaction_ids: Array.isArray(row.payment_transaction_ids) ? row.payment_transaction_ids : [],
      payment_transactions: Array.isArray(row.payment_transactions) ? row.payment_transactions : [],
      repair_required: Boolean(row.repair_required),
      notes: row.notes || "",
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      settled_at: row.settled_at || null,
      raw: row
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
      const payload = await fetchJSON(API_ACCOUNTS_PRIMARY);
      state.accounts = accountRowsFromPayload(payload).filter(Boolean);
    } catch {
      try {
        const payload = await fetchJSON(API_ACCOUNTS_FALLBACK);
        state.accounts = accountRowsFromPayload(payload).filter(Boolean);
      } catch {
        state.accounts = [];
      }
    }

    renderAccountOptions();
  }

  async function loadDebts() {
    if (state.loading) return;

    state.loading = true;
    setHTML("debtList", '<div class="debt-empty">Loading debts…</div>');

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
      setHTML("debtList", `<div class="debt-empty">Failed to load debts: ${esc(err.message)}</div>`);
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
    const q = state.search.toLowerCase();

    return state.debts
      .filter(debt => {
        if (q && !debtSearchHaystack(debt).includes(q)) return false;

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

  function debtOriginLabel(debt) {
    if (debt.ledger_linked) return "ledger linked";
    if (debt.ledger_required) return "needs repair";

    const notes = String(debt.notes || "").toLowerCase();
    if (notes.includes("movement_now=0")) return "debt-only";
    if (debt.origin_state === "legacy_unknown") return "legacy/no-origin";
    if (debt.origin_state === "payment_linked_only") return "payment-linked only";

    return "no origin movement";
  }

  function debtOriginTone(debt) {
    if (debt.ledger_linked) return "good";
    if (debt.ledger_required) return "danger";
    return "warn";
  }

  function debtStatusText(debt) {
    if (isTerminal(debt.status)) return debt.status;
    if (debt.due_status === "overdue") return "Overdue";
    if (debt.due_status === "due_today") return "Due today";
    if (debt.due_status === "due_soon") return "Due soon";
    if (debt.ledger_required && !debt.ledger_linked) return "Repair";
    return debt.status || "active";
  }

  function debtRowSubtitle(debt) {
    const parts = [debtOriginLabel(debt), debt.id];

    if (debt.next_due_date || debt.due_date) {
      parts.push(`next ${debt.next_due_date || debt.due_date}`);
    } else {
      parts.push("no due date");
    }

    if (debt.days_overdue) parts.push(`${debt.days_overdue}d overdue`);
    if (debt.days_until_due != null && debt.due_status === "due_soon") parts.push(`${debt.days_until_due}d left`);

    return parts.join(" · ");
  }

  function renderDebtTags(debt) {
    const tags = [];

    tags.push(tag(kindLabel(debt.kind), kindTone(debt.kind)));
    tags.push(tag(debt.status || "active", toneClass(debt.status)));
    tags.push(tag(debt.due_status || "no schedule", toneClass(debt.due_status)));
    tags.push(tag(debtOriginLabel(debt), debtOriginTone(debt)));

    if (isTerminal(debt.status)) tags.push(tag("inactive", "warn"));
    if (debt.next_due_date) tags.push(tag(`next ${debt.next_due_date}`));
    if (debt.days_overdue) tags.push(tag(`${debt.days_overdue}d overdue`, "danger"));
    if (debt.days_until_due != null && debt.due_status === "due_soon") tags.push(tag(`${debt.days_until_due}d left`, "warn"));

    return tags.join("");
  }

  function renderDebtBlockers(debt) {
    const blocks = [];

    if (debt.ledger_linked && debt.ledger_transaction_ids.length) {
      blocks.push(blocker(`origin ${debt.ledger_transaction_ids.join(", ")}`, "good"));
    }

    if (debt.payment_transaction_ids.length) {
      blocks.push(blocker(`payments ${debt.payment_transaction_ids.length}`, "good"));
    }

    if (debt.ledger_required && !debt.ledger_linked) {
      blocks.push(blocker("origin ledger missing", "danger"));
    }

    if (!debt.ledger_required && !debt.ledger_linked) {
      blocks.push(blocker("debt-only / no account movement", "warn"));
    }

    if (debt.schedule_missing && !isTerminal(debt.status)) {
      blocks.push(blocker("schedule missing", "warn"));
    }

    if (!blocks.length) return "";

    return `<div class="debt-blockers">${blocks.join("")}</div>`;
  }

  function renderDebtInlineDetail(debt) {
    const rows = [
      ["Kind", kindLabel(debt.kind)],
      ["Original", money(debt.original_amount)],
      ["Paid", money(debt.paid_amount)],
      ["Remaining", money(debt.remaining_amount)],
      ["Due date", debt.due_date || "—"],
      ["Next due", debt.next_due_date || "—"],
      ["Due status", debt.due_status || "—"],
      ["Frequency", debt.frequency || "—"],
      ["Installment", debt.installment_amount == null ? "—" : money(debt.installment_amount)],
      ["Origin movement", debtOriginLabel(debt)],
      ["Origin IDs", debt.ledger_transaction_ids.length ? debt.ledger_transaction_ids.join(", ") : "None"],
      ["Payment IDs", debt.payment_transaction_ids.length ? debt.payment_transaction_ids.join(", ") : "None"],
      ["Created", formatDateTime(debt.created_at)]
    ];

    return `
      <div class="debt-inline-grid">
        ${rows.map(([label, value]) => `
          <div class="debt-inline-label">${esc(label)}</div>
          <div class="debt-inline-value">${esc(value)}</div>
        `).join("")}
      </div>

      <div class="debt-inline-notes">
        <div class="debt-inline-label">Notes</div>
        <div class="debt-inline-note-text">${esc(debt.notes || "—")}</div>
      </div>

      ${debt.ledger_transactions.length ? `
        <div class="debt-inline-notes">
          <div class="debt-inline-label">Origin ledger transactions</div>
          <div class="debt-inline-note-text">
            ${esc(debt.ledger_transactions.map(tx => [
              tx.id,
              tx.date,
              tx.type,
              tx.account_id,
              tx.amount
            ].filter(Boolean).join(" · ")).join("\n"))}
          </div>
        </div>
      ` : ""}

      ${debt.payment_transactions.length ? `
        <div class="debt-inline-notes">
          <div class="debt-inline-label">Payment ledger transactions</div>
          <div class="debt-inline-note-text">
            ${esc(debt.payment_transactions.map(tx => [
              tx.id,
              tx.date,
              tx.type,
              tx.account_id,
              tx.amount,
              tx.notes
            ].filter(Boolean).join(" · ")).join("\n"))}
          </div>
        </div>
      ` : ""}

      <div class="debt-card-actions inline">
        <button class="debt-action" type="button" data-select-debt="${esc(debt.id)}">Details</button>
        <button class="debt-action primary" type="button" data-edit-debt="${esc(debt.id)}">Edit</button>
        ${!isTerminal(debt.status) ? `<button class="debt-action" type="button" data-pay-debt="${esc(debt.id)}">Payment</button>` : ""}
        ${!isTerminal(debt.status) ? `<button class="debt-action" type="button" data-defer-debt="${esc(debt.id)}">Defer</button>` : ""}
        ${debt.ledger_required && !debt.ledger_linked
          ? `<button class="debt-action danger" type="button" data-repair-debt="${esc(debt.id)}">Repair Ledger</button>`
          : ""}
        <a class="debt-action" href="/transactions.html">Open Ledger</a>
      </div>
    `;
  }

  function renderDebtCard(debt) {
    const selected = String(debt.id) === String(state.selectedDebtId);
    const pct = debtPaidPct(debt);
    const statusTone = toneClass(debtStatusText(debt));
    const dueDate = debt.next_due_date || debt.due_date || "";

    return `
      <article class="debt-card debt-compact-row ${selected ? "is-selected" : ""}" data-debt-id="${esc(debt.id)}">
        <button class="debt-row-shell" type="button" data-toggle-debt="${esc(debt.id)}">
          <div class="debt-icon">${debt.kind === "owed" ? "📥" : "📤"}</div>

          <div class="debt-copy-block">
            <div class="debt-title">${esc(debt.name)}</div>
            <div class="debt-sub">${esc(debtRowSubtitle(debt))}</div>
          </div>

          <div class="debt-row-kind">${esc(kindShort(debt.kind))}</div>
          <div class="debt-row-date">${esc(dueDate ? compactDate(dueDate) : "—")}</div>
          <div class="debt-amount">${money(debt.remaining_amount)}</div>
          <div class="debt-row-status ${statusTone}">${esc(debtStatusText(debt))}</div>
          <div class="debt-expand-caret">▾</div>
        </button>

        <div class="debt-progress" style="--paid-pct:${pct}%;">
          <div class="debt-progress-fill"></div>
        </div>

        <div class="debt-tags">${renderDebtTags(debt)}</div>
        ${renderDebtBlockers(debt)}

        <div class="debt-inline-detail" data-debt-detail="${esc(debt.id)}">
          ${renderDebtInlineDetail(debt)}
        </div>
      </article>
    `;
  }

  function renderDebtList() {
    const list = $("debtList");
    if (!list) return;

    const rows = filteredDebts();

    list.innerHTML = rows.length
      ? rows.map(renderDebtCard).join("")
      : '<div class="debt-empty">No debts match this filter.</div>';

    bindDebtCardActions();
  }

  function bindDebtCardActions() {
    document.querySelectorAll("[data-toggle-debt]").forEach(button => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-toggle-debt");
        const card = document.querySelector(`[data-debt-id="${cssEscape(id)}"]`);
        if (!card) return;

        card.classList.toggle("is-open");
        state.selectedDebtId = id;
        renderSelectedDebt();
        renderDebug();
      });
    });

    document.querySelectorAll("[data-select-debt]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        selectDebt(button.getAttribute("data-select-debt"));
      });
    });

    document.querySelectorAll("[data-edit-debt]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        openEditPanel(button.getAttribute("data-edit-debt"));
      });
    });

    document.querySelectorAll("[data-pay-debt]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        openPaymentModal(button.getAttribute("data-pay-debt"));
      });
    });

    document.querySelectorAll("[data-defer-debt]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        openDeferModal(button.getAttribute("data-defer-debt"));
      });
    });

    document.querySelectorAll("[data-repair-debt]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        openRepairPanel(button.getAttribute("data-repair-debt"));
      });
    });
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value || "").replace(/"/g, '\\"');
  }

  function selectDebt(id) {
    state.selectedDebtId = id;

    document.querySelectorAll(".debt-card").forEach(card => {
      const selected = card.getAttribute("data-debt-id") === String(id);
      card.classList.toggle("is-selected", selected);
      if (selected) card.classList.add("is-open");
    });

    renderSelectedDebt();
    renderDebug();
  }

  function renderSelectedDebt() {
    const debt = selectedDebt();

    if (!debt) {
      setText("selectedDebtTitle", "No debt selected");
      setText("selectedDebtSub", "Select a debt to inspect schedule, linked ledger rows, and repair options.");
      setHTML("selectedDebtPanel", '<div class="debt-empty">No debt selected.</div>');
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
      ${row("Origin state", "Ledger origin classifier", debtOriginLabel(debt), debtOriginTone(debt) === "good" ? "positive" : debtOriginTone(debt) === "danger" ? "danger" : "warning")}
      ${row("Ledger linked", "Origin movement", debt.ledger_linked ? "Yes" : "No", debt.ledger_linked ? "positive" : "warning")}
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
      button.classList.toggle("is-active", button.getAttribute("data-filter") === filter);
    });

    renderDebtList();
    renderDebug();
  }

  function ensureDebtControls() {
    if ($("debtSearchInput") && $("debtSortInput")) return;

    const filterRow = document.querySelector(".debt-filter-row");
    if (!filterRow) return;

    const controls = document.createElement("div");
    controls.className = "debt-list-controls";
    controls.innerHTML = `
      <input
        id="debtSearchInput"
        class="debt-mini-input"
        type="search"
        placeholder="Search debts, IDs, notes, ledger IDs"
        value="${esc(state.search)}"
      >
      <select id="debtSortInput" class="debt-mini-select">
        <option value="due">Sort: Due date</option>
        <option value="created">Sort: Created</option>
        <option value="amount">Sort: Amount</option>
        <option value="name">Sort: Name</option>
      </select>
    `;

    filterRow.insertAdjacentElement("afterend", controls);

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
      created_by: "web-debts-v0.7.0"
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
      <form class="debt-form">
        ${row("Amount", "Amount mutation is blocked here. Use reversal/re-entry for money correction.", money(debt.original_amount), "warning")}

        <div class="debt-form-grid">
          <div class="debt-field">
            <label for="editDueDateInput">Due Date</label>
            <input class="debt-input" id="editDueDateInput" type="date" value="${esc(debt.due_date || "")}" />
          </div>

          <div class="debt-field">
            <label for="editDueDayInput">Due Day</label>
            <input class="debt-input" id="editDueDayInput" type="number" min="1" max="31" value="${esc(debt.due_day || "")}" />
          </div>

          <div class="debt-field">
            <label for="editInstallmentInput">Installment Amount</label>
            <input class="debt-input" id="editInstallmentInput" type="number" step="0.01" min="0" value="${esc(debt.installment_amount || "")}" />
          </div>

          <div class="debt-field">
            <label for="editFrequencyInput">Frequency</label>
            <select class="debt-select" id="editFrequencyInput">
              ${["monthly", "weekly", "yearly", "custom"].map(f => `<option value="${f}" ${debt.frequency === f ? "selected" : ""}>${f}</option>`).join("")}
            </select>
          </div>

          <div class="debt-field debt-span-2">
            <label for="editNotesInput">Notes</label>
            <textarea class="debt-textarea" id="editNotesInput">${esc(debt.notes || "")}</textarea>
          </div>
        </div>

        <div class="debt-card-actions">
          <button class="debt-action primary" type="button" id="saveDebtEditBtn">Save Edit</button>
        </div>
      </form>
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
      setHTML("debtActionPanel", `<div class="debt-empty">Edit failed: ${esc(err.message)}</div>`);
    }
  }

  function openRepairPanel(id) {
    state.selectedDebtId = id;

    const debt = selectedDebt();
    if (!debt) return;

    renderSelectedDebt();
    renderAccountOptions();

    const copy = debt.kind === "owed"
      ? "Owed to me: choose the source account money left from. Backend writes an expense origin."
      : "I owe: choose the destination account money entered into. Backend writes an income origin.";

    setHTML("debtActionPanel", `
      <form class="debt-form">
        ${row("Debt", debt.id, `${esc(debt.name)} · ${money(debt.original_amount)}`)}
        ${row("Direction", "Repair rule", debt.kind === "owed" ? "expense" : "income", debt.kind === "owed" ? "danger" : "positive")}

        <div class="debt-field">
          <label for="repairAccountInput">Correct Account</label>
          <select class="debt-select" id="repairAccountInput">
            <option value="">Select account…</option>
          </select>
          <div class="debt-row-sub">${esc(copy)}</div>
        </div>

        <div class="debt-field">
          <label for="repairDateInput">Movement Date</label>
          <input class="debt-input" id="repairDateInput" type="date" value="${todayISO()}" />
        </div>

        <div class="debt-card-actions">
          <button class="debt-action" type="button" id="dryRunRepairBtn">Dry-run Repair</button>
          <button class="debt-action primary" type="button" id="commitRepairBtn">Commit Repair</button>
        </div>
      </form>
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

    const body = {
      action: "repair_ledger",
      debt_id: id,
      account_id: accountId,
      date: clean($("repairDateInput")?.value) || todayISO(),
      idempotency_key: buildClientKey(["repair_ledger", id, accountId, clean($("repairDateInput")?.value) || todayISO()]),
      created_by: "web-debts-v0.7.0"
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
      setHTML("debtActionPanel", `<div class="debt-empty">Repair failed: ${esc(err.message)}</div>`);
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
      created_by: "web-debts-v0.7.0"
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

    $("deferDebtIdInput").value = id;
    $("deferDueDateInput").value = debt.due_date || "";
    $("deferDueDayInput").value = debt.due_day || "";
    $("deferNotesInput").value = debt.notes || "";

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

  function injectStyles() {
    if ($("debt-compact-js-style")) return;

    const style = document.createElement("style");
    style.id = "debt-compact-js-style";
    style.textContent = `
      .debt-list-controls {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) 180px;
        gap: 10px;
        margin: -4px 0 14px;
      }

      .debt-mini-input,
      .debt-mini-select {
        width: 100%;
        border: 1px solid var(--sf-border);
        border-radius: 14px;
        background: var(--sf-surface-1);
        color: var(--sf-text);
        padding: 10px 12px;
        font: inherit;
        font-size: 13px;
        outline: none;
      }

      .debt-card.debt-compact-row {
        padding: 0;
        gap: 0;
      }

      .debt-row-shell {
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        display: grid;
        grid-template-columns: 34px minmax(220px, 1.6fr) minmax(100px, .6fr) 86px 112px 86px 20px;
        gap: 10px;
        align-items: center;
        padding: 10px 12px;
        text-align: left;
        cursor: pointer;
      }

      .debt-row-shell:hover {
        background: rgba(255,255,255,.035);
      }

      .debt-copy-block {
        min-width: 0;
      }

      .debt-row-kind,
      .debt-row-date,
      .debt-row-status {
        color: var(--sf-text-muted);
        font-size: 11px;
        font-weight: 850;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .debt-row-date {
        text-align: right;
      }

      .debt-row-status {
        justify-self: end;
        border: 1px solid var(--sf-border-subtle);
        border-radius: 999px;
        padding: 4px 8px;
        background: var(--sf-surface-2);
      }

      .debt-row-status.good {
        color: var(--sf-positive);
        border-color: rgba(83, 215, 167, .22);
      }

      .debt-row-status.warn {
        color: var(--sf-warning);
        border-color: rgba(241, 184, 87, .28);
      }

      .debt-row-status.danger {
        color: var(--sf-danger);
        border-color: rgba(255, 127, 138, .28);
      }

      .debt-expand-caret {
        color: var(--sf-text-muted);
        font-size: 13px;
        justify-self: end;
        transition: transform .18s ease;
      }

      .debt-card.is-open .debt-expand-caret {
        transform: rotate(180deg);
      }

      .debt-card.debt-compact-row .debt-progress {
        margin: 0 12px 9px 56px;
      }

      .debt-card.debt-compact-row .debt-tags,
      .debt-card.debt-compact-row .debt-blockers {
        padding: 0 12px 9px 56px;
      }

      .debt-inline-detail {
        display: none;
        border-top: 1px solid var(--sf-border-subtle);
        padding: 12px;
        gap: 10px;
        background: rgba(0,0,0,.12);
      }

      .debt-card.is-open .debt-inline-detail {
        display: grid;
      }

      .debt-inline-grid {
        display: grid;
        grid-template-columns: 150px minmax(0, 1fr);
        gap: 8px 14px;
        align-items: baseline;
      }

      .debt-inline-label {
        color: var(--sf-text-muted);
        font-size: 10px;
        letter-spacing: .08em;
        text-transform: uppercase;
        font-weight: 900;
      }

      .debt-inline-value {
        color: var(--sf-text);
        font-size: 12px;
        font-weight: 800;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .debt-inline-notes {
        border-top: 1px solid var(--sf-border-subtle);
        padding-top: 10px;
        display: grid;
        gap: 6px;
      }

      .debt-inline-note-text {
        color: var(--sf-text-muted);
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .debt-card-actions.inline {
        justify-content: flex-start;
        padding-top: 4px;
      }

      @media (max-width: 980px) {
        .debt-row-shell {
          grid-template-columns: 32px minmax(0, 1fr) 112px 20px;
        }

        .debt-row-kind,
        .debt-row-date,
        .debt-row-status {
          display: none;
        }

        .debt-card.debt-compact-row .debt-progress,
        .debt-card.debt-compact-row .debt-tags,
        .debt-card.debt-compact-row .debt-blockers {
          margin-left: 54px;
          padding-left: 0;
        }
      }

      @media (max-width: 640px) {
        .debt-list-controls {
          grid-template-columns: 1fr;
        }

        .debt-row-shell {
          grid-template-columns: 30px minmax(0, 1fr) 20px;
          gap: 8px;
        }

        .debt-amount {
          grid-column: 2;
          text-align: left;
          margin-top: -3px;
        }

        .debt-inline-grid {
          grid-template-columns: 1fr;
          gap: 4px;
        }

        .debt-card.debt-compact-row .debt-progress,
        .debt-card.debt-compact-row .debt-tags,
        .debt-card.debt-compact-row .debt-blockers {
          margin-left: 12px;
          padding-left: 0;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function init() {
    injectStyles();
    wireFilters();
    wireModalButtons();

    const movementDate = $("debtMovementDateInput");
    if (movementDate && !movementDate.value) movementDate.value = todayISO();

    loadDebts();

    window.SovereignDebts = {
      version: VERSION,
      canonical_route: API_DEBTS,
      reload: loadDebts,
      state: () => JSON.parse(JSON.stringify(state))
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
