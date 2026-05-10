/* /api/transactions/reverse — POST */
/* Sovereign Finance v0.3.0-schema-safe-reversal
 *
 * Restore goal:
 * - Bring back old working ledger correction flow.
 * - Frontend sends only transaction id + reason.
 * - Backend reverses against the original account/category/linkage.
 * - No Command Centre dependency.
 * - Schema-safe: only writes columns that exist in live D1.
 *
 * Single transaction reversal:
 * - insert audit reversal row with [REVERSAL OF original_id]
 * - mark original reversed_by / reversed_at / reversal_reason when those columns exist
 *
 * Transfer pair reversal:
 * - find linked transfer pair through linked_txn_id or [linked: ...] notes
 * - insert income back to source account
 * - insert expense out of destination account
 * - mark both original rows reversed when columns exist
 */

const VERSION = "v0.3.0-schema-safe-reversal";

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const body = await readJson(context.request);

    const id = clean(body.id);
    const reason = clean(body.reason);
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
        return json({
          ok: false,
          version: VERSION,
          error: "Linked transaction cannot be reversed: " + linkedGuard.error
        }, 400);
      }

      return reverseLinkedPair({
        db,
        columns,
        original,
        linked,
        reason,
        createdBy
      });
    }

    return reverseSingle({
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

  const originalId = clean(original.id);
  const originalType = clean(original.type || original.transaction_type || original.kind || "expense").toLowerCase();
  const amount = Math.abs(Number(original.amount || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: "Original amount is invalid" }, 400);
  }

  const reversalId = makeId("rev");
  const reversalType = oppositeType(originalType);

  const reversalRow = {
    id: reversalId,
    date: today,
    type: reversalType,
    transaction_type: reversalType,
    amount,
    account_id: original.account_id || null,
    transfer_to_account_id: null,
    category_id: original.category_id || null,
    category: original.category || null,
    notes: `[REVERSAL OF ${originalId}] Reason: ${reason}`,
    description: `[REVERSAL OF ${originalId}] Reason: ${reason}`,
    memo: `[REVERSAL OF ${originalId}] Reason: ${reason}`,
    linked_txn_id: originalId,
    reversed_of: originalId,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: "active",
    fee_amount: 0,
    pra_amount: 0
  };

  const insert = buildInsert("transactions", columns, reversalRow);

  const markOriginal = buildUpdate("transactions", columns, {
    reversed_by: reversalId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, "id = ?", [originalId]);

  const statements = [
    db.prepare(insert.sql).bind(...insert.values)
  ];

  if (markOriginal) {
    statements.push(db.prepare(markOriginal.sql).bind(...markOriginal.values));
  }

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    mode: "single",
    original_id: originalId,
    reversal_id: reversalId,
    original_type: originalType,
    reversal_type: reversalType,
    amount,
    account_id: original.account_id || null,
    reason,
    marked_original_reversed: Boolean(markOriginal)
  });
}

