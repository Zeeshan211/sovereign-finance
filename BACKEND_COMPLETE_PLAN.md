# BACKEND_COMPLETE_PLAN.md
> Generated 2026-05-23. Audit + Plan session — read-only. No code changed.
> This document is the executable spec for the implementation session ("Prompt 2").

---

## Section 1: Current sovereign-finance State

### 1.1 Endpoint Inventory (44 handler groups)

| Endpoint | Methods | Status | Returns Response? |
|---|---|---|---|
| GET /api/health | GET | ✅ Working | ✅ |
| GET /api/balances | GET | ✅ Working | ✅ |
| GET /api/accounts | GET | ✅ Working | ✅ |
| POST /api/accounts | POST | ❌ Returns 405 | ✅ (405 is a Response) |
| GET /api/transactions | GET | ✅ Working | ✅ |
| POST /api/transactions | POST | ✅ Working (dry_run + commit) | ✅ |
| GET /api/transactions/:id | GET | ✅ Working | ✅ |
| GET /api/transactions/health | GET | ✅ Working | ✅ |
| POST /api/transactions/reverse | POST | ✅ Working | ✅ |
| POST /api/transactions/:id/reverse | POST | ✅ (shim → canonical) | ✅ |
| GET /api/add/context | GET | ✅ Working | ✅ |
| POST /api/add/preview | POST | ✅ Working | ✅ |
| POST /api/add/dry-run | POST | 🐛 BUG — returns plain object | ❌ |
| POST /api/add/commit | POST | ✅ Working | ✅ |
| POST /api/add/save | POST | ✅ Working | ✅ |
| GET /api/bills | GET | ✅ Working | ✅ |
| POST /api/bills | POST (create/pay/defer/repair) | ✅ Working | ✅ |
| GET /api/bills/history | GET | ✅ Working | ✅ |
| GET /api/bills/cycle | GET | ✅ Working | ✅ |
| GET /api/bills/:id | GET | ✅ Working | ✅ |
| POST /api/bills/:id/pay | POST | ✅ Working | ✅ |
| GET /api/bills/health | GET | ✅ Working | ✅ |
| GET /api/debts | GET | ✅ Working | ✅ |
| POST /api/debts | POST (create/pay/receive/repair) | ✅ Working | ✅ |
| GET /api/merchants | GET | ✅ Working | ✅ |
| POST /api/merchants | POST (create) | ✅ Working | ✅ |
| PUT /api/merchants/:id | PUT | ✅ Working | ✅ |
| DELETE /api/merchants/:id | DELETE | ✅ Working | ✅ |
| POST /api/merchants/match | POST | ✅ Working | ✅ |
| POST /api/merchants/seed | POST | ✅ Working | ✅ |
| POST /api/merchants/:id/touch | POST | ✅ Working | ✅ |
| GET /api/categories | GET | ✅ Working | ✅ |
| GET /api/hub | GET | ✅ Working | ✅ |
| GET /api/forecast | GET | ✅ Working | ✅ |
| GET /api/salary | GET | ✅ Working | ✅ |
| POST /api/salary | POST | ✅ Working | ✅ |
| GET /api/cc | GET | ✅ Working | ✅ |
| GET /api/cc/:id/payoff-plan | GET | ✅ Working | ✅ |
| GET /api/reconciliation | GET | ✅ Working | ✅ |
| POST /api/reconciliation | POST | ✅ Working | ✅ |
| GET /api/nano-loans | GET | ✅ Working | ✅ |
| POST /api/nano-loans | POST | ✅ Working | ✅ |
| POST /api/nano-loans/:id/repay | POST | ✅ Working | ✅ |
| POST /api/nano-loans/:id/push-to-cc | POST | ⚠️ Guarded (not hardened) | ✅ |
| GET /api/atm | GET | ✅ Working | ✅ |
| POST /api/atm | POST | ✅ Working | ✅ |
| GET /api/snapshots | GET | ✅ Working | ✅ |
| POST /api/snapshots | POST | ✅ Working | ✅ |
| GET /api/ledger | GET | ✅ Working | ✅ |
| POST /api/ledger | POST | ✅ (delegates to transactions) | ✅ |
| GET /api/audit | GET | ✅ Working | ✅ |
| GET /api/goals | GET | ✅ Working | ✅ |
| POST /api/goals | POST (create/contribute) | ✅ Working | ✅ |
| GET /api/budgets | GET | ✅ Working | ✅ |
| POST /api/budgets | POST (create/update) | ✅ Working | ✅ |
| GET /api/intl-rates | GET | ✅ Working | ✅ |
| POST /api/intl-rates | POST | ✅ Working | ✅ |
| GET /api/intl-rates/fx | GET | ✅ Working | ✅ |
| POST /api/intl-rates/fx/refresh | POST | ✅ Working | ✅ |
| GET /api/intl-rates/audit | GET | ✅ Working | ✅ |
| GET /api/finance-command-center | GET | ⚠️ Exists (not fully audited) | Unknown |
| GET /api/monthly-close | GET | ⚠️ Exists (not fully audited) | Unknown |
| GET /api/insights | GET | ⚠️ Exists (not fully audited) | Unknown |

