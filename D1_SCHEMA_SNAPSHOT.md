# D1 Schema Snapshot — sovereign-finance

> Captured directly from Cloudflare D1 Console.
> Original snapshot: 2026-05-23
> Updated: 2026-05-23 (Phase 2A backend session)
> Purpose: Ground truth reference. Every future backend session should read this first.

---

## Migration Status

All migrations in `migrations/` have been **written** but require manual execution:

```bash
# Run in order:
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

After execution the schema will match the "AFTER migrations" sections below.

---

## Summary

- **Tables (before Phase 2A migrations):** 43 (8 are salah_* prayer tracking, 5 are dead backups, 30 are active)
- **Tables (after Phase 2A migrations):** 49 active (+ 8 salah + 2 system) — dead backups dropped
- **New tables added by Phase 2A:** households, users, account_permissions, sessions, login_attempts, password_reset_tokens, user_2fa, idempotency_keys

---

## Row Counts (Active Tables — as of original snapshot 2026-05-23)

| Table | Rows |
|---|---|
| transactions | 294 |
| accounts | 11 |
| categories | 13 |
| merchants | 0 |
| bills | 8 |
| debts | 21 |

---

## All Tables — After Phase 2A Migrations

### Multi-user / Auth Tables (NEW — added by migrations 01-02)
- `households` — household records (default: hh_owner)
- `users` — user records with role/status (default: user_owner → owner@local)
- `account_permissions` — per-user account access grants
- `sessions` — active login sessions
- `login_attempts` — login audit log
- `password_reset_tokens` — password reset flow
- `user_2fa` — TOTP 2FA per user

### System / Dedup Tables (NEW — added by migration 04)
- `idempotency_keys` — server-side dedup for API endpoints (24h TTL)

### Active Finance Tables
- `accounts` — 11 rows (+ owner_user_id, household_id, paisa columns after migrations)
- `audit_log` — log entries (+ sequence_number, prev_entry_hash, entry_hash, entity_hash after migration 06)
- `bill_payments` — bill payment history (paisa precision)
- `bills` — 8 rows (+ owner_user_id, household_id after migration 03)
- `budgets` — per-category monthly budgets (+ owner_user_id, household_id)
- `categories` — 13 rows (type column populated after migration 07)
- `debt_payments` — debt payment history
- `debt_purge_audit` — debt deletion audit
- `debts` — 21 rows (+ owner_user_id, household_id)
- `goals` — savings goals (+ owner_user_id, household_id)
- `intl_fx_cache` — FX rate cache
- `intl_package` — international purchase 5-component breakdown
- `intl_rate_audit` — intl rate config changes audit
- `intl_rate_config` — single-row config (FY2025-26 rates after migration 08)
- `merchants` — 0 rows
- `nano_loans` — nano loan tracking (+ owner_user_id, household_id)
- `reconciliation` — drift detection
- `reconciliation_declarations` — drift declarations
- `reconciliation_exceptions` — drift exception details
- `reconciliation_snapshots` — drift snapshots
- `salary` — main salary record (+ owner_user_id, household_id)
- `salary_config` — salary calculation config
- `salary_contracts` — salary contract history
- `salary_forecast_config` — salary forecasting config
- `salary_payslip_components` — payslip component breakdown
- `salary_payslips` — payslip history
- `settings` — key/value app config
- `snapshot_data` — snapshot row data (JSON)
- `snapshots` — snapshot metadata
- `transactions` — 294 rows (+ idempotency_key, account_delta, paisa cols, household_id after migrations)

### Salah/Prayer Tracking Tables (OUT OF FINANCE SCOPE — untouched)
- `salah_daily_status`
- `salah_export_batches`
- `salah_insights`
- `salah_prayer_entries`
- `salah_prayer_times`
- `salah_recovery_items`

### System Tables
- `_cf_KV` — Cloudflare KV (internal)
- `sqlite_sequence` — SQLite autoincrement tracker

### Dead Backup Tables (SAFE TO DROP — migration 09 drops these)
- `accounts_backup_20260504`
- `accounts_backup_20260504_ccvalid`
- `budgets_backup_20260504`
- `debts_delete_backup`
- `transactions_backup_20260504_1c_replay`
- `txn_backup_salary_recat_20260504`

grep confirmed 0 handler references to any of these tables.

---

## CONFIRMED BUGS / STATUS

### Bug 1: /api/add/dry-run returns plain JS object — ✅ FIXED (Phase 2A)
**Fix**: `dryRun()` in `add/[[path]].js` now wraps `internalPost()` result in `json()`.

### Bug 2: transactions.idempotency_key missing — ✅ SCHEMA WRITTEN, needs D1 execution
**Fix**: migration 04 adds column + unique index. Frontend can re-enable idempotency_key once migration runs.

### Bug 3: Category ID drift (groceries/debt_payment/cc_payment) — ✅ FIXED (Phase 2A)
**Fix**: CATEGORY_ALIASES in transactions.js, add/[[path]].js, categories.js updated to D1 canonical IDs.

### Bug 4: /api/transactions missing account_id filter — ✅ FIXED (Phase 2A)
**Fix**: GET /api/transactions now accepts ?account_id=X for server-side filtering.

### Bug 5: POST /api/accounts returns 405 — ✅ FIXED (Phase 2A)
**Fix**: POST, PATCH, DELETE /api/accounts all implemented with proper Response objects.

---

## TRANSACTIONS TABLE — FULL SCHEMA (after Phase 2A migrations)

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
idempotency_key         TEXT           UNIQUE (WHERE NOT NULL)  ← NEW (migration 04)
account_delta           REAL           ← NEW (migration 04)
amount_paisa            INTEGER        ← NEW (migration 05)
fee_amount_paisa        INTEGER        ← NEW (migration 05)
pra_amount_paisa        INTEGER        ← NEW (migration 05)
account_delta_paisa     INTEGER        ← NEW (migration 05)
created_by_user_id      TEXT           DEFAULT 'user_owner'  ← NEW (migration 03)
modified_by_user_id     TEXT           ← NEW (migration 03)
household_id            TEXT           DEFAULT 'hh_owner'  ← NEW (migration 03)
```

