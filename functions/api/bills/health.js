/* Sovereign Finance Bills Health API
 * /api/bills/health
 * v1.2.0-bills-health-contract-aligned
 *
 * B1 purpose:
 * - Align health output with js/bills.js expectations.
 * - Detect bill payment integrity issues.
 * - Detect active bill payments linked to reversed ledger transactions.
 * - Detect orphan bill payments without valid ledger transactions.
 * - Detect duplicate bill payments for same bill/month/amount/account.
 * - Detect payment amount mismatches between bill_payments and transactions.
 * - Read-only: does not mutate bills, bill_payments, ledger, accounts, or forecast.
 */

const VERSION = 'v1.2.0-bills-health-contract-aligned';

export async function onRequestGet(context) {
  const checkedAt = new Date().toISOString();

  try {
    const db = context.env.DB;

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        checked_at: checkedAt,
        status: 'fail',
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        },
        ...emptyHealth()
      }, 500);
    }

    const tableState = {
      bills: await tableExists(db, 'bills'),
      bill_payments: await tableExists(db, 'bill_payments'),
      transactions: await tableExists(db, 'transactions')
    };

    if (!tableState.bill_payments.exists) {
      return json({
        ok: true,
        version: VERSION,
        checked_at: checkedAt,
        status: 'warn',
        health: {
          status: 'warn',
          reason: 'bill_payments table missing',
          table_state: tableState
        },
        ...emptyHealth(),
        rules: rules()
      });
    }

    const billCols = tableState.bills.exists ? await tableColumns(db, 'bills') : new Set();
    const paymentCols = await tableColumns(db, 'bill_payments');
    const txnCols = tableState.transactions.exists ? await tableColumns(db, 'transactions') : new Set();

    const payments = await loadPayments(db, paymentCols);
    const txnsById = await loadTransactionsById(db, txnCols);
    const billsById = tableState.bills.exists
      ? await loadBillsById(db, billCols)
      : new Map();

    const diagnostics = buildDiagnostics({
      payments,
      txnsById,
      billsById,
      paymentCols,
      txnCols
    });

    const status = diagnostics.active_payment_reversed_txn_mismatch.length ||
      diagnostics.missing_reversal_txn.length ||
      diagnostics.orphans.length ||
      diagnostics.amount_mismatches.length ||
      diagnostics.duplicate_bill_month_amount.length
        ? 'warn'
        : 'pass';

    return json({
      ok: true,
      version: VERSION,
      checked_at: checkedAt,
      status,

      /*
       * Frontend-aligned fields expected by js/bills.js.
       */
      payment_rows: payments.length,
      orphans: diagnostics.orphans,
      active_payment_reversed_txn_mismatch: diagnostics.active_payment_reversed_txn_mismatch,
      missing_reversal_txn: diagnostics.missing_reversal_txn,
      duplicate_bill_month_amount: diagnostics.duplicate_bill_month_amount,
      amount_mismatches: diagnostics.amount_mismatches,

      /*
       * Rich nested health object for humans and future Hub aggregation.
       */
      health: {
        status,
        payment_rows: payments.length,
        orphan_count: diagnostics.orphans.length,
        active_payment_reversed_txn_mismatch_count: diagnostics.active_payment_reversed_txn_mismatch.length,
        missing_reversal_txn_count: diagnostics.missing_reversal_txn.length,
        duplicate_bill_month_amount_count: diagnostics.duplicate_bill_month_amount.length,
        amount_mismatch_count: diagnostics.amount_mismatches.length,
        table_state: tableState,
        columns: {
          bills: Array.from(billCols),
          bill_payments: Array.from(paymentCols),
          transactions: Array.from(txnCols)
        }
      },

      /*
       * Backward-compatible aliases for older displays/tools.
       */
      payment_count: payments.length,
      orphan_payments_without_transaction: diagnostics.orphans,
      payments_with_reversed_transaction_but_active_payment: diagnostics.active_payment_reversed_txn_mismatch,
      reversed_payments_without_reversal_transaction: diagnostics.missing_reversal_txn,
      duplicate_payments_same_month: diagnostics.duplicate_bill_month_amount,
      payment_amount_mismatches: diagnostics.amount_mismatches,

      rules: rules()
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      checked_at: checkedAt,
      status: 'fail',
      error: {
        code: 'BILLS_HEALTH_FAILED',
        message: err.message || String(err)
      },
      stack: String(err && err.stack ? err.stack : '')
        .split('\n')
        .slice(0, 6)
        .join('\n'),
      ...emptyHealth()
    }, 500);
  }
}

