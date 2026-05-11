(function () {
  function readConfig() {
    return window.SF_PAGE || {};
  }

  function q(selector, root) {
    return (root || document).querySelector(selector);
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

  function ensureAppShell() {
    let shell = q(".sf-app-shell");
    if (!shell) {
      shell = document.createElement("main");
      shell.className = "sf-app-shell";
      while (document.body.firstChild) {
        shell.appendChild(document.body.firstChild);
      }
      document.body.appendChild(shell);
    }
    return shell;
  }

  function renderHero(config) {
    const title = config.title || document.title || "Dashboard";
    const subtitle = config.subtitle || "";
    const eyebrow = config.eyebrow || "Sovereign Finance";
    const actions = Array.isArray(config.actions) ? config.actions : [];
    const actionHtml = actions.map((action) => {
      const href = action.href ? ` href="${window.SFComponents.escapeHtml(action.href)}"` : "";
      const tag = action.href ? "a" : "button";
      const extra = action.href ? "" : ' type="button"';
      return `<${tag} class="sf-button ${action.primary ? "sf-button--primary" : ""}"${href}${extra}>${window.SFComponents.escapeHtml(action.label || "Action")}</${tag}>`;
    }).join("");

    return `
      <header class="sf-page-hero">
        <div class="sf-page-title-group">
          <div class="sf-page-eyebrow">${window.SFComponents.escapeHtml(eyebrow)}</div>
          <h1 class="sf-page-title">${window.SFComponents.escapeHtml(title)}</h1>
          ${subtitle ? `<p class="sf-page-subtitle">${window.SFComponents.escapeHtml(subtitle)}</p>` : ""}
        </div>
        ${actionHtml ? `<div class="sf-page-actions">${actionHtml}</div>` : ""}
      </header>
    `;
  }

  function renderKpis(config) {
    const items = Array.isArray(config.kpis) ? config.kpis : [];
    if (!items.length) return "";
    return `<section class="sf-kpi-row">${items.map(window.SFComponents.metricCard).join("")}</section>`;
  }

  function renderControlRow(config) {
    const items = Array.isArray(config.controls) ? config.controls : [];
    if (!items.length) return "";
    return `<section class="sf-control-row">${items.map(window.SFComponents.chip).join("")}</section>`;
  }

  function mountPageShell() {
    const config = readConfig();
    ensureBodyClass();
    applyDebugMode();
    const appShell = ensureAppShell();

    let pageShell = q(".sf-page-shell", appShell);
    if (!pageShell) {
      const existing = Array.from(appShell.childNodes);
      pageShell = document.createElement("div");
      pageShell.className = "sf-page-shell";
      appShell.appendChild(pageShell);

      const contentSlot = document.createElement("section");
      contentSlot.className = "sf-page-content";
      existing.forEach((node) => contentSlot.appendChild(node));

      pageShell.innerHTML = renderHero(config) + renderControlRow(config) + renderKpis(config);
      pageShell.appendChild(contentSlot);
    }

    if (config.title) document.title = config.title;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPageShell, { once: true });
  } else {
    mountPageShell();
  }

  window.SFShell = {
    mount: mountPageShell,
    debugEnabled: () => document.body.classList.contains("sf-debug-mode")
  };
})();
