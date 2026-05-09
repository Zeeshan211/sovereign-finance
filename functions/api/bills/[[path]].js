/* Sovereign Finance Bills API v0.2.0
   Ship 5: Bills backend save hardening

   Contract:
   - No undefined values are ever bound into D1.
   - GET /api/bills returns bills.
   - GET /api/bills/:id returns one bill.
   - PUT /api/bills/:id safely updates supported bill config fields.
   - POST /api/bills/:id/pay marks a recurring bill paid for a real date/account.
   - DELETE is soft-delete only.
*/

const VERSION = "0.2.0";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function db(env) {
  return env.DB || env.SOVEREIGN_DB || env.FINANCE_DB;
}

function cleanString(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim();
  return s === "" ? fallback : s;
}

function cleanNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function dateOnly(value, fallback = null) {
  const raw = cleanString(value, null);
  if (!raw) return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

function pathId(context) {
  const parts = context.params && context.params.path ? context.params.path : [];
  return Array.isArray(parts) ? parts[0] || "" : String(parts || "");
}

function subAction(context) {
  const parts = context.params && context.params.path ? context.params.path : [];
  return Array.isArray(parts) ? parts[1] || "" : "";
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function listBills(database) {
  const result = await database.prepare(`
    SELECT
      id,
      name,
      amount,
      due_day,
      frequency,
      category_id,
      default_account_id,
      last_paid_date,
      auto_post,
      status,
      deleted_at,
      last_paid_account_id
    FROM bills
    ORDER BY
      CASE WHEN status = 'deleted' THEN 1 ELSE 0 END,
      due_day IS NULL,
      due_day ASC,
      name ASC
  `).all();

  return result.results || [];
}

async function getBill(database, id) {
  return await database.prepare(`
    SELECT
      id,
      name,
      amount,
      due_day,
      frequency,
      category_id,
      default_account_id,
      last_paid_date,
      auto_post,
      status,
      deleted_at,
      last_paid_account_id
    FROM bills
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function updateBill(database, id, input) {
  const current = await getBill(database, id);
  if (!current) return null;

  const amount = cleanNumber(input.amount, current.amount);
  const dueDay = cleanNumber(input.due_day, current.due_day);
  const frequency = cleanString(input.frequency, current.frequency || "monthly");
  const categoryId = cleanString(input.category_id, current.category_id);
  const defaultAccountId = cleanString(
    input.default_account_id ?? input.payment_account_id ?? input.account_id,
    current.default_account_id
  );
  const lastPaidDate = dateOnly(input.last_paid_date, current.last_paid_date);
  const lastPaidAccountId = cleanString(
    input.last_paid_account_id ?? input.paid_from_account_id,
    current.last_paid_account_id || defaultAccountId
  );
  const autoPost = input.auto_post === undefined || input.auto_post === null
    ? current.auto_post
    : cleanNumber(input.auto_post, current.auto_post);
  const status = cleanString(input.status, current.status || "active");

  await database.prepare(`
    UPDATE bills
    SET
      amount = ?,
      due_day = ?,
      frequency = ?,
      category_id = ?,
      default_account_id = ?,
      last_paid_date = ?,
      auto_post = ?,
      status = ?,
      last_paid_account_id = ?
    WHERE id = ?
  `).bind(
    amount,
    dueDay,
    frequency,
    categoryId,
    defaultAccountId,
    lastPaidDate,
    autoPost,
    status,
    lastPaidAccountId,
    id
  ).run();

  return await getBill(database, id);
}

async function markPaid(database, id, input) {
  const current = await getBill(database, id);
  if (!current) return null;

  const paidDate = dateOnly(input.paid_date || input.last_paid_date || new Date(), new Date().toISOString().slice(0, 10));
  const paidAccountId = cleanString(
    input.account_id || input.payment_account_id || input.last_paid_account_id || input.paid_from_account_id,
    current.default_account_id || current.last_paid_account_id || "cash"
  );

  await database.prepare(`
    UPDATE bills
    SET
      last_paid_date = ?,
      last_paid_account_id = ?,
      default_account_id = COALESCE(default_account_id, ?),
      status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'active' END
    WHERE id = ?
  `).bind(
    paidDate,
    paidAccountId,
    paidAccountId,
    id
  ).run();

  return await getBill(database, id);
}

async function softDelete(database, id) {
  const now = new Date().toISOString();

  await database.prepare(`
    UPDATE bills
    SET status = 'deleted', deleted_at = ?
    WHERE id = ?
  `).bind(now, id).run();

  return await getBill(database, id);
}

export async function onRequestGet(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  const id = pathId(context);

  if (id) {
    const bill = await getBill(database, id);
    if (!bill) return json({ ok: false, version: VERSION, error: "Bill not found" }, 404);
    return json({ ok: true, version: VERSION, bill });
  }

  const bills = await listBills(database);
  return json({ ok: true, version: VERSION, bills });
}

export async function onRequestPut(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  const id = pathId(context);
  if (!id) return json({ ok: false, version: VERSION, error: "Bill id required" }, 400);

  const input = await bodyJson(context.request);
  const bill = await updateBill(database, id, input);

  if (!bill) return json({ ok: false, version: VERSION, error: "Bill not found" }, 404);

  return json({ ok: true, version: VERSION, bill });
}

export async function onRequestPost(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  const id = pathId(context);
  const action = subAction(context);
  const input = await bodyJson(context.request);

  if (id && action === "pay") {
    const bill = await markPaid(database, id, input);
    if (!bill) return json({ ok: false, version: VERSION, error: "Bill not found" }, 404);
    return json({ ok: true, version: VERSION, bill });
  }

  return json({
    ok: false,
    version: VERSION,
    error: "Unsupported POST route. Use /api/bills/:id/pay."
  }, 400);
}

export async function onRequestDelete(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  const id = pathId(context);
  if (!id) return json({ ok: false, version: VERSION, error: "Bill id required" }, 400);

  const bill = await softDelete(database, id);
  return json({ ok: true, version: VERSION, bill });
}
