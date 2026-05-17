/* Sovereign Finance · Transactions API · POST /api/transactions/reverse
 * v0.5.0-debt-origin-reversal-integrity
 *
 * Delta vs v0.4.0:
 *   - NEW: repairDebtOriginForReversedTransaction()
 *       When a transaction carrying [DEBT_ORIGIN] or [DEBT_ORIGIN_REPAIR] marker
 *       is reversed, the linked debt is reverted:
 *         - cached paid_amount recalculated from active debt_payments
 *         - status flipped to 'archived' with audit note appended
 *         - if no other active origin tx exists for that debt
 *       The reverse routes already revert money + ledger; this closes the
 *       last gap where the debts row was left orphaned as "active".
 *   - reverseSingle + reverseLinkedPair call the new function alongside
 *     existing debt_payment + bill_payment repair hooks.
 *   - Response gains debt_origin_repair field.
 *   - No SQL / route / money-logic changes elsewhere.
 */

const VERSION = 'v0.5.0-debt-origin-reversal-integrity';

export async function onRequestPost(context) {
  try {
    const db = database(context.env);
    if (!db) return json(errorPayload('DB_BINDING_MISSING', 'D1 binding DB is missing.'), 500);

    const body = await readJson(context.request);
    const dryRun = isDryRun(body);
    const txId = clean(body.transaction_id || body.id || body.txn_id);
    if (!txId) return json(errorPayload('TRANSACTION_ID_REQUIRED', 'transaction_id is required.'), 400);

    const cols = await tableColumns(db, 'transactions');
    if (!cols.size) return json(errorPayload('TRANSACTIONS_TABLE_MISSING', 'transactions table is missing.'), 500);

    const original = await findTransaction(db, txId);
    if (!original) return json(errorPayload('TRANSACTION_NOT_FOUND', `Transaction not found: ${txId}`), 404);

    const reasonGuard = preReverseGuard(original);
    if (reasonGuard) return json(errorPayload(reasonGuard.code, reasonGuard.message), 409);

    if (isLinkedPair(original)) {
      return reverseLinkedPair(db, original, body, dryRun);
    }
    return reverseSingle(db, original, body, dryRun);
  } catch (err) {
    return json(errorPayloadFromException('REVERSE_FAILED', err), 500);
  }
}

/* ─────────────────────────────
 * Single-tx reverse path
 * ───────────────────────────── */

async function reverseSingle(db, original, body, dryRun) {
  const cols = await tableColumns(db, 'transactions');
  const reversalId = clean(body.reversal_id) || makeId('tx_reversal');
  const reversalDate = normalizeDate(body.date) || todayISO();
  const reason = clean(body.reason || body.notes);
  const createdAt = nowSql();
  const reversalAmount = Number(original.amount || 0);
  const reversalType = inverseType(original.type);
  const reversalAccount = original.account_id;

  if (!reversalType) {
    return json(errorPayload('UNSUPPORTED_TYPE', `Cannot infer reversal type for: ${original.type}`), 400);
  }

  const reversal = {
    id: reversalId,
    date: reversalDate,
    type: reversalType,
    transaction_type: reversalType,
    amount: reversalAmount,
    account_id: reversalAccount,
    category_id: original.category_id,
    notes: buildReversalNote(original, reason),
    description: `Reversal of ${original.id}`,
    memo: `Reversal of ${original.id}`,
    fee_amount: 0,
    pra_amount: 0,
    created_at: createdAt,
    updated_at: createdAt,
    reversed_by: null,
    reversed_at: null,
    linked_txn_id: original.id,
    status: 'active'
  };

  if (dryRun) {
    return json({
      ok: true, version: VERSION, action: 'transaction.reverse.dry_run',
      dry_run: true, writes_performed: false,
      original, reversal,
      rule: 'Single reverse: inserts inverse-type tx and marks original reversed.'
    });
  }

  const insertStmt = prepareInsert(db, 'transactions', cols, reversal);
  const markStmt = prepareUpdate(db, 'transactions', cols, {
    reversed_by: reversalId,
    reversed_at: nowIso(),
    updated_at: createdAt,
    status: 'reversed'
  }, 'id = ?', [original.id]);

  const batch = [insertStmt];
  if (markStmt) batch.push(markStmt);
  await db.batch(batch);

  // ─── REPAIR HOOKS (cascading domain integrity) ───
  const billRepair = await safeRepair(() => repairBillPaymentForReversedTransaction(db, original, reversalId));
  const debtPaymentRepair = await safeRepair(() => repairDebtPaymentForReversedTransaction(db, original, reversalId));
  const debtOriginRepair = await safeRepair(() => repairDebtOriginForReversedTransaction(db, original, reversalId));

  return json({
    ok: true, version: VERSION, action: 'transaction.reverse',
    writes_performed: true,
    original_id: original.id, reversal_id: reversalId,
    reversal,
    bill_payment_repair: billRepair,
    debt_payment_repair: debtPaymentRepair,
    debt_origin_repair: debtOriginRepair,
    rule: 'Single transaction reversed. Domain repair hooks attempted for bills, debt payments, and debt origins.'
  });
}

