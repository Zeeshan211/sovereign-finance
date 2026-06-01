# Bills Section Contract — Full Specification

> Version: `bills-section-v2`
> Budget cap: 5% of total build effort (lean, no gold-plating)
> Scope: what exists, what works, what is broken, what is missing, how bills must connect to the rest of finance.

---

## 1. What Bills Is

Bills is the **recurring obligation module**. It tracks money the user is expected to pay on a schedule — internet, electricity, rent, subscriptions, insurance — and records proof when they pay it.

Bills is **not** a payments processor. It is an obligation tracker backed by the ledger.

The contract is simple:

```txt
Bill exists → obligation visible to forecast
Bill paid   → ledger expense created + bill_payments row linked
Bill cycle  → backend knows expected / paid / remaining per YYYY-MM
Bill reversed → ledger reversal + payment row marked reversed + cycle repaired
```

Frontend renders backend truth. Frontend does not calculate paid, remaining, or cycle status.

---

## 2. What Already Exists and Works

### 2.1 Backend API (`functions/api/bills/[[path]].js` — v0.9.0)

| Feature | Status | Notes |
|---|---|---|
| Create bill (obligation only) | ✅ Working | No ledger movement on create |
| Pay bill (current cycle) | ✅ Working | Creates ledger expense + `bill_payments` row |
| Pay bill (advance cycle) | ✅ Working | `bill_month > current_month` is explicitly supported |
| Partial payment | ✅ Working | Multiple payments in same cycle sum correctly |
| Overpayment rejection | ✅ Working | Rejects unless advance cycle is selected |
| Idempotency | ✅ Working | `payment_id` hash-keyed per bill+month+amount+account+date |
| Update bill metadata | ✅ Working | Name, amount, due_day, category, account, status |
| Defer bill | ✅ Working | Changes due_day or due_date |
| Archive/delete bill | ✅ Working | DELETE sets status=deleted |
| Cycle math (expected/paid/remaining) | ✅ Working | Backend truth, fully server-computed |
| Advance payment tracking | ✅ Working | `next_paid_cycles` in response |
| Repair reversed payments | ✅ Working | `action=repair_reversed_payments` |
| Bill detail | ✅ Working | `GET /api/bills/{id}` |
| Bill payment history | ✅ Working | `GET /api/bills/history?bill_id=X` |
| Embedded health check | ✅ Working | Orphan detection, reversal mismatch |
| Dedicated health endpoint | ✅ Working | `GET /api/bills/health` |
| Contract version tagging | ✅ Working | `bills-v1` in all responses |
| Ledger marker | ✅ Working | `[BILL_PAYMENT] bill_id=X bill_month=YYYY-MM` |
| Dry-run mode | ✅ Working | `dry_run=1` on any write |
| Inactive bill filter | ✅ Working | `include_inactive=1` query param |

### 2.2 Database Tables

| Table | Status |
|---|---|
| `bills` | ✅ Exists (8 rows in production) |
| `bill_payments` | ✅ Exists (referenced in API code) |

### 2.3 Integrations That Already Work

| Integration | Status |
|---|---|
| Ledger (transactions table) | ✅ Bill payment creates expense row |
| Accounts (balance via ledger) | ✅ Account never directly mutated |
| Forecast (reads active bills) | ✅ `forecast.js` reads bills for scheduled outflows |
| Reversal (transactions/reverse.js) | ✅ Reversal repairs bill_payments status |
| Hub | ✅ Hub reads bills outstanding count |
| Snapshots | ✅ Bills included in snapshot backup tables |
| Monthly close | ✅ Bills validation in monthly close checks |

---

## 3. What Is Broken or Missing

### 3.1 CRITICAL — Category ID Drift (Bug)

**Problem:** `bills/[[path]].js` uses `DEFAULT_CATEGORY_ID = 'bills_utilities'` but `'bills_utilities'` does not exist in D1. The valid category is `'bills'`.

**Impact:** Every bill payment transaction writes an invalid `category_id`. Category-based reporting for bills is broken. Budget deduction by category is broken.

