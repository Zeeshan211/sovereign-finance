/* /api/transactions — GET list, POST create */
/* Sovereign Finance v0.4.1-contract-lock
 *
 * Shipment 3:
 * - No Command Centre gate in production write path.
 * - Backend owns transaction type validation.
 * - Frontend-facing Add types are only expense, income, transfer.
 * - Backend still accepts legacy/system types so old data does not break.
 * - Category inputs are canonicalized against /api/categories aliases.
 * - "adjustment" is explicitly rejected.
 */

import { audit } from './_lib.js';

const VERSION = 'v0.4.1-contract-lock';

const FRONTEND_ADD_TYPES = [
  'expense',
  'income',
  'transfer'
];

const SYSTEM_TYPES = [
  'cc_payment',
  'cc_spend',
  'borrow',
  'repay',
  'atm',
  'salary',
  'opening',
  'debt_in',
  'debt_out'
];

const ALLOWED_TYPES = FRONTEND_ADD_TYPES.concat(SYSTEM_TYPES);

const CATEGORY_ALIASES = {
  grocery: 'groceries',
  groceries: 'groceries',

  food: 'food_dining',
  food_dining: 'food_dining',
  dining: 'food_dining',

  transport: 'transport',
  travel: 'transport',

  bill: 'bills_utilities',
  bills: 'bills_utilities',
  utility: 'bills_utilities',
  utilities: 'bills_utilities',
  bills_utilities: 'bills_utilities',

  health: 'health',
  medical: 'health',

  fee: 'bank_fee',
  bank_fee: 'bank_fee',
  atm: 'atm_fee',
  atm_fee: 'atm_fee',

  cc: 'credit_card',
  card: 'credit_card',
  credit: 'credit_card',
  credit_card: 'credit_card',
  cc_payment: 'credit_card',
  cc_spend: 'credit_card',

  debt: 'debt_payment',
  debt_payment: 'debt_payment',
  repay: 'debt_payment',
  repayment: 'debt_payment',

  salary: 'salary_income',
  salary_income: 'salary_income',

  income: 'manual_income',
  manual_income: 'manual_income',
  manual: 'manual_income',

  transfer: 'transfer',

  misc: 'misc',
  miscellaneous: 'misc',
  other: 'misc',
  general: 'misc'
};

