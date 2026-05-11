/* Sovereign Finance Global Theme Controller v1.0.0
 *
 * One theme authority for the full finance app.
 * Default: light.
 * Storage key shared with nav.js: sf_theme_v1
 * No per-page theme drift.
 */
(function () {
  "use strict";

  const VERSION = "1.0.0";
  const STORAGE_KEY = "sf_theme_v1";
  const VALID = ["light", "dark"];

  function cleanTheme(value) {
    value = String(value || "").trim().toLowerCase();
    return VALID.includes(value) ? value : "light";
  }

  function readStoredTheme() {
    try {
      return cleanTheme(localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      return "light";
    }
  }

  function writeStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, cleanTheme(theme));
    } catch (err) {}
  }

  function removeLegacyThemeClasses() {
    const targets = [document.documentElement, document.body].filter(Boolean);

    targets.forEach(el => {
      el.classList.remove(
        "dark",
        "light",
        "dark-mode",
        "light-mode",
        "theme-dark",
        "theme-light"
      );
    });
  }

  function applyTheme(theme, persist) {
    const next = cleanTheme(theme);

    removeLegacyThemeClasses();

    document.documentElement.setAttribute("data-theme", next);
    document.documentElement.style.colorScheme = next;

    if (document.body) {
      document.body.setAttribute("data-theme", next);
      document.body.style.colorScheme = next;
    }

    let meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "color-scheme";
      document.head.appendChild(meta);
    }
    meta.content = next;

    if (persist !== false) {
      writeStoredTheme(next);
    }

    updateButtons(next);

    window.dispatchEvent(new CustomEvent("sovereign:theme", {
      detail: {
        theme: next,
        version: VERSION
      }
    }));

    return next;
  }

  function updateButtons(theme) {
    document.querySelectorAll("[data-sf-theme-toggle]").forEach(button => {
      button.setAttribute("aria-label", theme === "dark" ? "Use light theme" : "Use dark theme");
      button.setAttribute("title", theme === "dark" ? "Use light theme" : "Use dark theme");
      button.dataset.theme = theme;
    });

    document.querySelectorAll("[data-theme-choice]").forEach(button => {
      const choice = cleanTheme(button.dataset.themeChoice);
      button.classList.toggle("active", choice === theme);
      button.setAttribute("aria-pressed", choice === theme ? "true" : "false");
    });
  }

  function toggleTheme() {
    const current = cleanTheme(document.documentElement.getAttribute("data-theme"));
    return applyTheme(current === "dark" ? "light" : "dark", true);
  }

  function installListeners() {
    document.addEventListener("click", event => {
      const toggle = event.target.closest("[data-sf-theme-toggle]");
      if (toggle) {
        event.preventDefault();
        toggleTheme();
        return;
      }

      const choice = event.target.closest("[data-theme-choice]");
      if (choice) {
        event.preventDefault();
        applyTheme(choice.dataset.themeChoice, true);
      }
    });
  }

  function init() {
    const theme = readStoredTheme();

    applyTheme(theme, false);

    if (!localStorage.getItem(STORAGE_KEY)) {
      writeStoredTheme("light");
    }

    installListeners();

    window.SovereignTheme = {
      version: VERSION,
      storageKey: STORAGE_KEY,
      get: function () {
        return cleanTheme(document.documentElement.getAttribute("data-theme"));
      },
      set: function (theme) {
        return applyTheme(theme, true);
      },
      light: function () {
        return applyTheme("light", true);
      },
      dark: function () {
        return applyTheme("dark", true);
      },
      toggle: toggleTheme,
      reset: function () {
        return applyTheme("light", true);
      }
    };

    console.log("[theme v" + VERSION + "] ready", {
      theme: window.SovereignTheme.get()
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


(function () {
  "use strict";

  if (window.__SOVEREIGN_THEME_TOGGLE_V2__) return;
  window.__SOVEREIGN_THEME_TOGGLE_V2__ = true;

  const STORAGE_KEY = "sovereign-theme";

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {}
  }

  function getSystemTheme() {
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") ||
      document.body?.getAttribute("data-theme") ||
      getStoredTheme() ||
      getSystemTheme();
  }

  function applyTheme(theme) {
    const safeTheme = theme === "dark" ? "dark" : "light";

    document.documentElement.setAttribute("data-theme", safeTheme);
    if (document.body) document.body.setAttribute("data-theme", safeTheme);

    setStoredTheme(safeTheme);

    document.querySelectorAll(".sf-theme-toggle, .sf-floating-theme-toggle").forEach((button) => {
      button.setAttribute("data-theme-state", safeTheme);
      button.setAttribute("aria-label", safeTheme === "dark" ? "Switch to light mode" : "Switch to dark mode");
      button.setAttribute("title", safeTheme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    });
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  function ensureFloatingToggle() {
    if (document.querySelector(".sf-theme-toggle, .sf-floating-theme-toggle")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sf-theme-toggle sf-floating-theme-toggle";
    button.addEventListener("click", toggleTheme);

    document.body.appendChild(button);
  }

  function initThemeToggle() {
    applyTheme(getStoredTheme() || currentTheme());
    ensureFloatingToggle();

    document.querySelectorAll(".sf-theme-toggle, .sf-floating-theme-toggle").forEach((button) => {
      if (button.dataset.themeBound === "1") return;
      button.dataset.themeBound = "1";
      button.addEventListener("click", toggleTheme);
    });

    applyTheme(currentTheme());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initThemeToggle);
  } else {
    initThemeToggle();
  }
})();
