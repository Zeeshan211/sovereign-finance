/*  /api/transactions  GET list, POST create  */
/* Cloudflare Pages Function v0.1.4  Account FK guard + category canonicalization */
/*
* Changes vs v0.1.3:
*   - Validates and canonicalizes account_id before any transaction insert.
*   - Validates and canonicalizes transfer_to_account_id for transfer and cc_payment.
*   - Accepts account labels/names such as "Meezan" or "🏦 Meezan" and resolves to accounts.id.
*   - Keeps transfer POST as Sheet-compatible 2-row pair:
*       OUT row: type=transfer, source account
*       IN row:  type=income, destination account
*   - Keeps category_id nullable.
*   - If category_id is provided, validates/canonicalizes it or returns a clean error.
*   - Returns clean FK guard errors instead of raw D1 FOREIGN KEY failures.
*   - Keeps audit safe-wrapped so audit failure cannot break transaction insert.
*/

import { audit } from './_lib.js';

const VERSION = 'v0.1.4';

const ALLOWED_TYPES = [
  'expense',
  'income',
  'transfer',
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

const ACTIVE_ACCOUNT_CONDITION = "(deleted_at IS NULL OR deleted_at = '') AND (archived_at IS NULL OR archived_at = '') AND (status IS NULL OR status = '' OR status = 'active')";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const includeReversed = url.searchParams.get('include_reversed') === '1';

    const stmt = context.env.DB.prepare(
      `SELECT id, date, type, amount, account_id, transfer_to_account_id,
              category_id, notes, fee_amount, pra_amount, created_at,
              reversed_by, reversed_at, linked_txn_id
       FROM transactions
       ORDER BY date DESC, datetime(created_at) DESC, id DESC
       LIMIT 200`
    );

    const result = await stmt.all();
    const allRows = result.results || [];
    const visibleRows = includeReversed
      ? allRows
      : allRows.filter(t => !isReversalRow(t));

    return jsonResponse({
      ok: true,
      version: VERSION,
      include_reversed: includeReversed,
      count: visibleRows.length,
      hidden_reversal_count: allRows.length - visibleRows.length,
      transactions: visibleRows
    });
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await readJSON(context.request);
    const amount = Number(body.amount);
    const type = cleanText(body.type, '', 40).toLowerCase();

    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Amount must be greater than 0' }, 400);
    }

    if (!body.account_id) {
      return jsonResponse({ ok: false, version: VERSION, error: 'account_id required' }, 400);
    }

    if (!type) {
      return jsonResponse({ ok: false, version: VERSION, error: 'type required' }, 400);
    }

    if (!ALLOWED_TYPES.includes(type)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Invalid type',
        allowed_types: ALLOWED_TYPES
      }, 400);
    }

    body.type = type;

    if (type === 'transfer') {
      return createTransferPair(context, body, amount);
    }

    return createSingleTransaction(context, body, amount);
  } catch (err) {
    return jsonResponse({ ok: false, version: VERSION, error: err.message }, 500);
  }
}

