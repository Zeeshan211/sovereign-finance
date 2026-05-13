/* /api/debts/health
 * Sovereign Finance · Debts Health
 * v1.1.0-debts-health-origin-invariant
 *
 * Purpose:
 * - Verify immutable debt_payments rows against ledger transactions.
 * - Separate legacy migrated debt state from new banking-grade payment rows.
 * - Verify debt origin ledger state separately from debt payment state.
 * - Do not fail health just because old migrated debts have paid_amount without debt_payments backfill.
 * - Do not auto-repair legacy rows.
 */

const VERSION = 'v1.1.0-debts-health-origin-invariant';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    const debts = await db.prepare(
      `SELECT *
       FROM debts
       ORDER BY kind, name, created_at`
    ).all();

    const payments = await safeSelectPayments(db);
    const txCols = await columns(db, 'transactions');

    const debtRows = debts.results || [];
    const paymentRows = payments;

    const orphanPayments = [];
    const activePaymentWithReversedTxn = [];
    const reversedPaymentMissingReversalTxn = [];
    const transactionAmountMismatches = [];
    const debtPaidAmountMismatches = [];
    const duplicatePaymentSuspicions = await findDuplicatePayments(db);

    const activePaidByDebt = new Map();

    for (const payment of paymentRows) {
      const status = String(payment.status || 'paid').toLowerCase();
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

    const debtIds = debtRows.map(row => String(row.id || '')).filter(Boolean);
    const linkMap = await loadDebtLedgerLinks(db, txCols, debtIds);

    const legacyOpeningState = [];
    const originLinked = [];
    const legacyUnknown = [];
    const paymentLinkedOnly = [];
    const repairRequired = [];
    const originBadType = [];
    const originBadAmount = [];

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

      const normalized = normalizeDebt(debt);
      const links = linkMap.get(String(normalized.id)) || [];
      const classified = classifyDebtLedgerState(normalized, links);

      if (classified.origin_state === 'ledger_linked') {
        originLinked.push({
          debt_id: normalized.id,
          name: normalized.name,
          kind: normalized.kind,
          origin_transaction_ids: classified.origin_transaction_ids
        });
      }

      if (classified.origin_state === 'legacy_unknown') {
        legacyUnknown.push({
          debt_id: normalized.id,
          name: normalized.name,
          kind: normalized.kind,
          status: normalized.status,
          remaining_amount: normalized.remaining_amount,
          note: 'Legacy/opening debt. Not auto-repaired without manual origin classification.'
        });
      }

      if (classified.origin_state === 'payment_linked_only') {
        paymentLinkedOnly.push({
          debt_id: normalized.id,
          name: normalized.name,
          kind: normalized.kind,
          payment_transaction_ids: classified.payment_transaction_ids,
          note: 'Payment transaction exists but no origin transaction is proven.'
        });
      }

      if (classified.repair_required) {
        repairRequired.push({
          debt_id: normalized.id,
          name: normalized.name,
          kind: normalized.kind,
          original_amount: normalized.original_amount,
          origin_state: classified.origin_state,
          note: 'Explicit money_moved_now debt is missing origin ledger row.'
        });
      }

      const badOrigin = findBadOrigin(normalized, links);
      if (badOrigin.bad_type) originBadType.push(badOrigin.bad_type);
      if (badOrigin.bad_amount) originBadAmount.push(badOrigin.bad_amount);
    }

    const hardFailures =
      orphanPayments.length ||
      activePaymentWithReversedTxn.length ||
      reversedPaymentMissingReversalTxn.length ||
      transactionAmountMismatches.length ||
      debtPaidAmountMismatches.length ||
      duplicatePaymentSuspicions.length ||
      repairRequired.length ||
      originBadType.length ||
      originBadAmount.length;

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
        duplicate_payment_suspicions: duplicatePaymentSuspicions,

        legacy_opening_state_count: legacyOpeningState.length,
        legacy_opening_state: legacyOpeningState,

        origin_linked_count: originLinked.length,
        origin_linked: originLinked,

        legacy_unknown_count: legacyUnknown.length,
        legacy_unknown: legacyUnknown,

        payment_linked_only_count: paymentLinkedOnly.length,
        payment_linked_only: paymentLinkedOnly,

        repair_required_count: repairRequired.length,
        repair_required_debt_ids: repairRequired.map(row => row.debt_id),
        repair_required: repairRequired,

        origin_bad_type_count: originBadType.length,
        origin_bad_type: originBadType,

        origin_bad_amount_count: originBadAmount.length,
        origin_bad_amount: originBadAmount,

        rules: {
          immutable_debt_payments_verified: true,
          origin_and_payment_links_classified_separately: true,
          legacy_unknown_is_not_auto_repaired: true,
          only_explicit_movement_now_debts_can_be_repair_required: true,
          payment_transactions_do_not_count_as_origin: true
        }
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

