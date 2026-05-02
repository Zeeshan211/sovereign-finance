/* ─── /api/bills — GET list with status, POST create ─── */

export async function onRequestGet(context) {
  try {
    const stmt = context.env.DB.prepare(
      `SELECT id, name, amount, due_day, frequency, category_id, default_account_id,
              last_paid_date, auto_post
       FROM bills ORDER BY due_day ASC`
    );
    const result = await stmt.all();
    const bills = result.results || [];

    // Compute status for each bill (overdue / due soon / paid this period / upcoming)
    const today = new Date();
    const thisDay = today.getDate();
    const thisMonth = today.toISOString().slice(0, 7);

    const enriched = bills.map(b => {
      const dueDay = b.due_day || 1;
      const lastPaid = b.last_paid_date || '';
      const paidThisPeriod = lastPaid.startsWith(thisMonth);
      const daysToDue = dueDay - thisDay;

      let status = 'upcoming';
      let daysLabel = '';
      if (paidThisPeriod) {
        status = 'paid';
        daysLabel = 'paid';
      } else if (daysToDue < 0) {
        status = 'overdue';
        daysLabel = Math.abs(daysToDue) + 'd overdue';
      } else if (daysToDue === 0) {
        status = 'due-today';
        daysLabel = 'due today';
      } else if (daysToDue <= 3) {
        status = 'due-soon';
        daysLabel = 'in ' + daysToDue + 'd';
      } else {
        status = 'upcoming';
        daysLabel = 'in ' + daysToDue + 'd';
      }

      return { ...b, status, daysLabel, paidThisPeriod };
    });

    const totalMonthly = enriched.reduce((s, b) => s + (b.amount || 0), 0);
    const remaining = enriched.filter(b => !b.paidThisPeriod).reduce((s, b) => s + (b.amount || 0), 0);
    const paidCount = enriched.filter(b => b.paidThisPeriod).length;

    return jsonResponse({
      ok: true,
      count: enriched.length,
      total_monthly: Math.round(totalMonthly * 100) / 100,
      remaining_this_period: Math.round(remaining * 100) / 100,
      paid_count: paidCount,
      bills: enriched
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const amount = parseFloat(body.amount);
    if (!body.name || isNaN(amount) || amount <= 0) {
      return jsonResponse({ ok: false, error: 'Name and amount > 0 required' }, 400);
    }

    const id = 'bill_' + (body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) + '_' + Date.now().toString(36);

    await context.env.DB.prepare(
      `INSERT INTO bills (id, name, amount, due_day, frequency, category_id, default_account_id, auto_post)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      body.name,
      amount,
      parseInt(body.due_day) || 1,
      body.frequency || 'monthly',
      body.category_id || 'bills',
      body.default_account_id || null,
      body.auto_post ? 1 : 0
    ).run();

    return jsonResponse({ ok: true, id });
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