/* ─────────────────────────────
 * Linked-pair reverse path
 * ───────────────────────────── */

async function reverseLinkedPair(db, original, body, dryRun) {
  const cols = await tableColumns(db, 'transactions');
  const partner = await findTransaction(db, original.linked_txn_id);

  if (!partner) {
    return reverseSingle(db, original, body, dryRun);
  }
  const partnerGuard = preReverseGuard(partner);
  if (partnerGuard) {
    return json(errorPayload(partnerGuard.code, `Linked partner not reversible: ${partnerGuard.message}`), 409);
  }

  const createdAt = nowSql();
  const reversalDate = normalizeDate(body.date) || todayISO();
  const reason = clean(body.reason || body.notes);
  const reversalAId = clean(body.reversal_a_id) || makeId('tx_reversal_a');
  const reversalBId = clean(body.reversal_b_id) || makeId('tx_reversal_b');

  const reversalA = buildPartnerReversal(original, reversalAId, reversalDate, createdAt, reason);
  const reversalB = buildPartnerReversal(partner, reversalBId, reversalDate, createdAt, reason);

  if (dryRun) {
    return json({
      ok: true, version: VERSION, action: 'transaction.reverse_linked_pair.dry_run',
      dry_run: true, writes_performed: false,
      original, partner, reversal_a: reversalA, reversal_b: reversalB,
      rule: 'Linked-pair reverse: inserts two inverse rows and marks both originals reversed.'
    });
  }

  const batch = [
    prepareInsert(db, 'transactions', cols, reversalA),
    prepareInsert(db, 'transactions', cols, reversalB),
    prepareUpdate(db, 'transactions', cols, { reversed_by: reversalAId, reversed_at: nowIso(), updated_at: createdAt, status: 'reversed' }, 'id = ?', [original.id]),
    prepareUpdate(db, 'transactions', cols, { reversed_by: reversalBId, reversed_at: nowIso(), updated_at: createdAt, status: 'reversed' }, 'id = ?', [partner.id])
  ].filter(Boolean);
  await db.batch(batch);

  // Repair hooks on both halves
  const billRepairA = await safeRepair(() => repairBillPaymentForReversedTransaction(db, original, reversalAId));
  const billRepairB = await safeRepair(() => repairBillPaymentForReversedTransaction(db, partner, reversalBId));
  const debtPayRepairA = await safeRepair(() => repairDebtPaymentForReversedTransaction(db, original, reversalAId));
  const debtPayRepairB = await safeRepair(() => repairDebtPaymentForReversedTransaction(db, partner, reversalBId));
  const debtOriginRepairA = await safeRepair(() => repairDebtOriginForReversedTransaction(db, original, reversalAId));
  const debtOriginRepairB = await safeRepair(() => repairDebtOriginForReversedTransaction(db, partner, reversalBId));

  return json({
    ok: true, version: VERSION, action: 'transaction.reverse_linked_pair',
    writes_performed: true,
    original_id: original.id, partner_id: partner.id,
    reversal_a_id: reversalAId, reversal_b_id: reversalBId,
    bill_payment_repair: { a: billRepairA, b: billRepairB },
    debt_payment_repair: { a: debtPayRepairA, b: debtPayRepairB },
    debt_origin_repair:  { a: debtOriginRepairA, b: debtOriginRepairB }
  });
}

