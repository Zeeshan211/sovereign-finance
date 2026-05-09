/* Sovereign Finance Add Transaction Form v0.4.5
Phase 7D Add page transaction.save preflight dry-run.
Contract:
- Add page remains viewable/diagnostic.
- If Command Centre blocks transaction.save, submit runs dry-run proof only.
- Dry-run performs no ledger write and no audit write.
- If Command Centre later allows transaction.save, page still runs dry-run before real save.
- No silent offline queue.
- No category fallback.
- Every block shows action, reason, source, required fix, override status.
*/
(function () {
'use strict';

const VERSION = 'v0.4.5';
const ENFORCED_ACTION = 'transaction.save';

let selectedType = 'expense';
let requestedTo = '';
let requestedFrom = '';
let accounts = [];
let categories = [];
let categoriesLoaded = false;
let submitting = false;
let enforcementLoaded = false;
let enforcementError = '';
let lastPreflight = null;

let saveGate = {
allowed: false,
status: 'blocked',
action: ENFORCED_ACTION,
reason: 'transaction.save is blocked until Command Centre proves write safety.',
source: 'coverage.write_safety.status',
required_fix: 'Add dry-run write safety before allowing transaction saves.',
override: { allowed: false },
backend_enforced: false,
frontend_enforced: true
};

const $ = id => document.getElementById(id);

function todayLocal() {
const d = new Date();
return [
d.getFullYear(),
String(d.getMonth() + 1).padStart(2, '0'),
String(d.getDate()).padStart(2, '0')
].join('-');
}

function parseRoute() {
const params = new URLSearchParams(window.location.search || '');
const type = String(params.get('type') || '').toLowerCase().trim();
const to = String(params.get('to') || '').trim();
const from = String(params.get('from') || '').trim();

if (['expense', 'income', 'transfer'].includes(type)) selectedType = type;
if (to) requestedTo = to;
if (from) requestedFrom = from;
if (requestedTo && selectedType !== 'transfer') selectedType = 'transfer';
}

function toast(msg, kind) {
const old = document.querySelector('.toast');
if (old) old.remove();

const el = document.createElement('div');
el.className = 'toast toast-' + (kind || 'info');
el.textContent = msg;
document.body.appendChild(el);

setTimeout(() => el.classList.add('show'), 20);
setTimeout(() => {
el.classList.remove('show');
setTimeout(() => el.remove(), 250);
}, 3600);
}

function setSubmitText(text) {
const btn = $('submitBtn');
if (btn) btn.textContent = text;
}

async function fetchJSON(url) {
const res = await fetch(url, { cache: 'no-store' });
const data = await res.json().catch(() => null);

if (!res.ok || !data || data.ok === false) {
throw new Error((data && data.error) || ('HTTP ' + res.status));
}

return data;
}

function normalizeAccounts(raw) {
if (Array.isArray(raw)) return raw;
if (raw && Array.isArray(raw.accounts)) return raw.accounts;
if (raw && typeof raw === 'object') {
return Object.keys(raw).map(id => ({ id, ...raw[id] }));
}
return [];
}

function normalizeCategories(raw) {
if (!Array.isArray(raw)) return [];

return raw
.filter(c => c && c.id)
.map(c => ({
id: String(c.id || '').trim(),
name: String(c.name || c.id || '').trim(),
icon: String(c.icon || '').trim()
}))
.filter(c => c.id);
}

function accountName(a) {
return String(a.name || a.label || a.account_name || a.id || '').trim();
}

function accountKind(a) {
return String(a.kind || a.type || '').toLowerCase().trim();
}

function accountLabel(a) {
const name = accountName(a);
const kind = accountKind(a);
return [name, kind ? '(' + kind + ')' : ''].filter(Boolean).join(' ').trim();
}

function categoryLabel(c) {
return (c.name || c.id || '').trim();
}

function findAccountByRouteKey(value) {
if (!value) return null;

const key = String(value).toLowerCase().trim();

return accounts.find(account => {
const id = String(account.id || '').toLowerCase();
const name = accountName(account).toLowerCase();
const kind = accountKind(account);

if (id === key) return true;
if (name === key) return true;
if (key === 'cc' && (id === 'cc' || kind === 'cc' || name.includes('credit') || name.includes('alfalah cc'))) return true;
if (key === 'credit_card' && (kind === 'cc' || name.includes('credit'))) return true;

return false;
}) || null;
}

function normalizeGate(raw) {
if (!raw) {
return {
allowed: false,
status: 'blocked',
action: ENFORCED_ACTION,
reason: 'Command Centre returned no action policy for transaction.save.',
source: 'enforcement.actions',
required_fix: 'Register transaction.save in backend enforcement actions.',
override: { allowed: false },
backend_enforced: false,
frontend_enforced: true
};
}

return {
...raw,
allowed: raw.allowed === true,
status: raw.allowed === true ? 'pass' : (raw.status || 'blocked'),
action: raw.action || ENFORCED_ACTION,
reason: raw.reason || 'Command Centre blocked this action.',
source: raw.source || 'enforcement.actions',
required_fix: raw.required_fix || 'Resolve the Command Centre blocker.',
override: raw.override || { allowed: false },
backend_enforced: raw.backend_enforced === true,
frontend_enforced: true
};
}

function syncEnforcement(snapshot) {
enforcementLoaded = Boolean(snapshot && snapshot.loaded);
enforcementError = snapshot && snapshot.error ? String(snapshot.error) : '';

if (!snapshot || !snapshot.loaded) {
saveGate = {
allowed: false,
status: 'blocked',
action: ENFORCED_ACTION,
reason: enforcementError || 'Command Centre policy is still loading. Until it loads, transaction.save stays blocked.',
source: 'window.SovereignEnforcement',
required_fix: 'Wait for /api/finance-command-center to load. If it does not load, open Command Centre and verify enforcement policy.',
override: { allowed: false },
backend_enforced: false,
frontend_enforced: true
};
renderEnforcement();
updateButton();
return;
}

let gate = null;

if (typeof snapshot.findAction === 'function') {
gate = snapshot.findAction(ENFORCED_ACTION);
}

if (!gate && snapshot.enforcement && Array.isArray(snapshot.enforcement.actions)) {
gate = snapshot.enforcement.actions.find(item => item.action === ENFORCED_ACTION);
}

saveGate = normalizeGate(gate);
renderEnforcement();
updateButton();
}

function ensureEnforcementSubscription() {
if (window.SovereignEnforcement && typeof window.SovereignEnforcement.subscribe === 'function') {
window.SovereignEnforcement.subscribe(syncEnforcement);

if (typeof window.SovereignEnforcement.refresh === 'function') {
window.SovereignEnforcement.refresh();
}

return;
}

saveGate = {
allowed: false,
status: 'blocked',
action: ENFORCED_ACTION,
reason: 'Command Centre enforcement loader is unavailable.',
source: '/js/enforcement.js',
required_fix: 'Confirm /js/enforcement.js loads before Add can write.',
override: { allowed: false },
backend_enforced: false,
frontend_enforced: true
};

renderEnforcement();
updateButton();
}

function renderEnforcement() {
const panel = $('addEnforcementPanel');
const chip = $('enforcementChip');

if (!panel) return;

const blocked = !saveGate.allowed;
panel.hidden = false;
panel.classList.toggle('warning', enforcementLoaded && blocked && saveGate.status !== 'blocked');

const summary = $('addEnforcementSummary');
const action = $('addBlockedAction');
const reason = $('addBlockReason');
const source = $('addBlockSource');
const fix = $('addRequiredFix');
const override = $('addOverrideStatus');
const backend = $('addBackendStatus');

if (summary) {
if (saveGate.allowed) {
summary.textContent = lastPreflight && lastPreflight.ok
? 'Command Centre allows transaction.save. Page preflight passed before real save path.'
: 'Command Centre currently allows transaction.save. Page will dry-run before any real save.';
} else if (lastPreflight && lastPreflight.ok) {
summary.textContent = 'Add page preflight dry-run passed. Real transaction.save remains blocked until Command Centre lifts the action.';
} else {
summary.textContent = 'Command Centre has blocked transaction.save on this page. You can run a safe preflight dry-run without writing ledger rows.';
}
}

if (action) action.textContent = saveGate.action || ENFORCED_ACTION;

if (reason) {
reason.textContent = lastPreflight && lastPreflight.ok && !saveGate.allowed
? 'Page preflight passed; real save still blocked by Command Centre.'
: (saveGate.reason || 'No reason returned.');
}

if (source) {
source.textContent = lastPreflight && lastPreflight.ok
? '/api/transactions?dry_run=1'
: (saveGate.source || 'No source returned.');
}

if (fix) {
fix.textContent = lastPreflight && lastPreflight.ok && !saveGate.allowed
? 'Update Command Centre page_preflight_wired after verifying this page-level dry-run behavior.'
: (saveGate.required_fix || 'No required fix returned.');
}

if (override) override.textContent = saveGate.override && saveGate.override.allowed ? 'Allowed' : 'Not allowed';

if (backend) {
backend.textContent = saveGate.backend_enforced
? 'Yes'
: 'No - frontend soft block only';
}

if (chip) {
chip.hidden = false;
chip.textContent = saveGate.allowed ? 'Command Centre allowed' : lastPreflight && lastPreflight.ok ? 'Preflight passed' : 'Command Centre blocked';
chip.className = saveGate.allowed || (lastPreflight && lastPreflight.ok) ? 'add-chip safe' : 'add-chip blocked';
}
}

function getFormValidity() {
const amount = parseFloat(($('amountInput') || {}).value || '0');
const from = ($('accountSelect') || {}).value || '';
const to = ($('transferToSelect') || {}).value || '';

let ok = amount > 0 && !!from && !submitting;

if (selectedType === 'transfer') {
ok = ok && !!to && to !== from;
}

return ok;
}

function updateButton() {
const btn = $('submitBtn');
if (!btn) return;

const formOk = getFormValidity();

btn.disabled = !formOk;

if (submitting) {
setSubmitText(saveGate.allowed ? 'Saving...' : 'Running Preflight...');
return;
}

if (saveGate.allowed) {
setSubmitText('Save Transaction');
return;
}

if (lastPreflight && lastPreflight.ok) {
setSubmitText('Preflight Passed - Real Save Blocked');
return;
}

setSubmitText('Run Safe Preflight');
}

async function loadAccounts() {
try {
const data = await fetchJSON('/api/accounts?debug=1');
accounts = normalizeAccounts(data.accounts || data);
} catch (e1) {
console.warn('[add v0.4.5] /api/accounts failed:', e1.message);

try {
if (window.store && typeof window.store.refreshBalances === 'function') {
await window.store.refreshBalances();
accounts = normalizeAccounts(window.store.accounts || window.store.cachedAccounts || []);
}
} catch (e2) {
console.warn('[add v0.4.5] store account fallback failed:', e2.message);
}
}

accounts = accounts.filter(a => a && a.id);

if (!accounts.length) toast('Accounts failed to load. Add is blocked.', 'error');
}

async function loadCategories() {
categoriesLoaded = false;
categories = [];

try {
const data = await fetchJSON('/api/categories');
categories = normalizeCategories(data.categories);
categoriesLoaded = true;
} catch (e) {
console.warn('[add v0.4.5] /api/categories failed:', e.message);
categories = [];
categoriesLoaded = false;
}
}

function fillAccounts() {
const source = $('accountSelect');
const dest = $('transferToSelect');

if (source) {
const old = source.value;
source.innerHTML = '<option value="">Pick account...</option>';

accounts.forEach(a => {
const opt = document.createElement('option');
opt.value = a.id;
opt.textContent = accountLabel(a);
source.appendChild(opt);
});

const routeFrom = findAccountByRouteKey(requestedFrom);

if (routeFrom && [...source.options].some(o => o.value === routeFrom.id)) {
source.value = routeFrom.id;
} else if (old && [...source.options].some(o => o.value === old)) {
source.value = old;
}
}

if (dest) fillTransferDest();
}

function fillTransferDest() {
const dest = $('transferToSelect');
const source = $('accountSelect');

if (!dest) return;

const from = source ? source.value : '';
const old = dest.value;
dest.innerHTML = '<option value="">Pick account...</option>';

accounts.forEach(a => {
if (!a || !a.id || a.id === from) return;

const opt = document.createElement('option');
opt.value = a.id;
opt.textContent = accountLabel(a);
dest.appendChild(opt);
});

const routeTo = findAccountByRouteKey(requestedTo);

if (routeTo && routeTo.id !== from && [...dest.options].some(o => o.value === routeTo.id)) {
dest.value = routeTo.id;
requestedTo = '';
} else if (old && old !== from && [...dest.options].some(o => o.value === old)) {
dest.value = old;
}
}

function fillCategories() {
const sel = $('categorySelect');

if (!sel) return;

const old = sel.value;
sel.innerHTML = '';

const empty = document.createElement('option');
empty.value = '';
empty.textContent = categories.length ? 'No category' : categoriesLoaded ? 'No categories in D1 - save without category' : 'Categories unavailable - save without category';
sel.appendChild(empty);

categories.forEach(c => {
const opt = document.createElement('option');
opt.value = c.id;
opt.textContent = categoryLabel(c);
sel.appendChild(opt);
});

sel.value = old && [...sel.options].some(o => o.value === old) ? old : '';
sel.disabled = !categories.length;
}

function updateRouteCopy(type) {
const trustPanel = $('addTrustPanel');
const trustText = $('addTrustText');
const safetyText = $('addSafetyText');
const chip = $('submitClarityChip');

const copy = {
expense: {
panelClass: 'add-trust-panel',
chipClass: 'add-chip',
chip: 'Dry-run validates one ledger row',
trust: 'Expense dry-run validates one transaction row and the selected source account before any real save.',
safety: 'Expense mode can run a safe dry-run proof. Real save stays blocked until Command Centre allows transaction.save.'
},
income: {
panelClass: 'add-trust-panel income',
chipClass: 'add-chip safe',
chip: 'Dry-run validates one ledger row',
trust: 'Income dry-run validates one transaction row and the selected destination account before any real save.',
safety: 'Income mode can run a safe dry-run proof. Real save stays blocked until Command Centre allows transaction.save.'
},
transfer: {
panelClass: 'add-trust-panel transfer',
chipClass: 'add-chip transfer',
chip: 'Dry-run validates linked pair',
trust: 'Transfer dry-run validates the linked OUT and IN rows before any real save.',
safety: 'Transfer mode can run a safe dry-run proof for the linked pair. Real save stays blocked until Command Centre allows transaction.save.'
}
};

const item = copy[type] || copy.expense;

if (trustPanel) trustPanel.className = item.panelClass;
if (trustText) trustText.textContent = item.trust;
if (safetyText) safetyText.textContent = item.safety;

if (chip) {
chip.className = item.chipClass;
chip.textContent = item.chip;
}
}

function resetPreflight() {
lastPreflight = null;
renderEnforcement();
updateButton();
}

function setType(type) {
selectedType = ['expense', 'income', 'transfer'].includes(type) ? type : 'expense';

document.querySelectorAll('.type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === selectedType));

const isTransfer = selectedType === 'transfer';

document.body.classList.toggle('transfer-mode', isTransfer);

if ($('transferToWrap')) $('transferToWrap').hidden = !isTransfer;
if ($('categoryWrap')) $('categoryWrap').hidden = isTransfer;
if ($('accountFromLabel')) $('accountFromLabel').textContent = isTransfer ? 'From Account' : 'Account';

fillTransferDest();
updateRouteCopy(selectedType);
resetPreflight();
}

function collectPayload() {
const amount = parseFloat(($('amountInput') || {}).value || '0');
const from = ($('accountSelect') || {}).value || '';
const to = ($('transferToSelect') || {}).value || '';
const category = ($('categorySelect') || {}).value || null;
const date = ($('dateInput') || {}).value || todayLocal();
const notes = (($('notesInput') || {}).value || '').trim();

if (!(amount > 0)) throw new Error('Amount must be greater than 0');
if (!from) throw new Error('Pick an account');

const payload = {
type: selectedType,
amount,
accountId: from,
account_id: from,
categoryId: selectedType === 'transfer' ? null : category,
category_id: selectedType === 'transfer' ? null : category,
date,
notes
};

if (selectedType === 'transfer') {
if (!to) throw new Error('Pick a destination account');
if (to === from) throw new Error('Source and destination cannot match');

payload.transferToAccountId = to;
payload.transfer_to_account_id = to;
payload.categoryId = null;
payload.category_id = null;
}

return payload;
}

function payloadForApi(payload, dryRun) {
const body = {
dry_run: dryRun === true,
date: payload.date,
type: payload.type,
amount: payload.amount,
account_id: payload.account_id || payload.accountId,
category_id: payload.category_id || payload.categoryId || null,
notes: payload.notes,
created_by: dryRun ? 'web-add-preflight' : 'web-add-direct'
};

if (payload.transfer_to_account_id || payload.transferToAccountId) {
body.transfer_to_account_id = payload.transfer_to_account_id || payload.transferToAccountId;
}

return body;
}

async function runDryRun(payload) {
const res = await fetch('/api/transactions?dry_run=1&cb=' + Date.now(), {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payloadForApi(payload, true))
});

const data = await res.json().catch(() => null);

if (!res.ok || !data || data.ok !== true || data.dry_run !== true || data.writes_performed !== false) {
throw new Error((data && data.error) || ('Dry-run failed with HTTP ' + res.status));
}

return data;
}

async function directAdd(payload) {
const res = await fetch('/api/transactions', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payloadForApi(payload, false))
});

const data = await res.json().catch(() => null);

if (!res.ok || !data || !data.ok) {
return {
ok: false,
error: (data && data.error) || ('HTTP ' + res.status),
enforcement: data && data.enforcement ? data.enforcement : null,
proof: data && data.proof ? data.proof : null
};
}

return data;
}

