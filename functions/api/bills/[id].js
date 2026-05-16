/* Sovereign Finance Bills Item Route
 * /api/bills/:id
 * v0.8.1-bills-item-route-guard
 *
 * B3 purpose:
 * - Stop stale item route from hijacking reserved Bills engine paths.
 * - Keep /api/bills/:id usable for read/update/delete by actual bill id.
 * - Do NOT own pay/repair/update/defer/history/health/cycle routes.
 * - Do NOT create bill payments here.
 * - Root Bills engine remains the source of truth:
 *   functions/api/bills/[[path]].js
 */

const VERSION = 'v0.8.1-bills-item-route-guard';

const RESERVED_PATHS = new Set([
  'pay',
  'payment',
  'payments',
  'repair',
  'repair-reversed-payments',
  'repair_reversed_payments',
  'update',
  'edit',
  'defer',
  'health',
  'history',
  'cycle',
  'create',
  'add'
]);

export async function onRequestGet(context) {
  try {
    const db = database(context.env);
    const id = getId(context);

    if (isReserved(id)) {
      return reservedRouteResponse(id);
    }

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'D1 binding DB is missing.'
        }
      }, 500);
    }

    const bill = await findBill(db, id);

    if (!bill) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'BILL_NOT_FOUND',
          message: `Bill not found: ${id}`
        }
      }, 404);
    }

    const month = currentMonth();
    const payments = await loadBillPayments(db, bill.id);
    const txnsById = await loadTransactionsById(db);
    const current_cycle = buildCurrentCycle({
      bill,
      month,
      payments,
      txnsById
    });

    return json({
      ok: true,
      version: VERSION,
      route: '/api/bills/:id',
      bill: {
        ...bill,
        current_cycle
      },
      payments: payments.map(payment => {
        const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
        const classified = classifyPayment(payment, tx);

        return {
          ...payment,
          effective_paid: classified.effective_paid,
          ignore_reason: classified.ignore_reason,
          linked_transaction: tx || null
        };
      }),
      contract: {
        item_route_is_read_or_metadata_only: true,
        payment_writes_are_owned_by_root_engine: true,
        root_engine: '/api/bills',
        pay_endpoint: 'POST /api/bills with action=pay or POST /api/bills/pay',
        repair_endpoint: 'POST /api/bills with action=repair',
        reserved_path_guard_enabled: true
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_ITEM_GET_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const id = getId(context);

    if (isReserved(id)) {
      return reservedRouteResponse(id);
    }

    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'ITEM_ROUTE_POST_DISABLED',
        message: 'POST writes are disabled on /api/bills/:id. Use the root Bills engine instead.'
      },
      bill_id: id,
      use_instead: {
        pay: 'POST /api/bills with { action: "pay", bill_id: "<id>", ... }',
        update: 'POST /api/bills with { action: "update", bill_id: "<id>", ... }',
        defer: 'POST /api/bills with { action: "defer", bill_id: "<id>", ... }',
        repair: 'POST /api/bills with { action: "repair" }'
      }
    }, 405);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_ITEM_POST_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = database(context.env);
    const id = getId(context);
    const body = await readJson(context.request);

    if (isReserved(id)) {
      return reservedRouteResponse(id);
    }

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'D1 binding DB is missing.'
        }
      }, 500);
    }

    const bill = await findBill(db, id);

    if (!bill) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'BILL_NOT_FOUND',
          message: `Bill not found: ${id}`
        }
      }, 404);
    }

    const cols = await tableColumns(db, 'bills');
    const updates = buildBillUpdates(body, cols);

    if (!Object.keys(updates).length) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'NO_SUPPORTED_FIELDS',
          message: 'No supported bill fields were supplied.'
        }
      }, 400);
    }

    await updateRow(db, 'bills', cols, updates, 'id = ?', [id]);

    return json({
      ok: true,
      version: VERSION,
      action: 'bill.item.update',
      writes_performed: true,
      bill: await findBill(db, id),
      contract: {
        item_route_update_supported: true,
        payment_writes_are_not_supported_here: true
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_ITEM_PUT_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = database(context.env);
    const id = getId(context);

    if (isReserved(id)) {
      return reservedRouteResponse(id);
    }

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'D1 binding DB is missing.'
        }
      }, 500);
    }

    const bill = await findBill(db, id);

    if (!bill) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'BILL_NOT_FOUND',
          message: `Bill not found: ${id}`
        }
      }, 404);
    }

    const cols = await tableColumns(db, 'bills');
    const updates = {};

    if (cols.has('status')) updates.status = 'deleted';
    if (cols.has('deleted_at')) updates.deleted_at = nowIso();
    if (cols.has('updated_at')) updates.updated_at = nowSql();

    if (!Object.keys(updates).length) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'SOFT_DELETE_UNSUPPORTED',
          message: 'Bills table has no supported soft-delete columns.'
        }
      }, 409);
    }

    await updateRow(db, 'bills', cols, updates, 'id = ?', [id]);

    return json({
      ok: true,
      version: VERSION,
      action: 'bill.item.delete',
      writes_performed: true,
      bill_id: id,
      contract: {
        soft_delete_only: true,
        hard_delete_not_supported: true
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'BILL_ITEM_DELETE_FAILED',
        message: err.message || String(err)
      }
    }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie, Cf-Access-Jwt-Assertion'
    }
  });
}

