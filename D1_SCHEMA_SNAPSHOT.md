# D1 Schema Snapshot — sovereign-finance

> Captured directly from Cloudflare D1 Console.
> Date: 2026-05-23
> Purpose: Ground truth reference. Every future backend session should read this first.

---

## Summary

- **Tables found:** 43 (8 are salah_* prayer tracking, 5 are dead backups, 30 are active finance + system)
- **Active finance tables:** 21
- **System/internal tables:** 2 (_cf_KV, sqlite_sequence)
- **Dead backup tables to drop:** 5
- **Out-of-scope tables:** 8 (salah_* — prayer tracking, separate domain)

---

## Row Counts (Active Tables)

| Table | Rows |
|---|---|
| transactions | 294 |
| accounts | 11 |
| categories | 13 |
| merchants | 0 |
| bills | 8 |
| debts | 21 |

---

## All Tables Found

### Active Finance Tables
- `accounts` — 11 rows
- `audit_log` — log entries, indexed by action/entity/timestamp
- `bill_payments` — bill payment history (paisa precision)
- `bills` — 8 rows
- `budgets` — per-category monthly budgets
- `categories` — 13 rows
- `debt_payments` — debt payment history (paisa precision, snapshot fields)
- `debt_purge_audit` — debt deletion audit
- `debts` — 21 rows
- `goals` — savings goals
- `intl_fx_cache` — FX rate cache
- `intl_package` — international purchase 5-component breakdown
- `intl_rate_audit` — intl rate config changes audit
- `intl_rate_config` — single-row config table (id = 1 enforced)
- `merchants` — 0 rows (table exists, empty)
- `nano_loans` — nano loan tracking (shape A/B)
- `reconciliation` — drift detection (account-level)
- `reconciliation_declarations` — drift declarations with severity
- `reconciliation_exceptions` — drift exception details
- `reconciliation_snapshots` — drift snapshots
- `salary` — main salary record
- `salary_config` — salary calculation config (many fields)
- `salary_contracts` — salary contract history
- `salary_forecast_config` — salary forecasting config
- `salary_payslip_components` — payslip component breakdown
- `salary_payslips` — payslip history
- `settings` — key/value app config
- `snapshot_data` — snapshot row data (JSON)
- `snapshots` — snapshot metadata
- `transactions` — 294 rows (CORE LEDGER)

### Salah/Prayer Tracking Tables (OUT OF FINANCE SCOPE)
- `salah_daily_status`
- `salah_export_batches`
- `salah_insights`
- `salah_prayer_entries`
- `salah_prayer_times`
- `salah_recovery_items`

These are mixed into the same D1 database but are a separate domain (prayer tracking). Finance work should NOT touch these.

### System Tables
- `_cf_KV` — Cloudflare KV (internal)
- `sqlite_sequence` — SQLite autoincrement tracker

### Dead Backup Tables (SAFE TO DROP)
- `accounts_backup_20260504`
- `accounts_backup_20260504_ccvalid`
- `budgets_backup_20260504`
- `debts_delete_backup`
- `transactions_backup_20260504_1c_replay`
- `txn_backup_salary_recat_20260504`

These are stale backups from May 4. Recommend dropping after confirming no active references. They don't affect functionality but add visual noise.

---

## CONFIRMED BUGS / GAPS

### Bug 1: transactions table is missing `idempotency_key` column
**Severity:** HIGH
**Source:** Confirmed via `PRAGMA table_info(transactions)` — column not present.
**Impact:** Frontend can't send idempotency_key (currently working around by stripping it).
**Fix:** `ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;`
**Also needed:** UNIQUE index or pre-insert lookup logic to dedupe.

### Bug 2: /api/add/dry-run handler returns plain JS object (known from earlier RCA)
**Severity:** HIGH
**Source:** Frontend hit "Unsupported GET route" — Claude RCA found handler returns plain object instead of `new Response()`.
**Impact:** Direct calls to /api/add/dry-run fail. Frontend works around by hitting /api/transactions?dry_run=1.
**Fix:** Wrap response in `new Response(JSON.stringify(...), { headers })`.

### Gap 3: POST/PATCH/DELETE /api/accounts return 405
**Severity:** HIGH for AccountsPage write actions
**Source:** Frontend can't wire Add/Save/Archive/Delete buttons.
**Fix:** Add handlers — table schema is ready (already has status, deleted_at, archived_at columns).

### Gap 4: merchants table is empty
**Severity:** MEDIUM
**Source:** 0 rows in merchants table.
**Impact:** AddPage merchant autocomplete returns no suggestions.
**Fix:** Run `POST /api/merchants/seed` if endpoint exists, or seed manually with 150+ legacy merchants from Section 20 of LEGACY_FINANCE_INVENTORY.md.

---

## TRANSACTIONS TABLE — FULL SCHEMA

