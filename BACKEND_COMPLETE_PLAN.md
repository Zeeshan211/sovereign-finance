# BACKEND_COMPLETE_PLAN.md
> Generated 2026-05-23. Audit + Plan session — read-only. No code changed.
> This document is the executable spec for the implementation session ("Prompt 2").
> **UPDATED 2026-05-23: Phase 2A backend foundation session complete.**
> Phase 2A delivered: 9 D1 migrations written, 5 bugs fixed, POST/PATCH/DELETE /api/accounts implemented,
> Pakistan tax library created, dead backup tables scheduled for drop, schema snapshot updated.

---

## Section 1: Current sovereign-finance State

### 1.1 Endpoint Inventory (44 handler groups)

| Endpoint | Methods | Status | Returns Response? |
|---|---|---|---|
| GET /api/health | GET | ✅ Working | ✅ |
| GET /api/balances | GET | ✅ Working | ✅ |
| GET /api/accounts | GET | ✅ Working | ✅ |
| POST /api/accounts | POST | ✅ FIXED (Phase 2A) | ✅ |
| PATCH /api/accounts/:id | PATCH | ✅ NEW (Phase 2A) | ✅ |
| DELETE /api/accounts/:id | DELETE | ✅ NEW soft-delete (Phase 2A) | ✅ |
| GET /api/transactions | GET | ✅ Working | ✅ |
| POST /api/transactions | POST | ✅ Working (dry_run + commit) | ✅ |
| GET /api/transactions/:id | GET | ✅ Working | ✅ |
| GET /api/transactions/health | GET | ✅ Working | ✅ |
| POST /api/transactions/reverse | POST | ✅ Working | ✅ |
| POST /api/transactions/:id/reverse | POST | ✅ (shim → canonical) | ✅ |
| GET /api/add/context | GET | ✅ Working | ✅ |
| POST /api/add/preview | POST | ✅ Working | ✅ |
| POST /api/add/dry-run | POST | ✅ FIXED (Phase 2A) | ✅ |
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
| GET /api/finance-command-center | GET | ✅ Audited (Phase 2A) — correct | ✅ |
| GET /api/monthly-close | GET | ✅ Audited (Phase 2A) — correct | ✅ |
| GET /api/insights | GET | ✅ Audited (Phase 2A) — correct | ✅ |

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
| **households** | **Household records — NEW (migration 01)** | migrations/01 |
| **users** | **User accounts — NEW (migration 01)** | migrations/01 |
| **account_permissions** | **Per-user account grants — NEW (migration 01)** | migrations/01 |
| **sessions** | **Active login sessions — NEW (migration 02)** | migrations/02 |
| **login_attempts** | **Login audit log — NEW (migration 02)** | migrations/02 |
| **password_reset_tokens** | **Password reset flow — NEW (migration 02)** | migrations/02 |
| **user_2fa** | **TOTP 2FA per user — NEW (migration 02)** | migrations/02 |
| **idempotency_keys** | **Server-side dedup table — NEW (migration 04)** | migrations/04 |

### 1.3 Real D1 Data (from SCHEMA.md, captured 2026-05-04)

**11 accounts**: cash, meezan, mashreq, ubl, ubl_prepaid, easypaisa, jazzcash, naya_pay, js_bank, alfalah, cc
- Only `cc` is type=liability; all others are type=asset
- Only `active` status values exist across all accounts

**15 categories in D1**: food, grocery, transport, bills, health, personal, family, debt, cc_pay, cc_spend, biller, salary, gift, transfer, other
- `type` column is NULL pre-migration; **populated by migration 07 (pending D1 execution)**

---

## Section 2: Frontend Expectation Contract

### 2.1 LiquidityOS Query Hooks → Endpoint Map