/* ─────────────────────────────
 * Loaders
 * ───────────────────────────── */

async function loadPayments(db, cols) {
  const select = [
    cols.has('id') ? 'id' : 'rowid AS id',
    col(cols, 'bill_id'),
    firstExisting(cols, ['bill_month', 'month', 'cycle_month'], 'bill_month'),
    firstExisting(cols, ['amount', 'paid_amount'], 'amount'),
    firstExisting(cols, ['amount_paisa', 'paid_amount_paisa'], 'amount_paisa'),
    firstExisting(cols, ['status'], 'status'),
    firstExisting(cols, ['transaction_id', 'txn_id', 'ledger_transaction_id'], 'transaction_id'),
    firstExisting(cols, ['account_id'], 'account_id'),
    firstExisting(cols, ['paid_date', 'payment_date', 'date'], 'paid_date'),
    firstExisting(cols, ['created_at'], 'created_at'),
    firstExisting(cols, ['reversed_at'], 'reversed_at'),
    firstExisting(cols, ['reversal_transaction_id', 'reversed_by'], 'reversal_transaction_id'),
    firstExisting(cols, ['notes'], 'notes')
  ].filter(Boolean);

  const orderBy = cols.has('created_at')
    ? 'datetime(created_at) DESC'
    : cols.has('paid_date')
      ? 'paid_date DESC'
      : cols.has('payment_date')
        ? 'payment_date DESC'
        : 'id DESC';

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bill_payments
     ORDER BY ${orderBy}`
  ).all();

  return (res.results || []).map(normalizePayment);
}

async function loadTransactionsById(db, cols) {
  const map = new Map();

  if (!cols.size || !cols.has('id')) return map;

  const select = [
    'id',
    firstExisting(cols, ['type', 'transaction_type'], 'type'),
    col(cols, 'amount'),
    col(cols, 'account_id'),
    firstExisting(cols, ['category_id', 'category'], 'category_id'),
    firstExisting(cols, ['notes', 'description', 'memo'], 'notes'),
    col(cols, 'created_at'),
    col(cols, 'reversed_by'),
    col(cols, 'reversed_at'),
    firstExisting(cols, ['linked_txn_id', 'linked_transaction_id'], 'linked_txn_id')
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM transactions`
  ).all();

  for (const row of res.results || []) {
    map.set(clean(row.id), normalizeTxn(row));
  }

  return map;
}