### 1.2 D1 Tables (confirmed from codebase reads)

| Table | Purpose | Source Confirmed |
|---|---|---|
| accounts | Account master list | accounts/[[path]].js, balances.js |
| transactions | Append-only ledger | transactions.js, multiple handlers |
| categories | Expense categories | categories.js |
| merchants | Counterparty registry | merchants/[[path]].js |
| bills | Recurring bill obligations | bills/[[path]].js |
| bill_payments | Bill payment link rows | bills/[[path]].js |
| debts | Debt master records | debts/[[path]].js |
| debt_payments | Debt payment link rows | debts/[[path]].js |
| salary_contracts | Saved salary config | salary/[[path]].js |
| reconciliation | Manual balance snapshot comparisons | reconciliation/[[path]].js |
| reconciliation_snapshots | Deprecated alias for reconciliation | health.js |
| goals | Savings goal records | goals/[[path]].js |
| budgets | Monthly budget records | budgets/[[path]].js |
| snapshots | Point-in-time snapshots (metadata) | snapshots.js, _lib.js |
| snapshot_data | Snapshot table contents | snapshots.js, _lib.js |
| audit_log | Immutable audit trail | audit.js, _lib.js |
| intl_package | International purchase packages | add/[[path]].js |
| intl_rate_config | FX/tax config (id=1) | intl-rates/[[path]].js |
| intl_rate_audit | FX config change history | intl-rates/[[path]].js |
| intl_fx_cache | Cached live FX rates | intl-rates/[[path]].js |
| nano_loans | Nano loan records | nano-loans/[[path]].js |

### 1.3 Real D1 Data (from SCHEMA.md, captured 2026-05-04)

**11 accounts**: cash, meezan, mashreq, ubl, ubl_prepaid, easypaisa, jazzcash, naya_pay, js_bank, alfalah, cc
- Only `cc` is type=liability; all others are type=asset
- Only `active` status values exist across all accounts

**15 categories in D1**: food, grocery, transport, bills, health, personal, family, debt, cc_pay, cc_spend, biller, salary, gift, transfer, other
- `type` column is NULL for all rows

---

## Section 2: Frontend Expectation Contract

### 2.1 LiquidityOS Query Hooks → Endpoint Map

| Hook | Method + Endpoint | Notes |
|---|---|---|
| useAccounts() | GET /api/accounts | Zod: AccountsResponseSchema |
| useBalances() | GET /api/balances | Zod: BalancesResponseSchema |
| useTransactions() | GET /api/ledger?limit=500 | Hits /ledger not /transactions |
| useAccountTransactions(id) | GET /api/ledger?account_id=X&limit=200 | Client-side filter after fetch |
| useAddContext() | GET /api/add/context | staleTime: 60s |
| useAddDryRun() | POST /api/transactions?dry_run=1 | Workaround — bypasses /api/add/dry-run |
| useAddCommit() | POST /api/add/commit | Invalidates accounts/balances/transactions |
| useMerchantMatch() | POST /api/merchants/match | 300ms debounce, min 2 chars |
| useMerchantTouch() | POST /api/merchants/:id/touch | Called after successful commit |

### 2.2 Active Frontend Workarounds

| # | Workaround | Root Cause | Fix Target |
|---|---|---|---|
| 1 | useAddDryRun() calls /api/transactions?dry_run=1 instead of /api/add/dry-run | BUG: /api/add/dry-run returns plain JS object (not Response) | Fix dryRun() in add/[[path]].js |
| 2 | AddPage.tsx does NOT send idempotency_key in commit payload | BUG: transactions table missing idempotency_key column | Add idempotency_key column to transactions |
| 3 | useAccountTransactions() filters client-side after full fetch | /api/ledger has no server-side account_id filter | Add ?account_id= filter to /api/ledger and /api/transactions |
| 4 | touchMerchant() called manually after commit | No auto-touch in commit flow | Acceptable pattern — keep as-is |

### 2.3 Zod Schema Contracts (critical fields expected by LiquidityOS)

**AccountSchema** expects: id, name, type, balance (number required)
**BalancesResponseSchema** expects: ok, summary (with asset_total, liability_total, net_worth required)
**TransactionSchema** expects: id, type (all other fields optional/nullable)
**AddDryRunResponseSchema** expects: ok, payload_hash (required); warnings, package_preview, balance_before/after optional
**AddCommitResponseSchema** expects: ok; written, transaction_id, ids all optional

