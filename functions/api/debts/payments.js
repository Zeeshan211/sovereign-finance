/* /api/debts/payments
 * Sovereign Finance · Debt Payments List
 * v1.0.0-debts-payments-list
 *
 * Read-only route for immutable debt payment rows.
 * Used by Debts UI for payment history and reverse actions.
 */

const VERSION = 'v1.0.0-debts-payments-list';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);

    const debtId = text(url.searchParams.get('debt_id'), '', 160);
    const limit = clampInt(url.searchParams.get('limit'), 1, 500, 200);

    const paymentCols = await cols(db, 'debt_payments');
    const txCols = await cols(db, 'transactions');
    const debtCols = await cols(db, 'debts');

    if (!paymentCols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        error: 'debt_payments table missing or unreadable'
      }, 500);
    }

    const select = [
      'dp.*',
      debtCols.has('name') ? 'd.name AS debt_name' : 'NULL AS debt_name',
      debtCols.has('kind') ? 'd.kind AS debt_kind' : 'NULL AS debt_kind',
      txCols.has('amount') ? 't.amount AS transaction_amount' : 'NULL AS transaction_amount',
      txCols.has('account_id') ? 't.account_id AS transaction_account_id' : 'NULL AS transaction_account_id',
      txCols.has('category_id') ? 't.category_id AS transaction_category_id' : 'NULL AS transaction_category_id',
      txCols.has('notes') ? 't.notes AS transaction_notes' : 'NULL AS transaction_notes',
      txCols.has('reversed_by') ? 't.reversed_by AS transaction_reversed_by' : 'NULL AS transaction_reversed_by',
      txCols.has('reversed_at') ? 't.reversed_at AS transaction_reversed_at' : 'NULL AS transaction_reversed_at'
    ];

    const where = [];
    const binds = [];

    if (debtId) {
      where.push('dp.debt_id = ?');
      binds.push(debtId);
    }

    const sql = `
      SELECT ${select.join(', ')}
      FROM debt_payments dp
      LEFT JOIN debts d
        ON d.id = dp.debt_id
      LEFT JOIN transactions t
        ON t.id = dp.transaction_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY datetime(dp.created_at) DESC, dp.id DESC
      LIMIT ?
    `;

    binds.push(limit);

    const result = await db.prepare(sql).bind(...binds).all();
    const rows = result.results || [];

    const payments = rows.map(row => {
      const amountPaisa = Number(row.amount_paisa || moneyToPaisa(row.amount || 0));
      const txnPaisa = Number.isFinite(Number(row.transaction_amount))
        ? moneyToPaisa(row.transaction_amount)
        : null;

      const transactionReversed = !!(
        row.transaction_reversed_by ||
        row.transaction_reversed_at ||
        String(row.transaction_notes || '').toUpperCase().includes('[REVERSED BY ')
      );

      const amountMatches = txnPaisa == null
        ? false
        : Math.abs(amountPaisa - txnPaisa) <= 1;

      return {
        id: row.id,
        debt_id: row.debt_id,
        debt_name: row.debt_name || row.debt_name_snapshot || row.debt_id,
        debt_kind: row.debt_kind || row.debt_kind_snapshot,

        debt_name_snapshot: row.debt_name_snapshot,
        debt_kind_snapshot: row.debt_kind_snapshot,

        original_amount: Number(row.original_amount || 0),
        paid_before: Number(row.paid_before || 0),
        amount: Number(row.amount || 0),
        paid_after: Number(row.paid_after || 0),
        remaining_after: Number(row.remaining_after || 0),

        original_amount_paisa: Number(row.original_amount_paisa || 0),
        paid_before_paisa: Number(row.paid_before_paisa || 0),
        amount_paisa: amountPaisa,
        paid_after_paisa: Number(row.paid_after_paisa || 0),
        remaining_after_paisa: Number(row.remaining_after_paisa || 0),

        account_id: row.account_id,
        category_id: row.category_id,
        paid_date: row.paid_date,

        transaction_id: row.transaction_id,
        transaction_amount: row.transaction_amount == null ? null : Number(row.transaction_amount),
        transaction_account_id: row.transaction_account_id,
        transaction_category_id: row.transaction_category_id,
        transaction_reversed_by: row.transaction_reversed_by || null,
        transaction_reversed_at: row.transaction_reversed_at || null,
        transaction_reversed: transactionReversed,
        amount_matches_transaction: amountMatches,

        status: row.status || 'paid',
        reversed_at: row.reversed_at || null,
        reversal_transaction_id: row.reversal_transaction_id || null,
        reason: row.reason || '',
        notes: row.notes || '',

        dry_run_payload_hash: row.dry_run_payload_hash || null,
        transaction_payload_hash: row.transaction_payload_hash || null,

        created_by: row.created_by || null,
        created_at: row.created_at || null,

        reverse_eligible: String(row.status || 'paid') === 'paid' && !transactionReversed,
        reverse_block_reason: String(row.status || 'paid') !== 'paid'
          ? 'payment_not_active'
          : (transactionReversed ? 'linked_transaction_already_reversed' : null)
      };
    });

    const activeCount = payments.filter(p => p.status === 'paid').length;
    const reversedCount = payments.filter(p => p.status === 'reversed').length;
    const mismatchCount = payments.filter(p => !p.amount_matches_transaction).length;
    const reversedTxnActiveCount = payments.filter(p => p.status === 'paid' && p.transaction_reversed).length;

    return json({
      ok: true,
      version: VERSION,
      debt_id: debtId || null,
      count: payments.length,
      summary: {
        active_count: activeCount,
        reversed_count: reversedCount,
        amount_mismatch_count: mismatchCount,
        active_payment_with_reversed_transaction_count: reversedTxnActiveCount
      },
      payments
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

async function cols(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const set = new Set();

    for (const row of result.results || []) {
      if (row.name) set.add(row.name);
    }

    return set;
  } catch {
    return new Set();
  }
}

function moneyToPaisa(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function text(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw).trim().slice(0, max);
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
