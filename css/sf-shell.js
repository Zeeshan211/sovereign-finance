
html, body {
  background: var(--sf-bg);
  color: var(--sf-text);
}

body.sf-shell-body {
  margin: 0;
  min-height: 100vh;
  background: var(--sf-bg-elevated);
  color: var(--sf-text);
  font-family: var(--sf-font-sans);
  line-height: var(--sf-line-normal);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.sf-shell-body *,
.sf-shell-body *::before,
.sf-shell-body *::after {
  box-sizing: border-box;
}

.sf-app-shell {
  width: min(100%, var(--sf-content-max));
  margin: 0 auto;
  padding: var(--sf-space-7) var(--sf-space-5) var(--sf-space-10);
}

.sf-page-shell {
  display: grid;
  gap: var(--sf-space-6);
}

.sf-page-hero {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--sf-space-5);
  align-items: flex-start;
}

.sf-page-title-group {
  display: grid;
  gap: var(--sf-space-3);
  max-width: 720px;
}

.sf-page-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: var(--sf-space-2);
  width: fit-content;
  padding: 6px 12px;
  border-radius: var(--sf-radius-pill);
  background: var(--sf-accent-soft);
  color: var(--sf-accent-strong);
  font-size: var(--sf-font-12);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.sf-page-title {
  margin: 0;
  font-size: clamp(30px, 5vw, 48px);
  line-height: 1;
  letter-spacing: -0.03em;
}

.sf-page-subtitle {
  margin: 0;
  color: var(--sf-text-muted);
  font-size: var(--sf-font-16);
  max-width: 64ch;
}

.sf-page-actions,
.sf-control-row,
.sf-chip-row,
.sf-kpi-row,
.sf-panel-grid,
.sf-secondary-grid,
.sf-rail-layout {
  display: grid;
  gap: var(--sf-grid-gap);
}

.sf-page-actions {
  grid-auto-flow: column;
  grid-auto-columns: max-content;
  align-items: start;
  justify-content: end;
}

.sf-control-row,
.sf-chip-row {
  grid-auto-flow: column;
  grid-auto-columns: max-content;
  overflow-x: auto;
  padding-bottom: 2px;
}

.sf-kpi-row {
  grid-template-columns: repeat(auto-fit, minmax(var(--sf-kpi-min), 1fr));
}

.sf-panel-grid {
  grid-template-columns: repeat(12, minmax(0, 1fr));
}

.sf-secondary-grid {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.sf-rail-layout {
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  align-items: start;
}

.sf-span-12 { grid-column: span 12; }
.sf-span-8 { grid-column: span 8; }
.sf-span-7 { grid-column: span 7; }
.sf-span-6 { grid-column: span 6; }
.sf-span-5 { grid-column: span 5; }
.sf-span-4 { grid-column: span 4; }
.sf-span-3 { grid-column: span 3; }

.sf-card,
.sf-panel,
.sf-metric-card,
.sf-chart-card,
.sf-insight-card,
.sf-debug-panel {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--sf-border);
  border-radius: var(--sf-radius-lg);
  background: linear-gradient(180deg, var(--sf-card-strong) 0%, var(--sf-card) 100%);
  box-shadow: var(--sf-shadow-sm);
  backdrop-filter: blur(14px);
}

.sf-panel,
.sf-chart-card,
.sf-debug-panel,
.sf-insight-card {
  padding: var(--sf-space-6);
}

.sf-metric-card {
  padding: var(--sf-space-5);
  min-height: 160px;
}

.sf-card::after,
.sf-panel::after,
.sf-metric-card::after,
.sf-chart-card::after,
.sf-insight-card::after,
.sf-debug-panel::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), transparent 38%);
  pointer-events: none;
}

.sf-card--accent,
.sf-panel--accent,
.sf-metric-card--accent,
.sf-chart-card--accent {
  border-color: rgba(91, 162, 255, 0.34);
  box-shadow: var(--sf-shadow-accent);
}

.sf-section-head {
  display: flex;
  justify-content: space-between;
  gap: var(--sf-space-4);
  align-items: flex-start;
  margin-bottom: var(--sf-space-5);
}

.sf-section-kicker,
.sf-card-kicker {
  margin: 0 0 var(--sf-space-2);
  font-size: var(--sf-font-11);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sf-text-faint);
}

.sf-section-title,
.sf-card-title {
  margin: 0;
  font-size: var(--sf-font-20);
  line-height: var(--sf-line-tight);
  letter-spacing: -0.02em;
}

