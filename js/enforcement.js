// js/enforcement.js
// v0.1.0 — Sovereign Command Centre enforcement policy loader
//
// Contract:
// - Read-only frontend helper.
// - Fetches /api/finance-command-center.
// - Exposes backend enforcement policy.
// - Does not block routes.
// - Does not disable buttons.
// - Does not write D1.
// - Does not mutate ledger.
// - Does not override backend verdict.

(function () {
  "use strict";

  const VERSION = "0.1.0";
  const ENDPOINT = "/api/finance-command-center";
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
        actions_allowed: true,
        reason: "No route enforcement policy returned for this route.",
        source: "enforcement.routes",
        required_fix: "Register route in /api/finance-command-center enforcement.routes."
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
      raw: route
    };
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
      statusForRoute
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

  refresh();

  window.setInterval(refresh, REFRESH_MS);
})();
