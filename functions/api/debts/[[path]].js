/*  Sovereign Finance  /api/debts/[[path]]  v0.3.2  Debt Dry-Run Proof Guard  */
/*
* Handles:
*   GET    /api/debts
*   POST   /api/debts
*   GET    /api/debts/{id}
*   PUT    /api/debts/{id}
*   DELETE /api/debts/{id}
*   POST   /api/debts/{id}/pay
*
* v0.3.2:
*   - Adds true dry_run support for:
*       POST /api/debts?dry_run=1
*       PUT  /api/debts/{id}?dry_run=1
*       POST /api/debts/{id}/pay?dry_run=1
*   - Dry-run validates payload and returns proof before any D1 mutation.
*   - Dry-run performs no debt writes, no transaction writes, no ledger writes, no audit writes.
*   - Real debt.save / debt.pay writes are blocked until Command Centre recognizes debt proof and lifts them.
*   - Preserves v0.3.1 GET/read shape, schedule metadata, account resolver, FK guard, and overpayment guard.
*
* v0.3.1:
*   - Validates payment account before inserting ledger transaction.
*   - Resolves account labels like "Meezan" or "🏦 Meezan" back to canonical accounts.id.
*   - Uses canonical account id for transaction insert and audit detail.
*   - Returns clear payment-account errors instead of raw D1 FOREIGN KEY errors.
*   - Prevents overpayment against remaining debt/receivable amount.
*
* v0.3.0:
*   - Reads debt schedule metadata:
*       due_day, due_date, installment_amount, frequency, last_paid_date
*   - Computes:
*       remaining_amount, next_due_date, days_until_due, days_overdue,
*       due_status, schedule_missing
*   - No undefined value is passed into D1 bind().
*   - Audit failure does not break successful DB mutations.
*   - Cancel remains soft-only in legacy mode, but v0.3.2 blocks real delete until Command Centre lift.
*/

import { json, uuid } from '../_lib.js';