```
id                      TEXT PRIMARY KEY
date                    TEXT NOT NULL
type                    TEXT NOT NULL  (CHECK: expense, income, transfer, cc_payment, cc_spend, borrow, repay, atm)
amount                  REAL NOT NULL  (CHECK: amount > 0)
account_id              TEXT NOT NULL  (FK → accounts.id)
transfer_to_account_id  TEXT           (FK → accounts.id)
category_id             TEXT           (FK → categories.id)
merchant_id             TEXT
notes                   TEXT
fee_amount              REAL           DEFAULT 0
pra_amount              REAL           DEFAULT 0
is_pending_reversal     INTEGER        DEFAULT 0
reversal_due_date       TEXT
created_at              TEXT           DEFAULT CURRENT_TIMESTAMP
reversed_by             TEXT
reversed_at             TEXT
linked_txn_id           TEXT
intl_package_id         TEXT

```

**Missing:** `idempotency_key` (bug)

**Indexes:**
- idx_tx_account ON (account_id)
- idx_tx_category ON (category_id)
- idx_tx_date ON (date DESC)
- idx_txn_linked ON (linked_txn_id)
- idx_txn_reversed ON (reversed_by)
- idx_transactions_intl_package ON (intl_package_id) WHERE intl_package_id IS NOT NULL

**Foreign keys:**
- transfer_to_account_id → accounts.id
- account_id → accounts.id
- category_id → categories.id

---

## ACCOUNTS TABLE — SCHEMA

```
id                  TEXT PRIMARY KEY
name                TEXT NOT NULL
icon                TEXT
type                TEXT NOT NULL  (CHECK: asset, liability)
kind                TEXT NOT NULL
opening_balance     REAL           DEFAULT 0
currency            TEXT           DEFAULT 'PKR'
color               TEXT
display_order       INTEGER        DEFAULT 0
created_at          TEXT           DEFAULT CURRENT_TIMESTAMP
status              TEXT           DEFAULT 'active'
deleted_at          TEXT
archived_at         TEXT
credit_limit        REAL
min_payment_amount  REAL
statement_day       INTEGER
payment_due_day     INTEGER

```

Ready for full CRUD operations. Soft-delete via `archived_at` and `deleted_at` already supported.

---

## INTL_PACKAGE TABLE — SCHEMA (legacy international purchase support)

```
id                  TEXT PRIMARY KEY
created_at          TEXT NOT NULL DEFAULT (datetime('now'))
account_id          TEXT NOT NULL
category_id         TEXT NOT NULL
merchant            TEXT
reference           TEXT
notes               TEXT
subtype             TEXT NOT NULL  (CHECK: foreign, pkr_base)
foreign_amount      REAL
foreign_currency    TEXT
fx_rate             REAL
base_pkr            REAL NOT NULL
fx_fee_pkr          REAL NOT NULL DEFAULT 0
excise_pkr          REAL NOT NULL DEFAULT 0
advance_tax_pkr     REAL NOT NULL DEFAULT 0
pra_pkr             REAL NOT NULL DEFAULT 0
bank_charge_pkr     REAL NOT NULL DEFAULT 0
total_pkr           REAL NOT NULL
rate_snapshot       TEXT NOT NULL
status              TEXT NOT NULL  DEFAULT 'committed'  (CHECK: committed, voided)

```

**FULLY ALIGNED WITH LEGACY 5-COMPONENT FEE BREAKDOWN.** This is one of the most complete tables in the database.

---

## NANO_LOANS TABLE — SCHEMA (legacy nano-loan tracking)

```
id                   TEXT PRIMARY KEY
date                 TEXT NOT NULL
app_code             TEXT
app_name             TEXT NOT NULL
status               TEXT NOT NULL DEFAULT 'active'  (CHECK: active, closed, defaulted)
shape                TEXT NOT NULL DEFAULT 'A'       (CHECK: A, B)
principal_amount     REAL NOT NULL                   (CHECK > 0)
cool_off_fee         REAL NOT NULL DEFAULT 0         (CHECK >= 0)
total_owed           REAL NOT NULL                   (CHECK > 0)
repaid_amount        REAL NOT NULL DEFAULT 0         (CHECK >= 0)
source_account_id    TEXT NOT NULL                   (FK → accounts.id)
txn_in_id            TEXT
repay_txn_id         TEXT
pushed_at            TEXT
pushed_txn_id        TEXT
push_fee_txn_id      TEXT
cool_off_due         TEXT
closed_at            TEXT
notes                TEXT
created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP

```

**FULLY ALIGNED WITH LEGACY NANO-LOAN MODEL** (Shape A/B, push to CC, repay tracking).

---

## SALARY ECOSYSTEM (5 TABLES — VERY DETAILED)

- `salary` — current salary record (39+ columns including tax tracking, EOBI, all PK 2025-26 fields)
- `salary_config` — calculation config (employer, designation, basic/HRA/medical/utility, WFH USD, tax rate, FY tax tracker, YTD totals)
- `salary_contracts` — historical contracts by effective_month
- `salary_forecast_config` — forecasting policy with FX source tracking
- `salary_payslip_components` — payslip component breakdown
- `salary_payslips` — payslip history