**Fix:** Change `DEFAULT_CATEGORY_ID` from `'bills_utilities'` to `'bills'`.

**Effort:** 1 line change. Do this first before any other bills work.

---

### 3.2 CRITICAL — No Bills Schema Migration

**Problem:** The debts module has `migrations/20_debt_contract_v1.sql` which formally defines columns for `debts` and `debt_payments`. Bills has no equivalent migration. We do not know the exact `bills` and `bill_payments` column schemas without querying PRAGMA live.

**Impact:**
- `bills` table may be missing columns the code tries to write (`default_account_id`, `last_paid_date`, `last_paid_account_id`, `source_module`).
- `bill_payments` table may be missing columns like `bill_month`, `status`, `reversed_at`, `reversal_transaction_id`.
- API silently skips columns that don't exist — writes succeed but data is incomplete.

**Fix:** Write `migrations/26_bills_contract_v1.sql` to formally declare required columns and add any missing ones.

Required `bills` columns:
```sql
id                   TEXT PRIMARY KEY
name                 TEXT NOT NULL
amount               REAL NOT NULL
due_day              INTEGER
due_date             TEXT
frequency            TEXT DEFAULT 'monthly'
category_id          TEXT DEFAULT 'bills'
default_account_id   TEXT
account_id           TEXT
last_paid_date       TEXT
last_paid_account_id TEXT
auto_post            INTEGER DEFAULT 0
status               TEXT DEFAULT 'active'
notes                TEXT
created_at           TEXT DEFAULT CURRENT_TIMESTAMP
updated_at           TEXT DEFAULT CURRENT_TIMESTAMP
deleted_at           TEXT
owner_user_id        TEXT DEFAULT 'user_owner'
household_id         TEXT DEFAULT 'hh_owner'
```

Required `bill_payments` columns:
```sql
id                      TEXT PRIMARY KEY
bill_id                 TEXT NOT NULL
bill_month              TEXT NOT NULL          -- YYYY-MM cycle key
amount                  REAL NOT NULL
amount_paisa            INTEGER
account_id              TEXT NOT NULL
category_id             TEXT
paid_date               TEXT NOT NULL
transaction_id          TEXT                   -- FK → transactions.id
status                  TEXT DEFAULT 'paid'    -- paid / reversed / voided
reversed_at             TEXT
reversal_transaction_id TEXT
notes                   TEXT
created_at              TEXT DEFAULT CURRENT_TIMESTAMP
updated_at              TEXT DEFAULT CURRENT_TIMESTAMP
created_by              TEXT DEFAULT 'user_owner'
```

---

### 3.3 HIGH — Credit Card Bills Not Handled Correctly

**Problem:** When a bill is paid using `account_id = 'cc'` (Alfalah Credit Card), the code writes `type = 'expense'`. But a CC purchase must be `type = 'cc_spend'` so the credit card balance updates correctly.

**Impact:** Paying bills via credit card silently corrupts the CC balance. The CC liability account is not debited.

**Fix:** In `payBill()`, detect if `accountCheck.account.type === 'liability'` and set `transaction.type = 'cc_spend'` instead of `'expense'`.

**Rule:**
```txt
Asset account payment  → type = 'expense'
Liability account (CC) payment → type = 'cc_spend'
```

---

### 3.4 HIGH — Non-Monthly Frequencies Have No Cycle Engine

**Problem:** The API accepts `frequency: 'weekly'` and `frequency: 'yearly'` but `buildCycle()` only uses `bill_month = YYYY-MM` as the cycle key. A weekly bill paid in week 2 of June would collide with week 1 in cycle math.

**Impact:** Weekly and yearly bills return incorrect cycle paid/remaining. The cycle engine treats all non-monthly bills as if they are monthly.

**Fix (5% budget version):** Do not expand the cycle engine. Instead, enforce at the API level:
- `frequency = 'monthly'` — fully supported with cycle math
- `frequency = 'yearly'` — bill_month must be provided; cycle key is the full year `YYYY` or the month of the due date
- `frequency = 'weekly'` — mark as **not yet supported** in the API response warning. Accept creation but warn that cycle math is not accurate.
- `frequency = 'custom'` — same as weekly: accept creation, warn cycle math is manual.