const VERSION = 'v0.3.2';
const ACTIVE_CONDITION = "(status IS NULL OR status = 'active')";
const ACTIVE_ACCOUNT_CONDITION = "(deleted_at IS NULL OR deleted_at = '') AND (status IS NULL OR status = '' OR status = 'active')";
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

    if (path.length === 1) {
      const id = safeText(path[0], '', 160);
      const debt = await db.prepare(
        `SELECT ${DEBT_COLUMNS}
         FROM debts
         WHERE id = ?`
      ).bind(id).first();

      if (!debt) {
        return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
      }

      return json({ ok: true, version: VERSION, debt: normalizeDebt(debt) });
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

    return json({
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
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = getPath(context);

    if (path.length === 2 && path[1] === 'pay') {
      return payDebt(context, path[0]);
    }

    if (path.length === 0) {
      return createDebt(context);
    }

    return json({ ok: false, version: VERSION, error: 'Path not supported for POST' }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires debt id' }, 400);
    }

    const id = safeText(path[0], '', 160);
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);

    if (!id) {
      return json({ ok: false, version: VERSION, error: 'Debt id required' }, 400);
    }

    const beforeRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!beforeRaw) {
      return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const before = normalizeDebt(beforeRaw);
    const patch = buildDebtPatch(body);

    if (!patch.ok) {
      return json({ ok: false, version: VERSION, error: patch.error }, 400);
    }

    if (!patch.fields.length) {
      return json({ ok: false, version: VERSION, error: 'Nothing to update' }, 400);
    }

    const previewRaw = { ...beforeRaw };
    patch.fields.forEach((field, index) => {
      previewRaw[field] = patch.values[index];
    });

    const afterPreview = normalizeDebt(previewRaw);
    const proof = buildDebtSaveProof({
      mode: 'update',
      before,
      after: afterPreview,
      fields: patch.fields,
      id
    });

    if (dryRun) {
      return json({
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

    return blockedRealWrite('debt.save', proof, {
      id,
      mode: 'update',
      fields: patch.fields
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);

    if (path.length !== 1) {
      return json({ ok: false, version: VERSION, error: 'Path requires debt id' }, 400);
    }

    const id = safeText(path[0], '', 160);
    const dryRun = new URL(context.request.url).searchParams.get('dry_run') === '1'
      || new URL(context.request.url).searchParams.get('dry_run') === 'true';

    const beforeRaw = await db.prepare(
      `SELECT ${DEBT_COLUMNS}
       FROM debts
       WHERE id = ?`
    ).bind(id).first();

    if (!beforeRaw) {
      return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const before = normalizeDebt(beforeRaw);

    const proof = buildDebtDeleteProof({
      id,
      before
    });

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.delete',
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: {
          id,
          status: 'cancelled',
          before
        }
      });
    }

    return blockedRealWrite('debt.delete', proof, {
      id,
      status: 'cancelled'
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createDebt(context) {
  const db = context.env.DB;
  const body = await readJSON(context.request);
  const dryRun = isDryRunRequest(context, body);

  const name = safeText(body.name, '', 80);
  const kind = normalizeKind(body.kind || 'owe');
  const original = Number(body.original_amount);
  const paid = Number(body.paid_amount || 0);
  const id = body.id
    ? safeText(body.id, '', 120)
    : ('debt_' + uuid());
  const snowballOrder = body.snowball_order == null || body.snowball_order === ''
    ? null
    : Number(body.snowball_order);
  const dueDate = normalizeDate(body.due_date);
  const dueDay = normalizeDueDay(body.due_day);
  const installmentAmount = normalizeNullableAmount(body.installment_amount);
  const frequency = normalizeFrequency(body.frequency || 'monthly');
  const lastPaidDate = normalizeDate(body.last_paid_date);
  const notes = safeText(body.notes, '', 500);

  if (!name) {
    return json({ ok: false, version: VERSION, error: 'name required' }, 400);
  }

  if (!kind) {
    return json({ ok: false, version: VERSION, error: 'kind must be owe or owed' }, 400);
  }

  if (!Number.isFinite(original) || original <= 0) {
    return json({ ok: false, version: VERSION, error: 'original_amount must be greater than 0' }, 400);
  }

  if (!Number.isFinite(paid) || paid < 0) {
    return json({ ok: false, version: VERSION, error: 'paid_amount must be 0 or greater' }, 400);
  }

  if (paid > original) {
    return json({ ok: false, version: VERSION, error: 'paid_amount cannot exceed original_amount' }, 400);
  }

  if (body.due_day !== undefined && body.due_day !== null && body.due_day !== '' && dueDay == null) {
    return json({ ok: false, version: VERSION, error: 'due_day must be 1-31' }, 400);
  }

  if (body.installment_amount !== undefined && body.installment_amount !== null && body.installment_amount !== '' && installmentAmount == null) {
    return json({ ok: false, version: VERSION, error: 'installment_amount must be 0 or greater' }, 400);
  }

  if (!frequency) {
    return json({ ok: false, version: VERSION, error: 'Invalid frequency' }, 400);
  }

  const preview = normalizeDebt({
    id,
    name,
    kind,
    original_amount: original,
    paid_amount: paid,
    snowball_order: Number.isFinite(snowballOrder) ? snowballOrder : null,
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount,
    frequency,
    last_paid_date: lastPaidDate,
    status: 'active',
    notes,
    created_at: new Date().toISOString()
  });

  const proof = buildDebtSaveProof({
    mode: 'create',
    before: null,
    after: preview,
    fields: [
      'id',
      'name',
      'kind',
      'original_amount',
      'paid_amount',
      'snowball_order',
      'due_date',
      'due_day',
      'installment_amount',
      'frequency',
      'last_paid_date',
      'status',
      'notes'
    ],
    id
  });

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      dry_run: true,
      action: 'debt.save',
      writes_performed: false,
      audit_performed: false,
      proof,
      normalized_payload: {
        id,
        mode: 'create',
        debt: preview
      }
    });
  }

  return blockedRealWrite('debt.save', proof, {
    id,
    mode: 'create',
    debt: preview
  });
}

async function payDebt(context, debtIdRaw) {
  const db = context.env.DB;
  const body = await readJSON(context.request);
  const dryRun = isDryRunRequest(context, body);

  const debtId = safeText(debtIdRaw, '', 160);

  const debtRaw = await db.prepare(
    `SELECT ${DEBT_COLUMNS}
     FROM debts
     WHERE id = ?
     AND ${ACTIVE_CONDITION}`
  ).bind(debtId).first();

  if (!debtRaw) {
    return json({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
  }

  const debt = normalizeDebt(debtRaw);
  const amount = Number(body.amount);
  const accountInput = safeText(body.account_id, '', 120);
  const date = normalizeDate(body.date || body.paid_date || body.payment_date) || new Date().toISOString().slice(0, 10);
  const notes = safeText(body.notes, 'Debt payment: ' + debt.name, 200);

  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ ok: false, version: VERSION, error: 'amount must be greater than 0' }, 400);
  }

  if (!accountInput) {
    return json({ ok: false, version: VERSION, error: 'account_id required' }, 400);
  }

  if (debt.remaining_amount <= 0.01) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Debt is already fully paid',
      debt_id: debtId,
      remaining_amount: debt.remaining_amount
    }, 409);
  }

  if (amount > debt.remaining_amount + 0.01) {
    return json({
      ok: false,
      version: VERSION,
      error: 'amount cannot exceed remaining debt amount',
      debt_id: debtId,
      requested_amount: round2(amount),
      remaining_amount: debt.remaining_amount
    }, 400);
  }

  const accountResult = await resolvePaymentAccount(db, accountInput);

  if (!accountResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      error: accountResult.error,
      account_input: accountInput
    }, accountResult.status || 409);
  }

  const account = accountResult.account;
  const accountId = account.id;
  const txnId = 'TXN-' + uuid();
  const txnType = debt.kind === 'owed'
    ? 'income'
    : 'expense';
  const newPaid = round2(Number(debt.paid_amount || 0) + amount);
  const previewRaw = {
    ...debtRaw,
    paid_amount: newPaid,
    last_paid_date: date
  };
  const afterPreview = normalizeDebt(previewRaw);

  const proof = buildDebtPayProof({
    debt,
    after: afterPreview,
    txn_id: txnId,
    txn_type: txnType,
    amount,
    account_input: accountInput,
    account_id: accountId,
    account_name: account.name || accountId,
    date,
    notes
  });

  if (dryRun) {
    return json({
      ok: true,
      version: VERSION,
      dry_run: true,
      action: 'debt.pay',
      writes_performed: false,
      audit_performed: false,
      proof,
      normalized_payload: {
        debt_id: debtId,
        txn_id: txnId,
        txn_type: txnType,
        amount: round2(amount),
        account_id: accountId,
        account_name: account.name || accountId,
        account_resolved_from: accountInput,
        date,
        before: debt,
        after: afterPreview
      }
    });
  }

  return blockedRealWrite('debt.pay', proof, {
    debt_id: debtId,
    txn_id: txnId,
    amount: round2(amount),
    account_id: accountId,
    account_name: account.name || accountId,
    account_resolved_from: accountInput,
    date
  });
}

