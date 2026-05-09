/* Sovereign Finance Enforcement Bridge v0.3.0
 *
 * Purpose:
 * - Command Centre is an auditor/truth reader.
 * - This file must NOT inject blocking panels into normal pages.
 * - Read pages must keep working.
 * - Write pages may ask this bridge whether a specific action is allowed.
 *
 * Safe behavior:
 * - No DOM banners.
 * - No page hiding.
 * - No route blocking.
 * - No automatic disabling of forms.
 * - Backend remains final authority for money writes.
 */
(function () {
  "use strict";

  const VERSION = "0.3.0";
  const ENDPOINT = "/api/finance-command-center";

  const WRITE_ACTIONS = new Set([
    "transaction.save",
    "bill.save",
    "bill.clear",
    "debt.save",
    "debt.pay",
    "reconciliation.declare",
    "salary.save",
    "forecast.generate",
    "forecast.mark_ready",
    "cc.use_for_decision",
    "cc.use_for_forecast"
  ]);

  let state = {
    version: VERSION,
    loaded: false,
    loading: false,
    error: "",
    fetched_at: "",
    raw: null,
    enforcement: {
      actions: []
    }
  };

  const subscribers = new Set();

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (err) {
      return value;
    }
  }

  function notify() {
    const snapshot = getSnapshot();

    subscribers.forEach(fn => {
      try {
        fn(snapshot);
      } catch (err) {
        console.warn("[enforcement v" + VERSION + "] subscriber failed:", err);
      }
    });

    window.dispatchEvent(new CustomEvent("sovereign:enforcement", {
      detail: snapshot
    }));
  }

  function normalizeAction(action) {
    if (!action || typeof action !== "object") return null;

    const name = String(action.action || action.name || "").trim();
    if (!name) return null;

    const allowed = action.allowed === true;

    return {
      ...action,
      action: name,
      allowed,
      status: allowed ? "pass" : String(action.status || "blocked"),
      reason: allowed
        ? String(action.reason || "Allowed by Command Centre.")
        : String(action.reason || "Blocked by Command Centre."),
      required_fix: allowed
        ? String(action.required_fix || "None.")
        : String(action.required_fix || "Proof required before this write action is allowed."),
      source: String(action.source || "finance-command-center"),
      backend_enforced: action.backend_enforced !== false,
      frontend_enforced: false
    };
  }

  function extractActions(raw) {
    const candidates = [];

    if (raw && raw.enforcement && Array.isArray(raw.enforcement.actions)) {
      candidates.push(...raw.enforcement.actions);
    }

    if (raw && Array.isArray(raw.actions)) {
      candidates.push(...raw.actions);
    }

    if (raw && raw.governor && Array.isArray(raw.governor.actions)) {
      candidates.push(...raw.governor.actions);
    }

    const map = new Map();

    candidates.forEach(item => {
      const normalized = normalizeAction(item);
      if (normalized) map.set(normalized.action, normalized);
    });

    return Array.from(map.values());
  }

  function fallbackBlocked(action, reason) {
    return {
      action,
      allowed: false,
      status: "blocked",
      reason: reason || "No Command Centre proof found for this write action.",
      required_fix: "Run/prove this action before allowing real money writes.",
      source: "SovereignEnforcement fallback",
      backend_enforced: true,
      frontend_enforced: false,
      override: {
        allowed: false,
        reason_required: true
      }
    };
  }

  function getSnapshot() {
    const snapshot = clone(state);
    snapshot.findAction = findAction;
    snapshot.isAllowed = isAllowed;
    snapshot.requireAction = requireAction;
    snapshot.refresh = refresh;
    snapshot.subscribe = subscribe;
    return snapshot;
  }

  function findAction(action) {
    const name = String(action || "").trim();
    if (!name) return null;

    const actions = state.enforcement && Array.isArray(state.enforcement.actions)
      ? state.enforcement.actions
      : [];

    return actions.find(item => item && item.action === name) || null;
  }

  function isAllowed(action) {
    const found = findAction(action);
    return Boolean(found && found.allowed === true);
  }

  function requireAction(action) {
    const name = String(action || "").trim();

    if (!name) {
      return fallbackBlocked("unknown", "No action name was provided.");
    }

    const found = findAction(name);

    if (found) {
      return clone(found);
    }

    if (WRITE_ACTIONS.has(name)) {
      return fallbackBlocked(name);
    }

    return {
      action: name,
      allowed: true,
      status: "pass",
      reason: "Read/non-write actions are not blocked by the frontend enforcement bridge.",
      required_fix: "None.",
      source: "SovereignEnforcement read-safe policy",
      backend_enforced: false,
      frontend_enforced: false
    };
  }

  async function refresh() {
    if (state.loading) return getSnapshot();

    state = {
      ...state,
      loading: true,
      error: ""
    };
    notify();

    try {
      const response = await fetch(ENDPOINT + "?cb=" + Date.now(), {
        cache: "no-store",
        headers: {
          accept: "application/json",
          "x-sovereign-enforcement": VERSION
        }
      });

      const raw = await response.json().catch(() => null);

      if (!response.ok || !raw) {
        throw new Error((raw && raw.error) || "Command Centre returned HTTP " + response.status);
      }

      const actions = extractActions(raw);

      state = {
        version: VERSION,
        loaded: true,
        loading: false,
        error: "",
        fetched_at: new Date().toISOString(),
        raw,
        enforcement: {
          actions
        }
      };

      notify();
      return getSnapshot();
    } catch (err) {
      state = {
        ...state,
        loaded: false,
        loading: false,
        error: err.message || String(err),
        fetched_at: new Date().toISOString(),
        raw: null,
        enforcement: {
          actions: []
        }
      };

      console.warn("[enforcement v" + VERSION + "] Command Centre unavailable:", state.error);

      notify();
      return getSnapshot();
    }
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return function noop() {};

    subscribers.add(fn);

    try {
      fn(getSnapshot());
    } catch (err) {
      console.warn("[enforcement v" + VERSION + "] initial subscriber call failed:", err);
    }

    return function unsubscribe() {
      subscribers.delete(fn);
    };
  }

  window.SovereignEnforcement = {
    version: VERSION,
    endpoint: ENDPOINT,
    refresh,
    subscribe,
    getSnapshot,
    findAction,
    isAllowed,
    requireAction,
    get loaded() {
      return state.loaded;
    },
    get error() {
      return state.error;
    },
    get actions() {
      return clone(state.enforcement.actions || []);
    }
  };

  refresh();

  console.log("[enforcement v" + VERSION + "] non-invasive bridge loaded");
})();