All schemas use `.passthrough()` — extra backend fields are tolerated without crashes.

---

## Section 3: Legacy Feature Coverage Matrix

Source: LEGACY_FINANCE_INVENTORY.md (sovereign-ops-private_sheet, 2026-05-23)

| Legacy Feature | sovereign-finance Coverage | Status |
|---|---|---|
| Add expense transaction | POST /api/transactions + /api/add/commit | ✅ YES |
| Add income transaction | POST /api/transactions + /api/add/commit | ✅ YES |
| Add transfer between accounts | POST /api/transactions (transfer type, linked pair) | ✅ YES |
| Add adjustment (positive/negative) | POST /api/transactions (adjustment_positive/negative) | ✅ YES |
| International purchase (FX + tax) | POST /api/add/commit (intl mode) + /api/intl-rates | ✅ YES |
| Dry-run balance preview | POST /api/transactions?dry_run=1 (workaround) | ⚠️ PARTIAL (via workaround) |
| Account balance view | GET /api/balances | ✅ YES |
| Transaction list | GET /api/ledger | ✅ YES |
| Reversal of transaction | POST /api/transactions/reverse | ✅ YES |
| Reversal of transfer pair | POST /api/transactions/reverse (handles linked pair) | ✅ YES |
| Reversal of intl package | POST /api/transactions/reverse (handles full package) | ✅ YES |
| Debt creation | POST /api/debts | ✅ YES |
| Debt payment | POST /api/debts (payment action) | ✅ YES |
| Debt receive payment | POST /api/debts (receive action) | ✅ YES |
| Debt settlement via reversal repair | POST /api/transactions/reverse (module repair) | ✅ YES |
| Debt snowball order | GET /api/debts (snowball_order field) | ✅ YES |
| Bill creation | POST /api/bills | ✅ YES |
| Bill payment | POST /api/bills/:id/pay | ✅ YES |
| Bill deferral | POST /api/bills (defer action) | ✅ YES |
| Bill cycle view | GET /api/bills/cycle | ✅ YES |
| Bill reversal repair | POST /api/bills (repair_reversed_payments) | ✅ YES |
| CC payment recording | POST /api/transactions (type=cc_payment) | ✅ YES |
| CC liability view | GET /api/cc | ✅ YES |
| CC payoff plan | GET /api/cc/:id/payoff-plan | ✅ YES |
| ATM withdrawal (source→cash + fee) | POST /api/atm | ✅ YES |
| Salary contract save | POST /api/salary | ✅ YES |
| Salary auto-detection | POST /api/transactions (heuristic in handler) | ✅ YES |
| Forecast / runway | GET /api/forecast | ✅ YES |
| Goals creation + contribution | POST /api/goals | ✅ YES |
| Budget creation + tracking | POST /api/budgets | ✅ YES |
| Merchant registry | GET/POST/PUT/DELETE /api/merchants | ✅ YES |
| Merchant fuzzy match | POST /api/merchants/match | ✅ YES |
| Merchant seed (60+ Pakistani billers) | POST /api/merchants/seed | ✅ YES |
| Nano loans Shape A (CC refinance) | POST /api/nano-loans/:id/push-to-cc | ⚠️ PARTIAL (guarded, not hardened) |
| Nano loans Shape B (salary redeemed) | POST /api/nano-loans + repay | ✅ YES |
| Reconciliation snapshot | POST /api/reconciliation | ✅ YES |
| Audit log write | audit() in _lib.js (called from handlers) | ✅ YES |
| Audit log read | GET /api/audit | ✅ YES |
| Audit hash-chain verification | GET /api/audit (reported but not backfilled) | ⚠️ PARTIAL |
| Full snapshots | POST /api/snapshots (via _lib.js snapshot()) | ✅ YES |
| Hub / command centre aggregation | GET /api/hub | ✅ YES |
| Command centre (finance-command-center) | GET /api/finance-command-center | ⚠️ EXISTS (not fully audited) |
| Monthly close | GET /api/monthly-close | ⚠️ EXISTS (not fully audited) |
| Insights | GET /api/insights | ⚠️ EXISTS (not fully audited) |
| PropertiesService row pointer cache | None | ❌ NO (architectural gap — see Section 9) |
| Hash-chain audit log (chained hashes) | Not implemented | ❌ NO |
| Idempotency key dedup | Code present, column missing | ❌ NO (BUG) |
| Add context one-call bootstrap | GET /api/add/context | ✅ YES |
| Category budget tracking | GET /api/budgets (spentForCategory) | ✅ YES |
| FX rate cache + refresh | GET /api/intl-rates/fx + refresh | ✅ YES |

---

## Section 4: Confirmed Bugs To Fix

### BUG-1: /api/add/dry-run returns plain JS object (CRITICAL)