async function resolvePaymentAccount(db, input) {
  const raw = safeText(input, '', 120);

  if (!raw) {
    return { ok: false, status: 400, error: 'account_id required' };
  }

  const exact = await db.prepare(
    `SELECT id, name, icon
     FROM accounts
     WHERE id = ?
     AND ${ACTIVE_ACCOUNT_CONDITION}`
  ).bind(raw).first();

  if (exact && exact.id) {
    return { ok: true, account: exact };
  }

  const accountsResult = await db.prepare(
    `SELECT id, name, icon
     FROM accounts
     WHERE ${ACTIVE_ACCOUNT_CONDITION}
     ORDER BY display_order, name`
  ).all();

  const accounts = accountsResult.results || [];
  const wanted = accountToken(raw);

  const matched = accounts.find(account => {
    const idToken = accountToken(account.id);
    const nameToken = accountToken(account.name);
    const labelToken = accountToken(((account.icon || '') + ' ' + (account.name || '')).trim());

    return wanted === idToken
      || wanted === nameToken
      || wanted === labelToken
      || raw.toLowerCase() === String(account.name || '').trim().toLowerCase();
  });

  if (matched && matched.id) {
    return { ok: true, account: matched };
  }

  return {
    ok: false,
    status: 409,
    error: 'Payment account not found or inactive. Refresh accounts and retry.'
  };
}

