/* /api/debts/:id/pay — pay money I owe */
/* Sovereign Finance v0.5.0-debts-money-truth-pay
 *
 * Only allowed for i_owe / owe / payable.
 * Effect:
 * - creates expense transaction from selected account
 * - increases paid_amount
 * - reduces remaining payable
 */

const VERSION = "v0.5.0-debts-money-truth-pay";
const DEBT_CATEGORY = "debt_payment";

const ACTIVE_ACCOUNT_CONDITION =
  "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestPost(context) {
  try {
    const db = requireDb(context.env);
    const debtId = requireClean(context.params.id, "id");
    const body = await readJson(context.request);
    const dryRun = isDryRun(context.request, body);

    const debtRow = await readDebt(db, debtId);
    if (!debtRow) return json({ ok: false, version: VERSION, error: "Debt not found" }, 404);

    const debt = normalizeDebt(debtRow);

    if (debt.direction !== "i_owe") {
      return json({
        ok: false,
        version: VERSION,
        error: "Use receive endpoint for owed_to_me debts.",
        direction: debt.direction,
        allowed_endpoint: `/api/debts/${debtId}/receive`
      }, 409);
    }

    const statusCheck = assertMoneyActionAllowed(debt);
    if (!statusCheck.ok) return json({ ok: false, version: VERSION, error: statusCheck.error }, 409);

    const amount = positiveNumber(body.amount, "amount");
    if (amount > debt.remaining_amount + 0.01) {
      return json({
        ok: false,
        version: VERSION,
        error: "Amount cannot exceed remaining debt.",
        requested_amount: round2(amount),
        remaining_amount: debt.remaining_amount
      }, 400);
    }

    const accountId = requireClean(body.account_id || body.source_account_id, "account_id");
    const account = await resolveAccount(db, accountId);
    if (!account.ok) return json(account, account.status || 409);

    const date = normalizeDate(body.date || body.payment_date || body.paid_date) || today();
    const notes = clean(body.notes);
    await requireCategory(db, DEBT_CATEGORY);

    const nextPaid = round2(debt.paid_amount + amount);
    const remaining = round2(Math.max(0, debt.original_amount - nextPaid));
    const nextStatus = remaining <= 0 ? "settled" : "active";

    const txId = makeId("tx_debt_pay");
    const txNotes = [
      `Debt payment: ${debt.name}`,
      `debt_id=${debt.id}`,
      notes ? `notes=${notes}` : null
    ].filter(Boolean).join(" | ");

    const proof = {
      action: "debt.pay",
      version: VERSION,
      direction: debt.direction,
      transaction_type: "expense",
      account_effect: "selected_account_decreases",
      amount: round2(amount),
      before_remaining: debt.remaining_amount,
      after_remaining: remaining,
      category_id: DEBT_CATEGORY
    };

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        writes_performed: false,
        proof,
        normalized_payload: {
          debt_id: debt.id,
          account_id: account.account.id,
          amount: round2(amount),
          date,
          next_paid_amount: nextPaid,
          next_remaining_amount: remaining,
          next_status: nextStatus
        }
      });
    }

    const txColumns = await getColumns(db, "transactions");
    const debtColumns = await getColumns(db, "debts");

    const txInsert = buildInsert("transactions", txColumns, {
      id: txId,
      date,
      type: "expense",
      amount: round2(amount),
      account_id: account.account.id,
      transfer_to_account_id: null,
      category_id: DEBT_CATEGORY,
      notes: txNotes,
      fee_amount: 0,
      pra_amount: 0,
      created_at: new Date().toISOString(),
      reversed_by: null,
      reversed_at: null,
      linked_txn_id: null
    });

    const debtUpdate = buildUpdate("debts", debtColumns, {
      paid_amount: nextPaid,
      status: nextStatus,
      last_paid_date: date
    }, "id", debt.id);

    await db.batch([
      db.prepare(txInsert.sql).bind(...txInsert.values),
      db.prepare(debtUpdate.sql).bind(...debtUpdate.values)
    ]);

    const afterDebt = normalizeDebt(await readDebt(db, debt.id));

    return json({
      ok: true,
      version: VERSION,
      action: "debt.pay",
      debt_id: debt.id,
      transaction_id: txId,
      ledger_transaction: {
        id: txId,
        type: "expense",
        amount: round2(amount),
        account_id: account.account.id,
        category_id: DEBT_CATEGORY,
        effect: "decrease_account"
      },
      debt: afterDebt,
      proof
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

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

async function readDebt(db, id) {
  return await db.prepare(`SELECT ${DEBT_COLUMNS} FROM debts WHERE id = ? LIMIT 1`).bind(id).first();
}

function normalizeDebt(row) {
  const original = Number(row?.original_amount || 0);
  const paid = Number(row?.paid_amount || 0);
  const remaining = Math.max(0, original - paid);
  const kind = normalizeKind(row?.kind);
  const direction = kind === "owed" ? "owed_to_me" : "i_owe";
  const statusRaw = clean(row?.status || "active").toLowerCase();
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
    status,
    last_paid_date: normalizeDate(row?.last_paid_date),
    notes: clean(row?.notes)
  };
}

function assertMoneyActionAllowed(debt) {
  if (["settled", "archived", "deleted", "closed", "cancelled"].includes(debt.status)) {
    return { ok: false, error: "Settled/archived debts allow edit-only, no money movement." };
  }

  if (debt.remaining_amount <= 0) {
    return { ok: false, error: "Debt is already settled." };
  }

  return { ok: true };
}

async function resolveAccount(db, input) {
  const raw = clean(input);

  const account = await db.prepare(`
    SELECT id, name, kind, type, status
    FROM accounts
    WHERE id = ?
      AND ${ACTIVE_ACCOUNT_CONDITION}
    LIMIT 1
  `).bind(raw).first();

  if (account?.id) return { ok: true, account };

  return { ok: false, status: 409, error: "Account not found or inactive." };
}

async function requireCategory(db, id) {
  const category = await db.prepare(`SELECT id FROM categories WHERE id = ?`).bind(id).first();
  if (!category?.id) throw new Error(`Required category missing: ${id}`);
}

async function getColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map(row => row.name));
}

function buildInsert(table, columns, valuesByColumn) {
  const keys = Object.keys(valuesByColumn).filter(key => columns.has(key));
  if (!keys.length) throw new Error(`No insertable columns for ${table}.`);

  return {
    sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    values: keys.map(key => valuesByColumn[key])
  };
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

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function positiveNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be greater than zero.`);
  return n;
}

function requireClean(value, field) {
  const text = clean(value);
  if (!text) throw new Error(`${field} required`);
  return text;
}

function isDryRun(request, body) {
  const url = new URL(request.url);
  return url.searchParams.get("dry_run") === "1"
    || url.searchParams.get("dry_run") === "true"
    || body.dry_run === true
    || body.dry_run === "1"
    || body.dry_run === "true";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
