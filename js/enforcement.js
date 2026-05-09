// v0.2.0  Sovereign Command Centre frontend route gate
//
// Contract:
// - Read-only frontend helper.
// - Fetches /api/finance-command-center.
// - Exposes backend enforcement policy.
// - Gates blocked routes visually before risky page flow continues.
// - Allows view-only routes but marks them clearly.
// - Does not write D1.
// - Does not mutate ledger.
// - Does not override backend verdict.
// - Unknown stays Unknown.
// - Command Centre must always remain accessible.

(function () {
  "use strict";

  const VERSION = "0.2.0";
  const ENDPOINT = "/api/finance-command-center";
  const COMMAND_CENTRE_ROUTE = "/monthly-close.html";
  const REFRESH_MS = 5 * 60 * 1000;

  const state = {
    version: VERSION,
    endpoint: ENDPOINT,
    loaded: false,
    loading: false,
    data: null,
    enforcement: null,
    error: null,
    loadedAt: null,
    subscribers: []
  };

  function normalizePath(path) {
    let p = String(path || "/").split("?")[0].split("#")[0];
    if (p === "/" || p === "") return "/index.html";
    if (!p.endsWith(".html") && !p.startsWith("/api/")) p = p.replace(/\/$/, "") + ".html";
    return p;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function notify() {
    const snapshot = api.snapshot();

    state.subscribers.forEach(fn => {
      try {
        fn(snapshot);
      } catch (err) {
        console.warn("[SovereignEnforcement v" + VERSION + "] subscriber failed:", err);
      }
    });

    window.dispatchEvent(new CustomEvent("sovereign:enforcement:update", {
      detail: snapshot
    }));
  }

  async function refresh() {
    if (state.loading) return api.snapshot();

    state.loading = true;
    state.error = null;

    try {
      const response = await fetch(ENDPOINT, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "x-sovereign-enforcement-loader": VERSION
        }
      });

      const text = await response.text();
      let data = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch (err) {
        throw new Error("Command Centre endpoint returned non-JSON response.");
      }

      if (!response.ok) {
        throw new Error(data && data.error ? data.error : "Command Centre endpoint HTTP " + response.status);
      }

      if (!data || typeof data !== "object") {
        throw new Error("Command Centre endpoint returned empty response.");
      }

      state.data = data;
      state.enforcement = data.enforcement || null;
      state.loaded = true;
      state.loadedAt = new Date().toISOString();
      state.error = null;
    } catch (err) {
      state.error = err.message || String(err);
      state.loaded = false;
      state.data = null;
      state.enforcement = null;
      console.warn("[SovereignEnforcement v" + VERSION + "] load failed:", state.error);
    } finally {
      state.loading = false;
      notify();
      applyCurrentRouteGate();
    }

    return api.snapshot();
  }

  function findRoute(path) {
    const wanted = normalizePath(path);
    const enforcement = state.enforcement || {};
    const routes = safeArray(enforcement.routes);

    return routes.find(route => normalizePath(route.route) === wanted) || null;
  }

  function findAction(action) {
    const enforcement = state.enforcement || {};
    const actions = safeArray(enforcement.actions);

    return actions.find(item => item.action === action) || null;
  }

  function statusForRoute(path) {
    const route = findRoute(path);

    if (!route) {
      return {
        status: "unknown",
        label: "Unknown",
        level: 0,
        view_allowed: true,
        actions_allowed: false,
        reason: "No route enforcement policy returned for this route.",
        source: "enforcement.routes",
        required_fix: "Register route in /api/finance-command-center enforcement.routes.",
        override: {
          allowed: false,
          reason_required: true
        },
        raw: null
      };
    }

    let status = String(route.status || "unknown");
    let label = status.replace(/_/g, " ");

    if (route.view_allowed && route.actions_allowed && status === "pass") label = "Pass";
    if (route.view_allowed && !route.actions_allowed) label = "View only";
    if (status === "warn" || status === "warning") label = "Warning";
    if (!route.view_allowed || status === "blocked") label = "Blocked";

    return {
      status,
      label,
      level: Number(route.level || 0),
      view_allowed: Boolean(route.view_allowed),
      actions_allowed: Boolean(route.actions_allowed),
      reason: route.reason || "",
      source: route.source || "",
      required_fix: route.required_fix || "",
      override: route.override || {
        allowed: false,
        reason_required: true
      },
      raw: route
    };
  }

  function statusForCurrentRoute() {
    return statusForRoute(window.location.pathname);
  }

  function statusClass(value) {
    return String(value || "unknown").toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  }

  function ensureRouteGateCss() {
    let style = document.querySelector('style[data-sf-route-gate-css="true"]');
    if (style) return;

    style = document.createElement("style");
    style.dataset.sfRouteGateCss = "true";
    style.textContent = `
      .sf-route-gate-banner{
        box-sizing:border-box;
        width:min(1120px,calc(100vw - 32px));
        margin:14px auto;
        padding:12px 14px;
        border-radius:18px;
        border:1px solid rgba(37,99,235,.22);
        background:linear-gradient(135deg,#eff6ff,#f8fafc);
        color:#0f172a;
        box-shadow:0 16px 38px rgba(15,23,42,.10);
        font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        position:relative;
        z-index:20;
      }
      .sf-route-gate-banner strong{
        display:block;
        font-size:13px;
        line-height:1.25;
        margin-bottom:4px;
      }
      .sf-route-gate-banner span{
        display:block;
        font-size:12px;
        line-height:1.35;
        color:#334155;
      }
      .sf-route-gate-banner a{
        color:#1d4ed8;
        font-weight:800;
        text-decoration:none;
      }
      .sf-route-gate-overlay{
        position:fixed;
        inset:0;
        z-index:999999;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:22px;
        background:rgba(15,23,42,.72);
        backdrop-filter:blur(12px);
        font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      }
      .sf-route-gate-card{
        width:min(680px,calc(100vw - 32px));
        border-radius:26px;
        border:1px solid rgba(248,113,113,.35);
        background:linear-gradient(145deg,#fff7ed,#ffffff);
        color:#0f172a;
        box-shadow:0 30px 90px rgba(0,0,0,.34);
        overflow:hidden;
      }
      .sf-route-gate-card header{
        padding:22px 24px 14px;
        border-bottom:1px solid rgba(15,23,42,.08);
      }
      .sf-route-gate-card header small{
        display:inline-flex;
        align-items:center;
        width:fit-content;
        padding:5px 9px;
        border-radius:999px;
        border:1px solid rgba(220,38,38,.22);
        background:#fee2e2;
        color:#991b1b;
        font-size:11px;
        font-weight:1000;
        text-transform:uppercase;
        letter-spacing:.06em;
        margin-bottom:10px;
      }
      .sf-route-gate-card h2{
        margin:0;
        font-size:24px;
        line-height:1.1;
        letter-spacing:-.03em;
      }
      .sf-route-gate-card section{
        padding:18px 24px 6px;
      }
      .sf-route-gate-row{
        display:grid;
        grid-template-columns:130px 1fr;
        gap:12px;
        padding:10px 0;
        border-bottom:1px solid rgba(15,23,42,.07);
        font-size:13px;
        line-height:1.4;
      }
      .sf-route-gate-row b{
        color:#475569;
      }
      .sf-route-gate-actions{
        display:flex;
        flex-wrap:wrap;
        gap:10px;
        padding:18px 24px 24px;
      }
      .sf-route-gate-actions a,
      .sf-route-gate-actions button{
        appearance:none;
        border:0;
        border-radius:14px;
        padding:11px 14px;
        font-size:13px;
        font-weight:900;
        text-decoration:none;
        cursor:pointer;
      }
      .sf-route-gate-actions a{
        background:#0f172a;
        color:white;
      }
      .sf-route-gate-actions button{
        background:#e2e8f0;
        color:#0f172a;
      }
      html[data-sf-route-actions-allowed="false"] [data-command-action],
      html[data-sf-route-actions-allowed="false"] [data-finance-action],
      html[data-sf-route-actions-allowed="false"] [data-action],
      html[data-sf-route-actions-allowed="false"] button[type="submit"]{
        outline:2px solid rgba(220,38,38,.28);
      }
    `;
    document.head.appendChild(style);
  }

  function removeExistingGateUi() {
    document.querySelectorAll(".sf-route-gate-banner, .sf-route-gate-overlay").forEach(node => node.remove());
  }

  function buildReasonText(routeStatus) {
    return routeStatus.reason || "Route is not cleared by Command Centre policy.";
  }

  function buildSourceText(routeStatus) {
    return routeStatus.source || "enforcement.routes";
  }

  function buildFixText(routeStatus) {
    return routeStatus.required_fix || "Open Command Centre and resolve the route gate.";
  }

  function renderViewOnlyBanner(routeStatus) {
    if (!document.body) return;

    const banner = document.createElement("div");
    banner.className = "sf-route-gate-banner";
    banner.dataset.sfRouteGate = "view-only";
    banner.innerHTML = `
      <strong>View-only route: actions stay blocked here.</strong>
      <span>${escapeHtml(buildReasonText(routeStatus))}</span>
      <span>Source: ${escapeHtml(buildSourceText(routeStatus))} · Fix: ${escapeHtml(buildFixText(routeStatus))} · <a href="${COMMAND_CENTRE_ROUTE}">Open Command Centre</a></span>
    `;

    const nav = document.querySelector(".sf-shell-nav");
    if (nav && nav.nextSibling) {
      nav.parentNode.insertBefore(banner, nav.nextSibling);
    } else {
      document.body.insertAdjacentElement("afterbegin", banner);
    }
  }

  function renderBlockedOverlay(routeStatus, attemptedRoute) {
    if (!document.body) return;

    const overlay = document.createElement("div");
    overlay.className = "sf-route-gate-overlay";
    overlay.dataset.sfRouteGate = "blocked";
    overlay.innerHTML = `
      <div class="sf-route-gate-card" role="dialog" aria-modal="true" aria-label="Route blocked by Command Centre">
        <header>
          <small>Route blocked</small>
          <h2>This page is blocked by Command Centre.</h2>
        </header>
        <section>
          <div class="sf-route-gate-row">
            <b>Blocked</b>
            <span>${escapeHtml(attemptedRoute || normalizePath(window.location.pathname))}</span>
          </div>
          <div class="sf-route-gate-row">
            <b>Reason</b>
            <span>${escapeHtml(buildReasonText(routeStatus))}</span>
          </div>
          <div class="sf-route-gate-row">
            <b>Source/check</b>
            <span>${escapeHtml(buildSourceText(routeStatus))}</span>
          </div>
          <div class="sf-route-gate-row">
            <b>Required fix</b>
            <span>${escapeHtml(buildFixText(routeStatus))}</span>
          </div>
          <div class="sf-route-gate-row">
            <b>Override</b>
            <span>${routeStatus.override && routeStatus.override.allowed ? "Allowed by backend policy." : "Not available in this phase."}</span>
          </div>
        </section>
        <div class="sf-route-gate-actions">
          <a href="${COMMAND_CENTRE_ROUTE}">Open Command Centre</a>
          <button type="button" data-sf-route-gate-dismiss>Stay here</button>
        </div>
      </div>
    `;

    overlay.addEventListener("click", event => {
      if (event.target && event.target.matches("[data-sf-route-gate-dismiss]")) {
        overlay.remove();
      }
    });

    document.body.appendChild(overlay);
  }

  function applyDocumentDatasets(routeStatus) {
    const html = document.documentElement;
    if (!html) return;

    html.dataset.sfRouteGateVersion = VERSION;
    html.dataset.sfRouteStatus = statusClass(routeStatus.status);
    html.dataset.sfRouteViewAllowed = routeStatus.view_allowed ? "true" : "false";
    html.dataset.sfRouteActionsAllowed = routeStatus.actions_allowed ? "true" : "false";
    html.dataset.sfRouteGateLoaded = state.loaded ? "true" : "false";
    html.dataset.sfRouteGateSource = routeStatus.source || "unknown";
  }

  function applyCurrentRouteGate() {
    if (!document.body) return;

    ensureRouteGateCss();
    removeExistingGateUi();

    const current = normalizePath(window.location.pathname);
    const routeStatus = statusForRoute(current);

    applyDocumentDatasets(routeStatus);

    if (!state.loaded) {
      return;
    }

    if (current === COMMAND_CENTRE_ROUTE) {
      return;
    }

    if (!routeStatus.view_allowed || routeStatus.status === "blocked") {
      renderBlockedOverlay(routeStatus, current);
      return;
    }

    if (routeStatus.view_allowed && !routeStatus.actions_allowed) {
      renderViewOnlyBanner(routeStatus);
    }
  }

  function shouldGateLink(url) {
    if (!url) return false;

    const target = new URL(url, window.location.origin);

    if (target.origin !== window.location.origin) return false;
    if (normalizePath(target.pathname) === COMMAND_CENTRE_ROUTE) return false;
    if (target.pathname.startsWith("/api/")) return false;

    return true;
  }

    function handleDocumentClick(event) {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;

    if (link && shouldGateLink(link.href)) {
      const target = new URL(link.href, window.location.origin);
      const routeStatus = statusForRoute(target.pathname);

      if (state.loaded && (!routeStatus.view_allowed || routeStatus.status === "blocked")) {
        event.preventDefault();
        event.stopPropagation();
        ensureRouteGateCss();
        renderBlockedOverlay(routeStatus, normalizePath(target.pathname));
        return;
      }
    }

    const actionTarget = event.target && event.target.closest
      ? event.target.closest("[data-command-action], [data-finance-action], [data-action], button[type='submit'], input[type='submit']")
      : null;

    if (!actionTarget || !state.loaded) return;

    const activeRouteStatus = statusForCurrentRoute();

    if (activeRouteStatus.view_allowed && !activeRouteStatus.actions_allowed) {
      event.preventDefault();
      event.stopPropagation();
      ensureRouteGateCss();
      renderBlockedOverlay(activeRouteStatus, normalizePath(window.location.pathname));
    }
  }
    function handleDocumentSubmit(event) {
    if (!state.loaded) return;

    const activeRouteStatus = statusForCurrentRoute();

    if (activeRouteStatus.view_allowed && !activeRouteStatus.actions_allowed) {
      event.preventDefault();
      event.stopPropagation();
      ensureRouteGateCss();
      renderBlockedOverlay(activeRouteStatus, normalizePath(window.location.pathname));
    }
  }

  function snapshot() {
    return {
      version: VERSION,
      endpoint: ENDPOINT,
      loaded: state.loaded,
      loading: state.loading,
      loaded_at: state.loadedAt,
      error: state.error,
      data: state.data,
      enforcement: state.enforcement,
      findRoute,
      findAction,
      statusForRoute,
      statusForCurrentRoute,
      applyCurrentRouteGate
    };
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function noop() {};

    state.subscribers.push(fn);

    try {
      fn(api.snapshot());
    } catch (err) {
      console.warn("[SovereignEnforcement v" + VERSION + "] immediate subscriber failed:", err);
    }

    return function unsubscribe() {
      state.subscribers = state.subscribers.filter(item => item !== fn);
    };
  }

  const api = {
    version: VERSION,
    endpoint: ENDPOINT,
    refresh,
    subscribe,
    snapshot,
    findRoute,
    findAction,
    statusForRoute,
    statusForCurrentRoute,
    applyCurrentRouteGate,
    get loaded() {
      return state.loaded;
    },
    get data() {
      return state.data;
    },
    get enforcement() {
      return state.enforcement;
    },
    get error() {
      return state.error;
    }
  };

  window.SovereignEnforcement = api;

  document.addEventListener("click", handleDocumentClick, true);   document.addEventListener("submit", handleDocumentSubmit, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyCurrentRouteGate);
  } else {
    applyCurrentRouteGate();
  }

  refresh();
  window.setInterval(refresh, REFRESH_MS);
})();
