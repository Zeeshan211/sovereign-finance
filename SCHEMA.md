
---

## REAL DATA — captured 2026-05-04

### Active accounts (11 total)

| id | name | type | status |
|---|---|---|---|
| cash | Cash | asset | active |
| meezan | Meezan | asset | active |
| mashreq | Mashreq Bank | asset | active |
| ubl | UBL | asset | active |
| ubl_prepaid | UBL Prepaid | asset | active |
| easypaisa | Easypaisa | asset | active |
| jazzcash | JazzCash | asset | active |
| naya_pay | Naya Pay | asset | active |
| js_bank | JS Bank | asset | active |
| alfalah | Bank Alfalah | asset | active |
| cc | Alfalah CC | liability | active |

**Single liability account:** `cc` (Alfalah Credit Card). All other accounts are assets.

### Categories in D1 (15 total)

| id | name |
|---|---|
| food | Food |
| grocery | Groceries |
| transport | Transport |
| bills | Bills |
| health | Health |
| personal | Personal |
| family | Family |
| debt | Debt Payment |
| cc_pay | CC Payment |
| cc_spend | CC Spend |
| biller | Biller Charge |
| salary | Salary |
| gift | Gift Received |
| transfer | Transfer |
| other | Other |

**`type` column on categories is NULL for all rows** — never populated.

### Status values currently in use (per table)

| table | values seen | possible values |
|---|---|---|
| accounts | active | active / archived / deleted (per schema defaults + Sub-1D-3e UI) |
| bills | active | active / archived / deleted (per schema defaults + Sub-1D-3b/3d UI) |
| debts | active | active / closed (per Sub-1D-3c CRUD) |
| budgets | active | active / paused (per Sub-1D-4b) |
| goals | active | active / completed (per Sub-1D-4a) |

**Note:** only 'active' values exist today (no records have been archived/closed/deleted yet). Future SQL must still handle non-active values when they appear.

---

## KNOWN DRIFTS / TODO

### store.js FALLBACK_ACCOUNTS vs real accounts
store.js v0.1.0 line ~30 lists 11 fallback accounts. ✅ All 11 IDs match real D1 accounts. Names + icons match. No drift.

### store.js CATEGORIES vs real categories — ⚠️ DRIFT
store.js v0.1.0 hardcodes 12 categories with IDs that DON'T match D1:

| store.js ID | D1 ID | Status |
|---|---|---|
| food | food | ✅ match |
| groceries | grocery | ❌ DRIFT |
| transport | transport | ✅ match |
| bills | bills | ✅ match |
| health | health | ✅ match |
| personal | personal | ✅ match |
| family | family | ✅ match |
| debt_payment | debt | ❌ DRIFT |
| cc_payment | cc_pay | ❌ DRIFT |
| salary | salary | ✅ match |
| gift | gift | ✅ match |
| other | other | ✅ match |

**Plus D1 has 3 extra categories not in store.js:** `cc_spend`, `biller`, `transfer`

**Impact:** /add.html category dropdown sends drifted IDs to backend. Backend doesn't validate category_id FK so writes succeed but category-based reporting is broken. Pattern 4.

**Fix:** Sub-1D-CATEGORY-RECONCILE — point store.js at D1 (either fetch from new /api/categories endpoint or sync hardcoded list). Defer to next session, not blocking.

---

## REAL DATA — captured 2026-05-04

### Active accounts (11 total)

| id | name | type | status |
|---|---|---|---|
| cash | Cash | asset | active |
| meezan | Meezan | asset | active |
| mashreq | Mashreq Bank | asset | active |
| ubl | UBL | asset | active |
| ubl_prepaid | UBL Prepaid | asset | active |
| easypaisa | Easypaisa | asset | active |
| jazzcash | JazzCash | asset | active |
| naya_pay | Naya Pay | asset | active |
| js_bank | JS Bank | asset | active |
| alfalah | Bank Alfalah | asset | active |
| cc | Alfalah CC | liability | active |

Single liability account: `cc` (Alfalah Credit Card). All other accounts are assets.

### Categories in D1 (15 total)

| id | name |
|---|---|
| food | Food |
| grocery | Groceries |
| transport | Transport |
| bills | Bills |
| health | Health |
| personal | Personal |
| family | Family |
| debt | Debt Payment |
| cc_pay | CC Payment |
| cc_spend | CC Spend |
| biller | Biller Charge |
| salary | Salary |
| gift | Gift Received |
| transfer | Transfer |
| other | Other |

`type` column on categories is NULL for all rows — never populated.

### Status values currently in use (per table)

| table | values seen | possible values |
|---|---|---|
| accounts | active | active / archived / deleted (per Sub-1D-3e UI) |
| bills | active | active / archived / deleted (per Sub-1D-3b/3d UI) |
| debts | active | active / closed (per Sub-1D-3c CRUD) |
| budgets | active | active / paused (per Sub-1D-4b) |
| goals | active | active / completed (per Sub-1D-4a) |

Only 'active' values exist today (no records archived/closed/deleted yet). Future SQL must still handle non-active values when they appear.

---

## KNOWN DRIFTS / TODO

### store.js FALLBACK_ACCOUNTS vs real accounts
store.js v0.1.0 hardcodes 11 fallback accounts. All 11 IDs match real D1 accounts. Names + icons match. ✅ No drift.

### store.js CATEGORIES vs real D1 categories — ⚠️ DRIFT

| store.js ID | D1 ID | Status |
|---|---|---|
| food | food | ✅ match |
| groceries | grocery | ❌ DRIFT |
| transport | transport | ✅ match |
| bills | bills | ✅ match |
| health | health | ✅ match |
| personal | personal | ✅ match |
| family | family | ✅ match |
| debt_payment | debt | ❌ DRIFT |
| cc_payment | cc_pay | ❌ DRIFT |
| salary | salary | ✅ match |
| gift | gift | ✅ match |
| other | other | ✅ match |

D1 has 3 extra categories not in store.js: `cc_spend`, `biller`, `transfer`

**Impact:** /add.html category dropdown sends drifted IDs to backend. Backend doesn't validate category_id FK so writes succeed but category-based reporting is broken. Pattern 4.

**Fix:** Sub-1D-CATEGORY-RECONCILE — point store.js at D1 (either fetch from new /api/categories endpoint or sync hardcoded list). Defer to next session, not blocking.
