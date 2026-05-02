/* ─── /api/salary — read salary_* keys from settings table ─── */

export async function onRequestGet(context) {
  try {
    const stmt = context.env.DB.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'salary_%' ORDER BY key"
    );
    const result = await stmt.all();
    const rows = result.results || [];

    const components = rows.map(r => ({
      key: r.key,
      label: r.key.replace(/^salary_/, '').replace(/_/g, ' '),
      value: parseFloat(r.value) || 0
    }));

    // Compute payday countdown (sheet pays 1st of each month, lands in Meezan)
    const today = new Date();
    const nextPayday = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const daysToNext = Math.ceil((nextPayday - today) / (1000 * 60 * 60 * 24));

    // Sum totals
    const total = components.reduce((s, c) => s + c.value, 0);

    return jsonResponse({
      ok: true,
      count: components.length,
      total,
      next_payday: nextPayday.toISOString().slice(0, 10),
      days_to_next: daysToNext,
      components
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  });
}
