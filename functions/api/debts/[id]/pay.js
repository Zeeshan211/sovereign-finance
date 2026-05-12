/* /api/debts/:id/pay
 * Sovereign Finance · Debt Payment Engine
 * v1.0.0-debts-pay-banking-grade
 */

import { audit } from '../../_lib.js';

const VERSION = 'v1.0.0-debts-pay-banking-grade';
const DEFAULT_CATEGORY_ID = 'debt_payment';
const DEFAULT_CREATED_BY = 'web-debts';
const BALANCE_TOLERANCE_PAISA = 1;

const ACTIVE_ACCOUNT_CONDITION =
  "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestPost(context) {
  try {
    const debtId = getDebtId(context);
    const body = await readJSON(context.request);
    const url = new URL(context.request.url);
    const dryRun = url.searchParams.get('dry_run') === '1' || body.dry_run === true;

    const validation = await validateDebtPayment(context, debtId, body);

    if (!validation.ok) {
      return json(validation, validation.status || 400);
    }

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        writes_performed: false,
        payload_hash: validation.payload_hash,
        transaction_payload_hash: validation.transaction_payload_hash,
        requires_override: validation.requires_override,
        override_reason: validation.override_reason,
        override_token: validation.override_token,
        projected_debt_state: validation.projected_debt_state,
        transaction_proof: validation.transaction_proof,
        warnings: validation.warnings,
        normalized_payload: validation.normalized_payload
      });
    }

    const suppliedHash = text(body.payload_hash || body.dry_run_payload_hash, '', 200);

    if (!suppliedHash) {
      return json({
        ok: false,
        version: VERSION,
        error: 'payload_hash required. Run dry-run first.'
      }, 428);
    }

    if (suppliedHash !== validation.payload_hash) {
      return json({
        ok: false,
        version: VERSION,
        error: 'Payload changed after dry-run. Run dry-run again.',
        expected: validation.payload_hash,
        supplied: suppliedHash
      }, 409);
    }

    if (validation.requires_override) {
      const suppliedOverride = text(body.override_token, '', 200);

      if (!suppliedOverride || suppliedOverride !== validation.override_token) {
        return json({
          ok: false,
          version: VERSION,
          error: 'valid override_token required',
          override_reason: validation.override_reason
        }, 428);
      }
    }

    return commitDebtPayment(context, validation);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message
    }, 500);
  }
}