| Hook | Method + Endpoint | Notes |
|---|---|---|
| useAccounts() | GET /api/accounts | Zod: AccountsResponseSchema |
| useBalances() | GET /api/balances | Zod: BalancesResponseSchema |
| useTransactions() | GET /api/ledger?limit=500 | Hits /ledger not /transactions |
| useAccountTransactions(id) | GET /api/ledger?account_id=X&limit=200 | ✅ Server-side filter now works (Phase 2A) |
| useAddContext() | GET /api/add/context | staleTime: 60s |
| useAddDryRun() | POST /api/add/dry-run | ✅ Canonical endpoint now fixed (Phase 2A) |
| useAddCommit() | POST /api/add/commit | Invalidates accounts/balances/transactions |
| useMerchantMatch() | POST /api/merchants/match | 300ms debounce, min 2 chars |
| useMerchantTouch() | POST /api/merchants/:id/touch | Called after successful commit |

### 2.2 Active Frontend Workarounds

| # | Workaround | Root Cause | Status |
|---|---|---|---|
| 1 | useAddDryRun() calls /api/transactions?dry_run=1 instead of /api/add/dry-run | BUG: /api/add/dry-run returns plain JS object (not Response) | ✅ FIXED (Phase 2A) — frontend can switch back to canonical endpoint |
| 2 | AddPage.tsx does NOT send idempotency_key in commit payload | BUG: transactions table missing idempotency_key column | ⏳ Schema written (migration 04), pending D1 execution; frontend can re-enable after |
| 3 | useAccountTransactions() filters client-side after full fetch | /api/ledger has no server-side account_id filter | ✅ FIXED (Phase 2A) — server-side filter now in transactions.js |
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
| Dry-run balance preview | POST /api/add/dry-run | ✅ YES (fixed Phase 2A) |
| Account balance view | GET /api/balances | ✅ YES |
| Transaction list | GET /api/ledger | ✅ YES |
| Account transaction list | GET /api/ledger?account_id=X | ✅ YES (server-side filter added Phase 2A) |
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
| Command centre (finance-command-center) | GET /api/finance-command-center | ✅ YES (audited Phase 2A) |
| Monthly close | GET /api/monthly-close | ✅ YES (audited Phase 2A) |
| Insights | GET /api/insights | ✅ YES (audited Phase 2A) |
| Account create via API | POST /api/accounts | ✅ YES (implemented Phase 2A) |
| Account edit via API | PATCH /api/accounts/:id | ✅ YES (implemented Phase 2A) |
| Account soft-delete via API | DELETE /api/accounts/:id | ✅ YES (implemented Phase 2A) |
| Pakistan FY2025-26 tax constants | functions/api/_lib/pakistan_taxes.js | ✅ YES (created Phase 2A) |
| Idempotency key dedup | Code present + schema written | ⏳ Pending D1 migration execution |
| Category type classification | Migration 07 written | ⏳ Pending D1 migration execution |
| Hash-chain audit log (chained hashes) | Schema columns ready (migration 06) | ⏳ Deferred — dedicated session needed |
| PropertiesService row pointer cache | None | ❌ NO (architectural gap — see Section 9) |
| Add context one-call bootstrap | GET /api/add/context | ✅ YES |
| Category budget tracking | GET /api/budgets (spentForCategory) | ✅ YES |
| FX rate cache + refresh | GET /api/intl-rates/fx + refresh | ✅ YES |

---

## Section 4: Confirmed Bugs To Fix

### BUG-1: /api/add/dry-run returns plain JS object — ✅ FIXED (Phase 2A)

**File**: `functions/api/add/[[path]].js`
**Fix applied**: Wrapped `internalPost()` result in `json()` before returning from `dryRun()`.
**Commit**: `fix(api): wrap add/dry-run response in proper Response object (BUG-1)`
**Frontend action needed**: Remove workaround — switch useAddDryRun() back to POST /api/add/dry-run.

### BUG-2: transactions table missing idempotency_key column — ✅ SCHEMA WRITTEN, needs D1 execution

**File**: `functions/api/transactions.js`
**Fix applied**: Migration 04 adds `idempotency_key TEXT` + unique index + `idempotency_keys` dedup table.
**D1 execution required**: `wrangler d1 execute sovereign-finance --file=migrations/04_known_bugs.sql`
**Frontend action needed**: Re-enable sending `idempotency_key` in AddPage.tsx after migration runs.

