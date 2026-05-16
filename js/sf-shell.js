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
        { label: "Hub", href: "/index.html", aliases: ["/", "/index", "/index.html"] },
        { label: "Accounts", href: "/accounts.html", aliases: ["/accounts"] },
        { label: "Credit Card", href: "/cc.html", aliases: ["/cc"] },
        { label: "Ledger", href: "/transactions.html", aliases: ["/transactions"] },
        { label: "Add", href: "/add.html", aliases: ["/add"] },
        { label: "Bills", href: "/bills.html", aliases: ["/bills"] },
        { label: "Debts", href: "/debts.html", aliases: ["/debts"] },
        { label: "Salary", href: "/salary.html", aliases: ["/salary"] },
        { label: "Forecast", href: "/forecast.html", aliases: ["/forecast"] }
      ]
    },
    {
      group: "Control / QA",
      items: [
        { label: "Reconciliation", href: "/reconciliation.html", aliases: ["/reconciliation"] },
        { label: "Audit Trail", href: "/audit.html", aliases: ["/audit"] },
        { label: "Monthly Close", href: "/monthly-close.html", aliases: ["/monthly-close"] }
      ]
    },
    {
      group: "Analysis",
      items: [
        { label: "Insights", href: "/insights.html", aliases: ["/insights"] },
        { label: "Charts", href: "/charts.html", aliases: ["/charts"] },
        { label: "Snapshots", href: "/snapshots.html", aliases: ["/snapshots"] }
      ]
    },
    {
      group: "Modules",
      items: [
        { label: "ATM", href: "/atm.html", aliases: ["/atm"] },
        { label: "Budgets", href: "/budgets.html", aliases: ["/budgets"] },
        { label: "Goals", href: "/goals.html", aliases: ["/goals"] },
        { label: "Merchants", href: "/merchants.html", aliases: ["/merchants"] },
        { label: "Nano Loans", href: "/nano-loans.html", aliases: ["/nano-loans"] }
      ]
    }
  ];

  function comp() {
    return window.SFComponents || {};
  }

  function escapeHtml(value) {
    const c = comp();

    if (typeof c.escapeHtml === "function") {
      return c.escapeHtml(value);
    }

    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function classNames() {
    return Array.from(arguments).filter(Boolean).join(" ");
  }

  function q(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qa(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function readConfig() {
    return window.SF_PAGE || {};
  }

  function normalizePath(path) {
    let clean = String(path || "/").split("?")[0].split("#")[0];

    if (!clean || clean === "/") return "/index.html";
    if (clean.endsWith("/")) clean = clean.slice(0, -1);
    if (!clean.includes(".") && clean !== "/") return clean + ".html";

    return clean;
  }

  function currentPath() {
    return normalizePath(window.location.pathname);
  }

  function routeMatches(item) {
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

  function datasetAttrs(dataset) {
    if (!dataset || typeof dataset !== "object") return "";

    return Object.entries(dataset)
      .filter(([key, value]) => key && value != null)
      .map(([key, value]) => {
        const attr = "data-" + String(key)
          .replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())
          .replace(/[^a-z0-9_-]/gi, "-")
          .toLowerCase();

        return `${attr}="${escapeHtml(value)}"`;
      })
      .join(" ");
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

    return (
      tag === "script" ||
      tag === "style" ||
      tag === "link" ||
      tag === "meta" ||
      tag === "title"
    );
  }

  function buttonHTML(opts) {
    const c = comp();

    if (typeof c.button === "function") {
      return c.button(opts);
    }

    const o = opts || {};
    const tag = o.href ? "a" : "button";
    const attrs = [
      `class="${classNames("sf-button", o.primary && "sf-button--primary", o.className)}"`
    ];

    if (o.href) attrs.push(`href="${escapeHtml(o.href)}"`);
    else attrs.push('type="button"');

    if (o.disabled) attrs.push("disabled");
    if (o.id) attrs.push(`id="${escapeHtml(o.id)}"`);
    if (o.ariaLabel) attrs.push(`aria-label="${escapeHtml(o.ariaLabel)}"`);

    const data = datasetAttrs(o.dataset);
    if (data) attrs.push(data);

    return `<${tag} ${attrs.join(" ")}>${o.labelHtml != null ? String(o.labelHtml) : escapeHtml(o.label || "Action")}</${tag}>`;
  }

  function chipHTML(opts) {
    const c = comp();

    if (typeof c.chip === "function") {
      return c.chip(opts);
    }

    const o = opts || {};
    const tag = o.href ? "a" : "button";
    const attrs = [
      `class="${classNames("sf-chip", o.active && "is-active", o.className)}"`
    ];

    if (o.href) attrs.push(`href="${escapeHtml(o.href)}"`);
    else attrs.push('type="button"');

    if (o.disabled) attrs.push("disabled");
    if (o.id) attrs.push(`id="${escapeHtml(o.id)}"`);

    const data = datasetAttrs(o.dataset);
    if (data) attrs.push(data);

    return `<${tag} ${attrs.join(" ")}>${o.labelHtml != null ? String(o.labelHtml) : escapeHtml(o.label || "Option")}</${tag}>`;
  }

  function metricCardHTML(opts) {
    const c = comp();

    if (typeof c.metricCard === "function") {
      return c.metricCard(opts);
    }

    const o = opts || {};
    const value = o.valueHtml != null ? String(o.valueHtml) : escapeHtml(o.value || "—");

    const subtitle = o.subtitleHtml != null
      ? String(o.subtitleHtml)
      : o.subtitle
        ? escapeHtml(o.subtitle)
        : "";

    const foot = o.footHtml != null
      ? String(o.footHtml)
      : o.foot
        ? escapeHtml(o.foot)
        : "";

    const cardAttrs = [
      `class="${classNames("sf-metric-card", o.accent && "sf-metric-card--accent", o.className)}"`
    ];

    if (o.id) cardAttrs.push(`id="${escapeHtml(o.id)}"`);
    if (o.key) cardAttrs.push(`data-kpi="${escapeHtml(o.key)}"`);
    if (o.valueKey) cardAttrs.push(`data-kpi-key="${escapeHtml(o.valueKey)}"`);

    const cardData = datasetAttrs(o.dataset);
    if (cardData) cardAttrs.push(cardData);

    const valueAttrs = [
      `class="${classNames("sf-metric-value", o.tone && "sf-tone-" + o.tone)}"`
    ];

    /*
     * Backward-compatible KPI value hooks.
     *
     * Existing pages without valueId/valueKey render exactly as before.
     * Pages that provide valueId/valueKey can update shell KPI values
     * deterministically without text-scanning the DOM.
     */
    if (o.valueId) valueAttrs.push(`id="${escapeHtml(o.valueId)}"`);
    if (o.valueKey) valueAttrs.push(`data-kpi-value="${escapeHtml(o.valueKey)}"`);
    if (o.key) valueAttrs.push(`data-kpi-value="${escapeHtml(o.key)}"`);

    const valueData = datasetAttrs(o.valueDataset);
    if (valueData) valueAttrs.push(valueData);

    return `
      <section ${cardAttrs.join(" ")}>
        ${o.kicker ? `<p class="sf-card-kicker">${escapeHtml(o.kicker)}</p>` : ""}
        ${o.title ? `<h3 class="sf-card-title">${escapeHtml(o.title)}</h3>` : ""}
        <div ${valueAttrs.join(" ")}>${value}</div>
        ${subtitle ? `<p class="sf-card-subtitle">${subtitle}</p>` : ""}
        ${foot ? `<div class="sf-metric-foot">${foot}</div>` : ""}
      </section>
    `;
  }

  function renderFinanceNav() {
    const groups = FINANCE_NAV.map((group) => {
      const items = group.items.map((item) => {
        const active = routeMatches(item);

        return `
          <a class="sf-nav-link${active ? " is-active" : ""}" href="${escapeHtml(item.href)}" aria-current="${active ? "page" : "false"}">
            <span>${escapeHtml(item.label)}</span>
          </a>
        `;
      }).join("");

      return `
        <div class="sf-nav-group">
          <div class="sf-nav-group-title">${escapeHtml(group.group)}</div>
          <nav class="sf-nav-list" aria-label="${escapeHtml(group.group)} finance navigation">
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

  function ensureAppShell() {
    let appShell = q("." + SHELL_CLASS);
    if (appShell) return appShell;

    appShell = document.createElement("main");
    appShell.className = SHELL_CLASS;

    const nodes = Array.from(document.body.childNodes);
    const contentNodes = nodes.filter((node) => !isShellAsset(node));

    contentNodes.forEach((node) => appShell.appendChild(node));
    document.body.appendChild(appShell);

    return appShell;
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
      closeMobileNav();
    });

    document.body.appendChild(overlay);

    return overlay;
  }

  function closeMobileNav() {
    document.body.classList.remove(NAV_OPEN_CLASS);

    const button = q(".sf-nav-mobile-toggle");
    if (button) button.setAttribute("aria-expanded", "false");
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
      closeMobileNav();

      return null;
    }

    if (!sidebar) {
      const temp = document.createElement("div");
      temp.innerHTML = renderFinanceNav().trim();
      sidebar = temp.firstElementChild;
      appShell.insertBefore(sidebar, appShell.firstChild);
    } else {
      sidebar.outerHTML = renderFinanceNav().trim();
      sidebar = q("." + SIDEBAR_CLASS, appShell);
    }

    appShell.classList.add("sf-app-shell--with-nav");
    ensureMobileNavButton();
    ensureNavOverlay();

    qa("a", sidebar).forEach((link) => {
      link.addEventListener("click", closeMobileNav);
    });

    return sidebar;
  }

  function ensurePageShell(appShell) {
    let pageShell = q("." + PAGE_CLASS, appShell);
    if (pageShell) return pageShell;

    pageShell = document.createElement("div");
    pageShell.className = PAGE_CLASS;

    const contentSlot = document.createElement("section");
    contentSlot.className = CONTENT_CLASS;

    const existing = Array.from(appShell.childNodes);

    existing.forEach((node) => {
      if (node === pageShell) return;
      if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains(SIDEBAR_CLASS)) return;

      contentSlot.appendChild(node);
    });

    pageShell.appendChild(contentSlot);
    appShell.appendChild(pageShell);

    return pageShell;
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

  function ensureRegion(pageShell, className, create) {
    let region = q("." + className, pageShell);

    if (!region) {
      region = document.createElement("section");
      region.className = className;

      const content = q("." + CONTENT_CLASS, pageShell);

      if (content) pageShell.insertBefore(region, content);
      else pageShell.appendChild(region);
    }

    const next = create();

    region.innerHTML = next;
    region.hidden = !String(next || "").trim();

    return region;
  }

  function renderHero(config) {
    const c = normalizeConfig(config);

    const actionHtml = c.actions.map((action) => buttonHTML({
      label: action.label || "Action",
      labelHtml: action.labelHtml,
      href: action.href,
      primary: action.primary,
      className: action.className,
      disabled: action.disabled,
      id: action.id,
      dataset: action.dataset,
      ariaLabel: action.ariaLabel
    })).join("");

    return `
      <header class="sf-page-hero">
        <div class="sf-page-title-group">
          <div class="sf-page-eyebrow">${escapeHtml(c.eyebrow)}</div>
          <h1 class="sf-page-title">${escapeHtml(c.title)}</h1>
          ${
            c.subtitleHtml != null
              ? `<p class="sf-page-subtitle">${String(c.subtitleHtml)}</p>`
              : c.subtitle
                ? `<p class="sf-page-subtitle">${escapeHtml(c.subtitle)}</p>`
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

    return controls.map((control) => chipHTML(control)).join("");
  }

  function renderKpis(config) {
    const kpis = Array.isArray(config.kpis) ? config.kpis : [];
    if (!kpis.length) return "";

    return kpis.map((kpi) => metricCardHTML(kpi)).join("");
  }

  function renderShell(config) {
    const c = normalizeConfig(config);

    ensureBodyClass();
    applyDebugMode();

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

    revealDebugIfNeeded();

    return pageShell;
  }

  function mount(config) {
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

  ready(function () {
    try {
      mount();
    } catch (err) {
      console.error("[sf-shell] mount failed", err);
      document.body.classList.add("sf-shell-failed");
    }
  });
})();