async function loadBillsById(db, cols) {
  const map = new Map();

  if (!cols.size || !cols.has('id')) return map;

  const select = [
    'id',
    firstExisting(cols, ['name', 'title'], 'name'),
    firstExisting(cols, ['amount', 'expected_amount'], 'amount'),
    col(cols, 'status'),
    firstExisting(cols, ['account_id', 'default_account_id'], 'account_id'),
    col(cols, 'category_id')
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bills`
  ).all();

  for (const row of res.results || []) {
    map.set(clean(row.id), row);
  }

  return map;
}

/* ─────────────────────────────
 * Diagnostics
 * ───────────────────────────── */

function buildDiagnostics(input) {
  const { payments, txnsById, billsById } = input;

  const orphans = [];
  const activeReversed = [];
  const missingReversalTxn = [];
  const amountMismatches = [];
  const duplicateMap = new Map();

  for (const payment of payments) {
    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
    const activePayment = isActivePayment(payment);
    const reversedPayment = isReversedPayment(payment);
    const linkedTxnReversed = tx ? isReversedTxn(tx) : false;

    if (activePayment && (!payment.transaction_id || !tx)) {
      orphans.push(formatPaymentIssue(payment, tx, billsById, {
        reason: !payment.transaction_id ? 'missing_transaction_id' : 'transaction_not_found'
      }));
    }

    if (activePayment && tx && linkedTxnReversed) {
      activeReversed.push(formatPaymentIssue(payment, tx, billsById, {
        reason: 'active_payment_linked_to_reversed_transaction'
      }));
    }

    if (reversedPayment && payment.reversal_transaction_id) {
      const reversalTxn = txnsById.get(payment.reversal_transaction_id);

      if (!reversalTxn) {
        missingReversalTxn.push(formatPaymentIssue(payment, tx, billsById, {
          reason: 'reversal_transaction_not_found',
          reversal_transaction_id: payment.reversal_transaction_id
        }));
      }
    }

    if (activePayment && tx) {
      const paymentAmount = amountFromPayment(payment);
      const txnAmount = money(tx.amount);

      if (
        paymentAmount != null &&
        txnAmount != null &&
        Math.abs(Math.abs(paymentAmount) - Math.abs(txnAmount)) > 0.009
      ) {
        amountMismatches.push(formatPaymentIssue(payment, tx, billsById, {
          reason: 'payment_amount_does_not_match_transaction_amount',
          payment_amount: paymentAmount,
          transaction_amount: txnAmount
        }));
      }
    }

    if (activePayment) {
      const duplicateKey = [
        payment.bill_id || 'unknown_bill',
        payment.bill_month || payment.paid_date || 'unknown_month',
        amountFromPayment(payment) == null ? 'unknown_amount' : amountFromPayment(payment),
        payment.account_id || 'unknown_account'
      ].join('|');

      if (!duplicateMap.has(duplicateKey)) duplicateMap.set(duplicateKey, []);
      duplicateMap.get(duplicateKey).push(payment);
    }
  }

  const duplicate_bill_month_amount = [];

  for (const [key, rows] of duplicateMap.entries()) {
    if (rows.length <= 1) continue;

    duplicate_bill_month_amount.push({
      key,
      count: rows.length,
      bill_id: rows[0].bill_id || null,
      bill_month: rows[0].bill_month || null,
      amount: amountFromPayment(rows[0]),
      account_id: rows[0].account_id || null,
      payment_ids: rows.map(row => row.id),
      transaction_ids: rows.map(row => row.transaction_id).filter(Boolean)
    });
  }

  return {
    orphans,
    active_payment_reversed_txn_mismatch: activeReversed,
    missing_reversal_txn: missingReversalTxn,
    duplicate_bill_month_amount,
    amount_mismatches: amountMismatches
  };
}

function formatPaymentIssue(payment, tx, billsById, extra) {
  const bill = payment.bill_id ? billsById.get(payment.bill_id) : null;

  return {
    payment_id: payment.id || null,
    bill_id: payment.bill_id || null,
    bill_name: bill ? bill.name || bill.title || null : null,
    bill_month: payment.bill_month || null,
    amount: amountFromPayment(payment),
    amount_paisa: payment.amount_paisa == null ? null : Number(payment.amount_paisa),
    account_id: payment.account_id || null,
    paid_date: payment.paid_date || null,
    payment_status: payment.status || null,
    transaction_id: payment.transaction_id || null,
    transaction_type: tx ? tx.type || null : null,
    transaction_amount: tx ? money(tx.amount) : null,
    transaction_reversed_by: tx ? tx.reversed_by || null : null,
    transaction_reversed_at: tx ? tx.reversed_at || null : null,
    reversal_transaction_id: payment.reversal_transaction_id || null,
    ...extra
  };
}

/* ─────────────────────────────
 * Normalizers
 * ───────────────────────────── */

function normalizePayment(row) {
  return {
    id: clean(row.id),
    bill_id: clean(row.bill_id),
    bill_month: clean(row.bill_month),
    amount: row.amount == null ? null : money(row.amount),
    amount_paisa: row.amount_paisa == null ? null : Number(row.amount_paisa),
    status: clean(row.status).toLowerCase(),
    transaction_id: clean(row.transaction_id),
    account_id: clean(row.account_id),
    paid_date: clean(row.paid_date),
    created_at: clean(row.created_at),
    reversed_at: clean(row.reversed_at),
    reversal_transaction_id: clean(row.reversal_transaction_id),
    notes: clean(row.notes)
  };
}

function normalizeTxn(row) {
  return {
    id: clean(row.id),
    type: clean(row.type).toLowerCase(),
    amount: row.amount == null ? null : money(row.amount),
    account_id: clean(row.account_id),
    category_id: clean(row.category_id),
    notes: clean(row.notes),
    created_at: clean(row.created_at),
    reversed_by: clean(row.reversed_by),
    reversed_at: clean(row.reversed_at),
    linked_txn_id: clean(row.linked_txn_id)
  };
}

/* ─────────────────────────────
 * Rules
 * ───────────────────────────── */

function isActivePayment(payment) {
  const status = clean(payment.status).toLowerCase();

  return (
    status === '' ||
    status === 'paid' ||
    status === 'active' ||
    status === 'posted'
  );
}

function isReversedPayment(payment) {
  const status = clean(payment.status).toLowerCase();
  const notes = clean(payment.notes).toUpperCase();

  return Boolean(
    status === 'reversed' ||
    status === 'voided' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    payment.reversed_at ||
    payment.reversal_transaction_id ||
    notes.includes('[REVERSED') ||
    notes.includes('[REVERSAL')
  );
}

function isReversedTxn(tx) {
  const notes = clean(tx.notes).toUpperCase();

  return Boolean(
    tx.reversed_by ||
    tx.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function amountFromPayment(payment) {
  if (payment.amount != null) return money(payment.amount);
  if (payment.amount_paisa != null && Number.isFinite(Number(payment.amount_paisa))) {
    return Math.round(Number(payment.amount_paisa)) / 100;
  }

  return null;
}

function rules() {
  return {
    read_only: true,
    frontend_contract_aligned: true,
    expected_frontend_fields: [
      'status',
      'payment_rows',
      'orphans',
      'active_payment_reversed_txn_mismatch',
      'missing_reversal_txn',
      'duplicate_bill_month_amount',
      'amount_mismatches'
    ],
    active_payment_statuses: ['', 'paid', 'active', 'posted'],
    reversed_payment_statuses: ['reversed', 'voided', 'cancelled', 'canceled'],
    ledger_reversal_markers: ['reversed_by', 'reversed_at', '[REVERSAL OF ...]', '[REVERSED BY ...]'],
    bill_payment_rule: 'A bill payment linked to a reversed ledger transaction cannot remain active.',
    bill_health_rule: 'Health warns on orphans, reversed ledger mismatches, missing reversal txns, duplicates, and amount mismatches.'
  };
}

function emptyHealth() {
  return {
    payment_rows: 0,
    orphans: [],
    active_payment_reversed_txn_mismatch: [],
    missing_reversal_txn: [],
    duplicate_bill_month_amount: [],
    amount_mismatches: [],
    payment_count: 0,
    orphan_payments_without_transaction: [],
    payments_with_reversed_transaction_but_active_payment: [],
    reversed_payments_without_reversal_transaction: [],
    duplicate_payments_same_month: [],
    payment_amount_mismatches: []
  };
}

/* ─────────────────────────────
 * DB / SQL helpers
 * ───────────────────────────── */

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(tableName).first();

    return {
      exists: Boolean(row && row.name),
      name: tableName
    };
  } catch (err) {
    return {
      exists: false,
      name: tableName,
      error: err.message || String(err)
    };
  }
}

async function tableColumns(db, tableName) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((result.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function col(cols, name) {
  return cols.has(name) ? name : null;
}

function firstExisting(cols, names, alias) {
  for (const name of names) {
    if (cols.has(name)) {
      return alias && alias !== name ? `${name} AS ${alias}` : name;
    }
  }

  return `NULL AS ${alias}`;
}

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function money(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  if (!Number.isFinite(n)) return null;

  return Math.round(n * 100) / 100;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
