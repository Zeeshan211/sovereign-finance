/* Sovereign Finance Nav v1.1.9
   Scroll-with-page premium command dock with scoped SVG icons.

   Contract:
   - Visual navigation only.
   - No API calls.
   - No finance logic.
   - No balances.
   - No backend.
   - No D1.
   - No contract endpoint.
   - SVG icons are scoped inside nav only.
*/

(function () {
  "use strict";

  const VERSION = "1.1.9";
  const CSS_HREF = "/css/nav.css?v=1.1.9";

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

  function removeExistingNav() {
    document
      .querySelectorAll(".sf-shell-nav, .sf-mobile-nav, .sf-more-panel, .sf-more-backdrop")
      .forEach(node => node.remove());
  }

  function navLink(link, mode) {
    const active = link.key === currentKey();

    return `
      <a
        class="${mode === "mobile" ? "sfm-item" : "sfn-link"} ${active ? "active" : ""}"
        href="${escapeHtml(link.href)}"
        data-nav-key="${escapeHtml(link.key)}"
        aria-current="${active ? "page" : "false"}"
      >
        <span class="${mode === "mobile" ? "sfm-icon" : "sfn-icon"}" aria-hidden="true">${icon(link.icon)}</span>
        <span class="${mode === "mobile" ? "sfm-label" : "sfn-label"}">${escapeHtml(link.label)}</span>
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
          <span class="sfn-chevron" aria-hidden="true">⌄</span>
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
        <a class="sfn-primary-btn" href="${escapeHtml(link.href)}">
          <span class="sfn-primary-icon" aria-hidden="true">${icon(link.icon)}</span>
          <strong>${escapeHtml(link.label)}</strong>
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

          <div class="sfn-current">
            <span class="sfn-current-icon" aria-hidden="true">${icon(active.icon)}</span>
            <span>
              <small>Current</small>
              <strong>${escapeHtml(active.label)}</strong>
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
            <span>visual only</span>
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
          <button class="sfmore-close" type="button" aria-label="Close menu">×</button>
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
                    <a class="sfmore-link ${link.key === currentKey() ? "active" : ""}" href="${escapeHtml(link.href)}">
                      <span class="sfmore-icon" aria-hidden="true">${icon(link.icon)}</span>
                      <strong>${escapeHtml(link.label)}</strong>
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

  function mount() {
    if (!document.body) return;

    ensureCss();
    removeExistingNav();

    document.body.insertAdjacentHTML("afterbegin", desktopNav());
    document.body.insertAdjacentHTML("beforeend", mobileNav());

    markReady();
    bindEvents();
    closeMore();
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
    scheduleOverflowCheck
  };
})();
