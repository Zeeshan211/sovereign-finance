/* Sovereign Finance Debt Item Route v0.3.2-item
   /api/debts/:id

   Phase 4 prep:
   - GET remains read-only.
   - PUT dry_run remains safe.
   - PUT real write asks Command Centre before writing.
   - DELETE remains blocked unless dry_run.
   - No version bump.
*/

const VERSION = 'v0.3.2-item';
const ALLOWED_FREQUENCY = ['monthly', 'weekly', 'yearly', 'custom'];
const DUE_SOON_DAYS = 3;

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
    const db = context.env.DB;
    const id = safeText(context.params.id, '', 160);

    if (!id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt id required' }, 400);
    }

    const row = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(id).first();

    if (!row) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    return jsonResponse({
      ok: true,
      version: VERSION,
      debt: normalizeDebt(row)
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const id = safeText(context.params.id, '', 160);
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);

    if (!id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt id required' }, 400);
    }

    const beforeRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(id).first();

    if (!beforeRaw) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const before = normalizeDebt(beforeRaw);
    const patch = buildDebtPatch(body, before);

    if (!patch.ok) {
      return jsonResponse({ ok: false, version: VERSION, error: patch.error }, 400);
    }

    if (!patch.fields.length) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    const previewRaw = { ...beforeRaw };
    patch.fields.forEach((field, index) => {
      previewRaw[field] = patch.values[index];
    });

    const afterPreview = normalizeDebt(previewRaw);

    const proof = buildDebtSaveProof({
      id,
      before,
      after: afterPreview,
      fields: patch.fields
    });

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.save',
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: {
          id,
          mode: 'update',
          fields: patch.fields,
          values: patch.values.map(cleanBind),
          before,
          after: afterPreview
        }
      });
    }

    const allowed = await commandAllowsDebtAction(context, 'debt.save');

    if (!allowed) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Command Centre blocked real debt writes',
        action: 'debt.save',
        dry_run: false,
        writes_performed: false,
        audit_performed: false,
        enforcement: {
          action: 'debt.save',
          allowed: false,
          status: 'blocked',
          level: 3,
          reason: 'debt.save real write blocked by Command Centre.',
          source: 'coverage.write_safety.debts.debt_save_allowed',
          required_fix: 'Run Command Centre audit and confirm debt.save is allowed.',
          backend_enforced: true,
          frontend_enforced: true
        },
        proof
      }, 423);
    }

    const setSql = patch.fields.map(field => `${field} = ?`).join(', ');
    const bindValues = patch.values.concat([id]).map(cleanBind);

    await db.prepare(
      `UPDATE debts SET ${setSql} WHERE id = ?`
    ).bind(...bindValues).run();

    const afterWrittenRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(id).first();

    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'debt.save',
      id,
      writes_performed: true,
      audit_performed: false,
      debt: normalizeDebt(afterWrittenRaw),
      proof
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const id = safeText(context.params.id, '', 160);
    const dryRun = new URL(context.request.url).searchParams.get('dry_run') === '1';

    if (!id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt id required' }, 400);
    }

    const beforeRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(id).first();

    if (!beforeRaw) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const before = normalizeDebt(beforeRaw);
    const proof = buildDebtDeleteProof({ id, before });

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.delete',
        writes_performed: false,
        audit_performed: false,
        proof
      });
    }

    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Command Centre blocked debt.delete',
      action: 'debt.delete',
      writes_performed: false,
      audit_performed: false,
      proof
    }, 423);
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

