/* Sovereign Finance Nav v1.2.0
   Scroll-with-page premium command dock with scoped SVG icons + Command Centre enforcement markers.
   Contract:
   - Visual navigation only.
   - Loads enforcement policy read-only.
   - Marks routes as Pass / Warning / View only / Blocked.
   - Does not block navigation.
   - Does not disable buttons.
   - Does not write D1.
   - Does not mutate ledger.
   - Command Centre must always remain accessible.
*/

(function () {
  "use strict";

  const VERSION = "1.2.0";
  const CSS_HREF = "/css/nav.css?v=1.1.9";
  const ENFORCEMENT_SRC = "/js/enforcement.js?v=0.1.0";

  const ICONS = {
    hub: '<svg viewBox="0 0 24 24"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4Z"/><path d="M13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4Z"/><path d="M4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4Z"/><path d="M13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z"/></svg>',
    forecast: '<svg viewBox="0 0 24 24"><path d="M4 17.5 9.2 12l3.2 3.2L20 7.5"/><path d="M15 7.5h5v5"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14l-3-2-3 2-3-2-3 2-2-1.4V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8"/><path d="M8 13h6"/></svg>',
    add: '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    transactions: '<svg viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14l-3-1.8L13 20l-3-1.8L7 20l-2-1.2V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>',
    accounts: '<svg viewBox="0 0 24 24"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H19a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 17.5v-9Z"/><path d="M4 8.5A2.5 2.5 0 0 0 6.5 11H20"/><path d="M16.5 15.5h.01"/></svg>',
    reconciliation: '<svg viewBox="0 0 24 24"><path d="M12 3 20 7v5c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V7l8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>',
    bills: '<svg viewBox="0 0 24 24"><path d="M7 3h10a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2-2-1.3V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>',
    debts: '<svg viewBox="0 0 24 24"><path d="M12 4v16"/><path d="M6 8h12"/><path d="M7 8l-3 6h6L7 8Z"/><path d="m17 8-3 6h6l-3-6Z"/></svg>',
    card: '<svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/><path d="M4 10h16"/><path d="M7 15h4"/></svg>',
    atm: '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5V5Z"/><path d="M8 9h8"/><path d="M8 13h5"/><path d="M9 17h6"/><path d="M12 9v8"/></svg>',
    nano: '<svg viewBox="0 0 24 24"><path d="M12 3 4 8l8 5 8-5-8-5Z"/><path d="M4 12l8 5 8-5"/><path d="M4 16l8 5 8-5"/></svg>',
    salary: '<svg viewBox="0 0 24 24"><path d="M4 7h16v10H4V7Z"/><path d="M8 11h.01"/><path d="M16 13h.01"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>',
    charts: '<svg viewBox="0 0 24 24"><path d="M5 19V5"/><path d="M5 19h14"/><path d="M8 16v-4"/><path d="M12 16V8"/><path d="M16 16v-7"/></svg>',
    audit: '<svg viewBox="0 0 24 24"><path d="M7 4h7l4 4v12H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M14 4v4h4"/><path d="M8 13h7"/><path d="M8 17h5"/></svg>',
    snapshots: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 5v5h5"/><path d="M12 8v5l3 2"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M5 12h.01"/><path d="M12 12h.01"/><path d="M19 12h.01"/></svg>'
  };

  const LINKS = [
    { key: "hub", label: "Hub", href: "/index.html", section: "command", icon: "hub", mobile: true },
    { key: "forecast", label: "Forecast", href: "/forecast.html", section: "command", icon: "forecast" },
    { key: "monthly-close", label: "Monthly Close", href: "/monthly-close.html", section: "command", icon: "close" },
    { key: "add", label: "Add Transaction", href: "/add.html", section: "money", icon: "add", mobile: true },
    { key: "transactions", label: "Transactions", href: "/transactions.html", section: "money", icon: "transactions", mobile: true },
    { key: "accounts", label: "Accounts", href: "/accounts.html", section: "money", icon: "accounts" },
    { key: "reconciliation", label: "Reconciliation", href: "/reconciliation.html", section: "money", icon: "reconciliation" },
    { key: "bills", label: "Bills", href: "/bills.html", section: "obligations", icon: "bills", mobile: true },
    { key: "debts", label: "Debts", href: "/debts.html", section: "obligations", icon: "debts" },
    { key: "cc", label: "Credit Card", href: "/cc.html", section: "obligations", icon: "card" },
    { key: "atm", label: "ATM", href: "/atm.html", section: "obligations", icon: "atm" },
    { key: "nano-loans", label: "Nano Loans", href: "/nano-loans.html", section: "obligations", icon: "nano" },
    { key: "salary", label: "Salary", href: "/salary.html", section: "planning", icon: "salary" },
    { key: "charts", label: "Charts", href: "/charts.html", section: "records", icon: "charts" },
    { key: "audit", label: "Audit", href: "/audit.html", section: "records", icon: "audit" },
    { key: "snapshots", label: "Snapshots", href: "/snapshots.html", section: "records", icon: "snapshots" }
  ];

  const SECTIONS = [
    { key: "command", label: "Command", hint: "Safety and next move" },
    { key: "money", label: "Money", hint: "Entry, accounts, ledger" },
    { key: "obligations", label: "Obligations", hint: "Bills, debts, card" },
    { key: "planning", label: "Planning", hint: "Income and future" },
    { key: "records", label: "Records", hint: "Charts, audit, recovery" }
  ];

  const PRIMARY_KEYS = ["add", "transactions"];
  const MOBILE_KEYS = ["hub", "add", "transactions", "bills"];

  let latestEnforcementSnapshot = null;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function icon(name) {
    return ICONS[name] || ICONS.hub;
  }

  function normalizePath(path) {
    let p = String(path || "/").split("?")[0].split("#")[0];
    if (p === "/" || p === "") return "/index.html";
    if (!p.endsWith(".html")) p = p.replace(/\/$/, "") + ".html";
    return p;
  }

  function statusClass(value) {
    return String(value || "unknown").toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  }

  function currentKey() {
    const p = normalizePath(window.location.pathname);
    const direct = LINKS.find(link => normalizePath(link.href) === p);
    if (direct) return direct.key;
    if (p.includes("monthly-close")) return "monthly-close";
    if (p.includes("nano-loans")) return "nano-loans";
    if (p.includes("transactions")) return "transactions";
    if (p.includes("reconciliation")) return "reconciliation";
    if (p.includes("forecast")) return "forecast";
    if (p.includes("accounts")) return "accounts";
    if (p.includes("salary")) return "salary";
    if (p.includes("bills")) return "bills";
    if (p.includes("debts")) return "debts";
    if (p.includes("cc")) return "cc";
    if (p.includes("atm")) return "atm";
    if (p.includes("charts")) return "charts";
    if (p.includes("audit")) return "audit";
    if (p.includes("snapshots")) return "snapshots";
    if (p.includes("add")) return "add";
    return "hub";
  }

  function currentLink() {
    return LINKS.find(link => link.key === currentKey()) || LINKS[0];
  }

  function linkByKey(key) {
    return LINKS.find(link => link.key === key) || null;
  }

  function currentSectionKey() {
    return currentLink().section || "command";
  }

  function ensureCss() {
    const existing = document.querySelector('link[data-sf-nav-css="true"]');
    if (existing) {
      existing.href = CSS_HREF;
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS_HREF;
    link.dataset.sfNavCss = "true";
    document.head.appendChild(link);
  }

  function ensureEnforcementCss() {
    let style = document.querySelector('style[data-sf-enforcement-nav-css="true"]');
    if (style) return;

    style = document.createElement("style");
    style.dataset.sfEnforcementNavCss = "true";
    style.textContent = `
      .sfn-link,.sfm-item,.sfmore-link,.sfn-primary-btn{position:relative}
      .sfn-enforcement-badge,.sfm-enforcement-badge,.sfmore-enforcement-badge,.sfn-current-enforcement{
        display:inline-flex;align-items:center;width:fit-content;max-width:100%;
        padding:3px 7px;border-radius:999px;border:1px solid transparent;
        font-size:9px;font-weight:1000;line-height:1;text-transform:uppercase;letter-spacing:.04em;
        white-space:nowrap
      }
      .sfn-enforcement-badge{margin-left:auto}
      .sfm-enforcement-badge{position:absolute;top:4px;right:7px;padding:2px 5px;font-size:8px}
      .sfmore-enforcement-badge{margin-left:auto}
      .sfn-current-enforcement{margin-top:6px}
      [data-enforcement-status="pass"] .sfn-enforcement-badge,
      [data-enforcement-status="pass"] .sfm-enforcement-badge,
      [data-enforcement-status="pass"] .sfmore-enforcement-badge,
      .sfn-current-enforcement.pass{color:#166534;background:#dcfce7;border-color:rgba(22,163,74,.22)}
      [data-enforcement-status="warn"] .sfn-enforcement-badge,
      [data-enforcement-status="warning"] .sfn-enforcement-badge,
      [data-enforcement-status="warn"] .sfm-enforcement-badge,
      [data-enforcement-status="warning"] .sfm-enforcement-badge,
      [data-enforcement-status="warn"] .sfmore-enforcement-badge,
      [data-enforcement-status="warning"] .sfmore-enforcement-badge,
      .sfn-current-enforcement.warn,.sfn-current-enforcement.warning{color:#92400e;background:#fef3c7;border-color:rgba(217,119,6,.22)}
      [data-enforcement-status="soft-block"] .sfn-enforcement-badge,
      [data-enforcement-status="soft_block"] .sfn-enforcement-badge,
      [data-enforcement-status="soft-block"] .sfm-enforcement-badge,
      [data-enforcement-status="soft_block"] .sfm-enforcement-badge,
      [data-enforcement-status="soft-block"] .sfmore-enforcement-badge,
      [data-enforcement-status="soft_block"] .sfmore-enforcement-badge,
      .sfn-current-enforcement.soft-block,.sfn-current-enforcement.soft_block{color:#1d4ed8;background:#dbeafe;border-color:rgba(37,99,235,.22)}
      [data-enforcement-status="blocked"] .sfn-enforcement-badge,
      [data-enforcement-status="blocked"] .sfm-enforcement-badge,
      [data-enforcement-status="blocked"] .sfmore-enforcement-badge,
      .sfn-current-enforcement.blocked{color:#991b1b;background:#fee2e2;border-color:rgba(220,38,38,.22)}
      [data-enforcement-status="unknown"] .sfn-enforcement-badge,
      [data-enforcement-status="unknown"] .sfm-enforcement-badge,
      [data-enforcement-status="unknown"] .sfmore-enforcement-badge,
      .sfn-current-enforcement.unknown{color:#334155;background:#e2e8f0;border-color:rgba(71,85,105,.22)}
      .sfn-link[data-enforcement-status="soft-block"],
      .sfn-link[data-enforcement-status="blocked"],
      .sfmore-link[data-enforcement-status="soft-block"],
      .sfmore-link[data-enforcement-status="blocked"]{outline:1px solid rgba(37,99,235,.16)}
      .sfn-link[data-enforcement-status="blocked"],
      .sfmore-link[data-enforcement-status="blocked"]{outline-color:rgba(220,38,38,.20)}
    `;
    document.head.appendChild(style);
  }

  function ensureEnforcementScript() {
    if (window.SovereignEnforcement) {
      subscribeToEnforcement();
      return;
    }

    if (document.querySelector('script[data-sf-enforcement-script="true"]')) return;

    const script = document.createElement("script");
    script.src = ENFORCEMENT_SRC;
    script.defer = true;
    script.dataset.sfEnforcementScript = "true";
    script.addEventListener("load", subscribeToEnforcement);
    script.addEventListener("error", () => {
      console.warn("[SovereignNav v" + VERSION + "] enforcement loader failed");
      applyEnforcementMarkers(null);
    });
    document.head.appendChild(script);
  }

  function routeStatusFor(link) {
    if (!latestEnforcementSnapshot || !latestEnforcementSnapshot.loaded) {
      return {
        status: "unknown",
        label: "Unknown",
        reason: "Enforcement policy has not loaded yet.",
        source: "js/enforcement.js",
        required_fix: "Wait for /api/finance-command-center or open Command Centre."
      };
    }

    if (latestEnforcementSnapshot.statusForRoute) {
      return latestEnforcementSnapshot.statusForRoute(link.href);
    }

    return {
      status: "unknown",
      label: "Unknown",
      reason: "Enforcement policy helper unavailable.",
      source: "window.SovereignEnforcement",
      required_fix: "Reload page or open Command Centre."
    };
  }

  function displayStatus(status) {
    const raw = String(status.status || "unknown");
    if (status.label) return status.label;
    if (raw === "soft_block" || raw === "soft-block") return "View only";
    if (raw === "warn") return "Warning";
    return raw.replace(/_/g, " ");
  }

  function navLink(link, mode) {
    const active = link.key === currentKey();
    return `
      <a
        class="${mode === "mobile" ? "sfm-item" : "sfn-link"} ${active ? "active" : ""}"
        href="${escapeHtml(link.href)}"
        data-nav-key="${escapeHtml(link.key)}"
        data-nav-href="${escapeHtml(link.href)}"
        data-enforcement-status="unknown"
        aria-current="${active ? "page" : "false"}"
      >
        <span class="${mode === "mobile" ? "sfm-icon" : "sfn-icon"}" aria-hidden="true">${icon(link.icon)}</span>
        <span class="${mode === "mobile" ? "sfm-label" : "sfn-label"}">${escapeHtml(link.label)}</span>
        <span class="${mode === "mobile" ? "sfm-enforcement-badge" : "sfn-enforcement-badge"}">...</span>
      </a>
    `;
  }

  function sectionLinks(section) {
    const all = LINKS.filter(link => link.section === section.key);
    const withoutCurrent = all.filter(link => link.key !== currentKey());
    return withoutCurrent.length ? withoutCurrent : all;
  }

  function desktopSection(section) {
    const links = sectionLinks(section);
    if (!links.length) return "";
    const open = section.key === currentSectionKey();
    return `
      <section class="sfn-section ${open ? "open" : ""}" data-section="${escapeHtml(section.key)}">
        <button class="sfn-section-head" type="button" data-section-toggle="${escapeHtml(section.key)}" aria-expanded="${open ? "true" : "false"}">
          <span>
            <strong>${escapeHtml(section.label)}</strong>
            <small>${escapeHtml(section.hint)}</small>
          </span>
          <span class="sfn-chevron" aria-hidden="true"></span>
        </button>
        <div class="sfn-section-body">
          ${links.map(link => navLink(link, "desktop")).join("")}
        </div>
      </section>
    `;
  }

  function primaryActions() {
    let keys = PRIMARY_KEYS.filter(key => key !== currentKey());
    if (!keys.includes("hub") && currentKey() !== "hub") keys.unshift("hub");
    keys = keys.slice(0, 2);

    return keys.map(key => {
      const link = linkByKey(key);
      if (!link) return "";
      return `
        <a class="sfn-primary-btn" href="${escapeHtml(link.href)}" data-nav-key="${escapeHtml(link.key)}" data-nav-href="${escapeHtml(link.href)}" data-enforcement-status="unknown">
          <span class="sfn-primary-icon" aria-hidden="true">${icon(link.icon)}</span>
          <strong>${escapeHtml(link.label)}</strong>
          <span class="sfn-enforcement-badge">...</span>
        </a>
      `;
    }).join("");
  }

  function desktopNav() {
    const active = currentLink();

    return `
      <aside class="sf-shell-nav" data-nav-version="${VERSION}" aria-label="Sovereign Finance navigation">
        <div class="sfn-dock">
          <a class="sfn-brand" href="/index.html">
            <span class="sfn-brand-mark">SF</span>
            <span class="sfn-brand-text">
              <strong>Sovereign Finance</strong>
              <small>Premium command dock</small>
            </span>
          </a>

          <div class="sfn-current" data-current-enforcement="true">
            <span class="sfn-current-icon" aria-hidden="true">${icon(active.icon)}</span>
            <span>
              <small>Current</small>
              <strong>${escapeHtml(active.label)}</strong>
              <em class="sfn-current-enforcement unknown">Loading policy</em>
            </span>
          </div>

          <div class="sfn-primary">
            ${primaryActions()}
          </div>

          <nav class="sfn-sections" aria-label="Finance sections">
            ${SECTIONS.map(desktopSection).join("")}
          </nav>

          <div class="sfn-footer">
            <span>nav v${VERSION}</span>
            <span>enforcement visible</span>
          </div>
        </div>
      </aside>
    `;
  }

  function mobileNav() {
    const mobileLinks = MOBILE_KEYS.map(linkByKey).filter(Boolean);
    const moreActive = !MOBILE_KEYS.includes(currentKey());

    return `
      <nav class="sf-mobile-nav" data-nav-version="${VERSION}" aria-label="Mobile navigation">
        ${mobileLinks.map(link => navLink(link, "mobile")).join("")}
        <button class="sfm-item sfm-more ${moreActive ? "active" : ""}" type="button" aria-expanded="false" aria-controls="sf-more-panel">
          <span class="sfm-icon" aria-hidden="true">${icon("more")}</span>
          <span class="sfm-label">More</span>
        </button>
      </nav>

      <div class="sf-more-backdrop" hidden></div>

      <aside class="sf-more-panel" id="sf-more-panel" hidden aria-label="More finance tools">
        <div class="sfmore-head">
          <div>
            <strong>More tools</strong>
            <small>Secondary finance pages</small>
          </div>
          <button class="sfmore-close" type="button" aria-label="Close menu"></button>
        </div>

        <div class="sfmore-body">
          ${SECTIONS.map(section => {
            const links = LINKS
              .filter(link => link.section === section.key)
              .filter(link => !MOBILE_KEYS.includes(link.key));

            if (!links.length) return "";

            return `
              <section class="sfmore-section">
                <div class="sfmore-title">${escapeHtml(section.label)}</div>
                <div class="sfmore-grid">
                  ${links.map(link => `
                    <a class="sfmore-link ${link.key === currentKey() ? "active" : ""}" href="${escapeHtml(link.href)}" data-nav-key="${escapeHtml(link.key)}" data-nav-href="${escapeHtml(link.href)}" data-enforcement-status="unknown">
                      <span class="sfmore-icon" aria-hidden="true">${icon(link.icon)}</span>
                      <strong>${escapeHtml(link.label)}</strong>
                      <span class="sfmore-enforcement-badge">...</span>
                    </a>
                  `).join("")}
                </div>
              </section>
            `;
          }).join("")}
        </div>
      </aside>
    `;
  }

  function applyEnforcementMarkers(snapshot) {
    latestEnforcementSnapshot = snapshot || latestEnforcementSnapshot;

    document.querySelectorAll("[data-nav-key][data-nav-href]").forEach(node => {
      const key = node.dataset.navKey;
      const link = linkByKey(key);
      if (!link) return;

      const status = routeStatusFor(link);
      const cls = statusClass(status.status);
      const label = displayStatus(status);

      node.dataset.enforcementStatus = cls;
      node.dataset.enforcementLevel = String(status.level || 0);
      node.dataset.enforcementReason = status.reason || "";
      node.dataset.enforcementSource = status.source || "";
      node.dataset.enforcementFix = status.required_fix || "";
      node.title = [
        label,
        status.reason ? "Reason: " + status.reason : "",
        status.source ? "Source: " + status.source : "",
        status.required_fix ? "Fix: " + status.required_fix : "",
        "Open Command Centre for full block explanation."
      ].filter(Boolean).join("\n");

      const badge = node.querySelector(".sfn-enforcement-badge, .sfm-enforcement-badge, .sfmore-enforcement-badge");
      if (badge) badge.textContent = label;
    });

    const active = currentLink();
    const currentStatus = routeStatusFor(active);
    const currentBadge = document.querySelector(".sfn-current-enforcement");

    if (currentBadge) {
      currentBadge.className = "sfn-current-enforcement " + statusClass(currentStatus.status);
      currentBadge.textContent = displayStatus(currentStatus);
      currentBadge.title = [
        currentStatus.reason ? "Reason: " + currentStatus.reason : "",
        currentStatus.source ? "Source: " + currentStatus.source : "",
        currentStatus.required_fix ? "Fix: " + currentStatus.required_fix : ""
      ].filter(Boolean).join("\n");
    }

    document.documentElement.dataset.enforcementLoaded = latestEnforcementSnapshot && latestEnforcementSnapshot.loaded ? "true" : "false";
    document.documentElement.dataset.enforcementVersion = latestEnforcementSnapshot && latestEnforcementSnapshot.version ? latestEnforcementSnapshot.version : "unknown";

    scheduleOverflowCheck();
  }

  function subscribeToEnforcement() {
    if (!window.SovereignEnforcement || window.__sfNavEnforcementSubscribed) return;

    window.__sfNavEnforcementSubscribed = true;

    window.SovereignEnforcement.subscribe(snapshot => {
      latestEnforcementSnapshot = snapshot;
      applyEnforcementMarkers(snapshot);
    });

    window.SovereignEnforcement.refresh();
  }

  function openMore() {
    const trigger = document.querySelector(".sfm-more");
    const panel = document.querySelector(".sf-more-panel");
    const backdrop = document.querySelector(".sf-more-backdrop");
    if (!trigger || !panel || !backdrop) return;
    trigger.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("sf-more-open");
  }

  function closeMore() {
    const trigger = document.querySelector(".sfm-more");
    const panel = document.querySelector(".sf-more-panel");
    const backdrop = document.querySelector(".sf-more-backdrop");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (panel) panel.hidden = true;
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("sf-more-open");
  }

  function bindEvents() {
    document.querySelectorAll("[data-section-toggle]").forEach(button => {
      button.addEventListener("click", () => {
        const section = button.closest(".sfn-section");
        if (!section) return;

        const nextOpen = !section.classList.contains("open");

        document.querySelectorAll(".sfn-section").forEach(item => {
          if (item !== section) {
            item.classList.remove("open");
            const btn = item.querySelector("[data-section-toggle]");
            if (btn) btn.setAttribute("aria-expanded", "false");
          }
        });

        section.classList.toggle("open", nextOpen);
        button.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      });
    });

    const more = document.querySelector(".sfm-more");
    if (more) {
      more.addEventListener("click", () => {
        const panel = document.querySelector(".sf-more-panel");
        if (panel && !panel.hidden) closeMore();
        else openMore();
      });
    }

    const close = document.querySelector(".sfmore-close");
    const backdrop = document.querySelector(".sf-more-backdrop");
    if (close) close.addEventListener("click", closeMore);
    if (backdrop) backdrop.addEventListener("click", closeMore);

    document.querySelectorAll(".sfmore-link, .sfm-item[href]").forEach(link => {
      link.addEventListener("click", closeMore);
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeMore();
    });

    window.addEventListener("resize", () => {
      if (window.innerWidth > 980) closeMore();
      scheduleOverflowCheck();
    });

    window.addEventListener("orientationchange", () => {
      closeMore();
      scheduleOverflowCheck();
    });
  }

  function markReady() {
    document.body.classList.add("sf-nav-ready");
    document.documentElement.dataset.navVersion = VERSION;
  }

  function scheduleOverflowCheck() {
    window.clearTimeout(window.__sfNavOverflowTimer);
    window.__sfNavOverflowTimer = window.setTimeout(checkOverflow, 180);
  }

  function checkOverflow() {
    const doc = document.documentElement;
    const body = document.body;
    if (!doc || !body) return;

    const overflow = Math.max(doc.scrollWidth, body.scrollWidth) - window.innerWidth;
    doc.dataset.sfOverflow = overflow > 4 ? "true" : "false";

    if (overflow > 4) {
      console.warn("[SovereignNav v" + VERSION + "] horizontal overflow:", Math.round(overflow), "px");
    }
  }

  function removeExistingNav() {
    document
      .querySelectorAll(".sf-shell-nav, .sf-mobile-nav, .sf-more-panel, .sf-more-backdrop")
      .forEach(node => node.remove());
  }

  function mount() {
    if (!document.body) return;

    ensureCss();
    ensureEnforcementCss();
    removeExistingNav();

    document.body.insertAdjacentHTML("afterbegin", desktopNav());
    document.body.insertAdjacentHTML("beforeend", mobileNav());

    markReady();
    bindEvents();
    closeMore();
    applyEnforcementMarkers(null);
    ensureEnforcementScript();
    scheduleOverflowCheck();

    window.setTimeout(scheduleOverflowCheck, 600);
    window.setTimeout(scheduleOverflowCheck, 1400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.SovereignNav = {
    version: VERSION,
    links: LINKS.slice(),
    currentKey,
    currentSectionKey,
    openMore,
    closeMore,
    checkOverflow,
    scheduleOverflowCheck,
    applyEnforcementMarkers
  };
})();