### BUG-3: Category ID drift between store.js and D1 — ✅ FIXED (Phase 2A)

**Files fixed**: `functions/api/add/[[path]].js`, `functions/api/transactions.js`, `functions/api/categories.js`
**Fix applied**: Updated `CATEGORY_ALIASES` in all three files to map to D1 canonical IDs.
**Commit**: `fix(api): align category ID references to D1 canonical IDs (BUG-3)`

### BUG-4: /api/transactions missing ?account_id= server-side filter — ✅ FIXED (Phase 2A)

**File**: `functions/api/transactions.js`
**Fix applied**: Added `WHERE account_id = ?` clause when `?account_id=` query param present. Ledger.js inherits automatically.
**Commit**: `fix(api): add server-side account_id filter to GET /api/transactions (BUG-4)`

### BUG-5: /api/accounts POST returns 405 — ✅ FIXED (Phase 2A)

**File**: `functions/api/accounts/[[path]].js`
**Fix applied**: Implemented `onRequestPost`, `onRequestPatch`, `onRequestDelete`. VERSION bumped to v0.3.0-accounts-full-crud.
**Commit**: `feat(api): enable POST, PATCH, and soft DELETE /api/accounts (Q10, BUG-5)`

---

## Section 5: Schema Changes Needed

### 5.1 Phase 2A Migrations Written (pending D1 execution)

| Migration | File | Status |
|---|---|---|
| Multi-user foundation (households, users, account_permissions) | migrations/01_multiuser_foundation.sql | ⏳ Written, needs execution |
| Auth foundation (sessions, login_attempts, password_reset, 2fa) | migrations/02_auth_foundation.sql | ⏳ Written, needs execution |
| User attribution on existing tables | migrations/03_user_attribution.sql | ⏳ Written, needs execution |
| Known bugs (idempotency_key, account_delta, idempotency_keys table) | migrations/04_known_bugs.sql | ⏳ Written, needs execution |
| Money precision (paisa integer columns) | migrations/05_money_precision.sql | ⏳ Written, needs execution |
| Audit chain prep (hash columns on audit_log) | migrations/06_audit_chain.sql | ⏳ Written, needs execution |
| Category types data | migrations/07_category_types_data.sql | ⏳ Written, needs execution |
| Intl rate config FY2025-26 | migrations/08_intl_rate_config_data.sql | ⏳ Written, needs execution |
| Drop dead backup tables (6 tables, 0 handler references confirmed) | migrations/09_drop_dead_backups.sql | ⏳ Written, needs execution |

Run in order:
```bash
wrangler d1 execute sovereign-finance --file=migrations/01_multiuser_foundation.sql
wrangler d1 execute sovereign-finance --file=migrations/02_auth_foundation.sql
wrangler d1 execute sovereign-finance --file=migrations/03_user_attribution.sql
wrangler d1 execute sovereign-finance --file=migrations/04_known_bugs.sql
wrangler d1 execute sovereign-finance --file=migrations/05_money_precision.sql
wrangler d1 execute sovereign-finance --file=migrations/06_audit_chain.sql
wrangler d1 execute sovereign-finance --file=migrations/07_category_types_data.sql
wrangler d1 execute sovereign-finance --file=migrations/08_intl_rate_config_data.sql
wrangler d1 execute sovereign-finance --file=migrations/09_drop_dead_backups.sql
```

### 5.2 Pre-Phase 2A Schema Gaps (now addressed in migrations)