async function validateDebtPayment(context, debtId, body) {
  const db = context.env.DB;

  if (!debtId) {
    return {
      ok: false,
      version: VERSION,
      status: 400,
      error: 'debt id required'
    };
  }

  const debt = await getDebt(db, debtId);

  if (!debt) {
    return {
      ok: false,
      version: VERSION,
      status: 404,
      error: 'debt not found',
      debt_id: debtId
    };
  }

  const kind = String(debt.kind || '').toLowerCase();

  if (!['owe', 'owed'].includes(kind)) {
    return {
      ok: false,
      version: VERSION,
      status: 409,
      error: 'invalid debt kind',
      kind
    };
  }

  const originalPaisa = moneyToPaisa(debt.original_amount || 0);
  const paidBeforePaisa = moneyToPaisa(debt.paid_amount || 0);
  const remainingBeforePaisa = Math.max(0, originalPaisa - paidBeforePaisa);

  if (remainingBeforePaisa <= 0) {
    return {
      ok: false,
      version: VERSION,
      status: 409,
      error: 'debt has no remaining balance',
      remaining: 0
    };
  }

  const amount = roundMoney(Number(body.amount));
  const amountPaisa = moneyToPaisa(amount);

  if (!Number.isFinite(amount) || amount <= 0 || amountPaisa <= 0) {
    return {
      ok: false,
      version: VERSION,
      status: 400,
      error: 'amount must be greater than 0'
    };
  }

  if (amountPaisa > remainingBeforePaisa && body.allow_overpay !== true) {
    return {
      ok: false,
      version: VERSION,
      status: 409,
      error: 'payment exceeds remaining debt amount',
      remaining: paisaToMoney(remainingBeforePaisa),
      attempted: amount
    };
  }

  const accountId = text(body.account_id, '', 80);

  if (!accountId) {
    return {
      ok: false,
      version: VERSION,
      status: 400,
      error: 'account_id required'
    };
  }

  const accountResult = await resolveAccount(db, accountId);

  if (!accountResult.ok) {
    return {
      ...accountResult,
      version: VERSION,
      status: accountResult.status || 409
    };
  }

  const paidDate = normalizeDate(body.paid_date || body.date) || todayISO();
  const categoryId = text(body.category_id, DEFAULT_CATEGORY_ID, 80) || DEFAULT_CATEGORY_ID;
  const notes = text(body.notes, '', 220);
  const createdBy = text(body.created_by, DEFAULT_CREATED_BY, 80) || DEFAULT_CREATED_BY;

  const paidAfterPaisa = paidBeforePaisa + amountPaisa;
  const remainingAfterPaisa = Math.max(0, originalPaisa - paidAfterPaisa);

  const txnType = kind === 'owe' ? 'expense' : 'income';
  const balanceProof = await buildBalanceProof(db, accountResult.account, txnType, amountPaisa);
  const duplicateProof = await duplicateDebtPaymentWarning(db, debt.id, amountPaisa, paidDate);

  const warnings = [];

  if (duplicateProof.status === 'warn') {
    warnings.push(duplicateProof);
  }

  const normalized = {
    debt_id: debt.id,
    debt_name: debt.name,
    debt_kind: kind,
    original_amount_paisa: originalPaisa,
    paid_before_paisa: paidBeforePaisa,
    amount,
    amount_paisa: amountPaisa,
    paid_after_paisa: paidAfterPaisa,
    remaining_after_paisa: remainingAfterPaisa,
    original_amount: paisaToMoney(originalPaisa),
    paid_before: paisaToMoney(paidBeforePaisa),
    paid_after: paisaToMoney(paidAfterPaisa),
    remaining_after: paisaToMoney(remainingAfterPaisa),
    account_id: accountResult.account.id,
    category_id: categoryId,
    paid_date: paidDate,
    transaction_type: txnType,
    notes,
    created_by: createdBy
  };

  const transactionPayload = {
    route: 'debts.pay.transaction',
    type: txnType,
    amount,
    account_id: accountResult.account.id,
    category_id: categoryId,
    date: paidDate,
    debt_id: debt.id
  };

  const transactionHash = await hash(transactionPayload);
  const payloadHash = await hash({
    route: 'debts.pay',
    normalized
  });

  const requiresOverride = balanceProof.requires_override === true;
  const overrideReason = requiresOverride ? balanceProof.override_reason : null;
  const overrideToken = requiresOverride
    ? await hash({
      route: 'debts.pay.override',
      reason: overrideReason,
      normalized
    })
    : null;

  return {
    ok: true,
    normalized_payload: normalized,
    payload_hash: payloadHash,
    transaction_payload_hash: transactionHash,
    requires_override: requiresOverride,
    override_reason: overrideReason,
    override_token: overrideToken,
    projected_debt_state: {
      debt_id: debt.id,
      paid_before: paisaToMoney(paidBeforePaisa),
      paid_before_paisa: paidBeforePaisa,
      amount,
      amount_paisa: amountPaisa,
      paid_after: paisaToMoney(paidAfterPaisa),
      paid_after_paisa: paidAfterPaisa,
      remaining_after: paisaToMoney(remainingAfterPaisa),
      remaining_after_paisa: remainingAfterPaisa,
      status_after: remainingAfterPaisa === 0 ? finalStatusForKind(kind) : 'active'
    },
    transaction_proof: {
      action: 'debt_payment',
      writes_performed: false,
      expected_writes: {
        transactions: 1,
        debt_payments: 1,
        debts_update: 1,
        audit: 1
      },
      direction: kind === 'owe' ? 'money_out' : 'money_in',
      transaction_type: txnType,
      balance_projection: balanceProof,
      duplicate_payment: duplicateProof
    },
    warnings
  };
}