**File**: `functions/api/add/[[path]].js`
**Symptom**: POST /api/add/dry-run returns "Unsupported GET route." — Cloudflare falls back to GET handler
**Root cause**: `dryRun()` function calls `return internalPost(...)` where `internalPost()` returns a parsed JSON object (plain JS), not a `new Response()`. Cloudflare Pages sees non-Response return → falls back to alternate handler.
**Impact**: Entire dry-run flow is broken for non-international transactions. Frontend workaround in place (hits /api/transactions?dry_run=1 directly) but the canonical endpoint is dead.
**Fix**: In `dryRun()` for the non-intl path, wrap the return:
```javascript
const result = await internalPost(context, '/api/transactions?dry_run=1', directTransactionPayload(normalized));
return json(result);
```
**Risk**: Low. Wrapping in json() is exactly what commit and save already do. The result shape is unchanged.

### BUG-2: transactions table missing idempotency_key column (HIGH)

**File**: `functions/api/transactions.js`
**Symptom**: Backend throws "table has no column named idempotency_key" when frontend sends the field
**Root cause**: `idempotency_key TEXT` column was never added to the D1 transactions table, but the code references it
**Impact**: Idempotency deduplication is disabled. Duplicate transactions on retry are possible.
**Fix (two parts)**:
1. Migration: `ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;`
2. Migration: `CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;`
**Risk**: Medium — requires D1 migration. The handler already gracefully degrades if column missing (warns). After migration, frontend should re-enable sending idempotency_key.

### BUG-3: Category ID drift between store.js and D1 (MEDIUM)

**File**: Hard-coded in frontend store / merchants seed / possibly other handlers
**Symptom**: merchant match + auto-apply may return wrong category_id references
**Root cause**:
- Code uses `groceries` → D1 has `grocery`
- Code uses `debt_payment` → D1 has `debt`
- Code uses `cc_payment` → D1 has `cc_pay`
**Impact**: Auto-category assignment silently fails or assigns wrong category
**Fix**: Audit all hard-coded category references in functions/api/ and align to D1 canonical IDs. Do NOT rename D1 rows — fix the code references.
**Risk**: Low per handler, but requires grep across all handlers.

### BUG-4: /api/transactions missing ?account_id= server-side filter (LOW)

**File**: `functions/api/transactions.js` and `functions/api/ledger.js`
**Symptom**: useAccountTransactions() in LiquidityOS fetches all 200 transactions then filters client-side — wasteful and breaks when account has >200 transactions
**Fix**: Add `WHERE account_id = ?` clause when `?account_id=` query param is present
**Risk**: Low. Purely additive.

### BUG-5: /api/accounts POST returns 405 (LOW)

**File**: `functions/api/accounts/[[path]].js`
**Symptom**: Creating new accounts via API is impossible
**Impact**: New accounts must be added directly to D1 via SQL — no UI path
**Fix**: Implement POST handler for account creation with required fields: id, name, type, currency (default PKR)
**Risk**: Medium — needs schema awareness (what columns are mandatory).

---

## Section 5: Schema Changes Needed

### 5.1 New Columns (migrations required)

| Table | Column | Type | Constraint | Purpose |
|---|---|---|---|---|
| transactions | idempotency_key | TEXT | NULLABLE | Dedup on retry (BUG-2 fix) |
| transactions | account_delta | REAL | NULLABLE | Signed amount for balance calc (replaces type-lookup logic in accounts handler) |
| accounts | opening_balance | REAL | DEFAULT 0 | Used in add/[[path]].js balance projection |

### 5.2 New Indexes

| Table | Index | Columns | Type | Purpose |
|---|---|---|---|---|
| transactions | idx_transactions_idempotency | (idempotency_key) WHERE NOT NULL | UNIQUE | Idempotency dedup |
| transactions | idx_transactions_account_date | (account_id, date) | BTREE | account_id filter performance |
| transactions | idx_transactions_date | (date) | BTREE | Date range queries |
| audit_log | idx_audit_created_at | (created_at) | BTREE | Pagination performance |

### 5.3 Columns To Verify Exist (read PRAGMA before adding)

The following columns are referenced in handler code but not confirmed present in real D1 schema:
- `transactions.account_delta` — check accounts/[[path]].js fallback logic
- `accounts.opening_balance` — check add/[[path]].js balance projection
- `transactions.group_id` — referenced in TransactionSchema (frontend Zod)
- `transactions.group_type` — referenced in TransactionSchema (frontend Zod)

### 5.4 No Tables To Drop

No table removals are planned. All existing tables are referenced by active handlers.

### 5.5 Migration Execution Order (if all applied)

1. `ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;`
2. `CREATE UNIQUE INDEX idx_transactions_idempotency ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;`
3. (Verify first) `ALTER TABLE transactions ADD COLUMN account_delta REAL;`
4. (Verify first) `ALTER TABLE accounts ADD COLUMN opening_balance REAL DEFAULT 0;`
5. `CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);`
6. `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);`
7. `CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);`

