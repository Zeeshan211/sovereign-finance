const VERSION = "v0.6.0-bills-money-truth-item";

export async function onRequestGet({ env, params }) {
  try {
    const db = requireDb(env);
    await ensureBillPayments(db);
    const id = requireText(params.id, "id");
    const month = currentMonth();
    const bill = await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
    if (!bill) return json({ ok: false, version: VERSION, error: "Bill not found." }, 404);
    const payments = await getBillPaymentsForMonth(db, month);
    return json({ ok: true, version: VERSION, bill: normalizeBill(bill, payments, month) });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPut({ env, params, request }) {
  return onRequestPost({ env, params, request });
}

export async function onRequestPost({ env, params, request }) {
  try {
    const db = requireDb(env);
    await ensureBillPayments(db);
    const id = requireText(params.id, "id");
    const body = await request.json();
    const action = String(body.action || "update").toLowerCase();

    if (["pay", "paid"].includes(action)) return json({ ok: true, version: VERSION, ...(await payBill(db, id, body)) });
    if (action === "defer") return json({ ok: true, version: VERSION, ...(await deferBill(db, id, body)) });

    return json({ ok: false, version: VERSION, error: "Use /api/bills for create/update/archive/reactivate in Shipment 4." }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

const BILL_CATEGORY = "bills_utilities";

async function payBill(db, id, body) {
  const bill = await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!bill) throw new Error("Bill not found.");
  if (["archived", "deleted"].includes(String(bill.status || "active").toLowerCase())) throw new Error("Archived or deleted bills cannot be paid.");

  const amount = requirePositiveNumber(body.amount, "amount");
  const accountId = requireText(body.account_id, "account_id");
  const paymentDate = requireText(body.date || body.payment_date, "payment_date");
  const month = cleanText(body.month) || paymentDate.slice(0, 7);
  const notes = cleanText(body.notes);
  const now = new Date().toISOString();

  await requireActiveAccount(db, accountId);
  await requireCategory(db, BILL_CATEGORY);

  const paymentsBefore = await getBillPaymentsForMonth(db, month);
  const billBefore = normalizeBill(bill, paymentsBefore, month);
  if (amount > billBefore.remaining_this_month) throw new Error(`Payment exceeds remaining amount. Remaining is ${billBefore.remaining_this_month}.`);

  const txId = makeId("tx_bill_expense");
  const paymentId = makeId("billpay");
  const billName = bill.name || bill.title || bill.bill_name || id;

  const txNotes = [
    `Bill payment: ${billName}`,
    `bill_id=${id}`,
    `bill_payment_id=${paymentId}`,
    notes ? `notes=${notes}` : null
  ].filter(Boolean).join(" | ");

  const txColumns = await getColumns(db, "transactions");
  const txInsert = buildInsert("transactions", txColumns, {
    id: txId,
    date: paymentDate,
    type: "expense",
    amount,
    account_id: accountId,
    transfer_to_account_id: null,
    category_id: BILL_CATEGORY,
    merchant_id: null,
    notes: txNotes,
    fee_amount: 0,
    pra_amount: 0,
    is_pending_reversal: 0,
    reversal_due_date: null,
    created_at: now,
    reversed_by: null,
    reversed_at: null,
    linked_txn_id: null
  });

  const paymentInsert = db.prepare(`
    INSERT INTO bill_payments
      (id, bill_id, transaction_id, account_id, amount, payment_date, month, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(paymentId, id, txId, accountId, amount, paymentDate, month, notes || null, now);

  await db.batch([db.prepare(txInsert.sql).bind(...txInsert.values), paymentInsert]);

  const paymentsAfter = await getBillPaymentsForMonth(db, month);
  const billAfter = normalizeBill(await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first(), paymentsAfter, month);

  return {
    action: "pay",
    bill: billAfter,
    bill_payment: { id: paymentId, bill_id: id, transaction_id: txId, account_id: accountId, amount, payment_date: paymentDate, month },
    ledger_transaction: { id: txId, type: "expense", amount, account_id: accountId, category_id: BILL_CATEGORY, effect: "decrease_account" },
    proof: {
      account_effect: "decrease_selected_account",
      linked_transaction_id: txId,
      payment_record_id: paymentId,
      month,
      paid_this_month: billAfter.paid_this_month,
      remaining_this_month: billAfter.remaining_this_month,
      current_month_cleared: billAfter.current_month_cleared
    }
  };
}

async function deferBill(db, id, body) {
  const bill = await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
  if (!bill) throw new Error("Bill not found.");

  const columns = await getColumns(db, "bills");
  const nextDate = requireText(body.next_due_date || body.due_date, "next_due_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) throw new Error("next_due_date must be YYYY-MM-DD.");

  const day = Number(nextDate.slice(-2));
  const notes = appendNote(bill.notes || bill.description, body.notes, `Deferred to ${nextDate}`);
  const update = buildUpdate("bills", columns, {
    due_date: nextDate,
    next_due_date: nextDate,
    due_day: Number.isFinite(day) ? day : null,
    notes,
    description: notes,
    updated_at: new Date().toISOString()
  }, "id", id);

  await db.prepare(update.sql).bind(...update.values).run();

  return {
    action: "defer",
    bill: normalizeBill(await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first(), [], currentMonth()),
    ledger_transaction: null,
    proof: { ledger_transaction_created: false, account_effect: "none" }
  };
}

async function ensureBillPayments(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id TEXT PRIMARY KEY,
      bill_id TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      month TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function getBillPaymentsForMonth(db, month) {
  const result = await db.prepare(`SELECT * FROM bill_payments WHERE month = ?`).bind(month).all();
  return result.results || [];
}

function normalizeBill(row, payments, month) {
  const amount = readBillAmount(row);
  const paidThisMonth = payments.filter(p => String(p.bill_id) === String(row.id)).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const remainingThisMonth = Math.max(0, round2(amount - paidThisMonth));
  const cleared = amount > 0 && paidThisMonth >= amount;
  const latest = payments.filter(p => String(p.bill_id) === String(row.id)).sort((a, b) => String(b.payment_date || "").localeCompare(String(a.payment_date || "")))[0] || null;

  return {
    ...row,
    id: row.id,
    name: row.name || row.title || row.bill_name || "Unnamed bill",
    amount,
    monthly_amount: amount,
    category: BILL_CATEGORY,
    category_id: BILL_CATEGORY,
    month,
    paid_this_month: round2(paidThisMonth),
    remaining_this_month: remainingThisMonth,
    cleared,
    current_month_cleared: cleared,
    clear_status: cleared ? "cleared" : paidThisMonth > 0 ? "partial" : "pending",
    ledger_linked_payment_count: payments.filter(p => String(p.bill_id) === String(row.id)).length,
    last_paid_transaction_id: latest?.transaction_id || null,
    last_paid_account_id: latest?.account_id || null,
    last_paid_date: latest?.payment_date || null
  };
}

async function requireActiveAccount(db, id) {
  const account = await db.prepare(`
    SELECT id FROM accounts
    WHERE id = ?
      AND (deleted_at IS NULL OR deleted_at = '')
      AND (archived_at IS NULL OR archived_at = '')
      AND (status IS NULL OR status = '' OR status = 'active')
  `).bind(id).first();

  if (!account) throw new Error("Account not found or inactive.");
  return account;
}

async function requireCategory(db, id) {
  const category = await db.prepare(`SELECT id FROM categories WHERE id = ?`).bind(id).first();
  if (!category) throw new Error(`Required category missing: ${id}`);
  return category;
}

async function getColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map(r => r.name));
}

function buildInsert(table, columns, valuesByColumn) {
  const keys = Object.keys(valuesByColumn).filter(k => columns.has(k));
  return { sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, values: keys.map(k => valuesByColumn[k]) };
}

function buildUpdate(table, columns, valuesByColumn, whereColumn, whereValue) {
  const keys = Object.keys(valuesByColumn).filter(k => columns.has(k));
  return { sql: `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE ${whereColumn} = ?`, values: [...keys.map(k => valuesByColumn[k]), whereValue] };
}

function readBillAmount(row) { return Number(row.amount ?? row.monthly_amount ?? row.expected_amount ?? row.value ?? 0); }
function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function requireDb(env) { if (!env || !env.DB) throw new Error("D1 binding DB is missing."); return env.DB; }
function requireText(value, field) { const text = cleanText(value); if (!text) throw new Error(`${field} is required.`); return text; }
function cleanText(value) { if (value === undefined || value === null) return ""; return String(value).trim(); }
function requirePositiveNumber(value, field) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be greater than zero.`); return round2(n); }
function round2(value) { return Math.round(Number(value) * 100) / 100; }
function makeId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function appendNote(existing, incoming, systemNote) { return [cleanText(existing), systemNote ? `[${new Date().toISOString()}] ${systemNote}` : "", cleanText(incoming)].filter(Boolean).join(" | "); }
function json(payload, status = 200) { return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