const ACTIVE_ACCOUNT_CONDITION =
  "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const includeReversed = url.searchParams.get('include_reversed') === '1';

    const result = await context.env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, fee_amount, pra_amount, created_at,
              reversed_by, reversed_at, linked_txn_id
       FROM transactions
       ORDER BY date DESC, datetime(created_at) DESC, id DESC
       LIMIT 200`
    ).all();

    const allRows = result.results || [];
    const visibleRows = includeReversed ? allRows : allRows.filter(t => !isReversalRow(t));

    return jsonResponse({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
      count: visibleRows.length,
      hidden_reversal_count: allRows.length - visibleRows.length,
      contract: {
        frontend_add_types: FRONTEND_ADD_TYPES,
        backend_system_types: SYSTEM_TYPES,
        unsupported_types: ['adjustment'],
        category_aliases: CATEGORY_ALIASES
      },
      transactions: visibleRows
    });
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const url = new URL(context.request.url);
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(url, body);

    const validation = await validateTransactionPayload(context, body);

    if (!validation.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        error: validation.error,
        details: validation.details || null
      }, validation.status || 400);
    }

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        writes_performed: false,
        audit_performed: false,
        proof: validation.proof,
        normalized_payload: validation.normalized_payload
      });
    }

    if (validation.normalized_payload.type === 'transfer') {
      return createTransferPair(context, validation);
    }

    return createSingleTransaction(context, validation);
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function validateTransactionPayload(context, body) {
  const db = context.env.DB;
  const amount = Number(body.amount);
  const requestedType = cleanText(body.type || body.transaction_type, '', 40).toLowerCase();
  const type = normalizeType(requestedType);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 400, error: 'Amount must be greater than 0' };
  }

  if (!requestedType) {
    return { ok: false, status: 400, error: 'type required' };
  }

  if (requestedType === 'adjustment' || type === 'adjustment') {
    return {
      ok: false,
      status: 400,
      error: 'Unsupported transaction type',
      details: {
        rejected_type: requestedType,
        allowed_frontend_types: FRONTEND_ADD_TYPES
      }
    };
  }

  if (!ALLOWED_TYPES.includes(type)) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid type',
      details: {
        rejected_type: requestedType,
        allowed_types: ALLOWED_TYPES,
        frontend_add_types: FRONTEND_ADD_TYPES
      }
    };
  }

  const sourceAccountInput = body.account_id || body.from_account_id;

  if (!sourceAccountInput) {
    return { ok: false, status: 400, error: 'account_id required' };
  }

  const sourceAccountResult = await resolveAccount(db, sourceAccountInput);

  if (!sourceAccountResult.ok) {
    return {
      ok: false,
      status: sourceAccountResult.status || 409,
      error: sourceAccountResult.error,
      details: { account_input: cleanText(sourceAccountInput, '', 160) }
    };
  }

  const sourceAccount = sourceAccountResult.account;
  let transferToAccount = null;

  const transferTargetInput =
    body.transfer_to_account_id ||
    body.to_account_id ||
    body.destination_account_id;

  if (type === 'transfer' || type === 'cc_payment' || transferTargetInput) {
    if ((type === 'transfer' || type === 'cc_payment') && !transferTargetInput) {
      return {
        ok: false,
        status: 400,
        error: 'transfer_to_account_id required for ' + type
      };
    }

    if (transferTargetInput) {
      const targetResult = await resolveAccount(db, transferTargetInput);

      if (!targetResult.ok) {
        return {
          ok: false,
          status: targetResult.status || 409,
          error: targetResult.error,
          details: { transfer_to_account_input: cleanText(transferTargetInput, '', 160) }
        };
      }

      transferToAccount = targetResult.account;

      if (sourceAccount.id === transferToAccount.id) {
        return {
          ok: false,
          status: 400,
          error: 'source and destination accounts cannot match'
        };
      }
    }
  }

  let categoryId = null;

  if (type !== 'transfer') {
    const categoryInput = body.category_id || body.category;
    const categoryResult = await resolveCategory(db, categoryInput, type);

    if (!categoryResult.ok) {
      return {
        ok: false,
        status: categoryResult.status || 409,
        error: categoryResult.error,
        details: { category_input: cleanText(categoryInput, '', 160) }
      };
    }

    categoryId = categoryResult.category_id;
  }

  const normalized = {
    date: normalizeDate(body.date) || todayISO(),
    type,
    requested_type: requestedType,
    amount,
    account_id: sourceAccount.id,
    account_name: sourceAccount.name || sourceAccount.id,
    transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
    transfer_to_account_name: transferToAccount ? (transferToAccount.name || transferToAccount.id) : null,
    category_id: categoryId,
    notes: cleanNotes(body.notes || body.description || body.memo),
    fee_amount: cleanAmount(body.fee_amount),
    pra_amount: cleanAmount(body.pra_amount),
    created_by: cleanText(body.created_by, 'web-add', 80) || 'web-add'
  };

  return {
    ok: true,
    normalized_payload: normalized,
    proof: buildWriteProof(normalized)
  };
}

function normalizeType(type) {
  const raw = cleanText(type, '', 40).toLowerCase();

  if (raw === 'manual_income') return 'income';
  if (raw === 'salary_income') return 'salary';
  if (raw === 'debt_payment') return 'repay';
  if (raw === 'credit_card') return 'cc_spend';

  return raw;
}

function buildWriteProof(payload) {
  const isTransfer = payload.type === 'transfer';

  return {
    action: 'transaction.save',
    version: VERSION,
    writes_performed: false,
    validation_status: 'pass',
    write_model: isTransfer ? 'legacy_2_row_transfer_pair' : 'single_transaction_row',
    expected_transaction_rows: isTransfer ? 2 : 1,
    expected_audit_rows: 1,
    contract: {
      frontend_add_types: FRONTEND_ADD_TYPES,
      unsupported_types: ['adjustment'],
      requested_type: payload.requested_type,
      normalized_type: payload.type,
      canonical_category_id: payload.category_id
    },
    checks: [
      {
        check: 'amount_valid',
        status: 'pass',
        source: 'request.amount',
        detail: 'Amount is finite and greater than zero.'
      },
      {
        check: 'type_allowed',
        status: 'pass',
        source: 'request.type',
        detail: 'Type normalized to ' + payload.type + '.'
      },
      {
        check: 'source_account_active',
        status: 'pass',
        source: 'accounts',
        detail: 'Source account resolved to active account_id ' + payload.account_id + '.'
      },
      {
        check: 'destination_account_valid',
        status: payload.type === 'transfer' || payload.type === 'cc_payment' ? 'pass' : 'not_required',
        source: 'accounts',
        detail: payload.transfer_to_account_id
          ? 'Destination account resolved to active account_id ' + payload.transfer_to_account_id + '.'
          : 'Destination account not required for this transaction type.'
      },
      {
        check: 'category_valid',
        status: payload.category_id ? 'pass' : 'not_required',
        source: 'categories',
        detail: payload.category_id
          ? 'Category resolved to canonical category_id ' + payload.category_id + '.'
          : 'Category is empty or not required.'
      }
    ]
  };
}

async function createSingleTransaction(context, validation) {
  const db = context.env.DB;
  const payload = validation.normalized_payload;
  const id = makeTxnId('tx');

  try {
    await db.prepare(
      `INSERT INTO transactions
        (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      payload.date,
      payload.type,
      payload.amount,
      payload.account_id,
      payload.transfer_to_account_id,
      payload.category_id,
      payload.notes,
      payload.fee_amount,
      payload.pra_amount
    ).run();
  } catch (err) {
    if (isForeignKeyError(err)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Transaction failed account/category foreign-key guard. Refresh accounts/categories and retry.',
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  const auditResult = await safeAudit(context, {
    action: payload.type === 'cc_payment' ? 'CC_PAYMENT' : 'TXN_ADD',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      type: payload.type,
      requested_type: payload.requested_type,
      amount: payload.amount,
      account_id: payload.account_id,
      account_name: payload.account_name,
      transfer_to_account_id: payload.transfer_to_account_id,
      transfer_to_account_name: payload.transfer_to_account_name,
      category_id: payload.category_id,
      date: payload.date,
      notes: payload.notes.slice(0, 80)
    },
    created_by: payload.created_by
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id,
    account_id: payload.account_id,
    account_name: payload.account_name,
    transfer_to_account_id: payload.transfer_to_account_id,
    transfer_to_account_name: payload.transfer_to_account_name,
    category_id: payload.category_id,
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    proof: validation.proof
  });
}

