(() => {
  "use strict";

  const VERSION = "v0.3.0-atm-provider-refundable-ui";

  const ROUTES = {
    atm: "/api/atm",
    atmHealth: "/api/atm?action=health",
    atmProviders: "/api/atm?action=providers",
    atmWithdraw: "/api/atm/withdraw",
    atmRefund: "/api/atm/refund",
    balances: "/api/balances",
    reverse: "/api/transactions/reverse"
  };

  const CASH_ACCOUNT_ID = "cash";
  const DEFAULT_FEE = 35;

  const state = {
    atm: null,
    health: null,
    providersPayload: null,
    balances: null,
    accounts: [],
    sourceAccounts: [],
    destinationAccounts: [],
    providers: [],
    pendingFees: [],
    recentRows: [],
    busy: false,
    lastError: null
  };

  const id = {
    refresh: "atm-refresh",
    sourceStatus: "atm-source-status",

    pendingCount: "atm-kpi-pending-count",
    pendingTotal: "atm-kpi-pending-total",
    feesPaid: "atm-kpi-fees-paid",
    feesReversed: "atm-kpi-fees-reversed",
    feesNet: "atm-kpi-fees-net",
    defaultFee: "atm-kpi-default-fee",

    form: "atm-form",
    sourceAccount: "atm-source-account",
    destinationAccount: "atm-destination-account",
    provider: "atm-provider",
    feeRefundable: "atm-fee-refundable",
    amount: "atm-amount",
    fee: "atm-fee",
    date: "atm-date",
    notes: "atm-notes",
    result: "atm-result",
    submit: "atm-submit",
    submitLabel: "atm-submit-label",

    pendingFeesList: "atm-pending-fees-list",
    recentList: "atm-recent-list",

    debugOutput: "atm-debug-output",
    jsVersion: "atm-js-version",
    footerVersion: "atm-footer-version"
  };

  function el(nodeId) {
    return document.getElementById(nodeId);
  }

  function setText(nodeId, value) {
    const node = el(nodeId);
    if (!node) return;
    node.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
  }

  function setHtml(nodeId, value) {
    const node = el(nodeId);
    if (!node) return;
    node.innerHTML = value || "";
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function money(value) {
    const amount = asNumber(value, 0);

    return `Rs ${amount.toLocaleString("en-PK", {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2
    })}`;
  }

  function signedMoney(value) {
    const amount = asNumber(value, 0);
    if (amount > 0) return `+${money(amount)}`;
    if (amount < 0) return `-${money(Math.abs(amount))}`;
    return money(0);
  }

  function cleanText(value, fallback = "—") {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function todayISO() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function setHidden(nodeId, hidden) {
    const node = el(nodeId);
    if (!node) return;
    node.hidden = Boolean(hidden);
  }

  function normalizeProviderId(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function setStatus(tone, label) {
    const node = el(id.sourceStatus);
    if (!node) return;

    node.className = "sf-pill";

    if (tone === "positive" || tone === "success") {
      node.classList.add("sf-pill--positive");
    } else if (tone === "warning") {
      node.classList.add("sf-pill--warning");
    } else if (tone === "danger" || tone === "error") {
      node.classList.add("sf-pill--danger");
    } else {
      node.classList.add("sf-pill--info");
    }

    node.textContent = label;
  }

  function setBusy(nextBusy) {
    state.busy = Boolean(nextBusy);

    const submit = el(id.submit);
    const refresh = el(id.refresh);
    const refundButtons = document.querySelectorAll("[data-atm-refund-id]");

    if (submit) submit.disabled = state.busy;
    if (refresh) refresh.disabled = state.busy;

    refundButtons.forEach((button) => {
      button.disabled = state.busy;
    });

    setText(id.submitLabel, state.busy ? "Recording…" : "Record ATM withdrawal");
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    let payload;

    try {
      payload = await response.json();
    } catch (_) {
      payload = {
        ok: false,
        error: `Non-JSON response from ${url}`
      };
    }

    if (!response.ok || payload?.ok === false) {
      const error = new Error(
        payload?.error ||
          payload?.message ||
          `Request failed: ${response.status} ${response.statusText}`
      );

      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function normalizeAccount(raw, forcedId) {
    if (!raw || typeof raw !== "object") {
      if (!forcedId) return null;

      return {
        id: String(forcedId),
        name: String(forcedId),
        type: "",
        kind: "",
        provider_id: normalizeProviderId(forcedId),
        balance: asNumber(raw, 0),
        active: true
      };
    }

    const accountId =
      raw.id ||
      raw.account_id ||
      raw.accountId ||
      raw.key ||
      raw.slug ||
      forcedId;

    if (!accountId) return null;

    const name =
      raw.name ||
      raw.label ||
      raw.account_name ||
      raw.accountName ||
      raw.title ||
      accountId;

    const balance =
      raw.balance ??
      raw.current_balance ??
      raw.currentBalance ??
      raw.computed_balance ??
      raw.computedBalance ??
      raw.amount ??
      raw.value ??
      0;

    const type =
      raw.type ||
      raw.account_type ||
      raw.accountType ||
      "";

    const kind =
      raw.kind ||
      raw.account_kind ||
      raw.accountKind ||
      type ||
      "";

    const providerId =
      raw.provider_id ||
      raw.providerId ||
      raw.bank_id ||
      raw.bankId ||
      inferProviderIdFromAccount({
        id: accountId,
        name,
        type,
        kind
      });

    const active =
      raw.active !== false &&
      raw.is_active !== false &&
      raw.isActive !== false &&
      raw.archived !== true &&
      raw.hidden !== true &&
      !raw.archived_at &&
      !raw.deleted_at;

    return {
      id: String(accountId),
      name: String(name),
      type: String(type || ""),
      kind: String(kind || ""),
      provider_id: normalizeProviderId(providerId),
      balance: asNumber(balance, 0),
      active
    };
  }

  function inferProviderIdFromAccount(account) {
    const joined = [
      account?.id,
      account?.name,
      account?.kind,
      account?.type
    ].map((value) => normalizeProviderId(value)).join(" ");

    const map = [
      ["mashreq", ["mashreq"]],
      ["meezan", ["meezan"]],
      ["ubl", ["ubl", "united_bank"]],
      ["naya_pay", ["naya_pay", "nayapay"]],
      ["easypaisa", ["easypaisa", "easy_paisa"]],
      ["jazzcash", ["jazzcash", "jazz_cash"]],
      ["hbl", ["hbl", "habib_bank"]],
      ["mcb", ["mcb"]],
      ["abl", ["abl", "allied_bank"]],
      ["alfalah", ["alfalah", "bank_alfalah"]],
      ["bop", ["bop", "bank_of_punjab"]],
      ["faysal", ["faysal"]],
      ["standard_chartered", ["standard_chartered", "scb"]],
      ["askari", ["askari"]],
      ["js_bank", ["js_bank"]],
      ["bankislami", ["bankislami", "bank_islami"]],
      ["dib", ["dib", "dubai_islamic"]],
      ["soneri", ["soneri"]],
      ["samba", ["samba"]],
      ["silkbank", ["silkbank", "silk_bank"]],
      ["nbp", ["nbp", "national_bank"]],
      ["sindh_bank", ["sindh_bank"]]
    ];

    for (const [providerId, aliases] of map) {
      if (aliases.some((alias) => joined.includes(alias))) {
        return providerId;
      }
    }

    return "";
  }

  function extractAccounts(payload) {
    const rawAccounts = [];

    if (Array.isArray(payload?.account_list)) rawAccounts.push(...payload.account_list);
    if (Array.isArray(payload?.accounts)) rawAccounts.push(...payload.accounts);
    if (Array.isArray(payload?.rows)) rawAccounts.push(...payload.rows);
    if (Array.isArray(payload?.items)) rawAccounts.push(...payload.items);
    if (Array.isArray(payload?.balances)) rawAccounts.push(...payload.balances);
    if (Array.isArray(payload?.account_balances)) rawAccounts.push(...payload.account_balances);
    if (Array.isArray(payload?.accountBalances)) rawAccounts.push(...payload.accountBalances);
    if (Array.isArray(payload?.data?.accounts)) rawAccounts.push(...payload.data.accounts);
    if (Array.isArray(payload?.data?.rows)) rawAccounts.push(...payload.data.rows);

    if (payload?.accounts && !Array.isArray(payload.accounts) && typeof payload.accounts === "object") {
      Object.entries(payload.accounts).forEach(([accountId, account]) => {
        rawAccounts.push({
          id: accountId,
          ...(typeof account === "object" ? account : { balance: account })
        });
      });
    }

    if (payload?.balances && !Array.isArray(payload.balances) && typeof payload.balances === "object") {
      Object.entries(payload.balances).forEach(([accountId, account]) => {
        rawAccounts.push({
          id: accountId,
          ...(typeof account === "object" ? account : { balance: account })
        });
      });
    }

    const seen = new Set();

    return rawAccounts
      .map((account) => normalizeAccount(account))
      .filter(Boolean)
      .filter((account) => {
        if (!account.active) return false;
        if (seen.has(account.id)) return false;
        seen.add(account.id);
        return true;
      })
      .sort((a, b) => {
        if (a.id === CASH_ACCOUNT_ID) return 1;
        if (b.id === CASH_ACCOUNT_ID) return -1;
        return a.name.localeCompare(b.name);
      });
  }

  function normalizeProvider(raw) {
    if (!raw || typeof raw !== "object") return null;

    const providerId = normalizeProviderId(raw.id || raw.provider_id || raw.key || raw.name);
    const name = raw.name || raw.label || raw.title || providerId;

    if (!providerId) return null;

    return {
      id: providerId,
      name: String(name)
    };
  }

  function extractProviders(payload) {
    const rawProviders = [];

    if (Array.isArray(payload?.atm_providers)) rawProviders.push(...payload.atm_providers);
    if (Array.isArray(payload?.providers)) rawProviders.push(...payload.providers);
    if (Array.isArray(payload?.data?.atm_providers)) rawProviders.push(...payload.data.atm_providers);

    const seen = new Set();

    return rawProviders
      .map(normalizeProvider)
      .filter(Boolean)
      .filter((provider) => {
        if (seen.has(provider.id)) return false;
        seen.add(provider.id);
        return true;
      });
  }

  function extractPendingFees(payload) {
    const rows = [];

    if (Array.isArray(payload?.refundable_fees)) rows.push(...payload.refundable_fees);
    if (Array.isArray(payload?.pending_fees)) rows.push(...payload.pending_fees);
    if (Array.isArray(payload?.pendingFees)) rows.push(...payload.pendingFees);
    if (Array.isArray(payload?.fees?.pending)) rows.push(...payload.fees.pending);
    if (Array.isArray(payload?.summary?.pending_fees)) rows.push(...payload.summary.pending_fees);
    if (Array.isArray(payload?.data?.pending_fees)) rows.push(...payload.data.pending_fees);

    const seen = new Set();

    return rows.filter((row) => {
      const rowId = row?.id || row?.transaction_id || row?.txn_id || row?.row_id;
      if (!rowId) return true;
      if (seen.has(rowId)) return false;
      seen.add(rowId);
      return true;
    });
  }

  function extractRecentRows(payload) {
    const rows = [];

    if (Array.isArray(payload?.recent_atm_rows)) rows.push(...payload.recent_atm_rows);
    if (Array.isArray(payload?.recent_rows)) rows.push(...payload.recent_rows);
    if (Array.isArray(payload?.recentRows)) rows.push(...payload.recentRows);
    if (Array.isArray(payload?.recent)) rows.push(...payload.recent);
    if (Array.isArray(payload?.recent_activity)) rows.push(...payload.recent_activity);
    if (Array.isArray(payload?.transactions)) rows.push(...payload.transactions);
    if (Array.isArray(payload?.rows)) rows.push(...payload.rows);
    if (Array.isArray(payload?.data?.recent)) rows.push(...payload.data.recent);
    if (Array.isArray(payload?.data?.transactions)) rows.push(...payload.data.transactions);

    return rows.slice(0, 25);
  }

  function ensureProviderControls() {
    const formGrid = document.querySelector(`#${id.form} .sf-form-grid`);
    const amountInput = el(id.amount);

    if (!formGrid || !amountInput) return;

    if (!el(id.provider)) {
      const providerField = document.createElement("label");
      providerField.className = "sf-field sf-span-6";
      providerField.innerHTML = `
        <span class="sf-label">ATM used / provider bank</span>
        <select id="${id.provider}" class="sf-select" required>
          <option value="">Loading ATM providers…</option>
        </select>
      `;

      const amountField = amountInput.closest(".sf-field");
      if (amountField && amountField.parentNode === formGrid) {
        formGrid.insertBefore(providerField, amountField);
      } else {
        formGrid.appendChild(providerField);
      }
    }

    if (!el(id.feeRefundable)) {
      const refundableField = document.createElement("label");
      refundableField.className = "sf-field sf-span-6";
      refundableField.innerHTML = `
        <span class="sf-label">Fee refund status</span>
        <select id="${id.feeRefundable}" class="sf-select">
          <option value="0">Fee is final / not refundable</option>
          <option value="1">Fee is refundable / show refund button</option>
        </select>
      `;

      const feeInput = el(id.fee);
      const feeField = feeInput ? feeInput.closest(".sf-field") : null;

      if (feeField && feeField.parentNode === formGrid && feeField.nextSibling) {
        formGrid.insertBefore(refundableField, feeField.nextSibling);
      } else {
        formGrid.appendChild(refundableField);
      }
    }
  }

  function getSelectedSourceAccount() {
    const sourceId = el(id.sourceAccount)?.value || "";
    return state.sourceAccounts.find((account) => account.id === sourceId) ||
      state.accounts.find((account) => account.id === sourceId) ||
      null;
  }

  function getSelectedProvider() {
    const providerId = normalizeProviderId(el(id.provider)?.value || "");
    return state.providers.find((provider) => provider.id === providerId) || null;
  }

  function isSameBankSelection() {
    const source = getSelectedSourceAccount();
    const provider = getSelectedProvider();

    if (!source || !provider) return false;

    const sourceProviderId = normalizeProviderId(source.provider_id || inferProviderIdFromAccount(source));
    const atmProviderId = normalizeProviderId(provider.id);

    return !!sourceProviderId && !!atmProviderId && sourceProviderId === atmProviderId;
  }

  function updateFeeBehavior() {
    const feeInput = el(id.fee);
    const refundableSelect = el(id.feeRefundable);
    const provider = getSelectedProvider();
    const source = getSelectedSourceAccount();
    const sameBank = isSameBankSelection();

    if (!feeInput || !refundableSelect) return;

    if (sameBank) {
      feeInput.value = "0";
      feeInput.disabled = true;
      refundableSelect.value = "0";
      refundableSelect.disabled = true;
      feeInput.placeholder = "0";
      setStatus("positive", "Same-bank ATM · no fee row");
      return;
    }

    feeInput.disabled = false;
    refundableSelect.disabled = false;

    if (!feeInput.value) {
      feeInput.placeholder = String(getDefaultFee() || DEFAULT_FEE);
    }

    if (source && provider) {
      setStatus("warning", "Different-bank ATM · enter fee");
    }
  }

  function getPendingCount() {
    return (
      state.atm?.pending_count ??
      state.atm?.pending_fee_count ??
      state.atm?.summary?.pending_count ??
      state.atm?.summary?.pending_fee_count ??
      state.pendingFees.length
    );
  }

  function getPendingTotal() {
    const apiValue =
      state.atm?.total_pending_pkr ??
      state.atm?.pending_total ??
      state.atm?.pending_fee_total ??
      state.atm?.summary?.total_pending_pkr ??
      state.atm?.summary?.pending_total ??
      state.atm?.summary?.pending_fee_total;

    if (apiValue !== undefined && apiValue !== null) return asNumber(apiValue, 0);

    return state.pendingFees.reduce((sum, fee) => {
      return sum + asNumber(fee.amount ?? fee.fee ?? fee.value ?? fee.total, 0);
    }, 0);
  }

  function getFeesPaid() {
    return asNumber(
      state.atm?.fees_paid_30d ??
        state.atm?.fees_paid ??
        state.atm?.fees_30d?.paid ??
        state.atm?.summary?.fees_paid_30d ??
        state.atm?.summary?.fees_paid ??
        state.atm?.stats?.fees_paid_30d ??
        state.atm?.stats?.fees_paid ??
        0,
      0
    );
  }

  function getFeesRefunded() {
    return asNumber(
      state.atm?.fees_refunded_30d ??
        state.atm?.fees_refunded ??
        state.atm?.fees_reversed_30d ??
        state.atm?.fees_reversed ??
        state.atm?.fees_30d?.refunded ??
        state.atm?.fees_30d?.reversed ??
        state.atm?.summary?.fees_refunded_30d ??
        state.atm?.summary?.fees_refunded ??
        state.atm?.summary?.fees_reversed_30d ??
        state.atm?.summary?.fees_reversed ??
        state.atm?.stats?.fees_refunded_30d ??
        state.atm?.stats?.fees_refunded ??
        state.atm?.stats?.fees_reversed_30d ??
        state.atm?.stats?.fees_reversed ??
        0,
      0
    );
  }

  function getDefaultFee() {
    return asNumber(
      state.atm?.default_fee ??
        state.atm?.default_atm_fee ??
        state.atm?.defaults?.fee_pkr_hint ??
        state.atm?.defaults?.fee_pkr ??
        state.providersPayload?.defaults?.fee_pkr_hint ??
        0,
      DEFAULT_FEE
    );
  }

  function renderKpis() {
    const pendingCount = getPendingCount();
    const pendingTotal = getPendingTotal();
    const feesPaid = getFeesPaid();
    const feesRefunded = getFeesRefunded();

    const apiNet =
      state.atm?.fees_net ??
      state.atm?.net_fees ??
      state.atm?.fees_30d?.net ??
      state.atm?.summary?.fees_net ??
      state.atm?.summary?.net_fees ??
      state.atm?.stats?.fees_net;

    const feesNet = apiNet === undefined || apiNet === null
      ? feesPaid - feesRefunded
      : asNumber(apiNet, 0);

    setText(id.pendingCount, pendingCount);
    setText(id.pendingTotal, `${money(pendingTotal)} refundable queue`);
    setText(id.feesPaid, money(feesPaid));
    setText(id.feesReversed, money(feesRefunded));
    setText(id.feesNet, money(feesNet));
    setText(id.defaultFee, `Fee hint ${money(getDefaultFee())}`);
  }

  function renderAccounts() {
    const sourceSelect = el(id.sourceAccount);
    const destinationSelect = el(id.destinationAccount);

    if (!sourceSelect || !destinationSelect) return;

    const previousSource = sourceSelect.value;
    const previousDestination = destinationSelect.value || CASH_ACCOUNT_ID;

    const accounts = state.accounts;
    const cashAccount =
      accounts.find((account) => account.id === CASH_ACCOUNT_ID) ||
      normalizeAccount({ id: CASH_ACCOUNT_ID, name: "Cash", type: "cash", balance: 0 });

    state.sourceAccounts = accounts.filter((account) => account.id !== CASH_ACCOUNT_ID);
    state.destinationAccounts = accounts.filter((account) => account.id === CASH_ACCOUNT_ID);

    sourceSelect.innerHTML = [
      '<option value="">Select source card/account</option>',
      ...state.sourceAccounts.map((account) => {
        const selected = account.id === previousSource ? " selected" : "";
        const provider = account.provider_id ? ` · ${account.provider_id}` : "";
        return `<option value="${escapeHtml(account.id)}"${selected}>${escapeHtml(account.name)} · ${escapeHtml(money(account.balance))}${escapeHtml(provider)}</option>`;
      })
    ].join("");

    destinationSelect.innerHTML = [
      `<option value="${escapeHtml(cashAccount.id)}">${escapeHtml(cashAccount.name)} · ${escapeHtml(money(cashAccount.balance))}</option>`
    ].join("");

    destinationSelect.value = previousDestination || CASH_ACCOUNT_ID;

    if (!destinationSelect.value) {
      destinationSelect.value = CASH_ACCOUNT_ID;
    }
  }

  function renderProviders() {
    const providerSelect = el(id.provider);
    if (!providerSelect) return;

    const previousProvider = providerSelect.value;

    providerSelect.innerHTML = [
      '<option value="">Select ATM provider</option>',
      ...state.providers.map((provider) => {
        const selected = provider.id === previousProvider ? " selected" : "";
        return `<option value="${escapeHtml(provider.id)}"${selected}>${escapeHtml(provider.name)}</option>`;
      })
    ].join("");

    if (previousProvider) {
      providerSelect.value = previousProvider;
    }
  }

  function financeRowHtml(options) {
    const title = escapeHtml(options.title || "—");
    const subtitle = escapeHtml(options.subtitle || "—");
    const right = options.rightHtml || escapeHtml(options.right || "—");
    const tone = options.tone || "info";

    let rightClass = "sf-row-right";

    if (tone === "positive" || tone === "success") {
      rightClass += " sf-tone-positive";
    } else if (tone === "warning") {
      rightClass += " sf-tone-warning";
    } else if (tone === "danger" || tone === "error") {
      rightClass += " sf-tone-danger";
    } else {
      rightClass += " sf-tone-info";
    }

    return `
      <div class="sf-finance-row">
        <div class="sf-row-left">
          <div class="sf-row-title">${title}</div>
          <div class="sf-row-subtitle">${subtitle}</div>
        </div>
        <div class="${rightClass}">${right}</div>
      </div>
    `;
  }

  function loadingHtml(title, subtitle) {
    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${escapeHtml(title)}</h3>
          <p class="sf-card-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
    `;
  }

  function emptyHtml(title, subtitle) {
    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${escapeHtml(title)}</h3>
          <p class="sf-card-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
    `;
  }

  function renderPendingFees() {
    const node = el(id.pendingFeesList);
    if (!node) return;

    if (!state.pendingFees.length) {
      node.innerHTML = emptyHtml(
        "No refundable ATM fees",
        "Only refundable ATM fee rows appear here. Final ATM fees stay in the ledger as bank charges."
      );
      return;
    }

    node.innerHTML = state.pendingFees.map((fee) => {
      const feeId = cleanText(fee.id || fee.transaction_id || fee.txn_id || fee.row_id, "pending-fee");
      const accountId = cleanText(fee.account_id || fee.account || fee.source_account_id, "Unknown account");
      const amount = fee.amount ?? fee.fee ?? fee.value ?? 0;
      const date = cleanText(fee.date || fee.transaction_date || fee.created_at, "");
      const age = fee.age_days === null || fee.age_days === undefined ? "" : `${fee.age_days}d old`;
      const notes = cleanText(fee.notes || fee.description || fee.memo, "Refundable ATM fee charged; awaiting bank refund");

      const subtitle = [
        date,
        accountId,
        age,
        notes
          .replace("[ATM_FEE_REFUNDABLE]", "")
          .replace("[ATM_FEE_AWAITING_REFUND]", "")
          .replace("[ATM_FEE_PENDING]", "")
          .trim()
      ].filter(Boolean).join(" · ");

      const rightHtml = `
        <div>${escapeHtml(money(amount))}</div>
        <button
          type="button"
          class="sf-button"
          data-atm-refund-id="${escapeHtml(feeId)}"
          data-atm-refund-amount="${escapeHtml(amount)}"
        >Refund received</button>
      `;

      return financeRowHtml({
        title: "Refundable ATM fee",
        subtitle,
        rightHtml,
        tone: "warning"
      });
    }).join("");
  }

  function renderRecentRows() {
    const node = el(id.recentList);
    if (!node) return;

    if (!state.recentRows.length) {
      node.innerHTML = emptyHtml(
        "No ATM rows yet",
        "ATM withdrawals, cash receipt rows, final fee rows, refundable fee rows, and refund rows will appear here."
      );
      return;
    }

    node.innerHTML = state.recentRows.map((row) => {
      const rowId = cleanText(row.id || row.transaction_id || row.txn_id || row.row_id, "atm-row");
      const type = cleanText(row.type || row.kind || row.action || row.source_action || row.category, "ATM");
      const accountId = cleanText(row.account_id || row.account || row.source_account_id || row.destination_account_id, "");
      const amount = row.amount ?? row.value ?? row.fee ?? 0;
      const date = cleanText(row.date || row.transaction_date || row.created_at, "");
      const notes = cleanText(row.notes || row.description || row.memo, "");

      let tone = "info";
      let label = money(amount);
      let title = [type, accountId].filter(Boolean).join(" · ");

      if (notes.includes("[ATM_FEE_REFUND]") || notes.includes("[ATM_FEE_REVERSAL]") || type === "fee_refund") {
        tone = "positive";
        label = `Refund ${money(amount)}`;
        title = ["ATM fee refund", accountId].filter(Boolean).join(" · ");
      } else if (notes.includes("[ATM_FEE_REFUNDABLE]") || notes.includes("[ATM_FEE_AWAITING_REFUND]") || notes.includes("[ATM_FEE_PENDING]")) {
        tone = "warning";
        label = `Refundable ${money(amount)}`;
        title = ["ATM fee refundable", accountId].filter(Boolean).join(" · ");
      } else if (notes.includes("[ATM_FEE_FINAL]") || type === "atm") {
        tone = "warning";
        label = `Final fee ${money(amount)}`;
        title = ["ATM fee final", accountId].filter(Boolean).join(" · ");
      } else if (notes.includes("[ATM_WITHDRAWAL]") && type === "transfer") {
        tone = "warning";
        label = `Out ${money(amount)}`;
        title = ["ATM source out", accountId].filter(Boolean).join(" · ");
      } else if (notes.includes("[ATM_WITHDRAWAL]") && type === "income") {
        tone = "positive";
        label = `Cash ${money(amount)}`;
        title = ["ATM cash in", accountId].filter(Boolean).join(" · ");
      } else if (row.is_reversal || row.reversal_of || String(rowId).startsWith("rv_")) {
        tone = "positive";
        label = "Reversal";
      } else if (row.is_reversed) {
        tone = "warning";
        label = "Reversed";
      } else if (type === "expense" || type === "transfer") {
        tone = "warning";
      } else if (type === "income" || type === "opening") {
        tone = "positive";
      }

      return financeRowHtml({
        title,
        subtitle: [rowId, date, notes].filter(Boolean).join(" · "),
        right: label,
        tone
      });
    }).join("");
  }

  function renderResult(tone, title, message, payload) {
    const node = el(id.result);
    if (!node) return;

    node.hidden = false;

    node.innerHTML = financeRowHtml({
      title,
      subtitle: message,
      right: tone === "danger" ? "Failed" : tone === "warning" ? "Check" : "Done",
      tone
    });

    if (payload) {
      renderDebug(payload);
    }
  }

  function renderDebug(payload) {
    const node = el(id.debugOutput);
    if (!node) return;
    node.textContent = JSON.stringify(payload, null, 2);
  }

  function renderVersions() {
    window.SovereignATM = {
      version: VERSION,
      atm_route: ROUTES.atm,
      health_route: ROUTES.atmHealth,
      providers_route: ROUTES.atmProviders,
      withdraw_route: ROUTES.atmWithdraw,
      refund_route: ROUTES.atmRefund,
      reverse_route: ROUTES.reverse,
      contract_version: state.atm?.contract_version || state.health?.contract_version || "atm-v1",
      loaded_at: new Date().toISOString()
    };

    setText(id.jsVersion, `ATM UI ${VERSION}`);
    setText(id.footerVersion, `ATM · ${state.atm?.version || VERSION}`);
  }

  function renderStatus() {
    if (isSameBankSelection()) {
      setStatus("positive", "Same-bank ATM · no fee row");
      return;
    }

    if (state.health?.status === "pass") {
      setStatus("positive", `Healthy · ${state.health.version || state.atm?.version || "ATM"}`);
      return;
    }

    if (state.health?.status && state.health.status !== "pass") {
      setStatus("warning", `Health ${state.health.status}`);
      return;
    }

    if (state.atm?.version) {
      setStatus("positive", `Loaded · ${state.atm.version}`);
      return;
    }

    setStatus("info", "Loaded");
  }

  function renderAll() {
    ensureProviderControls();
    renderVersions();
    renderKpis();
    renderAccounts();
    renderProviders();
    renderPendingFees();
    renderRecentRows();
    updateFeeBehavior();
    renderStatus();
  }

  async function loadAll() {
    const [atmPayload, healthPayload, providersPayload, balancesPayload] = await Promise.all([
      requestJson(ROUTES.atm),
      requestJson(ROUTES.atmHealth).catch((error) => ({
        ok: false,
        status: "unknown",
        error: error.message,
        payload: error.payload || null
      })),
      requestJson(ROUTES.atmProviders).catch((error) => ({
        ok: false,
        atm_providers: [],
        error: error.message,
        payload: error.payload || null
      })),
      requestJson(ROUTES.balances)
    ]);

    state.atm = atmPayload;
    state.health = healthPayload;
    state.providersPayload = providersPayload;
    state.balances = balancesPayload;
    state.accounts = extractAccounts(balancesPayload);
    state.providers = extractProviders(providersPayload).length
      ? extractProviders(providersPayload)
      : extractProviders(atmPayload);
    state.pendingFees = extractPendingFees(atmPayload);
    state.recentRows = extractRecentRows(atmPayload);

    if (!state.accounts.some((account) => account.id === CASH_ACCOUNT_ID)) {
      state.accounts.push({
        id: CASH_ACCOUNT_ID,
        name: "Cash",
        type: "cash",
        kind: "cash",
        provider_id: "",
        balance: 0,
        active: true
      });
    }

    renderAll();

    renderDebug({
      atm: {
        ok: atmPayload?.ok,
        version: atmPayload?.version,
        contract_version: atmPayload?.contract_version,
        route: atmPayload?.route,
        supported_routes: atmPayload?.supported_routes,
        pending_count: getPendingCount(),
        pending_total: getPendingTotal(),
        fee_meaning: atmPayload?.rules?.pending_fee_meaning || "refundable fee charged now, awaiting possible bank refund"
      },
      health: healthPayload,
      providers: {
        ok: providersPayload?.ok,
        count: state.providers.length
      },
      balances: {
        ok: balancesPayload?.ok,
        version: balancesPayload?.version,
        contract_version: balancesPayload?.contract_version,
        source: balancesPayload?.source,
        balance_source: balancesPayload?.balance_source,
        account_count: balancesPayload?.account_count,
        active_account_count: balancesPayload?.active_account_count
      }
    });
  }

  async function refresh() {
    try {
      setBusy(true);
      setStatus("info", "Refreshing");
      await loadAll();
      renderResult(
        "positive",
        "ATM data refreshed",
        "Latest ATM contract, health, providers, balances, refundable fee queue, and recent rows loaded.",
        null
      );
    } catch (error) {
      state.lastError = error;
      setStatus("danger", "Refresh failed");
      renderResult("danger", "ATM refresh failed", error.message, error.payload || { error: error.message });
    } finally {
      setBusy(false);
    }
  }

  function buildWithdrawPayload() {
    const sourceAccount = getSelectedSourceAccount();
    const provider = getSelectedProvider();

    const sourceAccountId = el(id.sourceAccount)?.value || "";
    const destinationAccountId = el(id.destinationAccount)?.value || CASH_ACCOUNT_ID;
    const amount = asNumber(el(id.amount)?.value, 0);
    const sameBank = isSameBankSelection();
    const fee = sameBank ? 0 : asNumber(el(id.fee)?.value, 0);
    const feeRefundable = sameBank ? false : el(id.feeRefundable)?.value === "1";
    const date = el(id.date)?.value || todayISO();
    const notes = (el(id.notes)?.value || "").trim();

    if (!sourceAccountId) {
      throw new Error("Select a source card/account.");
    }

    if (!destinationAccountId) {
      throw new Error("Select a cash destination account.");
    }

    if (!provider) {
      throw new Error("Select the ATM provider/bank used.");
    }

    if (sourceAccountId === destinationAccountId) {
      throw new Error("Source account and destination account cannot be the same.");
    }

    if (!(amount > 0)) {
      throw new Error("Withdrawal amount must be greater than zero.");
    }

    if (fee < 0) {
      throw new Error("ATM fee cannot be negative.");
    }

    return {
      source_account_id: sourceAccountId,
      source_provider_id: sourceAccount?.provider_id || inferProviderIdFromAccount(sourceAccount),
      destination_account_id: destinationAccountId,
      cash_account_id: destinationAccountId,
      atm_provider_id: provider.id,
      atm_provider_name: provider.name,
      amount,
      fee,
      fee_amount: fee,
      fee_refundable: feeRefundable,
      refundable: feeRefundable,
      reversible: feeRefundable,
      no_fee: sameBank || fee === 0,
      date,
      notes
    };
  }

  async function submitWithdrawal(event) {
    event.preventDefault();

    try {
      setBusy(true);
      setStatus("info", "Recording");

      const payload = buildWithdrawPayload();

      const result = await requestJson(ROUTES.atmWithdraw, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      const sourceDelta = result?.account_impact?.source_account_delta;
      const cashDelta = result?.account_impact?.cash_account_delta;
      const liquidDelta = result?.account_impact?.liquid_total_delta;
      const feeTransaction = result?.fee_transaction;

      const feeText = feeTransaction
        ? feeTransaction.refundable
          ? `Refundable fee: ${money(feeTransaction.amount)}`
          : `Final fee: ${money(feeTransaction.amount)}`
        : "No fee row";

      renderResult(
        "positive",
        "ATM withdrawal recorded",
        [
          `Source impact: ${signedMoney(sourceDelta)}`,
          `Cash impact: ${signedMoney(cashDelta)}`,
          `Liquid impact: ${signedMoney(liquidDelta)}`,
          feeText
        ].join(" · "),
        result
      );

      const form = el(id.form);
      if (form) form.reset();

      const dateInput = el(id.date);
      if (dateInput) dateInput.value = todayISO();

      const destinationSelect = el(id.destinationAccount);
      if (destinationSelect) destinationSelect.value = CASH_ACCOUNT_ID;

      await loadAll();
    } catch (error) {
      state.lastError = error;
      setStatus("danger", "Record failed");
      renderResult("danger", "ATM withdrawal failed", error.message, error.payload || { error: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function refundFee(feeTxnId, amount) {
    try {
      setBusy(true);
      setStatus("info", "Recording refund");

      const result = await requestJson(ROUTES.atmRefund, {
        method: "POST",
        body: JSON.stringify({
          fee_txn_id: feeTxnId,
          amount: asNumber(amount, null),
          date: todayISO(),
          created_by: "web-atm-refund"
        })
      });

      renderResult(
        "positive",
        "ATM fee refund received",
        `Refund returned ${money(result?.amount || amount)} to ${cleanText(result?.account_id, "source account")}.`,
        result
      );

      await loadAll();
    } catch (error) {
      state.lastError = error;
      setStatus("danger", "Refund failed");
      renderResult("danger", "ATM fee refund failed", error.message, error.payload || { error: error.message });
    } finally {
      setBusy(false);
    }
  }

  function verifyRequiredNodes() {
    ensureProviderControls();

    const required = [
      id.sourceStatus,
      id.pendingCount,
      id.pendingTotal,
      id.feesPaid,
      id.feesReversed,
      id.feesNet,
      id.defaultFee,
      id.form,
      id.sourceAccount,
      id.destinationAccount,
      id.provider,
      id.feeRefundable,
      id.amount,
      id.fee,
      id.date,
      id.notes,
      id.result,
      id.submit,
      id.submitLabel,
      id.pendingFeesList,
      id.recentList,
      id.debugOutput,
      id.jsVersion,
      id.footerVersion
    ];

    const missing = required.filter((nodeId) => !el(nodeId));

    if (missing.length) {
      renderDebug({
        ok: false,
        version: VERSION,
        missing
      });

      setStatus("danger", "Missing page nodes");

      return false;
    }

    return true;
  }

  function bindEvents() {
    const form = el(id.form);
    if (form) {
      form.addEventListener("submit", submitWithdrawal);
    }

    const refreshButton = el(id.refresh);
    if (refreshButton) {
      refreshButton.addEventListener("click", refresh);
    }

    const sourceSelect = el(id.sourceAccount);
    if (sourceSelect) {
      sourceSelect.addEventListener("change", updateFeeBehavior);
    }

    const providerSelect = el(id.provider);
    if (providerSelect) {
      providerSelect.addEventListener("change", updateFeeBehavior);
    }

    const pendingList = el(id.pendingFeesList);
    if (pendingList) {
      pendingList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-atm-refund-id]");
        if (!button) return;

        const feeTxnId = button.getAttribute("data-atm-refund-id");
        const amount = button.getAttribute("data-atm-refund-amount");

        if (!feeTxnId) return;

        refundFee(feeTxnId, amount);
      });
    }

    const dateInput = el(id.date);
    if (dateInput && !dateInput.value) {
      dateInput.value = todayISO();
    }
  }

  async function init() {
    ensureProviderControls();
    renderVersions();

    if (!verifyRequiredNodes()) {
      return;
    }

    bindEvents();

    setHtml(id.pendingFeesList, loadingHtml("Loading refundable ATM fees", "Reading /api/atm."));
    setHtml(id.recentList, loadingHtml("Loading ATM rows", "Reading /api/atm."));
    setHidden(id.result, true);

    try {
      setBusy(true);
      setStatus("info", "Loading");
      await loadAll();
    } catch (error) {
      state.lastError = error;
      setStatus("danger", "Load failed");
      renderResult("danger", "ATM module failed to load", error.message, error.payload || { error: error.message });
    } finally {
      setBusy(false);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
