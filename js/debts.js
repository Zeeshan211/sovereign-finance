/* Sovereign Finance Debts v0.6.0
   Ship 3: Debts closeout

   Contract:
   - Reads /api/money-contracts for normalized debt truth.
   - Reads /api/debts for raw due_day/installment fallback.
   - Separates active owed/owe/closed.
   - Closed debts do not count as missing due-date blockers.
   - Shows next due date, days until due, overdue, installment amount.
   - Attempts PUT save only when operator edits due/installment.
   - No payment simulation.
*/

(function () {
  "use strict";

  const VERSION = "v0.6.0";

  const state = {
    debts: [],
    rawDebts: [],
    filter: "active"
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
    return "Rs " + n.toLocaleString("en-PK", {
      maximumFractionDigits: 0
    });
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
    const res = await fetch(url, {
      cache: "no-store",
      ...(options || {})
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }

    return data;
  }

  function rawById(id) {
    return state.rawDebts.find(d => String(d.id) === String(id)) || {};
  }

  function debtStatus(row, remaining, dueDate) {
    const status = String(row.status || "").toLowerCase();

    if (status === "closed" || status === "deleted" || remaining <= 0) return "closed";

    const days = dueDate ? daysUntil(dueDate) : null;

    if (days === null) return "missing";
    if (days < 0) return "overdue";
    if (days === 0) return "today";
    if (days <= 7) return "soon";

    return "active";
  }

  function normalizeDebt(row) {
    const raw = rawById(row.id);

    const remaining = Number(
      row.remaining_amount ??
      raw.remaining_amount ??
      raw.remaining ??
      Math.max(0, Number(raw.original_amount || row.original_amount || 0) - Number(raw.paid_amount || row.paid_amount || 0))
    );

    const dueDate =
      row.next_due_date ||
      dateOnly(raw.next_due_date) ||
      dateOnly(raw.installment_due_date) ||
      dateOnly(raw.due_date) ||
      nextDateFromDay(raw.due_day);

    const installment = Number(
      row.installment_amount ??
      raw.installment_amount ??
      raw.monthly_payment ??
      raw.minimum_payment ??
      0
    );

    const status = debtStatus({ ...raw, ...row }, remaining, dueDate);
    const days = dueDate ? daysUntil(dueDate) : null;
    const kind = String(row.kind || raw.kind || "owe").toLowerCase();

    const blockers = [];

    if (status !== "closed") {
      if (!dueDate) blockers.push("missing_due_date");
      if (remaining > 0 && installment <= 0) blockers.push("missing_installment");
    }

    return {
      id: row.id,
      name: row.name || raw.name || row.id,
      kind,
      original_amount: Number(row.original_amount ?? raw.original_amount ?? row.amount ?? raw.amount ?? 0),
      paid_amount: Number(row.paid_amount ?? raw.paid_amount ?? 0),
      remaining_amount: remaining,
      installment_amount: installment,
      next_due_date: dueDate,
      days_until_due: days,
      status,
      raw_status: row.status || raw.status || "active",
      snowball_order: row.snowball_order ?? raw.snowball_order ?? null,
      blockers
    };
  }

  async function load() {
    setLoading();

    const [contracts, raw] = await Promise.all([
      fetchJson("/api/money-contracts"),
      fetchJson("/api/debts").catch(() => ({ debts: [] }))
    ]);

    state.rawDebts = raw.debts || raw.rows || raw.items || [];

    state.debts =
      ((((contracts.contracts || {}).debts || {}).rows || [])
        .map(normalizeDebt)
        .sort(sortDebts));

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
    if (state.filter === "attention") return state.debts.filter(d => d.status !== "closed" && (d.blockers.length || ["overdue", "today", "soon"].includes(d.status)));
    if (state.filter === "closed") return state.debts.filter(d => d.status === "closed");
    return state.debts.filter(d => d.status !== "closed");
  }

  function renderStats() {
    const active = state.debts.filter(d => d.status !== "closed");
    const owe = active.filter(d => d.kind === "owe").reduce((sum, d) => sum + d.remaining_amount, 0);
    const owed = active.filter(d => d.kind === "owed").reduce((sum, d) => sum + d.remaining_amount, 0);
    const attention = active.filter(d => d.blockers.length || ["overdue", "today", "soon"].includes(d.status));

    $("debtStatActive").textContent = String(active.length);
    $("debtStatOwe").textContent = money(owe);
    $("debtStatOwed").textContent = money(owed);
    $("debtStatAttention").textContent = String(attention.length);
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

  function renderDebt(debt) {
    const pct = debt.original_amount > 0
      ? Math.max(0, Math.min(100, Math.round((debt.paid_amount / debt.original_amount) * 100)))
      : 0;

    const blockerHtml = debt.blockers.length
      ? `<div class="debt-blockers">${debt.blockers.map(b => `<span>${esc(b.replace(/_/g, " "))}</span>`).join("")}</div>`
      : "";

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

        <div class="debt-config">
          <label>
            Next due date
            <input type="date" data-due-date="${esc(debt.id)}" value="${esc(debt.next_due_date || "")}" ${debt.status === "closed" ? "disabled" : ""} />
          </label>

          <label>
            Installment
            <input type="number" min="0" step="1" data-installment="${esc(debt.id)}" value="${esc(debt.installment_amount || "")}" placeholder="0" ${debt.status === "closed" ? "disabled" : ""} />
          </label>

          <button class="debt-save" type="button" data-save="${esc(debt.id)}" ${debt.status === "closed" ? "disabled" : ""}>
            Save
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
      updated_by: "web-debts-v0.6.0"
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

  function wire() {
    document.querySelectorAll(".debt-filter").forEach(btn => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter || "active";
        render();
      });
    });

    $("reloadDebts").addEventListener("click", () => {
      load().then(() => toast("Debts refreshed.", "success")).catch(err => toast(err.message, "error"));
    });
  }

  window.SovereignDebts = {
    version: VERSION,
    reload: load,
    state
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      wire();
      load().catch(err => {
        $("debtsList").innerHTML = `<div class="debt-empty">Debts failed: ${esc(err.message)}</div>`;
      });
    });
  } else {
    wire();
    load().catch(err => {
      $("debtsList").innerHTML = `<div class="debt-empty">Debts failed: ${esc(err.message)}</div>`;
    });
  }
})();
