# Health and Sanity Contract

## Purpose

Health and Sanity is the system-wide integrity layer for Sovereign Finance.

This contract defines how the app proves it is safe to use.

Correct flow:

```txt
Core modules expose health/proof
→ health aggregator reads module checks
→ sanity tests detect drift, orphan rows, reversal mismatches, and stale contracts
→ Hub surfaces system status
→ user fixes source module, not symptoms
```

Health/Sanity must never silently mutate financial state.

## Contract Version

`health-sanity-v1`

## Ownership

Canonical backend owners:

```txt
functions/api/health.js
functions/api/sanity.js
```

Allowed supporting routes:

```txt
functions/api/hub/health.js
functions/api/accounts/health.js
functions/api/debts/health.js
functions/api/bills/health.js
functions/api/salary/health.js
functions/api/forecast/health.js
functions/api/reconciliation/health.js
functions/api/audit/health.js
```

Canonical frontend owners:

```txt
sanity.html
js/sanity.js
index.html
js/index.js
```

## Core Rule

Health checks prove correctness.

They must not repair money state automatically.

Allowed behavior:

```txt
read data
check rules
return pass/warn/fail
return counts
return warnings
return source links
```

Forbidden behavior:

```txt
health check runs
→ silently fixes debt status
→ silently repairs bill payment
→ silently inserts transaction
→ silently changes account balance
```

Repairs must live in explicit module-owned repair endpoints.

## Health Status Levels

Supported statuses:

| Status | Meaning |
|---|---|
| pass | Contract checks passed |
| warn | Usable, but attention needed |
| fail | Financial integrity risk |
| unknown | Source unavailable or incomplete |
| disabled | Module intentionally disabled |

Overall rule:

```txt
if any core module = fail → overall = fail
else if any core module = warn or unknown → overall = warn
else → overall = pass
```

## Core Modules

Core health must include:

- transactions/add
- accounts
- debts
- bills
- salary
- forecast
- hub
- reconciliation
- monthly close
- audit
- categories/merchants
- credit cards if enabled

## Required Global Health Output

```json
{
  "ok": true,
  "contract_version": "health-sanity-v1",
  "overall": "pass",
  "as_of": "2026-05-17T00:00:00Z",
  "modules": {
    "transactions": {
      "status": "pass",
      "contract_version": "transactions-add-v1",
      "warnings": []
    },
    "accounts": {
      "status": "pass",
      "contract_version": "accounts-v1",
      "warnings": []
    },
    "debts": {
      "status": "pass",
      "contract_version": "debts-v1",
      "warnings": []
    },
    "bills": {
      "status": "pass",
      "contract_version": "bills-v1",
      "warnings": []
    }
  },
  "counts": {
    "critical": 0,
    "warnings": 0,
    "unknown": 0
  },
  "alerts": [],
  "warnings": []
}
```

## Required Sanity Output

Sanity must return deeper integrity checks.

```json
{
  "ok": true,
  "contract_version": "health-sanity-v1",
  "overall": "pass",
  "checks": {
    "ledger_integrity": true,
    "account_balances": true,
    "debt_links": true,
    "bill_links": true,
    "reversal_integrity": true,
    "forecast_sources": true,
    "audit_coverage": true
  },
  "counts": {
    "orphan_transactions": 0,
    "orphan_debt_payments": 0,
    "orphan_bill_payments": 0,
    "reversal_mismatches": 0,
    "missing_audit_events": 0,
    "contract_version_missing": 0
  },
  "warnings": []
}
```

## Global Checks

Health/Sanity must verify:

1. Every core module responds.
2. Every core module reports a contract version.
3. Ledger rows reference valid accounts.
4. Reversed rows are excluded from active balances.
5. Reversal rows link to originals.
6. Accounts balances are ledger-derived.
7. Debts paid/remaining totals are valid.
8. Debt payments link to ledger rows.
9. Debt origin rows link to debts.
10. Bills payments link to ledger rows.
11. Bill current-cycle totals are valid.
12. Salary source matches forecast source.
13. Forecast is read-only.
14. Reconciliation differences are visible.
15. Monthly close blocks unsafe months.
16. Audit coverage exists for core writes.
17. Categories/merchants references are valid.
18. Credit card outstanding is valid if enabled.
19. Hub surfaces all critical module warnings.
20. No stale route reports conflicting contract version.

## Ledger Sanity

Ledger sanity must check:

- transaction IDs are present
- account IDs are valid
- amounts are positive
- transaction types are allowed
- reversed originals are marked
- reversal rows link to originals
- duplicate reversal is blocked
- transfer pairs are complete
- module markers are parseable
- active balance math is stable

Failure examples:

```txt
LEDGER_ORPHAN_ACCOUNT
LEDGER_REVERSAL_MISSING_ORIGINAL
LEDGER_DUPLICATE_REVERSAL
LEDGER_SINGLE_SIDED_TRANSFER
LEDGER_INVALID_AMOUNT
```

## Accounts Sanity