---

## Section 6: New Endpoints Needed

These endpoints are required to build the 9 unbuilt LiquidityOS frontend pages.

### 6.1 Endpoints for unbuilt pages

| Page | Endpoint Needed | Method | Notes |
|---|---|---|---|
| HubPage | GET /api/hub | GET | Already exists ✅ — page just not built |
| DebtsPage | GET /api/debts | GET | Already exists ✅ |
| DebtsPage | POST /api/debts | POST | Already exists ✅ |
| BillsPage | GET /api/bills | GET | Already exists ✅ |
| BillsPage | POST /api/bills/:id/pay | POST | Already exists ✅ |
| CreditCardPage | GET /api/cc | GET | Already exists ✅ |
| CreditCardPage | GET /api/cc/:id/payoff-plan | GET | Already exists ✅ |
| ForecastPage | GET /api/forecast | GET | Already exists ✅ |
| SalaryPage | GET /api/salary | GET | Already exists ✅ |
| SalaryPage | POST /api/salary | POST | Already exists ✅ |
| ReconciliationPage | GET /api/reconciliation | GET | Already exists ✅ |
| ReconciliationPage | POST /api/reconciliation | POST | Already exists ✅ |
| NanoLoansPage | GET /api/nano-loans | GET | Already exists ✅ |
| NanoLoansPage | POST /api/nano-loans/:id/repay | POST | Already exists ✅ |
| AtmPage | GET /api/atm | GET | Already exists ✅ |
| AtmPage | POST /api/atm | POST | Already exists ✅ |

**Finding**: All 9 unbuilt pages already have backend endpoints. The bottleneck is frontend development, not missing backend.

### 6.2 New endpoints that should be built

| Endpoint | Method | Priority | Purpose |
|---|---|---|---|
| POST /api/accounts | POST | HIGH | Create new account (currently 405) |
| PATCH /api/accounts/:id | PATCH | MEDIUM | Edit account name/color/status |
| DELETE /api/accounts/:id | DELETE | LOW | Soft-delete (set deleted_at, not DROP) |
| GET /api/goals | GET | LOW | Already exists — confirm frontend hook |
| GET /api/budgets | GET | LOW | Already exists — confirm frontend hook |
| GET /api/insights | GET | MEDIUM | Exists but not audited |
| GET /api/finance-command-center | GET | MEDIUM | Exists but not audited |
| GET /api/monthly-close | GET | LOW | Exists but not audited |
| POST /api/categories | POST | LOW | Create/edit category |
| PATCH /api/categories/:id | PATCH | LOW | Edit category budget, icon, color |

### 6.3 Endpoints confirmed NOT needed (handled by existing)

- No separate /api/transfers endpoint needed — transfers use /api/transactions with type=transfer
- No separate /api/cc-payments endpoint — use /api/transactions with type=cc_payment
- No separate /api/salary-income endpoint — salary deposits use /api/transactions with type=salary

---

## Section 7: Handler Fixes Needed

### 7.1 fix add/[[path]].js — dryRun() non-Response return (BUG-1)

**Priority**: CRITICAL
**Change**: Wrap `internalPost()` result in `json()` before returning from `dryRun()`.
**Lines to change**: The non-intl return path inside `async function dryRun(context, body)`.
**Pattern**: Same wrap that `commit()` and `save()` already use.

### 7.2 Add account_id filter to transactions.js and ledger.js (BUG-4)

**Priority**: HIGH (currently limits account transaction history to 200 rows before client-side filter)
**Change**: In the GET handler of transactions.js, check for `?account_id=` query param; if present, add `AND account_id = ?` to the SELECT.
**Cascade**: Same change needed in ledger.js which wraps transactions.js.

### 7.3 Fix category ID references across all handlers (BUG-3)

**Priority**: MEDIUM
**Files to check**: merchants/[[path]].js (seed list), add/[[path]].js (auto-category), any handler that references category by string ID
**Change**: Replace `'groceries'` → `'grocery'`, `'debt_payment'` → `'debt'`, `'cc_payment'` → `'cc_pay'`

### 7.4 Implement POST /api/accounts (BUG-5)

**Priority**: MEDIUM (currently returns 405)
**Change**: Add POST handler in accounts/[[path]].js. Required fields: id (or uuid-generated), name, type, currency (default PKR). Optional: color, icon, display_order, credit_limit.
**Constraint**: Must not set balance directly — balance is always ledger-derived.

### 7.5 Verify and un-guard /api/nano-loans/:id/push-to-cc

**Priority**: LOW
**Change**: push-to-cc is guarded with a comment "CC module not yet hardened." Evaluate whether CC module is now stable enough to enable this path.