function buildDebtPatch(body, before) {
  const fields = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    const name = safeText(body.name, '', 80);
    if (!name) return { ok: false, error: 'name cannot be empty' };
    fields.push('name');
    values.push(name);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'kind')) {
    const kind = normalizeKind(body.kind);
    if (!kind) return { ok: false, error: 'kind must be owe or owed' };
    fields.push('kind');
    values.push(kind);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'original_amount')) {
    const original = Number(body.original_amount);
    if (!Number.isFinite(original) || original < 0) {
      return { ok: false, error: 'original_amount must be 0 or greater' };
    }
    fields.push('original_amount');
    values.push(original);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'paid_amount')) {
    const paid = Number(body.paid_amount);
    if (!Number.isFinite(paid) || paid < 0) {
      return { ok: false, error: 'paid_amount must be 0 or greater' };
    }
    fields.push('paid_amount');
    values.push(paid);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'snowball_order')) {
    const order = body.snowball_order === '' || body.snowball_order == null
      ? null
      : Number(body.snowball_order);
    fields.push('snowball_order');
    values.push(Number.isFinite(order) ? order : null);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'due_date')) {
    fields.push('due_date');
    values.push(normalizeDate(body.due_date));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'due_day')) {
    const dueDay = normalizeDueDay(body.due_day);
    if (body.due_day !== null && body.due_day !== '' && body.due_day !== undefined && dueDay == null) {
      return { ok: false, error: 'due_day must be 1-31' };
    }
    fields.push('due_day');
    values.push(dueDay);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'installment_amount')) {
    const installmentAmount = normalizeNullableAmount(body.installment_amount);
    if (body.installment_amount !== null && body.installment_amount !== '' && body.installment_amount !== undefined && installmentAmount == null) {
      return { ok: false, error: 'installment_amount must be 0 or greater' };
    }
    fields.push('installment_amount');
    values.push(installmentAmount);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'frequency')) {
    const frequency = normalizeFrequency(body.frequency || 'monthly');
    if (!frequency) return { ok: false, error: 'Invalid frequency' };
    fields.push('frequency');
    values.push(frequency);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'last_paid_date')) {
    fields.push('last_paid_date');
    values.push(normalizeDate(body.last_paid_date));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    fields.push('notes');
    values.push(safeText(body.notes, '', 500));
  }

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = safeText(body.status, 'active', 20).toLowerCase();
    if (!['active', 'cancelled', 'closed'].includes(status)) {
      return { ok: false, error: 'Invalid status' };
    }
    fields.push('status');
    values.push(status);
  }

  const nextRaw = { ...before };
  fields.forEach((field, index) => {
    nextRaw[field] = values[index];
  });

  const original = Number(nextRaw.original_amount);
  const paid = Number(nextRaw.paid_amount);

  if (Number.isFinite(original) && Number.isFinite(paid) && paid > original) {
    return { ok: false, error: 'paid_amount cannot exceed original_amount' };
  }

  return { ok: true, fields, values };
}

function buildDebtSaveProof(input) {
  return {
    action: 'debt.save',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'debt_item_update_command_centre_gated',
    expected_debt_rows: 1,
    expected_transaction_rows: 0,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: input.id,
      before_kind: input.before.kind,
      after_kind: input.after.kind,
      before_remaining_amount: input.before.remaining_amount,
      after_remaining_amount: input.after.remaining_amount,
      before_status: input.before.status,
      after_status: input.after.status,
      updated_fields: input.fields
    },
    checks: [
      proofCheck('debt_exists', 'pass', 'debts.id', 'Debt id resolved.'),
      proofCheck('kind_valid', ['owe', 'owed'].includes(input.after.kind) ? 'pass' : 'blocked', 'request.kind', 'Debt kind is owe or owed.'),
      proofCheck('amounts_valid', input.after.original_amount >= 0 && input.after.paid_amount >= 0 && input.after.remaining_amount >= 0 ? 'pass' : 'blocked', 'request.amounts', 'Debt amounts are numerically safe.'),
      proofCheck('updated_fields_valid', Array.isArray(input.fields) && input.fields.length ? 'pass' : 'blocked', 'request.patch', 'Patch fields are explicit.'),
      proofCheck('undefined_guard', 'pass', 'cleanBind', 'No undefined values are bound into D1.'),
      proofCheck('command_gate_required', 'pass', 'finance-command-center', 'Real write asks Command Centre before UPDATE.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before UPDATE.')
    ]
  };
}

function buildDebtDeleteProof(input) {
  return {
    action: 'debt.delete',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'debt_delete_blocked',
    normalized_summary: {
      id: input.id,
      before_status: input.before.status,
      after_status: 'cancelled'
    },
    checks: [
      proofCheck('debt_exists', 'pass', 'debts.id', 'Debt id resolved.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before delete/cancel.')
    ]
  };
}

