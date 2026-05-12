/* /api/debts/health
 * Sovereign Finance · Debts Health
 * v1.0.0-debts-health
 *
 * Purpose:
 * - Verify immutable debt_payments rows against ledger transactions.
 * - Separate legacy migrated debt state from new banking-grade payment rows.
 * - Do not fail health just because old migrated debts have paid_amount without debt_payments backfill.
 */

const VERSION = 'v1.0.0-debts-health';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    const debts = await db.prepare(
      `SELECT *
       FROM debts
       ORDER BY kind, name, created_at`
    ).all();

    const payments = await db.prepare(
      `SELECT *
       FROM debt_payments
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 5000`
    ).all();

    const txCols = await columns(db, 'transactions');

    const debtRows = debts.results || [];
    const paymentRows = payments.results || [];

    const orphanPayments = [];
    const activePaymentWithReversedTxn = [];
    const reversedPaymentMissingReversalTxn = [];
    const transactionAmountMismatches = [];
    const debtPaidAmountMismatches = [];
    const legacyOpeningState = [];

    const activePaidByDebt = new Map();

    for (const payment of paymentRows) {
      const status = String(payment.status || 'paid');
      const paymentPaisa = Number(payment.amount_paisa || moneyToPaisa(payment.amount || 0));

      if (status === 'paid') {
        activePaidByDebt.set(
          payment.debt_id,
          (activePaidByDebt.get(payment.debt_id) || 0) + paymentPaisa
        );
      }

      const txn = await getTransaction(db, txCols, payment.transaction_id);

      if (!txn) {
        orphanPayments.push({
          debt_payment_id: payment.id,
          debt_id: payment.debt_id,
          transaction_id: payment.transaction_id
        });
        continue;
      }

      const txPaisa = moneyToPaisa(txn.amount || 0);

      if (Math.abs(paymentPaisa - txPaisa) > 1) {
        transactionAmountMismatches.push({
          debt_payment_id: payment.id,
          debt_id: payment.debt_id,
          transaction_id: txn.id,
          payment_paisa: paymentPaisa,
          transaction_paisa: txPaisa
        });
      }

      if (status === 'paid' && isTransactionReversed(txn)) {
        activePaymentWithReversedTxn.push({
          debt_payment_id: payment.id,
          debt_id: payment.debt_id,
          transaction_id: txn.id,
          reversed_by: txn.reversed_by || null,
          reversed_at: txn.reversed_at || null
        });
      }

      if (status === 'reversed' && !payment.reversal_transaction_id) {
        reversedPaymentMissingReversalTxn.push({
          debt_payment_id: payment.id,
          debt_id: payment.debt_id
        });
      }
    }

    for (const debt of debtRows) {
      const debtPaidPaisa = moneyToPaisa(debt.paid_amount || 0);
      const activePaymentPaisa = activePaidByDebt.get(debt.id) || 0;

      if (activePaymentPaisa > 0 && Math.abs(debtPaidPaisa - activePaymentPaisa) > 1) {
        debtPaidAmountMismatches.push({
          debt_id: debt.id,
          name: debt.name,
          kind: debt.kind,
          debt_paid_paisa: debtPaidPaisa,
          active_payment_paisa: activePaymentPaisa,
          delta_paisa: debtPaidPaisa - activePaymentPaisa
        });
      }

      if (activePaymentPaisa === 0 && debtPaidPaisa > 0) {
        legacyOpeningState.push({
          debt_id: debt.id,
          name: debt.name,
          kind: debt.kind,
          paid_amount: Number(debt.paid_amount || 0),
          paid_amount_paisa: debtPaidPaisa,
          status: debt.status || 'active',
          note: 'Legacy migrated paid_amount without immutable debt_payments backfill.'
        });
      }
    }

    const duplicateRows = await db.prepare(
      `SELECT debt_id, transaction_id, amount_paisa, COUNT(*) AS c
       FROM debt_payments
       WHERE status = 'paid'
       GROUP BY debt_id, transaction_id, amount_paisa
       HAVING COUNT(*) > 1`
    ).all();

    const hardFailures =
      orphanPayments.length ||
      activePaymentWithReversedTxn.length ||
      reversedPaymentMissingReversalTxn.length ||
      transactionAmountMismatches.length ||
      debtPaidAmountMismatches.length ||
      (duplicateRows.results || []).length;

    return json({
      ok: true,
      version: VERSION,
      health: {
        status: hardFailures ? 'warn' : 'pass',
        debt_count: debtRows.length,
        debt_payment_count: paymentRows.length,

        orphan_payments_without_transaction: orphanPayments,
        payments_with_reversed_transaction_but_active_payment: activePaymentWithReversedTxn,
        reversed_payments_without_reversal_transaction: reversedPaymentMissingReversalTxn,
        transaction_amount_mismatches: transactionAmountMismatches,
        debt_paid_amount_mismatches: debtPaidAmountMismatches,
        duplicate_payment_suspicions: duplicateRows.results || [],

        legacy_opening_state_count: legacyOpeningState.length,
        legacy_opening_state: legacyOpeningState
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

  const wanted = [
    'id',
    'amount',
    'notes',
    'reversed_by',
    'reversed_at'
  ];

  const select = wanted.filter(col => txCols.has(col));

  if (!select.length) return null;

  return db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

function isTransactionReversed(txn) {
  const notes = String(txn.notes || '').toUpperCase();

  return !!(
    txn.reversed_by ||
    txn.reversed_at ||
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