### 7.6 Audit finance-command-center, monthly-close, insights handlers

**Priority**: MEDIUM (all exist but were not read during this audit)
**Action**: Read all three files in the implementation session before touching them. Confirm they return proper Response objects.

---

## Section 8: Legacy Features To Port

Source: LEGACY_FINANCE_INVENTORY.md (sovereign-ops-private_sheet)

### 8.1 PORT decisions

| Legacy Feature | Decision | Reason | Implementation Notes |
|---|---|---|---|
| Dry-run endpoint (proper /api/add/dry-run) | PORT | BUG-1 fix | Just wrap internalPost in json() |
| Idempotency key dedup | PORT | BUG-2 fix | Migration + re-enable in frontend |
| Account creation via API | PORT | Missing feature | Implement POST /api/accounts |
| Account-scoped transaction filter | PORT | Performance/correctness | Add ?account_id= to /api/transactions |
| Category type column | PORT | Improves filtering | SET category.type where NULL; add type to seed data |
| Hash-chain audit log | PORT (deferred) | Security / integrity | Requires backfill migration — high risk; defer to dedicated session |
| PropertiesService row pointers | SKIP | Architecture mismatch | D1 query is authoritative; no cache layer needed |
| Finance_TxnIdRepair.gs | PORT (partial) | Use case is real | Expose as /api/transactions/health (already exists) + repair endpoint |
| Finance_PDFParser.gs | SKIP | Out of scope | PDF parsing not in LiquidityOS product spec |
| Finance_Vaccine.gs | SKIP | Not audited fully | Legacy data-cleaning; not applicable to new ledger |
| Finance_CrossTabAuditor.gs | SKIP | Not audited fully | Legacy spreadsheet validator; not applicable |
| WebApp.gs (debt metrics) | SKIP | LiquidityOS frontend replaces it | DebtsPage will compute same metrics |
| Finance_Pro menu structure | SKIP | Telegram bot / UI layer | Not a backend concern |
| Salary auto-detection heuristic | PORT (already ported) | Already in transactions.js | Verify heuristic matches legacy exactly |
| 1-Biller fee (31.25 PKR) | PORT (verify) | Fixed fee logic | Confirm fee in bills or atm handler — may need biller_fee column |
| Tiered biller fee (Finance_Intl v1.1) | INVESTIGATE | Supersedes fixed fee? | See Section 9 risk #2 |
| Snowball debt order | PORT (already ported) | Already in debts/[[path]].js | Verify sort logic matches legacy |
| Nano loan Shape A (CC refinance) | PORT | Guarded, needs hardening | Un-guard after CC module review |

### 8.2 SKIP decisions (final)

| Skipped Feature | Reason |
|---|---|
| PropertiesService cache | D1 queries are fast; no cache layer needed |
| PDF parsing | Not in product scope |
| Google Sheets tab sync | Frontend replaces Sheets UI |
| Legacy Telegram bot dispatcher | New system has API; Telegram hook can call API |
| Chained hash audit log | Deferred — major migration risk |
| Finance_Vaccine data-cleaning | One-time legacy cleanup; not a recurring need |
| Finance_CrossTabAuditor | Spreadsheet validation; not applicable |
| Finance_Pro custom menu | UI layer; not backend |
| `_onAuditLogEdit` trigger | Trigger architecture not applicable to Cloudflare |

---

## Section 9: Risks & Assumptions

### Risk R-1: `opening_balance` column may not exist in D1 accounts table

**Source**: add/[[path]].js references `account.opening_balance` in balance projection
**Risk**: If column missing, balance projection is wrong for newly-created accounts
**Mitigation**: Run `PRAGMA table_info(accounts)` before any account write; add column if missing (DEFAULT 0)

### Risk R-2: Tiered biller fee structure (Finance_Intl v1.1 vs v1.0)

**Source**: LEGACY_FINANCE_INVENTORY.md Section 26, item #2
**Legacy Finance_Intl v1.0**: Fixed 31.25 PKR fee for cross-bank CC payment via 1-Biller
**Legacy Finance_Intl v1.1**: Tiered fee structure — exact tiers not documented
**Risk**: If v1.1 tiers are the correct live logic, the fixed 31.25 in sovereign-finance atm.js/bills.js is wrong
**Mitigation**: Ask user which version is live before building BillsPage payment flow

### Risk R-3: CC payment validation logic location unknown

**Source**: LEGACY_FINANCE_INVENTORY.md Section 26, item #1 — `validateCCPayment()` referenced but not located
**Risk**: Unknown validation rules may be silently missing from sovereign-finance cc.js handler
**Mitigation**: Search legacy Finance_Pro.gs for validateCCPayment() implementation before hardening CC flow

### Risk R-4: Salary auto-detection heuristic may not match legacy exactly

