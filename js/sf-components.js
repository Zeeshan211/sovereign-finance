(function () {
  "use strict";

  const root = (window.SFComponents = window.SFComponents || {});

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function html(value) {
    return value == null ? "" : String(value);
  }

  function classNames() {
    return Array.from(arguments).filter(Boolean).join(" ");
  }

  function toneClass(tone, prefix) {
    const p = prefix || "sf-pill";
    switch (tone) {
      case "positive":
      case "warning":
      case "danger":
      case "info":
        return ${p}--${tone};
      default:
        return "";
    }
  }

  function toneTextClass(tone) {
    switch (tone) {
      case "positive":
      case "warning":
      case "danger":
      case "info":
        return sf-tone-${tone};
      default:
        return "";
    }
  }

  function renderField(opts, textKey, htmlKey) {
    const o = opts || {};
    if (o[htmlKey] != null) return html(o[htmlKey]);
    return escapeHtml(o[textKey] || "");
  }

  function formatNumber(value, options) {
    const n = Number(value) || 0;
    const opts = options || {};
    return new Intl.NumberFormat(opts.locale || "en-PK", {
      maximumFractionDigits: opts.maximumFractionDigits == null ? 0 : opts.maximumFractionDigits,
      minimumFractionDigits: opts.minimumFractionDigits == null ? 0 : opts.minimumFractionDigits
    }).format(n);
  }

  function money(value, options) {
    const opts = options || {};
    const currency = opts.currency || "PKR";
    const decimals = opts.maximumFractionDigits == null ? 0 : opts.maximumFractionDigits;
    const amount = formatNumber(value, {
      locale: opts.locale || "en-PK",
      maximumFractionDigits: decimals,
      minimumFractionDigits: opts.minimumFractionDigits == null ? 0 : opts.minimumFractionDigits
    });

    if (opts.compact) return amount;
    if (currency === "PKR") return Rs ${amount};
    return ${currency} ${amount};
  }

  function percent(value, options) {
    const opts = options || {};
    const decimals = opts.maximumFractionDigits == null ? 1 : opts.maximumFractionDigits;
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return ${formatNumber(n, {
      locale: opts.locale || "en-PK",
      maximumFractionDigits: decimals,
      minimumFractionDigits: opts.minimumFractionDigits == null ? 0 : opts.minimumFractionDigits
    })}%;
  }

  function attrsFromDataset(dataset) {
    if (!dataset) return "";
    return Object.keys(dataset)
      .map((key) =>  data-${escapeHtml(key)}="${escapeHtml(dataset[key])}")
      .join("");
  }

  function statusPill(opts) {
    const o = opts || {};
    const tag = o.tag || "span";
    return <${tag} class="${classNames("sf-pill", toneClass(o.tone), o.className)}"${attrsFromDataset(o.dataset)}>${renderField(o, "label", "labelHtml")}</${tag}>;
  }

  function button(opts) {
    const o = opts || {};
    const tag = o.href ? "a" : "button";
    const attrs = [
      class="${classNames("sf-button", o.primary && "sf-button--primary", o.className)}"
    ];

    if (o.href) {
attrs.push(href="${escapeHtml(o.href)}");
    } else {
attrs.push('type="button"');
    }

    if (o.disabled) attrs.push("disabled");
    if (o.ariaLabel) attrs.push(aria-label="${escapeHtml(o.ariaLabel)}");
    if (o.id) attrs.push(id="${escapeHtml(o.id)}");

    const dataset = attrsFromDataset(o.dataset);
    return <${tag} ${attrs.join(" ")}${dataset}>${renderField(o, "label", "labelHtml")}</${tag}>;
  }

  function chip(opts) {
    const o = opts || {};
    const tag = o.href ? "a" : (o.tag || "button");
    const attrs = [
      class="${classNames(
        tag === "button" ? "sf-chip" : "sf-pill",
        o.active && "is-active",
        toneClass(o.tone),
        o.className
      )}"
    ];

    if (tag === "button") attrs.push('type="button"');
    if (o.href) attrs.push(href="${escapeHtml(o.href)}");
    if (o.disabled) attrs.push("disabled");
    if (o.id) attrs.push(id="${escapeHtml(o.id)}");
    if (o.ariaLabel) attrs.push(aria-label="${escapeHtml(o.ariaLabel)}");

    return <${tag} ${attrs.join(" ")}${attrsFromDataset(o.dataset)}>${renderField(o, "label", "labelHtml")}</${tag}>;
  }

  function sectionHead(opts) {
    const o = opts || {};
    const meta = o.metaHtml != null
      ? html(o.metaHtml)
      : o.meta
        ? <div>${escapeHtml(o.meta)}</div>
        : "";

    return 
      <div class="sf-section-head">
        <div>
          ${o.kicker ? <p class="sf-section-kicker">${escapeHtml(o.kicker)}</p> : ""}
          ${o.title ? <h2 class="sf-section-title">${escapeHtml(o.title)}</h2> : ""}
          ${o.subtitleHtml != null ? <p class="sf-section-subtitle">${html(o.subtitleHtml)}</p> : ""}
          ${o.subtitle && o.subtitleHtml == null ? <p class="sf-section-subtitle">${escapeHtml(o.subtitle)}</p> : ""}
        </div>
        ${meta ? <div class="sf-section-meta">${meta}</div> : ""}
      </div>
    ;
  }

  function cardShell(inner, opts) {
    const o = opts || {};
    const tag = o.tag || "section";
    return 
      <${tag} class="${classNames(o.className || "sf-panel", o.accent && "sf-panel--accent")}">
        ${inner || ""}
      </${tag}>
    ;
  }

  function metricCard(opts) {
    const o = opts || {};
    return 
      <section class="${classNames("sf-metric-card", o.accent && "sf-metric-card--accent", o.className)}">
        ${o.kicker ? <p class="sf-card-kicker">${escapeHtml(o.kicker)}</p> : ""}
        ${o.title ? <h3 class="sf-card-title">${escapeHtml(o.title)}</h3> : ""}
        <div class="${classNames("sf-metric-value", toneTextClass(o.tone), o.valueClassName)}">
          ${renderField(o, "value", "valueHtml") || "—"}
        </div>
        ${o.subtitleHtml != null ? <p class="sf-card-subtitle">${html(o.subtitleHtml)}</p> : ""}
        ${o.subtitle && o.subtitleHtml == null ? <p class="sf-card-subtitle">${escapeHtml(o.subtitle)}</p> : ""}
        ${o.footHtml != null ? <div class="${classNames("sf-metric-foot", toneClass(o.tone), o.footClassName)}">${html(o.footHtml)}</div> : ""}
        ${o.foot && o.footHtml == null ? <div class="${classNames("sf-metric-foot", toneClass(o.tone), o.footClassName)}">${escapeHtml(o.foot)}</div> : ""}
      </section>
    ;
  }

  function listRow(opts) {
    const o = opts || {};
    return 
      <li class="${classNames("sf-list-item", o.className)}"${attrsFromDataset(o.dataset)}>
        <div>
          <div>${renderField(o, "label", "labelHtml")}</div>
          ${o.metaHtml != null ? <div class="sf-meta-text">${html(o.metaHtml)}</div> : ""}
          ${o.meta && o.metaHtml == null ? <div class="sf-meta-text">${escapeHtml(o.meta)}</div> : ""}
        </div>
        <div class="${classNames(toneTextClass(o.tone), o.valueClassName)}">
          ${renderField(o, "value", "valueHtml") || "—"}
        </div>
      </li>
    ;
  }

  function statList(items, opts) {
    const o = opts || {};
    const rows = (items || []).map(listRow).join("");
    return <ul class="${classNames("sf-list", o.className)}">${rows}</ul>;
  }

  function infoCard(opts) {
    const o = opts || {};
    return cardShell(
      
        ${sectionHead({
          kicker: o.kicker,
          title: o.title,
          subtitle: o.subtitle,
          subtitleHtml: o.subtitleHtml,
          meta: o.meta,
          metaHtml: o.metaHtml
        })}
        ${o.bodyHtml != null ? html(o.bodyHtml) : html(o.body || "")}
      ,
      {
        className: classNames("sf-insight-card", o.className),
        accent: o.accent
      }
    );
  }

  function chartCard(opts) {
    const o = opts || {};
    return 
      <section class="${classNames("sf-chart-card", o.accent && "sf-chart-card--accent", o.className)}">
        ${sectionHead({
          kicker: o.kicker,
          title: o.title,
          subtitle: o.subtitle,
          subtitleHtml: o.subtitleHtml,
          meta: o.meta,
          metaHtml: o.metaHtml
        })}
        <div class="sf-chart-slot"${o.chartId ?  id="${escapeHtml(o.chartId)}" : ""}>
          ${o.bodyHtml != null ? html(o.bodyHtml) : html(o.body || "")}
        </div>
      </section>
    ;
  }

  function emptyState(opts) {
    const o = opts || {};
    return 
      <div class="${classNames("sf-empty-state", o.className)}">
        <div>
          <h3 class="sf-card-title">${escapeHtml(o.title || "Nothing to show")}</h3>
          ${o.subtitleHtml != null ? <p class="sf-card-subtitle">${html(o.subtitleHtml)}</p> : ""}
          ${o.subtitle && o.subtitleHtml == null ? <p class="sf-card-subtitle">${escapeHtml(o.subtitle)}</p> : ""}
          ${o.actionHtml ? <div class="sf-empty-action">${html(o.actionHtml)}</div> : ""}
        </div>
      </div>
    ;
  }

  function loadingState(opts) {
    const o = opts || {};
    return 
      <div class="${classNames("sf-loading-state", o.className)}">
        <div>
          <h3 class="sf-card-title">${escapeHtml(o.title || "Loading")}</h3>
          ${o.subtitle ? <p class="sf-card-subtitle">${escapeHtml(o.subtitle)}</p> : ""}
        </div>
      </div>
    ;
  }

  function errorState(opts) {
    const o = opts || {};
    return 
      <div class="${classNames("sf-empty-state", "sf-tone-danger", o.className)}">
        <div>
          <h3 class="sf-card-title">${escapeHtml(o.title || "Load failed")}</h3>
          ${o.message ? <p class="sf-card-subtitle">${escapeHtml(o.message)}</p> : ""}
        </div>
      </div>
    ;
  }

  function debugPanel(opts) {
    const o = opts || {};
    const body = o.bodyHtml != null
      ? html(o.bodyHtml)
      : o.data != null
        ? <pre class="sf-debug-text">${escapeHtml(JSON.stringify(o.data, null, 2))}</pre>
        : "";

    return 
      <section class="${classNames("sf-debug-panel", "sf-debug-only", o.className)}">
        ${sectionHead({
          kicker: o.kicker || "Debug",
          title: o.title || "Debug",
          subtitle: o.subtitle,
          subtitleHtml: o.subtitleHtml,
          meta: o.meta,
          metaHtml: o.metaHtml
        })}
        ${body}
      </section>
    ;
  }

  root.escapeHtml = escapeHtml;
root.html = html;
root.classNames = classNames;
root.toneClass = toneClass;
root.toneTextClass = toneTextClass;

  root.formatNumber = formatNumber;
root.money = money;
root.percent = percent;

  root.statusPill = statusPill;
root.button = button;
root.chip = chip;

  root.cardShell = cardShell;
root.sectionHead = sectionHead;
root.metricCard = metricCard;
root.listRow = listRow;
root.statList = statList;
root.infoCard = infoCard;
root.chartCard = chartCard;

  root.emptyState = emptyState;
root.loadingState = loadingState;
root.errorState = errorState;
root.debugPanel = debugPanel;
})();
