/* ─── /api/nano-loans/[[path]] · v0.1.0 · Sheet Nano Loan web port ─── */
/*
 * Source logic:
 *   Finance_NanoLoan.gs
 *
 * D1 table:
 *   nano_loans
 *
 * Routes:
 *   GET  /api/nano-loans
 *   POST /api/nano-loans
 *   POST /api/nano-loans/{id}/repay
 *   POST /api/nano-loans/{id}/push-to-cc
 *
 * Ledger rules:
 *   - Creating a nano loan writes:
 *       1 nano_loans row
 *       1 transactions row with type='borrow'
 *
 *   - Repaying a nano loan writes:
 *       1 transactions row with type='repay'
 *       updates nano_loans.repaid_amount
 *       closes loan when repaid_amount >= total_owed
 *
 *   - Pushing a nano loan to CC writes:
 *       1 transactions row with type='cc_payment'
 *       optional cool-off fee row with type='expense'
 *       marks pushed_at / pushed_txn_id / push_fee_txn_id
 *
 * Safety:
 *   - No schema mutation.
 *   - No test data.
 *   - All mutations write audit_log through _lib.audit().
 */

import { json, audit } from '../_lib.js';

const VERSION = 'v0.1.0';

const DEFAULT_CC_ACCOUNT_ID = 'cc';

