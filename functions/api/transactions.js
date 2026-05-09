/*  /api/transactions  GET list, POST create  */
/* Cloudflare Pages Function v0.3.0  transaction.save dry-run proof */
/*
* Contract:
*   - GET remains read-only.
*   - POST with dry_run=true validates payload only and performs no transaction/audit writes.
*   - Real POST remains blocked by Command Centre until transaction.save is allowed.
*   - Backend gate checks /api/finance-command-center before real mutation.
*   - No D1 write happens before gate approval.
*   - Account/category validation is shared by dry-run and real save.
*/
import { audit } from './_lib.js';

const VERSION = 'v0.3.0';

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

const gate = await enforceActionGate(context, 'transaction.save');

if (!gate.allowed) {
return jsonResponse({
ok: false,
version: VERSION,
error: 'Command Centre blocked transaction.save',
enforcement: gate,
proof: validation.proof
}, 423);
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
const type = cleanText(body.type, '', 40).toLowerCase();

if (!Number.isFinite(amount) || amount <= 0) {
return { ok: false, status: 400, error: 'Amount must be greater than 0' };
}

if (!body.account_id) {
return { ok: false, status: 400, error: 'account_id required' };
}

if (!type) {
return { ok: false, status: 400, error: 'type required' };
}

if (!ALLOWED_TYPES.includes(type)) {
return {
ok: false,
status: 400,
error: 'Invalid type',
details: { allowed_types: ALLOWED_TYPES }
};
}

const sourceAccountResult = await resolveAccount(db, body.account_id);

if (!sourceAccountResult.ok) {
return {
ok: false,
status: sourceAccountResult.status || 409,
error: sourceAccountResult.error,
details: { account_input: cleanText(body.account_id, '', 160) }
};
}

const sourceAccount = sourceAccountResult.account;
let transferToAccount = null;

if (type === 'transfer' || type === 'cc_payment' || body.transfer_to_account_id) {
if ((type === 'transfer' || type === 'cc_payment') && !body.transfer_to_account_id) {
return {
ok: false,
status: 400,
error: 'transfer_to_account_id required for ' + type
};
}

if (body.transfer_to_account_id) {
const targetResult = await resolveAccount(db, body.transfer_to_account_id);

if (!targetResult.ok) {
return {
ok: false,
status: targetResult.status || 409,
error: targetResult.error,
details: { transfer_to_account_input: cleanText(body.transfer_to_account_id, '', 160) }
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
const categoryResult = await resolveCategory(db, body.category_id);

if (!categoryResult.ok) {
return {
ok: false,
status: categoryResult.status || 409,
error: categoryResult.error,
details: { category_input: cleanText(body.category_id, '', 160) }
};
}

categoryId = categoryResult.category_id;
}

const normalized = {
date: normalizeDate(body.date) || todayISO(),
type,
amount,
account_id: sourceAccount.id,
account_name: sourceAccount.name || sourceAccount.id,
transfer_to_account_id: transferToAccount ? transferToAccount.id : null,
transfer_to_account_name: transferToAccount ? (transferToAccount.name || transferToAccount.id) : null,
category_id: categoryId,
notes: cleanNotes(body.notes),
fee_amount: cleanAmount(body.fee_amount),
pra_amount: cleanAmount(body.pra_amount),
created_by: cleanText(body.created_by, 'web-add', 80) || 'web-add'
};

const proof = buildWriteProof(normalized);

return {
ok: true,
normalized_payload: normalized,
proof
};
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
detail: 'Type is included in allowed transaction types.'
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
? 'Category resolved to category_id ' + payload.category_id + '.'
: 'Category is empty or not required.'
},
{
check: 'undefined_guard',
status: 'pass',
source: 'normalized_payload',
detail: 'Payload is normalized before D1 bind values are created.'
}
],
lift_candidate: {
coverage_key: 'coverage.write_safety.status',
current_expected_state: 'unknown_or_blocked',
required_next_state: 'verified',
reason: 'Dry-run validates transaction.save without writing ledger rows.'
}
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

async function enforceActionGate(context, actionName) {
try {
const origin = new URL(context.request.url).origin;
const response = await fetch(origin + '/api/finance-command-center', {
method: 'GET',
cache: 'no-store',
headers: {
accept: 'application/json',
'x-sovereign-mutating-api-enforcement': VERSION
}
});

const data = await response.json().catch(() => null);

if (!response.ok || !data || !data.enforcement) {
return {
action: actionName,
allowed: false,
status: 'blocked',
level: 3,
reason: 'Command Centre policy could not be loaded by backend.',
source: '/api/finance-command-center',
required_fix: 'Restore Command Centre policy before allowing mutating transaction writes.',
backend_enforced: true,
frontend_enforced: false,
override: { allowed: false, reason_required: true }
};
}

const actions = Array.isArray(data.enforcement.actions)
? data.enforcement.actions
: [];

const gate = actions.find(item => item && item.action === actionName);

if (!gate) {
return {
action: actionName,
allowed: false,
status: 'blocked',
level: 3,
reason: 'Command Centre returned no backend policy for transaction.save.',
source: 'enforcement.actions',
required_fix: 'Register transaction.save in /api/finance-command-center enforcement.actions.',
backend_enforced: true,
frontend_enforced: false,
override: { allowed: false, reason_required: true }
};
}

return {
...gate,
action: gate.action || actionName,
allowed: gate.allowed === true,
status: gate.allowed === true ? 'pass' : (gate.status || 'blocked'),
level: Number(gate.level || (gate.allowed === true ? 0 : 3)),
reason: gate.allowed === true
? 'Command Centre allows transaction.save.'
: (gate.reason || 'Command Centre blocked transaction.save.'),
source: gate.source || 'enforcement.actions',
required_fix: gate.allowed === true
? 'None.'
: (gate.required_fix || 'Resolve Command Centre blocker before allowing transaction.save.'),
backend_enforced: true,
frontend_enforced: gate.frontend_enforced === true,
override: gate.override || { allowed: false, reason_required: true }
};
} catch (err) {
return {
action: actionName,
allowed: false,
status: 'blocked',
level: 3,
reason: 'Backend enforcement check failed: ' + (err.message || String(err)),
source: '/api/finance-command-center',
required_fix: 'Fix backend enforcement check before allowing transaction.save.',
backend_enforced: true,
frontend_enforced: false,
override: { allowed: false, reason_required: true }
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