function buildDebtPatch(body) {
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
    if (!frequency) {
      return { ok: false, error: 'Invalid frequency' };
    }
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

  return { ok: true, fields, values };
}

function buildDebtSaveProof(input) {
  return {
    action: 'debt.save',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: input.mode === 'create'
      ? 'debt_create_without_ledger_in_dry_run'
      : 'debt_update_without_ledger_in_dry_run',
    expected_debt_rows: 1,
    expected_ledger_rows: 0,
    expected_transaction_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: input.id,
      mode: input.mode,
      before_remaining_amount: input.before ? input.before.remaining_amount : null,
      after_remaining_amount: input.after ? input.after.remaining_amount : null,
      after_kind: input.after ? input.after.kind : null,
      after_status: input.after ? input.after.status : null
    },
    checks: [
      proofCheck('debt_identity_valid', 'pass', 'request.id/name', input.id ? 'Debt id/name is valid.' : 'Debt name is valid.'),
      proofCheck('kind_valid', input.after && ['owe', 'owed'].includes(input.after.kind) ? 'pass' : 'blocked', 'request.kind', 'Debt kind must be owe or owed.'),
      proofCheck('amounts_valid', input.after && input.after.original_amount >= 0 && input.after.paid_amount >= 0 && input.after.remaining_amount >= 0 ? 'pass' : 'blocked', 'request.amounts', 'Debt amounts are numerically safe.'),
      proofCheck('updated_fields_valid', Array.isArray(input.fields) && input.fields.length ? 'pass' : 'blocked', 'request.patch', 'Patch fields are explicit.'),
      proofCheck('undefined_guard', 'pass', 'cleanBind', 'No undefined values are bound into D1.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before INSERT/UPDATE/DELETE/audit.')
    ],
    lift_candidate: {
      coverage_key: 'coverage.write_safety.debt_save',
      current_expected_state: 'blocked',
      required_next_state: 'dry_run_available',
      reason: 'debt.save dry-run validates without writing debt, transaction, ledger, or audit rows.'
    }
  };
}

function buildDebtPayProof(input) {
  return {
    action: 'debt.pay',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'debt_payment_plus_transaction_blocked_until_lift',
    expected_debt_rows: 1,
    expected_ledger_rows: 0,
    expected_transaction_rows: 1,
    expected_audit_rows: 1,
    normalized_summary: {
      debt_id: input.debt.id,
      debt_name: input.debt.name,
      debt_kind: input.debt.kind,
      txn_type: input.txn_type,
      payment_amount: round2(input.amount),
      previous_paid_amount: input.debt.paid_amount,
      previous_remaining_amount: input.debt.remaining_amount,
      next_paid_amount: input.after.paid_amount,
      next_remaining_amount: input.after.remaining_amount,
      account_id: input.account_id,
      date: input.date
    },
    checks: [
      proofCheck('debt_exists', 'pass', 'debts.id', 'Debt id resolved.'),
      proofCheck('debt_active', input.debt.status === 'active' ? 'pass' : 'blocked', 'debts.status', 'Debt is active.'),
      proofCheck('kind_valid', ['owe', 'owed'].includes(input.debt.kind) ? 'pass' : 'blocked', 'debts.kind', 'Debt kind is owe or owed.'),
      proofCheck('remaining_amount_valid', input.debt.remaining_amount > 0 ? 'pass' : 'blocked', 'debts.remaining_amount', 'Debt has remaining amount.'),
      proofCheck('payment_amount_valid', input.amount > 0 && input.amount <= input.debt.remaining_amount + 0.01 ? 'pass' : 'blocked', 'request.amount', 'Payment amount is greater than 0 and does not exceed remaining amount.'),
      proofCheck('account_valid', input.account_id ? 'pass' : 'blocked', 'accounts.id', 'Payment account resolves to canonical account id.'),
      proofCheck('date_valid', input.date ? 'pass' : 'blocked', 'request.date', 'Payment date is normalized.'),
      proofCheck('transaction_model_valid', ['income', 'expense'].includes(input.txn_type) ? 'pass' : 'blocked', 'computed.txn_type', 'owed becomes income, owe becomes expense.'),
      proofCheck('undefined_guard', 'pass', 'cleanBind', 'No undefined values are bound into D1.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before transaction insert, debt update, or audit insert.')
    ],
    lift_candidate: {
      coverage_key: 'coverage.write_safety.debt_pay',
      current_expected_state: 'blocked',
      required_next_state: 'dry_run_available',
      reason: 'debt.pay dry-run validates debt payment without writing transaction, debt, ledger, or audit rows.'
    }
  };
}

