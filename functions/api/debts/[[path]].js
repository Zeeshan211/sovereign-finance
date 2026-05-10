/* Sovereign Finance Debts API v0.3.0
   Debt Phase 1: debt dry-run proof.

   Contract:
   - GET /api/debts remains read-only.
   - GET /api/debts/:id remains read-only.
   - PUT /api/debts/:id?dry_run=1 validates debt.save with no D1 writes.
   - POST /api/debts?dry_run=1 validates debt.save/create with no D1 writes.
   - POST /api/debts/:id/pay?dry_run=1 validates debt.pay with no D1 writes.
   - Real debt writes remain blocked until Command Centre recognizes debt proof and lifts debt actions.
   - Dry-run performs no debt writes, no ledger writes, no transaction writes, and no audit writes.
   - No undefined values are bound into D1.
*/

const VERSION = "0.3.0";

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

function pathParts(context) {
  const value = context.params && context.params.path ? context.params.path : [];
  return Array.isArray(value) ? value : String(value || "").split("/").filter(Boolean);
}

function pathId(context) {
  return pathParts(context)[0] || "";
}

function subAction(context) {
  return pathParts(context)[1] || "";
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function cleanString(value, fallback = null, max = 500) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().slice(0, max);
  return text === "" ? fallback : text;
}

function cleanNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanDate(value, fallback = null) {
  const text = cleanString(value, null, 40);
  if (!text) return fallback;

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return fallback;

  return date.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isDryRun(context, body) {
  const url = new URL(context.request.url);
  return (
    url.searchParams.get("dry_run") === "1" ||
    url.searchParams.get("dry_run") === "true" ||
    body.dry_run === true ||
    body.dry_run === "1" ||
    body.dry_run === "true"
  );
}

function normalizeKind(value, fallback = null) {
  const kind = cleanString(value, fallback, 40);
  if (!kind) return null;

  const lowered = kind.toLowerCase();

  if (["owe", "payable", "debt_out", "out"].includes(lowered)) return "owe";
  if (["owed", "receivable", "debt_in", "in"].includes(lowered)) return "owed";

  return lowered;
}

function normalizeFrequency(value, fallback = "custom") {
  const frequency = cleanString(value, fallback, 40).toLowerCase();

  if (["monthly", "weekly", "yearly", "custom", "one_time", "once"].includes(frequency)) {
    return frequency;
  }

  return "custom";
}

function normalizeStatus(value, fallback = "active") {
  const status = cleanString(value, fallback, 40).toLowerCase();

  if (["active", "inactive", "closed", "deleted", "paid_off"].includes(status)) {
    return status;
  }

  return fallback;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function dateFromISO(value) {
  const text = cleanDate(value, null);
  if (!text) return null;

  const date = new Date(text + "T00:00:00Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

function computeNextDueDate(row) {
  if (toNumber(row.remaining_amount) <= 0) return null;

  const dueDate = cleanDate(row.due_date, null);
  if (dueDate) return dueDate;

  const dueDay = cleanNumber(row.due_day, null);
  if (!dueDay || dueDay < 1 || dueDay > 31) return null;

  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();

  let candidate = new Date(Date.UTC(year, month, Math.min(dueDay, 28)));
  if (candidate < new Date(Date.UTC(year, month, now.getUTCDate()))) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = new Date(Date.UTC(year, month, Math.min(dueDay, 28)));
  }

  return candidate.toISOString().slice(0, 10);
}

function decorateDebt(row) {
  const original = toNumber(row.original_amount);
  const paid = toNumber(row.paid_amount);
  const remaining = Number.isFinite(Number(row.remaining_amount))
    ? toNumber(row.remaining_amount)
    : Math.max(0, original - paid);

  const nextDueDate = computeNextDueDate({ ...row, remaining_amount: remaining });
  const due = dateFromISO(nextDueDate);
  const today = dateFromISO(todayISO());
  let daysUntilDue = null;
  let daysOverdue = 0;
  let dueStatus = "unscheduled";

  if (remaining <= 0) {
    dueStatus = "paid_off";
  } else if (due && today) {
    const diff = Math.ceil((due.getTime() - today.getTime()) / 86400000);
    daysUntilDue = diff >= 0 ? diff : 0;
    daysOverdue = diff < 0 ? Math.abs(diff) : 0;
    dueStatus = diff < 0 ? "overdue" : "scheduled";
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    original_amount: original,
    paid_amount: paid,
    remaining_amount: remaining,
    snowball_order: row.snowball_order === null || row.snowball_order === undefined ? null : Number(row.snowball_order),
    due_date: row.due_date || null,
    due_day: row.due_day === null || row.due_day === undefined ? null : Number(row.due_day),
    installment_amount: row.installment_amount === null || row.installment_amount === undefined ? null : Number(row.installment_amount),
    frequency: row.frequency || "custom",
    last_paid_date: row.last_paid_date || null,
    next_due_date: nextDueDate,
    days_until_due: daysUntilDue,
    days_overdue: daysOverdue,
    due_status: dueStatus,
    schedule_missing: !nextDueDate && remaining > 0,
    status: row.status || "active",
    notes: row.notes || "",
    created_at: row.created_at || null
  };
}

async function listDebts(database) {
  const result = await database.prepare(`
    SELECT
      id,
      name,
      kind,
      original_amount,
      paid_amount,
      remaining_amount,
      snowball_order,
      due_date,
      due_day,
      installment_amount,
      frequency,
      last_paid_date,
      status,
      notes,
      created_at
    FROM debts
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      CASE WHEN kind = 'owe' THEN 0 ELSE 1 END,
      COALESCE(snowball_order, 999),
      COALESCE(due_date, ''),
      LOWER(COALESCE(name, id))
  `).all();

  return (result.results || []).map(decorateDebt);
}

async function getDebt(database, id) {
  const debtId = cleanString(id, null, 180);
  if (!debtId) return null;

  const row = await database.prepare(`
    SELECT
      id,
      name,
      kind,
      original_amount,
      paid_amount,
      remaining_amount,
      snowball_order,
      due_date,
      due_day,
      installment_amount,
      frequency,
      last_paid_date,
      status,
      notes,
      created_at
    FROM debts
    WHERE id = ?
    LIMIT 1
  `).bind(debtId).first();

  return row ? decorateDebt(row) : null;
}

async function accountExists(database, id) {
  const accountId = cleanString(id, null, 180);
  if (!accountId) return null;

  return await database.prepare(`
    SELECT id, name, kind, status
    FROM accounts
    WHERE id = ?
    LIMIT 1
  `).bind(accountId).first();
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function buildDebtProof(action, normalized, checks) {
  return {
    action,
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: "pass",
    write_model: action === "debt.pay" ? "debt_payment_update_without_ledger_in_dry_run" : "debt_save_update_or_create",
    expected_debt_rows: 1,
    expected_ledger_rows: 0,
    expected_transaction_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: normalized.id || null,
      name: normalized.name || null,
      kind: normalized.kind || null,
      original_amount: normalized.original_amount ?? null,
      paid_amount: normalized.paid_amount ?? null,
      remaining_amount: normalized.remaining_amount ?? null,
      payment_amount: normalized.payment_amount ?? null,
      status: normalized.status || null
    },
    checks,
    lift_candidate: {
      coverage_key: action === "debt.pay" ? "coverage.write_safety.debt_pay" : "coverage.write_safety.debt_save",
      current_expected_state: "blocked",
      required_next_state: "dry_run_available",
      reason: action + " dry-run validates without writing debt, ledger, transaction, or audit rows."
    }
  };
}

async function validateDebtSave(database, id, body, mode) {
  const existing = id ? await getDebt(database, id) : null;

  if (id && !existing) {
    return {
      ok: false,
      status: 404,
      error: "Debt not found",
      details: { id }
    };
  }

  const name = cleanString(body.name, existing ? existing.name : null, 180);
  const kind = normalizeKind(body.kind || body.direction || body.type, existing ? existing.kind : null);
  const originalAmount = cleanNumber(
    body.original_amount ?? body.amount,
    existing ? existing.original_amount : null
  );
  const paidAmount = cleanNumber(body.paid_amount, existing ? existing.paid_amount : 0);
  const remainingAmountInput = cleanNumber(body.remaining_amount, null);
  const remainingAmount = remainingAmountInput === null && originalAmount !== null && paidAmount !== null
    ? Math.max(0, originalAmount - paidAmount)
    : remainingAmountInput;
  const dueDate = cleanDate(body.due_date, existing ? existing.due_date : null);
  const dueDay = cleanNumber(body.due_day, existing ? existing.due_day : null);
  const installmentAmount = cleanNumber(body.installment_amount, existing ? existing.installment_amount : null);
  const frequency = normalizeFrequency(body.frequency, existing ? existing.frequency : "custom");
  const status = normalizeStatus(body.status, existing ? existing.status : "active");
  const notes = cleanString(body.notes, existing ? existing.notes : "", 1000);
  const snowballOrder = cleanNumber(body.snowball_order, existing ? existing.snowball_order : null);

  if (!name) {
    return { ok: false, status: 400, error: "Debt name is required" };
  }

  if (!["owe", "owed"].includes(kind)) {
    return {
      ok: false,
      status: 400,
      error: "Debt kind must be owe or owed",
      details: { kind }
    };
  }

  if (!Number.isFinite(Number(originalAmount)) || Number(originalAmount) <= 0) {
    return {
      ok: false,
      status: 400,
      error: "Debt original_amount must be greater than 0"
    };
  }

  if (!Number.isFinite(Number(paidAmount)) || Number(paidAmount) < 0) {
    return {
      ok: false,
      status: 400,
      error: "Debt paid_amount must be 0 or greater"
    };
  }

  if (!Number.isFinite(Number(remainingAmount)) || Number(remainingAmount) < 0) {
    return {
      ok: false,
      status: 400,
      error: "Debt remaining_amount must be 0 or greater"
    };
  }

  if (Number(paidAmount) > Number(originalAmount)) {
    return {
      ok: false,
      status: 400,
      error: "Debt paid_amount cannot exceed original_amount"
    };
  }

  if (dueDay !== null && (!Number.isFinite(Number(dueDay)) || Number(dueDay) < 1 || Number(dueDay) > 31)) {
    return {
      ok: false,
      status: 400,
      error: "Debt due_day must be between 1 and 31"
    };
  }

  const normalized = {
    action: "debt.save",
    mode,
    id: id || cleanString(body.id, null, 180) || null,
    name,
    kind,
    original_amount: Number(originalAmount),
    paid_amount: Number(paidAmount),
    remaining_amount: Number(remainingAmount),
    snowball_order: snowballOrder,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    status,
    notes
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildDebtProof("debt.save", normalized, [
      proofCheck("debt_identity_valid", "pass", "request.id/name", existing ? "Existing debt id resolved." : "Debt create/update payload has a name."),
      proofCheck("kind_valid", "pass", "request.kind", "Debt kind is owe or owed."),
      proofCheck("amounts_valid", "pass", "request.amounts", "Original, paid, and remaining amounts are numerically safe."),
      proofCheck("schedule_valid", dueDate || dueDay ? "pass" : "not_required", "request.due_date/due_day", dueDate || dueDay ? "Schedule field is valid." : "No schedule supplied."),
      proofCheck("undefined_guard", "pass", "normalized_payload", "No undefined values are present in normalized debt.save payload."),
      proofCheck("dry_run_no_write", "pass", "api.contract", "Dry-run returns before any D1 mutation.")
    ])
  };
}

async function validateDebtPay(database, id, body) {
  const debt = await getDebt(database, id);

  if (!debt) {
    return {
      ok: false,
      status: 404,
      error: "Debt not found",
      details: { id }
    };
  }

  if (!["owe", "owed"].includes(debt.kind)) {
    return {
      ok: false,
      status: 409,
      error: "Debt kind is invalid",
      details: { id, kind: debt.kind }
    };
  }

  if (String(debt.status || "active").toLowerCase() !== "active") {
    return {
      ok: false,
      status: 409,
      error: "Only active debts can be paid",
      details: { id, status: debt.status }
    };
  }

  const remaining = cleanNumber(debt.remaining_amount, 0);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return {
      ok: false,
      status: 409,
      error: "Debt has no remaining amount to pay",
      details: { id, remaining_amount: remaining }
    };
  }

  const paymentAmount = cleanNumber(body.amount ?? body.payment_amount ?? body.paid_amount, null);
  if (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
    return {
      ok: false,
      status: 400,
      error: "Payment amount must be greater than 0"
    };
  }

  if (Number(paymentAmount) > Number(remaining)) {
    return {
      ok: false,
      status: 400,
      error: "Payment amount cannot exceed remaining_amount",
      details: {
        payment_amount: paymentAmount,
        remaining_amount: remaining
      }
    };
  }

  const accountId = cleanString(
    body.account_id || body.accountId || body.paid_from_account_id || body.received_to_account_id,
    null,
    180
  );

  if (!accountId) {
    return {
      ok: false,
      status: 400,
      error: "account_id is required for debt.pay"
    };
  }

  const account = await accountExists(database, accountId);

  if (!account) {
    return {
      ok: false,
      status: 409,
      error: "Account not found",
      details: { account_id: accountId }
    };
  }

  if (String(account.status || "active").toLowerCase() !== "active") {
    return {
      ok: false,
      status: 409,
      error: "Account is not active",
      details: { account_id: accountId, status: account.status }
    };
  }

  const paidDate = cleanDate(body.paid_date || body.date || body.payment_date, todayISO());
  const nextPaidAmount = Number(debt.paid_amount) + Number(paymentAmount);
  const nextRemainingAmount = Math.max(0, Number(debt.remaining_amount) - Number(paymentAmount));
  const nextDueStatus = nextRemainingAmount === 0 ? "paid_off" : debt.due_status || "scheduled";

  const normalized = {
    action: "debt.pay",
    id: debt.id,
    name: debt.name,
    kind: debt.kind,
    payment_amount: Number(paymentAmount),
    account_id: account.id,
    paid_date: paidDate,
    original_amount: Number(debt.original_amount),
    previous_paid_amount: Number(debt.paid_amount),
    previous_remaining_amount: Number(debt.remaining_amount),
    paid_amount: nextPaidAmount,
    remaining_amount: nextRemainingAmount,
    due_status: nextDueStatus,
    status: debt.status
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildDebtProof("debt.pay", normalized, [
      proofCheck("debt_exists", "pass", "debts.id", "Debt id resolved."),
      proofCheck("kind_valid", "pass", "debts.kind", "Debt kind is owe or owed."),
      proofCheck("debt_active", "pass", "debts.status", "Debt is active."),
      proofCheck("remaining_amount_valid", "pass", "debts.remaining_amount", "Debt has remaining amount greater than 0."),
      proofCheck("payment_amount_valid", "pass", "request.amount", "Payment amount is greater than 0 and does not exceed remaining_amount."),
      proofCheck("account_valid", "pass", "accounts.id", "Payment account exists and is active."),
      proofCheck("paid_date_valid", "pass", "request.paid_date", "Paid date normalized to YYYY-MM-DD."),
      proofCheck("recalculation_valid", "pass", "computed", "Next paid_amount and remaining_amount computed safely."),
      proofCheck("undefined_guard", "pass", "normalized_payload", "No undefined values are present in normalized debt.pay payload."),
      proofCheck("dry_run_no_write", "pass", "api.contract", "Dry-run returns before any D1 mutation.")
    ])
  };
}

function blockedRealWrite(action, validation) {
  return json({
    ok: false,
    version: VERSION,
    error: "Command Centre blocked real debt writes",
    action,
    enforcement: {
      action,
      allowed: false,
      status: "blocked",
      level: 3,
      reason: action + " real writes remain blocked until Debts page preflight and Command Centre lift are complete.",
      source: action === "debt.pay" ? "coverage.write_safety.debt_pay" : "coverage.write_safety.debt_save",
      required_fix: "Wire debt dry-run proof, make Command Centre recognize debt proof, then explicitly lift only safe debt actions.",
      backend_enforced: true,
      frontend_enforced: true,
      override: {
        allowed: false,
        reason_required: true
      }
    },
    proof: validation && validation.proof ? validation.proof : null
  }, 423);
}

export async function onRequestGet(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  try {
    const id = pathId(context);

    if (id) {
      const debt = await getDebt(database, id);
      if (!debt) return json({ ok: false, version: VERSION, error: "Debt not found" }, 404);
      return json({ ok: true, version: VERSION, debt });
    }

    const debts = await listDebts(database);
    return json({ ok: true, version: VERSION, debts });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPut(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  try {
    const id = pathId(context);
    if (!id) return json({ ok: false, version: VERSION, error: "Debt id required" }, 400);

    const body = await readBody(context.request);
    const dryRun = isDryRun(context, body);
    const validation = await validateDebtSave(database, id, body, "update");

    if (!validation.ok) {
      return json({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action: "debt.save",
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: "debt.save",
        writes_performed: false,
        audit_performed: false,
        proof: validation.proof,
        normalized_payload: validation.normalized_payload
      });
    }

    return blockedRealWrite("debt.save", validation);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  const database = db(context.env || {});
  if (!database) return json({ ok: false, version: VERSION, error: "D1 binding missing" }, 500);

  try {
    const id = pathId(context);
    const action = subAction(context);
    const body = await readBody(context.request);
    const dryRun = isDryRun(context, body);

    if (id && action === "pay") {
      const validation = await validateDebtPay(database, id, body);

      if (!validation.ok) {
        return json({
          ok: false,
          version: VERSION,
          dry_run: dryRun,
          action: "debt.pay",
          error: validation.error,
          details: validation.details || null
        }, validation.status || 400);
      }

      if (dryRun) {
        return json({
          ok: true,
          version: VERSION,
          dry_run: true,
          action: "debt.pay",
          writes_performed: false,
          audit_performed: false,
          proof: validation.proof,
          normalized_payload: validation.normalized_payload
        });
      }

      return blockedRealWrite("debt.pay", validation);
    }

    if (!id) {
      const validation = await validateDebtSave(database, null, body, "create");

      if (!validation.ok) {
        return json({
          ok: false,
          version: VERSION,
          dry_run: dryRun,
          action: "debt.save",
          error: validation.error,
          details: validation.details || null
        }, validation.status || 400);
      }

      if (dryRun) {
        return json({
          ok: true,
          version: VERSION,
          dry_run: true,
          action: "debt.save",
          writes_performed: false,
          audit_performed: false,
          proof: validation.proof,
          normalized_payload: validation.normalized_payload
        });
      }

      return blockedRealWrite("debt.save", validation);
    }

    return json({
      ok: false,
      version: VERSION,
      error: "Unsupported POST route. Use /api/debts/:id/pay or /api/debts?dry_run=1."
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestDelete() {
  return json({
    ok: false,
    version: VERSION,
    error: "Command Centre blocked debt.delete",
    action: "debt.delete",
    enforcement: {
      action: "debt.delete",
      allowed: false,
      status: "blocked",
      level: 3,
      reason: "debt.delete remains blocked until debt.delete dry-run proof exists.",
      source: "coverage.write_safety.debt_delete",
      required_fix: "Add debt.delete dry-run proof before allowing debt delete.",
      backend_enforced: true,
      frontend_enforced: true,
      override: {
        allowed: false,
        reason_required: true
      }
    }
  }, 423);
}
