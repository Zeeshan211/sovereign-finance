/* /api/transactions
 * Sovereign Finance · Transactions Recovery Route
 * v0.5.3-transactions-json-recovery
 */

const VERSION = 'v0.5.3-transactions-json-recovery';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);

    const includeReversed = url.searchParams.get('include_reversed') === '1';
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);

    const cols = await tableColumns(db, 'transactions');

    if (!cols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        error: 'transactions table missing id column'
      }, 500);
    }

    const select = [
      'id',
      'date',
      'type',
      'amount',
      'account_id',
      'transfer_to_account_id',
      'category_id',
      'notes',
      'fee_amount',
      'pra_amount',
      'currency',
      'pkr_amount',
      'fx_rate_at_commit',
      'fx_source',
      'intl_package_id',
      'reversed_by',
      'reversed_at',
      'linked_txn_id',
      'created_by',
      'created_at'
    ].filter(col => cols.has(col));

    const fetchLimit = includeReversed
      ? limit
      : Math.min(500, Math.max(limit * 5, limit + 100));

    const orderBy = buildOrderBy(cols);

    const result = await db.prepare(
      `SELECT ${select.join(', ')}
       FROM transactions
       ORDER BY ${orderBy}
       LIMIT ?`
    ).bind(fetchLimit).all();

    const decorated = (result.results || []).map(decorateTransaction);

    const visible = includeReversed
      ? decorated.slice(0, limit)
      : decorated.filter(row => !row.is_reversal).slice(0, limit);

    return json({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
      count: visible.length,
      fetched_count: decorated.length,
      hidden_reversal_count: includeReversed ? 0 : decorated.filter(row => row.is_reversal).length,
      transactions: visible
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

export async function onRequestPost() {
  return json({
    ok: false,
    version: VERSION,
    error: 'POST temporarily disabled in recovery route. Restore write route after ledger read is healthy.'
  }, 503);
}

async function tableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const set = new Set();

  for (const row of result.results || []) {
    if (row.name) set.add(row.name);
  }

  return set;
}

function buildOrderBy(cols) {
  const parts = [];

  if (cols.has('date')) parts.push('date DESC');
  if (cols.has('created_at')) parts.push('datetime(created_at) DESC');
  if (cols.has('id')) parts.push('id DESC');

  return parts.length ? parts.join(', ') : 'rowid DESC';
}

function decorateTransaction(row) {
  const notes = String(row.notes || '');
  const upper = notes.toUpperCase();

  const isReversal = upper.includes('[REVERSAL OF ');
  const isReversed = !!(
    row.reversed_by ||
    row.reversed_at ||
    upper.includes('[REVERSED BY ')
  );

  const linkedFromNote = extractLinkedId(notes);

  const groupId =
    row.intl_package_id ||
    row.linked_txn_id ||
    linkedFromNote ||
    null;

  return {
    ...row,
    display_amount: Number(row.pkr_amount || row.amount || 0),
    is_reversal: isReversal,
    is_reversed: isReversed,
    reverse_eligible: !isReversal && !isReversed,
    reverse_block_reason: isReversal
      ? 'reversal_row'
      : (isReversed ? 'already_reversed' : null),
    group_id: groupId,
    group_type: row.intl_package_id
      ? 'intl_package'
      : (groupId ? 'linked_pair' : 'single')
  };
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}