| Table | Column | Type | Constraint | Status |
|---|---|---|---|---|
| transactions | idempotency_key | TEXT | NULLABLE, UNIQUE WHERE NOT NULL | ⏳ Migration 04 |
| transactions | account_delta | REAL | NULLABLE | ⏳ Migration 04 |
| transactions | amount_paisa | INTEGER | NULLABLE | ⏳ Migration 05 |
| transactions | fee_amount_paisa | INTEGER | NULLABLE | ⏳ Migration 05 |
| transactions | pra_amount_paisa | INTEGER | NULLABLE | ⏳ Migration 05 |
| transactions | account_delta_paisa | INTEGER | NULLABLE | ⏳ Migration 05 |
| transactions | created_by_user_id | TEXT | DEFAULT 'user_owner' | ⏳ Migration 03 |
| transactions | household_id | TEXT | DEFAULT 'hh_owner' | ⏳ Migration 03 |
| accounts | owner_user_id | TEXT | NULLABLE | ⏳ Migration 03 |
| accounts | household_id | TEXT | DEFAULT 'hh_owner' | ⏳ Migration 03 |
| accounts | opening_balance_paisa | INTEGER | DEFAULT 0 | ⏳ Migration 05 |
| accounts | credit_limit_paisa | INTEGER | NULLABLE | ⏳ Migration 05 |
| audit_log | sequence_number | INTEGER | NULLABLE | ⏳ Migration 06 |
| audit_log | prev_entry_hash | TEXT | NULLABLE | ⏳ Migration 06 |
| audit_log | entry_hash | TEXT | NULLABLE | ⏳ Migration 06 |
| audit_log | entity_hash | TEXT | NULLABLE | ⏳ Migration 06 |

### 5.3 No Tables To Drop Until Migration 09 Runs

Dead backup tables (scheduled for drop by migration 09, 0 handler references confirmed):
- accounts_backup_20260504
- accounts_backup_20260504_ccvalid
- budgets_backup_20260504
- debts_delete_backup
- transactions_backup_20260504_1c_replay
- txn_backup_salary_recat_20260504

---

## Section 6: New Endpoints Needed

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

| Endpoint | Method | Priority | Status |
|---|---|---|---|
| POST /api/accounts | POST | HIGH | ✅ DONE (Phase 2A) |
| PATCH /api/accounts/:id | PATCH | MEDIUM | ✅ DONE (Phase 2A) |
| DELETE /api/accounts/:id | DELETE | LOW | ✅ DONE (Phase 2A, soft-delete) |
| GET /api/goals | GET | LOW | Already exists — confirm frontend hook |
| GET /api/budgets | GET | LOW | Already exists — confirm frontend hook |
| GET /api/insights | GET | MEDIUM | ✅ Audited (Phase 2A) — no change needed |
| GET /api/finance-command-center | GET | MEDIUM | ✅ Audited (Phase 2A) — no change needed |
| GET /api/monthly-close | GET | LOW | ✅ Audited (Phase 2A) — no change needed |
| POST /api/categories | POST | LOW | Deferred |
| PATCH /api/categories/:id | PATCH | LOW | Deferred |

### 6.3 Endpoints confirmed NOT needed (handled by existing)

- No separate /api/transfers endpoint needed — transfers use /api/transactions with type=transfer
- No separate /api/cc-payments endpoint — use /api/transactions with type=cc_payment
- No separate /api/salary-income endpoint — salary deposits use /api/transactions with type=salary

---

## Section 7: Handler Fixes Needed

### 7.1 fix add/[[path]].js — dryRun() non-Response return (BUG-1) — ✅ DONE (Phase 2A)

**Commit**: `fix(api): wrap add/dry-run response in proper Response object (BUG-1)`
**Change made**: Wrapped `internalPost()` result in `json()` for the non-intl return path in `dryRun()`.

### 7.2 Add account_id filter to transactions.js and ledger.js (BUG-4) — ✅ DONE (Phase 2A)

**Commit**: `fix(api): add server-side account_id filter to GET /api/transactions (BUG-4)`
**Change made**: Added `?account_id=` query param → `WHERE account_id = ?` SQL clause. Ledger.js inherits automatically.

### 7.3 Fix category ID references across all handlers (BUG-3) — ✅ DONE (Phase 2A)

**Commit**: `fix(api): align category ID references to D1 canonical IDs (BUG-3)`
**Files changed**: add/[[path]].js, transactions.js, categories.js — all CATEGORY_ALIASES maps updated.

### 7.4 Implement POST /api/accounts (BUG-5) — ✅ DONE (Phase 2A)

**Commit**: `feat(api): enable POST, PATCH, and soft DELETE /api/accounts (Q10, BUG-5)`
**Change made**: Full onRequestPost, onRequestPatch, onRequestDelete implemented in accounts/[[path]].js.