**Source**: Legacy heuristic: Account=Meezan + Type=Income + PKR + amount 110k-200k + day in [28-31,1-5]
**Risk**: If sovereign-finance uses different thresholds, salary tag will miss real deposits or false-positive
**Mitigation**: Grep salary handler for the detection block and compare thresholds to legacy spec

### Risk R-5: intl_package table schema not confirmed against SCHEMA.md

**Source**: intl_package referenced in add/[[path]].js but not in SCHEMA.md (which was captured 2026-05-04)
**Risk**: Column names may have drifted; international transaction commits may fail silently
**Mitigation**: Run `PRAGMA table_info(intl_package)` before any intl-mode changes

### Risk R-6: account_delta column may be missing from transactions table

**Source**: accounts/[[path]].js has a fallback: prefers `account_delta` if present, else uses signed amount from type
**Risk**: If missing, balance calculation uses the type-based fallback — which may be less precise
**Mitigation**: Run `PRAGMA table_info(transactions)` before schema work; add column if needed (NULLABLE)

### Risk R-7: goals and budgets tables not confirmed in SCHEMA.md

**Source**: SCHEMA.md was captured before goals/budgets were built
**Risk**: Goals and budgets tables may be missing in production D1 (not yet migrated)
**Mitigation**: Run health check against live /api/health — if goals/budgets tables not listed, migration needed

### Risk R-8: reconciliation vs reconciliation_snapshots table name inconsistency

**Source**: health.js checks `reconciliation_snapshots`; reconciliation/[[path]].js uses `reconciliation`
**Risk**: One of these tables may not exist; health check may report false green
**Mitigation**: Check PRAGMA for both; confirm which one is the live table; alias or migrate as needed

### Risk R-9: finance-command-center, monthly-close, insights not audited

**Source**: These three endpoints were not read during this session
**Risk**: Unknown — any of the 3 confirmed bugs could exist in these handlers
**Mitigation**: Read all three files at start of implementation session before touching anything

### Risk R-10: Push-to-CC for nano loans creates CC transaction side-effect

**Source**: nano-loans/[[path]].js push-to-cc is guarded "CC module not yet hardened"
**Risk**: CC spend created by push-to-cc may not be properly reversed if nano loan is cancelled
**Mitigation**: Implement reversal-aware push-to-cc: create cc_spend transaction linked to nano_loan_id; reversal clears both

---

## Section 10: Prioritized Execution Order

### Phase A — Schema (do first, no handler changes yet)

1. Run `PRAGMA table_info(transactions)` — confirm which columns exist vs missing
2. Run `PRAGMA table_info(accounts)` — confirm opening_balance, other cols
3. Run `PRAGMA table_info(intl_package)` — confirm intl schema
4. Audit `reconciliation` vs `reconciliation_snapshots` table existence
5. Apply migration: `ALTER TABLE transactions ADD COLUMN idempotency_key TEXT` (BUG-2)
6. Apply migration: index on idempotency_key
7. Apply migration: `opening_balance` to accounts if missing
8. Apply migration: `account_delta` to transactions if missing
9. Apply performance indexes (account_date, date, audit_created_at)
10. Commit each migration separately: `fix(schema): add idempotency_key column to transactions`

### Phase B — Bug Fixes (after schema is confirmed stable)

1. Fix BUG-1: wrap dryRun() return in json() — `fix(add): wrap dry-run internalPost result in Response`
2. Fix BUG-3: fix category ID drift — grep all handlers, replace groceries/debt_payment/cc_payment
3. Fix BUG-4: add account_id filter to GET /api/transactions and /api/ledger
4. Re-enable frontend idempotency_key sending (coordinate with LiquidityOS session)
5. Audit finance-command-center, monthly-close, insights — fix any non-Response returns

### Phase C — New Endpoints (after bugs are fixed)

1. Implement POST /api/accounts (account creation)
2. Implement PATCH /api/accounts/:id (account edit)
3. Implement POST /api/categories (category create/edit) if needed by frontend
4. Un-guard /api/nano-loans/:id/push-to-cc after CC module review
5. Confirm /api/goals and /api/budgets work end-to-end with live data

### Phase D — Frontend Wire-up (LiquidityOS sessions, after backend is green)

1. HubPage — wire to GET /api/hub
2. DebtsPage — wire to GET/POST /api/debts
3. BillsPage — wire to GET /api/bills, POST /api/bills/:id/pay
4. CreditCardPage — wire to GET /api/cc, GET /api/cc/:id/payoff-plan
5. ForecastPage — wire to GET /api/forecast
6. SalaryPage — wire to GET/POST /api/salary
7. ReconciliationPage — wire to GET/POST /api/reconciliation
8. NanoLoansPage — wire to GET/POST /api/nano-loans, POST repay
9. AtmPage — wire to GET/POST /api/atm