async function commitDebtPayment(context, validation) {
  const db = context.env.DB;
  const p = validation.normalized_payload;

  const txCols = await cols(db, 'transactions');
  const paymentCols = await cols(db, 'debt_payments');
  const debtCols = await cols(db, 'debts');

  const transactionId = makeId('tx_debt');
  const paymentId = makeId('debtpay');

  const txNotes = (
    p.debt_kind === 'owe'
      ? `Debt payment: ${p.debt_name}`
      : `Debt received: ${p.debt_name}`
  ) + ` | debt_id=${p.debt_id} | debt_payment_id=${paymentId}` + (p.notes ? ` | notes=${p.notes}` : '');

  const txRow = {
    id: transactionId,
    date: p.paid_date,
    type: p.transaction_type,
    amount: p.amount,
    account_id: p.account_id,
    transfer_to_account_id: null,
    category_id: p.category_id,
    notes: txNotes.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    pkr_amount: p.amount,
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    created_by: p.created_by,
    created_at: nowISO()
  };

  const paymentRow = {
    id: paymentId,
    debt_id: p.debt_id,
    debt_name_snapshot: p.debt_name,
    debt_kind_snapshot: p.debt_kind,

    original_amount_paisa: p.original_amount_paisa,
    paid_before_paisa: p.paid_before_paisa,
    amount_paisa: p.amount_paisa,
    paid_after_paisa: p.paid_after_paisa,
    remaining_after_paisa: p.remaining_after_paisa,

    original_amount: p.original_amount,
    paid_before: p.paid_before,
    amount: p.amount,
    paid_after: p.paid_after,
    remaining_after: p.remaining_after,

    account_id: p.account_id,
    category_id: p.category_id,
    paid_date: p.paid_date,
    transaction_id: transactionId,
    status: 'paid',

    notes: p.notes,
    dry_run_payload_hash: validation.payload_hash,
    transaction_payload_hash: validation.transaction_payload_hash,

    created_by: p.created_by,
    created_at: nowISO()
  };

  const debtPatch = {
    paid_amount: p.paid_after,
    last_paid_date: p.paid_date,
    status: p.remaining_after_paisa === 0 ? finalStatusForKind(p.debt_kind) : 'active'
  };

  await db.batch([
    buildInsert(db, 'transactions', filterToCols(txCols, txRow)),
    buildInsert(db, 'debt_payments', filterToCols(paymentCols, paymentRow)),
    buildUpdate(db, 'debts', debtCols, p.debt_id, debtPatch)
  ]);

  await safeAudit(context, {
    action: p.debt_kind === 'owe' ? 'DEBT_PAYMENT' : 'RECEIVABLE_RECEIVED',
    entity: 'debt',
    entity_id: p.debt_id,
    kind: 'mutation',
    detail: {
      debt_payment_id: paymentId,
      transaction_id: transactionId,
      amount: p.amount,
      amount_paisa: p.amount_paisa,
      paid_before: p.paid_before,
      paid_after: p.paid_after,
      remaining_after: p.remaining_after,
      account_id: p.account_id,
      category_id: p.category_id,
      payload_hash: validation.payload_hash
    },
    created_by: p.created_by
  });

  return json({
    ok: true,
    version: VERSION,
    debt_id: p.debt_id,
    debt_payment_id: paymentId,
    transaction_id: transactionId,
    projected_debt_state: validation.projected_debt_state,
    payload_hash: validation.payload_hash
  });
}

/* helpers */