Add a `warnings` entry: `"weekly_and_custom_frequency_cycle_math_is_manual_only"`.

---

### 3.5 MEDIUM — Budget Deduction Not Wired

**Problem:** When a bill is paid, the expense transaction is created with a category (e.g., `bills`). The budgets module tracks monthly spending per category. But `payBill()` does not call any budget tracking logic.

**Impact:** Monthly budget for `bills` category shows incorrect remaining balance. Budget health checks will flag drift.

**Fix:** This is not a bills-only fix. The budget deduction must happen at the **ledger level** — budget spending should be computed by summing transactions by category per month, not by direct increment. Confirm with `GET /api/budgets` that it already queries `transactions` grouped by `category_id`. If yes, no fix needed in bills. If budget tracks spending via a separate column increment, file a bug against budgets.

**Action for bills:** Add a check in bills health that verifies budgets for `bills` category match actual transaction totals.

---

### 3.6 MEDIUM — `transactions.source_module` Columns Missing from Schema

**Problem:** `payBill()` writes `source_module = 'bills'`, `source_id = bill.id`, `source_action = 'payment'` to the transaction row. But the D1 schema snapshot does not list `source_module`, `source_id`, or `source_action` as columns on the `transactions` table.

**Impact:** These fields are silently skipped by `filterToColumns()`. The bill marker exists in `notes` but structured source fields are not stored. Audit and repair rely on the notes marker only.

**Fix:** Add `source_module`, `source_id`, `source_action` columns in migration `26_bills_contract_v1.sql` or confirm they already exist via `PRAGMA table_info(transactions)`. They should already be there from prior work — confirm and document.

---

### 3.7 LOW — No Archive Action (Only Delete)

**Problem:** The API only exposes `status = 'deleted'` via DELETE. There is no explicit `archive` action that sets `status = 'archived'` with an `archived_at` timestamp.

**Impact:** Deleted and archived bills are treated identically. Historical bills cannot be distinguished from mistakenly-deleted bills.

**Fix:** Add `action = 'archive'` as a POST action that sets `status = 'archived'` and `archived_at = now`. Keep DELETE as a destructive shortcut. Both excluded from active lists by default.

---

### 3.8 LOW — No Due-Date Alert for Hub

**Problem:** Hub shows bills outstanding count but does not surface bills due within the next 7 days as an actionable alert.

**Impact:** User has to open the bills page to know what is due soon. Hub feels incomplete.

**Fix:** Add a `due_soon` array to the bills overview response — bills where `due_day` falls within the next 7 calendar days and the current cycle is `unpaid` or `partial`. Hub reads this from `GET /api/bills` and displays an alert chip.

```json
"due_soon": [
  { "id": "bill_xyz", "name": "Internet", "due_date": "2026-06-05", "remaining": 3500 }
]
```

---

### 3.9 LOW — No `transactions` Source Columns Documented

The `bill_payments` rows load `reversed_by` field as `reversal_transaction_id` alias. This inconsistency in column aliasing can confuse health checks. Standardize: the column that holds the ID of the reversal transaction should be `reversal_transaction_id` in `bill_payments`.

---

## 4. How Bills Connects to the Rest of Finance

### 4.1 Ledger (transactions table)

```txt
Bill payment  → INSERT transactions (type=expense or cc_spend, source_module=bills)
Bill reversal → INSERT reversal transaction (via /api/transactions/reverse)
               → UPDATE bill_payments.status = 'reversed'
```

Bills must never bypass the ledger. Account balance changes only through the ledger.

### 4.2 Accounts

```txt
Bill payment → ledger expense → account balance decreases (ledger-derived)
Bill paid via CC → ledger cc_spend → CC liability increases (ledger-derived)
```

Bills API never calls `UPDATE accounts SET balance = ?`. Balance is always computed from `transactions`.

