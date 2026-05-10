const VERSION = "v0.5.1-bills-ledger-atomic";

export async function onRequestGet({ env, request }) {
  try {
    const db = requireDb(env);
    await ensureBillPayments(db);

    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    const month = url.searchParams.get("month") || currentMonth();

    const billsResult = await db.prepare(`SELECT * FROM bills ORDER BY name ASC`).all();
    const payments = await getBillPaymentsForMonth(db, month);

    const bills = (billsResult.results || [])
      .map(row => normalizeBill(row, payments, month))
      .filter(bill => includeInactive || !["archived", "deleted"].includes(String(bill.status || "").toLowerCase()));

    return json({
      ok: true,
      version: VERSION,
      month,
      count: bills.length,
      bills
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost({ env, request }) {
  try {
    const db = requireDb(env);
    await ensureBillPayments(db);

    const body = await request.json();
    const action = String(body.action || "create").toLowerCase();

    if (action === "create") {
      const result = await createBill(db, body);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (action === "update") {
      const result = await updateBill(db, requireText(body.id || body.bill_id, "id"), body);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (["pay", "paid"].includes(action)) {
      const result = await payBill(db, requireText(body.id || body.bill_id, "id"), body);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (action === "defer") {
      const result = await deferBill(db, requireText(body.id || body.bill_id, "id"), body);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (action === "archive") {
      const result = await setBillStatus(db, requireText(body.id || body.bill_id, "id"), "archived", body.notes);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (action === "reactivate") {
      const result = await setBillStatus(db, requireText(body.id || body.bill_id, "id"), "active", body.notes);
      return json({ ok: true, version: VERSION, ...result });
    }

    return json({ ok: false, version: VERSION, error: `Unsupported bill action: ${action}` }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createBill(db, body) {
  const columns = await getColumns(db, "bills");
  const now = new Date().toISOString();

  const id = cleanText(body.id) || makeId("bill");
  const name = requireText(body.name || body.title || body.bill_name, "name");
  const amount = requirePositiveNumber(body.amount ?? body.monthly_amount ?? body.expected_amount, "amount");
  const status = cleanText(body.status) || "active";
  const notes = cleanText(body.notes);
  const category = cleanText(body.category_id || body.category) || "bills";
  const dueDay = optionalInteger(body.due_day ?? body.dueDay);
  const dueDate = cleanText(body.due_date || body.next_due_date);
  const frequency = cleanText(body.frequency) || "monthly";

  const insert = buildInsert("bills", columns, {
    id,
    name,
    title: name,
    bill_name: name,
    amount,
    monthly_amount: amount,
    expected_amount: amount,
    status,
    notes,
    description: notes,
    category_id: category,
    category,
    due_day: dueDay,
    due_date: dueDate || null,
    next_due_date: dueDate || null,
    frequency,
    created_at: now,
    updated_at: now
  });

  await db.prepare(insert.sql).bind(...insert.values).run();

  return {
    action: "create",
    bill: normalizeBill(await getBill(db, id), [], currentMonth()),
    ledger_transaction: null
  };
}

async function updateBill(db, id, body) {
  const columns = await getColumns(db, "bills");
  const existing = await getBill(db, id);
  if (!existing) throw new Error("Bill not found.");

  const name = cleanText(body.name || body.title || body.bill_name) || existing.name || existing.title || existing.bill_name;
  const amount = optionalNumber(body.amount ?? body.monthly_amount ?? body.expected_amount) ?? readBillAmount(existing);
  const status = cleanText(body.status) || existing.status || "active";
  const notes = cleanText(body.notes) || existing.notes || existing.description || null;
  const category = cleanText(body.category_id || body.category) || existing.category_id || existing.category || "bills";
  const dueDay = optionalInteger(body.due_day ?? body.dueDay) ?? existing.due_day ?? null;
  const dueDate = cleanText(body.due_date || body.next_due_date) || existing.due_date || existing.next_due_date || null;
  const frequency = cleanText(body.frequency) || existing.frequency || "monthly";

  const update = buildUpdate("bills", columns, {
    name,
    title: name,
    bill_name: name,
    amount,
    monthly_amount: amount,
    expected_amount: amount,
    status,
    notes,
    description: notes,
    category_id: category,
    category,
    due_day: dueDay,
    due_date: dueDate,
    next_due_date: dueDate,
    frequency,
    updated_at: new Date().toISOString()
  }, "id", id);

  await db.prepare(update.sql).bind(...update.values).run();

  return {
    action: "update",
    bill: normalizeBill(await getBill(db, id), [], currentMonth()),
    ledger_transaction: null
  };
}

async function payBill(db, id, body) {
  const bill = await getBill(db, id);
  if (!bill) throw new Error("Bill not found.");

  const status = String(bill.status || "active").toLowerCase();
  if (["archived", "deleted"].includes(status)) {
    throw new Error("Archived or deleted bills cannot be paid.");
  }

  const amount = requirePositiveNumber(body.amount, "amount");
  const accountId = requireText(body.account_id, "account_id");
  const paymentDate = requireText(body.date || body.payment_date, "payment_date");
  const month = cleanText(body.month) || paymentDate.slice(0, 7);
  const notes = cleanText(body.notes);
  const now = new Date().toISOString();

  const txId = makeId("tx_bill_expense");
  const paymentId = makeId("billpay");
  const billName = bill.name || bill.title || bill.bill_name || id;
  const categoryId = bill.category_id || bill.category || body.category_id || body.category || "bills";

  const txNotes = [
    `Bill payment: ${billName}`,
    `bill_id=${id}`,
    notes ? `notes=${notes}` : null
  ].filter(Boolean).join(" | ");

  const insertTx = db.prepare(`
    INSERT INTO transactions (
      id,
      date,
      type,
      amount,
      account_id,
      transfer_to_account_id,
      category_id,
      merchant_id,
      notes,
      fee_amount,
      pra_amount,
      is_pending_reversal,
      reversal_due_date,
      created_at,
      reversed_by,
      reversed_at,
      linked_txn_id
    )
    VALUES (?, ?, 'expense', ?, ?, NULL, ?, NULL, ?, 0, 0, 0, NULL, ?, NULL, NULL, NULL)
  `).bind(txId, paymentDate, amount, accountId, categoryId, txNotes, now);

  const insertPayment = db.prepare(`
    INSERT INTO bill_payments (
      id,
      bill_id,
      transaction_id,
      account_id,
      amount,
      payment_date,
      month,
      notes,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(paymentId, id, txId, accountId, amount, paymentDate, month, notes || null, now);

  await db.batch([insertTx, insertPayment]);

  const payments = await getBillPaymentsForMonth(db, month);

  return {
    action: "pay",
    bill: normalizeBill(await getBill(db, id), payments, month),
    bill_payment: {
      id: paymentId,
      bill_id: id,
      transaction_id: txId,
      account_id: accountId,
      amount,
      payment_date: paymentDate,
      month
    },
    ledger_transaction: {
      id: txId,
      type: "expense",
      amount,
      account_id: accountId,
      effect: "decrease_account"
    }
  };
}

async function deferBill(db, id, body) {
  const columns = await getColumns(db, "bills");
  const bill = await getBill(db, id);
  if (!bill) throw new Error("Bill not found.");

  const nextDate = requireText(body.next_due_date || body.due_date, "next_due_date");
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
    bill: normalizeBill(await getBill(db, id), [], currentMonth()),
    ledger_transaction: null
  };
}

async function setBillStatus(db, id, status, note) {
  const columns = await getColumns(db, "bills");
  const bill = await getBill(db, id);
  if (!bill) throw new Error("Bill not found.");

  const notes = appendNote(bill.notes || bill.description, note, `Status changed to ${status}`);

  const update = buildUpdate("bills", columns, {
    status,
    notes,
    description: notes,
    updated_at: new Date().toISOString()
  }, "id", id);

  await db.prepare(update.sql).bind(...update.values).run();

  return {
    action: status,
    bill: normalizeBill(await getBill(db, id), [], currentMonth()),
    ledger_transaction: null
  };
}

async function getBill(db, id) {
  return await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
}

async function getBillPaymentsForMonth(db, month) {
  const result = await db.prepare(`SELECT * FROM bill_payments WHERE month = ?`).bind(month).all();
  return result.results || [];
}

function normalizeBill(row, payments, month) {
  if (!row) return null;

  const id = row.id;
  const amount = readBillAmount(row);
  const paidThisMonth = payments
    .filter(p => String(p.bill_id) === String(id))
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  const remainingThisMonth = Math.max(0, round2(amount - paidThisMonth));
  const cleared = amount > 0 && paidThisMonth >= amount;

  return {
    ...row,
    id,
    name: row.name || row.title || row.bill_name || "Unnamed bill",
    amount,
    monthly_amount: amount,
    due_day: row.due_day ?? row.dueDay ?? null,
    due_date: row.due_date || row.next_due_date || null,
    next_due_date: row.next_due_date || row.due_date || null,
    status: row.status || "active",
    category: row.category || row.category_id || "bills",
    category_id: row.category_id || row.category || "bills",
    notes: row.notes || row.description || "",
    month,
    paid_this_month: round2(paidThisMonth),
    remaining_this_month: remainingThisMonth,
    cleared,
    current_month_cleared: cleared,
    clear_status: cleared ? "cleared" : paidThisMonth > 0 ? "partial" : "pending"
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

async function getColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map(r => r.name));
}

function buildInsert(table, columns, valuesByColumn) {
  const keys = Object.keys(valuesByColumn).filter(k => columns.has(k));
  if (!keys.length) throw new Error(`No insertable columns found for ${table}.`);

  return {
    sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    values: keys.map(k => valuesByColumn[k])
  };
}

function buildUpdate(table, columns, valuesByColumn, whereColumn, whereValue) {
  const keys = Object.keys(valuesByColumn).filter(k => columns.has(k));
  if (!keys.length) throw new Error(`No updatable columns found for ${table}.`);

  return {
    sql: `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE ${whereColumn} = ?`,
    values: [...keys.map(k => valuesByColumn[k]), whereValue]
  };
}

function readBillAmount(row) {
  return Number(row.amount ?? row.monthly_amount ?? row.expected_amount ?? row.value ?? 0);
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function requireDb(env) {
  if (!env || !env.DB) throw new Error("D1 binding DB is missing.");
  return env.DB;
}

function requireText(value, field) {
  const text = cleanText(value);
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function requirePositiveNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be greater than zero.`);
  return round2(n);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Invalid number.");
  return round2(n);
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendNote(existing, incoming, systemNote) {
  return [
    cleanText(existing),
    systemNote ? `[${new Date().toISOString()}] ${systemNote}` : "",
    cleanText(incoming)
  ].filter(Boolean).join(" | ");
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
