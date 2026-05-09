/* Sovereign Finance Nav v1.1.4
   Visual-only minimal side panel shell

   Contract:
   - No API calls.
   - No finance logic.
   - No balances.
   - No backend.
   - No D1.
   - Renders navigation only.
   - Loads /css/nav.css dynamically.
*/

(function () {
  "use strict";

  const VERSION = "1.1.4";
  const CSS_HREF = "/css/nav.css?v=1.1.4";

  const LINKS = [
    { key: "hub", label: "Hub", short: "Hub", href: "/index.html", section: "command", mark: "H", mobile: true },
    { key: "forecast", label: "Forecast", short: "Fcst", href: "/forecast.html", section: "command", mark: "F" },
    { key: "monthly-close", label: "Monthly Close", short: "Close", href: "/monthly-close.html", section: "command", mark: "M" },

    { key: "add", label: "Add", short: "Add", href: "/add.html", section: "money", mark: "+", mobile: true },
    { key: "transactions", label: "Transactions", short: "Txns", href: "/transactions.html", section: "money", mark: "T", mobile: true },
    { key: "accounts", label: "Accounts", short: "Accts", href: "/accounts.html", section: "money", mark: "A" },
    { key: "reconciliation", label: "Reconciliation", short: "Recon", href: "/reconciliation.html", section: "money", mark: "R" },

    { key: "bills", label: "Bills", short: "Bills", href: "/bills.html", section: "obligations", mark: "B", mobile: true },
    { key: "debts", label: "Debts", short: "Debts", href: "/debts.html", section: "obligations", mark: "D" },
    { key: "cc", label: "Credit Card", short: "Card", href: "/cc.html", section: "obligations", mark: "C" },
    { key: "atm", label: "ATM", short: "ATM", href: "/atm.html", section: "obligations", mark: "₹" },
    { key: "nano-loans", label: "Nano Loans", short: "Nano", href: "/nano-loans.html", section: "obligations", mark: "N" },

    { key: "salary", label: "Salary", short: "Salary", href: "/salary.html", section: "planning", mark: "S" },
    { key: "charts", label: "Charts", short: "Charts", href: "/charts.html", section: "records", mark: "G" },
    { key: "audit", label: "Audit", short: "Audit", href: "/audit.html", section: "records", mark: "L" },
    { key: "snapshots", label: "Snapshots", short: "Snaps", href: "/snapshots.html", section: "records", mark: "P" }
  ];

  const SECTIONS = [
    { key: "command", label: "Command", hint: "Today and next move" },
    { key: "money", label: "Money", hint: "Entry and ledger" },
    { key: "obligations", label: "Obligations", hint: "Bills, debts, card" },
    { key: "planning", label: "Planning", hint: "Income and future" },
    { key: "records", label: "Records", hint: "Proof and history" }
  ];

  const MOBILE_KEYS = ["hub", "add", "transactions", "bills"];

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
    const link = currentLink();
    return link.section || "command";
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

  function removeOldNav() {
    document
      .querySelectorAll(".sf-shell-nav, .sf-mobile-nav, .sf-more-panel, .sf-more-backdrop")
      .forEach(node => node.remove());
  }

  function navLink(link, mode) {
    const active = link.key === currentKey();
    const label = mode === "mobile" ? link.short : link.label;

    return `
      <a
        class="${mode === "mobile" ? "sfm-item" : "sfn-link"} ${active ? "active" : ""}"
        href="${escapeHtml(link.href)}"
        data-nav-key="${escapeHtml(link.key)}"
        aria-current="${active ? "page" : "false"}"
      >
        <span class="${mode === "mobile" ? "sfm-mark" : "sfn-mark"}">${escapeHtml(link.mark)}</span>
        <span class="${mode === "mobile" ? "sfm-label" : "sfn-label"}">${escapeHtml(label)}</span>
      </a>
    `;
  }

  function desktopSection(section) {
    const links = LINKS.filter(link => link.section === section.key);
    if (!links.length) return "";

    const open = section.key === currentSectionKey();

    return `
      <section class="sfn-section ${open ? "open" : ""}">
        <button class="sfn-section-head" type="button" data-section-toggle="${escapeHtml(section.key)}" aria-expanded="${open ? "true" : "false"}">
          <span>
            <strong>${escapeHtml(section.label)}</strong>
            <small>${escapeHtml(section.hint)}</small>
          </span>
          <span class="sfn-chevron">⌄</span>
        </button>

        <div class="sfn-section-body">
          ${links.map(link => navLink(link, "desktop")).join("")}
        </div>
      </section>
    `;
  }

  function desktopNav() {
    const active = currentLink();

    return `
      <aside class="sf-shell-nav" data-nav-version="${VERSION}" aria-label="Sovereign Finance navigation">
        <div class="sfn-card">
          <a class="sfn-brand" href="/index.html">
            <span class="sfn-brand-mark">SF</span>
            <span class="sfn-brand-text">
              <strong>Sovereign Finance</strong>
              <small>Clean money cockpit</small>
            </span>
          </a>

          <div class="sfn-active-card">
            <span class="sfn-active-mark">${escapeHtml(active.mark)}</span>
            <span>
              <small>Current page</small>
              <strong>${escapeHtml(active.label)}</strong>
            </span>
          </div>

          <div class="sfn-quick">
            ${["hub", "add", "transactions"].map(key => {
              const link = linkByKey(key);
              return link ? `
                <a class="sfn-quick-btn ${link.key === currentKey() ? "active" : ""}" href="${escapeHtml(link.href)}">
                  <span>${escapeHtml(link.mark)}</span>
                  <strong>${escapeHtml(link.short)}</strong>
                </a>
              ` : "";
            }).join("")}
          </div>

          <nav class="sfn-sections">
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
          <span class="sfm-mark">⋯</span>
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
          <button class="sfmore-close" type="button" aria-label="Close">×</button>
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
                      <span>${escapeHtml(link.mark)}</span>
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

        const open = section.classList.toggle("open");
        button.setAttribute("aria-expanded", open ? "true" : "false");
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
    removeOldNav();

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