### 4.3 Forecast

```txt
Forecast reads active bills
Forecast computes expected_outflow = sum of (bill.amount - cycle.paid) for current month
Forecast excludes archived/deleted bills
Forecast reduces expected outflow for advance-paid future cycles
```

Forecast contract: read-only consumer of bills data. Never writes bills.

Bills must return `remaining` at the API level so forecast can consume it without re-computing.

### 4.4 Hub

```txt
Hub reads: bills count, unpaid total, due_soon list
Hub shows: "X bills due, total PKR Y remaining"
Hub shows: alert if any bill is overdue (due_day < today, status != paid)
```

Hub never calculates bill totals. It reads from `/api/bills` response.

### 4.5 Budgets

```txt
Bills category 'bills' is an expense category
Budget for 'bills' category tracks spending
Budget spending = sum of active transactions WHERE category_id = 'bills' AND date in month
Bills do not directly increment budget counters
```

If budgets module uses incremental counters (not query-based), that is a budgets bug, not a bills bug.

### 4.6 Monthly Close

```txt
Monthly close reads bills for the closed month
Bills unpaid at month-close should generate a warning (not an error)
Monthly close must not mark bills as paid
Monthly close should report: bills expected, bills paid, bills remaining for closed month
```

### 4.7 Reconciliation

```txt
Reconciliation works at account/ledger level
Bills indirectly affect reconciliation through ledger transactions
Bill-created transactions appear in account transaction list
No direct bills-to-reconciliation link needed
```

### 4.8 Audit

```txt
All bill writes should produce audit_log entries
Audited events:
  bill_create
  bill_update
  bill_archive
  bill_payment
  bill_advance_payment
  bill_reverse_payment
  bill_repair
```

The existing `audit.js` already defines `BILL_PAYMENT_CREATED` — confirm all actions are covered.

---

## 5. Canonical API Routes

```txt
GET  /api/bills                          → overview for current month
GET  /api/bills?month=YYYY-MM            → overview for specific month
GET  /api/bills?include_inactive=1       → include archived/deleted
GET  /api/bills/{id}                     → single bill detail
GET  /api/bills/history?bill_id={id}     → full payment history for bill

POST /api/bills  action=create           → create obligation
POST /api/bills  action=payment          → pay current or future cycle
POST /api/bills  action=update           → update metadata
POST /api/bills  action=defer            → change due day/date
POST /api/bills  action=archive          → archive (soft, reversible)
POST /api/bills  action=repair_reversed_payments → repair stale payment rows

DELETE /api/bills/{id}                   → hard delete (sets status=deleted)

GET  /api/bills/health                   → full health check
```

No route may implement payment, reversal, or cycle math differently from the canonical handler.

---

## 6. Cycle Status Rules (Non-Negotiable)

| Status | Rule |
|---|---|
| `unpaid` | paid = 0 |
| `partial` | paid > 0 AND paid < expected |
| `paid` | paid >= expected |
| `advance` | bill_month is future month and payment exists |
| `reversed` | all payments for cycle have status=reversed |

These are computed by the backend. Frontend must not invent or override cycle status.

---

## 7. Payment Classification Rules (Non-Negotiable)

A `bill_payments` row is counted as **effective** (adds to paid total) only if ALL of these are true:

1. `payment.status` is NOT `reversed`, `voided`, `cancelled`, `canceled`
2. `payment.reversed_at` is NULL
3. `payment.reversal_transaction_id` is NULL
4. `payment.transaction_id` is NOT NULL
5. The linked `transactions` row exists
6. The linked `transactions` row is NOT reversed (`reversed_by` is NULL AND `reversed_at` is NULL)

If any check fails, the payment is classified as ignored and excluded from the paid total.

This logic lives in `classifyPayment()` in `[[path]].js`. Do not duplicate it on the frontend.

---

## 8. What to Build Next (Prioritized, 5% Budget)

### Priority 1 — Fix broken things (must do before any feature work)

