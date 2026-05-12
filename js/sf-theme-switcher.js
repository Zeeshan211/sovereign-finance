/* Sovereign Finance Theme Switcher v2.0.0
 *
 * Folded floating button at top-right of every page.
 * Click to expand → combo panel with 12 accents + 11 backgrounds.
 * Click outside or press ESC to fold back.
 *
 * Storage:
 *   sf-accent  string  active palette id
 *   sf-bg      string  active background id
 *
 * Mounts to document.body (no sidebar dependency, works on every page).
 * Loads via single <script src="/js/sf-theme-switcher.js"></script> in <head>.
 */
(function () {
  "use strict";

  var VERSION = "v2.0.0";
  var KEY_ACCENT = "sf-accent";
  var KEY_BG = "sf-bg";
  var DEFAULT_ACCENT = "sapphire";
  var DEFAULT_BG = "slate";

  var ACCENTS = [
    { id: "sapphire",  name: "Sapphire",     hex: "#5ba2ff" },
    { id: "violet",    name: "Royal Violet", hex: "#7c5cff" },
    { id: "amethyst",  name: "Amethyst",     hex: "#b86dff" },
    { id: "emerald",   name: "Emerald",      hex: "#34d399" },
    { id: "teal",      name: "Deep Teal",    hex: "#2dd4bf" },
    { id: "sage",      name: "Sage",         hex: "#a8c7af" },
    { id: "champagne", name: "Champagne",    hex: "#f0c878" },
    { id: "copper",    name: "Copper",       hex: "#e89567" },
    { id: "crimson",   name: "Crimson",      hex: "#f43f5e" },
    { id: "rose",      name: "Rose Gold",    hex: "#f0a8b8" },
    { id: "graphite",  name: "Graphite",     hex: "#e4e4e7" },
    { id: "ice",       name: "Ice",          hex: "#67e8f9" }
  ];

  var BACKGROUNDS = [
    { id: "slate",       name: "Slate",     color: "#07111f" },
    { id: "obsidian",    name: "Obsidian",  color: "#0a0a0c" },
    { id: "graphite-bg", name: "Graphite",  color: "#161618" },
    { id: "charcoal",    name: "Charcoal",  color: "#1c1c1e" },
    { id: "midnight",    name: "Midnight",  color: "#0d0d12" },
    { id: "plum",        name: "Plum",      color: "#14101c" },
    { id: "espresso",    name: "Espresso",  color: "#1a1612" },
    { id: "forest",      name: "Forest",    color: "#0a1410" },
    { id: "black",       name: "Black",     color: "#000000" },
    { id: "linen",       name: "Linen",     color: "#faf8f3" },
    { id: "pearl",       name: "Pearl",     color: "#f5f5f7" }
  ];

  // ===== Storage =====
  function safeGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function isAccent(id) { for (var i = 0; i < ACCENTS.length; i++) if (ACCENTS[i].id === id) return true; return false; }
  function isBg(id) { for (var i = 0; i < BACKGROUNDS.length; i++) if (BACKGROUNDS[i].id === id) return true; return false; }
  function findAccent(id) { for (var i = 0; i < ACCENTS.length; i++) if (ACCENTS[i].id === id) return ACCENTS[i]; return ACCENTS[0]; }
  function findBg(id) { for (var i = 0; i < BACKGROUNDS.length; i++) if (BACKGROUNDS[i].id === id) return BACKGROUNDS[i]; return BACKGROUNDS[0]; }
  function getAccent() { var v = safeGet(KEY_ACCENT, DEFAULT_ACCENT); return isAccent(v) ? v : DEFAULT_ACCENT; }
  function getBg() { var v = safeGet(KEY_BG, DEFAULT_BG); return isBg(v) ? v : DEFAULT_BG; }

  function applyAccent(id) {
    if (!isAccent(id)) id = DEFAULT_ACCENT;
    document.documentElement.setAttribute("data-accent", id);
    safeSet(KEY_ACCENT, id);
  }
  function applyBg(id) {
    if (!isBg(id)) id = DEFAULT_BG;
    document.documentElement.setAttribute("data-bg", id);
    safeSet(KEY_BG, id);
  }

  // ===== Bootstrap (sync, before paint) =====
  (function () {
    document.documentElement.setAttribute("data-accent", getAccent());
    document.documentElement.setAttribute("data-bg", getBg());
  })();

  // ===== UI =====
  var buttonEl = null;
  var panelEl = null;
  var isOpen = false;

  function buildButton() {
    var btn = document.createElement("button");
    btn.className = "sf-theme-fab";
    btn.setAttribute("aria-label", "Open theme switcher");
    btn.setAttribute("title", "Theme");
    btn.innerHTML = renderFabIcon();
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggle();
    });
    return btn;
  }

  function renderFabIcon() {
    var a = findAccent(getAccent());
    var b = findBg(getBg());
    return (
      '<span class="sf-fab-stack">' +
        '<span class="sf-fab-dot sf-fab-bg" style="background:' + b.color + '"></span>' +
        '<span class="sf-fab-dot sf-fab-accent" style="background:' + a.hex + '"></span>' +
      '</span>'
    );
  }

  function refreshButton() {
    if (buttonEl) buttonEl.innerHTML = renderFabIcon();
  }

  function buildPanel() {
    var currentA = getAccent();
    var currentB = getBg();
    var panel = document.createElement("div");
    panel.className = "sf-theme-panel";
    panel.innerHTML =
      '<div class="sf-theme-panel-head">' +
        '<div>' +
          '<div class="sf-theme-panel-kicker">Theme</div>' +
          '<div class="sf-theme-panel-combo"><b>' + findAccent(currentA).name + '</b> on <b>' + findBg(currentB).name + '</b></div>' +
        '</div>' +
        '<button class="sf-theme-panel-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="sf-theme-section">' +
        '<div class="sf-theme-section-label">Accent</div>' +
        '<div class="sf-theme-grid sf-theme-grid-accent">' +
          ACCENTS.map(function (p) {
            return '<button class="sf-theme-pick' + (p.id === currentA ? ' is-active' : '') + '"' +
                   ' data-axis="accent" data-id="' + p.id + '"' +
                   ' title="' + p.name + '"' +
                   ' style="--sf-pick:' + p.hex + '">' +
                     '<span class="sf-theme-pick-swatch"></span>' +
                     '<span class="sf-theme-pick-name">' + p.name + '</span>' +
                   '</button>';
          }).join("") +
        '</div>' +
      '</div>' +
      '<div class="sf-theme-section">' +
        '<div class="sf-theme-section-label">Background</div>' +
        '<div class="sf-theme-grid sf-theme-grid-bg">' +
          BACKGROUNDS.map(function (b) {
            return '<button class="sf-theme-pick' + (b.id === currentB ? ' is-active' : '') + '"' +
                   ' data-axis="bg" data-id="' + b.id + '"' +
                   ' title="' + b.name + '"' +
                   ' style="--sf-pick:' + b.color + '">' +
                     '<span class="sf-theme-pick-swatch sf-theme-pick-square"></span>' +
                     '<span class="sf-theme-pick-name">' + b.name + '</span>' +
                   '</button>';
          }).join("") +
        '</div>' +
      '</div>';

    panel.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest(".sf-theme-panel-close")) { close(); return; }
      var pick = e.target.closest(".sf-theme-pick");
      if (!pick) return;
      var axis = pick.getAttribute("data-axis");
      var id = pick.getAttribute("data-id");
      if (axis === "accent") applyAccent(id);
      else applyBg(id);
      refreshPanel();
      refreshButton();
    });

    return panel;
  }

  function refreshPanel() {
    if (!panelEl || !panelEl.parentNode) return;
    var fresh = buildPanel();
    fresh.classList.add("is-open");
    panelEl.parentNode.replaceChild(fresh, panelEl);
    panelEl = fresh;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
    requestAnimationFrame(function () { panelEl.classList.add("is-open"); });
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onEsc);
    if (buttonEl) buttonEl.classList.add("is-open");
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (panelEl) {
      panelEl.classList.remove("is-open");
      var dying = panelEl;
      panelEl = null;
      setTimeout(function () { if (dying.parentNode) dying.parentNode.removeChild(dying); }, 200);
    }
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onEsc);
    if (buttonEl) buttonEl.classList.remove("is-open");
  }
  function toggle() { isOpen ? close() : open(); }
  function onDocClick(e) {
    if (panelEl && (panelEl === e.target || panelEl.contains(e.target))) return;
    if (buttonEl && (buttonEl === e.target || buttonEl.contains(e.target))) return;
    close();
  }
  function onEsc(e) { if (e.key === "Escape") close(); }

  function injectStyles() {
    if (document.getElementById("sf-theme-switcher-styles")) return;
    var css =
      '.sf-theme-fab{position:fixed;top:14px;right:14px;z-index:9998;width:42px;height:42px;border-radius:14px;border:1px solid var(--sf-border,rgba(255,255,255,.14));background:var(--sf-surface-1,rgba(20,20,24,.9));backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:var(--sf-shadow-sm,0 10px 24px rgba(0,0,0,.18));transition:transform .15s var(--sf-ease,ease),border-color .15s var(--sf-ease,ease),box-shadow .15s var(--sf-ease,ease);padding:0;}' +
      '.sf-theme-fab:hover{transform:translateY(-1px);border-color:var(--sf-accent-border,rgba(91,162,255,.34));box-shadow:0 8px 24px var(--sf-accent-glow,rgba(91,162,255,.36));}' +
      '.sf-theme-fab.is-open{border-color:var(--sf-accent-border,rgba(91,162,255,.34));box-shadow:0 0 0 2px var(--sf-accent-soft,rgba(91,162,255,.16));}' +
      '.sf-fab-stack{position:relative;width:24px;height:24px;}' +
      '.sf-fab-dot{position:absolute;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--sf-surface-1,rgba(20,20,24,.9));}' +
      '.sf-fab-bg{top:0;left:0;}' +
      '.sf-fab-accent{bottom:0;right:0;}' +

      '.sf-theme-panel{position:fixed;top:64px;right:14px;z-index:9999;width:340px;max-width:calc(100vw - 28px);max-height:calc(100vh - 84px);overflow:auto;background:linear-gradient(180deg,var(--sf-card-strong,rgba(26,26,30,.96)) 0%,var(--sf-card,rgba(18,18,22,.85)) 100%);border:1px solid var(--sf-border,rgba(255,255,255,.14));border-radius:18px;padding:16px;box-shadow:var(--sf-shadow-lg,0 24px 70px rgba(0,0,0,.34));opacity:0;transform:translateY(-6px) scale(.98);transform-origin:top right;transition:opacity .18s var(--sf-ease,ease),transform .18s var(--sf-ease,ease);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);}' +
      '.sf-theme-panel.is-open{opacity:1;transform:translateY(0) scale(1);}' +

      '.sf-theme-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;}' +
      '.sf-theme-panel-kicker{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--sf-text-faint,#71717a);}' +
      '.sf-theme-panel-combo{margin-top:4px;font-size:13px;color:var(--sf-text-soft,#d4d4d8);}' +
      '.sf-theme-panel-combo b{color:var(--sf-accent-strong,#7cc4ff);font-weight:600;}' +
      '.sf-theme-panel-close{appearance:none;background:transparent;border:0;color:var(--sf-text-muted,#a1a1aa);font-size:22px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px;transition:all .15s var(--sf-ease,ease);}' +
      '.sf-theme-panel-close:hover{background:var(--sf-surface-2,rgba(36,36,40,.96));color:var(--sf-text,#fff);}' +

      '.sf-theme-section{margin-bottom:14px;}' +
      '.sf-theme-section:last-child{margin-bottom:0;}' +
      '.sf-theme-section-label{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--sf-text-faint,#71717a);margin-bottom:8px;padding:0 2px;}' +

      '.sf-theme-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}' +
      '.sf-theme-pick{appearance:none;border:1px solid var(--sf-border,rgba(255,255,255,.14));background:var(--sf-surface-1,rgba(20,20,24,.9));color:var(--sf-text-soft,#d4d4d8);padding:8px 8px 8px 6px;border-radius:10px;font-size:11px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s var(--sf-ease,ease);text-align:left;line-height:1.1;}' +
      '.sf-theme-pick:hover{transform:translateY(-1px);border-color:var(--sf-border-strong,rgba(255,255,255,.24));}' +
      '.sf-theme-pick.is-active{border-color:var(--sf-accent-border,rgba(91,162,255,.34));background:var(--sf-accent-soft,rgba(91,162,255,.16));color:var(--sf-accent-strong,#7cc4ff);box-shadow:0 0 0 1px var(--sf-accent-border,rgba(91,162,255,.34));}' +
      '.sf-theme-pick-swatch{width:14px;height:14px;border-radius:50%;background:var(--sf-pick,#888);box-shadow:0 0 0 1px rgba(255,255,255,.12);flex-shrink:0;}' +
      '.sf-theme-pick-square{border-radius:4px;}' +
      '.sf-theme-pick-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +

      '@media (max-width:520px){.sf-theme-panel{width:calc(100vw - 28px);}.sf-theme-grid{grid-template-columns:repeat(2,1fr);}}';
    var style = document.createElement("style");
    style.id = "sf-theme-switcher-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function mount() {
    if (document.querySelector(".sf-theme-fab")) return;
    injectStyles();
    buttonEl = buildButton();
    document.body.appendChild(buttonEl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.SFThemeSwitcher = {
    version: VERSION,
    accents: function () { return ACCENTS.slice(); },
    backgrounds: function () { return BACKGROUNDS.slice(); },
    current: function () { return { accent: getAccent(), bg: getBg() }; },
    applyAccent: function (id) { applyAccent(id); refreshButton(); if (panelEl) refreshPanel(); },
    applyBg: function (id) { applyBg(id); refreshButton(); if (panelEl) refreshPanel(); },
    open: open,
    close: close
  };
})();