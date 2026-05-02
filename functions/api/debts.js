/* ─── /api/debts — list all debts and receivables ─── */

export async function onRequest(context) {
  try {
    const stmt = context.env.DB.prepare(
      `SELECT id, name, kind, original_amount, paid_amount, snowball_order, due_date, status, notes
       FROM debts WHERE status = 'active' ORDER BY snowball_order ASC`
    );
    const result = await stmt.all();

    const debts = result.results || [];
    let totalOwe = 0;
    let totalOwed = 0;
    debts.forEach(d => {
      const remaining = (d.original_amount || 0) - (d.paid_amount || 0);
      if (d.kind === 'owe') totalOwe += remaining;
      else if (d.kind === 'owed') totalOwed += remaining;
    });

    return new Response(JSON.stringify({
      ok: true,
      count: debts.length,
      total_owe: Math.round(totalOwe * 100) / 100,
      total_owed: Math.round(totalOwed * 100) / 100,
      debts: debts
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
