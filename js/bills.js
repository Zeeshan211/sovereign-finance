/* Sovereign Finance Bills v0.5.1
   Ship 5: Bills truth stabilizer

   Contract:
   - Reads /api/money-contracts v0.1.2.
   - Shows current-month paid state.
   - Save uses backend-safe bill fields only.
   - No fake payments.
*/

(function () {
  "use strict";

  const VERSION = "v0.5.1";

  const state = {
    bills: [],
    rawBills: [],
    accounts: [],
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
    return "Rs " + n.toLocaleString("en-PK", { maximumFractionDigits: 0 });
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, { cache: "no-store", ...(options || {}) });
    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ("HTTP " + res.status));
    }

    return data;
  }

  function statusLabel(bill) {
    if (bill.display_status === "paid_current_month" || bill.current_month_paid) return "Paid this month";
    if (bill.display_status === "deleted" || bill.status === "deleted") return "Archived";
    if (bill.display_status === "closed" || bill.status === "closed") return "Closed";
    if (bill.days_until_due === null) return "Missing due date";
    if (bill.days_until_due < 0) return "Overdue";
    if (bill.days_until_due === 0) return "Due today";
    if (bill.days_until_due <= 7) return "Due soon";
    return "Scheduled";
  }

  function visualStatus(bill) {
    if (bill.display_status === "paid_current_month" || bill.current_month_paid) return "paid-current";
    if (bill.status === "deleted" || bill.status === "closed") return "archived";
    if (bill.days_until_due === null) return "unknown";
    if (bill.days_until_due < 0) return "overdue";
    if (bill.days_until_due === 0) return "today";
    if (bill.days_until_due <= 7) return "soon";
    return "scheduled";
  }

  function dueCopy(bill) {
    if (bill.current_month_paid) return `Clear for this month${bill.last_paid_date ? " · paid " + bill.last_paid_date : ""}`;
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

  function visibleBills() {
    if (state.filter === "all") return state.bills;
    if (state.filter === "attention") {
      return state.bills.filter(b =>
        b.status !== "deleted" &&
        !b.current_month_paid &&
        (b.blockers.length || b.days_until_due === null || b.days_until_due <= 7)
      );
    }
    if (state.filter === "archived") return state.bills.filter(b => b.status === "deleted" || b.status === "closed");
    return state.bills.filter(b => b.status !== "deleted" && b.status !== "closed");
  }

  async function load() {
    $("billsList").innerHTML = `<div class="bill-empty">Loading bills...</div>`;

    const contracts = await fetchJson("/api/money-contracts");
    const raw = await fetchJson("/api/bills").catch(() => ({ bills: [] }));

    state.accounts = ((((contracts.contracts || {}).accounts || {}).payment_account_options || [])).filter(a => a && a.id);
    state.bills = ((((contracts.contracts || {}).bills || {}).rows || [])).sort(sortBills);
    state.rawBills = raw.bills || raw.rows || raw.items || [];

    render();
  }

  function sortBills(a, b) {
    const rank = {
      overdue: 0,
      today: 1,
      soon: 2,
      unknown: 3,
      scheduled: 4,
      "paid-current": 5,
      archived: 6
    };

    const ar = rank[visualStatus(a)] ?? 9;
    const br = rank[visualStatus(b)] ?? 9;
    if (ar !== br) return ar - br;

    if (a.days_until_due === null && b.days_until_due === null) return String(a.name).localeCompare(String(b.name));
    if (a.days_until_due === null) return 1;
    if (b.days_until_due === null) return -1;
    return a.days_until_due - b.days_until_due;
  }

  function renderStats() {
    const active = state.bills.filter(b => b.status !== "deleted" && b.status !== "closed");
    const attention = state.bills.filter(b => b.status !== "deleted" && !b.current_month_paid && (b.blockers.length || b.days_until_due === null || b.days_until_due <= 7));
    const monthly = active.reduce((sum, b) => sum + Number(b.amount || 0), 0);
    const missingAccount = active.filter(b => b.blockers.includes("missing_payment_account_id"));
    const missingDue = active.filter(b => b.blockers.includes("missing_due_date"));

    $("billStatActive").textContent = String(active.length);
    $("billStatAttention").textContent = String(attention.length);
    $("billStatMonthly").textContent = money(monthly);
    $("billStatMissing").textContent = `${missingAccount.length} acct · ${missingDue.length} due`;
  }

  function renderBill(bill) {
    const cls = visualStatus(bill);
    const blockerHtml = bill.blockers && bill.blockers.length
      ? `<div class="bill-blockers">${bill.blockers.map(b => `<span>${esc(b.replace(/_/g, " "))}</span>`).join("")}</div>`
      : "";

    const archived = bill.status === "deleted" || bill.status === "closed";

    return `
      <article class="bill-card ${esc(cls)}" data-bill-id="${esc(bill.id)}">
        <div class="bill-main">
          <div class="bill-left">
            <div class="bill-status-dot"></div>
            <div class="bill-info">
              <div class="bill-name">${esc(bill.name)}</div>
              <div class="bill-meta">${esc(statusLabel(bill))} · ${esc(dueCopy(bill))} · ${esc(bill.cadence || "monthly")}</div>
            </div>
          </div>
          <div class="bill-amount">${money(bill.amount)}</div>
        </div>

        ${blockerHtml}

        <div class="bill-config">
          <label>
            Payment account
            <select data-payment-account="${esc(bill.id)}" ${archived ? "disabled" : ""}>
              ${accountOptions(bill.payment_account_id)}
            </select>
          </label>

          <label>
            Due day
            <input type="number" min="1" max="28" data-due-day="${esc(bill.id)}" value="${esc(bill.due_day || "")}" ${archived ? "disabled" : ""} />
          </label>

          <button class="bill-save" type="button" data-save="${esc(bill.id)}" ${archived ? "disabled" : ""}>Save</button>
        </div>

        <div class="bill-foot">
          <span>ID: ${esc(bill.id)}</span>
          <span>Pay from: ${esc(bill.payment_account_name || "Not set")}</span>
          ${bill.current_month_paid ? `<span>Current month clear</span>` : ""}
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

  function toast(message, type) {
    const el = $("toast");
    if (!el) return;
    el.textContent = message;
    el.className = "toast toast-" + (type || "success") + " show";
    setTimeout(() => { el.className = "toast"; }, 2600);
  }

  async function saveBill(id) {
    const card = document.querySelector(`[data-bill-id="${CSS.escape(id)}"]`);
    if (!card) return;

    const account = card.querySelector("[data-payment-account]")?.value || "";
    const dueDay = Number(card.querySelector("[data-due-day]")?.value || 0);

    if (!account) return toast("Select a payment account first.", "error");
    if (!dueDay || dueDay < 1 || dueDay > 28) return toast("Due day must be 1-28.", "error");

    const btn = card.querySelector("[data-save]");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }

    try {
      await fetchJson(`/api/bills/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default_account_id: account,
          payment_account_id: account,
          due_day: dueDay,
          frequency: "monthly",
          updated_by: "web-bills-v0.5.1"
        })
      });

      toast("Bill saved.", "success");
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

  window.SovereignBills = { version: VERSION, reload: load, state };

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