---

## ACCOUNTS TABLE — SCHEMA (after Phase 2A migrations)

```
id                    TEXT PRIMARY KEY
name                  TEXT NOT NULL
icon                  TEXT
type                  TEXT NOT NULL  (CHECK: asset, liability)
kind                  TEXT NOT NULL
opening_balance       REAL           DEFAULT 0
currency              TEXT           DEFAULT 'PKR'
color                 TEXT
display_order         INTEGER        DEFAULT 0
created_at            TEXT           DEFAULT CURRENT_TIMESTAMP
status                TEXT           DEFAULT 'active'
deleted_at            TEXT
archived_at           TEXT
credit_limit          REAL
min_payment_amount    REAL
statement_day         INTEGER
payment_due_day       INTEGER
owner_user_id         TEXT           ← NEW (migration 03)
household_id          TEXT           DEFAULT 'hh_owner'  ← NEW (migration 03)
opening_balance_paisa INTEGER        DEFAULT 0  ← NEW (migration 05)
credit_limit_paisa    INTEGER        ← NEW (migration 05)
```

---

## CATEGORIES TABLE — type column (after migration 07)

| id | name | type |
|---|---|---|
| biller | Biller | expense |
| bills | Bills | expense |
| cc_pay | CC Payment | system |
| cc_spend | CC Spend | expense |
| debt | Debt | system |
| family | Family | expense |
| food | Food | expense |
| gift | Gift | expense |
| grocery | Grocery | expense |
| health | Health | expense |
| other | Other | system |
| personal | Personal | expense |
| salary | Salary | income |
| transfer | Transfer | transfer |
| transport | Transport | expense |

---

## INTL_PACKAGE TABLE — SCHEMA (unchanged — fully aligned with legacy)

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
status              TEXT NOT NULL  DEFAULT 'committed'
```

---

## INDEXES (after Phase 2A migrations, in addition to original set)

| Table | Index Name | Columns |
|---|---|---|
| transactions | idx_transactions_idempotency | (idempotency_key) WHERE NOT NULL — UNIQUE |
| transactions | idx_transactions_account_date | (account_id, date) |
| transactions | idx_transactions_date | (date) |
| transactions | idx_tx_household | (household_id) |
| transactions | idx_tx_created_by | (created_by_user_id) |
| accounts | idx_accounts_household | (household_id) |
| accounts | idx_accounts_owner | (owner_user_id) |
| bills | idx_bills_household | (household_id) |
| debts | idx_debts_household | (household_id) |
| users | idx_users_household | (household_id) |
| users | idx_users_email | (email) |
| account_permissions | idx_account_perms_user | (user_id) |
| account_permissions | idx_account_perms_account | (account_id) |
| sessions | idx_sessions_user | (user_id) |
| sessions | idx_sessions_token | (token_hash) |
| sessions | idx_sessions_expires | (expires_at) |
| login_attempts | idx_login_attempts_email_time | (email, attempted_at DESC) |
| login_attempts | idx_login_attempts_ip_time | (ip_address, attempted_at DESC) |
| password_reset_tokens | idx_password_reset_user | (user_id) |
| password_reset_tokens | idx_password_reset_token | (token_hash) |
| idempotency_keys | idx_idempotency_expires | (expires_at) |
| audit_log | idx_audit_seq | (sequence_number) |

---

## ARCHITECTURAL NOTES (updated)

1. **Multi-user foundation is code-complete.** Tables (households, users, account_permissions, sessions, auth tables) are written in migrations. Single-user mode remains the default — auth UI not yet built. No breaking changes to existing endpoints.

2. **Paisa precision prepared.** INTEGER paisa columns alongside REAL columns. Handler code continues using REAL for backward compatibility. Precision migration is a separate future session.

3. **Category IDs are now canonical.** All three CATEGORY_ALIASES maps (transactions.js, add/[[path]].js, categories.js) align to D1 canonical IDs. Frontend aliases for legacy inputs will now resolve correctly.

4. **Idempotency dedup is schema-ready.** Column added in migration 04. Frontend can re-enable `idempotency_key` field once migration runs.

5. **Account CRUD is complete.** POST/PATCH/DELETE /api/accounts implemented with soft-delete pattern.

6. **Salah tables untouched.** Prayer tracking tables coexist in the same D1 database — finance work must not reference these.

---

## NEXT BACKEND WORK PRIORITIES

1. **Run migrations 01-09** via wrangler — D1 schema is behind the code
2. **Re-enable idempotency_key** in LiquidityOS frontend (after migration 04 runs)
3. **Seed merchants table** (0 rows) — run `POST /api/merchants/seed`
4. **LiquidityOS frontend wire-up sessions** — all backend endpoints are ready
5. **Pakistan tax imports** — update salary/[[path]].js and atm/[[path]].js to import from `_lib/pakistan_taxes.js`
6. **Hash-chain audit backfill** — dedicated session (high risk migration)

---

*Updated: 2026-05-23 — Phase 2A backend foundation session complete.*
*Next session: Run migrations via wrangler, then LiquidityOS frontend wire-up.*