/* ─────────────────────────────
 * Repair: bill payments (UNCHANGED from v0.4.0)
 * ───────────────────────────── */

async function repairBillPaymentForReversedTransaction(db, original, reversalId) {
  const exists = await tableExists(db, 'bill_payments');
  if (!exists) return { applicable: false, reason: 'bill_payments_table_missing' };

  const cols = await tableColumns(db, 'bill_payments');
  if (!cols.size) return { applicable: false, reason: 'bill_payments_no_columns' };

  const txIdCol = pickColumn(cols, ['transaction_id', 'txn_id', 'ledger_transaction_id']);
  if (!txIdCol) return { applicable: false, reason: 'no_transaction_id_column_in_bill_payments' };

  const row = await db.prepare(`SELECT * FROM bill_payments WHERE TRIM(${txIdCol}) = TRIM(?) LIMIT 1`).bind(original.id).first();
  const markerText = String(original.notes || '').toUpperCase();
  if (!row && !markerText.includes('[BILL_PAYMENT]')) return { applicable: false };
  if (!row) return { applicable: false, reason: 'marker_present_but_no_row' };

  const updates = {};
  if (cols.has('status')) updates.status = 'reversed';
  if (cols.has('reversed_at')) updates.reversed_at = nowIso();
  if (cols.has('reversal_transaction_id')) updates.reversal_transaction_id = reversalId;
  if (cols.has('reversed_by')) updates.reversed_by = reversalId;
  if (cols.has('updated_at')) updates.updated_at = nowSql();
  if (cols.has('notes')) updates.notes = appendNote(row.notes, `Auto-reversed: linked ledger ${original.id} reversed by ${reversalId}.`);

  const stmt = prepareUpdate(db, 'bill_payments', cols, updates, 'id = ?', [row.id]);
  if (stmt) await stmt.run();

  // Bill cached last_paid fields: if this was the last payment, clear them.
  const billCols = await tableColumns(db, 'bills');
  if (billCols.has('last_paid_date') && row.bill_id) {
    const stillActive = await db.prepare(
      `SELECT COUNT(*) AS c FROM bill_payments WHERE bill_id = ? AND COALESCE(status,'paid') NOT IN ('reversed','voided','cancelled')`
    ).bind(row.bill_id).first();
    if (stillActive && Number(stillActive.c) === 0) {
      const clear = {};
      if (billCols.has('last_paid_date')) clear.last_paid_date = null;
      if (billCols.has('last_paid_account_id')) clear.last_paid_account_id = null;
      if (billCols.has('updated_at')) clear.updated_at = nowSql();
      const billStmt = prepareUpdate(db, 'bills', billCols, clear, 'id = ?', [row.bill_id]);
      if (billStmt) await billStmt.run();
    }
  }

  return { applicable: true, payment_id: row.id, bill_id: row.bill_id || null };
}

/* ─────────────────────────────
 * Repair: debt payments (UNCHANGED from v0.4.0)
 * ───────────────────────────── */

