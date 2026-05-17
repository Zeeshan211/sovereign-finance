# Hub Contract

## Purpose

Hub is the command center for Sovereign Finance.

It must aggregate backend truth from the core finance modules and show the user whether the system is healthy, usable, and financially consistent.

Hub is not a money owner.

Correct flow:

```txt
Accounts + Ledger + Transactions + Debts + Bills + Salary + Forecast + Reconciliation
→ backend health/proof APIs
→ hub aggregates status
→ frontend renders dashboard
→ user follows repair links if needed
```

Hub must never create hidden financial state, recalculate money differently, or silently repair module data.

## Contract Version

`hub-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/hub.js
```

Allowed supporting route:

```txt
functions/api/hub/health.js
```

Canonical frontend owner:

```txt
index.html
js/index.js
```

If filenames differ during implementation, the rule still stands: Hub must be a read-only aggregate of backend truth.

## Core Rule

Hub reads. Hub does not own or mutate money.

Hub may read:

- accounts summary
- transaction/ledger summary
- debts summary
- bills summary
- salary source
- forecast summary
- reconciliation summary
- module health checks
- audit warnings
- monthly close status

Hub must not write:

- transactions
- accounts
- debts
- bills
- salary
- forecast state
- reconciliation snapshots
- repair changes
- audit repair rows unless explicitly designed as a read/probe event

## Required Hub API Output

Hub API should return:

```json
{
  "ok": true,
  "contract_version": "hub-v1",
  "as_of": "2026-05-17",
  "overall": "pass",
  "summary": {
    "cash_now": 9352.57,
    "expected_income": 124860,
    "expected_outflow": 115000,
    "projected_end": 19213,
    "active_debt_payable": 0,
    "active_debt_receivable": 0,
    "active_bill_remaining": 0,
    "warning_count": 0,
    "critical_count": 0
  },
  "modules": {
    "accounts": {
      "status": "pass",
      "contract_version": "accounts-v1",
      "warnings": []
    },
    "transactions": {
      "status": "pass",
      "contract_version": "transactions-add-v1",
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
    },
    "salary": {
      "status": "pass",
      "contract_version": "salary-v1",
      "warnings": []
    },
    "forecast": {
      "status": "pass",
      "contract_version": "forecast-v1",
      "warnings": []
    }
  },
  "alerts": [],
  "actions": []
}
```

## Hub Status Levels

Hub must use clear status levels.

| Status | Meaning |
|---|---|
| pass | Module is healthy and contract-safe |
| warn | Module is usable but has warnings |
| fail | Module has financial integrity risk |
| unknown | Module health unavailable |
| disabled | Module intentionally disabled |

Overall status must be derived from module statuses.

Recommended rule:

```txt
if any core module = fail → overall = fail
else if any core module = warn or unknown → overall = warn
else → overall = pass
```

Core modules:

- accounts
- transactions
- debts
- bills
- salary
- forecast
- reconciliation if enabled

## Hub Summary Fields

Hub summary must include:

| Field | Source |
|---|---|
| cash_now | forecast/accounts |
| liquid_total | accounts |
| liability_total | accounts |
| expected_income | forecast/salary |
| expected_outflow | forecast/bills/debts |
| projected_end | forecast |
| active_bill_remaining | bills |
| active_debt_payable | debts |
| active_debt_receivable | debts |
| reconciliation_difference | reconciliation |
| warning_count | module health |
| critical_count | module health |

Hub must not calculate these from frontend state.

If the backend calculates them, the response must identify the source.

## Source Policy

Hub must expose where each key number came from.

Recommended shape:

```json
{
  "sources": {
    "cash_now": "accounts.summary.liquid_total",
    "expected_income": "forecast.summary.expected_income",
    "expected_outflow": "forecast.summary.expected_outflow",
    "projected_end": "forecast.summary.projected_end",
    "active_bill_remaining": "bills.summary.remaining",
    "active_debt_payable": "debts.summary.payable_remaining",
    "active_debt_receivable": "debts.summary.receivable_remaining"
  }
}
```

This prevents hidden duplicated math.

## Accounts Connection

Hub reads account summary from Accounts contract.

Hub may display:

- liquid total
- asset total
- liability total
- net worth
- account health warnings
- stale account warnings

Hub must not independently compute balances from transaction rows if Accounts already provides canonical balance proof.

## Transactions / Ledger Connection

Hub reads transaction health and recent activity.

Hub may display:

- latest transactions
- reversal warnings
- duplicate suspicion count
- orphan account references
- daily entry health
- catch-up reminders

Hub must not create transactions directly.

If Hub offers a shortcut to add transaction, it must navigate to the canonical Add Transaction flow.

## Debts Connection

Hub reads debt summary from Debts contract.

Hub may display:

- active payable remaining
- active receivable remaining
- terminal debt warnings
- orphan debt-payment warnings
- reversal mismatch warnings

Hub must not calculate debt remaining independently.

Hub must not settle, archive, or repair debts directly unless it calls an explicit debt repair route with user action and proof.

## Bills Connection

Hub reads bill summary from Bills contract.

Hub may display:

- current-cycle expected
- current-cycle paid
- current-cycle remaining
- upcoming due bills
- advance payment summary
- bill health warnings

Hub must not calculate bill cycle totals independently.

Hub must not mark bills paid directly; payment must go through canonical Bills API.

## Salary Connection

Hub reads salary source from Salary contract.

Hub may display:

- salary enabled/disabled
- expected income amount
- payday
- payout account
- salary warnings

Hub must not create salary payout silently.

If Hub has a payout shortcut, it must call the explicit Salary payout action and display backend proof.

## Forecast Connection

Hub reads forecast summary from Forecast contract.

Hub may display:

- projected ending cash
- expected income
- expected outflow
- forecast events
- forecast warnings
- source health

Hub must not recalculate projected_end independently.

Hub must not hide forecast source warnings.

## Reconciliation Connection

Hub reads reconciliation summary.

Hub may display:

- matched count
- pending count
- exception count
- real/manual balance total
- ledger-computed balance total
- difference total
- drift warnings

Hub must not overwrite balances.

If correction is needed, Hub should link to Reconciliation, where an explicit adjustment transaction can be created.

## Audit Connection

Hub may read audit health.

Hub may display:

- recent critical audit events
- failed repair attempts
- direct edit warnings
- missing audit warnings
- last successful write proof

Hub must not modify audit history.

## Alert Contract

Hub alerts must be backend-generated or backend-backed.

Alert shape:

```json
{
  "id": "alert_debts_reversal_mismatch",
  "severity": "critical",
  "source": "debts",
  "code": "DEBT_REVERSAL_MISMATCH",
  "title": "Debt reversal mismatch detected",
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
| warning | Needs attention but app can be used |
| critical | Financial integrity risk |
| blocked | User should not rely on affected module |

Hub must not suppress critical alerts.

## Action Contract

Hub actions are navigation or explicit user-triggered operations.

Allowed actions:

- open Add Transaction
- open Accounts
- open Debts
- open Bills
- open Forecast
- open Reconciliation
- open Health/Audit
- run explicit health refresh
- run explicit module repair only if the target module owns repair and returns proof

Forbidden hidden actions:

- auto-repair without user action
- auto-create transactions
- auto-settle debts
- auto-mark bills paid
- auto-change account balances
- auto-update salary

## Read-Only Safety

Normal Hub load must be read-only.

Calling:

```txt
GET /api/hub
```

must not:

- insert transactions
- update debts
- update bills
- update accounts
- update salary
- create reconciliation snapshots
- run repairs
- normalize statuses
- mark anything settled

If a health probe logs a read-only audit event, it must not affect financial state.

## Required Warning Types

Hub should surface module warnings without burying them.

Required warning codes:

| Code | Meaning |
|---|---|
| ACCOUNTS_UNHEALTHY | Account balance/link integrity issue |
| TRANSACTIONS_UNHEALTHY | Ledger/reversal/add issue |
| DEBTS_UNHEALTHY | Debt state/ledger mismatch |
| BILLS_UNHEALTHY | Bill cycle/payment mismatch |
| SALARY_UNHEALTHY | Salary source/payout issue |
| FORECAST_UNHEALTHY | Forecast source/formula issue |
| RECONCILIATION_DRIFT | Manual balance differs from ledger |
| CONTRACT_VERSION_MISSING | Module did not report version |
| SOURCE_UNAVAILABLE | Required module API failed |
| STALE_DATA | Data is older than expected |

## Health Check Requirements

Hub health must verify:

1. Accounts health is reachable.
2. Transactions/Add health is reachable.
3. Debts health is reachable.
4. Bills health is reachable.
5. Salary health is reachable.
6. Forecast health is reachable.
7. Reconciliation health is reachable if enabled.
8. Source contract versions are present.
9. Overall status is derived correctly.
10. Summary fields come from known sources.
11. Critical module failures are surfaced as alerts.
12. Hub performs no financial writes.
13. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "hub-v1",
  "overall": "pass",
  "checks": {
    "accounts_reachable": true,
    "transactions_reachable": true,
    "debts_reachable": true,
    "bills_reachable": true,
    "salary_reachable": true,
    "forecast_reachable": true,
    "source_versions_present": true,
    "summary_sources_known": true,
    "read_only": true
  },
  "modules": {
    "accounts": "pass",
    "transactions": "pass",
    "debts": "pass",
    "bills": "pass",
    "salary": "pass",
    "forecast": "pass"
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render Hub summary
- render module status cards
- render alerts
- render next actions
- render source warnings
- link to module pages
- refresh backend Hub data
- show compact KPI strips and rows

Frontend must not:

- calculate authoritative money totals
- hide critical alerts
- mutate financial state on page load
- run repair without explicit user action
- introduce a separate visual system
- create second hero cards
- directly call stale module routes for money actions

## UI Layout Contract

Hub must use the shared app shell.

Preferred layout:

```txt
compact top status strip
KPI strip
module health grid
alerts row/list
upcoming obligations
recent ledger activity
forecast summary
reconciliation warning strip
```

Use compact rows/cards and expandable details.

Do not introduce:

- oversized standalone panels
- foreign visual blocks
- page-specific design systems
- duplicated hero cards

## Canonical API Routes

Preferred routes:

```txt
GET /api/hub
GET /api/hub/health
```

Optional query parameters:

```txt
GET /api/hub?include=alerts,summary,modules
GET /api/hub?window=current_month
```

No POST route should be required for normal Hub rendering.

If a POST route exists, it must be for explicit user-triggered actions only and must return proof.

## Stale Route Policy

Any stale Hub route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale Hub routes must not:

- calculate money totals differently
- hide module warnings
- mutate finance state
- run silent repairs
- bypass module contracts

## Acceptance Tests

### Test 1: Hub reads accounts

Input:

```txt
accounts summary liquid_total = 10000
```

Expected:

```txt
hub cash/liquid field reflects accounts source
source mapping identifies accounts summary
no frontend balance calculation required
```

### Test 2: Hub reads forecast

Input:

```txt
forecast projected_end = 19213
```

Expected:

```txt
hub projected_end = 19213
source mapping identifies forecast summary
hub does not recalculate projected_end
```

### Test 3: Hub surfaces debt warning

Input:

```txt
debts health reports reversal mismatch
```

Expected:

```txt
hub overall = fail or warn
critical alert visible
action links to Debts
warning is not hidden
```

### Test 4: Hub surfaces bill warning

Input:

```txt
bills health reports orphan payment row
```

Expected:

```txt
hub module bills status = fail or warn
alert visible
action links to Bills
```

### Test 5: Hub remains read-only

Input:

```txt
GET /api/hub
```

Expected:

```txt
no transactions inserted
no debts changed
no bills changed
no salary changed
no accounts changed
no reconciliation snapshots created
```

### Test 6: Missing source version

Input:

```txt
forecast response lacks contract_version
```

Expected:

```txt
hub warning CONTRACT_VERSION_MISSING
affected module marked warn or unknown
```

### Test 7: Source unavailable

Input:

```txt
debts API fails
```

Expected:

```txt
hub still loads partial dashboard
debts module status = unknown or fail
alert visible
overall not pass
```

### Test 8: Reconciliation drift

Input:

```txt
reconciliation difference_total != 0
```

Expected:

```txt
hub warning visible
cash totals remain ledger-derived
action links to Reconciliation
```

## Implementation Order

1. Confirm current Hub/index backend route.
2. Confirm current frontend Hub data expectations.
3. Map Hub summary fields to source APIs.
4. Add source/version reporting.
5. Add module status aggregation.
6. Add alerts list.
7. Add read-only proof.
8. Align frontend to backend Hub response only.
9. Keep UI in shared compact shell.
10. Run acceptance tests before moving to Reconciliation.

## Non-Negotiable Close Criteria

Hub is contract-safe only when:

- Hub is read-only on normal load
- every key number has a source
- source module versions are visible
- module health warnings are surfaced
- critical alerts are never hidden
- frontend renders backend truth only
- no money state is mutated by Hub
- Hub links to source modules for repair
- overall status is derived from module health
- health proves no financial writes occurred

Until these pass, Hub cannot be considered banking-grade.