### 7.5 Verify and un-guard /api/nano-loans/:id/push-to-cc — ⏳ DEFERRED

**Priority**: LOW
**Action needed**: Evaluate CC module stability; implement reversal-aware logic before un-guarding.

### 7.6 Audit finance-command-center, monthly-close, insights handlers — ✅ DONE (Phase 2A)

**Findings**: All three use `onRequest`, all return proper Response objects, no fixes needed.

---

## Section 8: Legacy Features To Port

Source: LEGACY_FINANCE_INVENTORY.md (sovereign-ops-private_sheet)

### 8.1 PORT decisions

| Legacy Feature | Decision | Status |
|---|---|---|
| Dry-run endpoint (proper /api/add/dry-run) | PORT | ✅ DONE (Phase 2A) |
| Idempotency key dedup | PORT | ⏳ Schema written, pending D1 execution |
| Account creation via API | PORT | ✅ DONE (Phase 2A) |
| Account-scoped transaction filter | PORT | ✅ DONE (Phase 2A) |
| Category type column | PORT | ⏳ Migration 07 written, pending D1 execution |
| Pakistan FY2025-26 tax constants | PORT | ✅ DONE (Phase 2A) — functions/api/_lib/pakistan_taxes.js |
| Hash-chain audit log | PORT (deferred) | ⏳ Schema columns added (migration 06), backfill deferred |
| PropertiesService row pointers | SKIP | ❌ Not applicable — D1 query is authoritative |
| Finance_TxnIdRepair.gs | PORT (partial) | /api/transactions/health exists; repair endpoint is future |
| Finance_PDFParser.gs | SKIP | Out of scope |
| Finance_Vaccine.gs | SKIP | Not applicable |
| Finance_CrossTabAuditor.gs | SKIP | Not applicable |
| WebApp.gs (debt metrics) | SKIP | LiquidityOS frontend replaces it |
| Finance_Pro menu structure | SKIP | Not a backend concern |
| Salary auto-detection heuristic | PORT (already ported) | ✅ In transactions.js |
| 1-Biller fee (31.25 PKR) | PORT (verify) | In pakistan_taxes.js as billerFixedFee |
| Tiered biller fee (Finance_Intl v1.1) | INVESTIGATE | See Section 9 risk #2 |
| Snowball debt order | PORT (already ported) | ✅ In debts/[[path]].js |
| Nano loan Shape A (CC refinance) | PORT | ⏳ Guarded, pending hardening |

### 8.2 SKIP decisions (final)

| Skipped Feature | Reason |
|---|---|
| PropertiesService cache | D1 queries are fast; no cache layer needed |
| PDF parsing | Not in product scope |
| Google Sheets sync | Frontend replaces Sheets UI |
| Legacy Telegram bot dispatcher | New system has API; Telegram hook can call API |
| Chained hash audit log | Deferred — major migration risk |
| Finance_Vaccine data-cleaning | One-time legacy cleanup; not a recurring need |
| Finance_CrossTabAuditor | Spreadsheet validation; not applicable |
| Finance_Pro custom menu | UI layer; not backend |
| `_onAuditLogEdit` trigger | Trigger architecture not applicable to Cloudflare |

---

## Section 9: Risks & Assumptions

### Risk R-1: `opening_balance` column — ✅ CONFIRMED EXISTS

`opening_balance` is present in the D1 accounts table (confirmed from schema snapshot). No migration needed.

### Risk R-2: Tiered biller fee structure (Finance_Intl v1.1 vs v1.0) — ⚠️ OPEN

**Source**: LEGACY_FINANCE_INVENTORY.md Section 26, item #2
**Status**: Fixed fee of 31.25 PKR is now in `pakistan_taxes.js` as `billerFixedFee`. If v1.1 tiers apply, update that constant.
**Mitigation**: Ask user which version is live before building BillsPage payment flow.

### Risk R-3: CC payment validation logic location unknown — ⚠️ OPEN

