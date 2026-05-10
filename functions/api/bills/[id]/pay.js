const VERSION = "v0.5.1-bills-ledger-atomic-pay";

export async function onRequestPost({ env, params, request }) {
  try {
    const db = requireDb(env);
    await ensureBillPayments(db);

    const id = requireText(params.id, "id");
    const body = await request.json();
    const result = await payBill(db, id, body);

    return json({
      ok: true,
      version: VERSION,
      ...result
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
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

  return {
    action: "pay",
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

async function getBill(db, id) {
  return await db.prepare(`SELECT * FROM bills WHERE id = ?`).bind(id).first();
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
  return Math.round(n * 100) / 100;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
