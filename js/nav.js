/* Sovereign Finance Navigation Shell v2.0.0
   Premium banking-ready sidebar + mobile drawer + theme wiring.
   Frontend-only. No finance logic. No backend writes.
*/

(function () {
  "use strict";

  const VERSION = "2.0.0";
  const ENFORCEMENT_SRC = "/js/enforcement.js?v=0.2.0";
  const THEME_KEY = "sovereign-finance-theme";

  const NAV_GROUPS = [
    {
      label: "Overview",
      items: [
        { label: "Finance Hub", route: "/index.html", icon: "dashboard" },
        { label: "Command Centre", route: "/monthly-close.html", icon: "shield" }
      ]
    },
    {
      label: "Money Movement",
      items: [
        { label: "Add Transaction", route: "/add.html", icon: "plus" },
        { label: "Transactions", route: "/transactions.html", icon: "ledger" },
        { label: "Accounts", route: "/accounts.html", icon: "wallet" }
      ]
    },
    {
      label: "Obligations",
      items: [
        { label: "Bills", route: "/bills.html", icon: "receipt" },
        { label: "Debts", route: "/debts.html", icon: "scale" },
        { label: "Credit Card", route: "/cc.html", icon: "card" }
      ]
    },
    {
      label: "Planning",
      items: [
        { label: "Forecast", route: "/forecast.html", icon: "chart" },
        { label: "Salary", route: "/salary.html", icon: "salary" },
        { label: "Reconciliation", route: "/reconciliation.html", icon: "check" }
      ]
    }
  ];

  const ICONS = {
    dashboard: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
    `,
    shield: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3 5 6v5c0 4.55 2.9 8.75 7 10 4.1-1.25 7-5.45 7-10V6l-7-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `,
    plus: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M4 4h16v16H4V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity=".42"/>
      </svg>
    `,
    ledger: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 4h12v16H6V4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `,
    wallet: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v4H6.5A2.5 2.5 0 0 1 4 6.5v11A2.5 2.5 0 0 0 6.5 20H20V9H6.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M16.5 14h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `,
    receipt: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 4h10v16l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2V4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `,
    scale: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4v16M6 20h12M7 7h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M7 7 4 13h6L7 7ZM17 7l-3 6h6l-3-6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
    `,
    card: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7h16v10H4V7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M4 10h16M7 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `,
    chart: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 19V5M4 19h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="m7 15 3-4 3 2 4-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `,
    salary: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7h16v10H4V7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" stroke-width="1.8"/>
        <path d="M6.5 9.5v5M17.5 9.5v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    `,
    check: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0Z" stroke="currentColor" stroke-width="1.8"/>
        <path d="m8.5 12.5 2.2 2.2 4.8-5.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `,
    menu: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `,
    moon: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
    `,
    sun: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" stroke-width="1.8"/>
        <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `
  };

  function normalizePath(path) {
    const raw = String(path || "/").split("?")[0].split("#")[0];
    if (raw === "/" || raw === "") return "/index.html";
    if (raw.endsWith("/")) return raw + "index.html";
    return raw;
  }

  function currentPath() {
    return normalizePath(window.location.pathname);
  }

  function icon(name) {
    return `<span class="sf-nav-icon">${ICONS[name] || ICONS.dashboard}</span>`;
  }

  function isActive(route) {
    return normalizePath(route) === currentPath();
  }

  function pageTitleFromDom() {
    const legacyTitle = document.querySelector("body > header:not(.sf-topbar) .title");
    if (legacyTitle && legacyTitle.textContent.trim()) return legacyTitle.textContent.trim();

    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();

    return (document.title || "Sovereign Finance").replace(/\s*-\s*Sovereign Finance\s*$/i, "").trim() || "Sovereign Finance";
  }

  function pageEyebrowFromPath() {
    const path = currentPath();
    const found = NAV_GROUPS.flatMap(group => group.items).find(item => normalizePath(item.route) === path);
    if (found) return found.label;
    return "Sovereign Finance";
  }

  function applyTheme(theme) {
    const selected = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", selected);
    document.body.setAttribute("data-theme", selected);
    localStorage.setItem(THEME_KEY, selected);
    updateThemeButton();
  }

  function initialTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return "dark";
  }

  function updateThemeButton() {
    const btn = document.querySelector("[data-sf-theme-toggle]");
    if (!btn) return;

    const theme = document.documentElement.getAttribute("data-theme") || "dark";
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    btn.innerHTML = theme === "dark" ? ICONS.sun : ICONS.moon;
  }

  function hideLegacyHeader() {
    document.querySelectorAll("body > header:not(.sf-topbar)").forEach(header => {
      header.setAttribute("data-sf-legacy-header", "true");
      header.style.display = "none";
    });
  }

  function buildSidebar() {
    const groups = NAV_GROUPS.map(group => {
      const links = group.items.map(item => {
        const active = isActive(item.route);
        return `
          <a class="sf-nav-link${active ? " active" : ""}"
             href="${item.route}"
             data-sf-nav-route="${item.route}"
             ${active ? 'aria-current="page"' : ""}>
            ${icon(item.icon)}
            <span>${item.label}</span>
          </a>
        `;
      }).join("");

      return `
        <div class="sf-nav-group">
          <div class="sf-nav-group-label">${group.label}</div>
          ${links}
        </div>
      `;
    }).join("");

    return `
      <aside class="sf-sidebar" data-sf-sidebar>
        <div class="sf-sidebar-brand">
          <div class="sf-brand-mark">SF</div>
          <div class="sf-brand-title">Sovereign Finance</div>
          <div class="sf-brand-subtitle">Personal command system</div>
        </div>

        <nav class="sf-nav-scroll" aria-label="Finance navigation">
          ${groups}
        </nav>

        <div class="sf-sidebar-footer">
          <a class="sf-nav-link" href="/monthly-close.html" data-sf-command-link>
            ${icon("shield")}
            <span>Authority Check</span>
          </a>
        </div>
      </aside>
    `;
  }

  function buildTopbar() {
    return `
      <header class="sf-topbar" data-sf-topbar>
        <div class="sf-topbar-left">
          <button class="sf-mobile-menu" type="button" data-sf-mobile-menu aria-label="Open navigation">
            ${ICONS.menu}
          </button>
          <div>
            <div class="sf-page-eyebrow">${pageEyebrowFromPath()}</div>
            <div class="sf-page-title">${pageTitleFromDom()}</div>
          </div>
        </div>

        <button class="sf-theme-toggle" type="button" data-sf-theme-toggle aria-label="Toggle theme">
          ${ICONS.sun}
        </button>
      </header>
    `;
  }

  function removeExistingShell() {
    document.querySelectorAll("[data-sf-sidebar], [data-sf-topbar], [data-sf-overlay]").forEach(node => node.remove());
  }

  function openNav() {
    document.body.classList.add("sf-nav-open");
  }

  function closeNav() {
    document.body.classList.remove("sf-nav-open");
  }

  function wireShellEvents() {
    const menu = document.querySelector("[data-sf-mobile-menu]");
    const overlay = document.querySelector("[data-sf-overlay]");
    const theme = document.querySelector("[data-sf-theme-toggle]");

    if (menu) menu.addEventListener("click", openNav);
    if (overlay) overlay.addEventListener("click", closeNav);

    document.querySelectorAll(".sf-nav-link").forEach(link => {
      link.addEventListener("click", closeNav);
    });

    if (theme) {
      theme.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("data-theme") || "dark";
        applyTheme(current === "dark" ? "light" : "dark");
      });
    }

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeNav();
    });
  }

  function ensureEnforcementLoaded() {
    window.setTimeout(() => {
      if (window.SovereignEnforcement) return;

      const existing = Array.from(document.querySelectorAll("script[src]"))
        .some(script => String(script.getAttribute("src") || "").includes("/js/enforcement.js"));

      if (existing) return;

      const script = document.createElement("script");
      script.src = ENFORCEMENT_SRC;
      script.defer = true;
      script.dataset.sfLoadedByNav = VERSION;
      document.head.appendChild(script);
    }, 0);
  }

  function decorateNavFromEnforcement(snapshot) {
    const enforcement = snapshot && snapshot.enforcement ? snapshot.enforcement : null;
    const routes = enforcement && Array.isArray(enforcement.routes) ? enforcement.routes : [];

    document.querySelectorAll("[data-sf-nav-route]").forEach(link => {
      const route = normalizePath(link.getAttribute("data-sf-nav-route"));
      const found = routes.find(item => normalizePath(item.route) === route);

      link.removeAttribute("data-sf-route-status");
      link.removeAttribute("title");

      if (!found) {
        link.setAttribute("data-sf-route-status", "unknown");
        return;
      }

      link.setAttribute("data-sf-route-status", found.status || "unknown");

      const label = found.actions_allowed
        ? "Actions allowed"
        : found.view_allowed
          ? "View only"
          : "Blocked";

      link.setAttribute("title", `${label}: ${found.reason || "No reason returned"}`);
    });
  }

  function subscribeEnforcement() {
    window.setTimeout(() => {
      if (!window.SovereignEnforcement || typeof window.SovereignEnforcement.subscribe !== "function") return;

      window.SovereignEnforcement.subscribe(decorateNavFromEnforcement);

      if (typeof window.SovereignEnforcement.refresh === "function") {
        window.SovereignEnforcement.refresh();
      }
    }, 80);
  }

  function mountShell() {
    applyTheme(initialTheme());
    hideLegacyHeader();
    removeExistingShell();

    const overlay = document.createElement("div");
    overlay.className = "sf-overlay";
    overlay.dataset.sfOverlay = "true";

    document.body.insertAdjacentHTML("afterbegin", buildSidebar() + buildTopbar());
    document.body.appendChild(overlay);

    wireShellEvents();
    updateThemeButton();
    ensureEnforcementLoaded();
    subscribeEnforcement();

    document.documentElement.dataset.sfNavVersion = VERSION;
  }

  const api = {
    version: VERSION,
    mount: mountShell,
    open: openNav,
    close: closeNav,
    theme: {
      apply: applyTheme,
      current: () => document.documentElement.getAttribute("data-theme") || "dark"
    },
    routes: () => NAV_GROUPS.flatMap(group => group.items).map(item => ({ ...item }))
  };

  window.SovereignNav = api;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountShell);
  } else {
    mountShell();
  }
})();