async function submit(e) {
e.preventDefault();

if (submitting) return;

let payload;

try {
payload = collectPayload();
} catch (err) {
toast(err.message, 'error');
updateButton();
return;
}

submitting = true;
lastPreflight = null;
renderEnforcement();
updateButton();

try {
const dryRunResult = await runDryRun(payload);

lastPreflight = {
ok: true,
at: new Date().toISOString(),
result: dryRunResult
};

renderEnforcement();

if (!saveGate.allowed) {
toast('Preflight passed. Real save remains blocked by Command Centre.', 'success');
submitting = false;
updateButton();
return;
}

setSubmitText('Saving...');

let result;

if (window.store && typeof window.store.addTransaction === 'function') {
result = await window.store.addTransaction(payload);
} else {
result = await directAdd(payload);
}

if (!result || !result.ok) {
throw new Error((result && result.error) || 'Save failed');
}

toast(payload.type === 'transfer' ? 'Transfer saved' : 'Transaction saved', 'success');

setTimeout(() => {
window.location.href = '/transactions.html';
}, 650);
} catch (err) {
lastPreflight = {
ok: false,
at: new Date().toISOString(),
error: err.message || String(err)
};

toast(err.message || 'Preflight failed', 'error');
submitting = false;
setSubmitText(saveGate.allowed ? 'Save Transaction' : 'Run Safe Preflight');
renderEnforcement();
updateButton();
}
}

