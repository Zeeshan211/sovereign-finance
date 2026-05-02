/* ─── Sovereign Finance · Theme System v0.7.0 ─── */
/* Auto-applies BEFORE first paint to prevent FOUC */

(function () {
  const STORAGE_KEY = 'sov_theme_v1';
  const DEFAULT_THEME = 'midnight';

  const THEMES = [
    {
      id: 'midnight',
      name: 'Midnight',
      desc: 'Deep navy · mint accent',
      bg: '#050816',
      accent: '#10b981',
      icon: '🌌'
    },
    {
      id: 'obsidian',
      name: 'Obsidian',
      desc: 'Pure black · OLED friendly',
      bg: '#000000',
      accent: '#ffffff',
      icon: '⚫'
    },
    {
      id: 'aurora',
      name: 'Aurora',
      desc: 'Deep purple · violet glow',
      bg: '#0c0a1f',
      accent: '#a78bfa',
      icon: '🌃'
    },
    {
      id: 'slate',
      name: 'Slate',
      desc: 'Premium grey · sky accent',
      bg: '#0f1419',
      accent: '#38bdf8',
      icon: '🪨'
    },
    {
      id: 'daylight',
      name: 'Daylight',
      desc: 'Banking white · pro look',
      bg: '#f8fafc',
      accent: '#059669',
      icon: '☀️'
    }
  ];

  function getStoredTheme() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function setStoredTheme(id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) {}
  }

  function applyTheme(id) {
    document.documentElement.setAttribute('data-theme', id);
    setStoredTheme(id);
    updateMetaThemeColor(id);
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === id);
    });
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

  // Apply theme IMMEDIATELY (before DOM is ready) to avoid flash
  applyTheme(detectInitial());

  function buildSwitcher() {
    if (document.querySelector('.theme-switcher')) return;

    const btn = document.createElement('button');
    btn.className = 'theme-switcher';
    btn.setAttribute('aria-label', 'Change theme');
    btn.title = 'Change theme';
    btn.innerHTML = '🎨';

    const panel = document.createElement('div');
    panel.className = 'theme-panel';
    panel.innerHTML = '<div class="theme-panel-title">Choose Theme</div>';

    THEMES.forEach(theme => {
      const opt = document.createElement('button');
      opt.className = 'theme-option' + (theme.id === detectInitial() ? ' active' : '');
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
      });
      panel.appendChild(opt);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('open');
      }
    });

    document.body.appendChild(panel);
    document.body.appendChild(btn);
  }

  // Build switcher when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSwitcher);
  } else {
    buildSwitcher();
  }

  // Public API
  window.theme = {
    apply: applyTheme,
    current: () => document.documentElement.getAttribute('data-theme'),
    list: () => THEMES.slice()
  };
})();