1. **Fix `DEFAULT_CATEGORY_ID`** from `'bills_utilities'` → `'bills'` (1 line)
2. **Write `migrations/26_bills_contract_v1.sql`** — document and add missing columns for `bills` and `bill_payments`
3. **Fix CC payment type** — detect liability account and write `cc_spend` not `expense`
4. **Confirm/add `source_module` columns** on transactions table

### Priority 2 — Minimum missing features (implement if budget allows)

5. **Add `archive` action** — separate from `delete`, sets `archived_at`
6. **Add `due_soon` to overview response** — bills due in next 7 days with remaining amount
7. **Add frequency warning** — weekly/custom cycles warn that cycle math is manual
8. **Add `budget_category_match` to health** — confirm bills transactions align with budget category totals

### Priority 3 — Do not build yet (over budget for 5%)

- Merchant linkage for bills
- Receipt/attachment support
- Bulk operations
- Bill splitting between accounts
- SMS/push reminders
- Subscription detection from transactions
- Bill import from statements

---

## 9. Non-Negotiable Close Criteria for Bills

Bills are contract-safe only when:

- [ ] `DEFAULT_CATEGORY_ID` is `'bills'` (not `'bills_utilities'`)
- [ ] `bills` and `bill_payments` table columns are documented in a migration
- [ ] CC-paid bills create `cc_spend` transaction type, not `expense`
- [ ] Bill create does not touch ledger or accounts
- [ ] Bill payment always creates ledger row + `bill_payments` row in same DB batch
- [ ] All bill ledger rows have `[BILL_PAYMENT] bill_id=X bill_month=YYYY-MM` in notes
- [ ] Cycle paid/remaining is computed by backend, never by frontend
- [ ] Reversed payments are excluded from cycle paid totals
- [ ] Advance payments reduce future cycle forecast obligation
- [ ] Health endpoint reports no orphan payment rows and no reversal mismatches
- [ ] Forecast consumes remaining (not amount) for bills already partially paid
- [ ] Hub shows due_soon bills with remaining amount
- [ ] Archived bills do not appear in active forecast

Until every item is checked, bills is not banking-grade.

---

## 10. What the Frontend Must and Must Not Do

### May do
- Render bill list from `/api/bills` response
- Show expected / paid / remaining from `current_cycle` object
- Show cycle status badge from `payment_status` field
- Show Paid-in-Advance section from `next_paid_cycles` array
- Show due_soon alerts from `due_soon` array
- Submit create / payment / update requests
- Display backend proof after writes
- Show warnings array from response
- Refresh ledger, accounts, forecast after successful payment

### Must not do
- Calculate authoritative paid total by summing payment records
- Calculate authoritative remaining total
- Invent cycle status (paid / partial / unpaid)
- Assume a payment succeeded before backend confirms
- Hide failed ledger writes
- Call any route that bypasses the canonical payment handler
- Allow CC bill payment without backend detecting the account type

---

## 11. Module Contract Checklist

| Question | Answer |
|---|---|
| Source of truth | `bills` table + `bill_payments` table |
| Tables read | `bills`, `bill_payments`, `transactions`, `accounts` |
| Tables written | `bills`, `bill_payments`, `transactions` |
| Creates ledger transactions | Yes — on payment only, not on create |
| Account balance impact | Indirect through ledger (never direct) |
| Forecast impact | Active bills reduce expected cash-in-hand; paid reduces remaining obligation |
| Reversal behavior | Reversal via `/api/transactions/reverse`; bill_payments status repaired |
| Audit behavior | All writes should log to `audit_log` via audit helper |
| Health check | `GET /api/bills/health` — orphans, reversal mismatches, category alignment |
| Canonical frontend route | `bills.html` / `js/bills.js` |
| Stale routes | `bills/[id].js` must forward to canonical handler or be removed |
| Proof returned | `cycle`, `ledger`, `payment`, `proof` objects in every write response |

---

*Contract version: `bills-section-v2`*
*Date: 2026-06-01*
*5% budget cap: fix broken first, then minimal missing features, no scope creep.*
