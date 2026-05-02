/* ─── Sovereign Finance · Animated Counters v0.5.0 ─── */
/* Public API: window.animateNumber(element, targetValue, options)
   Auto-runs on any element with class "counter" and data-value attribute */

(function () {
  const DEFAULT_DURATION = 900;
  const ease = t => 1 - Math.pow(1 - t, 3);

  function animateNumber(el, target, opts) {
    if (!el) return;
    opts = opts || {};
    const duration = opts.duration || DEFAULT_DURATION;
    const start = parseFloat(el.dataset.current || '0');
    const targetNum = parseFloat(target) || 0;
    const fmt = opts.format || (n => Math.round(n).toLocaleString('en-US'));
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const value = start + (targetNum - start) * ease(t);
      el.textContent = fmt(value);
      if (t < 1) requestAnimationFrame(step);
      else {
        el.textContent = fmt(targetNum);
        el.dataset.current = targetNum;
      }
    }
    requestAnimationFrame(step);
  }

  window.animateNumber = animateNumber;

  // Auto-run on data-value elements
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-animate-value]').forEach(el => {
      const target = parseFloat(el.dataset.animateValue);
      animateNumber(el, target);
    });
  });
})();
