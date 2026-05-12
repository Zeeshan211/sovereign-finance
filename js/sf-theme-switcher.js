/* Sovereign Finance Theme Switcher v1.0.0
 *
 * Self-contained accent palette switcher.
 *
 * Behavior:
 * - Reads stored accent from localStorage and sets html[data-accent]
 *   synchronously on script execution (prevents FOUC if loaded in <head>).
 * - Mounts a 3-dot switcher into the shared finance sidebar footer.
 * - "..." button opens a full overlay with all 12 palettes.
 * - Each palette pick persists to localStorage and updates the recent set.
 * - The 3 dots in the sidebar reflect the 3 most-recently-applied palettes.
 *
 * Storage keys:
 *   sf-accent         string  active palette id
 *   sf-accent-recent  JSON    last 3 palette ids (most recent first)
 *
 * Mount target: first .sf-finance-sidebar in the DOM.
 *   If sidebar isn't present yet, MutationObserver waits up to 10s.
 *
 * Load order: include in <head> non-deferred:
 *   <script src="/js/sf-theme-switcher.js"></script>
 *
 * No deps. No money logic. Pure presentation.
 */
(function () {
  "use strict";

  var VERSION = "v1.0.0";
  var STORAGE_KEY = "sf-accent";
  var RECENT_KEY = "sf-accent-recent";
  var DEFAULT_ACCENT = "sapphire";
  var DEFAULT_RECENT = ["sapphire", "violet", "teal"];

  var PALETTES = [
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

  // ===== Storage helpers =====
  function safeGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function isValidId(id) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) return true;
    }
    return false;
  }
  function paletteById(id) {
    for (var i = 0; i < PALETTES.length; i++) {
      if (PALETTES[i].id === id) return PALETTES[i];
    }
    return PALETTES[0];
  }
  function getStoredAccent() {
    var v = safeGet(STORAGE_KEY, DEFAULT_ACCENT);
    return isValidId(v) ? v : DEFAULT_ACCENT;
  }
  function getStoredRecent() {
    try {
      var raw = safeGet(RECENT_KEY, null);
      if (!raw) return DEFAULT_RECENT.slice();
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return DEFAULT_RECENT.slice();
      var valid = arr.filter(isValidId);
      return valid.length ? valid.slice(0, 3) : DEFAULT_RECENT.slice();
    } catch (e) { return DEFAULT_RECENT.slice(); }
  }
  function setStoredRecent(arr) { safeSet(RECENT_KEY, JSON.stringify(arr)); }

  // ===== Apply palette =====
  function applyAccent(id) {
    if (!isValidId(id)) id = DEFAULT_ACCENT;
    document.documentElement.setAttribute("data-accent", id);
    safeSet(STORAGE_KEY, id);
    var recent = getStoredRecent();
    var idx = recent.indexOf(id);
    if (idx === 0) return id;
    if (idx > -1) recent.splice(idx, 1);
    recent.unshift(id);
    if (recent.length > 3) recent = recent.slice(0, 3);
    setStoredRecent(recent);
    return id;
  }

  // ===== Synchronous bootstrap (runs immediately, before paint) =====
  (function bootstrap() {
    document.documentElement.setAttribute("data-accent", getStoredAccent());
  })();

  // ===== UI =====
  var mountedFooter = null;
  var overlayEl = null;

  function buildFooter() {
    var current = getStoredAccent();
    var recent = getStoredRecent();

    var footer = document.createElement("div");
    footer.className = "sf-theme-switcher";
    footer.innerHTML =
      '<div class="sf-theme-kicker">Theme</div>' +
      '<div class="sf-theme-row">' +
        recent.map(function (id) {
          var p = paletteById(id);
          return '<button class="sf-theme-dot' + (id === current ? ' is-active' : '') + '"' +
                 ' data-accent-id="' + id + '"' +
                 ' title="' + p.name + '"' +
                 ' style="--sf-dot:' + p.hex + '"></button>';
        }).join('') +
        '<button class="sf-theme-more" title="All palettes" aria-label="All palettes">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
            '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>' +
          '</svg>' +
        '</button>' +
      '</div>';

    footer.addEventListener("click", function (e) {
      var dot = e.target.closest(".sf-theme-dot");
      if (dot) {
        applyAccent(dot.getAttribute("data-accent-id"));
        refreshFooter();
        return;
      }
      var more = e.target.closest(".sf-theme-more");
      if (more) openOverlay();
    });

    return footer;
  }

  function refreshFooter() {
    if (!mountedFooter || !mountedFooter.parentNode) return;
    var fresh = buildFooter();
    mountedFooter.parentNode.replaceChild(fresh, mountedFooter);
    mountedFooter = fresh;
    if (overlayEl) refreshOverlay();
  }

  function buildOverlay() {
    var current = getStoredAccent();
    var ov = document.createElement("div");
    ov.className = "sf-theme-overlay";
    ov.innerHTML =
      '<div class="sf-theme-modal" role="dialog" aria-label="Choose theme">' +
        '<div class="sf-theme-modal-head">' +
          '<div>' +
            '<div class="sf-theme-modal-kicker">Theme</div>' +
            '<h3 class="sf-theme-modal-title">Choose accent</h3>' +
          '</div>' +
          '<button class="sf-theme-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="sf-theme-modal-sub">Tap a palette to apply. The last 3 used appear pinned in the sidebar.</div>' +
        '<div class="sf-theme-grid">' +
          PALETTES.map(function (p) {
            return '<button class="sf-theme-card' + (p.id === current ? ' is-active' : '') + '"' +
                   ' data-accent-id="' + p.id + '"' +
                   ' style="--sf-card-color:' + p.hex + '">' +
                     '<span class="sf-theme-card-swatch"></span>' +
                     '<span class="sf-theme-card-name">' + p.name + '</span>' +
                   '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    ov.addEventListener("click", function (e) {
      if (e.target === ov) { closeOverlay(); return; }
      if (e.target.closest(".sf-theme-close")) { closeOverlay(); return; }
      var card = e.target.closest(".sf-theme-card");
      if (card) {
        applyAccent(card.getAttribute("data-accent-id"));
        refreshFooter();
      }
    });

    return ov;
  }

  function refreshOverlay() {
    if (!overlayEl || !overlayEl.parentNode) return;
    var fresh = buildOverlay();
    fresh.classList.add("is-open");
    overlayEl.parentNode.replaceChild(fresh, overlayEl);
    overlayEl = fresh;
  }

  function openOverlay() {
    if (overlayEl) return;
    overlayEl = buildOverlay();
    document.body.appendChild(overlayEl);
    document.addEventListener("keydown", onEsc);
    requestAnimationFrame(function () { overlayEl.classList.add("is-open"); });
  }
  function closeOverlay() {
    if (!overlayEl) return;
    overlayEl.classList.remove("is-open");
    document.removeEventListener("keydown", onEsc);
    var dying = overlayEl;
    overlayEl = null;
    setTimeout(function () { if (dying.parentNode) dying.parentNode.removeChild(dying); }, 200);
  }
  function onEsc(e) { if (e.key === "Escape") closeOverlay(); }

  function injectStyles() {
    if (document.getElementById("sf-theme-switcher-styles")) return;
    var css =
      '.sf-theme-switcher{margin-top:auto;padding:14px 12px 4px;border-top:1px solid var(--sf-border-subtle);}' +
      '.sf-theme-kicker{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--sf-text-faint);margin-bottom:8px;padding:0 4px;}' +
      '.sf-theme-row{display:flex;align-items:center;gap:8px;padding:0 4px;}' +
      '.sf-theme-dot{appearance:none;border:0;padding:0;width:22px;height:22px;border-radius:50%;background:var(--sf-dot,#888);cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.08);transition:transform .15s var(--sf-ease,ease),box-shadow .15s var(--sf-ease,ease);}' +
      '.sf-theme-dot:hover{transform:scale(1.12);}' +
      '.sf-theme-dot.is-active{box-shadow:0 0 0 2px var(--sf-bg,#07111f),0 0 0 4px var(--sf-dot,#888);}' +
      '.sf-theme-more{appearance:none;border:1px solid var(--sf-border);background:var(--sf-surface-1);color:var(--sf-text-soft);width:28px;height:22px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;margin-left:2px;transition:all .15s var(--sf-ease,ease);}' +
      '.sf-theme-more:hover{border-color:var(--sf-accent-border);color:var(--sf-accent-strong);}' +

      '.sf-theme-overlay{position:fixed;inset:0;background:var(--sf-overlay,rgba(3,8,16,.78));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:24px;z-index:9999;opacity:0;transition:opacity .2s var(--sf-ease,ease);}' +
      '.sf-theme-overlay.is-open{opacity:1;}' +
      '.sf-theme-modal{background:linear-gradient(180deg,var(--sf-card-strong) 0%,var(--sf-card) 100%);border:1px solid var(--sf-border);border-radius:var(--sf-radius-lg,24px);padding:28px;width:min(100%,640px);max-height:85vh;overflow:auto;box-shadow:var(--sf-shadow-lg);}' +
      '.sf-theme-modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}' +
      '.sf-theme-modal-kicker{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--sf-text-faint);}' +
      '.sf-theme-modal-title{margin:4px 0 0;font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--sf-text);}' +
      '.sf-theme-modal-sub{margin-top:6px;font-size:13px;color:var(--sf-text-muted);}' +
      '.sf-theme-close{appearance:none;background:transparent;border:0;color:var(--sf-text-muted);font-size:24px;line-height:1;cursor:pointer;padding:4px 12px;border-radius:8px;transition:all .15s var(--sf-ease,ease);}' +
      '.sf-theme-close:hover{background:var(--sf-surface-1);color:var(--sf-text);}' +
      '.sf-theme-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:20px;}' +
      '.sf-theme-card{appearance:none;text-align:left;padding:14px;border:1px solid var(--sf-border);border-radius:var(--sf-radius-sm,14px);background:var(--sf-surface-1);color:var(--sf-text-soft);cursor:pointer;display:flex;align-items:center;gap:12px;transition:all .15s var(--sf-ease,ease);}' +
      '.sf-theme-card:hover{transform:translateY(-2px);border-color:var(--sf-accent-border);}' +
      '.sf-theme-card.is-active{border-color:var(--sf-accent-border);background:var(--sf-accent-soft);color:var(--sf-accent-strong);box-shadow:var(--sf-shadow-accent);}' +
      '.sf-theme-card-swatch{width:24px;height:24px;border-radius:50%;background:var(--sf-card-color,#888);box-shadow:0 0 0 1px rgba(255,255,255,.08),0 0 12px var(--sf-card-color,#888);flex-shrink:0;}' +
      '.sf-theme-card-name{font-size:13px;font-weight:600;}' +
      '@media (max-width:720px){.sf-theme-grid{grid-template-columns:repeat(2,1fr);}}';
    var style = document.createElement("style");
    style.id = "sf-theme-switcher-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function tryMount() {
    var sidebar = document.querySelector(".sf-finance-sidebar");
    if (!sidebar) return false;
    if (sidebar.querySelector(".sf-theme-switcher")) return true;
    injectStyles();
    var footer = buildFooter();
    sidebar.appendChild(footer);
    mountedFooter = footer;
    return true;
  }

  function mountWhenReady() {
    if (tryMount()) return;
    var observer = new MutationObserver(function () {
      if (tryMount()) observer.disconnect();
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 10000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountWhenReady);
  } else {
    mountWhenReady();
  }

  window.SFThemeSwitcher = {
    version: VERSION,
    palettes: function () { return PALETTES.slice(); },
    current: function () { return document.documentElement.getAttribute("data-accent"); },
    apply: function (id) { applyAccent(id); refreshFooter(); },
    open: openOverlay,
    close: closeOverlay
  };
})();