async function getDebt(db, id) {
  return db.prepare(
    `SELECT *
     FROM debts
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

async function resolveAccount(db, accountId) {
  const row = await db.prepare(
    `SELECT *
     FROM accounts
     WHERE id = ?
       AND ${ACTIVE_ACCOUNT_CONDITION}
     LIMIT 1`
  ).bind(accountId).first();

  if (!row) {
    return {
      ok: false,
      status: 409,
      error: 'account not found or inactive',
      account_id: accountId
    };
  }

  return {
    ok: true,
    account: row
  };
}

async function buildBalanceProof(db, account, txnType, amountPaisa) {
  const current = await computeAccountBalancePaisa(db, account.id);
  const projected = txnType === 'income'
    ? current + amountPaisa
    : current - amountPaisa;

  const kind = classifyAccount(account);

  const proof = {
    check: 'debt_payment_balance_projection',
    account_id: account.id,
    account_kind: kind,
    current_balance: paisaToMoney(current),
    current_balance_paisa: current,
    payment_amount: paisaToMoney(amountPaisa),
    payment_amount_paisa: amountPaisa,
    projected_balance: paisaToMoney(projected),
    projected_balance_paisa: projected,
    requires_override: false,
    override_reason: null,
    status: 'pass'
  };

  if (txnType === 'expense' && kind === 'asset' && projected < -BALANCE_TOLERANCE_PAISA) {
    proof.status = 'blocked';
    proof.requires_override = true;
    proof.override_reason = 'asset_overdraft';
  }

  return proof;
}

async function computeAccountBalancePaisa(db, accountId) {
  const rows = await db.prepare(
    `SELECT type, amount, notes, reversed_by, reversed_at
     FROM transactions
     WHERE account_id = ?`
  ).bind(accountId).all();

  let balance = 0;

  for (const row of rows.results || []) {
    if (isReversal(row)) continue;

    const amount = moneyToPaisa(row.amount || 0);
    const typeValue = String(row.type || '').toLowerCase();

    if (['income', 'borrow', 'salary', 'opening', 'debt_in'].includes(typeValue)) {
      balance += amount;
    } else {
      balance -= amount;
    }
  }

  return balance;
}

async function duplicateDebtPaymentWarning(db, debtId, amountPaisa, paidDate) {
  const rows = await db.prepare(
    `SELECT id
     FROM debt_payments
     WHERE debt_id = ?
       AND amount_paisa = ?
       AND paid_date = ?
       AND status = 'paid'
     LIMIT 5`
  ).bind(debtId, amountPaisa, paidDate).all();

  const matches = rows.results || [];

  if (!matches.length) {
    return {
      check: 'duplicate_payment',
      status: 'pass',
      detail: 'No same debt/date/amount active payment found.'
    };
  }

  return {
    check: 'duplicate_payment',
    status: 'warn',
    possible_duplicate_payment_ids: matches.map(r => r.id),
    detail: 'Possible duplicate debt payment.'
  };
}

function finalStatusForKind(kind) {
  return kind === 'owed' ? 'settled' : 'closed';
}

function classifyAccount(account) {
  const joined = [
    account.kind,
    account.type,
    account.account_type,
    account.name,
    account.id
  ].map(v => String(v || '').toLowerCase()).join(' ');

  if (
    joined.includes('credit') ||
    joined.includes('liability') ||
    joined.includes('cc')
  ) {
    return 'liability';
  }

  return 'asset';
}

function isReversal(row) {
  const notes = String(row.notes || '').toUpperCase();
  return notes.includes('[REVERSAL OF ');
}

async function cols(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  const set = new Set();

  for (const row of result.results || []) {
    if (row.name) set.add(row.name);
  }

  return set;
}

function filterToCols(colSet, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (colSet.has(key)) out[key] = value;
  }

  return out;
}

function buildInsert(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('no insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(k => row[k]));
}

function buildUpdate(db, table, colSet, id, patch) {
  const keys = Object.keys(patch).filter(k => colSet.has(k));

  if (!keys.length) {
    return db.prepare(`SELECT 1`).bind();
  }

  return db.prepare(
    `UPDATE ${table}
     SET ${keys.map(k => `${k} = ?`).join(', ')}
     WHERE id = ?`
  ).bind(...keys.map(k => patch[k]), id);
}

async function safeAudit(context, event) {
  try {
    const result = await audit(context.env, {
      ...event,
      detail: typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail || {})
    });

    return {
      ok: !!(result && result.ok),
      error: result && result.error ? result.error : null
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

function getDebtId(context) {
  const params = context.params || {};
  return text(params.id || params.debt_id || '', '', 120);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}

function moneyToPaisa(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function paisaToMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeDate(value) {
  const raw = text(value, '', 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function text(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, max);
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function hash(value) {
  const canonical = JSON.stringify(sortKeys(value));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);

  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }

  return value;
}