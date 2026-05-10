/* /api/debts — GET list, POST create */
/* Sovereign Finance v0.5.0-debts-money-truth
 *
 * Shipment 5:
 * - No Command Centre gate.
 * - Direction-aware debt creation.
 * - Optional account-linked ledger movement at creation.
 * - owed_to_me / owed / receivable:
 *     money moved now => expense from selected source account
 *     creates receivable debt.
 * - i_owe / owe / payable:
 *     money moved now => income into selected destination account
 *     creates payable debt.
 * - debt_only creates debt record only, no ledger movement.
 * - Payments/receipts are handled by /api/debts/:id/pay and /api/debts/:id/receive.
 */

const VERSION = "v0.5.0-debts-money-truth";
const DEBT_CATEGORY = "debt_payment";

const ACTIVE_ACCOUNT_CONDITION =
  "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

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
    const url = new URL(context.request.url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";

    const sql = includeInactive
      ? `SELECT ${DEBT_COLUMNS} FROM debts ORDER BY kind, snowball_order, name`
      : `SELECT ${DEBT_COLUMNS} FROM debts WHERE status IS NULL OR status = '' OR status = 'active' ORDER BY kind, snowball_order, name`;

    const result = await db.prepare(sql).all();
    const debts = (result.results || []).map(normalizeDebt);

    return json({
      ok: true,
      version: VERSION,
      count: debts.length,
      total_payable: round2(sumRemaining(debts.filter(d => d.direction === "i_owe"))),
      total_receivable: round2(sumRemaining(debts.filter(d => d.direction === "owed_to_me"))),
      total_owe: round2(sumRemaining(debts.filter(d => d.direction === "i_owe"))),
      total_owed: round2(sumRemaining(debts.filter(d => d.direction === "owed_to_me"))),
      active_count: debts.filter(d => d.status === "active").length,
      settled_count: debts.filter(d => d.status === "settled" || d.remaining_amount <= 0).length,
      contract: {
        source_of_truth: "debts + transactions",
        category_id: DEBT_CATEGORY,
        directions: {
          i_owe: {
            create_with_ledger: "income into selected account",
            pay: "expense from selected account",
            receive: "not_allowed"
          },
          owed_to_me: {
            create_with_ledger: "expense from selected account",
            pay: "not_allowed",
            receive: "income into selected account"
          }
        },
        settled_or_archived_money_actions: "blocked"
      },
      debts
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = requireDb(context.env);
    const body = await readJson(context.request);
    const dryRun = isDryRun(context.request, body);

    const validation = await buildCreatePayload(db, body);

    if (!validation.ok) {
      return json({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action: "debt.create",
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: "debt.create",
        writes_performed: false,
        normalized_payload: validation.payload,
        proof: validation.proof
      });
    }

    const result = await createDebt(db, validation.payload);

    return json({
      ok: true,
      version: VERSION,
      action: "debt.create",
      writes_performed: true,
      ...result,
      proof: validation.proof
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

async function buildCreatePayload(db, body) {
  const name = requireClean(body.name || body.title || body.person || body.code, "name");
  const direction = normalizeDirection(body.direction || body.kind || body.type);
  const amount = positiveNumber(body.original_amount ?? body.amount, "amount");
  const paidAmount = nonNegativeNumber(body.paid_amount || 0, "paid_amount");
  const installment = nullableNonNegative(body.installment_amount ?? body.installment);
  const dueDate = normalizeDate(body.due_date || body.next_due_date || body.follow_up_date);
  const dueDay = normalizeDueDay(body.due_day);
  const frequency = normalizeFrequency(body.frequency || "custom");
  const notes = clean(body.notes);
  const ledgerMode = normalizeLedgerMode(body.ledger_mode || body.with_ledger || body.money_moved_now);
  const date = normalizeDate(body.date || body.movement_date || body.created_date) || today();
  const accountInput = clean(body.account_id || body.source_account_id || body.destination_account_id);
  const id = clean(body.id) || makeId("debt");
  const snowballOrder = nullableNumber(body.snowball_order);

  if (!direction) {
    return { ok: false, status: 400, error: "direction/kind must be i_owe or owed_to_me" };
  }

  if (paidAmount > amount) {
    return { ok: false, status: 400, error: "paid_amount cannot exceed original_amount" };
  }

  if (!frequency) {
    return { ok: false, status: 400, error: "frequency must be monthly, weekly, yearly, or custom" };
  }

  let account = null;

  if (ledgerMode === "with_ledger") {
    if (!accountInput) {
      return {
        ok: false,
        status: 400,
        error: direction === "owed_to_me"
          ? "source account required when money goes out"
          : "destination account required when borrowed money enters"
      };
    }

    account = await resolveAccount(db, accountInput);
    if (!account.ok) return account;
  }

  const category = await requireCategoryIfExists(db, DEBT_CATEGORY);
  if (!category.ok) return category;

  const kind = direction === "i_owe" ? "owe" : "owed";

  const payload = {
    id,
    name,
    direction,
    kind,
    original_amount: round2(amount),
    paid_amount: round2(paidAmount),
    snowball_order: Number.isFinite(snowballOrder) ? snowballOrder : null,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installment,
    frequency,
    last_paid_date: null,
    status: "active",
    notes,
    ledger_mode: ledgerMode,
    movement_date: date,
    account_id: account?.account?.id || null,
    category_id: DEBT_CATEGORY
  };

  const txType = direction === "owed_to_me" ? "expense" : "income";

  return {
    ok: true,
    payload,
    proof: {
      action: "debt.create",
      version: VERSION,
      validation_status: "pass",
      ledger_mode: ledgerMode,
      expected_debt_rows: 1,
      expected_transaction_rows: ledgerMode === "with_ledger" ? 1 : 0,
      direction,
      account_effect: ledgerMode === "with_ledger"
        ? direction === "owed_to_me"
          ? "selected_account_decreases"
          : "selected_account_increases"
        : "none",
      transaction_type: ledgerMode === "with_ledger" ? txType : null,
      category_id: DEBT_CATEGORY
    }
  };
}

async function createDebt(db, payload) {
  const now = new Date().toISOString();
  const debtColumns = await getColumns(db, "debts");

  const debtInsert = buildInsert("debts", debtColumns, {
    id: payload.id,
    name: payload.name,
    kind: payload.kind,
    original_amount: payload.original_amount,
    paid_amount: payload.paid_amount,
    snowball_order: payload.snowball_order,
    due_date: payload.due_date,
    due_day: payload.due_day,
    installment_amount: payload.installment_amount,
    frequency: payload.frequency,
    last_paid_date: payload.last_paid_date,
    status: payload.status,
    notes: payload.notes,
    created_at: now
  });

  const statements = [
    db.prepare(debtInsert.sql).bind(...debtInsert.values)
  ];

  let ledgerTransaction = null;

  if (payload.ledger_mode === "with_ledger") {
    const txColumns = await getColumns(db, "transactions");
    const txId = makeId(payload.direction === "owed_to_me" ? "tx_debt_out" : "tx_debt_in");
    const txType = payload.direction === "owed_to_me" ? "expense" : "income";

    const txNotes = [
      payload.direction === "owed_to_me" ? "Debt created: money out" : "Debt created: money received",
      `debt_id=${payload.id}`,
      payload.notes ? `notes=${payload.notes}` : null
    ].filter(Boolean).join(" | ");

    const txInsert = buildInsert("transactions", txColumns, {
      id: txId,
      date: payload.movement_date,
      type: txType,
      amount: payload.original_amount,
      account_id: payload.account_id,
      transfer_to_account_id: null,
      category_id: DEBT_CATEGORY,
      notes: txNotes,
      fee_amount: 0,
      pra_amount: 0,
      created_at: now,
      reversed_by: null,
      reversed_at: null,
      linked_txn_id: null
    });

    statements.push(db.prepare(txInsert.sql).bind(...txInsert.values));

    ledgerTransaction = {
      id: txId,
      type: txType,
      amount: payload.original_amount,
      account_id: payload.account_id,
      category_id: DEBT_CATEGORY,
      effect: payload.direction === "owed_to_me" ? "decrease_account" : "increase_account"
    };
  }

  await db.batch(statements);

  const created = await readDebt(db, payload.id);

  return {
    id: payload.id,
    debt: normalizeDebt(created),
    ledger_transaction: ledgerTransaction
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

function sumRemaining(rows) {
  return rows.reduce((sum, row) => sum + Number(row.remaining_amount || 0), 0);
}

async function resolveAccount(db, input) {
  const raw = clean(input);

  const exact = await db.prepare(`
    SELECT id, name, kind, type, status
    FROM accounts
    WHERE id = ?
      AND ${ACTIVE_ACCOUNT_CONDITION}
    LIMIT 1
  `).bind(raw).first();

  if (exact?.id) return { ok: true, account: exact };

  return {
    ok: false,
    status: 409,
    error: "Account not found or inactive."
  };
}

async function requireCategoryIfExists(db, id) {
  try {
    const category = await db.prepare(`SELECT id FROM categories WHERE id = ?`).bind(id).first();
    if (!category?.id) {
      return { ok: false, status: 409, error: `Required category missing: ${id}` };
    }
  } catch (err) {
    return { ok: false, status: 409, error: "Category validation failed." };
  }

  return { ok: true };
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

function normalizeDirection(value) {
  const text = clean(value).toLowerCase();

  if (["i_owe", "owe", "payable", "debt", "debt_out"].includes(text)) return "i_owe";
  if (["owed_to_me", "owed", "owed_me", "receivable", "to_me", "debt_in"].includes(text)) return "owed_to_me";

  return "";
}

function normalizeKind(value) {
  const text = clean(value).toLowerCase();

  if (["i_owe", "owe", "payable", "debt", "debt_out"].includes(text)) return "owe";
  if (["owed_to_me", "owed", "owed_me", "receivable", "to_me", "debt_in"].includes(text)) return "owed";

  return "owe";
}

function normalizeLedgerMode(value) {
  if (value === true) return "with_ledger";
  const text = clean(value).toLowerCase();
  if (["1", "true", "yes", "with_ledger", "ledger", "money_moved"].includes(text)) return "with_ledger";
  return "debt_only";
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
  return n;
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