/* ─────────────────────────────
 * Route guard
 * ───────────────────────────── */

function getId(context) {
  return clean(context.params && context.params.id);
}

function isReserved(id) {
  return RESERVED_PATHS.has(clean(id).toLowerCase());
}

function reservedRouteResponse(id) {
  return json({
    ok: false,
    version: VERSION,
    route: '/api/bills/:id',
    reserved_path: id,
    error: {
      code: 'RESERVED_BILLS_ROUTE',
      message: `"/api/bills/${id}" is a reserved Bills engine path and must not be handled as a bill id.`
    },
    use_instead: {
      overview: 'GET /api/bills',
      health: 'GET /api/bills/health',
      history: 'GET /api/bills/history?bill_id=<id>',
      repair: 'POST /api/bills with { action: "repair" }',
      pay: 'POST /api/bills with { action: "pay", bill_id: "<id>", ... }',
      update: 'POST /api/bills with { action: "update", bill_id: "<id>", ... }',
      defer: 'POST /api/bills with { action: "defer", bill_id: "<id>", ... }'
    },
    contract: {
      route_hijack_guard: true,
      root_engine_owns_reserved_paths: true,
      root_engine_file: 'functions/api/bills/[[path]].js'
    }
  }, 409);
}

/* ─────────────────────────────
 * Bill read/update
 * ───────────────────────────── */

async function findBill(db, id) {
  const cols = await tableColumns(db, 'bills');

  if (!cols.size || !cols.has('id')) return null;

  const select = [
    'id',
    firstExisting(cols, ['name', 'title'], 'name'),
    firstExisting(cols, ['amount', 'expected_amount'], 'amount'),
    col(cols, 'due_day'),
    col(cols, 'due_date'),
    col(cols, 'frequency'),
    col(cols, 'category_id'),
    firstExisting(cols, ['default_account_id', 'account_id'], 'default_account_id'),
    col(cols, 'last_paid_date'),
    col(cols, 'last_paid_account_id'),
    col(cols, 'status'),
    col(cols, 'deleted_at'),
    col(cols, 'notes'),
    col(cols, 'created_at'),
    col(cols, 'updated_at')
  ].filter(Boolean);

  const row = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bills
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();

  return row ? normalizeBill(row) : null;
}

function buildBillUpdates(body, cols) {
  const updates = {};

  if (body.name !== undefined && cols.has('name')) updates.name = clean(body.name);
  if (body.title !== undefined && cols.has('title')) updates.title = clean(body.title);

  if (body.amount !== undefined) {
    const amount = money(body.amount);
    if (amount != null && amount > 0) {
      if (cols.has('amount')) updates.amount = amount;
      if (cols.has('expected_amount')) updates.expected_amount = amount;
    }
  }

  if (body.expected_amount !== undefined) {
    const amount = money(body.expected_amount);
    if (amount != null && amount > 0) {
      if (cols.has('amount')) updates.amount = amount;
      if (cols.has('expected_amount')) updates.expected_amount = amount;
    }
  }

  if (body.due_day !== undefined && cols.has('due_day')) updates.due_day = normalizeDueDay(body.due_day);
  if (body.due_date !== undefined && cols.has('due_date')) updates.due_date = normalizeDate(body.due_date);
  if (body.frequency !== undefined && cols.has('frequency')) updates.frequency = clean(body.frequency || 'monthly');
  if (body.category_id !== undefined && cols.has('category_id')) updates.category_id = clean(body.category_id);
  if (body.default_account_id !== undefined && cols.has('default_account_id')) updates.default_account_id = clean(body.default_account_id) || null;
  if (body.account_id !== undefined && cols.has('account_id')) updates.account_id = clean(body.account_id) || null;
  if (body.status !== undefined && cols.has('status')) updates.status = clean(body.status || 'active');
  if (body.notes !== undefined && cols.has('notes')) updates.notes = clean(body.notes);
  if (cols.has('updated_at')) updates.updated_at = nowSql();

  return updates;
}

