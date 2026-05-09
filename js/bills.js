/* Sovereign Finance Bills v0.5.0
   Ship 3: Bills closeout

   Contract:
   - Reads /api/money-contracts for normalized backend truth.
   - Reads /api/bills for raw due_day/default_account_id fallback.
   - Shows active vs archived/deleted bills clearly.
   - Computes next due date from due_date or due_day.
   - Exposes payment account selector.
   - Attempts PUT save only when operator changes config.
   - No fake payments.
   - No ledger pollution.
*/

(function () {
  "use strict";

  const VERSION = "v0.5.0";

  const state = {
    bills: [],
    rawBills: [],
    accounts: [],
    filter: "active",
    saving: null
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

  function statusFromDays(days, status) {
    const s = String(status || "").toLowerCase();

    if (s === "deleted" || s === "archived" || s === "inactive") return "archived";
    if (s === "paid") return "paid";
    if (days === null) return "unknown";
    if (days < 0) return "overdue";
    if (days === 0) return "today";
    if (days <= 7) return "soon";

    return "scheduled";
  }

  function statusLabel(status) {
    return {
      archived: "Archived",
      paid: "Paid",
      overdue: "Overdue",
      today: "Due today",
      soon: "Due soon",
      scheduled: "Scheduled",
      unknown: "Missing due date"
    }[status] || "Unknown";
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
    return state.rawBills.find(b => String(b.id) === String(id)) || {};
  }

  function accountName(id) {
    if (!id) return "No payment account";
    const found = state.accounts.find(a => String(a.id) === String(id));
    return found ? found.name : id;
  }

  function normalizeBill(row) {
    const raw = rawById(row.id);
    const dueDate = row.due_date || dateOnly(raw.due_date) || dateOnly(raw.next_due_date) || nextDateFromDay(raw.due_day);
    const days = dueDate ? daysUntil(dueDate) : null;

    const paymentAccount =
      row.payment_account_id ||
      raw.payment_account_id ||
      raw.default_account_id ||
      raw.last_paid_account_id ||
      "";

    const status = statusFromDays(days, row.status || raw.status);

    return {
      id: row.id,
      name: row.name || raw.name || row.id,
      amount: Number(row.amount || raw.amount || 0),
      due_date: dueDate,
      due_day: raw.due_day || null,
      days_until_due: days,
      status,
      raw_status: row.status || raw.status || "unknown",
      cadence: row.cadence || raw.frequency || raw.cadence || "monthly",
      payment_account_id: paymentAccount,
      payment_account_name: paymentAccount ? accountName(paymentAccount) : null,
      blockers: [
        !dueDate && status !== "archived" ? "missing_due_date" : null,
        !paymentAccount && status !== "archived" ? "missing_payment_account" : null
      ].filter(Boolean)
    };
  }

  async function load() {
    setLoading();

    const [contracts, raw] = await Promise.all([
      fetchJson("/api/money-contracts"),
      fetchJson("/api/bills").catch(() => ({ bills: [] }))
    ]);

    state.accounts =
      (((contracts.contracts || {}).accounts || {}).payment_account_options || [])
        .filter(a => a && a.id);

    state.rawBills = raw.bills || raw.rows || raw.items || [];

    state.bills =
      ((((contracts.contracts || {}).bills || {}).rows || [])
        .map(normalizeBill)
        .sort(sortBills));

    render();
  }

  function sortBills(a, b) {
    const rank = {
      overdue: 0,
      today: 1,
      soon: 2,
      scheduled: 3,
      unknown: 4,
      paid: 5,
      archived: 6
    };

    const ar = rank[a.status] ?? 9;
    const br = rank[b.status] ?? 9;

    if (ar !== br) return ar - br;

    if (a.days_until_due === null && b.days_until_due === null) return a.name.localeCompare(b.name);
    if (a.days_until_due === null) return 1;
    if (b.days_until_due === null) return -1;

    return a.days_until_due - b.days_until_due;
  }

  function visibleBills() {
    if (state.filter === "all") return state.bills;
    if (state.filter === "attention") return state.bills.filter(b => b.status === "overdue" || b.status === "today" || b.status === "soon" || b.blockers.length);
    if (state.filter === "archived") return state.bills.filter(b => b.status === "archived" || b.status === "paid");
    return state.bills.filter(b => b.status !== "archived" && b.status !== "paid");
  }

  function renderStats() {
    const active = state.bills.filter(b => b.status !== "archived" && b.status !== "paid");
    const attention = state.bills.filter(b => b.status === "overdue" || b.status === "today" || b.status === "soon" || b.blockers.length);
    const missingAccount = state.bills.filter(b => b.blockers.includes("missing_payment_account"));
    const missingDue = state.bills.filter(b => b.blockers.includes("missing_due_date"));
    const monthly = active.reduce((sum, b) => sum + Number(b.amount || 0), 0);

    $("billStatActive").textContent = String(active.length);
    $("billStatAttention").textContent = String(attention.length);
    $("billStatMonthly").textContent = money(monthly);
    $("billStatMissing").textContent = `${missingAccount.length} acct · ${missingDue.length} due`;
  }

  function dueCopy(bill) {
    if (!bill.due_date) return "No due date";

    if (bill.days_until_due < 0) return `${Math.abs(bill.days_until_due)} days overdue`;
    if (bill.days_until_due === 0) return "Due today";
    if (bill.days_until_due === 1) return "Due tomorrow";

    return `Due in ${bill.days_until_due} days`;
  }

  function accountOptions(selected) {
    const base = [`<option value="">Select payment account...</option>`];

    state.accounts.forEach(account => {
      base.push(`
        <option value="${esc(account.id)}" ${String(account.id) === String(selected) ? "selected" : ""}>
          ${esc(account.name)}${account.kind ? " · " + esc(account.kind) : ""}
        </option>
      `);
    });

    return base.join("");
  }

  function renderBill(bill) {
    const blockerHtml = bill.blockers.length
      ? `<div class="bill-blockers">${bill.blockers.map(b => `<span>${esc(b.replace(/_/g, " "))}</span>`).join("")}</div>`
      : "";

    const dueInputValue = bill.due_date || "";

    return `
      <article class="bill-card ${esc(bill.status)}" data-bill-id="${esc(bill.id)}">
        <div class="bill-main">
          <div class="bill-left">
            <div class="bill-status-dot"></div>
            <div class="bill-info">
              <div class="bill-name">${esc(bill.name)}</div>
              <div class="bill-meta">
                ${esc(statusLabel(bill.status))} · ${esc(dueCopy(bill))} · ${esc(bill.cadence)}
              </div>
            </div>
          </div>

          <div class="bill-amount">${money(bill.amount)}</div>
        </div>

        ${blockerHtml}

        <div class="bill-config">
          <label>
            Payment account
            <select data-payment-account="${esc(bill.id)}" ${bill.status === "archived" ? "disabled" : ""}>
              ${accountOptions(bill.payment_account_id)}
            </select>
          </label>

          <label>
            Next due date
            <input type="date" data-due-date="${esc(bill.id)}" value="${esc(dueInputValue)}" ${bill.status === "archived" ? "disabled" : ""} />
          </label>

          <button class="bill-save" type="button" data-save="${esc(bill.id)}" ${bill.status === "archived" ? "disabled" : ""}>
            Save
          </button>
        </div>

        <div class="bill-foot">
          <span>ID: ${esc(bill.id)}</span>
          <span>Pay from: ${esc(bill.payment_account_name || "Not set")}</span>
        </div>
      </article>
    `;
  }

  function render() {
    renderStats();

    document.querySelectorAll(".bill-filter").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === state.filter);
    });

    const rows = visibleBills();
    const list = $("billsList");

    if (!rows.length) {
      list.innerHTML = `<div class="bill-empty">No bills in this view.</div>`;
      return;
    }

    list.innerHTML = rows.map(renderBill).join("");

    list.querySelectorAll("[data-save]").forEach(btn => {
      btn.addEventListener("click", () => saveBill(btn.dataset.save));
    });

    if (window.SovereignNav && typeof window.SovereignNav.scheduleOverflowCheck === "function") {
      window.SovereignNav.scheduleOverflowCheck();
    }
  }

  function setLoading() {
    $("billsList").innerHTML = `<div class="bill-empty">Loading bills...</div>`;
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

  async function saveBill(id) {
    if (!id) return;

    const card = document.querySelector(`[data-bill-id="${CSS.escape(id)}"]`);
    if (!card) return;

    const account = card.querySelector("[data-payment-account]")?.value || "";
    const dueDate = card.querySelector("[data-due-date]")?.value || "";

    if (!account) {
      toast("Select a payment account first.", "error");
      return;
    }

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
      payment_account_id: account,
      default_account_id: account,
      due_date: dueDate,
      next_due_date: dueDate,
      updated_by: "web-bills-v0.5.0"
    };

    try {
      await fetchJson(`/api/bills/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      toast("Bill config saved.", "success");
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
    document.querySelectorAll(".bill-filter").forEach(btn => {
      btn.addEventListener("click", () => {
        state.filter = btn.dataset.filter || "active";
        render();
      });
    });

    $("reloadBills").addEventListener("click", () => {
      load().then(() => toast("Bills refreshed.", "success")).catch(err => toast(err.message, "error"));
    });
  }

  window.SovereignBills = {
    version: VERSION,
    reload: load,
    state
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      wire();
      load().catch(err => {
        $("billsList").innerHTML = `<div class="bill-empty">Bills failed: ${esc(err.message)}</div>`;
      });
    });
  } else {
    wire();
    load().catch(err => {
      $("billsList").innerHTML = `<div class="bill-empty">Bills failed: ${esc(err.message)}</div>`;
    });
  }
})();
