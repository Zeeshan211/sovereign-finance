/* Sovereign Finance Debts v0.6.1
   Phase 4C: Command Centre debt.save soft block
   Contract:
   - Reads /api/debts only.
   - Does not call /api/money-contracts.
   - Keeps Debts page viewable.
   - Blocks debt.save when Command Centre says write safety is not ready or unknown.
   - Shows block reason, source, required fix, override policy, and backend/frontend status.
   - No D1 writes from enforcement.
   - No ledger tests.
*/
(function () {
  "use strict";

  const VERSION = "v0.6.1";
  const SAVE_ACTION = "debt.save";

  const state = {
    debts: [],
    filter: "active",
    saveGate: blockedGate("Command Centre enforcement has not loaded yet.", {
      source: "window.SovereignEnforcement",
      required_fix: "Wait for /api/finance-command-center to return an action policy for debt.save.",
      status: "unknown"
    })
  };

  const $ = id => document.getElementById(id);

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const n = Number(value || 0);
    return "Rs " + n.toLocaleString("en-PK", { maximumFractionDigits: 0 });
  }

  function todayStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function dateOnly(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  function nextDateFromDay(day) {
    const n = Number(day);
    if (!Number.isFinite(n) || n < 1) return null;
    const safe = Math.min(28, Math.max(1, Math.floor(n)));
    const now = todayStart();
    let d = new Date(now.getFullYear(), now.getMonth(), safe);
    if (d < now) d = new Date(now.getFullYear(), now.getMonth() + 1, safe);
    return dateOnly(d);
  }

  function daysUntil(dateValue) {
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return null;
    const a = todayStart();
    d.setHours(0, 0, 0, 0);
    return Math.ceil((d.getTime() - a.getTime()) / 86400000);
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, { cache: "no-store", ...(options || {}) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }
    return data;
  }

  function blockedGate(reason, extra) {
    const raw = (extra && extra.raw) || null;
    return {
      action: SAVE_ACTION,
      allowed: false,
      status: (extra && extra.status) || "blocked",
      label: (extra && extra.label) || "Blocked",
      reason: reason || "Debt save is blocked by Command Centre.",
      source: (extra && extra.source) || "enforcement.actions",
      required_fix: (extra && extra.required_fix) || "Resolve Command Centre blocker before saving debt changes.",
      override_allowed: Boolean(extra && extra.override_allowed),
      backend_enforced: Boolean(extra && extra.backend_enforced),
      frontend_enforced: true,
      raw
    };
  }

  function passGate(action) {
    return {
      action: SAVE_ACTION,
      allowed: true,
      status: String(action.status || "pass"),
      label: "Allowed",
      reason: action.reason || "Command Centre allows debt.save.",
      source: action.source || "enforcement.actions",
      required_fix: action.required_fix || "",
      override_allowed: Boolean(action.override_allowed),
      backend_enforced: Boolean(action.backend_enforced),
      frontend_enforced: true,
      raw: action
    };
  }

  function actionAllowsSave(action) {
    if (!action || typeof action !== "object") return false;
    const status = String(action.status || action.verdict || "").toLowerCase();
    const explicitAllowed =
      action.allowed === true ||
      action.action_allowed === true ||
      action.actions_allowed === true ||
      action.write_allowed === true ||
      action.can_execute === true;
    const explicitlyBlocked =
      action.blocked === true ||
      action.allowed === false ||
      action.action_allowed === false ||
      action.actions_allowed === false ||
      action.write_allowed === false ||
      ["blocked", "unknown", "unready", "not_ready", "fail", "failed", "deny", "denied"].includes(status);
    if (explicitlyBlocked) return false;
    if (explicitAllowed && ["", "pass", "ready", "allowed", "ok"].includes(status)) return true;
    return false;
  }

  function updateSaveGate(snapshot) {
    if (!snapshot) {
      state.saveGate = blockedGate("Command Centre enforcement snapshot is unavailable.", {
        source: "window.SovereignEnforcement",
        required_fix: "Load /js/enforcement.js and /api/finance-command-center.",
        status: "unknown"
      });
      return;
    }

    if (snapshot.error) {
      state.saveGate = blockedGate("Command Centre enforcement failed to load: " + snapshot.error, {
        source: "/api/finance-command-center",
        required_fix: "Open Command Centre and resolve backend enforcement endpoint availability.",
        status: "unknown"
      });
      return;
    }

    if (!snapshot.loaded) {
      state.saveGate = blockedGate("Command Centre enforcement is still loading.", {
        source: "/api/finance-command-center",
        required_fix: "Wait for enforcement policy to load. Unknown never becomes Ready.",
        status: "unknown"
      });
      return;
    }

    const action = typeof snapshot.findAction === "function"
      ? snapshot.findAction(SAVE_ACTION)
      : null;

    if (!action) {
      state.saveGate = blockedGate("No backend action policy returned for debt.save.", {
        source: "enforcement.actions",
        required_fix: "Register debt.save in /api/finance-command-center enforcement.actions.",
        status: "unknown"
      });
      return;
    }

    if (actionAllowsSave(action)) {
      state.saveGate = passGate(action);
      return;
    }

    state.saveGate = blockedGate(action.reason || "Command Centre blocks debt.save.", {
      source: action.source || "enforcement.actions",
      required_fix: action.required_fix || "Resolve debt.save blocker in Command Centre.",
      override_allowed: action.override_allowed,
      backend_enforced: action.backend_enforced,
      status: action.status || "blocked",
      label: action.label || "Blocked",
      raw: action
    });
  }

  function normalizeDebt(row) {
    const original = Number(
      row.original_amount ??
      row.amount ??
      row.principal_amount ??
      0
    );

    const paid = Number(
      row.paid_amount ??
      row.amount_paid ??
      0
    );

    const remaining = Number(
      row.remaining_amount ??
      row.remaining ??
      Math.max(0, original - paid)
    );

    const dueDate =
      dateOnly(row.next_due_date) ||
      dateOnly(row.installment_due_date) ||
      dateOnly(row.due_date) ||
      nextDateFromDay(row.due_day);

    const installment = Number(
      row.installment_amount ??
      row.monthly_payment ??
      row.minimum_payment ??
      0
    );

    const status = debtStatus(row, remaining, dueDate);
    const days = dueDate ? daysUntil(dueDate) : null;
    const kind = String(row.kind || "owe").toLowerCase();

    const blockers = [];
    if (status !== "closed") {
      if (!dueDate) blockers.push("missing_due_date");
      if (remaining > 0 && installment <= 0) blockers.push("missing_installment");
    }

    return {
      id: row.id,
      name: row.name || row.title || row.label || row.id,
      kind,
      original_amount: original,
      paid_amount: paid,
      remaining_amount: remaining,
      installment_amount: installment,
      next_due_date: dueDate,
      days_until_due: days,
      status,
      raw_status: row.status || "active",
      snowball_order: row.snowball_order ?? null,
      blockers,
      raw: row
    };
  }

  function debtStatus(row, remaining, dueDate) {
    const status = String(row.status || "").toLowerCase();
    if (status === "closed" || status === "deleted" || status === "paid" || remaining <= 0) return "closed";

    const days = dueDate ? daysUntil(dueDate) : null;
    if (days === null) return "missing";
    if (days < 0) return "overdue";
    if (days === 0) return "today";
    if (days <= 7) return "soon";
    return "active";
  }

  async function load() {
    setLoading();
    const raw = await fetchJson("/api/debts").catch(err => {
      throw new Error("Debts API failed: " + err.message);
    });

    const rows = raw.debts || raw.rows || raw.items || raw.data || [];
    state.debts = rows
      .map(normalizeDebt)
      .sort(sortDebts);

    render();
  }

  function sortDebts(a, b) {
    const rank = {
      overdue: 0,
      today: 1,
      soon: 2,
      missing: 3,
      active: 4,
      closed: 5
    };

    const ar = rank[a.status] ?? 9;
    const br = rank[b.status] ?? 9;
    if (ar !== br) return ar - br;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.days_until_due === null && b.days_until_due === null) return b.remaining_amount - a.remaining_amount;
    if (a.days_until_due === null) return 1;
    if (b.days_until_due === null) return -1;
    return a.days_until_due - b.days_until_due;
  }

  function visibleDebts() {
    if (state.filter === "all") return state.debts;
    if (state.filter === "owe") return state.debts.filter(d => d.kind === "owe" && d.status !== "closed");
    if (state.filter === "owed") return state.debts.filter(d => d.kind === "owed" && d.status !== "closed");
    if (state.filter === "attention") {
      return state.debts.filter(d =>
        d.status !== "closed" &&
        (d.blockers.length || ["overdue", "today", "soon"].includes(d.status))
      );
    }
    if (state.filter === "closed") return state.debts.filter(d => d.status === "closed");
    return state.debts.filter(d => d.status !== "closed");
  }

  function renderStats() {
    const active = state.debts.filter(d => d.status !== "closed");
    const owe = active
      .filter(d => d.kind === "owe")
      .reduce((sum, d) => sum + d.remaining_amount, 0);
    const owed = active
      .filter(d => d.kind === "owed")
      .reduce((sum, d) => sum + d.remaining_amount, 0);
    const attention = active.filter(d =>
      d.blockers.length || ["overdue", "today", "soon"].includes(d.status)
    );

    $("debtStatActive").textContent = String(active.length);
    $("debtStatOwe").textContent = money(owe);
    $("debtStatOwed").textContent = money(owed);
    $("debtStatAttention").textContent = String(attention.length);
  }

  function renderAuthority() {
    const box = $("debtAuthority");
    const pill = $("debtAuthorityPill");
    const copy = $("debtAuthorityCopy");
    if (!box || !pill || !copy) return;

    const gate = state.saveGate;
    box.className = "debt-authority " + (gate.allowed ? "pass" : gate.status === "unknown" ? "unknown" : "blocked");
    pill.textContent = gate.allowed ? "Save allowed" : "Save blocked";
    copy.textContent = gate.allowed
      ? `${gate.reason || "Command Centre allows debt.save."} Source: ${gate.source || "enforcement.actions"}.`
      : `${gate.reason || "Debt save is blocked."} Source: ${gate.source || "enforcement.actions"}. Required fix: ${gate.required_fix || "Resolve blocker in Command Centre."} Override: ${gate.override_allowed ? "allowed" : "not allowed"}. Backend enforced: ${gate.backend_enforced ? "yes" : "no"} · Frontend enforced: yes.`;
  }

  function dueCopy(debt) {
    if (debt.status === "closed") return "Closed";
    if (!debt.next_due_date) return "No due date";
    if (debt.days_until_due < 0) return `${Math.abs(debt.days_until_due)} days overdue`;
    if (debt.days_until_due === 0) return "Due today";
    if (debt.days_until_due === 1) return "Due tomorrow";
    return `Due in ${debt.days_until_due} days`;
  }

  function kindCopy(kind) {
    return kind === "owed" ? "They owe me" : "I owe";
  }

  function statusLabel(status) {
    return {
      overdue: "Overdue",
      today: "Due today",
      soon: "Due soon",
      missing: "Missing setup",
      active: "Scheduled",
      closed: "Closed"
    }[status] || "Unknown";
  }

  function blockHtml(debt) {
    if (debt.status === "closed" || state.saveGate.allowed) return "";
    const gate = state.saveGate;
    return `
      <div class="debt-save-block">
        <div><strong>Save blocked by Command Centre.</strong></div>
        <div>Blocked: ${esc(gate.action)}</div>
        <div>Reason: ${esc(gate.reason)}</div>
        <div>Source: ${esc(gate.source)}</div>
        <div>Required fix: ${esc(gate.required_fix)}</div>
        <div>Override: ${gate.override_allowed ? "allowed" : "not allowed"} · Backend enforced: ${gate.backend_enforced ? "yes" : "no"} · Frontend enforced: yes</div>
      </div>
    `;
  }

  function renderDebt(debt) {
    const pct = debt.original_amount > 0
      ? Math.max(0, Math.min(100, Math.round((debt.paid_amount / debt.original_amount) * 100)))
      : 0;

    const blockerHtml = debt.blockers.length
      ? `<div class="debt-blockers">${debt.blockers.map(b => `<span>${esc(b.replace(/_/g, " "))}</span>`).join("")}</div>`
      : "";

    const closed = debt.status === "closed";
    const saveBlocked = !closed && !state.saveGate.allowed;
    const disabled = closed || saveBlocked;

    return `
      <article class="debt-card ${esc(debt.status)} ${esc(debt.kind)}" data-debt-id="${esc(debt.id)}">
        <div class="debt-main">
          <div class="debt-left">
            <div class="debt-kind-pill ${esc(debt.kind)}">${esc(kindCopy(debt.kind))}</div>
            <div class="debt-name">${esc(debt.name)}</div>
            <div class="debt-meta">
              ${esc(statusLabel(debt.status))} · ${esc(dueCopy(debt))} · ${esc(debt.raw_status)}
            </div>
          </div>
          <div class="debt-money">
            <div class="debt-remaining">${money(debt.remaining_amount)}</div>
            <div class="debt-sub">remaining</div>
          </div>
        </div>

        <div class="debt-progress">
          <div class="debt-progress-bar" style="width:${pct}%"></div>
        </div>

        <div class="debt-split">
          <span>Original: ${money(debt.original_amount)}</span>
          <span>Paid: ${money(debt.paid_amount)}</span>
          <span>${pct}% cleared</span>
        </div>

        ${blockerHtml}
        ${blockHtml(debt)}

        <div class="debt-config">
          <label>
            Next due date
            <input type="date" data-due-date="${esc(debt.id)}" value="${esc(debt.next_due_date || "")}" ${closed ? "disabled" : ""} />
          </label>
          <label>
            Installment
            <input type="number" min="0" step="1" data-installment="${esc(debt.id)}" value="${esc(debt.installment_amount || "")}" placeholder="0" ${closed ? "disabled" : ""} />
          </label>
          <button class="debt-save" type="button" data-save="${esc(debt.id)}" ${disabled ? "disabled" : ""}>
            ${closed ? "Closed" : saveBlocked ? "Blocked" : "Save"}
          </button>
        </div>

        <div class="debt-foot">
          <span>ID: ${esc(debt.id)}</span>
          <span>Snowball: ${esc(debt.snowball_order ?? "N/A")}</span>
        </div>
      </article>
    `;
  }

  function render() {
    renderAuthority();
    renderStats();

    document.querySelectorAll(".debt-filter").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === state.filter);
    });

    const rows = visibleDebts();
    const list = $("debtsList");

    if (!rows.length) {
      list.innerHTML = `<div class="debt-empty">No debts in this view.</div>`;
      return;
    }

    list.innerHTML = rows.map(renderDebt).join("");

    list.querySelectorAll("[data-save]").forEach(btn => {
      btn.addEventListener("click", () => saveDebt(btn.dataset.save));
    });

    if (window.SovereignNav && typeof window.SovereignNav.scheduleOverflowCheck === "function") {
      window.SovereignNav.scheduleOverflowCheck();
    }
  }

  function setLoading() {
    $("debtsList").innerHTML = `<div class="debt-empty">Loading debts...</div>`;
  }

  function toast(message, type) {
    const el = $("toast");
    if (!el) return;
    el.textContent = message;
    el.className = "toast toast-" + (type || "success") + " show";
    setTimeout(() => {
      el.className = "toast";
    }, 2600);
  }

  async function saveDebt(id) {
    if (!state.saveGate.allowed) {
      toast("Save blocked by Command Centre: " + state.saveGate.reason, "error");
      render();
      return;
    }

    const card = document.querySelector(`[data-debt-id="${CSS.escape(id)}"]`);
    if (!card) return;

    const dueDate = card.querySelector("[data-due-date]")?.value || "";
    const installment = Number(card.querySelector("[data-installment]")?.value || 0);

    if (!dueDate) {
      toast("Select a due date first.", "error");
      return;
    }

    const btn = card.querySelector("[data-save]");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }

    const payload = {
      due_date: dueDate,
      next_due_date: dueDate,
      installment_amount: installment,
      updated_by: "web-debts-v0.6.1"
    };

    try {
      await fetchJson(`/api/debts/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      toast("Debt config saved.", "success");
      await load();
    } catch (err) {
      toast("Save failed: " + err.message, "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Save";
      }
    }
  }

  function wireFilters() {
    document.querySelectorAll(".debt-filter").forEach(btn => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter || "active";
        render();
      });
    });

    $("reloadDebts").addEventListener("click", () => {
      load()
        .then(() => toast("Debts refreshed.", "success"))
        .catch(err => toast(err.message, "error"));
    });
  }

  function wireEnforcement() {
    if (window.SovereignEnforcement && typeof window.SovereignEnforcement.subscribe === "function") {
      window.SovereignEnforcement.subscribe(snapshot => {
        updateSaveGate(snapshot);
        render();
      });

      updateSaveGate(window.SovereignEnforcement.snapshot());
      render();
      return;
    }

    updateSaveGate(null);
    render();
  }

  function boot() {
    wireFilters();
    wireEnforcement();

    load().catch(err => {
      $("debtsList").innerHTML = `<div class="debt-empty">Debts failed: ${esc(err.message)}</div>`;
      renderAuthority();
    });
  }

  window.SovereignDebts = {
    version: VERSION,
    reload: load,
    state,
    enforcement() {
      return {
        saveGate: state.saveGate
      };
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
