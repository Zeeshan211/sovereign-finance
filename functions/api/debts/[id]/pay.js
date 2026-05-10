/* Sovereign Finance Debt Pay Route v0.3.2-pay
   POST /api/debts/:id/pay

   Debt Phase 1B:
   - Adds true dry_run support.
   - Dry-run validates debt.pay and exits before D1 writes.
   - Real debt.pay remains blocked until Command Centre recognizes debt proof and explicitly lifts debt.pay.
   - Prevents the old FK crash caused by dry_run entering transaction insert.
*/

const VERSION = 'v0.3.2-pay';

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const debtId = safeText(context.params.id, '', 180);
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);

    if (!debtId) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt id required' }, 400);
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Amount must be > 0' }, 400);
    }

    const accountInput = safeText(body.account_id, '', 180);
    if (!accountInput) {
      return jsonResponse({ ok: false, version: VERSION, error: 'account_id required' }, 400);
    }

    const debt = await db.prepare(
      `SELECT *
       FROM debts
       WHERE id = ?
       LIMIT 1`
    ).bind(debtId).first();

    if (!debt) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Debt not found' }, 404);
    }

    const normalizedDebt = normalizeDebt(debt);

    if (normalizedDebt.status !== 'active') {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Only active debts can be paid',
        debt_id: debtId,
        status: normalizedDebt.status
      }, 409);
    }

    if (!['owe', 'owed'].includes(normalizedDebt.kind)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Debt kind must be owe or owed',
        debt_id: debtId,
        kind: normalizedDebt.kind
      }, 409);
    }

    if (normalizedDebt.remaining_amount <= 0) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Debt is already fully paid',
        debt_id: debtId,
        remaining_amount: normalizedDebt.remaining_amount
      }, 409);
    }

    if (amount > normalizedDebt.remaining_amount + 0.01) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Amount cannot exceed remaining debt amount',
        debt_id: debtId,
        requested_amount: round2(amount),
        remaining_amount: normalizedDebt.remaining_amount
      }, 400);
    }

    const accountResult = await resolvePaymentAccount(db, accountInput);

    if (!accountResult.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: accountResult.error,
        account_input: accountInput
      }, accountResult.status || 409);
    }

    const account = accountResult.account;
    const date = normalizeDate(body.paid_date || body.date || body.payment_date) || todayISO();
    const txType = normalizedDebt.kind === 'owe' ? 'expense' : 'income';
    const txId = 'tx_pay_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const newPaid = round2(normalizedDebt.paid_amount + amount);
    const remaining = round2(Math.max(0, normalizedDebt.original_amount - newPaid));
    const nextStatus = remaining <= 0 ? 'closed' : 'active';

    const proof = buildDebtPayProof({
      debt: normalizedDebt,
      amount,
      account,
      accountInput,
      date,
      txId,
      txType,
      newPaid,
      remaining,
      nextStatus
    });

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'debt.pay',
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: {
          debt_id: debtId,
          tx_id: txId,
          tx_type: txType,
          amount: round2(amount),
          account_id: account.id,
          account_name: account.name || account.id,
          account_resolved_from: accountInput,
          date,
          before: normalizedDebt,
          after: {
            paid_amount: newPaid,
            remaining_amount: remaining,
            status: nextStatus
          }
        }
      });
    }

    return jsonResponse({
      ok: false,
      version: VERSION,
      error: 'Command Centre blocked real debt writes',
      action: 'debt.pay',
      dry_run: false,
      writes_performed: false,
      audit_performed: false,
      enforcement: {
        action: 'debt.pay',
        allowed: false,
        status: 'blocked',
        level: 3,
        reason: 'debt.pay real writes remain blocked until debt dry-run proof, Debts page preflight, backend gate, and Command Centre lift are complete.',
        source: 'coverage.write_safety.debt_pay',
        required_fix: 'Make Command Centre recognize debt.pay proof, wire Debts page preflight, then explicitly lift debt.pay.',
        backend_enforced: true,
        frontend_enforced: true,
        override: {
          allowed: false,
          reason_required: true
        }
      },
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

async function resolvePaymentAccount(db, input) {
  const raw = safeText(input, '', 180);

  const exact = await db.prepare(
    `SELECT id, name, kind, type, status
     FROM accounts
     WHERE id = ?
     LIMIT 1`
  ).bind(raw).first();

  if (exact && isActiveAccount(exact)) {
    return { ok: true, account: exact };
  }

  const accountsResult = await db.prepare(
    `SELECT id, name, kind, type, status
     FROM accounts
     ORDER BY name`
  ).all();

  const accounts = accountsResult.results || [];
  const wanted = accountToken(raw);

  const matched = accounts.find(account => {
    if (!isActiveAccount(account)) return false;

    return wanted === accountToken(account.id)
      || wanted === accountToken(account.name)
      || raw.toLowerCase() === String(account.name || '').trim().toLowerCase();
  });

  if (matched) {
    return { ok: true, account: matched };
  }

  return {
    ok: false,
    status: 409,
    error: 'Payment account not found or inactive. Refresh accounts and retry.'
  };
}

function buildDebtPayProof(input) {
  return {
    action: 'debt.pay',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'debt_payment_real_write_blocked_until_command_centre_lift',
    expected_debt_rows: 1,
    expected_transaction_rows: 1,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      debt_id: input.debt.id,
      debt_name: input.debt.name,
      debt_kind: input.debt.kind,
      txn_type: input.txType,
      payment_amount: round2(input.amount),
      previous_paid_amount: input.debt.paid_amount,
      previous_remaining_amount: input.debt.remaining_amount,
      next_paid_amount: input.newPaid,
      next_remaining_amount: input.remaining,
      next_status: input.nextStatus,
      account_id: input.account.id,
      date: input.date
    },
    checks: [
      proofCheck('debt_exists', 'pass', 'debts.id', 'Debt id resolved.'),
      proofCheck('debt_active', 'pass', 'debts.status', 'Debt is active.'),
      proofCheck('kind_valid', 'pass', 'debts.kind', 'Debt kind is owe or owed.'),
      proofCheck('remaining_amount_valid', 'pass', 'debts.remaining_amount', 'Debt has remaining amount greater than zero.'),
      proofCheck('payment_amount_valid', 'pass', 'request.amount', 'Payment amount is greater than zero and does not exceed remaining amount.'),
      proofCheck('account_valid', 'pass', 'accounts.id', 'Payment account resolves to canonical active account id.'),
      proofCheck('date_valid', 'pass', 'request.date', 'Payment date normalized.'),
      proofCheck('transaction_model_valid', 'pass', 'computed.txn_type', 'owe becomes expense, owed becomes income.'),
      proofCheck('fk_guard', 'pass', 'accounts.id', 'Account is checked before any future transaction insert.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before transaction insert or debt update.')
    ],
    lift_candidate: {
      coverage_key: 'coverage.write_safety.debt_pay',
      current_expected_state: 'blocked',
      required_next_state: 'dry_run_available',
      reason: 'debt.pay dry-run validates without writing transaction, debt, ledger, or audit rows.'
    }
  };
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function normalizeDebt(row) {
  const original = Number(row.original_amount || 0);
  const paid = Number(row.paid_amount || 0);
  const remaining = Math.max(0, original - paid);

  return {
    id: safeText(row.id, '', 180),
    name: safeText(row.name, '', 180),
    kind: normalizeKind(row.kind),
    original_amount: round2(original),
    paid_amount: round2(paid),
    remaining_amount: round2(remaining),
    status: safeText(row.status, 'active', 40).toLowerCase(),
    due_date: row.due_date || null,
    due_day: row.due_day == null ? null : Number(row.due_day),
    installment_amount: row.installment_amount == null ? null : Number(row.installment_amount),
    frequency: row.frequency || 'custom',
    last_paid_date: row.last_paid_date || null,
    notes: row.notes || ''
  };
}

function normalizeKind(value) {
  const text = String(value || '').trim().toLowerCase();

  if (['owe', 'i_owe', 'payable', 'debt', 'debt_out'].includes(text)) return 'owe';
  if (['owed', 'owed_me', 'receivable', 'to_me', 'debt_in'].includes(text)) return 'owed';

  return text;
}

function isActiveAccount(account) {
  const status = String(account.status || 'active').trim().toLowerCase();
  return status === '' || status === 'active';
}

function normalizeDate(value) {
  const raw = safeText(value, '', 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isDryRunRequest(context, body) {
  const url = new URL(context.request.url);

  return url.searchParams.get('dry_run') === '1'
    || url.searchParams.get('dry_run') === 'true'
    || body.dry_run === true
    || body.dry_run === '1'
    || body.dry_run === 'true';
}

function accountToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
