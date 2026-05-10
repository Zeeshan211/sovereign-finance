const VERSION = "v0.3.0-schema-safe-reversal";

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const body = await readJson(context.request);

    const id = clean(body.id);
    const reason = clean(body.reason || "Correction");
    const createdBy = clean(body.created_by || "web-ledger");

    if (!id) {
      return json({ ok: false, version: VERSION, error: "id required" }, 400);
    }

    if (!reason) {
      return json({ ok: false, version: VERSION, error: "reason required" }, 400);
    }

    const columns = await getColumns(db, "transactions");

    const original = await db.prepare(
      "SELECT * FROM transactions WHERE id = ?"
    ).bind(id).first();

    if (!original) {
      return json({ ok: false, version: VERSION, error: "Original transaction not found" }, 404);
    }

    const guard = guardReversible(original);
    if (!guard.ok) {
      return json({ ok: false, version: VERSION, error: guard.error }, 400);
    }

    const linked = await findLinkedTransaction(db, original);

    if (linked) {
      const linkedGuard = guardReversible(linked);
      if (!linkedGuard.ok) {
        return json({ ok: false, version: VERSION, error: "Linked transaction cannot be reversed: " + linkedGuard.error }, 400);
      }

      return await reversePair({
        db,
        columns,
        original,
        linked,
        reason,
        createdBy
      });
    }

    return await reverseSingle({
      db,
      columns,
      original,
      reason,
      createdBy
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err && err.message ? err.message : String(err)
    }, 500);
  }
}

async function reverseSingle(input) {
  const { db, columns, original, reason, createdBy } = input;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const reversalId = makeId("rev");

  const originalType = clean(original.type || original.transaction_type || original.kind || "expense");
  const reversalType = oppositeType(originalType);
  const amount = Math.abs(Number(original.amount || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: "Original amount is invalid" }, 400);
  }

  const reversalRow = {
    id: reversalId,
    date: today,
    type: reversalType,
    amount,
    account_id: original.account_id || null,
    category_id: original.category_id || null,
    notes: `[REVERSAL OF ${original.id}] Reason: ${reason}`,
    linked_txn_id: original.id,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: "active",
    fee_amount: 0,
    pra_amount: 0
  };

  const insert = buildInsert("transactions", columns, reversalRow);

  const updates = {
    reversed_by: reversalId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  };

  const update = buildUpdate("transactions", columns, updates, "id = ?", [original.id]);

  const statements = [db.prepare(insert.sql).bind(...insert.values)];

  if (update) {
    statements.push(db.prepare(update.sql).bind(...update.values));
  }

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    mode: "single",
    original_id: original.id,
    reversal_id: reversalId,
    reversal_type: reversalType,
    amount,
    account_id: original.account_id || null,
    reason
  });
}

async function reversePair(input) {
  const { db, columns, original, linked, reason, createdBy } = input;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const pair = normalizePair(original, linked);

  if (!pair.ok) {
    return json({ ok: false, version: VERSION, error: pair.error }, 400);
  }

  const amount = Math.abs(Number(pair.amount || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: "Linked transfer amount is invalid" }, 400);
  }

  const reversalOutId = makeId("revout");
  const reversalInId = makeId("revin");

  const reversalOut = {
    id: reversalOutId,
    date: today,
    type: "income",
    amount,
    account_id: pair.sourceAccount,
    category_id: null,
    notes: `[REVERSAL OF ${pair.out.id}] [linked: ${reversalInId}] Reason: ${reason}`,
    linked_txn_id: reversalInId,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: "active",
    fee_amount: 0,
    pra_amount: 0
  };

  const reversalIn = {
    id: reversalInId,
    date: today,
    type: "expense",
    amount,
    account_id: pair.destinationAccount,
    category_id: null,
    notes: `[REVERSAL OF ${pair.in.id}] [linked: ${reversalOutId}] Reason: ${reason}`,
    linked_txn_id: reversalOutId,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: "active",
    fee_amount: 0,
    pra_amount: 0
  };

  const insertOut = buildInsert("transactions", columns, reversalOut);
  const insertIn = buildInsert("transactions", columns, reversalIn);

  const updateOut = buildUpdate("transactions", columns, {
    reversed_by: reversalOutId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, "id = ?", [pair.out.id]);

  const updateIn = buildUpdate("transactions", columns, {
    reversed_by: reversalInId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, "id = ?", [pair.in.id]);

  const statements = [
    db.prepare(insertOut.sql).bind(...insertOut.values),
    db.prepare(insertIn.sql).bind(...insertIn.values)
  ];

  if (updateOut) statements.push(db.prepare(updateOut.sql).bind(...updateOut.values));
  if (updateIn) statements.push(db.prepare(updateIn.sql).bind(...updateIn.values));

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    mode: "linked_transfer",
    original_out_id: pair.out.id,
    original_in_id: pair.in.id,
    reversal_out_id: reversalOutId,
    reversal_in_id: reversalInId,
    amount,
    source_account: pair.sourceAccount,
    destination_account: pair.destinationAccount,
    reason
  });
}