async function commandAllowsDebtAction(context, action) {
  try {
    const origin = new URL(context.request.url).origin;
    const res = await fetch(origin + '/api/finance-command-center?gate=' + encodeURIComponent(action) + '&cb=' + Date.now(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-sovereign-debt-gate': action
      }
    });

    const data = await res.json().catch(() => null);
    const found = data && data.enforcement && Array.isArray(data.enforcement.actions)
      ? data.enforcement.actions.find(item => item.action === action)
      : null;

    return Boolean(found && found.allowed);
  } catch (err) {
    return false;
  }
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function normalizeDebt(row) {
  const original = Number(row && row.original_amount) || 0;
  const paid = Number(row && row.paid_amount) || 0;
  const remaining = Math.max(0, original - paid);
  const dueDate = row && row.due_date ? normalizeDate(row.due_date) : null;
  const dueDay = row && row.due_day == null ? null : normalizeDueDay(row.due_day);
  const installmentAmount = row && row.installment_amount == null ? null : normalizeNullableAmount(row.installment_amount);
  const frequency = normalizeFrequency(row && row.frequency ? row.frequency : 'monthly') || 'monthly';
  const lastPaidDate = row && row.last_paid_date ? normalizeDate(row.last_paid_date) : null;

  const schedule = computeDebtSchedule({
    remaining,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    last_paid_date: lastPaidDate
  });

  return {
    id: safeText(row && row.id, '', 160),
    name: safeText(row && row.name, '', 120),
    kind: normalizeKind(row && row.kind) || 'owe',
    original_amount: round2(original),
    paid_amount: round2(paid),
    remaining_amount: round2(remaining),
    snowball_order: row && row.snowball_order == null ? null : Number(row.snowball_order),
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount == null ? null : round2(installmentAmount),
    frequency,
    last_paid_date: lastPaidDate,
    next_due_date: schedule.next_due_date,
    days_until_due: schedule.days_until_due,
    days_overdue: schedule.days_overdue,
    due_status: schedule.due_status,
    schedule_missing: schedule.schedule_missing,
    status: safeText(row && row.status, 'active', 40).toLowerCase(),
    notes: safeText(row && row.notes, '', 500),
    created_at: row && row.created_at ? safeText(row.created_at, '', 40) : null
  };
}

function computeDebtSchedule(input) {
  const remaining = Number(input.remaining) || 0;
  const dueDate = input.due_date || null;
  const dueDay = input.due_day == null ? null : Number(input.due_day);
  const lastPaidDate = input.last_paid_date || null;

  if (remaining <= 0) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'paid_off',
      schedule_missing: false
    };
  }

  let nextDue = null;

  if (dueDate) {
    nextDue = parseDate(dueDate);
  } else if (dueDay != null) {
    nextDue = nextDueFromDay(dueDay, lastPaidDate);
  }

  if (!nextDue) {
    return {
      next_due_date: null,
      days_until_due: null,
      days_overdue: null,
      due_status: 'no_schedule',
      schedule_missing: true
    };
  }

  const today = startOfDay(new Date());
  const days = daysBetween(today, nextDue);

  if (days < 0) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: 0,
      days_overdue: Math.abs(days),
      due_status: 'overdue',
      schedule_missing: false
    };
  }

  if (days === 0) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: 0,
      days_overdue: 0,
      due_status: 'due_today',
      schedule_missing: false
    };
  }

  if (days <= DUE_SOON_DAYS) {
    return {
      next_due_date: dateOnly(nextDue),
      days_until_due: days,
      days_overdue: 0,
      due_status: 'due_soon',
      schedule_missing: false
    };
  }

  return {
    next_due_date: dateOnly(nextDue),
    days_until_due: days,
    days_overdue: 0,
    due_status: 'scheduled',
    schedule_missing: false
  };
}

function nextDueFromDay(dueDay, lastPaidDate) {
  const now = new Date();
  const today = startOfDay(now);
  let candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), dueDay);

  if (lastPaidDate && lastPaidDate.slice(0, 7) === today.toISOString().slice(0, 7)) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, dueDay);
  } else if (candidate < today) {
    candidate = safeUtcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, dueDay);
  }

  return candidate;
}

function safeUtcDate(year, monthIndex, day) {
  const max = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, max);
  return new Date(Date.UTC(year, monthIndex, safeDay));
}

function parseDate(value) {
  const raw = normalizeDate(value);
  if (!raw) return null;

  const date = new Date(raw + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function normalizeDate(value) {
  const raw = safeText(value, '', 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function normalizeDueDay(value) {
  if (value === undefined || value === null || value === '') return null;

  const day = Number(value);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  return Math.floor(day);
}

function normalizeNullableAmount(value) {
  if (value === undefined || value === null || value === '') return null;

  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;

  return amount;
}

function normalizeFrequency(value) {
  const frequency = safeText(value, 'monthly', 20).toLowerCase();
  if (ALLOWED_FREQUENCY.includes(frequency)) return frequency;
  return null;
}

function normalizeKind(kind) {
  const text = String(kind || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'debt'].includes(text)) return 'owe';
  if (['owed', 'owed_me', 'receivable', 'to_me'].includes(text)) return 'owed';

  return null;
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(from, to) {
  const ms = startOfDay(to).getTime() - startOfDay(from).getTime();
  return Math.round(ms / 86400000);
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function safeText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function cleanBind(value) {
  if (value === undefined) return null;
  if (Number.isNaN(value)) return null;
  return value;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function isDryRunRequest(context, body) {
  const url = new URL(context.request.url);

  return url.searchParams.get('dry_run') === '1'
    || url.searchParams.get('dry_run') === 'true'
    || body.dry_run === true
    || body.dry_run === '1'
    || body.dry_run === 'true';
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