async function repairDebtPaymentForReversedTransaction(db, original, reversalId) {
  const exists = await tableExists(db, 'debt_payments');
  if (!exists) return { applicable: false, reason: 'debt_payments_table_missing' };

  const cols = await tableColumns(db, 'debt_payments');
  if (!cols.size) return { applicable: false, reason: 'debt_payments_no_columns' };

  const txIdCol = pickColumn(cols, ['transaction_id', 'txn_id', 'ledger_transaction_id']);
  if (!txIdCol) return { applicable: false, reason: 'no_transaction_id_column_in_debt_payments' };

  const row = await db.prepare(`SELECT * FROM debt_payments WHERE TRIM(${txIdCol}) = TRIM(?) LIMIT 1`).bind(original.id).first();
  const markerText = String(original.notes || '').toUpperCase();
  if (!row && !markerText.includes('[DEBT_PAYMENT]')) return { applicable: false };
  if (!row) return { applicable: false, reason: 'marker_present_but_no_row' };

  const updates = {};
  if (cols.has('status')) updates.status = 'reversed';
  if (cols.has('reversed_at')) updates.reversed_at = nowIso();
  if (cols.has('reversal_transaction_id')) updates.reversal_transaction_id = reversalId;
  if (cols.has('reversed_by')) updates.reversed_by = reversalId;
  if (cols.has('updated_at')) updates.updated_at = nowSql();
  if (cols.has('notes')) updates.notes = appendNote(row.notes, `Auto-reversed: linked ledger ${original.id} reversed by ${reversalId}.`);
  const stmt = prepareUpdate(db, 'debt_payments', cols, updates, 'id = ?', [row.id]);
  if (stmt) await stmt.run();

  // Recalculate cached debt.paid_amount and flip status back to active if needed.
  const debtId = row.debt_id;
  let recalc = null;
  if (debtId) recalc = await recalculateDebtFromPayments(db, debtId);

  return { applicable: true, payment_id: row.id, debt_id: debtId || null, recalc };
}

/* ─────────────────────────────
 * NEW: Repair debt origin (CLOSES THE BUG)
 * ───────────────────────────── */

async function repairDebtOriginForReversedTransaction(db, original, reversalId) {
  const markerText = String(original.notes || '').toUpperCase();
  const isOriginMarker = markerText.includes('[DEBT_ORIGIN]') || markerText.includes('[DEBT_ORIGIN_REPAIR]');
  if (!isOriginMarker) return { applicable: false };

  // Extract debt_id token from notes — same format used by debts/[[path]].js when writing origin txs.
  const m = String(original.notes || '').match(/debt_id=([A-Za-z0-9_\-]+)/);
  const debtId = m ? m[1] : null;
  if (!debtId) return { applicable: false, reason: 'no_debt_id_token_in_notes' };

  const debtsExists = await tableExists(db, 'debts');
  if (!debtsExists) return { applicable: false, reason: 'debts_table_missing' };

  const debtCols = await tableColumns(db, 'debts');
  if (!debtCols.size || !debtCols.has('id')) return { applicable: false, reason: 'debts_no_columns' };

  const debt = await db.prepare(`SELECT * FROM debts WHERE id = ? LIMIT 1`).bind(debtId).first();
  if (!debt) return { applicable: false, reason: 'debt_not_found', debt_id: debtId };

  // Is there ANOTHER active origin tx for this debt? If yes, do not archive — only recalc payments.
  const txCols = await tableColumns(db, 'transactions');
  const otherActiveOriginCount = await countOtherActiveOriginsForDebt(db, txCols, debtId, original.id);

  // Always recalculate paid_amount from surviving active debt_payments.
  const recalc = await recalculateDebtFromPayments(db, debtId);

  if (otherActiveOriginCount > 0) {
    return {
      applicable: true,
      debt_id: debtId,
      action: 'origin_reversed_but_other_origins_exist',
      other_active_origin_count: otherActiveOriginCount,
      recalc
    };
  }

  // No other active origins → revert the debt to a clean archived state.
  const updates = {};
  if (debtCols.has('status')) updates.status = 'archived';
  if (debtCols.has('archived_at')) updates.archived_at = nowIso();
  if (debtCols.has('updated_at')) updates.updated_at = nowSql();
  if (debtCols.has('notes')) {
    updates.notes = appendNote(
      debt.notes,
      `Auto-archived ${nowIso()}: origin ledger tx ${original.id} was reversed by ${reversalId}. Linked debt reverted.`
    );
  }

  const stmt = prepareUpdate(db, 'debts', debtCols, updates, 'id = ?', [debtId]);
  if (stmt) await stmt.run();

  return {
    applicable: true,
    debt_id: debtId,
    action: 'debt_archived_origin_reversed',
    recalc,
    debt_name: debt.name || null,
    original_amount: Number(debt.original_amount || 0)
  };
}

