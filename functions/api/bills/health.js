/* /api/bills/health
 * Sovereign Finance · Bills Health
 * v1.0.1-bills-health-route
 */

const VERSION = 'v1.0.1-bills-health-route';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    const payments = await db.prepare(
      `SELECT *
       FROM bill_payments
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 5000`
    ).all();

    const rows = payments.results || [];

    const txCols = await columns(db, 'transactions');

    const orphanPayments = [];
    const reversedTxnActivePayment = [];
    const reversedPaymentsMissingReversal = [];
    const amountMismatches = [];

    for (const p of rows) {
      const tx = await getTransaction(db, txCols, p.transaction_id);

      if (!tx) {
        orphanPayments.push(p.id);
        continue;
      }

      const paymentPaisa = Number(p.amount_paisa || moneyToPaisa(p.amount || 0));
      const txPaisa = moneyToPaisa(tx.amount || 0);

      if (Math.abs(paymentPaisa - txPaisa) > 1) {
        amountMismatches.push({
          bill_payment_id: p.id,
          transaction_id: tx.id,
          payment_paisa: paymentPaisa,
          transaction_paisa: txPaisa
        });
      }

      if (isReversed(tx) && String(p.status || 'paid') === 'paid') {
        reversedTxnActivePayment.push({
          bill_payment_id: p.id,
          transaction_id: tx.id
        });
      }

      if (String(p.status || '') === 'reversed' && !p.reversal_transaction_id) {
        reversedPaymentsMissingReversal.push(p.id);
      }
    }

    const duplicateRows = await db.prepare(
      `SELECT bill_id, bill_month, amount_paisa, COUNT(*) AS c
       FROM bill_payments
       WHERE status = 'paid'
       GROUP BY bill_id, bill_month, amount_paisa
       HAVING COUNT(*) > 1`
    ).all();

    const status =
      orphanPayments.length ||
      reversedTxnActivePayment.length ||
      reversedPaymentsMissingReversal.length ||
      amountMismatches.length
        ? 'warn'
        : 'pass';

    return json({
      ok: true,
      version: VERSION,
      health: {
        status,
        payment_count: rows.length,
        orphan_payments_without_transaction: orphanPayments,
        payments_with_reversed_transaction_but_active_payment: reversedTxnActivePayment,
        reversed_payments_without_reversal_transaction: reversedPaymentsMissingReversal,
        duplicate_payments_same_month: duplicateRows.results || [],
        payment_amount_mismatches: amountMismatches
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

async function columns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const set = new Set();

  for (const row of result.results || []) {
    if (row.name) set.add(row.name);
  }

  return set;
}

async function getTransaction(db, txCols, id) {
  if (!id) return null;

  const select = [
    'id',
    'amount',
    'notes',
    'reversed_by',
    'reversed_at'
  ].filter(c => txCols.has(c));

  if (!select.length) return null;

  return db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

function isReversed(row) {
  const notes = String(row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSED BY ')
  );
}

function moneyToPaisa(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100);
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
