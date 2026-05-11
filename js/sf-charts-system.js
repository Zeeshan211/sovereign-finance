(function () {
  const palette = {
    accent: "#5ba2ff",
    accentStrong: "#7cc4ff",
    positive: "#53d7a7",
    warning: "#f1b857",
    danger: "#ff7f8a",
    text: "#eef4ff",
    muted: "#94a9cc",
    grid: "rgba(130, 164, 220, 0.14)"
  };

  function getCssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function getPalette() {
    return {
      accent: getCssVar("--sf-accent", palette.accent),
      accentStrong: getCssVar("--sf-accent-strong", palette.accentStrong),
      positive: getCssVar("--sf-positive", palette.positive),
      warning: getCssVar("--sf-warning", palette.warning),
      danger: getCssVar("--sf-danger", palette.danger),
      text: getCssVar("--sf-text", palette.text),
      muted: getCssVar("--sf-text-muted", palette.muted),
      grid: getCssVar("--sf-border-subtle", palette.grid)
    };
  }

  function baseOptions() {
    const p = getPalette();
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 260,
        easing: "easeOutQuart"
      },
      plugins: {
        legend: {
          labels: {
            color: p.text,
            usePointStyle: true,
            boxWidth: 10,
            boxHeight: 10,
            padding: 16
          }
        },
        tooltip: {
          backgroundColor: "rgba(9, 20, 39, 0.94)",
          titleColor: "#eef4ff",
          bodyColor: "#cad7ef",
          borderColor: p.grid,
          borderWidth: 1,
          padding: 12,
          displayColors: true
        }
      },
      scales: {
        x: {
          ticks: { color: p.muted },
          grid: { color: p.grid, drawBorder: false }
        },
        y: {
          ticks: { color: p.muted },
          grid: { color: p.grid, drawBorder: false }
        }
      }
    };
  }

  function money(value, currency) {
    const amount = Number(value || 0);
    return new Intl.NumberFormat("en-PK", {
      style: "currency",
      currency: currency || "PKR",
      maximumFractionDigits: 2
    }).format(amount);
  }

  function integer(value) {
    return new Intl.NumberFormat("en-PK", {
      maximumFractionDigits: 0
    }).format(Number(value || 0));
  }

  window.SFChartsSystem = {
    getPalette,
    baseOptions,
    money,
    integer
  };
})();
