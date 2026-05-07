/*  Sovereign Finance  Theme System v0.7.2  effective token restore  */
/* Auto-applies BEFORE first paint to prevent FOUC */
(function () {
'use strict';

const STORAGE_KEY = 'sov_theme_v1';
const DEFAULT_THEME = 'midnight';
const STYLE_ID = 'sov-theme-compact-style';
const TOKEN_STYLE_ID = 'sov-theme-token-style';

const THEMES = [
{
id: 'midnight',
name: 'Midnight',
desc: 'Deep navy mint',
bg: '#eef4ff',
shell: '#0f172a',
shell2: '#111827',
surface: '#ffffff',
surface2: '#f8fafc',
surface3: '#e2e8f0',
card: 'rgba(255, 255, 255, 0.84)',
text: '#0f172a',
muted: '#334155',
dim: '#64748b',
accent: '#16a34a',
accentBright: '#22c55e',
accentDeep: '#15803d',
accentSoft: 'rgba(34, 197, 94, 0.12)',
accentGlow: 'rgba(34, 197, 94, 0.28)',
grad: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
icon: '🌙'
},
{
id: 'obsidian',
name: 'Obsidian',
desc: 'OLED black',
bg: '#030712',
shell: '#000000',
shell2: '#111111',
surface: '#0b1120',
surface2: '#111827',
surface3: '#1f2937',
card: 'rgba(15, 23, 42, 0.88)',
text: '#f8fafc',
muted: '#cbd5e1',
dim: '#94a3b8',
accent: '#e5e7eb',
accentBright: '#ffffff',
accentDeep: '#f8fafc',
accentSoft: 'rgba(255, 255, 255, 0.10)',
accentGlow: 'rgba(255, 255, 255, 0.18)',
grad: 'linear-gradient(135deg, #f8fafc 0%, #94a3b8 100%)',
icon: '●'
},
{
id: 'aurora',
name: 'Aurora',
desc: 'Violet glow',
bg: '#f5f3ff',
shell: '#1e1b4b',
shell2: '#312e81',
surface: '#ffffff',
surface2: '#faf5ff',
surface3: '#ede9fe',
card: 'rgba(255, 255, 255, 0.84)',
text: '#1e1b4b',
muted: '#4c1d95',
dim: '#7c3aed',
accent: '#7c3aed',
accentBright: '#a78bfa',
accentDeep: '#6d28d9',
accentSoft: 'rgba(124, 58, 237, 0.12)',
accentGlow: 'rgba(124, 58, 237, 0.26)',
grad: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
icon: '✦'
},
{
id: 'slate',
name: 'Slate',
desc: 'Grey sky',
bg: '#f1f5f9',
shell: '#1e293b',
shell2: '#334155',
surface: '#ffffff',
surface2: '#f8fafc',
surface3: '#dbeafe',
card: 'rgba(255, 255, 255, 0.84)',
text: '#0f172a',
muted: '#334155',
dim: '#64748b',
accent: '#0284c7',
accentBright: '#38bdf8',
accentDeep: '#0369a1',
accentSoft: 'rgba(2, 132, 199, 0.12)',
accentGlow: 'rgba(56, 189, 248, 0.26)',
grad: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)',
icon: '☁'
},
{
id: 'daylight',
name: 'Daylight',
desc: 'Banking white',
bg: '#f8fafc',
shell: '#064e3b',
shell2: '#065f46',
surface: '#ffffff',
surface2: '#f0fdf4',
surface3: '#dcfce7',
card: 'rgba(255, 255, 255, 0.90)',
text: '#052e16',
muted: '#166534',
dim: '#64748b',
accent: '#059669',
accentBright: '#10b981',
accentDeep: '#047857',
accentSoft: 'rgba(16, 185, 129, 0.12)',
accentGlow: 'rgba(16, 185, 129, 0.22)',
grad: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
icon: '☀'
}
];

function themeById(id) {
return THEMES.find(t => t.id === id) || THEMES.find(t => t.id === DEFAULT_THEME);
}

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
const theme = themeById(id);
if (!theme) return;

let meta = document.querySelector('meta[name="theme-color"]');
if (!meta) {
meta = document.createElement('meta');
meta.name = 'theme-color';
document.head.appendChild(meta);
}
meta.content = theme.shell || theme.bg;
}

function detectInitial() {
const stored = getStoredTheme();
if (stored && THEMES.find(t => t.id === stored)) return stored;

if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
return 'daylight';
}

return DEFAULT_THEME;
}

