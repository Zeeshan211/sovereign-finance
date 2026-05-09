// /api/bills v0.3.0
// Phase 7G Bills dry-run proof.
//
// Contract:
// - GET remains read-only and returns the existing bills shape.
// - POST dry_run validates bill.save / bill.clear only.
// - Dry-run performs no D1 writes and no audit writes.
// - Real bill writes remain blocked until Command Centre later lifts bill actions.
// - No ledger pollution.
// - Unknown stays Unknown.

const VERSION = '0.3.0';

const ACTIVE_ACCOUNT_CONDITION = "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const rows = await listBills(context.env.DB);

    return jsonResponse({
      ok: true,
      version: VERSION,
      bills: rows
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const url = new URL(context.request.url);
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(url, body);
    const action = normalizeAction(body.action || body.operation || body.intent || body.type || 'bill.save');

    const validation = await validateBillAction(context.env.DB, action, body);

    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action,
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action,
        writes_performed: false,
        audit_performed: false,
        proof: validation.proof,
        normalized_payload: validation.normalized_payload
      });
    }

    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Command Centre blocked real bill writes',
      action,
      enforcement: {
        action,
        allowed: false,
        status: 'blocked',
        level: 3,
        reason: 'bill.save and bill.clear real writes remain blocked until Bills page preflight and Command Centre lift are complete.',
        source: 'coverage.write_safety.bill_save',
        required_fix: 'Wire Bills page dry-run preflight, make Command Centre recognize bill proof, then explicitly lift only safe bill actions.',
        backend_enforced: true,
        frontend_enforced: true,
        override: {
          allowed: false,
          reason_required: true
        }
      },
      proof: validation.proof
    }, 423);
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function listBills(db) {
  const result = await db.prepare(
    `SELECT
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
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      COALESCE(due_day, 99),
      LOWER(COALESCE(name, id))`
  ).all();

  return (result.results || []).map(row => ({
    id: row.id,
    name: row.name,
    amount: toNumber(row.amount),
    due_day: row.due_day == null ? null : Number(row.due_day),
    frequency: row.frequency || 'monthly',
    category_id: row.category_id || null,
    default_account_id: row.default_account_id || null,
    last_paid_date: row.last_paid_date || null,
    auto_post: Number(row.auto_post || 0),
    status: row.status || 'active',
    deleted_at: row.deleted_at || null,
    last_paid_account_id: row.last_paid_account_id || null
  }));
}

async function validateBillAction(db, action, body) {
  if (!['bill.save', 'bill.clear'].includes(action)) {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported bill action',
      details: {
        allowed_actions: ['bill.save', 'bill.clear']
      }
    };
  }

  if (action === 'bill.clear') {
    return validateBillClear(db, body);
  }

  return validateBillSave(db, body);
}

async function validateBillSave(db, body) {
  const id = cleanText(body.id || body.bill_id || '', 160);
  const name = cleanText(body.name || body.bill_name || '', 160);
  const amount = Number(body.amount);
  const dueDayRaw = body.due_day ?? body.dueDay;
  const dueDay = dueDayRaw === null || dueDayRaw === '' || dueDayRaw === undefined ? null : Number(dueDayRaw);
  const frequency = cleanText(body.frequency || 'monthly', 40).toLowerCase();
  const categoryId = nullableText(body.category_id || body.categoryId);
  const defaultAccountId = nullableText(body.default_account_id || body.defaultAccountId || body.account_id || body.accountId);
  const status = cleanText(body.status || 'active', 40).toLowerCase();

  if (!name && !id) {
    return {
      ok: false,
      status: 400,
      error: 'Bill name or bill id required'
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'Bill amount must be greater than 0'
    };
  }

  if (dueDay !== null && (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 31)) {
    return {
      ok: false,
      status: 400,
      error: 'Bill due_day must be between 1 and 31'
    };
  }

  if (!['monthly', 'weekly', 'yearly', 'one_time', 'once'].includes(frequency)) {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported bill frequency',
      details: {
        allowed_frequencies: ['monthly', 'weekly', 'yearly', 'one_time', 'once']
      }
    };
  }

  if (!['active', 'deleted', 'archived', 'inactive'].includes(status)) {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported bill status',
      details: {
        allowed_statuses: ['active', 'deleted', 'archived', 'inactive']
      }
    };
  }

  let existingBill = null;

  if (id) {
    existingBill = await findBill(db, id);

    if (!existingBill) {
      return {
        ok: false,
        status: 404,
        error: 'Bill not found',
        details: {
          bill_id: id
        }
      };
    }
  }

  let defaultAccount = null;

  if (defaultAccountId) {
    defaultAccount = await findActiveAccount(db, defaultAccountId);

    if (!defaultAccount) {
      return {
        ok: false,
        status: 409,
        error: 'Default account not found or inactive',
        details: {
          default_account_id: defaultAccountId
        }
      };
    }
  }

  const normalized = {
    action: 'bill.save',
    id: id || null,
    name: name || (existingBill ? existingBill.name : null),
    amount,
    due_day: dueDay,
    frequency,
    category_id: categoryId,
    default_account_id: defaultAccount ? defaultAccount.id : defaultAccountId,
    status,
    existing_bill_found: Boolean(existingBill)
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildBillProof('bill.save', normalized, [
      proofCheck('bill_identity_valid', 'pass', 'request.id/name', id ? 'Existing bill id is valid.' : 'New/updated bill name is present.'),
      proofCheck('amount_valid', 'pass', 'request.amount', 'Amount is finite and greater than zero.'),
      proofCheck('due_day_valid', dueDay === null ? 'not_required' : 'pass', 'request.due_day', dueDay === null ? 'No due_day supplied.' : 'Due day is between 1 and 31.'),
      proofCheck('frequency_valid', 'pass', 'request.frequency', 'Frequency is allowed.'),
      proofCheck('default_account_valid', defaultAccountId ? 'pass' : 'not_required', 'accounts', defaultAccountId ? 'Default account resolved to active account.' : 'Default account not supplied.'),
      proofCheck('undefined_guard', 'pass', 'normalized_payload', 'Payload is normalized before any future D1 bind values are created.')
    ])
  };
}