/* ─────────────────────────────
 * Payment health helpers
 * ───────────────────────────── */

async function safeSelectPayments(db) {
  try {
    const payments = await db.prepare(
      `SELECT *
       FROM debt_payments
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 5000`
    ).all();

    return payments.results || [];
  } catch {
    return [];
  }
}

async function findDuplicatePayments(db) {
  try {
    const duplicateRows = await db.prepare(
      `SELECT debt_id, transaction_id, amount_paisa, COUNT(*) AS c
       FROM debt_payments
       WHERE status = 'paid'
       GROUP BY debt_id, transaction_id, amount_paisa
       HAVING COUNT(*) > 1`
    ).all();

    return duplicateRows.results || [];
  } catch {
    return [];
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
    'date',
    'type',
    'amount',
    'account_id',
    'category_id',
    'notes',
    'created_at',
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
    notes.includes('[REVERSED BY ') ||
    notes.includes('[REVERSAL OF ')
  );
}

/* ─────────────────────────────
 * Debt origin classifier
 * ───────────────────────────── */

async function loadDebtLedgerLinks(db, txCols, debtIds) {
  const map = new Map();

  for (const id of debtIds || []) {
    map.set(String(id), []);
  }

  if (!debtIds || !debtIds.length) return map;
  if (!txCols.has('notes')) return map;

  const select = [
    'id',
    'date',
    'type',
    'amount',
    'account_id',
    'category_id',
    'notes',
    'created_at',
    'reversed_by',
    'reversed_at'
  ].filter(col => txCols.has(col));

  for (const chunk of chunks(debtIds, 40)) {
    const where = chunk.map(() => 'notes LIKE ?').join(' OR ');
    const args = chunk.map(id => `%debt_id=${id}%`);

    const res = await db.prepare(
      `SELECT ${select.join(', ')}
       FROM transactions
       WHERE ${where}
       ORDER BY ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
    ).bind(...args).all();

    for (const tx of res.results || []) {
      const debtId = extractDebtId(tx.notes);

      if (!debtId) continue;
      if (!map.has(debtId)) map.set(debtId, []);
      map.get(debtId).push(sanitizeTransaction(tx));
    }
  }

  return map;
}

function classifyDebtLedgerState(debt, linkedTransactions) {
  const txs = Array.isArray(linkedTransactions) ? linkedTransactions : [];
  const activeTxs = txs.filter(tx => !isTransactionReversed(tx));

  const originTxs = activeTxs.filter(tx => isOriginTransactionForDebt(debt, tx));
  const paymentTxs = activeTxs.filter(tx => isPaymentTransactionForDebt(debt, tx));

  const debtNotes = String(debt.notes || '').toLowerCase();

  const explicitMovementNow =
    debtNotes.includes('movement_now=1') ||
    debtNotes.includes('[debt_origin]') ||
    debtNotes.includes('[debt_origin_repair]') ||
    originTxs.some(tx => {
      const notes = String(tx.notes || '').toLowerCase();
      return notes.includes('[debt_origin]') || notes.includes('[debt_origin_repair]');
    });

  let originState = 'legacy_unknown';
  let repairRequired = false;

  if (originTxs.length > 0) {
    originState = 'ledger_linked';
  } else if (explicitMovementNow) {
    originState = 'ledger_missing';
    repairRequired = true;
  } else if (paymentTxs.length > 0) {
    originState = 'payment_linked_only';
  } else {
    originState = 'legacy_unknown';
  }

  return {
    origin_state: originState,
    origin_required: explicitMovementNow || originTxs.length > 0,
    origin_linked: originTxs.length > 0,
    origin_transaction_ids: originTxs.map(tx => tx.id),
    origin_transactions: originTxs,
    payment_transaction_ids: paymentTxs.map(tx => tx.id),
    payment_transactions: paymentTxs,
    all_linked_transaction_ids: activeTxs.map(tx => tx.id),
    repair_required: repairRequired
  };
}

function isOriginTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const type = String(tx.type || '').toLowerCase();
  const amountMatches = Math.abs(Number(tx.amount || 0) - Number(debt.original_amount || 0)) < 0.01;

  if (notes.includes('[DEBT_ORIGIN]')) return true;
  if (notes.includes('[DEBT_ORIGIN_REPAIR]')) return true;

  if (!amountMatches) return false;

  if (debt.kind === 'owed') {
    return ['expense', 'debt_out'].includes(type);
  }

  if (debt.kind === 'owe') {
    return ['income', 'borrow', 'debt_in'].includes(type);
  }

  return false;
}

function isPaymentTransactionForDebt(debt, tx) {
  const notes = String(tx.notes || '').toUpperCase();
  const type = String(tx.type || '').toLowerCase();

  if (notes.includes('[DEBT_PAYMENT]')) return true;
  if (notes.includes('[DEBT_RECEIVE]')) return true;

  if (debt.kind === 'owed') {
    return ['income', 'debt_in'].includes(type);
  }

  if (debt.kind === 'owe') {
    return ['expense', 'repay', 'debt_out'].includes(type);
  }

  return false;
}

function findBadOrigin(debt, linkedTransactions) {
  const txs = Array.isArray(linkedTransactions) ? linkedTransactions : [];
  const activeTxs = txs.filter(tx => !isTransactionReversed(tx));

  const out = {
    bad_type: null,
    bad_amount: null
  };

  for (const tx of activeTxs) {
    const notes = String(tx.notes || '').toUpperCase();
    const isExplicitOrigin = notes.includes('[DEBT_ORIGIN]') || notes.includes('[DEBT_ORIGIN_REPAIR]');

    if (!isExplicitOrigin) continue;

    const type = String(tx.type || '').toLowerCase();
    const amount = Number(tx.amount || 0);
    const expectedAmount = Number(debt.original_amount || 0);

    const validType = debt.kind === 'owed'
      ? ['expense', 'debt_out'].includes(type)
      : ['income', 'borrow', 'debt_in'].includes(type);

    if (!validType) {
      out.bad_type = {
        debt_id: debt.id,
        name: debt.name,
        kind: debt.kind,
        transaction_id: tx.id,
        transaction_type: tx.type,
        expected: debt.kind === 'owed' ? 'expense/debt_out' : 'income/borrow/debt_in'
      };
    }

    if (Math.abs(amount - expectedAmount) >= 0.01) {
      out.bad_amount = {
        debt_id: debt.id,
        name: debt.name,
        kind: debt.kind,
        transaction_id: tx.id,
        transaction_amount: amount,
        expected_amount: expectedAmount
      };
    }
  }

  return out;
}

function normalizeDebt(row) {
  const original = Number(row?.original_amount || 0);
  const paid = Number(row?.paid_amount || 0);

  return {
    id: String(row?.id || ''),
    name: String(row?.name || row?.id || ''),
    kind: normalizeKind(row?.kind) || 'owe',
    original_amount: original,
    paid_amount: paid,
    remaining_amount: Math.max(0, original - paid),
    status: String(row?.status || 'active').toLowerCase(),
    notes: String(row?.notes || '')
  };
}

function normalizeKind(value) {
  const raw = String(value || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'borrowed'].includes(raw)) return 'owe';
  if (['owed', 'owed_to_me', 'owed_me', 'to_me', 'receivable'].includes(raw)) return 'owed';

  return null;
}

function sanitizeTransaction(tx) {
  return {
    id: tx.id,
    date: tx.date || null,
    type: tx.type || null,
    amount: tx.amount == null ? null : Number(tx.amount),
    account_id: tx.account_id || null,
    category_id: tx.category_id || null,
    notes: tx.notes || '',
    created_at: tx.created_at || null,
    reversed_by: tx.reversed_by || null,
    reversed_at: tx.reversed_at || null
  };
}

function extractDebtId(notes) {
  const match = String(notes || '').match(/debt_id=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

function moneyToPaisa(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function chunks(values, size) {
  const out = [];

  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }

  return out;
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