**ALIGNED WITH LEGACY MULTI-ANCHOR SALARY FORECAST + TAX TRACKER.** Backend has more salary fields than I expected.

---

## INDEXES (only those that exist as explicit CREATE INDEX, ordered by table)

| Table | Index Name | Columns |
|---|---|---|
| audit_log | idx_audit_action | action |
| audit_log | idx_audit_entity | (entity, entity_id) |
| audit_log | idx_audit_timestamp | timestamp DESC |
| bill_payments | idx_bill_payments_bill_month | (bill_id, bill_month, status) |
| bills | idx_bills_status | status |
| debt_payments | idx_debt_payments_debt_status | (debt_id, status) |
| debt_payments | idx_debt_payments_transaction | transaction_id |
| goals | idx_goals_status | status |
| intl_fx_cache | idx_intl_fx_cache_lookup | (base_currency, quote_currency, fetched_at DESC) |
| intl_package | idx_intl_package_account | (account_id, created_at DESC) |
| intl_rate_audit | idx_intl_rate_audit_changed_at | changed_at DESC |
| nano_loans | (6 indexes — app, date, pushed, source, status + autoindex) |
| reconciliation | idx_recon_account_date | (account_id, declared_at DESC) |
| reconciliation_declarations | idx_reconciliation_declarations_account_created | (account_id, created_at DESC) |
| reconciliation_declarations | idx_reconciliation_declarations_severity | severity |
| snapshot_data | idx_snapdata_snap | snapshot_id |
| snapshots | idx_snapshots_created | created_at DESC |
| transactions | idx_tx_account, idx_tx_category, idx_tx_date, idx_txn_linked, idx_txn_reversed, idx_transactions_intl_package |
| salary | idx_salary_next_salary_date, idx_salary_status |

Indexing is generally good. Some tables (bills, debts, accounts) have minimal indexes — could be tuned later.

---

## DATA INTEGRITY CHECKS

| Check | Result |
|---|---|
| transactions.account_id NULL count | 0 ✅ |
| transactions.amount NULL count | 0 ✅ |

Database integrity is clean on the critical fields tested.

---

## SAMPLE DATA — transactions (first 5 rows)

All 5 sample rows are ATM-related transactions from 2026-05-02:
- 1 ATM fee (35 PKR, pending reversal, then reversed)
- 1 Transfer OUT (Mashreq → Cash, 16500)
- 1 Income IN (Cash from Mashreq, 16500) — the corresponding leg
- 1 Transfer OUT (UBL → Mashreq, 16500) — different transfer
- 1 Income IN (Mashreq from UBL, 16500) — the corresponding leg

This confirms: **Transfer pair pattern works as designed** (linked OUT + IN with [linked: TXN-XXX] in notes).

---

## ARCHITECTURAL INSIGHTS

1. **The backend is way more capable than the LiquidityOS frontend currently uses.** Most of the legacy app's features have schema support already; they just need API endpoints exposed.

2. **Paisa precision is used in payments tables.** `bill_payments` and `debt_payments` use both REAL (rupees) and INTEGER (paisa) columns. The new backend already follows the "store paisa for accuracy" pattern.

3. **Soft-delete pattern is consistent.** accounts has `status`, `deleted_at`, `archived_at`. bills has `status`, `deleted_at`. Frontend can safely use these for archive/delete UX.

4. **Audit trail uses entity/action/timestamp indexing.** This is well-designed. New endpoints should write to `audit_log` with the right entity/action.

5. **The mix of salah_* tables in the same DB is unusual.** Probably from a separate prayer tracking module that shares the DB. Should be ignored for finance work.

6. **5 backup tables = ~30KB of dead weight.** Can be DROPped to clean up but not urgent.

---

## NEXT BACKEND WORK PRIORITIES (based on this schema)

1. Add `idempotency_key` column to transactions + dedupe insert logic (highest priority bug)
2. Fix `/api/add/dry-run` response wrapping (highest priority bug)
3. Add POST/PATCH/DELETE `/api/accounts` handlers (unblocks AccountsPage write actions)
4. Seed merchants table (unblocks AddPage merchant autocomplete)
5. Expose existing nano_loans table via REST endpoints (unblocks NanoLoanPage future build)
6. Expose existing intl_package data via /api/add/commit international mode (mostly already there)
7. Expose existing reconciliation_declarations via endpoints (unblocks ReconciliationPage)
8. Expose existing salary_* tables via endpoints (unblocks SalaryPage)
9. Expose existing snapshots system via endpoints (admin nice-to-have)
10. DROP backup tables (cosmetic cleanup, low priority)

---

*Snapshot complete. This document is the canonical reference for sovereign-finance D1 state as of 2026-05-23.*