async function createSingleTransaction(context, body, amount) {
  const db = context.env.DB;
  const id = makeTxnId('tx');
  const date = normalizeDate(body.date) || todayISO();
  const notes = cleanNotes(body.notes);
  const feeAmount = cleanAmount(body.fee_amount);
  const praAmount = cleanAmount(body.pra_amount);

  const sourceAccountResult = await resolveAccount(db, body.account_id);

  if (!sourceAccountResult.ok) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: sourceAccountResult.error,
      account_input: cleanText(body.account_id, '', 160)
    }, sourceAccountResult.status || 409);
  }

  const sourceAccount = sourceAccountResult.account;
  let transferToAccount = null;

  if (body.type === 'cc_payment') {
    if (!body.transfer_to_account_id) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'transfer_to_account_id required for cc_payment'
      }, 400);
    }

    const targetResult = await resolveAccount(db, body.transfer_to_account_id);

    if (!targetResult.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: targetResult.error,
        transfer_to_account_input: cleanText(body.transfer_to_account_id, '', 160)
      }, targetResult.status || 409);
    }

    transferToAccount = targetResult.account;

    if (sourceAccount.id === transferToAccount.id) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'source and destination accounts cannot match'
      }, 400);
    }
  } else if (body.transfer_to_account_id) {
    const targetResult = await resolveAccount(db, body.transfer_to_account_id);

    if (!targetResult.ok) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: targetResult.error,
        transfer_to_account_input: cleanText(body.transfer_to_account_id, '', 160)
      }, targetResult.status || 409);
    }

    transferToAccount = targetResult.account;
  }

  const categoryResult = await resolveCategory(db, body.category_id);

  if (!categoryResult.ok) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: categoryResult.error,
      category_input: cleanText(body.category_id, '', 160)
    }, categoryResult.status || 409);
  }

  const categoryId = categoryResult.category_id;

  try {
    await db.prepare(
      `INSERT INTO transactions
       (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      date,
      body.type,
      amount,
      sourceAccount.id,
      transferToAccount ? transferToAccount.id : null,
      categoryId,
      notes,
      feeAmount,
      praAmount
    ).run();
  } catch (err) {
    if (isForeignKeyError(err)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Transaction failed account/category foreign-key guard. Refresh accounts/categories and retry.',
        account_input: cleanText(body.account_id, '', 160),
        resolved_account_id: sourceAccount.id,
        transfer_to_account_input: cleanText(body.transfer_to_account_id, '', 160),
        resolved_transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
        category_input: cleanText(body.category_id, '', 160),
        resolved_category_id: categoryId,
        d1_error: err.message
      }, 409);
    }

    throw err;
  }

  const auditResult = await safeAudit(context, {
    action: body.type === 'cc_payment' ? 'CC_PAYMENT' : 'TXN_ADD',
    entity: 'transaction',
    entity_id: id,
    kind: 'mutation',
    detail: {
      type: body.type,
      amount,
      account_input: cleanText(body.account_id, '', 160),
      account_id: sourceAccount.id,
      account_name: sourceAccount.name || sourceAccount.id,
      transfer_to_account_input: cleanText(body.transfer_to_account_id, '', 160) || null,
      transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
      transfer_to_account_name: transferToAccount ? (transferToAccount.name || transferToAccount.id) : null,
      category_input: cleanText(body.category_id, '', 160) || null,
      category_id: categoryId,
      date,
      notes: notes.slice(0, 80)
    },
    created_by: body.created_by || 'web-add'
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id,
    account_id: sourceAccount.id,
    account_name: sourceAccount.name || sourceAccount.id,
    transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
    transfer_to_account_name: transferToAccount ? (transferToAccount.name || transferToAccount.id) : null,
    category_id: categoryId,
    audited: auditResult.ok,
    audit_error: auditResult.error || null
  });
}

async function createTransferPair(context, body, amount) {
  const db = context.env.DB;
  const date = normalizeDate(body.date) || todayISO();
  const feeAmount = cleanAmount(body.fee_amount);
  const praAmount = cleanAmount(body.pra_amount);

  if (!body.transfer_to_account_id) {
    return jsonResponse({ ok: false, version: VERSION, error: 'transfer_to_account_id required for transfer' }, 400);
  }

  const fromResult = await resolveAccount(db, body.account_id);

  if (!fromResult.ok) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: fromResult.error,
      account_input: cleanText(body.account_id, '', 160)
    }, fromResult.status || 409);
  }

  const toResult = await resolveAccount(db, body.transfer_to_account_id);

  if (!toResult.ok) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: toResult.error,
      transfer_to_account_input: cleanText(body.transfer_to_account_id, '', 160)
    }, toResult.status || 409);
  }

  const fromAccount = fromResult.account;
  const toAccount = toResult.account;

  if (fromAccount.id === toAccount.id) {
    return jsonResponse({ ok: false, version: VERSION, error: 'source and destination accounts cannot match' }, 400);
  }

  const outId = makeTxnId('txout');
  const inId = makeTxnId('txin');
  const baseNotes = cleanNotes(body.notes || 'Transfer');
  const outNotes = `To: ${toAccount.name || toAccount.id}  ${baseNotes} (OUT) [linked: ${inId}]`.slice(0, 200);
  const inNotes = `From: ${fromAccount.name || fromAccount.id}  ${baseNotes} (IN) [linked: ${outId}]`.slice(0, 200);

  const outStmt = db.prepare(
    `INSERT INTO transactions
     (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    outId,
    date,
    'transfer',
    amount,
    fromAccount.id,
    null,
    null,
    outNotes,
    feeAmount,
    praAmount
  );

  const inStmt = db.prepare(
    `INSERT INTO transactions
     (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    inId,
    date,
    'income',
    amount,
    toAccount.id,
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
        from_account_input: cleanText(body.account_id, '', 160),
        resolved_from_account_id: fromAccount.id,
        to_account_input: cleanText(body.transfer_to_account_id, '', 160),
        resolved_to_account_id: toAccount.id,
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
      amount,
      from_account_input: cleanText(body.account_id, '', 160),
      from_account_id: fromAccount.id,
      from_account_name: fromAccount.name || fromAccount.id,
      to_account_input: cleanText(body.transfer_to_account_id, '', 160),
      to_account_id: toAccount.id,
      to_account_name: toAccount.name || toAccount.id,
      out_id: outId,
      in_id: inId,
      category_id: null,
      date,
      notes: baseNotes.slice(0, 80)
    },
    created_by: body.created_by || 'web-add'
  });

  return jsonResponse({
    ok: true,
    version: VERSION,
    id: outId,
    linked_id: inId,
    ids: [outId, inId],
    from_account_id: fromAccount.id,
    from_account_name: fromAccount.name || fromAccount.id,
    to_account_id: toAccount.id,
    to_account_name: toAccount.name || toAccount.id,
    transfer_model: 'legacy_2_row',
    audited: auditResult.ok,
    audit_error: auditResult.error || null
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

async function resolveCategory(db, input) {
  const raw = cleanText(input, '', 160);

  if (!raw) {
    return { ok: true, category_id: null };
  }

  try {
    const exact = await db.prepare(
      `SELECT id
       FROM categories
       WHERE id = ?`
    ).bind(raw).first();

    if (exact && exact.id) {
      return { ok: true, category_id: exact.id };
    }

    const categoriesResult = await db.prepare(
      `SELECT id, name
       FROM categories
       ORDER BY name, id`
    ).all();

    const categories = categoriesResult.results || [];
    const wanted = token(raw);

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
      error: 'Category not found. Clear category or refresh categories and retry.'
    };
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: 'Category validation failed. Clear category and retry.'
    };
  }
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
  return String(err && err.message || '').toLowerCase().includes('foreign key');
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
