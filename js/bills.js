(() => {
  "use strict";

  const VERSION = "0.4.2";
  const DEBUG = new URLSearchParams(window.location.search).get("debug") === "1";

  if (DEBUG) document.body.classList.add("debug");

  const state = {
    bills: [],
    command: null,
    loading: true,
    commandLoading: false,
    error: null,
    commandError: null,
    search: "",
    filter: "active",
    lastPayload: null,
    lastCommandPayload: null
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    statusDetail: $("statusDetail"),
    activeCount: $("activeCount"),
    monthlyTotal: $("monthlyTotal"),
    dueCount: $("dueCount"),
    billsBody: $("billsBody"),
    searchInput: $("searchInput"),
    statusFilter: $("statusFilter"),
    addBillBtn: $("addBillBtn"),
    refreshBtn: $("refreshBtn"),
    debugPanel: $("debugPanel"),
    billModal: $("billModal"),
    billForm: $("billForm"),
    billModalTitle: $("billModalTitle"),
    billId: $("billId"),
    billName: $("billName"),
    billAmount: $("billAmount"),
    billDueDay: $("billDueDay"),
    billCategory: $("billCategory"),
    billStatus: $("billStatus"),
    billNotes: $("billNotes"),
    clearModal: $("clearModal"),
    clearForm: $("clearForm"),
    clearBillId: $("clearBillId"),
    clearModalText: $("clearModalText"),
    clearMonth: $("clearMonth"),
    clearAmount: $("clearAmount"),
    clearNotes: $("clearNotes"),
    toast: $("toast"),
    toastTitle: $("toastTitle"),
    toastBody: $("toastBody")
  };

  window.SovereignBillsUI = {
    version: VERSION,
    mode: DEBUG ? "debug" : "normal",
    refresh,
    refreshCommandCentre,
    getState: () => JSON.parse(JSON.stringify(state))
  };

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: "PKR",
      maximumFractionDigits: 0
    }).format(n);
  }

  function plainNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function monthValue(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function todayDay() {
    return new Date().getDate();
  }

  function normalizeBill(raw) {
    const id = raw.id ?? raw.bill_id ?? raw.uuid ?? raw.name;
    const name = raw.name ?? raw.title ?? raw.bill_name ?? "Unnamed bill";
    const amount = raw.amount ?? raw.monthly_amount ?? raw.expected_amount ?? raw.value ?? 0;
    const dueDay = raw.due_day ?? raw.dueDay ?? raw.day ?? raw.due_date_day ?? raw.due_date ?? null;
    const status = String(raw.status ?? "active").toLowerCase();
    const cleared =
      raw.cleared === true ||
      raw.is_cleared === true ||
      raw.current_month_cleared === true ||
      String(raw.clear_status ?? "").toLowerCase() === "cleared";
    const category = raw.category ?? raw.category_id ?? raw.type ?? "bills";
    const notes = raw.notes ?? raw.description ?? "";

    return {
      ...raw,
      id,
      name,
      amount: plainNumber(amount),
      dueDay,
      status,
      cleared,
      category,
      notes
    };
  }

  function extractBills(payload) {
    if (Array.isArray(payload)) return payload.map(normalizeBill);
    if (Array.isArray(payload?.bills)) return payload.bills.map(normalizeBill);
    if (Array.isArray(payload?.items)) return payload.items.map(normalizeBill);
    if (Array.isArray(payload?.data)) return payload.data.map(normalizeBill);
    if (Array.isArray(payload?.rows)) return payload.rows.map(normalizeBill);
    return [];
  }

  async function readJson(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await res.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: text || "Non-JSON response" };
    }

    if (!res.ok) {
      const message = json?.error || json?.message || `HTTP ${res.status}`;
      throw new Error(message);
    }

    return json;
  }

  async function refresh() {
    state.loading = true;
    state.error = null;
    render();

    try {
      const billsPayload = await readJson(`/api/bills?cb=${Date.now()}`);
      state.lastPayload = billsPayload;
      state.bills = extractBills(billsPayload);
      state.loading = false;
      state.error = null;
      render();

      deferCommandRefresh();
    } catch (err) {
      state.loading = false;
      state.error = err?.message || "Unable to load bills.";
      render();

      deferCommandRefresh();
    }
  }

  function deferCommandRefresh() {
    if (DEBUG) {
      refreshCommandCentre();
      return;
    }

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => refreshCommandCentre(), { timeout: 2500 });
      return;
    }

    window.setTimeout(() => refreshCommandCentre(), 1200);
  }

  async function refreshCommandCentre() {
    if (state.commandLoading) return;

    state.commandLoading = true;
    state.commandError = null;
    renderDebug();

    try {
      const commandPayload = await readJson(`/api/finance-command-center?cb=${Date.now()}`);
      state.command = commandPayload;
      state.lastCommandPayload = commandPayload;
      state.commandError = null;
    } catch (err) {
      state.commandError = err?.message || "Command Centre unavailable.";
    } finally {
      state.commandLoading = false;
      render();
    }
  }

  function commandActionAllowed(actionName) {
    if (!state.command) return true;

    const actions = state.command?.enforcement?.actions || state.command?.actions || [];
    const action = actions.find((x) => x.action === actionName || x.name === actionName);

    if (!action) return true;
    return action.allowed !== false && action.status !== "blocked";
  }

  function filteredBills() {
    const q = state.search.trim().toLowerCase();

    return state.bills.filter((bill) => {
      const matchesSearch = !q || [bill.name, bill.category, bill.notes]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));

      let matchesFilter = true;

      if (state.filter === "active") matchesFilter = bill.status === "active";
      if (state.filter === "cleared") matchesFilter = bill.cleared === true;
      if (state.filter === "pending") matchesFilter = bill.cleared !== true && bill.status === "active";

      return matchesSearch && matchesFilter;
    });
  }

  function render() {
    renderStatus();
    renderStats();
    renderTable();
    renderDebug();
  }

  function renderStatus() {
    if (state.loading) {
      els.statusDot.className = "dot";
      els.statusText.textContent = "Loading bills";
      els.statusDetail.textContent = "Fetching your current obligations.";
      return;
    }

    if (state.error) {
      els.statusDot.className = "dot bad";
      els.statusText.textContent = "Needs attention";
      els.statusDetail.textContent = state.error;
      return;
    }

    els.statusDot.className = "dot ready";
    els.statusText.textContent = "Ready";
    els.statusDetail.textContent = "Bills are loaded and available.";
  }

  function renderStats() {
    const active = state.bills.filter((b) => b.status === "active");
    const total = active.reduce((sum, b) => sum + plainNumber(b.amount), 0);
    const due = active.filter((b) => {
      const dueDay = Number.parseInt(String(b.dueDay ?? ""), 10);
      return Number.isFinite(dueDay) && dueDay >= todayDay() && !b.cleared;
    });

    els.activeCount.textContent = state.loading ? "—" : String(active.length);
    els.monthlyTotal.textContent = state.loading ? "—" : money(total);
    els.dueCount.textContent = state.loading ? "—" : String(due.length);
  }

  function renderTable() {
    if (state.loading) {
      els.billsBody.innerHTML = `<tr><td colspan="5" class="empty">Loading bills...</td></tr>`;
      return;
    }

    if (state.error) {
      els.billsBody.innerHTML = `<tr><td colspan="5" class="empty">${escapeHtml(state.error)}</td></tr>`;
      return;
    }

    const bills = filteredBills();

    if (!bills.length) {
      els.billsBody.innerHTML = `<tr><td colspan="5" class="empty">No bills found.</td></tr>`;
      return;
    }

    els.billsBody.innerHTML = bills.map((bill) => {
      const due = bill.dueDay ? `Day ${escapeHtml(bill.dueDay)}` : "—";
      const statusBadge = bill.cleared
        ? `<span class="badge ok">Cleared</span>`
        : `<span class="badge warn">Pending</span>`;

      const archived = bill.status !== "active"
        ? `<span class="badge">${escapeHtml(bill.status)}</span>`
        : "";

      return `
        <tr>
          <td data-label="Bill">
            <div class="bill-name">
              <strong>${escapeHtml(bill.name)}</strong>
              <span class="sub">${escapeHtml(bill.category || "bills")}${bill.notes ? ` · ${escapeHtml(bill.notes)}` : ""}</span>
            </div>
          </td>
          <td data-label="Amount">${money(bill.amount)}</td>
          <td data-label="Due">${due}</td>
          <td data-label="Status">${statusBadge} ${archived}</td>
          <td data-label="Actions">
            <div class="row-actions">
              <button class="small-btn" type="button" data-edit="${escapeHtml(bill.id)}">Edit</button>
              <button class="small-btn" type="button" data-clear="${escapeHtml(bill.id)}">Clear</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function renderDebug() {
    if (!DEBUG || !els.debugPanel) return;

    els.debugPanel.textContent = JSON.stringify({
      ui_version: VERSION,
      mode: "debug",
      bills_count: state.bills.length,
      bills_loading: state.loading,
      command_loading: state.commandLoading,
      command_error: state.commandError,
      filter: state.filter,
      search: state.search,
      error: state.error,
      command_version: state.command?.version,
      bill_save_allowed: commandActionAllowed("bill.save"),
      bill_clear_allowed: commandActionAllowed("bill.clear"),
      raw_bills_payload: state.lastPayload,
      raw_command_payload: state.lastCommandPayload
    }, null, 2);
  }

  function showToast(title, body = "") {
    els.toastTitle.textContent = title;
    els.toastBody.textContent = body;
    els.toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 3200);
  }

  function openBillModal(bill = null) {
    els.billModal.classList.add("open");
    els.billModal.setAttribute("aria-hidden", "false");

    els.billModalTitle.textContent = bill ? "Edit Bill" : "Add Bill";
    els.billId.value = bill?.id ?? "";
    els.billName.value = bill?.name ?? "";
    els.billAmount.value = bill?.amount ?? "";
    els.billDueDay.value = bill?.dueDay ?? "";
    els.billCategory.value = bill?.category ?? "bills";
    els.billStatus.value = bill?.status ?? "active";
    els.billNotes.value = bill?.notes ?? "";
    setTimeout(() => els.billName.focus(), 30);
  }

  function closeBillModal() {
    els.billModal.classList.remove("open");
    els.billModal.setAttribute("aria-hidden", "true");
    els.billForm.reset();
    els.billId.value = "";
  }

  function openClearModal(bill) {
    els.clearModal.classList.add("open");
    els.clearModal.setAttribute("aria-hidden", "false");

    els.clearBillId.value = bill.id;
    els.clearAmount.value = bill.amount || "";
    els.clearMonth.value = monthValue();
    els.clearNotes.value = "";
    els.clearModalText.textContent = `Mark ${bill.name} as cleared for the selected month.`;
    setTimeout(() => els.clearAmount.focus(), 30);
  }

  function closeClearModal() {
    els.clearModal.classList.remove("open");
    els.clearModal.setAttribute("aria-hidden", "true");
    els.clearForm.reset();
    els.clearBillId.value = "";
  }

  function billById(id) {
    return state.bills.find((bill) => String(bill.id) === String(id));
  }

  function billPayloadFromForm() {
    const id = els.billId.value.trim();

    const payload = {
      name: els.billName.value.trim(),
      amount: plainNumber(els.billAmount.value),
      due_day: els.billDueDay.value ? Number.parseInt(els.billDueDay.value, 10) : null,
      category: els.billCategory.value.trim() || "bills",
      status: els.billStatus.value,
      notes: els.billNotes.value.trim()
    };

    if (id) payload.id = id;
    return payload;
  }

  async function saveBill(payload) {
    const isEdit = Boolean(payload.id);

    const endpoints = isEdit
      ? [
          { url: `/api/bills/${encodeURIComponent(payload.id)}`, method: "PUT" },
          { url: `/api/bills/${encodeURIComponent(payload.id)}`, method: "POST" },
          { url: `/api/bills`, method: "POST", body: { ...payload, action: "update" } }
        ]
      : [
          { url: `/api/bills`, method: "POST", body: payload }
        ];

    return tryMutation(endpoints, payload);
  }

  async function clearBill(payload) {
    const id = payload.id;

    const endpoints = [
      { url: `/api/bills/${encodeURIComponent(id)}/clear`, method: "POST", body: payload },
      { url: `/api/bills/${encodeURIComponent(id)}`, method: "POST", body: { ...payload, action: "clear" } },
      { url: `/api/bills`, method: "POST", body: { ...payload, bill_id: id, action: "clear" } }
    ];

    return tryMutation(endpoints, payload);
  }

  async function tryMutation(candidates, fallbackBody) {
    let lastError = null;

    for (const candidate of candidates) {
      try {
        return await readJson(candidate.url, {
          method: candidate.method,
          body: JSON.stringify(candidate.body || fallbackBody)
        });
      } catch (err) {
        lastError = err;
        if (DEBUG) console.warn("Bills mutation candidate failed", candidate, err);
      }
    }

    throw lastError || new Error("Unable to save changes.");
  }

  function bindEvents() {
    els.refreshBtn.addEventListener("click", refresh);
    els.addBillBtn.addEventListener("click", () => openBillModal());

    els.searchInput.addEventListener("input", (event) => {
      state.search = event.target.value;
      render();
    });

    els.statusFilter.addEventListener("change", (event) => {
      state.filter = event.target.value;
      render();
    });

    document.addEventListener("click", (event) => {
      const editId = event.target?.getAttribute?.("data-edit");
      const clearId = event.target?.getAttribute?.("data-clear");

      if (editId) {
        const bill = billById(editId);
        if (bill) openBillModal(bill);
      }

      if (clearId) {
        const bill = billById(clearId);
        if (bill) openClearModal(bill);
      }

      if (event.target?.hasAttribute?.("data-close-modal")) closeBillModal();
      if (event.target?.hasAttribute?.("data-close-clear")) closeClearModal();
    });

    els.billModal.addEventListener("click", (event) => {
      if (event.target === els.billModal) closeBillModal();
    });

    els.clearModal.addEventListener("click", (event) => {
      if (event.target === els.clearModal) closeClearModal();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeBillModal();
        closeClearModal();
      }
    });

    els.billForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const payload = billPayloadFromForm();

      if (!payload.name) {
        showToast("Name required", "Add a bill name before saving.");
        return;
      }

      try {
        await saveBill(payload);
        closeBillModal();
        showToast("Bill saved", payload.name);
        await refresh();
      } catch (err) {
        showToast("Save failed", err?.message || "Unable to save bill.");
        deferCommandRefresh();
      }
    });

    els.clearForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const id = els.clearBillId.value;
      const bill = billById(id);

      const payload = {
        id,
        amount: plainNumber(els.clearAmount.value),
        month: els.clearMonth.value,
        notes: els.clearNotes.value.trim()
      };

      try {
        await clearBill(payload);
        closeClearModal();
        showToast("Bill cleared", bill?.name || "Bill");
        await refresh();
      } catch (err) {
        showToast("Clear failed", err?.message || "Unable to clear bill.");
        deferCommandRefresh();
      }
    });
  }

  bindEvents();
  refresh();
})();
