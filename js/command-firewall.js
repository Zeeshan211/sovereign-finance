(() => {
  "use strict";

  const VERSION = "1.5A.1";
  const COMMAND_PATH = "/api/finance-command-center";
  const CACHE_KEY = "sovereign.command_centre.cached.v1";
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const REAL_FETCH_TIMEOUT_MS = 1800;

  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const debug = params.get("debug") === "1";
  const isCommandCentre =
    path.includes("monthly-close") ||
    path.includes("command") ||
    document.title.toLowerCase().includes("command centre");

  if (isCommandCentre) {
    window.SovereignCommandFirewall = {
      version: VERSION,
      active: false,
      reason: "Command Centre page owns real audit fetches."
    };
    return;
  }

  const originalFetch = window.fetch.bind(window);

  window.SovereignCommandFirewall = {
    version: VERSION,
    active: true,
    mode: debug ? "debug" : "normal",
    cacheKey: CACHE_KEY,
    commandPath: COMMAND_PATH,
    refresh: refreshRealCommandCentre,
    getCached
  };

  window.fetch = function sovereignFirewallFetch(input, init) {
    const url = normalizeUrl(input);

    if (!isCommandCentreRequest(url)) {
      return originalFetch(input, init);
    }

    if (debug) {
      return fetchWithTimeout(input, init, REAL_FETCH_TIMEOUT_MS)
        .catch(() => responseFromJson(lightweightCommand("debug_timeout")));
    }

    refreshRealCommandCentre();

    const cached = getCached();
    if (cached) {
      return Promise.resolve(responseFromJson({
        ...cached,
        speed_firewall: {
          active: true,
          version: VERSION,
          mode: "cached",
          note: "Returned cached Command Centre snapshot so normal page load is not blocked."
        }
      }));
    }

    return Promise.resolve(responseFromJson(lightweightCommand("fallback")));
  };

  function normalizeUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isCommandCentreRequest(url) {
    try {
      const u = new URL(url, window.location.origin);
      return u.pathname === COMMAND_PATH;
    } catch {
      return String(url).includes(COMMAND_PATH);
    }
  }

  function responseFromJson(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-sovereign-command-firewall": VERSION
      }
    });
  }

  function getCached() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.saved_at || !parsed.payload) return null;

      const age = Date.now() - Number(parsed.saved_at);
      if (age > CACHE_TTL_MS) return null;

      return parsed.payload;
    } catch {
      return null;
    }
  }

  function setCached(payload) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        saved_at: Date.now(),
        payload
      }));
    } catch {
      // Cache failure must never break a normal page.
    }
  }

  let refreshInFlight = null;

  function refreshRealCommandCentre() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = fetchWithTimeout(
      `${COMMAND_PATH}?cb=${Date.now()}&source=normal_page_speed_firewall`,
      { method: "GET" },
      REAL_FETCH_TIMEOUT_MS
    )
      .then((res) => res.json())
      .then((json) => {
        setCached(json);
        return json;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });

    return refreshInFlight;
  }

  function fetchWithTimeout(input, init, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    return originalFetch(input, {
      ...(init || {}),
      signal: controller.signal
    }).finally(() => window.clearTimeout(timer));
  }

  function lightweightCommand(reason) {
    const allowed = [
      "transaction.preflight",
      "transaction.save",
      "bill.preflight",
      "bill.save",
      "bill.clear",
      "debt.preflight",
      "debt.save",
      "debt.pay",
      "reconciliation.declare",
      "salary.save",
      "forecast.generate",
      "override.request"
    ];

    const blocked = [
      {
        action: "override.apply",
        module: "system",
        allowed: false,
        status: "blocked",
        reason: "Command Centre does not directly apply overrides.",
        source: "speed_firewall.permanent_policy",
        required_fix: "Owning API must enforce any future override path."
      },
      {
        action: "override.silent_bypass",
        module: "system",
        allowed: false,
        status: "blocked",
        reason: "Silent bypass is permanently blocked.",
        source: "speed_firewall.permanent_policy",
        required_fix: "Never lift."
      },
      {
        action: "money_contracts.use_as_truth_source",
        module: "system",
        allowed: false,
        status: "blocked",
        reason: "/api/money-contracts is banned as a finance truth source.",
        source: "speed_firewall.permanent_policy",
        required_fix: "Never lift."
      }
    ];

    return {
      ok: true,
      version: "speed-firewall-lightweight",
      stale: true,
      source: "frontend.speed_firewall",
      reason,
      speed_firewall: {
        active: true,
        version: VERSION,
        mode: reason,
        note: "This is a fast frontend hint for normal pages only. Backend APIs remain authoritative."
      },
      enforcement: {
        actions: [
          ...allowed.map((action) => ({
            action,
            allowed: true,
            status: "allowed",
            reason: "Normal page speed firewall returned fast allow hint. Owning API still enforces real write rules.",
            source: "frontend.speed_firewall"
          })),
          ...blocked
        ]
      }
    };
  }
})();
