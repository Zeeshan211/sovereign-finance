(function () {
  "use strict";

  const ROOT = "SFShell";
  const SHELL_CLASS = "sf-app-shell";
  const PAGE_CLASS = "sf-page-shell";
  const CONTENT_CLASS = "sf-page-content";
  const SIDEBAR_CLASS = "sf-finance-sidebar";
  const NAV_OPEN_CLASS = "sf-nav-open";

  let mounted = false;
  let currentConfig = {};

  const FINANCE_NAV = [
    {
      group: "Core",
      items: [
        { label: "Hub", href: "/index.html", aliases: ["/", "/index.html"] },
        { label: "Accounts", href: "/accounts.html" },
        { label: "Credit Card", href: "/cc.html" },
        { label: "Ledger", href: "/transactions.html" },
        { label: "Add", href: "/add.html" },
        { label: "Bills", href: "/bills.html" },
        { label: "Debts", href: "/debts.html" },
        { label: "Salary", href: "/salary.html" },
        { label: "Forecast", href: "/forecast.html" }
      ]
    },
    {
      group: "Control / QA",
      items: [
        { label: "Reconciliation", href: "/reconciliation.html" },
        { label: "Audit Trail", href: "/audit.html" },
        { label: "Monthly Close", href: "/monthly-close.html" }
      ]
    },
    {
      group: "Analysis",
      items: [
        { label: "Insights", href: "/insights.html" },
        { label: "Charts", href: "/charts.html" },
        { label: "Snapshots", href: "/snapshots.html" }
      ]
    },
    {
      group: "Modules",
      items: [
        { label: "ATM", href: "/atm.html" },
        { label: "Budgets", href: "/budgets.html" },
        { label: "Goals", href: "/goals.html" },
        { label: "Merchants", href: "/merchants.html" },
        { label: "Nano Loans", href: "/nano-loans.html" }
      ]
    }
  ];

  function components() {
    if (!window.SFComponents) {
      throw new Error("SFComponents must load before sf-shell.js");
    }
    return window.SFComponents;
  }

  function readConfig() {
    return window.SF_PAGE || {};
  }

  function q(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function escape(value) {
    return components().escapeHtml(value);
  }

  function normalizePath(path) {
    const clean = String(path || "/").split("?")[0].split("#")[0];

    if (clean === "" || clean === "/") return "/index.html";
    if (clean.endsWith("/")) return clean + "index.html";

    return clean;
  }

  function currentPath() {
    return normalizePath(window.location.pathname);
  }

  function isActiveRoute(item) {
    const now = currentPath();
    const href = normalizePath(item.href);
    const aliases = (item.aliases || []).map(normalizePath);

    return now === href || aliases.includes(now);
  }

  function normalizeConfig(config) {
    const c = config || {};

    return {
      eyebrow: c.eyebrow || "Sovereign Finance",
      title: c.title || document.title || "Dashboard",
      subtitle: c.subtitle || "",
      subtitleHtml: c.subtitleHtml,
      actions: Array.isArray(c.actions) ? c.actions : [],
      controls: Array.isArray(c.controls) ? c.controls : [],
      kpis: Array.isArray(c.kpis) ? c.kpis : [],
      nav: c.nav === false ? false : true
    };
  }

  function applyDebugMode() {
    const params = new URLSearchParams(window.location.search);
    const debugOn = params.get("debug") === "1";
    document.body.classList.toggle("sf-debug-mode", debugOn);
    return debugOn;
  }

  function ensureBodyClass() {
    document.body.classList.add("sf-shell-body");
  }

  function isShellAsset(node) {
    if (!node) return false;

    if (node.nodeType === Node.TEXT_NODE) {
      return !String(node.textContent || "").trim();
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return false;

    const tag = node.tagName.toLowerCase();

    if (tag === "script") return true;
    if (tag === "style") return true;
    if (tag === "link") return true;
    if (tag === "meta") return true;
    if (tag === "title") return true;

    return false;
  }

  function ensureAppShell() {
    let appShell = q("." + SHELL_CLASS);

    if (appShell) return appShell;

    appShell = document.createElement("main");
    appShell.className = SHELL_CLASS;

    const nodes = Array.from(document.body.childNodes);
    const contentNodes = [];

    nodes.forEach((node) => {
      if (isShellAsset(node)) return;
      contentNodes.push(node);
    });

    contentNodes.forEach((node) => appShell.appendChild(node));
    document.body.appendChild(appShell);

    return appShell;
  }

  function renderFinanceNav() {
    const groups = FINANCE_NAV.map((group) => {
      const items = group.items.map((item) => {
        const active = isActiveRoute(item);

        return `
          <a class="sf-nav-link${active ? " is-active" : ""}" href="${escape(item.href)}" aria-current="${active ? "page" : "false"}">
            <span>${escape(item.label)}</span>
          </a>
        `;
      }).join("");

      return `
        <div class="sf-nav-group">
          <div class="sf-nav-group-title">${escape(group.group)}</div>
          <nav class="sf-nav-list" aria-label="${escape(group.group)} finance navigation">
            ${items}
          </nav>
        </div>
      `;
    }).join("");

    return `
      <aside class="${SIDEBAR_CLASS}" aria-label="Finance navigation">
        <div class="sf-nav-brand">
          <a class="sf-nav-brand-link" href="/index.html" aria-label="Open Finance Hub">
            <span class="sf-nav-brand-mark">SF</span>
            <span>
              <strong>Sovereign Finance</strong>
              <small>Finance hub</small>
            </span>
          </a>
        </div>

        <div class="sf-nav-scroll">
          ${groups}
        </div>
      </aside>
    `;
  }

  function ensureMobileNavButton() {
    let button = q(".sf-nav-mobile-toggle");

    if (button) return button;

    button = document.createElement("button");
    button.className = "sf-nav-mobile-toggle";
    button.type = "button";
    button.setAttribute("aria-label", "Toggle finance navigation");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = "<span></span><span></span><span></span>";

    button.addEventListener("click", function () {
      const open = !document.body.classList.contains(NAV_OPEN_CLASS);
      document.body.classList.toggle(NAV_OPEN_CLASS, open);
      button.setAttribute("aria-expanded", String(open));
    });

    document.body.appendChild(button);
    return button;
  }

  function ensureNavOverlay() {
    let overlay = q(".sf-nav-overlay");

    if (overlay) return overlay;

    overlay = document.createElement("button");
    overlay.className = "sf-nav-overlay";
    overlay.type = "button";
    overlay.setAttribute("aria-label", "Close finance navigation");

    overlay.addEventListener("click", function () {
      document.body.classList.remove(NAV_OPEN_CLASS);

      const button = q(".sf-nav-mobile-toggle");
      if (button) button.setAttribute("aria-expanded", "false");
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function closeMobileNavOnRouteClick(sidebar) {
    qa("a", sidebar).forEach((link) => {
      link.addEventListener("click", function () {
        document.body.classList.remove(NAV_OPEN_CLASS);

        const button = q(".sf-nav-mobile-toggle");
        if (button) button.setAttribute("aria-expanded", "false");
      });
    });
  }

  function ensureFinanceNav(appShell, enabled) {
    let sidebar = q("." + SIDEBAR_CLASS, appShell);

    if (!enabled) {
      if (sidebar) sidebar.remove();

      const button = q(".sf-nav-mobile-toggle");
      const overlay = q(".sf-nav-overlay");

      if (button) button.remove();
      if (overlay) overlay.remove();

      appShell.classList.remove("sf-app-shell--with-nav");
      document.body.classList.remove(NAV_OPEN_CLASS);

      return null;
    }

    if (!sidebar) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = renderFinanceNav().trim();
      sidebar = wrapper.firstElementChild;
      appShell.insertBefore(sidebar, appShell.firstChild);
    } else {
      sidebar.outerHTML = renderFinanceNav().trim();
      sidebar = q("." + SIDEBAR_CLASS, appShell);
    }

    appShell.classList.add("sf-app-shell--with-nav");

    ensureMobileNavButton();
    ensureNavOverlay();
    closeMobileNavOnRouteClick(sidebar);

    return sidebar;
  }

  function ensurePageShell(appShell) {
    let pageShell = q("." + PAGE_CLASS, appShell);

    if (pageShell) return pageShell;

    pageShell = document.createElement("div");
    pageShell.className = PAGE_CLASS;

    const existing = Array.from(appShell.childNodes);
    const contentSlot = document.createElement("section");
    contentSlot.className = CONTENT_CLASS;

    existing.forEach((node) => {
      if (node === pageShell) return;
      if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains(SIDEBAR_CLASS)) return;
      contentSlot.appendChild(node);
    });

    pageShell.appendChild(contentSlot);
    appShell.appendChild(pageShell);

    return pageShell;
  }

  function ensureRegion(pageShell, className, create) {
    let region = q("." + className, pageShell);

    if (!region) {
      region = document.createElement("section");
      region.className = className;

      const content = q("." + CONTENT_CLASS, pageShell);

      if (content) {
        pageShell.insertBefore(region, content);
      } else {
        pageShell.appendChild(region);
      }
    }

    region.innerHTML = create();
    region.hidden = !String(region.innerHTML || "").trim();

    return region;
  }

  function renderHero(config) {
    const c = normalizeConfig(config);

    const actionHtml = c.actions.map((action) => {
      return components().button({
        label: action.label || "Action",
        labelHtml: action.labelHtml,
        href: action.href,
        primary: action.primary,
        className: action.className,
        disabled: action.disabled,
        id: action.id,
        dataset: action.dataset,
        ariaLabel: action.ariaLabel
      });
    }).join("");

    return `
      <header class="sf-page-hero">
        <div class="sf-page-title-group">
          <div class="sf-page-eyebrow">${escape(c.eyebrow)}</div>
          <h1 class="sf-page-title">${escape(c.title)}</h1>
          ${
            c.subtitleHtml != null
              ? `<p class="sf-page-subtitle">${String(c.subtitleHtml)}</p>`
              : c.subtitle
                ? `<p class="sf-page-subtitle">${escape(c.subtitle)}</p>`
                : ""
          }
        </div>

        ${actionHtml ? `<div class="sf-page-actions">${actionHtml}</div>` : ""}
      </header>
    `;
  }

  function renderControls(config) {
    const controls = Array.isArray(config.controls) ? config.controls : [];
    if (!controls.length) return "";

    return controls.map((control) => components().chip(control)).join("");
  }

  function renderKpis(config) {
    const kpis = Array.isArray(config.kpis) ? config.kpis : [];
    if (!kpis.length) return "";

    return kpis.map((kpi) => components().metricCard(kpi)).join("");
  }

  function ensureContentSlot(pageShell) {
    let content = q("." + CONTENT_CLASS, pageShell);

    if (!content) {
      content = document.createElement("section");
      content.className = CONTENT_CLASS;
      pageShell.appendChild(content);
    }

    return content;
  }

  function renderShell(config) {
    const c = normalizeConfig(config);
    const appShell = ensureAppShell();

    ensureFinanceNav(appShell, c.nav !== false);

    const pageShell = ensurePageShell(appShell);
    ensureContentSlot(pageShell);

    ensureRegion(pageShell, "sf-page-hero-region", () => renderHero(c));
    ensureRegion(pageShell, "sf-control-region", () => renderControls(c));
    ensureRegion(pageShell, "sf-kpi-region", () => renderKpis(c));

    if (c.title) document.title = c.title;

    currentConfig = c;
    mounted = true;

    return pageShell;
  }

  function mount(config) {
    ensureBodyClass();
    applyDebugMode();
    return renderShell(config || readConfig());
  }

  function refresh(nextConfig) {
    const merged = Object.assign({}, currentConfig, nextConfig || {});
    window.SF_PAGE = Object.assign({}, window.SF_PAGE || {}, merged);
    return mount(merged);
  }

  function setKpis(kpis) {
    return refresh({ kpis: Array.isArray(kpis) ? kpis : [] });
  }

  function setControls(controls) {
    return refresh({ controls: Array.isArray(controls) ? controls : [] });
  }

  function setActions(actions) {
    return refresh({ actions: Array.isArray(actions) ? actions : [] });
  }

  function setTitle(title) {
    return refresh({ title: title || "" });
  }

  function setSubtitle(subtitle) {
    return refresh({ subtitle: subtitle || "", subtitleHtml: null });
  }

  function setSubtitleHtml(subtitleHtml) {
    return refresh({
      subtitleHtml: subtitleHtml == null ? "" : String(subtitleHtml),
      subtitle: ""
    });
  }

  function debugEnabled() {
    return document.body.classList.contains("sf-debug-mode");
  }

  function revealDebugIfNeeded() {
    const enabled = applyDebugMode();

    qa(".sf-debug-panel").forEach((panel) => {
      panel.hidden = !enabled;
    });

    return enabled;
  }

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  ready(function () {
    try {
      mount();
      revealDebugIfNeeded();
    } catch (err) {
      console.error("[sf-shell] mount failed", err);
      document.body.classList.add("sf-shell-failed");
    }
  });

  window[ROOT] = {
    mount,
    refresh,
    setKpis,
    setControls,
    setActions,
    setTitle,
    setSubtitle,
    setSubtitleHtml,
    debugEnabled,
    revealDebugIfNeeded,
    getConfig: function () {
      return Object.assign({}, currentConfig);
    },
    getFinanceNav: function () {
      return JSON.parse(JSON.stringify(FINANCE_NAV));
    },
    isMounted: function () {
      return mounted;
    }
  };
})();