async function createTransferPair(context, validation) {
  const db = context.env.DB;
  const payload = validation.normalized_payload;

  const outId = makeTxnId('txout');
  const inId = makeTxnId('txin');
  const baseNotes = cleanNotes(payload.notes || 'Transfer');

  const outNotes = `To: ${payload.transfer_to_account_name || payload.transfer_to_account_id}  ${baseNotes} (OUT) [linked: ${inId}]`.slice(0, 200);
  const inNotes = `From: ${payload.account_name || payload.account_id}  ${baseNotes} (IN) [linked: ${outId}]`.slice(0, 200);

  const outStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    outId,
    payload.date,
    'transfer',
    payload.amount,
    payload.account_id,
    null,
    null,
    outNotes,
    payload.fee_amount,
    payload.pra_amount
  );

  const inStmt = db.prepare(
    `INSERT INTO transactions
      (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    inId,
    payload.date,
    'income',
    payload.amount,
    payload.transfer_to_account_id,
    null,
    null,
    inNotes,
    0,
    0
  );

  try {
    await db.batch([outStmt, inStmt]);
  } catch (err) {
    if (isForeignKeyError(err)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Transfer failed account foreign-key guard. Refresh accounts and retry.',
        normalized_payload: payload,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  const auditResult = await safeAudit(context, {
    action: 'TRANSFER',
    entity: 'transaction',
    entity_id: outId,
    kind: 'mutation',
    detail: {
      type: 'transfer',
      amount: payload.amount,
      from_account_id: payload.account_id,
      from_account_name: payload.account_name,
      to_account_id: payload.transfer_to_account_id,
      to_account_name: payload.transfer_to_account_name,
      out_id: outId,
      in_id: inId,
      category_id: null,
      date: payload.date,
      notes: baseNotes.slice(0, 80)
    },
    created_by: payload.created_by
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id: outId,
    linked_id: inId,
    ids: [outId, inId],
    from_account_id: payload.account_id,
    from_account_name: payload.account_name,
    to_account_id: payload.transfer_to_account_id,
    to_account_name: payload.transfer_to_account_name,
    transfer_model: 'legacy_2_row',
    audited: auditResult.ok,
    audit_error: auditResult.error || null,
    proof: validation.proof
  });
}

async function resolveAccount(db, input) {
  const raw = cleanText(input, '', 160);

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
  const wanted = token(raw);

  const matched = accounts.find(account => {
    const idToken = token(account.id);
    const nameToken = token(account.name);
    const labelToken = token(((account.icon || '') + ' ' + (account.name || '')).trim());

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
    error: 'Account not found or inactive. Refresh accounts and retry.'
  };
}

async function resolveCategory(db, input, type) {
  const raw = cleanText(input, '', 160);

  if (!raw) {
    if (type === 'income' || type === 'salary') {
      return resolveCategory(db, type === 'salary' ? 'salary_income' : 'manual_income', type);
    }

    return resolveCategory(db, 'misc', type);
  }

  const canonicalInput = canonicalCategory(raw);

  try {
    const exact = await db.prepare(
      `SELECT id
       FROM categories
       WHERE id = ?`
    ).bind(canonicalInput).first();

    if (exact && exact.id) {
      return { ok: true, category_id: exact.id };
    }

    const categoriesResult = await db.prepare(
      `SELECT id, name
       FROM categories
       ORDER BY name, id`
    ).all();

    const categories = categoriesResult.results || [];
    const wanted = token(canonicalInput);

    const matched = categories.find(category => {
      return wanted === token(category.id)
        || wanted === token(category.name)
        || raw.toLowerCase() === String(category.name || '').trim().toLowerCase();
    });

    if (matched && matched.id) {
      return { ok: true, category_id: matched.id };
    }

    return {
      ok: false,
      status: 409,
      error: 'Category not found. Use a category from /api/categories.'
    };
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: 'Category validation failed. Use a category from /api/categories.'
    };
  }
}

function canonicalCategory(value) {
  const key = token(value);
  return CATEGORY_ALIASES[key] || cleanText(value, '', 160);
}

function isDryRunRequest(url, body) {
  if (url.searchParams.get('dry_run') === '1') return true;
  if (url.searchParams.get('dry_run') === 'true') return true;
  if (body && body.dry_run === true) return true;
  if (body && body.dry_run === '1') return true;
  if (body && body.dry_run === 'true') return true;
  return false;
}

function isReversalRow(t) {
  if (!t) return false;
  if (t.reversed_by || t.reversed_at) return true;

  const notes = String(t.notes || '').toUpperCase();
  return notes.includes('[REVERSED BY ') || notes.includes('[REVERSAL OF ');
}

async function safeAudit(context, event) {
  try {
    const payload = {
      ...event,
      detail: typeof event.detail === 'string'
        ? event.detail
        : JSON.stringify(event.detail || {})
    };

    const result = await audit(context.env, payload);

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

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);

  if (!raw) return todayISO();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return todayISO();

  return raw.slice(0, 10);
}

function cleanAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) return 0;

  return amount;
}

function cleanNotes(notes) {
  return String(notes || '').trim().slice(0, 200);
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function token(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isForeignKeyError(err) {
  return String((err && err.message) || '').toLowerCase().includes('foreign key');
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
