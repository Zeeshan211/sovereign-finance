/* Sovereign Finance Bills UI v0.4.0
Phase 7H: Bills page dry-run preflight wiring.

Contract:
- Loads Bills API v0.3.0+.
- Runs bill.clear dry-run before any real clear path.
- Runs bill.save dry-run helper for future save flows.
- If Command Centre keeps bill.clear/bill.save blocked, stops after preflight.
- No silent offline queue.
- No fake ledger smoke test.
*/

(function () {
  "use strict";

  const VERSION = "v0.4.0";
  const REQUIRED_BILLS_API_VERSION = "0.3.0";

  let bills = [];
  let enforcementSnapshot = null;
  let lastProofByBill = {};

  const $ = id => document.getElementById(id);

  function toast(message, kind) {
    const old = document.querySelector(".toast");
    if (old) old.remove();

    const el = document.createElement("div");
    el.className = "toast toast-" + (kind || "info");
    el.textContent = message;
    document.body.appendChild(el);

    setTimeout(() => el.classList.add("show"), 20);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }

  function money(value) {
    const n = Number(value || 0);
    return "Rs " + n.toLocaleString("en-PK", { maximumFractionDigits: 0 });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function versionAtLeast(actual, required) {
    const a = parseVersion(actual);
    const r = parseVersion(required);
    for (let i = 0; i < Math.max(a.length, r.length); i += 1) {
      const av = a[i] || 0;
      const rv = r[i] || 0;
      if (av > rv) return true;
      if (av < rv) return false;
    }
    return true;
  }

  function parseVersion(value) {
    return String(value || "")
      .replace(/^v/i, "")
      .split(".")
      .map(part => Number(part))
      .map(number => Number.isFinite(number) ? number : 0);
  }

  async function fetchJSON(url, options) {
    const res = await fetch(url, {
      cache: "no-store",
      ...(options || {})
    });

    const data = await res.json().catch(() => null);

    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || ("HTTP " + res.status));
      err.data = data;
      err.status = res.status;
      throw err;
    }

    return data;
  }

  async function refreshEnforcement() {
    if (window.SovereignEnforcement && typeof window.SovereignEnforcement.refresh === "function") {
      enforcementSnapshot = await window.SovereignEnforcement.refresh();
      renderEnforcement();
      return enforcementSnapshot;
    }

    enforcementSnapshot = {
      loaded: false,
      error: "window.SovereignEnforcement unavailable",
      enforcement: null
    };

    renderEnforcement();
    return enforcementSnapshot;
  }

  function findAction(actionName) {
    const actions = enforcementSnapshot &&
      enforcementSnapshot.enforcement &&
      Array.isArray(enforcementSnapshot.enforcement.actions)
      ? enforcementSnapshot.enforcement.actions
      : [];

    return actions.find(action => action.action === actionName) || null;
  }

  function actionAllowed(actionName) {
    const action = findAction(actionName);
    return Boolean(action && action.allowed === true);
  }

  function billAuthoritySummary() {
    const preflight = findAction("bill.preflight");
    const save = findAction("bill.save");
    const clear = findAction("bill.clear");

    return {
      preflight_allowed: Boolean(preflight && preflight.allowed),
      bill_save_allowed: Boolean(save && save.allowed),
      bill_clear_allowed: Boolean(clear && clear.allowed),
      save,
      clear,
      preflight
    };
  }

  function renderEnforcement() {
    const panel = $("billsEnforcement");
    const status = $("billAuthorityStatus");
    if (!panel) return;

    const summary = billAuthoritySummary();

    panel.classList.remove("pass", "blocked");

    if (!enforcementSnapshot || !enforcementSnapshot.loaded) {
      panel.classList.add("blocked");
      panel.textContent = "Command Centre policy is not loaded. Bills actions stay blocked.";
      if (status) status.textContent = "Blocked";
      return;
    }

    if (summary.bill_save_allowed || summary.bill_clear_allowed) {
      panel.classList.add("pass");
      panel.textContent = "Command Centre allows proven Bills actions. Page still runs dry-run preflight before real write.";
      if (status) status.textContent = "Allowed";
      return;
    }

    if (summary.preflight_allowed) {
      panel.textContent = "Bills preflight is allowed. Real bill save/clear remains blocked until Command Centre lift.";
      if (status) status.textContent = "Preflight";
      return;
    }

    panel.classList.add("blocked");
    panel.textContent = "Bills are viewable, but bill actions are blocked until dry-run proof and page preflight are recognized.";
    if (status) status.textContent = "Blocked";
  }

  async function loadBills() {
    const data = await fetchJSON("/api/bills?cb=" + Date.now());
    if (!versionAtLeast(data.version, REQUIRED_BILLS_API_VERSION)) {
      throw new Error("Bills API must be v0.3.0+ for dry-run proof. Current: " + data.version);
    }
    bills = Array.isArray(data.bills) ? data.bills : [];
    renderBills();
  }

  function renderStats() {
    const active = bills.filter(bill => String(bill.status || "active").toLowerCase() === "active");
    const monthlyAmount = active.reduce((sum, bill) => sum + Number(bill.amount || 0), 0);

    if ($("billCount")) $("billCount").textContent = String(bills.length);
    if ($("activeBillCount")) $("activeBillCount").textContent = String(active.length);
    if ($("monthlyBillAmount")) $("monthlyBillAmount").textContent = money(monthlyAmount);
  }

  function renderBills() {
    renderStats();
    renderEnforcement();

    const list = $("billsList");
    if (!list) return;

    if (!bills.length) {
      list.innerHTML = '<div class="bills-empty">No bills returned from /api/bills.</div>';
      return;
    }

    list.innerHTML = bills.map(renderBillCard).join("");

    list.querySelectorAll("[data-bill-action]").forEach(button => {
      button.addEventListener("click", onBillActionClick);
    });
  }

  function renderBillCard(bill) {
    const id = escapeHtml(bill.id || "");
    const proof = lastProofByBill[bill.id];
    const proofHtml = proof
      ? `<div class="bill-proof ${proof.ok ? "" : "fail"}">${escapeHtml(proof.message)}</div>`
      : "";

    return `
      <article class="bill-card" data-bill-id="${id}">
        <div class="bill-card-header">
          <div>
            <div class="bill-name">${escapeHtml(bill.name || bill.id || "Bill")}</div>
            <div class="bill-status">${escapeHtml(bill.status || "active")}</div>
          </div>
          <div class="bill-status">${escapeHtml(bill.frequency || "monthly")}</div>
        </div>

        <div class="bill-meta">
          <div class="bill-meta-item">
            <div class="bill-meta-label">Amount</div>
            <div class="bill-meta-value">${escapeHtml(money(bill.amount))}</div>
          </div>
          <div class="bill-meta-item">
            <div class="bill-meta-label">Due day</div>
            <div class="bill-meta-value">${escapeHtml(bill.due_day == null ? "N/A" : String(bill.due_day))}</div>
          </div>
          <div class="bill-meta-item">
            <div class="bill-meta-label">Last paid</div>
            <div class="bill-meta-value">${escapeHtml(bill.last_paid_date || "N/A")}</div>
          </div>
          <div class="bill-meta-item">
            <div class="bill-meta-label">Account</div>
            <div class="bill-meta-value">${escapeHtml(bill.default_account_id || bill.last_paid_account_id || "N/A")}</div>
          </div>
        </div>

        <div class="bill-actions">
          <button class="primary" type="button" data-bill-action="clear" data-bill-id="${id}">
            Run Clear Preflight
          </button>
          <button class="secondary" type="button" data-bill-action="save" data-bill-id="${id}">
            Run Save Preflight
          </button>
        </div>

        ${proofHtml}
      </article>
    `;
  }

  async function onBillActionClick(event) {
    const button = event.currentTarget;
    const billId = button.dataset.billId;
    const action = button.dataset.billAction;
    const bill = bills.find(item => item.id === billId);

    if (!bill) {
      toast("Bill not found on page.", "error");
      return;
    }

    button.disabled = true;
    button.classList.add("disabled");

    try {
      await refreshEnforcement();

      if (action === "clear") {
        await handleBillClear(bill);
      } else {
        await handleBillSave(bill);
      }
    } catch (err) {
      lastProofByBill[billId] = {
        ok: false,
        message: err.message || String(err)
      };
      toast(err.message || "Bills preflight failed", "error");
      renderBills();
    } finally {
      button.disabled = false;
      button.classList.remove("disabled");
    }
  }

  async function handleBillClear(bill) {
    const result = await runClearPreflight(bill);

    lastProofByBill[bill.id] = {
      ok: true,
      message: "bill.clear preflight passed. No bill, ledger, or audit rows were written."
    };

    renderBills();
    toast("bill.clear preflight passed.", "success");

    if (!actionAllowed("bill.clear")) {
      return;
    }

    await runRealBillClear(bill);
  }

  async function handleBillSave(bill) {
    const result = await runSavePreflight(bill);

    lastProofByBill[bill.id] = {
      ok: true,
      message: "bill.save preflight passed. No bill, ledger, or audit rows were written."
    };

    renderBills();
    toast("bill.save preflight passed.", "success");

    if (!actionAllowed("bill.save")) {
      return;
    }

    await runRealBillSave(bill);
  }

  async function runClearPreflight(bill) {
    return fetchJSON("/api/bills/" + encodeURIComponent(bill.id) + "/pay?dry_run=1&cb=" + Date.now(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry_run: true,
        account_id: bill.last_paid_account_id || bill.default_account_id || "cash",
        paid_date: todayISO()
      })
    });
  }

  async function runSavePreflight(bill) {
    return fetchJSON("/api/bills/" + encodeURIComponent(bill.id) + "?dry_run=1&cb=" + Date.now(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dry_run: true,
        amount: Number(bill.amount || 0),
        due_day: bill.due_day,
        frequency: bill.frequency || "monthly",
        category_id: bill.category_id || null,
        default_account_id: bill.default_account_id || bill.last_paid_account_id || null,
        status: bill.status || "active"
      })
    });
  }

  async function runRealBillClear(bill) {
    const result = await fetchJSON("/api/bills/" + encodeURIComponent(bill.id) + "/pay?cb=" + Date.now(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: bill.last_paid_account_id || bill.default_account_id || "cash",
        paid_date: todayISO()
      })
    });

    toast("Bill cleared.", "success");
    await loadBills();
    return result;
  }

  async function runRealBillSave(bill) {
    const result = await fetchJSON("/api/bills/" + encodeURIComponent(bill.id) + "?cb=" + Date.now(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Number(bill.amount || 0),
        due_day: bill.due_day,
        frequency: bill.frequency || "monthly",
        category_id: bill.category_id || null,
        default_account_id: bill.default_account_id || bill.last_paid_account_id || null,
        status: bill.status || "active"
      })
    });

    toast("Bill saved.", "success");
    await loadBills();
    return result;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function init() {
    console.log("[bills v0.4.0] init");

    try {
      await refreshEnforcement();
      await loadBills();

      console.log("[bills v0.4.0] ready", {
        bills: bills.length,
        enforcement: billAuthoritySummary()
      });
    } catch (err) {
      console.error("[bills v0.4.0] init failed", err);
      toast(err.message || "Bills failed to load", "error");

      const list = $("billsList");
      if (list) {
        list.innerHTML = '<div class="bills-empty">Bills failed to load: ' + escapeHtml(err.message || String(err)) + '</div>';
      }
    }
  }

  window.SovereignBills = {
    version: VERSION,
    bills: () => bills.slice(),
    enforcement: () => billAuthoritySummary(),
    refresh: async () => {
      await refreshEnforcement();
      await loadBills();
      return {
        bills: bills.slice(),
        enforcement: billAuthoritySummary()
      };
    },
    preflightClear: async billId => {
      const bill = bills.find(item => item.id === billId);
      if (!bill) throw new Error("Bill not found: " + billId);
      return runClearPreflight(bill);
    },
    preflightSave: async billId => {
      const bill = bills.find(item => item.id === billId);
      if (!bill) throw new Error("Bill not found: " + billId);
      return runSavePreflight(bill);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