const ACTIVE_ACCOUNT_CONDITION = "(deleted_at IS NULL OR deleted_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    const [loans, accountsRes, ccAccountsRes] = await Promise.all([
      loadLoans(db),
      db.prepare(
        `SELECT id, name, icon, type, kind, display_order
         FROM accounts
         WHERE ${ACTIVE_ACCOUNT_CONDITION}
         ORDER BY display_order, name`
      ).all(),
      db.prepare(
        `SELECT id, name, icon, type, kind, display_order
         FROM accounts
         WHERE ${ACTIVE_ACCOUNT_CONDITION}
           AND (id = ? OR kind = 'cc' OR type = 'liability')
         ORDER BY display_order, name`
      ).bind(DEFAULT_CC_ACCOUNT_ID).all()
    ]);

    const accounts = accountsRes.results || [];
    const sourceAccounts = accounts.filter(account => account.type === 'asset' && account.kind !== 'cc');
    const ccAccounts = ccAccountsRes.results || [];

    const activeLoans = loans.filter(loan => loan.status === 'active');
    const closedLoans = loans.filter(loan => loan.status === 'closed');

    const totalPrincipal = activeLoans.reduce((sum, loan) => sum + number(loan.principal_amount), 0);
    const totalOwed = activeLoans.reduce((sum, loan) => sum + number(loan.total_owed), 0);
    const totalRepaid = activeLoans.reduce((sum, loan) => sum + number(loan.repaid_amount), 0);
    const remaining = activeLoans.reduce((sum, loan) => sum + remainingForLoan(loan), 0);
    const coolOffFees = activeLoans.reduce((sum, loan) => sum + number(loan.cool_off_fee), 0);
    const pushedCount = activeLoans.filter(loan => loan.pushed_at).length;

    return json({
      ok: true,
      version: VERSION,
      defaults: {
        cc_account_id: DEFAULT_CC_ACCOUNT_ID
      },
      accounts,
      source_accounts: sourceAccounts,
      cc_accounts: ccAccounts,
      loans,
      active_loans: activeLoans,
      closed_loans: closedLoans,
      summary: {
        active_count: activeLoans.length,
        closed_count: closedLoans.length,
        total_principal: round2(totalPrincipal),
        total_owed: round2(totalOwed),
        total_repaid: round2(totalRepaid),
        remaining: round2(remaining),
        cool_off_fees: round2(coolOffFees),
        pushed_count: pushedCount,
        unpushed_count: Math.max(0, activeLoans.length - pushedCount)
      }
    });
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = context.params.path || [];
    const loanId = cleanText(path[0] || '', 120);
    const action = cleanText(path[1] || '', 40);

    if (!loanId && !action) {
      return createNanoLoan(context);
    }

    if (loanId && action === 'repay') {
      return repayNanoLoan(context, loanId);
    }

    if (loanId && action === 'push-to-cc') {
      return pushNanoLoanToCC(context, loanId);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported nano loan route',
      supported: [
        'GET /api/nano-loans',
        'POST /api/nano-loans',
        'POST /api/nano-loans/{id}/repay',
        'POST /api/nano-loans/{id}/push-to-cc'
      ]
    }, 400);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createNanoLoan(context) {
  const db = context.env.DB;
  const body = await context.request.json();

  const date = cleanDate(body.date);
  const appName = cleanText(body.app_name || body.name || '', 80);
  const appCode = cleanId(body.app_code || appName || 'nano');
  const shape = normalizeShape(body.shape);
  const principalAmount = number(body.principal_amount || body.amount);
  const coolOffFee = number(body.cool_off_fee);
  const totalOwed = number(body.total_owed || (principalAmount + coolOffFee));
  const sourceAccountId = cleanId(body.source_account_id || body.account_id || '');
  const notes = cleanText(body.notes || '', 300);
  const createdBy = cleanText(body.created_by || 'web-nano-loans', 80);

  if (!appName) {
    return json({ ok: false, version: VERSION, error: 'app_name is required' }, 400);
  }

  if (!(principalAmount > 0)) {
    return json({ ok: false, version: VERSION, error: 'principal_amount must be greater than 0' }, 400);
  }

  if (coolOffFee < 0) {
    return json({ ok: false, version: VERSION, error: 'cool_off_fee cannot be negative' }, 400);
  }

  if (!(totalOwed > 0)) {
    return json({ ok: false, version: VERSION, error: 'total_owed must be greater than 0' }, 400);
  }

  if (totalOwed < principalAmount) {
    return json({ ok: false, version: VERSION, error: 'total_owed cannot be less than principal_amount' }, 400);
  }

  if (!sourceAccountId) {
    return json({ ok: false, version: VERSION, error: 'source_account_id is required' }, 400);
  }

  const source = await loadAccount(db, sourceAccountId);

  if (!source) {
    return json({ ok: false, version: VERSION, error: 'source account not found', account_id: sourceAccountId }, 404);
  }

  if (source.type !== 'asset') {
    return json({ ok: false, version: VERSION, error: 'source account must be an asset account' }, 400);
  }

  const loanId = makeId('nano');
  const txnInId = makeId('nanoin');

  const loanNotes = notes || `${appName} nano loan`;
  const txnNotes = `[NANO_LOAN_IN] ${appName} · principal ${formatAmount(principalAmount)} · loan ${loanId}`.slice(0, 200);

  await db.batch([
    db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, merchant_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      txnInId,
      date,
      'borrow',
      principalAmount,
      sourceAccountId,
      null,
      null,
      null,
      txnNotes,
      0,
      0,
      loanId
    ),
    db.prepare(
      `INSERT INTO nano_loans
        (id, date, app_code, app_name, status, shape, principal_amount, cool_off_fee, total_owed, repaid_amount, source_account_id, txn_in_id, cool_off_due, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      loanId,
      date,
      appCode,
      appName,
      'active',
      shape,
      principalAmount,
      coolOffFee,
      totalOwed,
      0,
      sourceAccountId,
      txnInId,
      cleanDateOrNull(body.cool_off_due),
      loanNotes
    )
  ]);

  const auditResult = await safeAudit(context.env, {
    action: 'NANO_LOAN_CREATE',
    entity: 'nano_loan',
    entity_id: loanId,
    kind: 'mutation',
    detail: {
      loan_id: loanId,
      txn_in_id: txnInId,
      app_code: appCode,
      app_name: appName,
      shape,
      principal_amount: principalAmount,
      cool_off_fee: coolOffFee,
      total_owed: totalOwed,
      source_account_id: sourceAccountId,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    loan_id: loanId,
    txn_in_id: txnInId,
    status: 'active',
    principal_amount: round2(principalAmount),
    cool_off_fee: round2(coolOffFee),
    total_owed: round2(totalOwed),
    remaining: round2(totalOwed),
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function repayNanoLoan(context, loanId) {
  const db = context.env.DB;
  const body = await context.request.json();

  const loan = await loadLoan(db, loanId);

  if (!loan) {
    return json({ ok: false, version: VERSION, error: 'nano loan not found', loan_id: loanId }, 404);
  }

  if (loan.status !== 'active') {
    return json({ ok: false, version: VERSION, error: 'nano loan is not active', loan_id: loanId, status: loan.status }, 400);
  }

  const remaining = remainingForLoan(loan);
  const amount = body.amount == null || body.amount === '' ? remaining : number(body.amount);
  const accountId = cleanId(body.account_id || body.source_account_id || loan.source_account_id);
  const date = cleanDate(body.date);
  const createdBy = cleanText(body.created_by || 'web-nano-repay', 80);

  if (!(amount > 0)) {
    return json({ ok: false, version: VERSION, error: 'repay amount must be greater than 0' }, 400);
  }

  if (amount > remaining + 0.01) {
    return json({
      ok: false,
      version: VERSION,
      error: 'repay amount cannot exceed remaining balance',
      remaining: round2(remaining)
    }, 400);
  }

  const account = await loadAccount(db, accountId);

  if (!account) {
    return json({ ok: false, version: VERSION, error: 'repayment account not found', account_id: accountId }, 404);
  }

  if (account.type !== 'asset') {
    return json({ ok: false, version: VERSION, error: 'repayment account must be an asset account' }, 400);
  }

  const repayTxnId = makeId('nanorepay');
  const newRepaid = number(loan.repaid_amount) + amount;
  const nowClosed = newRepaid + 0.01 >= number(loan.total_owed);
  const nextStatus = nowClosed ? 'closed' : 'active';

  const notes = `[NANO_LOAN_REPAY] ${loan.app_name} · loan ${loan.id} · ${nowClosed ? 'closed' : 'partial'}`.slice(0, 200);

  await db.batch([
    db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, merchant_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      repayTxnId,
      date,
      'repay',
      amount,
      accountId,
      null,
      null,
      null,
      notes,
      0,
      0,
      loan.id
    ),
    db.prepare(
      `UPDATE nano_loans
       SET repaid_amount = ?,
           repay_txn_id = ?,
           status = ?,
           closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      round2(newRepaid),
      repayTxnId,
      nextStatus,
      nextStatus,
      loan.id
    )
  ]);

  const auditResult = await safeAudit(context.env, {
    action: 'NANO_LOAN_REPAY',
    entity: 'nano_loan',
    entity_id: loan.id,
    kind: 'mutation',
    detail: {
      loan_id: loan.id,
      repay_txn_id: repayTxnId,
      amount,
      account_id: accountId,
      previous_repaid: number(loan.repaid_amount),
      new_repaid: round2(newRepaid),
      total_owed: number(loan.total_owed),
      status: nextStatus,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    loan_id: loan.id,
    repay_txn_id: repayTxnId,
    amount: round2(amount),
    repaid_amount: round2(newRepaid),
    remaining: round2(Math.max(0, number(loan.total_owed) - newRepaid)),
    status: nextStatus,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function pushNanoLoanToCC(context, loanId) {
  const db = context.env.DB;
  const body = await context.request.json();

  const loan = await loadLoan(db, loanId);

  if (!loan) {
    return json({ ok: false, version: VERSION, error: 'nano loan not found', loan_id: loanId }, 404);
  }

  if (loan.status !== 'active') {
    return json({ ok: false, version: VERSION, error: 'nano loan is not active', loan_id: loanId, status: loan.status }, 400);
  }

  if (loan.pushed_at || loan.pushed_txn_id) {
    return json({
      ok: false,
      version: VERSION,
      error: 'nano loan already pushed to CC',
      loan_id: loan.id,
      pushed_at: loan.pushed_at,
      pushed_txn_id: loan.pushed_txn_id
    }, 400);
  }

  const sourceAccountId = cleanId(body.source_account_id || loan.source_account_id);
  const ccAccountId = cleanId(body.cc_account_id || DEFAULT_CC_ACCOUNT_ID);
  const amount = body.amount == null || body.amount === '' ? number(loan.principal_amount) : number(body.amount);
  const includeFee = body.include_cool_off_fee !== false;
  const date = cleanDate(body.date);
  const createdBy = cleanText(body.created_by || 'web-nano-push-cc', 80);

  if (!(amount > 0)) {
    return json({ ok: false, version: VERSION, error: 'push amount must be greater than 0' }, 400);
  }

  const source = await loadAccount(db, sourceAccountId);
  const cc = await loadAccount(db, ccAccountId, true);

  if (!source) {
    return json({ ok: false, version: VERSION, error: 'source account not found', account_id: sourceAccountId }, 404);
  }

  if (!cc) {
    return json({ ok: false, version: VERSION, error: 'CC account not found', account_id: ccAccountId }, 404);
  }

  if (source.type !== 'asset') {
    return json({ ok: false, version: VERSION, error: 'source account must be an asset account' }, 400);
  }

  const pushedTxnId = makeId('nanocc');
  const feeTxnId = includeFee && number(loan.cool_off_fee) > 0 ? makeId('nanofee') : null;

  const batch = [
    db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, merchant_id, notes, fee_amount, pra_amount, linked_txn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      pushedTxnId,
      date,
      'cc_payment',
      amount,
      sourceAccountId,
      ccAccountId,
      null,
      null,
      `[NANO_PUSH_TO_CC] ${loan.app_name} · loan ${loan.id} · pushed principal to CC`.slice(0, 200),
      0,
      0,
      loan.id
    )
  ];

  if (feeTxnId) {
    batch.push(
      db.prepare(
        `INSERT INTO transactions
          (id, date, type, amount, account_id, transfer_to_account_id, category_id, merchant_id, notes, fee_amount, pra_amount, linked_txn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        feeTxnId,
        date,
        'expense',
        number(loan.cool_off_fee),
        sourceAccountId,
        null,
        null,
        null,
        `[NANO_COOL_OFF_FEE] ${loan.app_name} · loan ${loan.id}`.slice(0, 200),
        0,
        0,
        loan.id
      )
    );
  }

  batch.push(
    db.prepare(
      `UPDATE nano_loans
       SET pushed_at = datetime('now'),
           pushed_txn_id = ?,
           push_fee_txn_id = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(
      pushedTxnId,
      feeTxnId,
      loan.id
    )
  );

  await db.batch(batch);

  const auditResult = await safeAudit(context.env, {
    action: 'NANO_PUSH_TO_CC',
    entity: 'nano_loan',
    entity_id: loan.id,
    kind: 'mutation',
    detail: {
      loan_id: loan.id,
      app_name: loan.app_name,
      pushed_txn_id: pushedTxnId,
      push_fee_txn_id: feeTxnId,
      amount,
      cool_off_fee: feeTxnId ? number(loan.cool_off_fee) : 0,
      source_account_id: sourceAccountId,
      cc_account_id: ccAccountId,
      date
    },
    created_by: createdBy
  });

  return json({
    ok: true,
    version: VERSION,
    loan_id: loan.id,
    pushed_txn_id: pushedTxnId,
    push_fee_txn_id: feeTxnId,
    amount: round2(amount),
    cool_off_fee: feeTxnId ? round2(loan.cool_off_fee) : 0,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function loadLoans(db) {
  const res = await db.prepare(
    `SELECT
       id,
       date,
       app_code,
       app_name,
       status,
       shape,
       principal_amount,
       cool_off_fee,
       total_owed,
       repaid_amount,
       source_account_id,
       txn_in_id,
       repay_txn_id,
       pushed_at,
       pushed_txn_id,
       push_fee_txn_id,
       cool_off_due,
       closed_at,
       notes,
       created_at,
       updated_at
     FROM nano_loans
     ORDER BY
       CASE status WHEN 'active' THEN 0 WHEN 'defaulted' THEN 1 ELSE 2 END,
       date DESC,
       datetime(created_at) DESC,
       app_name`
  ).all();

  const rows = res.results || [];

  return rows.map(loan => ({
    ...loan,
    principal_amount: round2(loan.principal_amount),
    cool_off_fee: round2(loan.cool_off_fee),
    total_owed: round2(loan.total_owed),
    repaid_amount: round2(loan.repaid_amount),
    remaining_amount: round2(remainingForLoan(loan)),
    progress_pct: progressPct(loan)
  }));
}

async function loadLoan(db, id) {
  return db.prepare(
    `SELECT
       id,
       date,
       app_code,
       app_name,
       status,
       shape,
       principal_amount,
       cool_off_fee,
       total_owed,
       repaid_amount,
       source_account_id,
       txn_in_id,
       repay_txn_id,
       pushed_at,
       pushed_txn_id,
       push_fee_txn_id,
       cool_off_due,
       closed_at,
       notes,
       created_at,
       updated_at
     FROM nano_loans
     WHERE id = ?`
  ).bind(id).first();
}

async function loadAccount(db, id, allowLiability = false) {
  const row = await db.prepare(
    `SELECT id, name, icon, type, kind, status, deleted_at, archived_at
     FROM accounts
     WHERE id = ?
       AND ${ACTIVE_ACCOUNT_CONDITION}`
  ).bind(id).first();

  if (!row) return null;

  if (!allowLiability && row.type !== 'asset') return null;

  return row;
}

function remainingForLoan(loan) {
  return Math.max(0, number(loan.total_owed) - number(loan.repaid_amount));
}

function progressPct(loan) {
  const total = number(loan.total_owed);
  if (total <= 0) return 0;

  return round2(Math.max(0, Math.min(100, (number(loan.repaid_amount) / total) * 100)));
}

function normalizeShape(value) {
  const shape = String(value || 'A').trim().toUpperCase();

  return shape === 'B' ? 'B' : 'A';
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function cleanText(value, max) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max || 200);
}

function cleanDate(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return new Date().toISOString().slice(0, 10);
}

function cleanDateOrNull(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return null;
}

function number(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return n;
}

function round2(value) {
  return Math.round(number(value) * 100) / 100;
}

function formatAmount(value) {
  return String(round2(value));
}

function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function safeAudit(env, event) {
  try {
    const result = await audit(env, {
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
