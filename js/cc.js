(function () {
  "use strict";

  if (window.SovereignCC && window.SovereignCC.initialized) return;

  const VERSION = "v0.3.1-shared-ui";
  const CC_ENDPOINT = "/api/cc";
  const ADD_PAYMENT_BASE = "/add.html?type=transfer";

  let ccPayload = null;
  let selectedCardId = null;
  let selectedPlanPayload = null;

  const $ = id => document.getElementById(id);

  function components() {
    return window.SFComponents || {};
  }

  function esc(value) {
    const c = components();
    if (typeof c.escapeHtml === "function") return c.escapeHtml(value);
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const c = components();
    if (typeof c.money === "function") return c.money(value);
    return "Rs " + Math.round(Number(value) || 0).toLocaleString("en-PK");
  }

  function percent(value) {
    const c = components();
    if (typeof c.percent === "function") return c.percent(value);
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toFixed(n % 1 === 0 ? 0 : 1) + "%";
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function setHTML(id, value) {
    const el = $(id);
    if (el) el.innerHTML = value == null ? "" : String(value);
  }

  function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function round2(value) {
    return Math.round(asNumber(value, 0) * 100) / 100;
  }

  function normalizeCards(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.accounts)) return payload.accounts;
    if (Array.isArray(payload.cards)) return payload.cards;
    if (Array.isArray(payload.credit_cards)) return payload.credit_cards;
    if (Array.isArray(payload.data)) return payload.data;
    return [];
  }

  function cardName(card) {
    return card.name || card.label || card.account_name || card.id || "Credit Card";
  }

  function cardId(card) {
    return card.id || card.account_id || "";
  }

  function utilizationTone(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "info";
    if (n >= 75) return "danger";
    if (n >= 40) return "warning";
    return "positive";
  }

  function dueTone(card) {
    const status = String(card.due_status || card.due?.due_status || "").toLowerCase();
    const days = card.days_until_payment_due ?? card.days_to_payment_due ?? card.due?.days_until_payment_due;

    if (status === "overdue") return "danger";
    if (status === "due_urgent") return "danger";
    if (status === "due_soon") return "warning";

    const n = Number(days);
    if (Number.isFinite(n) && n < 0) return "danger";
    if (Number.isFinite(n) && n <= 3) return "danger";
    if (Number.isFinite(n) && n <= 7) return "warning";

    return "positive";
  }

  function dueLabel(card) {
    const outstanding = asNumber(card.outstanding ?? card.cc_outstanding, 0);
    if (outstanding <= 0) return "clear";

    const days = card.days_until_payment_due ?? card.days_to_payment_due ?? card.due?.days_until_payment_due;
    const n = Number(days);

    if (!Number.isFinite(n)) return "no due date";
    if (n < 0) return "overdue " + Math.abs(n) + "d";
    if (n === 0) return "due today";
    if (n === 1) return "due tomorrow";
    return "due in " + n + "d";
  }

  function sourceLabel(source, estimate) {
    if (!source) return estimate ? "estimated" : "configured";
    if (source === "estimated_outstanding_5pct") return "5% estimate";
    if (source === "account_configured") return "configured";
    if (source === "none_no_outstanding") return "none";
    return source.replace(/_/g, " ");
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-sovereign-cc-page": VERSION
      }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data) {
      throw new Error((data && data.error) || "HTTP " + response.status);
    }

    if (data.ok === false) {
      throw new Error(data.error || "Request failed");
    }

    return data;
  }

  function setStatus(label, tone) {
    const el = $("cc-api-status");
    if (!el) return;
    el.textContent = label;
    el.className = "sf-pill" + (tone ? " sf-pill--" + tone : "");
  }

  function updateShellKpis(cards, payload) {
    const totalOutstanding = round2(
      payload?.total_outstanding ??
      cards.reduce((sum, card) => sum + asNumber(card.outstanding ?? card.cc_outstanding, 0), 0)
    );

    const totalLimit = round2(
      payload?.total_credit_limit ??
      cards.reduce((sum, card) => sum + asNumber(card.credit_limit, 0), 0)
    );

    const utilization = payload?.utilization_pct ??
      (totalLimit > 0 ? round2((totalOutstanding / totalLimit) * 100) : null);

    const minimumDue = round2(
      cards.reduce((sum, card) => sum + asNumber(card.minimum_payment_amount, 0), 0)
    );

    const urgentCount = cards.filter(card => {
      const tone = dueTone(card);
      return tone === "danger" || tone === "warning";
    }).length;

    const kpis = [
      {
        title: "Outstanding",
        kicker: "Credit Card",
        valueHtml: money(totalOutstanding),
        subtitle: cards.length + " active card" + (cards.length === 1 ? "" : "s"),
        footHtml: "Formula: <strong>max(0, -balance)</strong>",
        tone: totalOutstanding > 0 ? "warning" : "positive"
      },
      {
        title: "Minimum Due",
        kicker: "Payment",
        valueHtml: money(minimumDue),
        subtitle: minimumDue > 0 ? "Configured or 5% estimate" : "No minimum due",
        foot: "No writes from this page",
        tone: minimumDue > 0 ? "warning" : "positive"
      },
      {
        title: "Utilization",
        kicker: "Risk",
        valueHtml: utilization == null ? "—" : percent(utilization),
        subtitle: totalLimit > 0 ? money(totalLimit) + " total limit" : "No card limit configured",
        foot: "Limit minus outstanding",
        tone: utilizationTone(utilization)
      },
      {
        title: "Due Pressure",
        kicker: "Timing",
        valueHtml: urgentCount ? String(urgentCount) : "Clear",
        subtitle: urgentCount ? "Cards need attention" : "No urgent due pressure",
        foot: "Statement and due-date engine",
        tone: urgentCount ? "danger" : "positive"
      }
    ];

    if (window.SFShell && typeof window.SFShell.setKpis === "function") {
      window.SFShell.setKpis(kpis);
    }
  }

  function renderMeter(value, tone) {
    const pct = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
    return `
      <div class="sf-meter" aria-label="Utilization ${esc(percent(value))}">
        <div class="sf-meter-fill sf-tone-${esc(tone || "info")}" style="--sf-meter-value:${pct}%"></div>
      </div>
    `;
  }

  function addPaymentUrl(card, amount) {
    const params = new URLSearchParams();
    params.set("type", "transfer");
    params.set("to", cardId(card) || "cc");

    if (amount && Number(amount) > 0) {
      params.set("amount", String(round2(amount)));
    }

    params.set("notes", "CC payment · " + cardName(card));
    return "/add.html?" + params.toString();
  }

  function renderCard(card) {
    const id = cardId(card);
    const outstanding = asNumber(card.outstanding ?? card.cc_outstanding, 0);
    const creditLimit = asNumber(card.credit_limit, 0);
    const availableCredit = card.available_credit == null ? null : asNumber(card.available_credit, 0);
    const utilization = card.utilization_pct;
    const utilTone = utilizationTone(utilization);
    const minPayment = asNumber(card.minimum_payment_amount, 0);
    const selected = id && id === selectedCardId;

    const due = dueLabel(card);
    const duePill = components().statusPill
      ? components().statusPill({ label: due, tone: dueTone(card) })
      : `<span class="sf-pill sf-pill--${dueTone(card)}">${esc(due)}</span>`;

    return `
      <button class="sf-finance-row cc-card-row${selected ? " is-active" : ""}" type="button" data-card-id="${esc(id)}">
        <div class="sf-row-left">
          <div class="sf-row-title">${esc(cardName(card))}</div>
          <div class="sf-row-subtitle">
            ${duePill}
            <span class="sf-pill">${esc(card.balance_model || "liability")}</span>
          </div>
          ${renderMeter(utilization, utilTone)}
        </div>
        <div class="sf-row-right">
          <div class="sf-tone-${outstanding > 0 ? "warning" : "positive"}">${money(outstanding)}</div>
          <div class="sf-row-subtitle">outstanding</div>
          <div class="sf-row-subtitle">
            ${creditLimit > 0 ? "Limit " + money(creditLimit) : "No limit"}
            ${availableCredit != null ? " · Available " + money(availableCredit) : ""}
          </div>
          <div class="sf-row-subtitle">
            Min ${money(minPayment)} · ${esc(sourceLabel(card.minimum_payment_source, card.minimum_payment_is_estimate))}
          </div>
        </div>
      </button>
    `;
  }

  function renderCards(cards) {
    if (!cards.length) {
      setText("cc-summary", "No credit card accounts found.");
      setHTML("cc-cards-container", components().emptyState
        ? components().emptyState({
          title: "No credit cards",
          subtitle: "Add a credit-card account from Accounts first.",
          actionHtml: '<a class="sf-button sf-button--primary" href="/accounts.html">Open Accounts</a>'
        })
        : '<div class="sf-empty-state">No credit cards</div>'
      );
      return;
    }

    const totalOutstanding = cards.reduce((sum, card) => {
      return sum + asNumber(card.outstanding ?? card.cc_outstanding, 0);
    }, 0);

    setText(
      "cc-summary",
      cards.length + " card" + (cards.length === 1 ? "" : "s") + " · " + money(totalOutstanding) + " outstanding"
    );

    setHTML("cc-cards-container", cards.map(renderCard).join(""));

    document.querySelectorAll(".cc-card-row").forEach(row => {
      row.addEventListener("click", () => {
        const id = row.getAttribute("data-card-id");
        if (id) selectCard(id);
      });
    });
  }

  function renderPressure(card) {
    if (!card) {
      setHTML("cc-pressure-panel", components().emptyState
        ? components().emptyState({
          title: "No card selected",
          subtitle: "Open a card to inspect payment pressure."
        })
        : '<div class="sf-empty-state">No card selected</div>'
      );
      return;
    }

    const outstanding = asNumber(card.outstanding ?? card.cc_outstanding, 0);
    const minPayment = asNumber(card.minimum_payment_amount, 0);
    const utilization = card.utilization_pct;
    const availableCredit = card.available_credit == null ? null : asNumber(card.available_credit, 0);
    const dueHeadline = card.due_headline || card.due?.due_headline || dueLabel(card);

    const rows = [
      {
        label: "Outstanding",
        valueHtml: money(outstanding),
        tone: outstanding > 0 ? "warning" : "positive"
      },
      {
        label: "Minimum payment",
        meta: sourceLabel(card.minimum_payment_source, card.minimum_payment_is_estimate),
        valueHtml: money(minPayment),
        tone: minPayment > 0 ? "warning" : "positive"
      },
      {
        label: "Utilization",
        valueHtml: utilization == null ? "—" : percent(utilization),
        tone: utilizationTone(utilization)
      },
      {
        label: "Available credit",
        valueHtml: availableCredit == null ? "—" : money(availableCredit),
        tone: "info"
      },
      {
        label: "Payment due",
        meta: dueHeadline,
        value: card.payment_due_date || card.due?.payment_due_date || "—",
        tone: dueTone(card)
      }
    ];

    const list = components().statList
      ? components().statList(rows)
      : rows.map(r => `<div class="sf-dense-row"><span>${esc(r.label)}</span><strong>${r.valueHtml || esc(r.value)}</strong></div>`).join("");

    const action = minPayment > 0
      ? `<a class="sf-button sf-button--primary" href="${esc(addPaymentUrl(card, minPayment))}">Pay minimum via Add</a>`
      : `<a class="sf-button" href="${esc(addPaymentUrl(card, outstanding))}">Open Add payment</a>`;

    setHTML("cc-pressure-panel", `
      ${list}
      <div class="sf-empty-action">${action}</div>
    `);
  }

  function scenarioTitle(key) {
    return String(key || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, ch => ch.toUpperCase());
  }

  function scenarioSummary(scenario) {
    if (!scenario || typeof scenario !== "object") return "—";
    if (scenario.message) return scenario.message;

    const parts = [];
    if (scenario.payment != null) parts.push("Payment " + money(scenario.payment));
    if (scenario.months != null) parts.push(String(scenario.months) + " months");
    if (scenario.total_interest != null) parts.push("Interest " + money(scenario.total_interest));
    return parts.join(" · ") || "—";
  }

  function renderPayoffScenarios(planPayload) {
    if (!planPayload) {
      setHTML("cc-payoff-plan", components().emptyState
        ? components().emptyState({
          title: "No payoff plan loaded",
          subtitle: "Open a card to load its payoff scenarios."
        })
        : '<div class="sf-empty-state">No payoff plan loaded</div>'
      );
      return;
    }

    const account = planPayload.account || {};
    const scenarios = planPayload.scenarios || {};
    const entries = Array.isArray(scenarios)
      ? scenarios.map((item, index) => ["scenario_" + (index + 1), item])
      : Object.entries(scenarios);

    if (scenarios.paid_off || !entries.length) {
      setHTML("cc-payoff-plan", components().emptyState
        ? components().emptyState({
          title: "Already paid off",
          subtitle: scenarios.message || "No payoff scenarios needed."
        })
        : '<div class="sf-empty-state">Already paid off</div>'
      );
      return;
    }

    const rows = entries.map(([key, scenario]) => {
      const amount = scenario && scenario.payment != null ? scenario.payment : null;
      const paymentLink = amount && amount > 0
        ? `<a class="sf-button" href="${esc(addPaymentUrl(account, amount))}">Pay via Add</a>`
        : `<span class="sf-pill">No payment</span>`;

      return `
        <div class="sf-finance-row">
          <div class="sf-row-left">
            <div class="sf-row-title">${esc(scenarioTitle(key))}</div>
            <div class="sf-row-subtitle">${esc(scenarioSummary(scenario))}</div>
          </div>
          <div class="sf-row-right">
            ${paymentLink}
          </div>
        </div>
      `;
    }).join("");

    setHTML("cc-payoff-plan", rows);
  }

  function renderDebug() {
    const debug = {
      page_version: VERSION,
      primary_endpoint: CC_ENDPOINT,
      selected_card_id: selectedCardId,
      cc_payload: ccPayload,
      selected_plan_payload: selectedPlanPayload,
      contract: {
        read_only: true,
        payment_execution: "/add.html",
        primary_api: "/api/cc",
        planner_api: "/api/cc/{id}/payoff-plan",
        outstanding_formula: "max(0, -balance)"
      }
    };

    setText("cc-debug-output", JSON.stringify(debug, null, 2));

    if (window.SFShell && typeof window.SFShell.revealDebugIfNeeded === "function") {
      window.SFShell.revealDebugIfNeeded();
    }
  }

  async function loadPlan(cardIdValue) {
    if (!cardIdValue) return;

    const selected = normalizeCards(ccPayload).find(card => cardId(card) === cardIdValue) || null;
    setText("cc-selected-card", selected ? cardName(selected) : cardIdValue);

    setHTML("cc-payoff-plan", components().loadingState
      ? components().loadingState({
        title: "Loading payoff plan",
        subtitle: "/api/cc/" + cardIdValue + "/payoff-plan"
      })
      : '<div class="sf-loading-state">Loading payoff plan</div>'
    );

    try {
      selectedPlanPayload = await fetchJSON("/api/cc/" + encodeURIComponent(cardIdValue) + "/payoff-plan");
      renderPayoffScenarios(selectedPlanPayload);
    } catch (err) {
      selectedPlanPayload = { ok: false, error: err.message };
      setHTML("cc-payoff-plan", components().errorState
        ? components().errorState({
          title: "Payoff plan failed",
          message: err.message
        })
        : '<div class="sf-empty-state">Payoff plan failed: ' + esc(err.message) + '</div>'
      );
    }

    renderDebug();
  }

  function selectCard(cardIdValue) {
    selectedCardId = cardIdValue;
    const cards = normalizeCards(ccPayload);
    const selected = cards.find(card => cardId(card) === selectedCardId) || null;

    renderCards(cards);
    renderPressure(selected);
    loadPlan(selectedCardId);
  }

  async function loadAll() {
    setStatus("Loading", "info");

    setHTML("cc-cards-container", components().loadingState
      ? components().loadingState({
        title: "Loading cards",
        subtitle: "Reading /api/cc."
      })
      : '<div class="sf-loading-state">Loading cards</div>'
    );

    try {
      ccPayload = await fetchJSON(CC_ENDPOINT);
      const cards = normalizeCards(ccPayload);

      setStatus("Ready · " + (ccPayload.version || "unknown"), "positive");
      updateShellKpis(cards, ccPayload);
      renderCards(cards);

      if (cards.length) {
        const first = cards[0];
        const firstId = cardId(first);
        selectedCardId = selectedCardId || firstId;
        renderPressure(first);
        await loadPlan(selectedCardId);
      } else {
        renderPressure(null);
        renderPayoffScenarios(null);
      }
    } catch (err) {
      ccPayload = { ok: false, error: err.message };
      setStatus("Load failed", "danger");
      setText("cc-summary", "Credit Card load failed.");

      setHTML("cc-cards-container", components().errorState
        ? components().errorState({
          title: "Credit Card API failed",
          message: err.message
        })
        : '<div class="sf-empty-state">Credit Card API failed: ' + esc(err.message) + '</div>'
      );

      if (window.SFShell && typeof window.SFShell.setKpis === "function") {
        window.SFShell.setKpis([
          {
            title: "Outstanding",
            kicker: "Credit Card",
            value: "Failed",
            subtitle: err.message,
            tone: "danger"
          },
          {
            title: "Minimum Due",
            kicker: "Payment",
            value: "—",
            subtitle: "No fallback write",
            tone: "danger"
          },
          {
            title: "Utilization",
            kicker: "Risk",
            value: "—",
            subtitle: "API unavailable",
            tone: "danger"
          },
          {
            title: "Due Pressure",
            kicker: "Timing",
            value: "—",
            subtitle: "API unavailable",
            tone: "danger"
          }
        ]);
      }
    }

    renderDebug();
  }

  function init() {
    window.SovereignCC = {
      initialized: true,
      version: VERSION,
      reload: loadAll,
      selectCard,
      payload: () => ccPayload,
      selectedPlan: () => selectedPlanPayload,
      selectedCardId: () => selectedCardId
    };

    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