async function countOtherActiveOriginsForDebt(db, txCols, debtId, excludeTxId) {
  if (!txCols || !txCols.size) return 0;
  // Look up txs whose notes contain debt_id=<debtId> AND [DEBT_ORIGIN]/[DEBT_ORIGIN_REPAIR] markers and are NOT reversed.
  // SQLite LIKE is case-insensitive for ASCII; markers are uppercase ASCII.
  try {
    const rows = await db.prepare(
      `SELECT id, notes, reversed_by, reversed_at, status
         FROM transactions
        WHERE id <> ?
          AND notes LIKE ?
          AND (notes LIKE '%[DEBT_ORIGIN]%' OR notes LIKE '%[DEBT_ORIGIN_REPAIR]%')`
    ).bind(excludeTxId, `%debt_id=${debtId}%`).all();
    return (rows.results || []).filter(t => {
      if (t.reversed_by || t.reversed_at) return false;
      if (String(t.status || '').toLowerCase() === 'reversed') return false;
      return true;
    }).length;
  } catch (_) {
    return 0;
  }
}

/* ─────────────────────────────
 * Shared: recalculate debt from payments (UNCHANGED from v0.4.0)
 * ───────────────────────────── */

async function recalculateDebtFromPayments(db, debtId) {
  const debtsExists = await tableExists(db, 'debts');
  const paymentsExists = await tableExists(db, 'debt_payments');
  if (!debtsExists || !paymentsExists) return { ok: false, reason: 'tables_missing' };
  const debtCols = await tableColumns(db, 'debts');
  const paymentCols = await tableColumns(db, 'debt_payments');
  if (!debtCols.size || !paymentCols.size) return { ok: false, reason: 'no_columns' };
  const amountCol = pickColumn(paymentCols, ['amount', 'paid_amount']);
  if (!amountCol) return { ok: false, reason: 'no_amount_column' };

  const sumRow = await db.prepare(
    `SELECT COALESCE(SUM(${amountCol}), 0) AS total
       FROM debt_payments
      WHERE debt_id = ?
        AND COALESCE(status,'paid') NOT IN ('reversed','voided','cancelled','canceled')`
  ).bind(debtId).first();

  const paid = Number((sumRow && sumRow.total) || 0);
  const debt = await db.prepare(`SELECT id, original_amount, status, paid_amount FROM debts WHERE id = ? LIMIT 1`).bind(debtId).first();
  if (!debt) return { ok: false, reason: 'debt_not_found' };

  const original = Number(debt.original_amount || 0);
  const remaining = Math.max(0, round2(original - paid));
  let nextStatus = debt.status;
  if (['archived','settled','deleted'].includes(String(debt.status || '').toLowerCase())) {
    nextStatus = debt.status;
  } else {
    nextStatus = remaining <= 0 ? 'settled' : 'active';
  }

  const updates = {};
  if (debtCols.has('paid_amount')) updates.paid_amount = round2(paid);
  if (debtCols.has('status')) updates.status = nextStatus;
  if (debtCols.has('updated_at')) updates.updated_at = nowSql();
  const stmt = prepareUpdate(db, 'debts', debtCols, updates, 'id = ?', [debtId]);
  if (stmt) await stmt.run();

  return { ok: true, debt_id: debtId, paid_amount: round2(paid), original_amount: original, remaining_amount: remaining, status: nextStatus };
}

/* ─────────────────────────────
 * Helpers (UNCHANGED)
 * ───────────────────────────── */

function preReverseGuard(tx) {
  if (!tx) return { code: 'NOT_FOUND', message: 'Transaction not found.' };
  if (tx.reversed_by || tx.reversed_at) return { code: 'ALREADY_REVERSED', message: 'Transaction is already reversed.' };
  if (String(tx.status || '').toLowerCase() === 'reversed') return { code: 'ALREADY_REVERSED', message: 'Transaction is already reversed.' };
  const notes = String(tx.notes || '').toUpperCase();
  if (notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY ')) {
    return { code: 'REVERSAL_ROW', message: 'Cannot reverse a reversal row.' };
  }
  return null;
}

