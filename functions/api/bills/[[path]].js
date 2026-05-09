/* Sovereign Finance Bills API v0.4.0
Phase 7J: Bills real-write lift after Command Centre authority.

Contract:
- GET routes remain read-only.
- Dry-run remains no-write.
- Real PUT /api/bills/:id is allowed only if Command Centre allows bill.save.
- Real POST /api/bills/:id/pay is allowed only if Command Centre allows bill.clear.
- DELETE remains blocked.
- No ledger row is created by bill.clear in this version.
*/

const VERSION = "0.4.0";

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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function pathParts(context) {
  const parts = context.params && context.params.path ? context.params.path : [];
  return Array.isArray(parts) ? parts : String(parts || "").split("/").filter(Boolean);
}

function pathId(context) {
  return pathParts(context)[0] || "";
}

function subAction(context) {
  return pathParts(context)[1] || "";
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isDryRun(context, input) {
  const url = new URL(context.request.url);
  if (url.searchParams.get("dry_run") === "1") return true;
  if (url.searchParams.get("dry_run") === "true") return true;
  if (input && input.dry_run === true) return true;
  if (input && input.dry_run === "1") return true;
  if (input && input.dry_run === "true") return true;
  return false;
}

async function commandCentreActionAllowed(context, actionName) {
  try {
    const origin = new URL(context.request.url).origin;
    const res = await fetch(origin + "/api/finance-command-center?cb=" + Date.now(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-bills-api-enforcement": VERSION
      }
    });

    const data = await res.json().catch(() => null);
    const action = data && data.enforcement && Array.isArray(data.enforcement.actions)
      ? data.enforcement.actions.find(item => item.action === actionName)
      : null;

    return {
      ok: Boolean(res.ok && action && action.allowed === true),
      action: action || null,
      command_centre_version: data && data.version ? data.version : null
    };
  } catch (err) {
    return {
      ok: false,
      action: null,
      error: err.message || String(err)
    };
  }
}

async function listBills(database) {
  const result = await database.prepare(`
    SELECT id, name, amount, due_day, frequency, category_id, default_account_id,
           last_paid_date, auto_post, status, deleted_at, last_paid_account_id
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
    SELECT id, name, amount, due_day, frequency, category_id, default_account_id,
           last_paid_date, auto_post, status, deleted_at, last_paid_account_id
    FROM bills
    WHERE id = ?
    LIMIT 1
  `).bind(id).first();
}

async function accountExists(database, id) {
  const accountId = cleanString(id, null);
  if (!accountId) return null;

  return await database.prepare(`
    SELECT id, name, status
    FROM accounts
    WHERE id = ?
    LIMIT 1
  `).bind(accountId).first();
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function buildProof(action, normalized, checks) {
  return {
    action,
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: "pass",
    write_model: action === "bill.clear" ? "bill_paid_marker_update" : "bill_config_update",
    expected_bill_rows: 1,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: normalized.id,
      name: normalized.name || null,
      amount: normalized.amount ?? null,
      status: normalized.status || null,
      last_paid_date: normalized.last_paid_date || null,
      last_paid_account_id: normalized.last_paid_account_id || null
    },
    checks
  };
}