function wireEvents() {
document.querySelectorAll('.type-btn').forEach(btn => {
btn.addEventListener('click', () => setType(btn.dataset.type || 'expense'));
});

['amountInput', 'accountSelect', 'transferToSelect', 'categorySelect', 'dateInput', 'notesInput'].forEach(id => {
const el = $(id);

if (!el) return;

el.addEventListener('input', () => {
resetPreflight();
});

el.addEventListener('change', () => {
if (id === 'accountSelect') fillTransferDest();
resetPreflight();
});
});

const form = $('addForm');

if (form) form.addEventListener('submit', submit);
}

async function init() {
console.log('[add v0.4.5] init');

parseRoute();

const date = $('dateInput');

if (date && !date.value) date.value = todayLocal();

wireEvents();
ensureEnforcementSubscription();

await Promise.all([loadAccounts(), loadCategories()]);

fillAccounts();
fillCategories();
setType(selectedType);
renderEnforcement();
updateButton();

console.log('[add v0.4.5] ready', {
accounts: accounts.length,
categories: categories.length,
categoriesLoaded,
selectedType,
enforcementLoaded,
saveGate,
lastPreflight,
store: window.store && window.store.version
});
}

window.SovereignAdd = {
version: VERSION,
get selectedType() {
return selectedType;
},
accounts: () => accounts.slice(),
categories: () => categories.slice(),
enforcement: () => ({
loaded: enforcementLoaded,
error: enforcementError,
saveGate: { ...saveGate },
lastPreflight
}),
preflight: async () => {
const payload = collectPayload();
const result = await runDryRun(payload);
lastPreflight = {
ok: true,
at: new Date().toISOString(),
result
};
renderEnforcement();
updateButton();
return result;
}
};

if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', init);
} else {
init();
}
})();
