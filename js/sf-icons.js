(function () {
  "use strict";

  const VERSION = "sf-icons-v1.0.0";

  const ACCOUNT_ICON = {
    cash: "💵",
    meezan: "🕌",
    mashreq: "🏛",
    ubl: "🏦",
    ubl_prepaid: "💳",
    easypaisa: "📲",
    jazzcash: "📱",
    naya_pay: "💠",
    js_bank: "💼",
    alfalah: "🏢",
    cc: "🪪"
  };

  const ACCOUNT_NAME_ICON = {
    cash: "💵",
    meezan: "🕌",
    "mashreq bank": "🏛",
    mashreq: "🏛",
    ubl: "🏦",
    "ubl prepaid": "💳",
    easypaisa: "📲",
    jazzcash: "📱",
    "naya pay": "💠",
    "js bank": "💼",
    "bank alfalah": "🏢",
    "alfalah cc": "🪪",
    "credit card": "💳"
  };

  const CATEGORY_ICON = {
    groceries: "🛒",
    food_dining: "🍽",
    transport: "🚗",
    bills_utilities: "🧾",
    health: "⚕",
    bank_fee: "🏦",
    atm_fee: "🏧",
    credit_card: "💳",
    debt_payment: "↔",
    salary_income: "💰",
    manual_income: "➕",
    transfer: "⇄",
    misc: "•"
  };

  const CATEGORY_NAME_ICON = {
    groceries: "🛒",
    "food & dining": "🍽",
    food: "🍽",
    dining: "🍽",
    transport: "🚗",
    "bills & utilities": "🧾",
    bills: "🧾",
    bill: "🧾",
    utilities: "🧾",
    health: "⚕",
    "bank fee": "🏦",
    "atm fee": "🏧",
    "credit card": "💳",
    debt: "↔",
    "debt payment": "↔",
    salary: "💰",
    "salary income": "💰",
    income: "💰",
    "manual income": "➕",
    transfer: "⇄",
    miscellaneous: "•",
    misc: "•",
    uncategorized: "•"
  };

  let cachedAccounts = [];
  let cachedCategories = [];

  window.SovereignIcons = {
    version: VERSION,
    accountIcon,
    categoryIcon,
    decorate
  };

  function clean(value) {
    return String(value == null ? "" : value).trim();
  }

  function key(value) {
    return clean(value).toLowerCase();
  }

  function hasIconPrefix(text) {
    const value = clean(text);
    if (!value) return false;

    return /^(💵|🕌|🏛|🏦|💳|📲|📱|💠|💼|🏢|🪪|🛒|🍽|🚗|🧾|⚕|🏧|↔|💰|➕|⇄|•)\s/.test(value);
  }

  function accountIcon(accountOrId) {
    if (typeof accountOrId === "object" && accountOrId) {
      const explicit = clean(accountOrId.icon);
      if (explicit) return explicit;

      const id = clean(accountOrId.id || accountOrId.account_id);
      if (ACCOUNT_ICON[id]) return ACCOUNT_ICON[id];

      const name = key(accountOrId.name || accountOrId.account_name || accountOrId.label);
      if (ACCOUNT_NAME_ICON[name]) return ACCOUNT_NAME_ICON[name];
    }

    const id = clean(accountOrId);
    return ACCOUNT_ICON[id] || ACCOUNT_NAME_ICON[key(id)] || "◫";
  }

  function categoryIcon(categoryOrId) {
    if (typeof categoryOrId === "object" && categoryOrId) {
      const explicit = clean(categoryOrId.icon);
      if (explicit) return explicit;

      const id = clean(categoryOrId.id || categoryOrId.category_id);
      if (CATEGORY_ICON[id]) return CATEGORY_ICON[id];

      const name = key(categoryOrId.name || categoryOrId.category_name || categoryOrId.label);
      if (CATEGORY_NAME_ICON[name]) return CATEGORY_NAME_ICON[name];
    }

    const id = clean(categoryOrId);
    return CATEGORY_ICON[id] || CATEGORY_NAME_ICON[key(id)] || "•";
  }

  function accountIconFromText(text) {
    const lower = key(text);

    const matchedAccount = cachedAccounts
      .slice()
      .sort((a, b) => clean(b.name).length - clean(a.name).length)
      .find(account => {
        const id = key(account.id);
        const name = key(account.name);
        return (id && lower.includes(id)) || (name && lower.includes(name));
      });

    if (matchedAccount) return accountIcon(matchedAccount);

    const matchedName = Object.keys(ACCOUNT_NAME_ICON)
      .sort((a, b) => b.length - a.length)
      .find(name => lower.includes(name));

    return matchedName ? ACCOUNT_NAME_ICON[matchedName] : "";
  }

  function categoryIconFromText(text) {
    const lower = key(text);

    const matchedCategory = cachedCategories
      .slice()
      .sort((a, b) => clean(b.name).length - clean(a.name).length)
      .find(category => {
        const id = key(category.id);
        const name = key(category.name);
        return (id && lower === id) || (name && lower === name);
      });

    if (matchedCategory) return categoryIcon(matchedCategory);

    const matchedName = Object.keys(CATEGORY_NAME_ICON)
      .sort((a, b) => b.length - a.length)
      .find(name => lower === name);

    return matchedName ? CATEGORY_NAME_ICON[matchedName] : "";
  }

  async function loadReferenceData() {
    try {
      const [accounts, categories] = await Promise.all([
        fetch("/api/accounts?cb=" + Date.now()).then(r => r.json()),
        fetch("/api/categories?cb=" + Date.now()).then(r => r.json())
      ]);

      cachedAccounts = Array.isArray(accounts.accounts) ? accounts.accounts : [];
      cachedCategories = Array.isArray(categories.categories) ? categories.categories : [];
    } catch (err) {
      cachedAccounts = [];
      cachedCategories = [];
      console.warn("[icons] reference load failed", err);
    }
  }

  function prependIcon(element, icon) {
    if (!element || !icon) return;
    if (element.dataset.sfIconized === "1") return;
    if (hasIconPrefix(element.textContent)) {
      element.dataset.sfIconized = "1";
      return;
    }

    const span = document.createElement("span");
    span.className = "sf-icon-prefix";
    span.textContent = icon;

    element.prepend(document.createTextNode(" "));
    element.prepend(span);

    element.dataset.sfIconized = "1";
  }

  function decorateOption(option, icon) {
    if (!option || !icon) return;
    if (option.dataset.sfIconized === "1") return;
    if (!option.value) return;
    if (hasIconPrefix(option.textContent)) {
      option.dataset.sfIconized = "1";
      return;
    }

    option.textContent = icon + " " + option.textContent;
    option.dataset.sfIconized = "1";
  }

  function decorateSelects() {
    document.querySelectorAll("select option").forEach(option => {
      const value = clean(option.value);
      if (!value) return;

      const select = option.closest("select");
      const selectId = key(select && select.id);

      if (
        selectId.includes("account") ||
        ACCOUNT_ICON[value] ||
        cachedAccounts.some(account => clean(account.id) === value)
      ) {
        const account = cachedAccounts.find(item => clean(item.id) === value);
        decorateOption(option, accountIcon(account || value));
        return;
      }

      if (
        selectId.includes("category") ||
        CATEGORY_ICON[value] ||
        cachedCategories.some(category => clean(category.id) === value)
      ) {
        const category = cachedCategories.find(item => clean(item.id) === value);
        decorateOption(option, categoryIcon(category || value));
      }
    });
  }

  function decorateLedgerRows() {
    document.querySelectorAll(".ledger-table tbody tr, .tx-table tbody tr").forEach(row => {
      const cells = row.children;
      if (!cells || cells.length < 4) return;

      const movementCell = cells[2];
      const categoryCell = cells[3];

      const movementPrimary =
        movementCell.querySelector(".ledger-primary, .tx-primary") ||
        movementCell;

      const categoryTarget = categoryCell;

      const movementIcon = accountIconFromText(movementPrimary.textContent);
      prependIcon(movementPrimary, movementIcon);

      const catIcon = categoryIconFromText(categoryTarget.textContent);
      prependIcon(categoryTarget, catIcon);
    });
  }

  function decorateAccountCards() {
    document.querySelectorAll(".strong, .hub-row-title, .ledger-primary, .tx-primary").forEach(el => {
      if (el.dataset.sfIconized === "1") return;

      const text = clean(el.textContent);
      if (!text || text.length > 80) return;

      const accountMatch = cachedAccounts.find(account => key(account.name) === key(text) || key(account.id) === key(text));
      if (accountMatch) {
        prependIcon(el, accountIcon(accountMatch));
        return;
      }

      const categoryMatch = cachedCategories.find(category => key(category.name) === key(text) || key(category.id) === key(text));
      if (categoryMatch) {
        prependIcon(el, categoryIcon(categoryMatch));
      }
    });
  }

  function decorate() {
    decorateSelects();
    decorateLedgerRows();
    decorateAccountCards();
  }

  function observe() {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(decorate, 120);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  async function init() {
    await loadReferenceData();
    decorate();
    observe();

    console.log("[icons " + VERSION + "] ready", {
      accounts: cachedAccounts.length,
      categories: cachedCategories.length
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