**Status**: Unchanged. Search Finance_Pro.gs for validateCCPayment() before hardening CC flow.

### Risk R-4: Salary auto-detection heuristic may not match legacy exactly — ⚠️ OPEN

**Status**: Unchanged. Verify grep against legacy spec before SalaryPage wire-up.

### Risk R-5: intl_package table schema — ✅ CONFIRMED (from SCHEMA.md snapshot)

`intl_package` schema is documented in D1_SCHEMA_SNAPSHOT.md. Columns confirmed aligned.

### Risk R-6: account_delta column — ⏳ PENDING MIGRATION

`account_delta` will be added by migration 04. Handler has fallback logic for pre-migration rows.

### Risk R-7: goals and budgets tables — ✅ CONFIRMED EXISTS

Both tables confirmed present and working (handlers verified in Phase 2A).

### Risk R-8: reconciliation vs reconciliation_snapshots — ⚠️ OPEN

**Status**: Unchanged. `reconciliation` is the live table; `reconciliation_snapshots` is an alias in health.js. Verify which actually exists in D1 before reconciliation frontend wire-up.

### Risk R-9: finance-command-center, monthly-close, insights — ✅ RESOLVED (Phase 2A)

All three handlers read and confirmed correct. They use `onRequest`, return proper Response objects, no fixes needed.

### Risk R-10: Push-to-CC for nano loans — ⚠️ OPEN (deferred)

**Status**: Still guarded. Implement reversal-aware push-to-cc in a dedicated session.

---

## Section 10: Prioritized Execution Order

### Phase A — Schema ✅ COMPLETE (Phase 2A)

All migration files written (01-09). D1 execution pending — user must run via wrangler.

### Phase B — Bug Fixes ✅ COMPLETE (Phase 2A)

- BUG-1 (dry-run plain object): ✅ FIXED
- BUG-2 (idempotency_key column): ✅ Migration written, pending D1 execution
- BUG-3 (category ID drift): ✅ FIXED
- BUG-4 (account_id filter): ✅ FIXED
- BUG-5 (POST accounts 405): ✅ FIXED

### Phase C — New Endpoints ✅ COMPLETE (Phase 2A)

- POST /api/accounts: ✅ IMPLEMENTED
- PATCH /api/accounts/:id: ✅ IMPLEMENTED
- DELETE /api/accounts/:id: ✅ IMPLEMENTED (soft-delete)
- finance-command-center, monthly-close, insights: ✅ AUDITED (no changes needed)

### Phase D — Frontend Wire-up (LiquidityOS sessions, after backend is green) — ⏳ NEXT

1. Run D1 migrations 01-09 via wrangler (user must do this)
2. Re-enable idempotency_key in LiquidityOS frontend (after migration 04 runs)
3. Switch useAddDryRun() back to POST /api/add/dry-run (BUG-1 now fixed)
4. HubPage — wire to GET /api/hub
5. DebtsPage — wire to GET/POST /api/debts
6. BillsPage — wire to GET /api/bills, POST /api/bills/:id/pay
7. CreditCardPage — wire to GET /api/cc, GET /api/cc/:id/payoff-plan
8. ForecastPage — wire to GET /api/forecast
9. SalaryPage — wire to GET/POST /api/salary
10. ReconciliationPage — wire to GET/POST /api/reconciliation
11. NanoLoansPage — wire to GET/POST /api/nano-loans, POST repay
12. AtmPage — wire to GET/POST /api/atm

### Phase E — Legacy Porting (deferred, lower urgency)

1. Hash-chain audit log backfill (deferred — high risk, dedicated session)
2. Tiered biller fee logic (after user clarifies v1.0 vs v1.1)
3. Salary detection heuristic verification
4. Finance_TxnIdRepair equivalent (via /api/transactions/health repair endpoint)
5. Import pakistan_taxes.js in salary/[[path]].js and atm/[[path]].js (noted, deferred)

---

## Section 11: Total Effort Estimate