function inverseType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'expense') return 'income';
  if (t === 'income') return 'expense';
  if (t === 'transfer') return 'transfer';
  return null;
}

function isLinkedPair(tx) {
  if (!tx) return false;
  if (String(tx.type || '').toLowerCase() !== 'transfer') return false;
  return Boolean(tx.linked_txn_id);
}

function buildReversalNote(original, reason) {
  const base = `[REVERSAL OF ${original.id}]`;
  const why = reason ? ` ${reason}` : '';
  return `${base} ${String(original.notes || '').slice(0, 400)}${why}`.slice(0, 1000);
}

function buildPartnerReversal(tx, id, date, createdAt, reason) {
  return {
    id, date,
    type: inverseType(tx.type) || tx.type,
    transaction_type: inverseType(tx.type) || tx.type,
    amount: Number(tx.amount || 0),
    account_id: tx.account_id,
    category_id: tx.category_id,
    notes: buildReversalNote(tx, reason),
    description: `Reversal of ${tx.id}`,
    memo: `Reversal of ${tx.id}`,
    fee_amount: 0, pra_amount: 0,
    created_at: createdAt, updated_at: createdAt,
    reversed_by: null, reversed_at: null,
    linked_txn_id: tx.id,
    status: 'active'
  };
}

async function findTransaction(db, id) {
  const cols = await tableColumns(db, 'transactions');
  if (!cols.size || !cols.has('id')) return null;
  const row = await db.prepare(`SELECT * FROM transactions WHERE id = ? LIMIT 1`).bind(id).first();
  return row || null;
}

async function safeRepair(fn) {
  try {
    return await fn();
  } catch (err) {
    return { applicable: false, error: err && err.message ? err.message : String(err) };
  }
}

function database(env) { return env.DB || env.SOVEREIGN_DB || env.FINANCE_DB; }
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function isDryRun(body) { return body.dry_run === true || body.dry_run === '1' || body.dry_run === 'true'; }
async function tableExists(db, t) {
  try {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").bind(t).first();
    return Boolean(row && row.name);
  } catch { return false; }
}
async function tableColumns(db, t) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${t})`).all();
    return new Set((res.results || []).map(r => r.name).filter(Boolean));
  } catch { return new Set(); }
}
function pickColumn(cols, candidates) { for (const c of candidates) if (cols.has(c)) return c; return null; }
function filterToColumns(row, cols) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (cols.has(k)) out[k] = v;
  return out;
}
function prepareInsert(db, table, cols, row) {
  const f = filterToColumns(row, cols);
  const keys = Object.keys(f);
  if (!keys.length) throw new Error(`${table} has no compatible insert columns.`);
  return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => f[k]));
}
function prepareUpdate(db, table, cols, updates, whereSql, whereValues) {
  const f = filterToColumns(updates, cols);
  const keys = Object.keys(f);
  if (!keys.length) return null;
  return db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE ${whereSql}`).bind(...keys.map(k => f[k]), ...(whereValues || []));
}
function clean(v) { return String(v == null ? '' : v).trim(); }
function round2(v) { const n = Number(v); if (!Number.isFinite(n)) return 0; return Math.round(n * 100) / 100; }
function normalizeDate(v) {
  const r = clean(v); if (!r) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(r)) return r.slice(0, 10);
  const d = new Date(r); if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function nowSql() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function appendNote(existing, addition) {
  const b = clean(existing); const n = clean(addition);
  if (!b) return n; if (!n) return b;
  return `${b} | ${n}`.slice(0, 1000);
}
function makeId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function errorPayload(code, message) { return { ok: false, version: VERSION, error: { code, message } }; }
function errorPayloadFromException(code, err) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : null;
  return { ok: false, version: VERSION, error: { code, message, stack } };
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