/* ─────────────────────────────
 * Current-cycle read support
 * ───────────────────────────── */

async function loadBillPayments(db, billId) {
  const exists = await tableExists(db, 'bill_payments');
  if (!exists) return [];

  const cols = await tableColumns(db, 'bill_payments');
  if (!cols.size) return [];

  const select = [
    cols.has('id') ? 'id' : 'rowid AS id',
    col(cols, 'bill_id'),
    firstExisting(cols, ['bill_month', 'month', 'cycle_month'], 'bill_month'),
    firstExisting(cols, ['amount', 'paid_amount'], 'amount'),
    firstExisting(cols, ['amount_paisa', 'paid_amount_paisa'], 'amount_paisa'),
    col(cols, 'account_id'),
    col(cols, 'category_id'),
    firstExisting(cols, ['paid_date', 'payment_date', 'date'], 'paid_date'),
    firstExisting(cols, ['transaction_id', 'txn_id', 'ledger_transaction_id'], 'transaction_id'),
    col(cols, 'status'),
    col(cols, 'reversed_at'),
    firstExisting(cols, ['reversal_transaction_id', 'reversed_by'], 'reversal_transaction_id'),
    col(cols, 'notes'),
    col(cols, 'created_at'),
    col(cols, 'updated_at')
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM bill_payments
     WHERE bill_id = ?
     ORDER BY ${cols.has('created_at') ? 'datetime(created_at) DESC' : 'id DESC'}`
  ).bind(billId).all();

  return (res.results || []).map(normalizePayment);
}

async function loadTransactionsById(db) {
  const exists = await tableExists(db, 'transactions');
  const map = new Map();

  if (!exists) return map;

  const cols = await tableColumns(db, 'transactions');
  if (!cols.size || !cols.has('id')) return map;

  const select = [
    'id',
    firstExisting(cols, ['type', 'transaction_type'], 'type'),
    col(cols, 'amount'),
    col(cols, 'account_id'),
    col(cols, 'category_id'),
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
    const tx = normalizeTxn(row);
    map.set(tx.id, tx);
  }

  return map;
}

function buildCurrentCycle(input) {
  const { bill, month, payments, txnsById } = input;
  const amount = bill.amount;
  const billPayments = payments.filter(payment => {
    const paymentMonth = payment.bill_month || monthFromDate(payment.paid_date);
    return paymentMonth === month;
  });

  const activePayments = [];
  const ignoredPayments = [];

  for (const payment of billPayments) {
    const tx = payment.transaction_id ? txnsById.get(payment.transaction_id) : null;
    const classified = classifyPayment(payment, tx);
    const decorated = {
      ...payment,
      effective_paid: classified.effective_paid,
      ignore_reason: classified.ignore_reason,
      linked_transaction: tx || null
    };

    if (classified.effective_paid) activePayments.push(decorated);
    else ignoredPayments.push(decorated);
  }

  const paidAmount = round2(activePayments.reduce((sum, payment) => {
    return sum + Number(payment.amount || 0);
  }, 0));

  const remainingAmount = round2(Math.max(0, amount - paidAmount));
  const status = remainingAmount <= 0
    ? 'paid'
    : paidAmount > 0
      ? 'partial'
      : 'unpaid';

  return {
    month,
    amount,
    paid_amount: paidAmount,
    remaining_amount: remainingAmount,
    status,
    payments: activePayments,
    ignored_payments: ignoredPayments,
    effective_payment_count: activePayments.length,
    ignored_payment_count: ignoredPayments.length,
    due_day: bill.due_day,
    due_date: dueDateForMonth(month, bill.due_day)
  };
}

function classifyPayment(payment, tx) {
  const status = clean(payment.status).toLowerCase();
  const notes = clean(payment.notes).toUpperCase();

  if (status === 'reversed' || status === 'voided' || status === 'cancelled' || status === 'canceled') {
    return { effective_paid: false, ignore_reason: 'payment_status_reversed' };
  }

  if (payment.reversed_at || payment.reversal_transaction_id) {
    return { effective_paid: false, ignore_reason: 'payment_marked_reversed' };
  }

  if (notes.includes('[REVERSED') || notes.includes('[REVERSAL')) {
    return { effective_paid: false, ignore_reason: 'payment_notes_reversal_marker' };
  }

  if (!payment.transaction_id) {
    return { effective_paid: false, ignore_reason: 'missing_transaction_id' };
  }

  if (!tx) {
    return { effective_paid: false, ignore_reason: 'transaction_not_found' };
  }

  if (isReversedTxn(tx)) {
    return { effective_paid: false, ignore_reason: 'linked_transaction_reversed' };
  }

  return { effective_paid: true, ignore_reason: null };
}

/* ─────────────────────────────
 * Normalizers
 * ───────────────────────────── */

function normalizeBill(row) {
  return {
    id: clean(row.id),
    name: clean(row.name),
    amount: money(row.amount) || 0,
    due_day: normalizeDueDay(row.due_day),
    due_date: normalizeDate(row.due_date),
    frequency: clean(row.frequency || 'monthly') || 'monthly',
    category_id: clean(row.category_id),
    default_account_id: clean(row.default_account_id),
    last_paid_date: normalizeDate(row.last_paid_date),
    last_paid_account_id: clean(row.last_paid_account_id),
    status: clean(row.status || 'active') || 'active',
    deleted_at: clean(row.deleted_at),
    notes: clean(row.notes),
    created_at: clean(row.created_at),
    updated_at: clean(row.updated_at)
  };
}

function normalizePayment(row) {
  const amount = row.amount == null
    ? row.amount_paisa == null
      ? null
      : Number(row.amount_paisa) / 100
    : money(row.amount);

  return {
    id: clean(row.id),
    bill_id: clean(row.bill_id),
    bill_month: clean(row.bill_month),
    amount: amount == null ? 0 : round2(amount),
    amount_paisa: row.amount_paisa == null ? null : Number(row.amount_paisa),
    account_id: clean(row.account_id),
    category_id: clean(row.category_id),
    paid_date: normalizeDate(row.paid_date),
    transaction_id: clean(row.transaction_id),
    status: clean(row.status || 'paid') || 'paid',
    reversed_at: clean(row.reversed_at),
    reversal_transaction_id: clean(row.reversal_transaction_id),
    notes: clean(row.notes),
    created_at: clean(row.created_at),
    updated_at: clean(row.updated_at)
  };
}

function normalizeTxn(row) {
  return {
    id: clean(row.id),
    type: clean(row.type).toLowerCase(),
    amount: money(row.amount) || 0,
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
 * Helpers
 * ───────────────────────────── */

function database(env) {
  return env.DB || env.SOVEREIGN_DB || env.FINANCE_DB;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).bind(tableName).first();

    return Boolean(row && row.name);
  } catch {
    return false;
  }
}

async function tableColumns(db, tableName) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
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

function filterToColumns(row, cols) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function prepareUpdate(db, table, cols, updates, whereSql, whereValues) {
  const filtered = filterToColumns(updates, cols);
  const keys = Object.keys(filtered);

  if (!keys.length) return null;

  return db.prepare(
    `UPDATE ${table}
     SET ${keys.map(key => `${key} = ?`).join(', ')}
     WHERE ${whereSql}`
  ).bind(...keys.map(key => filtered[key]), ...(whereValues || []));
}

async function updateRow(db, table, cols, updates, whereSql, whereValues) {
  const stmt = prepareUpdate(db, table, cols, updates, whereSql, whereValues);
  if (!stmt) return null;

  return stmt.run();
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

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function money(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  if (!Number.isFinite(n)) return null;

  return round2(n);
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return '';

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';

  return d.toISOString().slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 31) return null;

  return Math.floor(n);
}

function monthFromDate(value) {
  const date = normalizeDate(value);
  return date ? date.slice(0, 7) : currentMonth();
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function nowIso() {
  return new Date().toISOString();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function dueDateForMonth(month, dueDay) {
  const m = /^\d{4}-\d{2}$/.test(clean(month)) ? clean(month) : currentMonth();
  const day = normalizeDueDay(dueDay);

  if (!day) return '';

  const [yearText, monthText] = m.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, maxDay);

  return `${m}-${String(safeDay).padStart(2, '0')}`;
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
