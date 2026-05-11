(function () {
  const root = (window.SFComponents = window.SFComponents || {});

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function classNames() {
    return Array.from(arguments).filter(Boolean).join(" ");
  }

  function toneClass(tone) {
    switch (tone) {
      case "positive":
      case "warning":
      case "danger":
      case "info":
        return `sf-pill--${tone}`;
      default:
        return "";
    }
  }

  function cardShell(inner, opts) {
    const o = opts || {};
    return `
      <section class="${classNames(o.className || "sf-panel", o.accent && "sf-panel--accent")}">
        ${inner}
      </section>
    `;
  }

  function sectionHead(opts) {
    const o = opts || {};
    const meta = o.meta ? `<div>${o.meta}</div>` : "";
    return `
      <div class="sf-section-head">
        <div>
          ${o.kicker ? `<p class="sf-section-kicker">${escapeHtml(o.kicker)}</p>` : ""}
          ${o.title ? `<h2 class="sf-section-title">${escapeHtml(o.title)}</h2>` : ""}
          ${o.subtitle ? `<p class="sf-section-subtitle">${escapeHtml(o.subtitle)}</p>` : ""}
        </div>
        ${meta}
      </div>
    `;
  }

    function metricCard(opts) {
    const o = opts || {};
    const valueMarkup = o.valueHtml != null ? o.valueHtml : escapeHtml(o.value || "—");
    const subtitleMarkup = o.subtitleHtml != null
      ? o.subtitleHtml
      : (o.subtitle ? escapeHtml(o.subtitle) : "");
    const footMarkup = o.footHtml != null
      ? o.footHtml
      : (o.foot ? escapeHtml(o.foot) : "");

    return `
      <section class="${classNames("sf-metric-card", o.accent && "sf-metric-card--accent", o.className)}">
        ${o.kicker ? `<p class="sf-card-kicker">${escapeHtml(o.kicker)}</p>` : ""}
        ${o.title ? `<h3 class="sf-card-title">${escapeHtml(o.title)}</h3>` : ""}
        <div class="sf-metric-value">${valueMarkup}</div>
        ${subtitleMarkup ? `<p class="sf-card-subtitle">${subtitleMarkup}</p>` : ""}
        ${footMarkup ? `<div class="sf-metric-foot ${toneClass(o.tone)}">${footMarkup}</div>` : ""}
      </section>
    `;
  }

  function chip(opts) {
    const o = opts || {};
    const tag = o.tag || "button";
    const attrs = [
      `class="${classNames(tag === "button" ? "sf-chip" : "sf-pill", o.active && "is-active", o.className, toneClass(o.tone))}"`
    ];
    if (tag === "button") attrs.push('type="button"');
    if (o.dataset) {
      Object.keys(o.dataset).forEach((key) => {
        attrs.push(`data-${escapeHtml(key)}="${escapeHtml(o.dataset[key])}"`);
      });
    }
    return `<${tag} ${attrs.join(" ")}>${escapeHtml(o.label || "")}</${tag}>`;
  }

  function statList(items) {
    const rows = (items || []).map((item) => `
      <li class="sf-list-item">
        <div>
          <div>${escapeHtml(item.label || "")}</div>
          ${item.meta ? `<div class="sf-meta-text">${escapeHtml(item.meta)}</div>` : ""}
        </div>
        <div class="${classNames(item.tone && `sf-tone-${item.tone}`)}">${escapeHtml(item.value || "—")}</div>
      </li>
    `).join("");
    return `<ul class="sf-list">${rows}</ul>`;
  }

  function infoCard(opts) {
    const o = opts || {};
    return `
      <section class="${classNames("sf-insight-card", o.className, o.accent && "sf-panel--accent")}">
        ${sectionHead({ kicker: o.kicker, title: o.title, subtitle: o.subtitle, meta: o.meta })}
        ${o.body || ""}
      </section>
    `;
  }

  function chartCard(opts) {
    const o = opts || {};
    return `
      <section class="${classNames("sf-chart-card", o.className, o.accent && "sf-chart-card--accent")}">
        ${sectionHead({ kicker: o.kicker, title: o.title, subtitle: o.subtitle, meta: o.meta })}
        <div class="sf-chart-slot"${o.chartId ? ` id="${escapeHtml(o.chartId)}"` : ""}>${o.body || ""}</div>
      </section>
    `;
  }

  function emptyState(opts) {
    const o = opts || {};
    return `
      <div class="sf-empty-state">
        <div>
          <h3 class="sf-card-title">${escapeHtml(o.title || "Nothing to show")}</h3>
          ${o.subtitle ? `<p class="sf-card-subtitle">${escapeHtml(o.subtitle)}</p>` : ""}
        </div>
      </div>
    `;
  }

  function loadingState(opts) {
    const o = opts || {};
    return `
      <div class="sf-loading-state">
        <div>
          <h3 class="sf-card-title">${escapeHtml(o.title || "Loading")}</h3>
          ${o.subtitle ? `<p class="sf-card-subtitle">${escapeHtml(o.subtitle)}</p>` : ""}
        </div>
      </div>
    `;
  }

  root.escapeHtml = escapeHtml;
  root.classNames = classNames;
  root.cardShell = cardShell;
  root.sectionHead = sectionHead;
  root.metricCard = metricCard;
  root.chip = chip;
  root.statList = statList;
  root.infoCard = infoCard;
  root.chartCard = chartCard;
  root.emptyState = emptyState;
  root.loadingState = loadingState;
})();