async function getColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const rows = result && result.results ? result.results : [];
  return new Set(rows.map(row => row.name));
}

function buildInsert(table, columns, row) {
  const keys = Object.keys(row).filter(key => columns.has(key));

  if (!keys.includes("id")) {
    throw new Error("transactions table missing id column");
  }

  if (!keys.includes("type")) {
    throw new Error("transactions table missing type column");
  }

  if (!keys.includes("amount")) {
    throw new Error("transactions table missing amount column");
  }

  const placeholders = keys.map(() => "?").join(", ");
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
  const values = keys.map(key => row[key]);

  return { sql, values };
}

function buildUpdate(table, columns, updates, whereSql, whereValues) {
  const keys = Object.keys(updates).filter(key => columns.has(key));

  if (!keys.length) return null;

  const setSql = keys.map(key => `${key} = ?`).join(", ");
  const sql = `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`;
  const values = keys.map(key => updates[key]).concat(whereValues || []);

  return { sql, values };
}

async function findLinkedTransaction(db, tx) {
  const direct = clean(tx.linked_txn_id);
  const fromNotes = extractLinkedId(tx.notes);
  const linkedId = direct || fromNotes;

  if (!linkedId || linkedId === tx.id) return null;

  try {
    return await db.prepare(
      "SELECT * FROM transactions WHERE id = ?"
    ).bind(linkedId).first();
  } catch (err) {
    return null;
  }
}

function normalizePair(a, b) {
  const aType = clean(a.type).toLowerCase();
  const bType = clean(b.type).toLowerCase();

  if (aType === "transfer" && bType === "income") {
    return {
      ok: true,
      out: a,
      in: b,
      amount: Number(a.amount || b.amount || 0),
      sourceAccount: a.account_id,
      destinationAccount: b.account_id
    };
  }

  if (bType === "transfer" && aType === "income") {
    return {
      ok: true,
      out: b,
      in: a,
      amount: Number(b.amount || a.amount || 0),
      sourceAccount: b.account_id,
      destinationAccount: a.account_id
    };
  }

  return {
    ok: false,
    error: "Linked rows are not a recognized transfer pair"
  };
}

function guardReversible(tx) {
  if (!tx) {
    return { ok: false, error: "Transaction not found" };
  }

  if (clean(tx.reversed_by) || clean(tx.reversed_at)) {
    return { ok: false, error: "Transaction is already reversed" };
  }

  const notes = clean(tx.notes).toUpperCase();

  if (notes.includes("[REVERSAL OF ")) {
    return { ok: false, error: "Cannot reverse a reversal row" };
  }

  return { ok: true };
}

function oppositeType(type) {
  const t = clean(type).toLowerCase();

  if (t === "expense") return "income";
  if (t === "income") return "expense";
  if (t === "transfer") return "income";

  if (t === "cc_payment") return "cc_spend";
  if (t === "cc_spend") return "cc_payment";

  if (t === "borrow") return "repay";
  if (t === "repay") return "borrow";

  if (t === "debt_in") return "debt_out";
  if (t === "debt_out") return "debt_in";

  return t || "expense";
}

function extractLinkedId(notes) {
  const text = clean(notes);
  const match = text.match(/\[linked:\s*([^\]\s]+)\]/i);
  return match ? clean(match[1]) : "";
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
