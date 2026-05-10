/* Sovereign Finance Debts Collection Route v0.3.2
   /api/debts

   Stable contract:
   - GET /api/debts lists debts.
   - POST /api/debts?dry_run=1 validates create and performs no write.
   - POST /api/debts asks Command Centre before creating.
   - Specific /api/debts/:id and /api/debts/:id/pay routes are handled by dedicated files.
   - No audit writes here.
   - No version bump.
*/

const VERSION = 'v0.3.2';
const ACTIVE_CONDITION = "(status IS NULL OR status = 'active')";
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
    const path = getPath(context);

    if (path.length > 0) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Use dedicated debt item route for this path.'
      }, 404);
    }

    const includeInactive = new URL(context.request.url).searchParams.get('include_inactive') === '1';

    const sql = includeInactive
      ? `SELECT ${DEBT_COLUMNS}
         FROM debts
         ORDER BY kind, snowball_order, name`
      : `SELECT ${DEBT_COLUMNS}
         FROM debts
         WHERE ${ACTIVE_CONDITION}
         ORDER BY kind, snowball_order, name`;

    const res = await db.prepare(sql).all();
    const debts = (res.results || []).map(normalizeDebt);

    return jsonResponse({
      ok: true,
      version: VERSION,
      count: debts.length,
      total_owe: round2(sumRemaining(debts.filter(d => d.kind === 'owe'))),
      total_owed: round2(sumRemaining(debts.filter(d => d.kind === 'owed'))),
      schedule_missing_count: debts.filter(d => d.schedule_missing && d.status === 'active').length,
      due_soon_count: debts.filter(d => d.due_status === 'due_soon').length,
      overdue_count: debts.filter(d => d.due_status === 'overdue').length,
      debts
    });
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);

    if (path.length > 0) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Use dedicated debt route for this path.'
      }, 404);
    }

    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);
    const validation = buildCreatePayload(body);

    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action: 'debt.save',
        error: validation.error
      }, 400);
    }

    const payload = validation.payload;
    const preview = normalizeDebt({
      ...payload,
      status: 'active',
      created_at: new Date().toISOString()
    });

    const proof = buildDebtCreateProof(preview);

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.save',
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: payload
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
          reason: 'debt.save create blocked by Command Centre.',
          source: 'coverage.write_safety.debts.debt_save_allowed',
          backend_enforced: true
        },
        proof
      }, 423);
    }

    await db.prepare(
      `INSERT INTO debts
       (id, name, kind, original_amount, paid_amount, snowball_order, due_date, due_day, installment_amount, frequency, last_paid_date, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      payload.id,
      payload.name,
      payload.kind,
      payload.original_amount,
      payload.paid_amount,
      payload.snowball_order,
      payload.due_date,
      payload.due_day,
      payload.installment_amount,
      payload.frequency,
      payload.last_paid_date,
      'active',
      payload.notes
    ).run();

    const afterRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(payload.id).first();

    return jsonResponse({
      ok: true,
      version: VERSION,
      action: 'debt.save',
      id: payload.id,
      writes_performed: true,
      audit_performed: false,
      debt: normalizeDebt(afterRaw),
      proof
    });
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message || String(err) }, 500);
  }
}

function buildCreatePayload(body) {
  const name = safeText(body.name, '', 100);
  const kind = normalizeKind(body.kind || 'owe');
  const originalAmount = Number(body.original_amount);
  const paidAmount = Number(body.paid_amount || 0);
  const snowballOrder = body.snowball_order === '' || body.snowball_order == null ? null : Number(body.snowball_order);
  const dueDate = normalizeDate(body.due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const installmentAmount = normalizeNullableAmount(body.installment_amount);
  const frequency = normalizeFrequency(body.frequency || 'custom');
  const lastPaidDate = normalizeDate(body.last_paid_date);
  const notes = safeText(body.notes, '', 500);
  const id = safeText(body.id, '', 160) || 'debt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  if (!name) return { ok: false, error: 'name required' };
  if (!kind) return { ok: false, error: 'kind must be owe or owed' };
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) return { ok: false, error: 'original_amount must be greater than 0' };
  if (!Number.isFinite(paidAmount) || paidAmount < 0) return { ok: false, error: 'paid_amount must be 0 or greater' };
  if (paidAmount > originalAmount) return { ok: false, error: 'paid_amount cannot exceed original_amount' };
  if (body.due_day !== undefined && body.due_day !== null && body.due_day !== '' && dueDay == null) return { ok: false, error: 'due_day must be 1-31' };
  if (body.installment_amount !== undefined && body.installment_amount !== null && body.installment_amount !== '' && installmentAmount == null) return { ok: false, error: 'installment_amount must be 0 or greater' };
  if (!frequency) return { ok: false, error: 'Invalid frequency' };

  return {
    ok: true,
    payload: {
      id,
      name,
      kind,
      original_amount: round2(originalAmount),
      paid_amount: round2(paidAmount),
      snowball_order: Number.isFinite(snowballOrder) ? snowballOrder : null,
      due_date: dueDate,
      due_day: dueDay,
      installment_amount: installmentAmount,
      frequency,
      last_paid_date: lastPaidDate,
      notes
    }
  };
}

function buildDebtCreateProof(debt) {
  return {
    action: 'debt.save',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'debt_create_command_centre_gated',
    expected_debt_rows: 1,
    expected_transaction_rows: 0,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: debt.id,
      name: debt.name,
      kind: debt.kind,
      original_amount: debt.original_amount,
      paid_amount: debt.paid_amount,
      remaining_amount: debt.remaining_amount
    },
    checks: [
      proofCheck('name_valid', 'pass', 'request.name', 'Debt name exists.'),
      proofCheck('kind_valid', 'pass', 'request.kind', 'Debt kind is owe or owed.'),
      proofCheck('amount_valid', 'pass', 'request.original_amount', 'Original amount is greater than 0.'),
      proofCheck('paid_amount_valid', 'pass', 'request.paid_amount', 'Paid amount is safe.'),
      proofCheck('command_gate_required', 'pass', 'finance-command-center', 'Real create asks Command Centre before INSERT.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before INSERT.')
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

function getPath(context) {
  const raw = context.params && context.params.path;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(x => safeText(x, '', 180));
  return String(raw).split('/').filter(Boolean).map(x => safeText(x, '', 180));
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
    return { next_due_date: dateOnly(nextDue), days_until_due: 0, days_overdue: Math.abs(days), due_status: 'overdue', schedule_missing: false };
  }

  if (days === 0) {
    return { next_due_date: dateOnly(nextDue), days_until_due: 0, days_overdue: 0, due_status: 'due_today', schedule_missing: false };
  }

  if (days <= DUE_SOON_DAYS) {
    return { next_due_date: dateOnly(nextDue), days_until_due: days, days_overdue: 0, due_status: 'due_soon', schedule_missing: false };
  }

  return { next_due_date: dateOnly(nextDue), days_until_due: days, days_overdue: 0, due_status: 'scheduled', schedule_missing: false };
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

function sumRemaining(rows) {
  return rows.reduce((sum, debt) => sum + Math.max(0, Number(debt.remaining_amount) || 0), 0);
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
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
  });
}