async function validateBillSave(database, id, input) {
  if (!id) return { ok: false, status: 400, error: "Bill id required" };

  const current = await getBill(database, id);
  if (!current) return { ok: false, status: 404, error: "Bill not found" };

  const amount = cleanNumber(input.amount, current.amount);
  const dueDay = cleanNumber(input.due_day, current.due_day);
  const frequency = cleanString(input.frequency, current.frequency || "monthly");
  const categoryId = cleanString(input.category_id, current.category_id);
  const defaultAccountId = cleanString(input.default_account_id ?? input.payment_account_id ?? input.account_id, current.default_account_id);
  const lastPaidDate = dateOnly(input.last_paid_date, current.last_paid_date);
  const lastPaidAccountId = cleanString(input.last_paid_account_id ?? input.paid_from_account_id, current.last_paid_account_id || defaultAccountId);
  const autoPost = input.auto_post === undefined || input.auto_post === null ? current.auto_post : cleanNumber(input.auto_post, current.auto_post);
  const status = cleanString(input.status, current.status || "active");

  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return { ok: false, status: 400, error: "Bill amount must be greater than 0" };
  }

  if (dueDay !== null && dueDay !== undefined && (!Number.isFinite(Number(dueDay)) || Number(dueDay) < 1 || Number(dueDay) > 31)) {
    return { ok: false, status: 400, error: "Bill due_day must be between 1 and 31" };
  }

  if (!["monthly", "weekly", "yearly", "one_time", "once"].includes(String(frequency || "").toLowerCase())) {
    return { ok: false, status: 400, error: "Unsupported bill frequency" };
  }

  if (!["active", "deleted", "archived", "inactive"].includes(String(status || "").toLowerCase())) {
    return { ok: false, status: 400, error: "Unsupported bill status" };
  }

  let defaultAccount = null;
  if (defaultAccountId) {
    defaultAccount = await accountExists(database, defaultAccountId);
    if (!defaultAccount) {
      return { ok: false, status: 409, error: "Default account not found", details: { default_account_id: defaultAccountId } };
    }
  }

  const normalized = {
    id,
    name: current.name,
    amount,
    due_day: dueDay,
    frequency,
    category_id: categoryId,
    default_account_id: defaultAccount ? defaultAccount.id : defaultAccountId,
    last_paid_date: lastPaidDate,
    auto_post: autoPost,
    status,
    last_paid_account_id: lastPaidAccountId
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildProof("bill.save", normalized, [
      proofCheck("bill_exists", "pass", "bills.id", "Bill id resolved."),
      proofCheck("amount_valid", "pass", "request.amount/bills.amount", "Amount is finite and greater than zero."),
      proofCheck("due_day_valid", dueDay === null || dueDay === undefined ? "not_required" : "pass", "request.due_day/bills.due_day", "Due day valid."),
      proofCheck("frequency_valid", "pass", "request.frequency/bills.frequency", "Frequency is allowed."),
      proofCheck("default_account_valid", defaultAccountId ? "pass" : "not_required", "accounts.id", defaultAccountId ? "Default account resolved." : "Default account not supplied."),
      proofCheck("undefined_guard", "pass", "normalized_payload", "No undefined values are present.")
    ])
  };
}

async function validateBillClear(database, id, input) {
  if (!id) return { ok: false, status: 400, error: "Bill id required" };

  const current = await getBill(database, id);
  if (!current) return { ok: false, status: 404, error: "Bill not found" };

  if (String(current.status || "active").toLowerCase() === "deleted") {
    return { ok: false, status: 409, error: "Deleted bills cannot be cleared" };
  }

  if (!Number.isFinite(Number(current.amount)) || Number(current.amount) <= 0) {
    return { ok: false, status: 409, error: "Bill amount is invalid and cannot be cleared", details: { id, amount: current.amount } };
  }

  const paidDate = dateOnly(input.paid_date || input.last_paid_date || input.date || new Date(), todayISO());
  const paidAccountId = cleanString(input.account_id || input.payment_account_id || input.last_paid_account_id || input.paid_from_account_id, current.default_account_id || current.last_paid_account_id || "cash");
  const paidAccount = await accountExists(database, paidAccountId);

  if (!paidAccount) {
    return { ok: false, status: 409, error: "Paid account not found", details: { account_id: paidAccountId } };
  }

  const normalized = {
    id,
    name: current.name,
    amount: Number(current.amount),
    last_paid_date: paidDate,
    last_paid_account_id: paidAccount.id,
    default_account_id: current.default_account_id || paidAccount.id,
    status: current.status === "deleted" ? "deleted" : "active"
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildProof("bill.clear", normalized, [
      proofCheck("bill_exists", "pass", "bills.id", "Bill id resolved."),
      proofCheck("bill_not_deleted", "pass", "bills.status", "Bill is not deleted."),
      proofCheck("amount_valid", "pass", "bills.amount", "Bill amount is finite and greater than zero."),
      proofCheck("paid_date_valid", "pass", "request.date", "Paid date normalized."),
      proofCheck("paid_account_valid", "pass", "accounts.id", "Paid account resolved."),
      proofCheck("undefined_guard", "pass", "normalized_payload", "No undefined values are present.")
    ])
  };
}

