(function () {
  var root = (window.SFComponents = window.SFComponents || {});

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function classNames() {
    return Array.prototype.slice.call(arguments).filter(Boolean).join(" ");
  }

  function toneClass(tone) {
    switch (tone) {
      case "positive":
      case "warning":
      case "danger":
      case "info":
        return "sf-pill--" + tone;
      default:
        return "";
    }
  }

  function cardShell(inner, opts) {
    var o = opts || {};
    return [
      '<section class="' + classNames(o.className || "sf-panel", o.accent && "sf-panel--accent") + '">',
      inner || "",
      "</section>"
    ].join("");
  }

  function sectionHead(opts) {
    var o = opts || {};
    var meta = o.meta ? "<div>" + o.meta + "</div>" : "";
    return [
      '<div class="sf-section-head">',
      "  <div>",
      o.kicker ? '    <p class="sf-section-kicker">' + escapeHtml(o.kicker) + "</p>" : "",
      o.title ? '    <h2 class="sf-section-title">' + escapeHtml(o.title) + "</h2>" : "",
      o.subtitle ? '    <p class="sf-section-subtitle">' + escapeHtml(o.subtitle) + "</p>" : "",
      "  </div>",
      meta,
      "</div>"
    ].join("");
  }

  function metricCard(opts) {
    var o = opts || {};
    var valueMarkup = o.valueHtml != null ? o.valueHtml : escapeHtml(o.value || "—");
    var subtitleMarkup = o.subtitleHtml != null
      ? o.subtitleHtml
      : (o.subtitle ? escapeHtml(o.subtitle) : "");
    var footMarkup = o.footHtml != null
      ? o.footHtml
      : (o.foot ? escapeHtml(o.foot) : "");

    return [
      '<section class="' + classNames("sf-metric-card", o.accent && "sf-metric-card--accent", o.className) + '">',
      o.kicker ? '  <p class="sf-card-kicker">' + escapeHtml(o.kicker) + "</p>" : "",
      o.title ? '  <h3 class="sf-card-title">' + escapeHtml(o.title) + "</h3>" : "",
      '  <div class="sf-metric-value">' + valueMarkup + "</div>",
      subtitleMarkup ? '  <p class="sf-card-subtitle">' + subtitleMarkup + "</p>" : "",
      footMarkup ? '  <div class="sf-metric-foot ' + toneClass(o.tone) + '">' + footMarkup + "</div>" : "",
      "</section>"
    ].join("");
  }

  function chip(opts) {
    var o = opts || {};
    var tag = o.tag || "button";
    var classes = classNames(
      tag === "button" ? "sf-chip" : "sf-pill",
      o.active && "is-active",
      o.className,
      toneClass(o.tone)
    );
    var attrs = ['class="' + classes + '"'];

    if (tag === "button") attrs.push('type="button"');

    if (o.dataset && typeof o.dataset === "object") {
      Object.keys(o.dataset).forEach(function (key) {
        attrs.push("data-" + escapeHtml(key) + '="' + escapeHtml(o.dataset[key]) + '"');
      });
    }

    return "<" + tag + " " + attrs.join(" ") + ">" + escapeHtml(o.label || "") + "</" + tag + ">";
  }

  function statList(items) {
    var rows = (items || []).map(function (item) {
      return [
        '<li class="sf-list-item">',
        "  <div>",
        "    <div>" + escapeHtml(item.label || "") + "</div>",
        item.meta ? '    <div class="sf-meta-text">' + escapeHtml(item.meta) + "</div>" : "",
        "  </div>",
        '  <div class="' + classNames(item.tone && ("sf-tone-" + item.tone)) + '">' + escapeHtml(item.value || "—") + "</div>",
        "</li>"
      ].join("");
    }).join("");

    return '<ul class="sf-list">' + rows + "</ul>";
  }

  function infoCard(opts) {
    var o = opts || {};
    return [
      '<section class="' + classNames("sf-insight-card", o.className, o.accent && "sf-panel--accent") + '">',
      sectionHead({ kicker: o.kicker, title: o.title, subtitle: o.subtitle, meta: o.meta }),
      o.body || "",
      "</section>"
    ].join("");
  }

  function chartCard(opts) {
    var o = opts || {};
    var idAttr = o.chartId ? ' id="' + escapeHtml(o.chartId) + '"' : "";
    return [
      '<section class="' + classNames("sf-chart-card", o.className, o.accent && "sf-chart-card--accent") + '">',
      sectionHead({ kicker: o.kicker, title: o.title, subtitle: o.subtitle, meta: o.meta }),
      '  <div class="sf-chart-slot"' + idAttr + ">" + (o.body || "") + "</div>",
      "</section>"
    ].join("");
  }

  function emptyState(opts) {
    var o = opts || {};
    return [
      '<div class="sf-empty-state">',
      "  <div>",
      '    <h3 class="sf-card-title">' + escapeHtml(o.title || "Nothing to show") + "</h3>",
      o.subtitle ? '    <p class="sf-card-subtitle">' + escapeHtml(o.subtitle) + "</p>" : "",
      "  </div>",
      "</div>"
    ].join("");
  }

  function loadingState(opts) {
    var o = opts || {};
    return [
      '<div class="sf-loading-state">',
      "  <div>",
      '    <h3 class="sf-card-title">' + escapeHtml(o.title || "Loading") + "</h3>",
      o.subtitle ? '    <p class="sf-card-subtitle">' + escapeHtml(o.subtitle) + "</p>" : "",
      "  </div>",
      "</div>"
    ].join("");
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
