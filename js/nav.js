(function () {
  "use strict";

  const VERSION = "nav-internal-report-v2.1.0";

  const ROUTES = [
    { href: "/index.html", label: "Hub", icon: "⌂", keys: ["/", "/index.html", "/home.html"] },
    { href: "/add.html", label: "Add", icon: "＋", keys: ["/add.html", "/add"] },
    { href: "/transactions.html", label: "Ledger", icon: "≡", keys: ["/transactions.html", "/transactions", "/ledger.html", "/ledger"] },
    { href: "/bills.html", label: "Bills", icon: "◷", keys: ["/bills.html", "/bills"] },
    { href: "/debts.html", label: "Debts", icon: "↔", keys: ["/debts.html", "/debts"] },
    { href: "/salary.html", label: "Salary", icon: "₨", keys: ["/salary.html", "/salary"] },
    { href: "/forecast.html", label: "Forecast", icon: "⌁", keys: ["/forecast.html", "/forecast"] },
    { href: "/reconciliation.html", label: "Reconcile", icon: "✓", keys: ["/reconciliation.html", "/reconciliation", "/reconcile.html", "/reconcile"] },
    { href: "/accounts.html", label: "Accounts", icon: "◫", keys: ["/accounts.html", "/accounts"] },
    { href: "/cc.html", label: "Credit Card", icon: "▣", keys: ["/cc.html", "/cc", "/credit-card.html", "/credit-card"] }
  ];

  const INTERNAL_REPORT_ROUTE = {
    href: "/monthly-close.html",
    label: "Internal Report",
    icon: "◇",
    keys: ["/monthly-close.html", "/monthly-close"]
  };

  const pathname = normalizePath(window.location.pathname);
  const params = new URLSearchParams(window.location.search || "");
  const debugMode = params.get("debug") === "1";
  const internalPage = INTERNAL_REPORT_ROUTE.keys.includes(pathname);

  function normalizePath(path) {
    let value = String(path || "/").trim();

    if (!value.startsWith("/")) value = "/" + value;
    if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);

    return value || "/";
  }

  function isCurrent(route) {
    return route.keys.some(key => normalizePath(key) === pathname);
  }

  function shouldShowInternalReport() {
    return internalPage || debugMode;
  }

  function routeList() {
    const list = ROUTES.slice();

    if (shouldShowInternalReport()) {
      list.push(INTERNAL_REPORT_ROUTE);
    }

    return list;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function linkHtml(route) {
    const active = isCurrent(route);
    const cls = active ? "sf-nav-link active" : "sf-nav-link";
    const current = active ? ' aria-current="page"' : "";

    return (
      '<a class="' + cls + '" href="' + escapeHtml(route.href) + '"' + current + ">" +
        '<span class="sf-nav-icon">' + escapeHtml(route.icon) + "</span>" +
        '<span class="sf-nav-label">' + escapeHtml(route.label) + "</span>" +
      "</a>"
    );
  }

  function buildSidebarHtml() {
    return (
      '<aside class="sf-sidebar" aria-label="Sovereign Finance navigation">' +
        '<div class="sf-sidebar-brand">' +
          '<a class="sf-brand-home" href="/index.html">' +
            '<span class="sf-brand-mark">SF</span>' +
            '<span class="sf-brand-copy">' +
              '<span class="sf-brand-title">Sovereign Finance</span>' +
              '<span class="sf-brand-subtitle">Personal finance system</span>' +
            '</span>' +
          '</a>' +
          '<button class="sf-sidebar-fold" type="button" id="sidebarFold" aria-label="Collapse sidebar">' +
            '<span class="sf-nav-icon">‹</span>' +
          '</button>' +
        '</div>' +

        '<nav class="sf-nav-scroll" aria-label="Main navigation">' +
          routeList().map(linkHtml).join("") +
        '</nav>' +

        '<div class="sf-sidebar-footer">' +
          '<div class="sf-sidebar-footer-title">Flat navigation</div>' +
          '<div class="sf-sidebar-footer-copy">No submenus. No nested routes.</div>' +
        '</div>' +
      '</aside>'
    );
  }

  function buildOverlayHtml() {
    return '<div class="sf-overlay" id="navOverlay"></div>';
  }

  function ensureSidebar() {
    let sidebar = document.querySelector(".sf-sidebar");

    if (!sidebar) {
      document.body.insertAdjacentHTML("afterbegin", buildSidebarHtml());
      sidebar = document.querySelector(".sf-sidebar");
    }

    return sidebar;
  }

  function ensureOverlay() {
    let overlay = document.getElementById("navOverlay");

    if (!overlay) {
      const sidebar = document.querySelector(".sf-sidebar");

      if (sidebar) {
        sidebar.insertAdjacentHTML("afterend", buildOverlayHtml());
      } else {
        document.body.insertAdjacentHTML("afterbegin", buildOverlayHtml());
      }

      overlay = document.getElementById("navOverlay");
    }

    return overlay;
  }

  function rebuildNav() {
    const sidebar = ensureSidebar();
    const nav = sidebar.querySelector(".sf-nav-scroll");

    if (nav) {
      nav.innerHTML = routeList().map(linkHtml).join("");
    }

    scrubCommandCentreLinks();
    scrubCommandCentreText();
  }

  function scrubCommandCentreLinks() {
    const links = Array.from(document.querySelectorAll('a[href*="monthly-close"], a[href*="finance-command-center"]'));

    links.forEach(link => {
      const insideAllowedInternalContext = shouldShowInternalReport() && link.closest(".sf-sidebar");

      if (insideAllowedInternalContext) {
        link.setAttribute("href", "/monthly-close.html");
        link.classList.add("sf-nav-link");

        const label = link.querySelector(".sf-nav-label");
        if (label) {
          label.textContent = "Internal Report";
        } else {
          link.textContent = "Internal Report";
        }

        return;
      }

      link.remove();
    });
  }

  function scrubCommandCentreText() {
    if (internalPage) return;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = node.nodeValue || "";

          if (/Command Centre|preflight|dry-run|governor|proof-first|write safety|Command Centre decides/i.test(text)) {
            const parent = node.parentElement;

            if (parent && parent.closest("script, style, noscript")) {
              return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
          }

          return NodeFilter.FILTER_REJECT;
        }
      }
    );

    const nodes = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    nodes.forEach(node => {
      node.nodeValue = node.nodeValue
        .replace(/Command Centre decides/gi, "System validates")
        .replace(/Command Centre/gi, "Internal Report")
        .replace(/proof-first/gi, "verified")
        .replace(/preflight/gi, "check")
        .replace(/dry-run/gi, "preview")
        .replace(/governor/gi, "guard")
        .replace(/write safety/gi, "safe write");
    });

    scrubRemainingVisibleInternalReportLabels();
  }

  function scrubRemainingVisibleInternalReportLabels() {
    if (internalPage || debugMode) return;

    Array.from(document.querySelectorAll(".sf-sidebar, .sf-topbar, nav, header")).forEach(area => {
      if (!area) return;

      Array.from(area.querySelectorAll("*")).forEach(el => {
        const text = el.textContent || "";

        if (/Internal Report|Command Centre/i.test(text)) {
          const link = el.closest("a");

          if (link && /monthly-close|finance-command-center/i.test(link.getAttribute("href") || "")) {
            link.remove();
          }
        }
      });
    });
  }

  function ensureTopbarMenuButton() {
    let button = document.getElementById("mobileMenu");

    if (!button) {
      const topbar = document.querySelector(".sf-topbar, header");

      if (topbar) {
        topbar.insertAdjacentHTML(
          "afterbegin",
          '<button class="sf-mobile-menu" type="button" id="mobileMenu" aria-label="Open navigation">☰</button>'
        );

        button = document.getElementById("mobileMenu");
      }
    }

    return button;
  }

  function setCollapsed(collapsed) {
    document.body.classList.toggle("sf-sidebar-collapsed", collapsed);
    localStorage.setItem("sf_sidebar_collapsed", collapsed ? "1" : "0");
  }

  function getCollapsed() {
    return localStorage.getItem("sf_sidebar_collapsed") === "1";
  }

  function openMobileNav() {
    document.body.classList.add("sf-nav-open");
  }

  function closeMobileNav() {
    document.body.classList.remove("sf-nav-open");
  }

  function bindControls() {
    const fold = document.getElementById("sidebarFold");
    const overlay = ensureOverlay();
    const mobile = ensureTopbarMenuButton();

    if (fold && !fold.dataset.sfBound) {
      fold.dataset.sfBound = "1";
      fold.addEventListener("click", () => {
        setCollapsed(!document.body.classList.contains("sf-sidebar-collapsed"));
      });
    }

    if (overlay && !overlay.dataset.sfBound) {
      overlay.dataset.sfBound = "1";
      overlay.addEventListener("click", closeMobileNav);
    }

    if (mobile && !mobile.dataset.sfBound) {
      mobile.dataset.sfBound = "1";
      mobile.addEventListener("click", openMobileNav);
    }

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeMobileNav();
    }, { passive: true });

    Array.from(document.querySelectorAll(".sf-nav-link")).forEach(link => {
      if (link.dataset.sfBound) return;
      link.dataset.sfBound = "1";
      link.addEventListener("click", closeMobileNav);
    });
  }

  function exposeDebug() {
    window.SovereignNav = {
      version: VERSION,
      routes: routeList().map(route => ({
        href: route.href,
        label: route.label,
        internal: route.href === INTERNAL_REPORT_ROUTE.href
      })),
      internalPage,
      debugMode,
      refresh: init
    };
  }

  function verifyNormalSurface() {
    if (internalPage) return;

    const normalForbidden = Array.from(
      document.body.innerText.matchAll(/Command Centre|preflight|dry-run|governor|proof-first|write safety|Command Centre decides/gi)
    ).map(match => match[0]);

    if (normalForbidden.length) {
      console.warn("[nav " + VERSION + "] normal-surface forbidden text remains", normalForbidden);
    }
  }

  function init() {
    document.body.classList.toggle("sf-sidebar-collapsed", getCollapsed());

    rebuildNav();
    bindControls();
    exposeDebug();
    verifyNormalSurface();

    console.log("[nav " + VERSION + "] ready", {
      internalPage,
      debugMode,
      routes: routeList().map(route => route.label)
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
