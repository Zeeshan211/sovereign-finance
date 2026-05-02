/* ─── /api/insights — aggregate spending data for charts ─── */

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const days = parseInt(url.searchParams.get('days')) || 30;
    const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const db = context.env.DB;

    const catResult = await db.prepare(
      `SELECT c.id, c.name, c.icon, SUM(t.amount) as total, COUNT(*) as count
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.type = 'expense' AND t.date >= ?
       GROUP BY c.id ORDER BY total DESC`
    ).bind(sinceDate).all();

    const accResult = await db.prepare(
      `SELECT a.id, a.name, a.icon, SUM(t.amount) as total, COUNT(*) as count
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.type = 'expense' AND t.date >= ?
       GROUP BY a.id ORDER BY total DESC`
    ).bind(sinceDate).all();

    const trendResult = await db.prepare(
      `SELECT date, SUM(amount) as total
       FROM transactions
       WHERE type = 'expense' AND date >= ?
       GROUP BY date ORDER BY date ASC`
    ).bind(sinceDate).all();

    const sumResult = await db.prepare(
      `SELECT type, SUM(amount) as total
       FROM transactions
       WHERE date >= ? AND type IN ('income', 'expense')
       GROUP BY type`
    ).bind(sinceDate).all();

    const totals = { income: 0, expense: 0 };
    (sumResult.results || []).forEach(r => { totals[r.type] = r.total; });

    return jsonResponse({
      ok: true, days, since: sinceDate, totals,
      net: totals.income - totals.expense,
      by_category: catResult.results || [],
      by_account: accResult.results || [],
      daily_trend: trendResult.results || []
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