async function validateBillClear(db, body) {
  const id = cleanText(body.id || body.bill_id || '', 160);
  const paidDate = normalizeDate(body.paid_date || body.last_paid_date || body.date);
  const accountId = nullableText(body.account_id || body.accountId || body.last_paid_account_id || body.default_account_id);

  if (!id) {
    return {
      ok: false,
      status: 400,
      error: 'bill_id required for bill.clear'
    };
  }

  const bill = await findBill(db, id);

  if (!bill) {
    return {
      ok: false,
      status: 404,
      error: 'Bill not found',
      details: {
        bill_id: id
      }
    };
  }

  if (String(bill.status || 'active').toLowerCase() !== 'active') {
    return {
      ok: false,
      status: 409,
      error: 'Only active bills can be cleared',
      details: {
        bill_id: id,
        status: bill.status
      }
    };
  }

  if (!Number.isFinite(Number(bill.amount)) || Number(bill.amount) <= 0) {
    return {
      ok: false,
      status: 409,
      error: 'Bill amount is invalid and cannot be cleared',
      details: {
        bill_id: id,
        amount: bill.amount
      }
    };
  }

  let paidAccount = null;

  if (accountId) {
    paidAccount = await findActiveAccount(db, accountId);

    if (!paidAccount) {
      return {
        ok: false,
        status: 409,
        error: 'Paid account not found or inactive',
        details: {
          account_id: accountId
        }
      };
    }
  }

  const normalized = {
    action: 'bill.clear',
    id: bill.id,
    name: bill.name,
    amount: Number(bill.amount),
    paid_date: paidDate,
    last_paid_account_id: paidAccount ? paidAccount.id : accountId || bill.default_account_id || null,
    status: bill.status || 'active'
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildBillProof('bill.clear', normalized, [
      proofCheck('bill_exists', 'pass', 'bills.id', 'Bill id resolved.'),
      proofCheck('bill_active', 'pass', 'bills.status', 'Bill is active.'),
      proofCheck('bill_amount_valid', 'pass', 'bills.amount', 'Bill amount is finite and greater than zero.'),
      proofCheck('paid_date_valid', 'pass', 'request.date', 'Paid date normalized to YYYY-MM-DD.'),
      proofCheck('paid_account_valid', accountId ? 'pass' : 'not_required', 'accounts', accountId ? 'Paid account resolved to active account.' : 'Paid account not supplied; existing/default bill account may be used later.'),
      proofCheck('undefined_guard', 'pass', 'normalized_payload', 'Payload is normalized before any future D1 bind values are created.')
    ])
  };
}

function buildBillProof(action, payload, checks) {
  return {
    action,
    version: VERSION,
    writes_performed: false,
    validation_status: 'pass',
    write_model: action === 'bill.clear' ? 'bill_clear_update_only' : 'bill_save_upsert_or_update',
    expected_bill_rows: 1,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    checks,
    normalized_summary: {
      id: payload.id || null,
      name: payload.name || null,
      amount: payload.amount || null,
      status: payload.status || null
    },
    lift_candidate: {
      coverage_key: action === 'bill.clear' ? 'coverage.write_safety.bill_clear' : 'coverage.write_safety.bill_save',
      current_expected_state: 'blocked',
      required_next_state: 'dry_run_available',
      reason: action + ' dry-run validates without writing bill, ledger, or audit rows.'
    }
  };
}

function proofCheck(check, status, source, detail) {
  return {
    check,
    status,
    source,
    detail
  };
}

async function findBill(db, id) {
  return db.prepare(
    `SELECT
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
    LIMIT 1`
  ).bind(id).first();
}

async function findActiveAccount(db, id) {
  const exact = await db.prepare(
    `SELECT id, name
    FROM accounts
    WHERE id = ?
    AND ${ACTIVE_ACCOUNT_CONDITION}
    LIMIT 1`
  ).bind(id).first();

  if (exact && exact.id) return exact;

  return null;
}

function normalizeAction(value) {
  const text = cleanText(value, 'bill.save', 80).toLowerCase();

  if (['clear', 'paid', 'pay', 'bill.clear', 'bill.pay'].includes(text)) return 'bill.clear';
  if (['save', 'upsert', 'update', 'create', 'bill.save'].includes(text)) return 'bill.save';

  return text;
}

function isDryRunRequest(url, body) {
  if (url.searchParams.get('dry_run') === '1') return true;
  if (url.searchParams.get('dry_run') === 'true') return true;
  if (body && body.dry_run === true) return true;
  if (body && body.dry_run === '1') return true;
  if (body && body.dry_run === 'true') return true;
  return false;
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);

  if (!raw) return todayISO();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return todayISO();

  return raw.slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nullableText(value) {
  const text = cleanText(value, '', 160);
  return text || null;
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