| Phase | Sessions | Budget Estimate | Status |
|---|---|---|---|
| Phase A: Schema | 1 session | 3–5% | ✅ DONE |
| Phase B: Bug fixes | 1–2 sessions | 5–10% | ✅ DONE |
| Phase C: New endpoints | 2 sessions | 10–15% | ✅ DONE |
| Phase D: Frontend wire-up (9 pages) | 4–6 sessions | 40–60% | ⏳ NEXT — run migrations first |
| Phase E: Legacy porting | 2–3 sessions | 10–20% | ⏳ DEFERRED |
| **Total estimate** | **10–13 sessions** | **68–110%** | Phases A-C complete |

**Phase 2A session used ~10-12% budget** (9 migrations + 5 bug fixes + 3 new endpoints + audit + library + docs).

---

## Section 12: Questions For User

**Q1 — Biller fee tiers (blocks BillsPage)** — ⚠️ OPEN
The legacy system has two versions: Finance_Intl v1.0 with a fixed 31.25 PKR fee for cross-bank CC payments via 1-Biller, and v1.1 with a tiered fee structure. Fixed fee is now in pakistan_taxes.js as `billerFixedFee`. Which is live today?

**Q2 — Account creation via API** — ✅ ANSWERED (Phase 2A)
POST /api/accounts, PATCH /api/accounts/:id, and soft-DELETE /api/accounts/:id are all now implemented.

**Q3 — Goals and budgets pages** — ⚠️ OPEN
Are GoalsPage and BudgetsPage planned for LiquidityOS? Both backend endpoints exist. Should they be added to the roadmap?

**Q4 — Hash-chain audit log** — ⚠️ DEFERRED
Schema columns added by migration 06 (sequence_number, prev_entry_hash, entry_hash, entity_hash). Backfill is a separate dedicated session — high risk migration. Schedule when needed.

**Q5 — Phase ordering preference** — ✅ ANSWERED
User chose to complete all of Phases A-C first. Next: run migrations via wrangler, then start Phase D (frontend wire-up).

**Q6 — Nano loans push-to-CC** — ⚠️ OPEN
push-to-CC is still guarded. Revisit when CC module hardening is scheduled.

**Q7 — Monthly close and insights** — ✅ ANSWERED (Phase 2A)
Both audited and confirmed correct. No changes needed.

**Q8 — finance-command-center endpoint** — ✅ ANSWERED (Phase 2A)
Audited and confirmed correct. Uses `onRequest`, returns proper Response. No changes needed.

**Q9 — Category types** — ✅ ANSWERED (Phase 2A)
Migration 07 written: UPDATE sets type (expense/income/transfer/system) for all 15 categories. Pending D1 execution.

**Q10 — DELETE /api/accounts** — ✅ ANSWERED (Phase 2A)
Implemented as soft-delete: sets `deleted_at=now` and `status='deleted'`. Row and all transactions preserved.

---

## Section 13: Out Of Scope

The following are explicitly NOT part of this plan and should not be attempted without separate user instruction:

1. **Google Apps Script modifications** — the legacy repo is read-only
2. **Telegram bot endpoint** — bot dispatcher is in the legacy Apps Script, not sovereign-finance
3. **PDF parsing** — Finance_PDFParser.gs has no equivalent in the new system
4. **Google Sheets sync** — the new system replaces Sheets UI entirely
5. **Multi-user / permissions** — single-owner system; auth UI not yet built; foundation is schema-complete
6. **Currency conversion oracle** — FX rates come from external provider; sovereign-finance caches them but does not compute them
7. **Cloudflare Worker (worker/index.ts)** — proxy logic is in LiquidityOS, not sovereign-finance
8. **wrangler.jsonc changes** — deployment config is locked
9. **D1 table renames** — renaming tables would break all existing handlers atomically; not recommended
10. **Moving off D1** — D1 is the canonical store; no migration to external DB is planned

---

*End of BACKEND_COMPLETE_PLAN.md*
*Original audit: 2026-05-23*
*Phase 2A implementation complete: 2026-05-23*
*Commits pushed to main: 7 (6 implementation + 1 docs)*
*Next session: Run migrations 01-09 via wrangler, then LiquidityOS Phase D frontend wire-up.*