function buildDebtDeleteProof(input) {
  return {
    action: 'debt.delete',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'debt_soft_cancel_blocked_until_lift',
    expected_debt_rows: 1,
    expected_ledger_rows: 0,
    expected_transaction_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      id: input.id,
      before_status: input.before ? input.before.status : null,
      after_status: 'cancelled'
    },
    checks: [
      proofCheck('debt_exists', 'pass', 'debts.id', 'Debt id resolved.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before soft cancel update or audit insert.')
    ],
    lift_candidate: {
      coverage_key: 'coverage.write_safety.debt_delete',
      current_expected_state: 'blocked',
      required_next_state: 'dry_run_available',
      reason: 'debt.delete is not part of current Command Centre lift scope.'
    }
  };
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function blockedRealWrite(action, proof, normalizedPayload) {
  return json({
    ok: false,
    version: VERSION,
    error: 'Command Centre blocked real debt writes',
    action,
    dry_run: false,
    writes_performed: false,
    audit_performed: false,
    enforcement: {
      action,
      allowed: false,
      status: 'blocked',
      level: 3,
      reason: action + ' real writes remain blocked until Debts page preflight and Command Centre lift are complete.',
      source: action === 'debt.pay'
        ? 'coverage.write_safety.debt_pay'
        : action === 'debt.delete'
          ? 'coverage.write_safety.debt_delete'
          : 'coverage.write_safety.debt_save',
      required_fix: 'Wire debt dry-run proof, make Command Centre recognize debt proof, then explicitly lift only safe debt actions.',
      backend_enforced: true,
      frontend_enforced: true,
      override: {
        allowed: false,
        reason_required: true
      }
    },
    proof,
    normalized_payload: normalizedPayload || null
  }, 423);
}

function accountToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
  const dueDate = row && row.due_date
    ? normalizeDate(row.due_date)
    : null;
  const dueDay = row && row.due_day == null
    ? null
    : normalizeDueDay(row.due_day);
  const installmentAmount = row && row.installment_amount == null
    ? null
    : normalizeNullableAmount(row.installment_amount);
  const frequency = normalizeFrequency(row && row.frequency
    ? row.frequency
    : 'monthly') || 'monthly';
  const lastPaidDate = row && row.last_paid_date
    ? normalizeDate(row.last_paid_date)
    : null;

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
    snowball_order: row && row.snowball_order == null
      ? null
      : Number(row.snowball_order),
    due_date: dueDate,
    due_day: dueDay,
    installment_amount: installmentAmount == null
      ? null
      : round2(installmentAmount),
    frequency,
    last_paid_date: lastPaidDate,
    next_due_date: schedule.next_due_date,
    days_until_due: schedule.days_until_due,
    days_overdue: schedule.days_overdue,
    due_status: schedule.due_status,
    schedule_missing: schedule.schedule_missing,
    status: safeText(row && row.status, 'active', 40),
    notes: safeText(row && row.notes, '', 500),
    created_at: row && row.created_at
      ? safeText(row.created_at, '', 40)
      : null
  };
}

function computeDebtSchedule(input) {
  const remaining = Number(input.remaining) || 0;
  const dueDate = input.due_date || null;
  const dueDay = input.due_day == null
    ? null
    : Number(input.due_day);
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

function sumRemaining(rows) {
  return rows.reduce((sum, debt) => sum + Math.max(0, (Number(debt.original_amount) || 0) - (Number(debt.paid_amount) || 0)), 0);
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
  const raw = value == null
    ? fallback
    : value;

  return String(raw == null
    ? ''
    : raw).trim().slice(0, maxLen || 500);
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