### Phase E — Legacy Porting (deferred, lower urgency)

1. Hash-chain audit log backfill (deferred — high risk, dedicated session)
2. Tiered biller fee logic (after user clarifies v1.0 vs v1.1)
3. Salary detection heuristic verification
4. Finance_TxnIdRepair equivalent (via /api/transactions/health repair endpoint)

---

## Section 11: Total Effort Estimate

| Phase | Sessions | Budget Estimate | Notes |
|---|---|---|---|
| Phase A: Schema | 1 session | 3–5% | PRAGMA checks + 3 migrations |
| Phase B: Bug fixes | 1–2 sessions | 5–10% | BUG-1 is tiny; BUG-3 needs grep across all handlers |
| Phase C: New endpoints | 2 sessions | 10–15% | POST /api/accounts is the main work |
| Phase D: Frontend wire-up (9 pages) | 4–6 sessions | 40–60% | Most expensive phase; each page = 1 session |
| Phase E: Legacy porting | 2–3 sessions | 10–20% | Hash chain deferred; rest is lighter |
| **Total estimate** | **10–13 sessions** | **68–110%** | Spread over multiple months at current budget |

**Quick wins (minimal budget)**:
- BUG-1 fix: < 1% (5 lines of code)
- BUG-2 migration: < 2% (SQL + index)
- BUG-4 account filter: < 1% (5 lines of code)

**These three together unblock the entire frontend add flow and enable per-account transaction history without any new UI work.**

---

## Section 12: Questions For User

Before the implementation session starts, the following decisions are needed:

**Q1 — Biller fee tiers (blocks BillsPage)**
The legacy system has two versions: Finance_Intl v1.0 with a fixed 31.25 PKR fee for cross-bank CC payments via 1-Biller, and v1.1 with a tiered fee structure. Which is live today, and if v1.1, what are the tiers?

**Q2 — Account creation via API (blocks CreditCardPage and new account onboarding)**
Should POST /api/accounts be implemented now so new accounts can be added without direct D1 SQL access? Or is the current "add directly to D1" approach acceptable for now?

**Q3 — Goals and budgets pages**
Are GoalsPage and BudgetsPage planned for LiquidityOS? Both backend endpoints exist (goals/budgets handlers) but the pages are not in the current STATUS.md. Should they be added to the roadmap?

**Q4 — Hash-chain audit log**
The legacy system has a hash-chained audit trail for tamper detection. The new audit_log table exists but the chain is not backfilled. Is full hash-chain integrity required for the new system? If yes, this is a dedicated migration session — do you want it scheduled?

**Q5 — Phase ordering preference**
Would you like to start with Phase A+B (schema + bug fixes, ~8% budget, unblocks all frontend) before any new pages? Or should we parallel-track one of the unbuilt pages alongside the fixes?

**Q6 — Nano loans push-to-CC**
The push-to-CC endpoint is currently guarded as "not hardened." Do you use this feature actively, or is it deferred?

**Q7 — Monthly close and insights**
Are /api/monthly-close and /api/insights used by any active workflow today? Or are they experimental endpoints that can stay un-audited for now?

**Q8 — finance-command-center endpoint**
Is /api/finance-command-center actively consumed by the Telegram bot or any frontend? If yes, it must be audited in Phase B. If no, it can wait.

**Q9 — Category types**
The `type` column on all 15 categories is currently NULL. Should categories be typed (expense / income / transfer / system)? This affects filtering in AddPage and BudgetsPage.

**Q10 — DELETE /api/accounts**
Should account deletion be a hard delete (row removed) or soft delete (deleted_at timestamp set)? The ledger is append-only, but hard-deleting an account would orphan all its transactions.

---

## Section 13: Out Of Scope

The following are explicitly NOT part of this plan and should not be attempted without separate user instruction:

1. **Google Apps Script modifications** — the legacy repo is read-only
2. **Telegram bot endpoint** — bot dispatcher is in the legacy Apps Script, not sovereign-finance
3. **PDF parsing** — Finance_PDFParser.gs has no equivalent in the new system
4. **Google Sheets sync** — the new system replaces Sheets UI entirely
5. **Multi-user / permissions** — single-owner system; no auth changes needed
6. **Currency conversion oracle** — FX rates come from external provider; sovereign-finance caches them but does not compute them
7. **Cloudflare Worker (worker/index.ts)** — proxy logic is in LiquidityOS, not sovereign-finance
8. **wrangler.jsonc changes** — deployment config is locked
9. **D1 table renames** — renaming tables would break all existing handlers atomically; not recommended
10. **Moving off D1** — D1 is the canonical store; no migration to external DB is planned

---

*End of BACKEND_COMPLETE_PLAN.md — generated 2026-05-23 by audit session*
*Next step: Implementation session reads this file first, then executes Phase A → B → C in order.*
