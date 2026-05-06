/* ─── Sovereign Finance · Theme System v0.7.1 · compact dock ─── */
/* Auto-applies BEFORE first paint to prevent FOUC */

(function () {
  const STORAGE_KEY = 'sov_theme_v1';
  const DEFAULT_THEME = 'midnight';
  const STYLE_ID = 'sov-theme-compact-style';

  const THEMES = [
    {
      id: 'midnight',
      name: 'Midnight',
      desc: 'Deep navy · mint',
      bg: '#050816',
      accent: '#10b981',
      icon: '🌌'
    },
    {
      id: 'obsidian',
      name: 'Obsidian',
      desc: 'OLED black',
      bg: '#000000',
      accent: '#ffffff',
      icon: '⚫'
    },
    {
      id: 'aurora',
      name: 'Aurora',
      desc: 'Violet glow',
      bg: '#0c0a1f',
      accent: '#a78bfa',
      icon: '🌃'
    },
    {
      id: 'slate',
      name: 'Slate',
      desc: 'Grey · sky',
      bg: '#0f1419',
      accent: '#38bdf8',
      icon: '🪨'
    },
    {
      id: 'daylight',
      name: 'Daylight',
      desc: 'Banking white',
      bg: '#f8fafc',
      accent: '#059669',
      icon: '☀️'
    }
  ];

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function setStoredTheme(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {}
  }

  function updateMetaThemeColor(id) {
    const theme = THEMES.find(t => t.id === id);
    if (!theme) return;

    let meta = document.querySelector('meta[name="theme-color"]');

    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }

    meta.content = theme.bg;
  }

  function detectInitial() {
    const stored = getStoredTheme();

    if (stored && THEMES.find(t => t.id === stored)) return stored;

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'daylight';
    }

    return DEFAULT_THEME;
  }

  function applyTheme(id) {
    const safeId = THEMES.find(t => t.id === id) ? id : DEFAULT_THEME;

    document.documentElement.setAttribute('data-theme', safeId);
    setStoredTheme(safeId);
    updateMetaThemeColor(safeId);

    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === safeId);
    });
  }

  function closePanel(panel, btn) {
    if (!panel || !btn) return;

    panel.classList.remove('open');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  function togglePanel(panel, btn) {
    if (!panel || !btn) return;

    const nextOpen = !panel.classList.contains('open');

    panel.classList.toggle('open', nextOpen);
    btn.classList.toggle('open', nextOpen);
    btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  }

  function injectCompactStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .theme-switcher {
        position: fixed !important;
        right: 18px !important;
        top: 92px !important;
        bottom: auto !important;
        z-index: 1400 !important;
        width: 38px !important;
        height: 38px !important;
        border-radius: 14px !important;
        border: 1px solid rgba(15, 23, 42, 0.14) !important;
        background: rgba(15, 23, 42, 0.94) !important;
        color: #f8fafc !important;
        font-size: 17px !important;
        line-height: 1 !important;
        display: grid !important;
        place-items: center !important;
        box-shadow: 0 14px 34px rgba(15, 23, 42, 0.18) !important;
        opacity: 0.82 !important;
        transition: opacity 180ms ease, transform 180ms ease, box-shadow 180ms ease !important;
      }

      .theme-switcher:hover,
      .theme-switcher.open {
        opacity: 1 !important;
        transform: translateY(-1px) !important;
        box-shadow: 0 18px 42px rgba(15, 23, 42, 0.24) !important;
      }

      .theme-panel {
        position: fixed !important;
        right: 18px !important;
        top: 138px !important;
        bottom: auto !important;
        width: 224px !important;
        max-width: calc(100vw - 28px) !important;
        max-height: min(390px, calc(100vh - 158px)) !important;
        overflow-y: auto !important;
        z-index: 1399 !important;
        background: rgba(255, 255, 255, 0.96) !important;
        border: 1px solid rgba(15, 23, 42, 0.10) !important;
        border-radius: 20px !important;
        padding: 9px !important;
        box-shadow: 0 22px 58px rgba(15, 23, 42, 0.18) !important;
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translateY(-6px) scale(0.98) !important;
        transform-origin: top right !important;
        transition: opacity 180ms ease, transform 180ms ease !important;
      }

      .theme-panel.open {
        opacity: 1 !important;
        pointer-events: auto !important;
        transform: translateY(0) scale(1) !important;
      }

      .theme-panel-title {
        margin: 4px 5px 8px !important;
        color: #64748b !important;
        font-size: 9px !important;
        font-weight: 950 !important;
        letter-spacing: 0.09em !important;
        text-transform: uppercase !important;
      }

      .theme-option {
        width: 100% !important;
        min-height: 46px !important;
        display: grid !important;
        grid-template-columns: 30px minmax(0, 1fr) 14px !important;
        align-items: center !important;
        gap: 9px !important;
        padding: 8px !important;
        margin-bottom: 5px !important;
        border: 1px solid transparent !important;
        border-radius: 14px !important;
        background: #f8fafc !important;
        color: #0f172a !important;
        text-align: left !important;
      }

      .theme-option.active {
        border-color: rgba(34, 197, 94, 0.46) !important;
        background: rgba(34, 197, 94, 0.11) !important;
      }

      .theme-swatch {
        width: 30px !important;
        height: 30px !important;
        border-radius: 10px !important;
        background:
          linear-gradient(135deg, var(--swatch-bg), var(--swatch-accent)) !important;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18) !important;
      }

      .theme-option-info {
        min-width: 0 !important;
      }

      .theme-option-name {
        color: #0f172a !important;
        font-size: 12px !important;
        font-weight: 950 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }

      .theme-option-desc {
        margin-top: 1px !important;
        color: #64748b !important;
        font-size: 10px !important;
        font-weight: 800 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }

      .theme-option-check {
        width: 8px !important;
        height: 8px !important;
        border-radius: 999px !important;
        background: transparent !important;
      }

      .theme-option.active .theme-option-check {
        background: #22c55e !important;
        box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12) !important;
      }

      @media (min-width: 1200px) {
        .theme-switcher {
          right: 18px !important;
          top: 18px !important;
        }

        .theme-panel {
          right: 18px !important;
          top: 64px !important;
        }
      }

      @media (max-width: 720px) {
        .theme-switcher {
          right: 12px !important;
          top: auto !important;
          bottom: calc(76px + env(safe-area-inset-bottom)) !important;
          width: 36px !important;
          height: 36px !important;
          border-radius: 13px !important;
          font-size: 16px !important;
        }

        .theme-panel {
          right: 12px !important;
          top: auto !important;
          bottom: calc(120px + env(safe-area-inset-bottom)) !important;
          width: min(220px, calc(100vw - 24px)) !important;
          max-height: min(330px, calc(100vh - 170px)) !important;
          transform-origin: bottom right !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // Apply theme IMMEDIATELY before DOM is ready to avoid flash.
  applyTheme(detectInitial());

  function buildSwitcher() {
    if (document.querySelector('.theme-switcher')) return;

    injectCompactStyles();

    const activeTheme = detectInitial();

    const btn = document.createElement('button');
    btn.className = 'theme-switcher';
    btn.setAttribute('aria-label', 'Change theme');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Change theme';
    btn.type = 'button';
    btn.innerHTML = '🎨';

    const panel = document.createElement('div');
    panel.className = 'theme-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose theme');
    panel.innerHTML = '<div class="theme-panel-title">Theme</div>';

    THEMES.forEach(theme => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'theme-option' + (theme.id === activeTheme ? ' active' : '');
      opt.dataset.theme = theme.id;
      opt.innerHTML = `
        <div class="theme-swatch" style="--swatch-bg: ${theme.bg}; --swatch-accent: ${theme.accent}"></div>
        <div class="theme-option-info">
          <div class="theme-option-name">${theme.icon} ${theme.name}</div>
          <div class="theme-option-desc">${theme.desc}</div>
        </div>
        <div class="theme-option-check"></div>
      `;

      opt.addEventListener('click', () => {
        applyTheme(theme.id);
        closePanel(panel, btn);
      });

      panel.appendChild(opt);
    });

    btn.addEventListener('click', event => {
      event.stopPropagation();
      togglePanel(panel, btn);
    });

    panel.addEventListener('click', event => {
      event.stopPropagation();
    });

    document.addEventListener('click', () => {
      closePanel(panel, btn);
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closePanel(panel, btn);
      }
    });

    document.body.appendChild(panel);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSwitcher);
  } else {
    buildSwitcher();
  }

  window.theme = {
    apply: applyTheme,
    current: () => document.documentElement.getAttribute('data-theme'),
    list: () => THEMES.slice(),
    close: () => {
      closePanel(
        document.querySelector('.theme-panel'),
        document.querySelector('.theme-switcher')
      );
    }
  };
})();