async function reverseLinkedPair(input) {
  const { db, columns, original, linked, reason, createdBy } = input;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const pair = normalizeTransferPair(original, linked);

  if (!pair.ok) {
    return json({ ok: false, version: VERSION, error: pair.error }, 400);
  }

  const amount = Math.abs(Number(pair.amount || 0));

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: "Linked transfer amount is invalid" }, 400);
  }

  const reversalSourceId = makeId("revsrc");
  const reversalDestId = makeId("revdst");

  const sourceReversalNotes =
    `[REVERSAL OF ${pair.outRow.id}] [linked: ${reversalDestId}] Reason: ${reason}`;

  const destinationReversalNotes =
    `[REVERSAL OF ${pair.inRow.id}] [linked: ${reversalSourceId}] Reason: ${reason}`;

  const sourceReversalRow = {
    id: reversalSourceId,
    date: today,
    type: "income",
    transaction_type: "income",
    amount,
    account_id: pair.sourceAccount,
    transfer_to_account_id: null,
    category_id: null,
    category: null,
    notes: sourceReversalNotes,
    description: sourceReversalNotes,
    memo: sourceReversalNotes,
    linked_txn_id: reversalDestId,
    reversed_of: pair.outRow.id,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: "active",
    fee_amount: 0,
    pra_amount: 0
  };

  const destinationReversalRow = {
    id: reversalDestId,
    date: today,
    type: "expense",
    transaction_type: "expense",
    amount,
    account_id: pair.destinationAccount,
    transfer_to_account_id: null,
    category_id: null,
    category: null,
    notes: destinationReversalNotes,
    description: destinationReversalNotes,
    memo: destinationReversalNotes,
    linked_txn_id: reversalSourceId,
    reversed_of: pair.inRow.id,
    created_by: createdBy,
    created_at: now,
    updated_at: now,
    status: "active",
    fee_amount: 0,
    pra_amount: 0
  };

  const insertSource = buildInsert("transactions", columns, sourceReversalRow);
  const insertDestination = buildInsert("transactions", columns, destinationReversalRow);

  const markOut = buildUpdate("transactions", columns, {
    reversed_by: reversalSourceId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, "id = ?", [pair.outRow.id]);

  const markIn = buildUpdate("transactions", columns, {
    reversed_by: reversalDestId,
    reversed_at: now,
    reversal_reason: reason,
    updated_at: now
  }, "id = ?", [pair.inRow.id]);

  const statements = [
    db.prepare(insertSource.sql).bind(...insertSource.values),
    db.prepare(insertDestination.sql).bind(...insertDestination.values)
  ];

  if (markOut) {
    statements.push(db.prepare(markOut.sql).bind(...markOut.values));
  }

  if (markIn) {
    statements.push(db.prepare(markIn.sql).bind(...markIn.values));
  }

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    mode: "linked_transfer",
    original_out_id: pair.outRow.id,
    original_in_id: pair.inRow.id,
    reversal_source_id: reversalSourceId,
    reversal_destination_id: reversalDestId,
    amount,
    source_account: pair.sourceAccount,
    destination_account: pair.destinationAccount,
    reason,
    marked_originals_reversed: Boolean(markOut && markIn)
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

  if (!keys.includes("type") && !keys.includes("transaction_type")) {
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

  if (!keys.length) {
    return null;
  }

  const setSql = keys.map(key => `${key} = ?`).join(", ");
  const sql = `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`;
  const values = keys.map(key => updates[key]).concat(whereValues || []);

  return { sql, values };
}

async function findLinkedTransaction(db, tx) {
  const direct = clean(tx.linked_txn_id);
  const fromNotes = extractLinkedId(tx.notes || tx.description || tx.memo);
  const linkedId = direct || fromNotes;

  if (!linkedId || linkedId === tx.id) {
    return null;
  }

  try {
    return await db.prepare(
      "SELECT * FROM transactions WHERE id = ?"
    ).bind(linkedId).first();
  } catch (err) {
    return null;
  }
}

function normalizeTransferPair(a, b) {
  const aType = clean(a.type || a.transaction_type).toLowerCase();
  const bType = clean(b.type || b.transaction_type).toLowerCase();

  if (aType === "transfer" && bType === "income") {
    return {
      ok: true,
      outRow: a,
      inRow: b,
      amount: Number(a.amount || b.amount || 0),
      sourceAccount: a.account_id,
      destinationAccount: b.account_id
    };
  }

  if (bType === "transfer" && aType === "income") {
    return {
      ok: true,
      outRow: b,
      inRow: a,
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

  const notes = clean(tx.notes || tx.description || tx.memo).toUpperCase();

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

  if (t === "atm") return "income";
  if (t === "salary") return "expense";
  if (t === "opening") return "expense";

  return t || "expense";
}

function extractLinkedId(value) {
  const text = clean(value);
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
