/* Sovereign Finance App Navigation v2.0.3
 *
 * Frontend-only app shell.
 * - Builds left sidebar and topbar.
 * - Adds working desktop fold/unfold rail.
 * - Mobile keeps drawer behavior.
 * - Remembers folded state.
 * - Does not touch finance data.
 * - Does not call Command Centre.
 */
(function () {
  "use strict";

  const VERSION = "2.0.3";
  const STORAGE_KEY = "sf_sidebar_collapsed_v1";
  const THEME_KEY = "sf_theme_v1";

  const NAV_GROUPS = [
    {
      label: "Core",
      items: [
        { href: "/index.html", label: "Finance Hub", icon: "home", match: ["/", "/index.html"] },
        { href: "/add.html", label: "Add Transaction", icon: "plus", match: ["/add.html"] },
        { href: "/transactions.html", label: "Transactions", icon: "ledger", match: ["/transactions.html"] },
        { href: "/accounts.html", label: "Accounts", icon: "wallet", match: ["/accounts.html"] }
      ]
    },
    {
      label: "Planning",
      items: [
        { href: "/bills.html", label: "Bills", icon: "receipt", match: ["/bills.html"] },
        { href: "/debts.html", label: "Debts", icon: "debt", match: ["/debts.html"] },
        { href: "/salary.html", label: "Salary", icon: "salary", match: ["/salary.html"] },
        { href: "/forecast.html", label: "Forecast", icon: "forecast", match: ["/forecast.html"] }
      ]
    },
    {
      label: "Control",
      items: [
        { href: "/reconciliation.html", label: "Reconciliation", icon: "recon", match: ["/reconciliation.html"] },
        { href: "/cc.html", label: "Credit Card", icon: "card", match: ["/cc.html"] },
        { href: "/monthly-close.html", label: "Command Centre", icon: "command", match: ["/monthly-close.html"] }
      ]
    }
  ];

  const PAGE_TITLES = {
    "/index.html": ["Sovereign Finance", "Finance Hub"],
    "/add.html": ["Governed money entry", "Add Transaction"],
    "/transactions.html": ["Ledger reader", "Transactions"],
    "/accounts.html": ["Account balances", "Accounts"],
    "/bills.html": ["Monthly obligations", "Bills"],
    "/debts.html": ["Debt control", "Debts"],
    "/reconciliation.html": ["Reality check", "Reconciliation"],
    "/salary.html": ["Income control", "Salary"],
    "/forecast.html": ["Forward view", "Forecast"],
    "/cc.html": ["Liability control", "Credit Card"],
    "/monthly-close.html": ["Truth and audit", "Command Centre"]
  };

  function normalizePath(path) {
    let value = String(path || window.location.pathname || "/").split("?")[0].split("#")[0];
    if (value === "/" || value === "") return "/index.html";
    if (!value.endsWith(".html")) value = value.replace(/\/$/, "") + ".html";
    return value;
  }

  function currentPath() {
    return normalizePath(window.location.pathname);
  }

  function isCurrent(item) {
    const path = currentPath();
    return (item.match || [item.href]).map(normalizePath).includes(path);
  }

  function pageMeta() {
    const path = currentPath();
    return PAGE_TITLES[path] || ["Sovereign Finance", document.title || "Dashboard"];
  }

  function readStoredCollapsed() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (err) {
      return false;
    }
  }

  function writeStoredCollapsed(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch (err) {}
  }

  function readTheme() {
    try {
      return localStorage.getItem(THEME_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function writeTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {}
  }

  function applyTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    document.body.setAttribute("data-theme", next);

    const button = document.querySelector("[data-sf-theme-toggle]");
    if (button) {
      button.setAttribute("aria-label", next === "dark" ? "Use light theme" : "Use dark theme");
      button.innerHTML = icon(next === "dark" ? "sun" : "moon");
    }
  }

  function initTheme() {
    const stored = readTheme();
    if (stored === "dark" || stored === "light") {
      applyTheme(stored);
      return;
    }

    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(prefersDark ? "dark" : "light");
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    writeTheme(next);
    applyTheme(next);
  }

  function applyCollapsed(value) {
    const collapsed = Boolean(value);
    document.body.classList.toggle("sf-sidebar-collapsed", collapsed);
    document.documentElement.dataset.sfSidebarCollapsed = collapsed ? "true" : "false";

    const button = document.querySelector("[data-sf-sidebar-fold]");
    if (button) {
      button.setAttribute("aria-pressed", collapsed ? "true" : "false");
      button.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Fold sidebar");
      button.setAttribute("title", collapsed ? "Expand sidebar" : "Fold sidebar");
      button.innerHTML =
        '<span class="sf-fold-icon" aria-hidden="true">' +
        (collapsed ? icon("chevron-right") : icon("chevron-left")) +
        '</span><span class="sf-fold-text">' +
        (collapsed ? "Expand" : "Fold") +
        "</span>";
    }
  }

  function toggleCollapsed() {
    const next = !document.body.classList.contains("sf-sidebar-collapsed");
    writeStoredCollapsed(next);
    applyCollapsed(next);
  }

  function openMobileNav() {
    document.body.classList.add("sf-nav-open");
  }

  function closeMobileNav() {
    document.body.classList.remove("sf-nav-open");
  }

  function icon(name) {
    const paths = {
      home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
      plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
      ledger: '<path d="M5 4h14v16H5z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
      wallet: '<path d="M4 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4z"/><path d="M4 7V5a2 2 0 0 1 2-2h11v4"/><path d="M16 13h5"/>',
      receipt: '<path d="M6 3h12v18l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2L6 21z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/>',
      debt: '<path d="M4 7h16"/><path d="M6 7v12"/><path d="M18 7v12"/><path d="M8 11h8"/><path d="M8 15h5"/><path d="M12 3v4"/>',
      salary: '<path d="M12 3v18"/><path d="M17 7.5c0-2-2-3-5-3s-5 1-5 3 2 3 5 3 5 1 5 3-2 3-5 3-5-1-5-3"/>',
      forecast: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 3-4 3 2 5-7"/>',
      recon: '<path d="M4 7h11"/><path d="m12 4 3 3-3 3"/><path d="M20 17H9"/><path d="m12 14-3 3 3 3"/>',
      card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/>',
      command: '<path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="M12 8v8"/><path d="M8 10.5 12 8l4 2.5"/>',
      menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
      moon: '<path d="M21 13.2A8 8 0 1 1 10.8 3a6.5 6.5 0 0 0 10.2 10.2z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
      "chevron-left": '<path d="m15 18-6-6 6-6"/>',
      "chevron-right": '<path d="m9 18 6-6-6-6"/>'
    };

    return (
      '<svg class="sf-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (paths[name] || paths.home) +
      "</svg>"
    );
  }

  function navLink(item) {
    const active = isCurrent(item);
    return (
      '<a class="sf-nav-link' +
      (active ? " active" : "") +
      '" href="' +
      item.href +
      '"' +
      (active ? ' aria-current="page"' : "") +
      ' title="' +
      escapeHtml(item.label) +
      '">' +
      icon(item.icon) +
      '<span class="sf-nav-label">' +
      escapeHtml(item.label) +
      "</span>" +
      "</a>"
    );
  }

  function sidebarHtml() {
    return (
      '<aside class="sf-sidebar" aria-label="Sovereign Finance navigation">' +
      '<div class="sf-sidebar-brand">' +
      '<a class="sf-brand-home" href="/index.html" aria-label="Sovereign Finance home">' +
      '<span class="sf-brand-mark">SF</span>' +
      '<span class="sf-brand-copy">' +
      '<span class="sf-brand-title">Sovereign Finance</span>' +
      '<span class="sf-brand-subtitle">Private finance cockpit</span>' +
      "</span>" +
      "</a>" +
      '<button class="sf-sidebar-fold" type="button" data-sf-sidebar-fold aria-label="Fold sidebar"></button>' +
      "</div>" +
      '<nav class="sf-nav-scroll">' +
      NAV_GROUPS.map(group => {
        return (
          '<section class="sf-nav-group">' +
          '<div class="sf-nav-group-label">' +
          escapeHtml(group.label) +
          "</div>" +
          group.items.map(navLink).join("") +
          "</section>"
        );
      }).join("") +
      "</nav>" +
      '<div class="sf-sidebar-footer">' +
      '<div class="sf-sidebar-footer-title">Mode</div>' +
      '<div class="sf-sidebar-footer-copy">Manual control · audit aware</div>' +
      "</div>" +
      "</aside>"
    );
  }

  function topbarHtml() {
    const meta = pageMeta();

    return (
      '<div class="sf-overlay" data-sf-overlay></div>' +
      '<header class="sf-topbar">' +
      '<div class="sf-topbar-left">' +
      '<button class="sf-mobile-menu" type="button" data-sf-mobile-menu aria-label="Open navigation">' +
      icon("menu") +
      "</button>" +
      '<div>' +
      '<div class="sf-page-eyebrow">' +
      escapeHtml(meta[0]) +
      "</div>" +
      '<div class="sf-page-title">' +
      escapeHtml(meta[1]) +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="sf-topbar-right">' +
      '<button class="sf-theme-toggle" type="button" data-sf-theme-toggle aria-label="Toggle theme"></button>' +
      "</div>" +
      "</header>"
    );
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function removeLegacyHeaderIfDuplicated() {
    const topbar = document.querySelector(".sf-topbar");
    if (!topbar) return;

    const legacy = document.querySelector("body > header:not(.sf-topbar)");
    if (legacy) {
      legacy.style.display = "none";
      legacy.setAttribute("aria-hidden", "true");
    }
  }

  function installShell() {
    if (!document.body) return;

    if (!document.querySelector(".sf-sidebar")) {
      document.body.insertAdjacentHTML("afterbegin", sidebarHtml());
    }

    if (!document.querySelector(".sf-topbar")) {
      const sidebar = document.querySelector(".sf-sidebar");
      if (sidebar) {
        sidebar.insertAdjacentHTML("afterend", topbarHtml());
      } else {
        document.body.insertAdjacentHTML("afterbegin", topbarHtml());
      }
    }

    removeLegacyHeaderIfDuplicated();
  }

  function wireEvents() {
    const fold = document.querySelector("[data-sf-sidebar-fold]");
    if (fold && !fold.dataset.sfWired) {
      fold.dataset.sfWired = "true";
      fold.addEventListener("click", toggleCollapsed);
    }

    const mobile = document.querySelector("[data-sf-mobile-menu]");
    if (mobile && !mobile.dataset.sfWired) {
      mobile.dataset.sfWired = "true";
      mobile.addEventListener("click", openMobileNav);
    }

    const overlay = document.querySelector("[data-sf-overlay]");
    if (overlay && !overlay.dataset.sfWired) {
      overlay.dataset.sfWired = "true";
      overlay.addEventListener("click", closeMobileNav);
    }

    const theme = document.querySelector("[data-sf-theme-toggle]");
    if (theme && !theme.dataset.sfWired) {
      theme.dataset.sfWired = "true";
      theme.addEventListener("click", toggleTheme);
    }

    document.querySelectorAll(".sf-nav-link").forEach(link => {
      if (link.dataset.sfWired) return;
      link.dataset.sfWired = "true";
      link.addEventListener("click", closeMobileNav);
    });

    window.addEventListener("keydown", event => {
      if (event.key === "Escape") closeMobileNav();
    });
  }

  function exposeApi() {
    window.SovereignNav = {
      version: VERSION,
      collapse: function () {
        writeStoredCollapsed(true);
        applyCollapsed(true);
      },
      expand: function () {
        writeStoredCollapsed(false);
        applyCollapsed(false);
      },
      toggle: toggleCollapsed,
      isCollapsed: function () {
        return document.body.classList.contains("sf-sidebar-collapsed");
      }
    };
  }

  function init() {
    console.log("[nav v" + VERSION + "] init");

    initTheme();
    installShell();
    wireEvents();
    applyCollapsed(readStoredCollapsed());
    exposeApi();

    console.log("[nav v" + VERSION + "] ready", {
      collapsed: document.body.classList.contains("sf-sidebar-collapsed"),
      path: currentPath()
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