Accounts sanity must check:

- all active accounts have valid metadata
- archived accounts preserve history
- no new transaction can hit archived account
- computed balances match transaction math
- liability sign policy is consistent
- opening balances are explicit
- reconciliation drift is visible

Failure examples:

```txt
ACCOUNT_BALANCE_MISMATCH
ACCOUNT_ARCHIVED_WRITE_ALLOWED
ACCOUNT_OPENING_BALANCE_MISSING_PROOF
ACCOUNT_LIABILITY_SIGN_MISMATCH
```

## Debts Sanity

Debts sanity must check:

- active debts have valid amounts
- terminal debts are excluded from active totals
- fully paid debts are terminal
- payment transactions contain debt markers
- origin transactions contain debt markers
- debt payment rows match ledger rows
- reversed payments repair paid_amount
- reversed origins do not leave false active debts
- forecast debt totals match backend debt totals

Failure examples:

```txt
DEBT_FULLY_PAID_ACTIVE
DEBT_ORPHAN_PAYMENT_TRANSACTION
DEBT_ORPHAN_ORIGIN_TRANSACTION
DEBT_REVERSAL_MISMATCH
DEBT_FORECAST_TOTAL_MISMATCH
```

## Bills Sanity

Bills sanity must check:

- active bills have valid positive amount
- payment rows reference valid bills
- payment rows reference valid transactions
- payment transaction markers are parseable
- current-cycle paid/remaining totals are backend-derived
- advance payments are assigned to future cycles
- reversed payments restore remaining amount
- forecast bill totals match backend bill totals

Failure examples:

```txt
BILL_ORPHAN_PAYMENT_ROW
BILL_ORPHAN_PAYMENT_TRANSACTION
BILL_CYCLE_TOTAL_MISMATCH
BILL_ADVANCE_CYCLE_INVALID
BILL_REVERSAL_MISMATCH
```

## Forecast Sanity

Forecast sanity must check:

- forecast performs no writes
- cash_now comes from Accounts
- expected income comes from Salary
- bill remaining comes from Bills
- debt payable/receivable comes from Debts
- terminal debts are excluded
- source contract versions are present
- calculation policy is returned

Failure examples:

```txt
FORECAST_SOURCE_MISSING
FORECAST_CONTRACT_VERSION_MISSING
FORECAST_TERMINAL_DEBT_INCLUDED
FORECAST_WRITE_DETECTED
```

## Audit Sanity

Audit sanity must check:

- core transaction writes have audit events
- reversals have audit events
- debt payments have audit events
- bill payments have audit events
- salary payouts have audit events
- reconciliation adjustments have audit events
- monthly close events have audit events
- repair jobs are audited
- audit rows are protected from frontend edit/delete

Failure examples:

```txt
AUDIT_MISSING_TRANSACTION_EVENT
AUDIT_MISSING_REVERSAL_EVENT
AUDIT_MISSING_DEBT_PAYMENT_EVENT
AUDIT_MUTATION_ALLOWED
```

## Reconciliation Sanity

Reconciliation sanity must check:

- snapshots reference valid accounts
- observed balances are numeric
- ledger balances come from Accounts
- difference math is backend-owned
- adjustment rows use ledger transactions
- wrong adjustment direction is blocked
- drift is visible to Hub/Forecast

Failure examples:

```txt
RECON_ORPHAN_SNAPSHOT
RECON_DIFFERENCE_MISMATCH
RECON_ADJUSTMENT_DIRECTION_INVALID
RECON_DRIFT_HIDDEN
```

## Monthly Close Sanity

Monthly Close sanity must check:

- source modules are reachable
- source versions are present
- close is blocked on critical failures
- close snapshot is preserved
- historical edits after close are blocked or audited
- reopen preserves original close snapshot

Failure examples:

```txt
MONTHLY_CLOSE_SOURCE_MISSING
MONTHLY_CLOSE_BLOCKER_IGNORED
MONTHLY_CLOSE_SNAPSHOT_MUTATED
MONTHLY_CLOSE_HISTORICAL_EDIT_UNAUDITED
```

## Categories and Merchants Sanity

Categories/Merchants sanity must check:

- transaction category references are valid
- merchant references are valid
- merchant default category references are valid
- duplicate active names are flagged
- archived categories remain valid for history
- deleted categories are blocked for new writes

Failure examples:

```txt
CATEGORY_ORPHAN_REFERENCE
MERCHANT_ORPHAN_REFERENCE
CATEGORY_DUPLICATE_ACTIVE
MERCHANT_DUPLICATE_NORMALIZED_NAME
```

## Credit Cards Sanity

Credit Cards sanity must check when enabled:

- outstanding balance is backend-owned
- card spend rows are marked
- card payment rows are marked
- cash account impact exists for payments
- reversals repair outstanding
- available credit equals limit minus outstanding
- over-limit warnings are surfaced
- forecast obligation matches card state

Failure examples:

