/* /api/debts/:id — item/update/defer/archive/reactivate */
/* Sovereign Finance v0.5.0-debts-money-truth-item */

const VERSION = "v0.5.0-debts-money-truth-item";

const DEBT_COLUMNS = `
  id,
  name,
  kind,
  original_amount,
  paid_amount,
  snowball_order,
  due_date,
  due_day,
  installment_amount,
  frequency,
  last_paid_date,
  status,
  notes,
  created_at
`;

export async function onRequestGet(context) {
  try {
    const db = requireDb(context.env);
    const id = requireClean(context.params.id, "id");
    const debt = await readDebt(db, id);

    if (!debt) return json({ ok: false, version: VERSION, error: "Debt not found" }, 404);

    return json({
      ok: true,
      version: VERSION,
      debt: normalizeDebt(debt)
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPut(context) {
  return onRequestPost(context);
}

export async function onRequestPost(context) {
  try {
    const db = requireDb(context.env);
    const id = requireClean(context.params.id, "id");
    const body = await readJson(context.request);
    const action = clean(body.action || "update").toLowerCase();

    const before = await readDebt(db, id);
    if (!before) return json({ ok: false, version: VERSION, error: "Debt not found" }, 404);

    const normalizedBefore = normalizeDebt(before);

    if (action === "defer") {
      return json({
        ok: true,
        version: VERSION,
        action: "defer",
        ...(await deferDebt(db, id, body, before))
      });
    }

    if (action === "archive") {
      return json({
        ok: true,
        version: VERSION,
        action: "archive",
        ...(await setStatus(db, id, "archived", body.notes, before))
      });
    }

    if (action === "reactivate") {
      return json({
        ok: true,
        version: VERSION,
        action: "reactivate",
        ...(await setStatus(db, id, "active", body.notes, before))
      });
    }

    if (action === "settle") {
      return json({
        ok: true,
        version: VERSION,
        action: "settle",
        ...(await settleDebt(db, id, body, before))
      });
    }

    if (["settled", "archived", "deleted", "closed", "cancelled"].includes(normalizedBefore.status)) {
      return json({ ok: false, version: VERSION, error: "Settled/archived debts allow edit-only, no money movement." }, 409);
    }

    return json({
      ok: true,
      version: VERSION,
      action: "update",
      ...(await updateDebt(db, id, body, before))
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

async function updateDebt(db, id, body, before) {
  const columns = await getColumns(db, "debts");
  const patch = {};

  if ("name" in body) patch.name = requireClean(body.name, "name");
  if ("kind" in body || "direction" in body) patch.kind = normalizeKind(body.kind || body.direction);
  if ("original_amount" in body || "amount" in body) patch.original_amount = nonNegativeNumber(body.original_amount ?? body.amount, "original_amount");
  if ("paid_amount" in body) patch.paid_amount = nonNegativeNumber(body.paid_amount, "paid_amount");
  if ("snowball_order" in body) patch.snowball_order = nullableNumber(body.snowball_order);
  if ("due_date" in body || "next_due_date" in body) patch.due_date = normalizeDate(body.due_date || body.next_due_date);
  if ("due_day" in body) patch.due_day = normalizeDueDay(body.due_day);
  if ("installment_amount" in body || "installment" in body) patch.installment_amount = nullableNonNegative(body.installment_amount ?? body.installment);
  if ("frequency" in body) patch.frequency = normalizeFrequency(body.frequency);
  if ("last_paid_date" in body) patch.last_paid_date = normalizeDate(body.last_paid_date);
  if ("notes" in body) patch.notes = clean(body.notes);
  if ("status" in body) patch.status = normalizeStatus(body.status);

  const nextOriginal = "original_amount" in patch ? patch.original_amount : Number(before.original_amount || 0);
  const nextPaid = "paid_amount" in patch ? patch.paid_amount : Number(before.paid_amount || 0);

  if (nextPaid > nextOriginal) throw new Error("paid_amount cannot exceed original_amount.");

  if (!Object.keys(patch).length) throw new Error("Nothing to update.");

  const update = buildUpdate("debts", columns, patch, "id", id);
  await db.prepare(update.sql).bind(...update.values).run();

  const after = await readDebt(db, id);

  return {
    debt: normalizeDebt(after),
    ledger_transaction: null,
    proof: {
      money_movement: false,
      updated_fields: Object.keys(patch)
    }
  };
}

async function deferDebt(db, id, body, before) {
  const columns = await getColumns(db, "debts");
  const nextDate = normalizeDate(body.next_due_date || body.due_date || body.follow_up_date);

  if (!nextDate) throw new Error("next_due_date must be YYYY-MM-DD.");

  const notes = appendNote(before.notes, body.notes, `Deferred to ${nextDate}`);

  const update = buildUpdate("debts", columns, {
    due_date: nextDate,
    notes
  }, "id", id);

  await db.prepare(update.sql).bind(...update.values).run();

  return {
    debt: normalizeDebt(await readDebt(db, id)),
    ledger_transaction: null,
    proof: {
      money_movement: false,
      account_effect: "none",
      next_due_date: nextDate
    }
  };
}

async function setStatus(db, id, status, note, before) {
  const columns = await getColumns(db, "debts");
  const notes = appendNote(before.notes, note, `Status changed to ${status}`);

  const update = buildUpdate("debts", columns, {
    status,
    notes
  }, "id", id);

  await db.prepare(update.sql).bind(...update.values).run();

  return {
    debt: normalizeDebt(await readDebt(db, id)),
    ledger_transaction: null,
    proof: {
      money_movement: false,
      status
    }
  };
}

async function settleDebt(db, id, body, before) {
  const columns = await getColumns(db, "debts");
  const original = Number(before.original_amount || 0);
  const notes = appendNote(before.notes, body.notes, "Marked settled manually");

  const update = buildUpdate("debts", columns, {
    paid_amount: original,
    status: "settled",
    notes
  }, "id", id);

  await db.prepare(update.sql).bind(...update.values).run();

  return {
    debt: normalizeDebt(await readDebt(db, id)),
    ledger_transaction: null,
    proof: {
      money_movement: false,
      manual_settle: true
    }
  };
}

async function readDebt(db, id) {
  return await db.prepare(`SELECT ${DEBT_COLUMNS} FROM debts WHERE id = ? LIMIT 1`).bind(id).first();
}

function normalizeDebt(row) {
  const original = Number(row?.original_amount || 0);
  const paid = Number(row?.paid_amount || 0);
  const remaining = Math.max(0, original - paid);
  const kind = normalizeKind(row?.kind);
  const direction = kind === "owed" ? "owed_to_me" : "i_owe";
  const statusRaw = normalizeStatus(row?.status || "active");
  const status = remaining <= 0 && statusRaw === "active" ? "settled" : statusRaw;

  return {
    id: clean(row?.id),
    name: clean(row?.name),
    kind,
    direction,
    original_amount: round2(original),
    paid_amount: round2(paid),
    remaining_amount: round2(remaining),
    outstanding_amount: round2(remaining),
    snowball_order: row?.snowball_order == null ? null : Number(row.snowball_order),
    due_date: normalizeDate(row?.due_date),
    due_day: normalizeDueDay(row?.due_day),
    installment_amount: nullableNonNegative(row?.installment_amount),
    frequency: normalizeFrequency(row?.frequency || "custom") || "custom",
    last_paid_date: normalizeDate(row?.last_paid_date),
    next_due_date: normalizeDate(row?.due_date),
    status,
    notes: clean(row?.notes),
    created_at: row?.created_at || null,
    allowed_actions: allowedActions(direction, status)
  };
}

function allowedActions(direction, status) {
  if (["settled", "archived", "deleted", "closed", "cancelled"].includes(status)) return ["edit"];
  if (direction === "i_owe") return ["pay", "defer", "edit", "archive"];
  if (direction === "owed_to_me") return ["receive", "defer", "edit", "archive"];
  return ["edit"];
}

async function getColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map(row => row.name));
}

function buildUpdate(table, columns, valuesByColumn, whereColumn, whereValue) {
  const keys = Object.keys(valuesByColumn).filter(key => columns.has(key));
  if (!keys.length) throw new Error(`No updatable columns for ${table}.`);

  return {
    sql: `UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE ${whereColumn} = ?`,
    values: [...keys.map(key => valuesByColumn[key]), whereValue]
  };
}

function normalizeKind(value) {
  const text = clean(value).toLowerCase();

  if (["i_owe", "owe", "payable", "debt", "debt_out"].includes(text)) return "owe";
  if (["owed_to_me", "owed", "owed_me", "receivable", "to_me", "debt_in"].includes(text)) return "owed";

  return "owe";
}

function normalizeStatus(value) {
  const text = clean(value || "active").toLowerCase();
  if (["active", "settled", "archived", "deleted", "closed", "cancelled"].includes(text)) return text;
  return "active";
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 31) return null;
  return Math.floor(n);
}

function normalizeFrequency(value) {
  const text = clean(value || "custom").toLowerCase();
  return ["monthly", "weekly", "yearly", "custom"].includes(text) ? text : null;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableNonNegative(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return round2(n);
}

function nonNegativeNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} must be 0 or greater.`);
  return round2(n);
}

function requireClean(value, field) {
  const text = clean(value);
  if (!text) throw new Error(`${field} required`);
  return text;
}

function appendNote(existing, incoming, systemNote) {
  return [clean(existing), systemNote ? `[${new Date().toISOString()}] ${systemNote}` : "", clean(incoming)]
    .filter(Boolean)
    .join(" | ");
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function requireDb(env) {
  if (!env?.DB) throw new Error("D1 binding DB is missing.");
  return env.DB;
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
