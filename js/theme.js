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