```txt
CC_OUTSTANDING_MISMATCH
CC_PAYMENT_ACCOUNT_MISSING
CC_REVERSAL_MISMATCH
CC_OVER_LIMIT
```

## Alert Shape

All health/sanity alerts must use a consistent shape:

```json
{
  "id": "debt_reversal_mismatch_001",
  "severity": "critical",
  "source": "debts",
  "code": "DEBT_REVERSAL_MISMATCH",
  "title": "Debt reversal mismatch",
  "message": "A reversed debt payment has not repaired paid_amount.",
  "action": {
    "label": "Open Debts",
    "href": "/debts.html"
  }
}
```

Severity levels:

| Severity | Meaning |
|---|---|
| info | Useful context |
| warning | Needs attention |
| critical | Financial integrity risk |
| blocked | Do not rely on affected module |

## Read-Only Requirement

These routes must be read-only:

```txt
GET /api/health
GET /api/sanity
GET /api/*/health
```

They must not:

- insert transactions
- update debts
- update bills
- update accounts
- update salary
- create snapshots
- close months
- repair data
- normalize statuses

If a health route needs to offer repair, it must return a recommended action link, not perform the repair.

## Repair Separation

Health may recommend repair:

```json
{
  "recommended_action": {
    "module": "debts",
    "route": "/api/debts",
    "action": "repair_ledger",
    "requires_user_confirmation": true
  }
}
```

But repair must be explicit:

```txt
POST /api/debts
action=repair_ledger
```

No automatic repair on health page load.

## Frontend Contract

Frontend may:

- render overall status
- render module statuses
- render alerts
- render sanity counts
- link to source modules
- trigger explicit health refresh
- show compact details

Frontend must not:

- hide critical alerts
- auto-run repair
- mutate money state
- calculate authoritative health differently from backend
- suppress missing contract versions
- introduce a foreign visual system

## UI Layout Contract

Health/Sanity must use the shared app shell.

Preferred layout:

```txt
compact status strip
KPI strip: pass / warn / fail / unknown
module health rows
critical alerts
sanity check groups
expandable details
source module links
```

Do not introduce:

- oversized standalone panels
- foreign visual blocks
- page-specific design systems
- duplicated hero cards

## Canonical API Routes

Preferred routes:

```txt
GET /api/health
GET /api/sanity
GET /api/accounts/health
GET /api/debts/health
GET /api/bills/health
GET /api/salary/health
GET /api/forecast/health
GET /api/reconciliation/health
GET /api/monthly-close/health
GET /api/audit/health
GET /api/categories/health
GET /api/merchants/health
GET /api/cc/health
```

No POST route is required for normal health/sanity rendering.

## Acceptance Tests

### Test 1: Clean system

Input:

```txt
all module health checks pass
```

Expected:

```txt
overall = pass
critical = 0
warnings = 0
Hub shows system healthy
```

### Test 2: Debt mismatch

Input:

```txt
debt payment reversal mismatch exists
```

Expected:

```txt
overall = fail
alert source = debts
code = DEBT_REVERSAL_MISMATCH
repair is recommended, not auto-run
```

### Test 3: Bill orphan payment

Input:

```txt
bill payment row references missing transaction
```

Expected:

```txt
overall = fail
alert source = bills
code = BILL_ORPHAN_PAYMENT_TRANSACTION
```

### Test 4: Missing contract version

Input:

```txt
forecast health does not report contract_version
```

Expected:

```txt
overall = warn or fail based on policy
alert code = CONTRACT_VERSION_MISSING
```

### Test 5: Health is read-only

Input:

```txt
GET /api/health
GET /api/sanity
```

Expected:

```txt
no transactions inserted
no accounts changed
no debts changed
no bills changed
no salary changed
no reconciliation snapshot created
```

### Test 6: Hub surfaces critical alert

Input:

```txt
sanity returns critical debt alert
```

Expected:

```txt
Hub overall is not pass
critical alert visible
action links to source module
```

### Test 7: Stale route conflict

Input:

```txt
two routes report conflicting contract versions for same module
```

Expected:

```txt
sanity returns stale route warning
implementation must convert stale route to shim or remove it
```

## Implementation Order

1. Confirm existing health/sanity routes.
2. Add `contract_version` to every core module health response.
3. Build global `/api/health` aggregator.
4. Build deeper `/api/sanity` integrity checks.
5. Ensure all health routes are read-only.
6. Add alert normalization.
7. Wire Hub to health/sanity output.
8. Wire `sanity.html` to backend output only.
9. Run acceptance tests.
10. Start implementation phase.

## Non-Negotiable Close Criteria

Health/Sanity is contract-safe only when:

- every core module reports health
- every core module reports contract version
- global health derives overall status correctly
- sanity detects orphan links and reversal mismatches
- health routes are read-only
- critical alerts are visible in Hub
- frontend does not hide failures
- repairs are explicit and module-owned
- stale route conflicts are surfaced
- contract version is reported

Until these pass, Sovereign Finance cannot be considered banking-grade.
