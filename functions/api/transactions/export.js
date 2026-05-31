// GET /api/transactions/export — download all transactions as CSV
// Query params: from (YYYY-MM-DD), to (YYYY-MM-DD), account_id

import { json } from '../_lib.js';

const CSV_COLUMNS = [
  'id', 'date', 'type', 'amount', 'currency', 'pkr_amount',
  'account_id', 'category_id', 'merchant', 'notes',
  'fee_amount', 'fx_rate_at_commit', 'created_at',
];

function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowToCsv(row) {
  return CSV_COLUMNS.map(col => escapeCsv(row[col])).join(',');
}

export async function onRequestGet(context) {
  try {
    const userId = context.data?.user_id;
    if (!userId) return json({ ok: false, error: 'Unauthorized' }, 401);

    const url = new URL(context.request.url);
    const from      = url.searchParams.get('from')       || null;
    const to        = url.searchParams.get('to')         || null;
    const accountId = url.searchParams.get('account_id') || null;

    const conditions = ['created_by_user_id = ?'];
    const binds      = [userId];

    if (from)      { conditions.push('date >= ?'); binds.push(from); }
    if (to)        { conditions.push('date <= ?'); binds.push(to); }
    if (accountId) { conditions.push('account_id = ?'); binds.push(accountId); }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const { results } = await context.env.DB.prepare(
      `SELECT ${CSV_COLUMNS.join(', ')}
       FROM transactions
       ${whereClause}
         AND (reversed_by IS NULL OR reversed_by = '')
         AND (reversed_at IS NULL)
       ORDER BY date DESC, created_at DESC`
    ).bind(...binds).all();

    const rows   = results || [];
    const header = CSV_COLUMNS.join(',');
    const body   = [header, ...rows.map(rowToCsv)].join('\n');

    const filename = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}
