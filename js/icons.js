/* Sovereign Finance Icons v1.0.0
   Stable visual icon resolver.

   Contract:
   - Visual only.
   - No API calls.
   - No backend.
   - No D1.
   - No finance logic.
   - No mutation.
   - Bank/logo assets can be replaced later without code changes.
   - Missing assets fall back safely to initials.
*/

(function () {
  "use strict";

  const VERSION = "1.0.0";

  const BANKS = {
    cash: {
      label: "Cash",
      asset: "/assets/banks/cash.svg",
      fallback: "₨",
      tone: "cash"
    },
    meezan: {
      label: "Meezan",
      asset: "/assets/banks/meezan.svg",
      fallback: "M",
      tone: "meezan"
    },
    mashreq: {
      label: "Mashreq Bank",
      asset: "/assets/banks/mashreq.svg",
      fallback: "M",
      tone: "mashreq"
    },
    ubl: {
      label: "UBL",
      asset: "/assets/banks/ubl.svg",
      fallback: "U",
      tone: "ubl"
    },
    ubl_prepaid: {
      label: "UBL Prepaid",
      asset: "/assets/banks/ubl-prepaid.svg",
      fallback: "U",
      tone: "ubl"
    },
    easypaisa: {
      label: "Easypaisa",
      asset: "/assets/banks/easypaisa.svg",
      fallback: "E",
      tone: "easypaisa"
    },
    jazzcash: {
      label: "JazzCash",
      asset: "/assets/banks/jazzcash.svg",
      fallback: "J",
      tone: "jazzcash"
    },
    naya_pay: {
      label: "Naya Pay",
      asset: "/assets/banks/nayapay.svg",
      fallback: "N",
      tone: "nayapay"
    },
    js_bank: {
      label: "JS Bank",
      asset: "/assets/banks/js-bank.svg",
      fallback: "JS",
      tone: "js"
    },
    alfalah: {
      label: "Bank Alfalah",
      asset: "/assets/banks/alfalah.svg",
      fallback: "A",
      tone: "alfalah"
    },
    cc: {
      label: "Alfalah Credit Card",
      asset: "/assets/banks/alfalah-cc.svg",
      fallback: "CC",
      tone: "card"
    }
  };

  const CATEGORIES = {
    food: { label: "Food", fallback: "F", icon: "utensils", tone: "orange" },
    groceries: { label: "Groceries", fallback: "G", icon: "cart", tone: "green" },
    transport: { label: "Transport", fallback: "T", icon: "car", tone: "blue" },
    fuel: { label: "Fuel", fallback: "F", icon: "fuel", tone: "red" },
    bills: { label: "Bills", fallback: "B", icon: "receipt", tone: "amber" },
    utilities: { label: "Utilities", fallback: "U", icon: "bolt", tone: "amber" },
    health: { label: "Health", fallback: "H", icon: "heart", tone: "red" },
    medicine: { label: "Medicine", fallback: "M", icon: "heart", tone: "red" },
    salary: { label: "Salary", fallback: "S", icon: "banknote", tone: "green" },
    income: { label: "Income", fallback: "I", icon: "inflow", tone: "green" },
    debt: { label: "Debt", fallback: "D", icon: "scale", tone: "red" },
    credit_card: { label: "Credit Card", fallback: "C", icon: "card", tone: "blue" },
    atm: { label: "ATM", fallback: "A", icon: "atm", tone: "violet" },
    transfer: { label: "Transfer", fallback: "T", icon: "transfer", tone: "blue" },
    shopping: { label: "Shopping", fallback: "S", icon: "bag", tone: "violet" },
    family: { label: "Family", fallback: "F", icon: "home", tone: "green" },
    personal: { label: "Personal", fallback: "P", icon: "user", tone: "slate" },
    other: { label: "Other", fallback: "O", icon: "dot", tone: "slate" }
  };

  const SVG = {
    utensils: '<svg viewBox="0 0 24 24"><path d="M7 3v8"/><path d="M5 3v8"/><path d="M9 3v8"/><path d="M5 11h4"/><path d="M7 11v10"/><path d="M17 3v18"/><path d="M14 3c0 5 0 8 3 8"/></svg>',
    cart: '<svg viewBox="0 0 24 24"><path d="M4 5h2l2 10h9l2-7H7"/><path d="M9 20h.01"/><path d="M17 20h.01"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="M5 13l2-5h10l2 5"/><path d="M5 13h14v5H5z"/><path d="M7 18v2"/><path d="M17 18v2"/><path d="M8 15h.01"/><path d="M16 15h.01"/></svg>',
    fuel: '<svg viewBox="0 0 24 24"><path d="M6 3h8v18H6z"/><path d="M9 7h2"/><path d="M14 8h3l2 2v7a2 2 0 0 1-2 2h-1"/><path d="M19 10h-2"/></svg>',
    receipt: '<svg viewBox="0 0 24 24"><path d="M7 3h10a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2-2-1.3V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.4-9-9.2C1.7 8.7 3.6 5 7 5c2 0 3.2 1.1 5 3 1.8-1.9 3-3 5-3 3.4 0 5.3 3.7 4 6.8C19 16.6 12 21 12 21Z"/></svg>',
    banknote: '<svg viewBox="0 0 24 24"><path d="M4 7h16v10H4z"/><path d="M8 11h.01"/><path d="M16 13h.01"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>',
    inflow: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
    scale: '<svg viewBox="0 0 24 24"><path d="M12 4v16"/><path d="M6 8h12"/><path d="M7 8l-3 6h6L7 8Z"/><path d="m17 8-3 6h6l-3-6Z"/></svg>',
    card: '<svg viewBox="0 0 24 24"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/><path d="M4 10h16"/><path d="M7 15h4"/></svg>',
    atm: '<svg viewBox="0 0 24 24"><path d="M5 5h14v14H5z"/><path d="M8 9h8"/><path d="M8 13h5"/><path d="M9 17h6"/><path d="M12 9v8"/></svg>',
    transfer: '<svg viewBox="0 0 24 24"><path d="M7 7h11"/><path d="m14 4 4 3-4 3"/><path d="M17 17H6"/><path d="m10 14-4 3 4 3"/></svg>',
    bag: '<svg viewBox="0 0 24 24"><path d="M6 8h12l-1 13H7L6 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>',
    user: '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    dot: '<svg viewBox="0 0 24 24"><path d="M12 12h.01"/></svg>'
  };

  function cleanKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function bankConfig(input) {
    const key = cleanKey(input);
    return BANKS[key] || {
      label: String(input || "Account"),
      asset: "",
      fallback: String(input || "A").slice(0, 2).toUpperCase(),
      tone: "default"
    };
  }

  function categoryConfig(input) {
    const key = cleanKey(input);
    return CATEGORIES[key] || {
      label: String(input || "Category"),
      fallback: String(input || "C").slice(0, 2).toUpperCase(),
      icon: "dot",
      tone: "slate"
    };
  }

  function bank(input, options = {}) {
    const cfg = bankConfig(input);
    const label = options.label || cfg.label;
    const size = options.size || "md";

    if (cfg.asset) {
      return `
        <span class="sf-bank-logo-wrap sf-icon-${escapeHtml(size)} sf-bank-${escapeHtml(cfg.tone)}" title="${escapeHtml(label)}">
          <img
            class="sf-bank-logo"
            src="${escapeHtml(cfg.asset)}"
            alt="${escapeHtml(label)}"
            loading="lazy"
            onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';"
          />
          <span class="sf-bank-fallback" style="display:none;">${escapeHtml(cfg.fallback)}</span>
        </span>
      `;
    }

    return `
      <span class="sf-bank-logo-wrap sf-icon-${escapeHtml(size)} sf-bank-${escapeHtml(cfg.tone)}" title="${escapeHtml(label)}">
        <span class="sf-bank-fallback">${escapeHtml(cfg.fallback)}</span>
      </span>
    `;
  }

  function category(input, options = {}) {
    const cfg = categoryConfig(input);
    const label = options.label || cfg.label;
    const size = options.size || "md";
    const svg = SVG[cfg.icon] || SVG.dot;

    return `
      <span class="sf-category-icon sf-icon-${escapeHtml(size)} sf-cat-${escapeHtml(cfg.tone)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
        ${svg}
      </span>
    `;
  }

  function decorateBankElements(root = document) {
    root.querySelectorAll("[data-bank-icon]").forEach(node => {
      const key = node.getAttribute("data-bank-icon") || "";
      const label = node.getAttribute("data-bank-label") || key;
      const size = node.getAttribute("data-icon-size") || "md";
      node.innerHTML = bank(key, { label, size });
    });
  }

  function decorateCategoryElements(root = document) {
    root.querySelectorAll("[data-category-icon]").forEach(node => {
      const key = node.getAttribute("data-category-icon") || "";
      const label = node.getAttribute("data-category-label") || key;
      const size = node.getAttribute("data-icon-size") || "md";
      node.innerHTML = category(key, { label, size });
    });
  }

  function decorate(root = document) {
    decorateBankElements(root);
    decorateCategoryElements(root);
  }

  window.SovereignIcons = {
    version: VERSION,
    bank,
    category,
    decorate,
    bankConfig,
    categoryConfig,
    banks: { ...BANKS },
    categories: { ...CATEGORIES }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => decorate(document));
  } else {
    decorate(document);
  }
})();