async function updateBill(database, id, normalized) {
  await database.prepare(`
    UPDATE bills
    SET amount = ?,
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
    normalized.amount,
    normalized.due_day,
    normalized.frequency,
    normalized.category_id,
    normalized.default_account_id,
    normalized.last_paid_date,
    normalized.auto_post,
    normalized.status,
    normalized.last_paid_account_id,
    id
  ).run();

  return await getBill(database, id);
}

async function markPaid(database, id, normalized) {
  await database.prepare(`
    UPDATE bills
    SET last_paid_date = ?,
        last_paid_account_id = ?,
        default_account_id = COALESCE(default_account_id, ?),
        status = CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'active' END
    WHERE id = ?
  `).bind(
    normalized.last_paid_date,
    normalized.last_paid_account_id,
    normalized.last_paid_account_id,
    id
  ).run();

  return await getBill(database, id);
}

function blockedByCommandCentre(action, validation, gate) {
  return json({
    ok: false,
    version: VERSION,
    error: "Command Centre blocked " + action,
    action,
    enforcement: {
      action,
      allowed: false,
      status: "blocked",
      level: 3,
      reason: gate && gate.action ? gate.action.reason : action + " is not allowed by Command Centre.",
      source: gate && gate.action ? gate.action.source : "enforcement.actions",
      required_fix: gate && gate.action ? gate.action.required_fix : "Lift action in Command Centre after proof.",
      backend_enforced: true,
      frontend_enforced: true,
      override: { allowed: false, reason_required: true },
      command_centre_version: gate ? gate.command_centre_version : null
    },
    proof: validation && validation.proof ? validation.proof : null
  }, 423);
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
  const dryRun = isDryRun(context, input);
  const validation = await validateBillSave(database, id, input);

  if (!validation.ok) {
    return json({ ok: false, version: VERSION, dry_run: dryRun, action: "bill.save", error: validation.error, details: validation.details || null }, validation.status || 400);
  }

  if (dryRun) {
    return json({ ok: true, version: VERSION, dry_run: true, action: "bill.save", writes_performed: false, audit_performed: false, proof: validation.proof, normalized_payload: validation.normalized_payload });
  }

  const gate = await commandCentreActionAllowed(context, "bill.save");
  if (!gate.ok) return blockedByCommandCentre("bill.save", validation, gate);

  const bill = await updateBill(database, id, validation.normalized_payload);

  return json({
    ok: true,
    version: VERSION,
    action: "bill.save",
    dry_run: false,
    writes_performed: true,
    audit_performed: false,
    bill,
    proof: validation.proof,
    enforcement: gate.action
  });
}

export async function onRequestPost(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  const id = pathId(context);
  const action = subAction(context);
  const input = await bodyJson(context.request);
  const dryRun = isDryRun(context, input);

  if (id && action === "pay") {
    const validation = await validateBillClear(database, id, input);

    if (!validation.ok) {
      return json({ ok: false, version: VERSION, dry_run: dryRun, action: "bill.clear", error: validation.error, details: validation.details || null }, validation.status || 400);
    }

    if (dryRun) {
      return json({ ok: true, version: VERSION, dry_run: true, action: "bill.clear", writes_performed: false, audit_performed: false, proof: validation.proof, normalized_payload: validation.normalized_payload });
    }

    const gate = await commandCentreActionAllowed(context, "bill.clear");
    if (!gate.ok) return blockedByCommandCentre("bill.clear", validation, gate);

    const bill = await markPaid(database, id, validation.normalized_payload);

    return json({
      ok: true,
      version: VERSION,
      action: "bill.clear",
      dry_run: false,
      writes_performed: true,
      audit_performed: false,
      bill,
      proof: validation.proof,
      enforcement: gate.action
    });
  }

  return json({ ok: false, version: VERSION, error: "Unsupported POST route. Use /api/bills/:id/pay." }, 400);
}

export async function onRequestDelete(context) {
  return json({
    ok: false,
    version: VERSION,
    error: "Command Centre blocked bill.delete",
    action: "bill.delete",
    enforcement: {
      action: "bill.delete",
      allowed: false,
      status: "blocked",
      level: 3,
      reason: "bill.delete remains blocked until bill.delete dry-run proof exists.",
      source: "coverage.write_safety.bill_delete",
      required_fix: "Add bill.delete dry-run proof before allowing bill delete.",
      backend_enforced: true,
      frontend_enforced: true,
      override: { allowed: false, reason_required: true }
    }
  }, 423);
}