.sf-section-subtitle,
.sf-card-subtitle,
.sf-meta-text,
.sf-debug-text {
  margin: var(--sf-space-2) 0 0;
  color: var(--sf-text-muted);
  font-size: var(--sf-font-13);
}

.sf-metric-value {
  margin: var(--sf-space-4) 0 var(--sf-space-2);
  font-size: clamp(28px, 4vw, 40px);
  line-height: 1;
  letter-spacing: -0.04em;
  font-weight: 700;
}

.sf-metric-foot,
.sf-inline-stat,
.sf-pill,
.sf-chip,
.sf-button {
  display: inline-flex;
  align-items: center;
  gap: var(--sf-space-2);
  width: fit-content;
  border-radius: var(--sf-radius-pill);
  font-size: var(--sf-font-12);
  font-weight: 600;
}

.sf-metric-foot,
.sf-pill {
  padding: 7px 12px;
  background: var(--sf-surface-2);
  border: 1px solid var(--sf-border-subtle);
  color: var(--sf-text-soft);
}

.sf-chip,
.sf-button {
  appearance: none;
  border: 1px solid var(--sf-border);
  background: var(--sf-surface-1);
  color: var(--sf-text-soft);
  cursor: pointer;
  padding: 10px 14px;
  transition: transform var(--sf-duration-fast) var(--sf-ease), border-color var(--sf-duration-fast) var(--sf-ease), background var(--sf-duration-fast) var(--sf-ease);
}

.sf-chip:hover,
.sf-chip:focus-visible,
.sf-button:hover,
.sf-button:focus-visible {
  transform: translateY(-1px);
  border-color: var(--sf-border-strong);
  outline: none;
}

.sf-chip.is-active,
.sf-button--primary {
  background: linear-gradient(180deg, rgba(91, 162, 255, 0.22), rgba(91, 162, 255, 0.12));
  color: var(--sf-accent-strong);
  border-color: rgba(91, 162, 255, 0.34);
}

.sf-pill--positive,
.sf-tone-positive {
  background: var(--sf-positive-soft);
  color: var(--sf-positive);
  border-color: rgba(83, 215, 167, 0.28);
}

.sf-pill--warning,
.sf-tone-warning {
  background: var(--sf-warning-soft);
  color: var(--sf-warning);
  border-color: rgba(241, 184, 87, 0.28);
}

.sf-pill--danger,
.sf-tone-danger {
  background: var(--sf-danger-soft);
  color: var(--sf-danger);
  border-color: rgba(255, 127, 138, 0.28);
}

.sf-pill--info,
.sf-tone-info {
  background: var(--sf-info-soft);
  color: var(--sf-info);
  border-color: rgba(143, 188, 255, 0.28);
}

.sf-list {
  display: grid;
  gap: var(--sf-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.sf-list-item {
  display: flex;
  justify-content: space-between;
  gap: var(--sf-space-4);
  align-items: center;
  padding: var(--sf-space-3) 0;
  border-bottom: 1px solid var(--sf-border-subtle);
}

.sf-list-item:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.sf-muted {
  color: var(--sf-text-muted);
}

.sf-debug-panel[hidden],
.sf-shell-body:not(.sf-debug-mode) .sf-debug-only {
  display: none !important;
}

.sf-empty-state,
.sf-loading-state {
  display: grid;
  place-items: center;
  min-height: 180px;
  text-align: center;
  color: var(--sf-text-muted);
}

.sf-skeleton {
  position: relative;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
}

.sf-skeleton::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.12), transparent);
  animation: sf-shimmer 1.4s infinite;
}

@keyframes sf-shimmer {
  100% { transform: translateX(100%); }
}

@media (max-width: 1100px) {
  .sf-span-8,
  .sf-span-7,
  .sf-span-6,
  .sf-span-5,
  .sf-span-4,
  .sf-span-3 {
    grid-column: span 12;
  }

  .sf-rail-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .sf-app-shell {
    padding: var(--sf-space-6) var(--sf-space-4) var(--sf-space-8);
  }

  .sf-page-hero {
    grid-template-columns: 1fr;
  }

  .sf-page-actions {
    justify-content: start;
  }

  .sf-control-row,
  .sf-chip-row,
  .sf-page-actions {
    grid-auto-columns: max-content;
  }

  .sf-panel,
  .sf-chart-card,
  .sf-debug-panel,
  .sf-insight-card,
  .sf-metric-card {
    padding: var(--sf-space-5);
  }
}
