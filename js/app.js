/* ─── Sovereign Finance · Shared App Logic v0.0.5 ─── */

(function initQuestDay() {
  const QUEST_START = new Date('2026-04-25');
  const today = new Date();
  const day = Math.floor((today - QUEST_START) / 86400000) + 1;
  const el = document.getElementById('dayNum');
  if (el) el.textContent = day;
})();
