const VERSION = "v0.4.1-ledger-atomic-item";

export async function onRequestGet({ env, params }) {
  try {
    const db = requireDb(env);
    const id = requireText(params.id, "id");
    const debt = await getDebt(db, id);

    if (!debt) {
      return json({ ok: false, version: VERSION, error: "Debt not found." }, 404);
    }

    return json({
      ok: true,
      version: VERSION,
      debt: normalizeDebtRow(debt)
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPut({ env, params, request }) {
  try {
    const db = requireDb(env);
    const id = requireText(params.id, "id");
    const body = await request.json();
    const action = String(body.action || "update").toLowerCase();

    if (action === "defer") {
      const result = await deferDebt(db, id, body);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (action === "payment" || action === "received") {
      const result = await recordDebtMovement(db, id, body);
      return json({ ok: true, version: VERSION, ...result });
    }

    const result = await updateDebt(db, id, body);
    return json({ ok: true, version: VERSION, ...result });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost({ env, params, request }) {
  try {
    const db = requireDb(env);
    const id = requireText(params.id, "id");
    const body = await request.json();
    const action = String(body.action || "update").toLowerCase();

    if (action === "defer") {
      const result = await deferDebt(db, id, body);
      return json({ ok: true, version: VERSION, ...result });
    }

    if (action === "payment" || action === "received") {
      const result = await recordDebtMovement(db, id, body);
      return json({ ok: true, version: VERSION, ...result });
    }

    const result = await updateDebt(db, id, body);
    return json({ ok: true, version: VERSION, ...result });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function updateDebt(db, id, body) {
  const existing = await getDebt(db, id);
  if (!existing) throw new Error("Debt not found.");

  const name = cleanText(body.name) || existing.name;
  const kind = normalizeKind(body.kind || body.direction || body.type || existing.kind);
  const original = optionalNumber(body.original_amount ?? body.amount) ?? Number(existing.original_amount);
  const paid = optionalNumber(body.paid_amount) ?? Number(existing.paid_amount || 0);
  const dueDate = cleanText(body.next_due_date || body.due_date) || null;
  const notes = cleanText(body.notes) || existing.notes || null;
  const installment = optionalNumber(body.installment_amount);
  const frequency = cleanText(body.frequency) || existing.frequency || "custom";
  const status = cleanText(body.status) || existing.status || "active";

  if (original <= 0) throw new Error("original_amount must be greater than zero.");
  if (paid < 0) throw new Error("paid_amount cannot be negative.");
  if (paid > original) throw new Error("paid_amount cannot exceed original_amount.");

  await db.prepare(`
    UPDATE debts
    SET
      name = ?,
      kind = ?,
      original_amount = ?,
      paid_amount = ?,
      due_date = ?,
      status = ?,
      notes = ?,
      installment_amount = ?,
      frequency = ?
    WHERE id = ?
  `).bind(
    name,
    kind,
    original,
    paid,
    dueDate,
    status,
    notes,
    installment,
    frequency,
    id
  ).run();

  return {
    action: "update",
    debt: normalizeDebtRow(await getDebt(db, id)),
    ledger_transaction: null
  };
}

async function deferDebt(db, id, body) {
  const existing = await getDebt(db, id);
  if (!existing) throw new Error("Debt not found.");

  if (isClosed(existing.status)) {
    throw new Error("Settled or archived debts can only be edited.");
  }

  const nextDueDate = requireText(body.next_due_date || body.due_date, "next_due_date");
  const notes = appendNote(existing.notes, body.notes, `Deferred to ${nextDueDate}`);

  await db.prepare(`
    UPDATE debts
    SET
      due_date = ?,
      notes = ?
    WHERE id = ?
  `).bind(nextDueDate, notes, id).run();

  return {
    action: "defer",
    debt: normalizeDebtRow(await getDebt(db, id)),
    ledger_transaction: null
  };
}

async function recordDebtMovement(db, id, body) {
  const existing = await getDebt(db, id);
  if (!existing) throw new Error("Debt not found.");

  if (isClosed(existing.status)) {
    throw new Error("Settled or archived debts can only be edited.");
  }

  const action = normalizeMovementAction(body.action || body.type);
  const kind = normalizeKind(existing.kind);

  if (kind === "owe" && action !== "payment") {
    throw new Error("This debt is money you owe. Use payment only.");
  }

  if (kind === "owed" && action !== "received") {
    throw new Error("This debt is owed to you. Use received only.");
  }

  const amount = requirePositiveNumber(body.amount, "amount");
  const accountId = requireText(body.account_id, "account_id");
  const date = requireText(body.date, "date");
  const now = new Date().toISOString();

  const original = Number(existing.original_amount);
  const paidBefore = Number(existing.paid_amount || 0);
  const remainingBefore = round2(original - paidBefore);

  if (amount > remainingBefore + 0.00001) {
    throw new Error(`Amount exceeds outstanding debt. Outstanding is ${remainingBefore}.`);
  }

  const paidAfter = round2(paidBefore + amount);
  const remainingAfter = round2(original - paidAfter);
  const settled = remainingAfter <= 0.00001;

  const nextDueDate = settled ? null : cleanText(body.next_due_date || body.due_date || existing.due_date);
  const status = settled ? "closed" : "active";

  const txType = action === "payment" ? "repay" : "income";
  const txEffect = action === "payment" ? "decrease_account" : "increase_account";
  const txId = makeId(`tx_${txType}`);

  const newNotes = appendNote(
    existing.notes,
    body.notes,
    action === "payment" ? `Payment ${amount} on ${date}` : `Received ${amount} on ${date}`
  );

  const txNotes = [
    action === "payment" ? `Debt payment: ${existing.name}` : `Debt received: ${existing.name}`,
    `debt_id=${id}`,
    `kind=${kind}`,
    cleanText(body.notes) ? `notes=${cleanText(body.notes)}` : null
  ].filter(Boolean).join(" | ");

  const debtUpdate = db.prepare(`
    UPDATE debts
    SET
      paid_amount = ?,
      status = ?,
      due_date = ?,
      last_paid_date = ?,
      notes = ?
    WHERE id = ?
  `).bind(paidAfter, status, nextDueDate, date, newNotes, id);

  const transactionInsert = db.prepare(`
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
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, 0, NULL, ?, NULL, NULL, NULL)
  `).bind(txId, date, txType, amount, accountId, txNotes, now);

  await db.batch([debtUpdate, transactionInsert]);

  return {
    action,
    debt: normalizeDebtRow(await getDebt(db, id)),
    ledger_transaction: {
      id: txId,
      type: txType,
      date,
      amount,
      account_id: accountId,
      effect: txEffect
    }
  };
}

async function getDebt(db, id) {
  return await db.prepare(`
    SELECT
      id,
      name,
      kind,
      original_amount,
      paid_amount,
      snowball_order,
      due_date,
      status,
      notes,
      created_at,
      due_day,
      installment_amount,
      frequency,
      last_paid_date
    FROM debts
    WHERE id = ?
  `).bind(id).first();
}

function normalizeDebtRow(row) {
  if (!row) return null;

  const original = Number(row.original_amount || 0);
  const paid = Number(row.paid_amount || 0);
  const remaining = round2(original - paid);
  const normalizedKind = normalizeKind(row.kind);

  return {
    ...row,
    kind: normalizedKind,
    direction: normalizedKind === "owed" ? "owed_to_me" : "i_owe",
    type: normalizedKind === "owed" ? "owed_to_me" : "i_owe",
    original_amount: original,
    amount: original,
    paid_amount: paid,
    outstanding: remaining,
    outstanding_amount: remaining,
    remaining_amount: remaining,
    next_due_date: row.due_date || null,
    settled: remaining <= 0.00001 || isClosed(row.status)
  };
}

function normalizeMovementAction(value) {
  const action = String(value || "").toLowerCase();

  if (["payment", "pay", "paid", "repay"].includes(action)) return "payment";
  if (["received", "receive", "receipt", "income"].includes(action)) return "received";

  throw new Error("action must be payment or received.");
}

function normalizeKind(value) {
  const v = String(value || "").toLowerCase();

  if (["owed", "owed_to_me", "receivable", "to_me", "they_owe_me", "received"].includes(v)) return "owed";
  if (["owe", "i_owe", "payable", "i owe", "debt"].includes(v)) return "owe";

  throw new Error("kind/direction must be either owe or owed.");
}

function isClosed(status) {
  return ["closed", "settled", "archived", "deleted"].includes(String(status || "").toLowerCase());
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