function injectTokenStyles() {
const old = document.getElementById(TOKEN_STYLE_ID);
if (old) old.remove();

const style = document.createElement('style');
style.id = TOKEN_STYLE_ID;
style.textContent = THEMES.map(theme => `
html[data-theme="${theme.id}"],
body[data-theme="${theme.id}"] {
--bg-base: ${theme.bg};
--bg-elevated: ${theme.surface};
--surface-1: ${theme.surface};
--surface-2: ${theme.surface2};
--surface-3: ${theme.surface3};
--surface-glass: ${theme.card};
--card: ${theme.card};
--shell: ${theme.shell};
--shell-2: ${theme.shell2};
--text: ${theme.text};
--text-main: ${theme.text};
--text-muted: ${theme.muted};
--text-dim: ${theme.dim};
--text-faint: ${theme.dim};
--border: rgba(15, 23, 42, 0.10);
--border-strong: rgba(15, 23, 42, 0.18);
--border-bright: rgba(15, 23, 42, 0.28);
--accent: ${theme.accent};
--accent-bright: ${theme.accentBright};
--accent-deep: ${theme.accentDeep};
--accent-soft: ${theme.accentSoft};
--accent-glow: ${theme.accentGlow};
--grad-mint: ${theme.grad};
}
html[data-theme="${theme.id}"] body {
background:
radial-gradient(circle at top left, ${theme.accentSoft}, transparent 34rem),
radial-gradient(circle at top right, rgba(59, 130, 246, 0.10), transparent 34rem),
${theme.bg};
color: ${theme.text};
}
html[data-theme="${theme.id}"] .sov-card-upgraded,
html[data-theme="${theme.id}"] .hub-panel,
html[data-theme="${theme.id}"] .stat-card,
html[data-theme="${theme.id}"] .account-row,
html[data-theme="${theme.id}"] .bill-row,
html[data-theme="${theme.id}"] .debt-row,
html[data-theme="${theme.id}"] .form-card,
html[data-theme="${theme.id}"] .filter-panel,
html[data-theme="${theme.id}"] .dense-wrap,
html[data-theme="${theme.id}"] .modal {
background:
radial-gradient(circle at 12% 0%, ${theme.accentSoft}, transparent 14rem),
${theme.card} !important;
color: ${theme.text} !important;
}
html[data-theme="${theme.id}"] header,
html[data-theme="${theme.id}"] .desktop-nav {
background:
radial-gradient(circle at 18% 0%, ${theme.accentSoft}, transparent 13rem),
linear-gradient(180deg, ${theme.shell}, ${theme.shell2}) !important;
}
`).join('\n');

document.head.appendChild(style);
}

function applyTheme(id) {
injectTokenStyles();

const safeTheme = themeById(id);
const safeId = safeTheme.id;

document.documentElement.setAttribute('data-theme', safeId);
if (document.body) document.body.setAttribute('data-theme', safeId);

setStoredTheme(safeId);
updateMetaThemeColor(safeId);

document.querySelectorAll('.theme-option').forEach(btn => {
btn.classList.toggle('active', btn.dataset.theme === safeId);
});

window.dispatchEvent(new CustomEvent('sov-theme-change', {
detail: { theme: safeTheme }
}));
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
const old = document.getElementById(STYLE_ID);
if (old) old.remove();

const style = document.createElement('style');
style.id = STYLE_ID;
style.textContent = `
.theme-switcher {
position: fixed !important;
right: 18px !important;
top: 92px !important;
bottom: auto !important;
z-index: 3200 !important;
width: 38px !important;
height: 38px !important;
border-radius: 14px !important;
border: 1px solid rgba(255, 255, 255, 0.18) !important;
background: var(--shell, rgba(15, 23, 42, 0.94)) !important;
color: #f8fafc !important;
font-size: 17px !important;
line-height: 1 !important;
display: grid !important;
place-items: center !important;
box-shadow: 0 14px 34px rgba(15, 23, 42, 0.18) !important;
opacity: 0.88 !important;
transition: opacity 180ms ease, transform 180ms ease, box-shadow 180ms ease, background 180ms ease !important;
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
z-index: 3199 !important;
background: var(--surface-1, rgba(255, 255, 255, 0.96)) !important;
border: 1px solid var(--border, rgba(15, 23, 42, 0.10)) !important;
border-radius: 20px !important;
padding: 9px !important;
box-shadow: 0 22px 58px rgba(15, 23, 42, 0.18) !important;
opacity: 0 !important;
pointer-events: none !important;
transform: translateY(-6px) scale(0.98) !important;
transform-origin: top right !important;
transition: opacity 180ms ease, transform 180ms ease, background 180ms ease !important;
}
.theme-panel.open {
opacity: 1 !important;
pointer-events: auto !important;
transform: translateY(0) scale(1) !important;
}
.theme-panel-title {
margin: 4px 5px 8px !important;
color: var(--text-dim, #64748b) !important;
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
background: var(--surface-2, #f8fafc) !important;
color: var(--text, #0f172a) !important;
text-align: left !important;
}
.theme-option.active {
border-color: var(--accent, rgba(34, 197, 94, 0.46)) !important;
background: var(--accent-soft, rgba(34, 197, 94, 0.11)) !important;
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
color: var(--text, #0f172a) !important;
font-size: 12px !important;
font-weight: 950 !important;
white-space: nowrap !important;
overflow: hidden !important;
text-overflow: ellipsis !important;
}
.theme-option-desc {
margin-top: 1px !important;
color: var(--text-dim, #64748b) !important;
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
background: var(--accent-bright, #22c55e) !important;
box-shadow: 0 0 0 4px var(--accent-soft, rgba(34, 197, 94, 0.12)) !important;
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

applyTheme(detectInitial());

function buildSwitcher() {
injectCompactStyles();

document.querySelectorAll('.theme-switcher, .theme-panel').forEach(node => node.remove());

const activeTheme = document.documentElement.getAttribute('data-theme') || detectInitial();

const btn = document.createElement('button');
btn.className = 'theme-switcher';
btn.setAttribute('aria-label', 'Change theme');
btn.setAttribute('aria-expanded', 'false');
btn.title = 'Change theme';
btn.type = 'button';
btn.innerHTML = '◐';

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
<div class="theme-swatch" style="--swatch-bg: ${theme.shell}; --swatch-accent: ${theme.accentBright}"></div>
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
if (event.key === 'Escape') closePanel(panel, btn);
});

document.body.appendChild(panel);
document.body.appendChild(btn);

applyTheme(activeTheme);
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
