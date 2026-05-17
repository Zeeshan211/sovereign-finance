# Forecast Contract

## Purpose

Forecast is the read-only projection engine for Sovereign Finance.

This contract hardens how forecast reads money state from the rest of the app:

```txt
Ledger + Accounts + Salary + Bills + Debts
→ forecast reads backend truth
→ forecast projects cash position
→ forecast returns warnings/proof
→ forecast never mutates financial state
```

Forecast must never become a hidden writer or a second source of truth.

## Contract Version

`forecast-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/forecast.js
```

Allowed supporting routes:

```txt
functions/api/forecast/health.js
```

Canonical frontend owner:

```txt
forecast.html
js/forecast.js
```

If file names differ during implementation, the contract still stands: forecast must be one backend-owned read model with one frontend consumer contract.

## Core Rule

Forecast is read-only.

Forecast may read:

- accounts
- ledger
- salary
- bills
- debts
- credit cards
- budgets
- goals
- reconciliation warnings
- monthly close data

Forecast must not write:

- transactions
- accounts
- debts
- bills
- salary settings
- reconciliation snapshots
- monthly close rows
- audit repair rows except optional read/probe audit if explicitly designed

Correct flow:

```txt
financial modules produce backend truth
→ forecast reads active state
→ forecast calculates projection
→ frontend renders backend forecast
```

Frontend must not calculate authoritative forecast totals.

## Forecast Inputs

Forecast should consume backend-owned source data only.

Minimum inputs:

| Source | Required Data |
|---|---|
| Accounts | cash_now, liquid_total, liability_total, account warnings |
| Ledger | recent transactions, active/reversed state, current cash position |
| Salary | enabled, expected_income_amount, payday, payout account |
| Bills | active expected obligations, paid, remaining, due dates, advance payments |
| Debts | active payable remaining, active receivable remaining |
| Reconciliation | drift warnings, snapshot difference |
| Health | module warnings that affect projection trust |

Forecast must identify which source versions were used.

## Required Forecast API Output

Forecast API should return:

```json
{
  "ok": true,
  "contract_version": "forecast-v1",
  "as_of": "2026-05-17",
  "summary": {
    "cash_now": 9352.57,
    "expected_income": 124860,
    "expected_outflow": 115000,
    "projected_end": 19213,
    "liquid_total": 9352.57,
    "liability_total": 0,
    "net_position": 19213
  },
  "sources": {
    "accounts": {
      "version": "accounts-v1",
      "status": "ok"
    },
    "salary": {
      "version": "salary-v1",
      "status": "ok"
    },
    "bills": {
      "version": "bills-v1",
      "status": "ok"
    },
    "debts": {
      "version": "debts-v1",
      "status": "ok"
    }
  },
  "events": [],
  "warnings": []
}
```

## Summary Fields

Forecast summary must include:

| Field | Meaning |
|---|---|
| cash_now | current ledger-derived liquid cash position |
| expected_income | expected future income in forecast window |
| expected_outflow | expected future outflows in forecast window |
| projected_end | projected ending cash position |
| liquid_total | total liquid account balance |
| liability_total | active liability exposure if included |
| net_position | projected usable position after expected inflow/outflow |
| active_debt_payable | remaining active debts user owes |
| active_debt_receivable | remaining active debts owed to user |
| active_bill_remaining | remaining bills in forecast window |
| warning_count | count of forecast-relevant warnings |

Formula baseline:

```txt
projected_end = cash_now + expected_income + expected_receivables - expected_outflow - expected_payables
```

The exact formula may evolve, but backend must return the formula basis in `calculation_policy`.

## Calculation Policy

Forecast must expose calculation rules.

Required policy output:

```json
{
  "calculation_policy": {
    "cash_source": "accounts-ledger-derived",
    "salary_source": "salary-contract",
    "bill_source": "bills-current-cycle",
    "debt_source": "debts-active-remaining",
    "reconciliation_source": "manual-snapshots",
    "forecast_window": "current_month",
    "terminal_status_filter": true,
    "reversed_rows_excluded": true
  }
}
```

This prevents hidden math and makes forecast auditable.

## Account Input Contract

Forecast must use account balances from the Accounts contract.

Rules:

- use ledger-derived balances only
- exclude reversed rows through accounts API/balance engine
- respect archived account rules
- include liquid accounts in `cash_now`
- include liabilities only if explicitly part of net position

Forecast must not independently recalculate account balances differently from Accounts.

## Salary Input Contract

Forecast must use salary expected income from Salary contract.

Rules:

- include salary only when `salary.enabled = true`
- use backend `expected_income_amount`
- use backend payday
- use backend FX/WFH decisions
- do not create payout transactions
- do not change salary settings

Salary forecast event example:

```json
{
  "type": "salary",
  "date": "2026-06-01",
  "amount": 119710,
  "direction": "inflow",
  "source": "salary-contract"
}
```

## Bills Input Contract

Forecast must use Bills backend cycle truth.

Rules:

- include active bills only
- use backend expected/paid/remaining
- include current cycle remaining obligations
- respect advance payments
- exclude archived/disabled bills
- restore obligation if a bill payment is reversed

Bill forecast event example:

```json
{
  "type": "bill",
  "bill_id": "bill_internet",
  "date": "2026-05-20",
  "amount": 5000,
  "remaining": 5000,
  "direction": "outflow",
  "source": "bills-current-cycle"
}
```

## Debts Input Contract

Forecast must use Debts backend remaining truth.

Rules:

- include active debts only
- exclude terminal statuses
- `owe` debts are payable/outflow exposure
- `owed` debts are receivable/inflow exposure
- use `remaining_amount = max(0, original_amount - paid_amount)`
- debt payment reversals must restore forecast exposure
- debt origin reversals must remove/repair linked debt exposure

Debt payable event example:

```json
{
  "type": "debt_payable",
  "debt_id": "debt_imran",
  "amount": 10000,
  "direction": "outflow",
  "source": "debts-active-remaining"
}
```

Debt receivable event example:

```json
{
  "type": "debt_receivable",
  "debt_id": "debt_yusra",
  "amount": 5000,
  "direction": "inflow",
  "source": "debts-active-remaining"
}
```

## Reconciliation Input Contract

Forecast may consume reconciliation warnings, but must not overwrite balances.

Rules:

- if reconciliation drift exists, forecast must show warning
- forecast may display both computed and observed balance context
- forecast must not replace ledger-derived cash with manual balance unless a specific policy says so
- adjustment must happen through explicit reconciliation adjustment transaction, not forecast

Warning example:

```json
{
  "severity": "warning",
  "code": "RECONCILIATION_DRIFT",
  "message": "Manual snapshot differs from ledger-derived account balance."
}
```

## Forecast Events Contract

Forecast events should be backend-generated.

Minimum event fields:

- id
- type
- source_module
- source_id
- date
- amount
- direction
- status
- label
- warnings

Example:

```json
{
  "id": "event_bill_internet_2026_05",
  "type": "bill",
  "source_module": "bills",
  "source_id": "bill_internet",
  "date": "2026-05-20",
  "amount": 5000,
  "direction": "outflow",
  "status": "pending",
  "label": "Internet bill",
  "warnings": []
}
```

Frontend must render these events; it must not invent authoritative forecast events.

## Forecast Window

Forecast must define its window.

Supported windows:

| Window | Meaning |
|---|---|
| current_month | From today/current date to month end |
| next_30_days | Rolling 30-day projection |
| next_month | Next calendar month |
| custom | User-selected date range |

Default:

```txt
current_month
```

Forecast response must include:

```json
{
  "window": {
    "type": "current_month",
    "start": "2026-05-17",
    "end": "2026-05-31"
  }
}
```

## Read-Only Safety

Forecast must not perform hidden writes.

Forbidden forecast behavior:

- creating transactions
- marking bills paid
- settling debts
- saving salary settings
- changing account balances
- creating reconciliation snapshots
- auto-repairing module state
- silently normalizing statuses

If forecast detects bad state, it must return warnings and let the correct module repair endpoint handle it.

## Required Warning Types

Forecast should warn when projection trust is reduced.

Required warnings:

| Code | Meaning |
|---|---|
| ACCOUNTS_UNHEALTHY | Accounts health has balance/link issues |
| DEBTS_UNHEALTHY | Debts health has orphan/mismatch issues |
| BILLS_UNHEALTHY | Bills health has payment/cycle issues |
| SALARY_DISABLED | Salary expected income is disabled |
| RECONCILIATION_DRIFT | Manual snapshot differs from ledger |
| FORECAST_SOURCE_MISMATCH | Frontend/backend source contract mismatch |
| STALE_DATA | Source data is older than expected |
| UNKNOWN_SOURCE_VERSION | Source did not report contract version |

Warning shape:

```json
{
  "severity": "warning",
  "code": "BILLS_UNHEALTHY",
  "message": "Bill payment totals may not match ledger.",
  "source": "bills"
}
```

## Hub Connection

Hub reads forecast summary.

Hub must not recalculate forecast independently.

Hub may display:

- projected ending cash
- expected income
- expected outflow
- upcoming obligations
- debt exposure
- forecast warnings
- source health

Hub must link back to the source module for repairs.

## Frontend Contract

Frontend may:

- render forecast summary
- render events
- render warnings
- render source health
- switch forecast windows
- call backend forecast API
- show loading/error/empty states

Frontend must not:

- calculate authoritative forecast totals
- override backend projected_end
- silently suppress source warnings
- write module state
- create transactions from forecast without explicit user action and module route
- invent bill/debt/salary values locally

## Canonical API Routes

Preferred canonical routes:

```txt
GET /api/forecast
GET /api/forecast?window=current_month
GET /api/forecast?window=next_30_days
GET /api/forecast?start=YYYY-MM-DD&end=YYYY-MM-DD
GET /api/forecast/health
```

No POST route should be required for normal forecast calculation.

If a POST forecast route exists, it must be read-only and must not mutate finance state.

## Required Frontend Fetch Shape

Example:

```txt
GET /api/forecast?window=current_month
```

Expected frontend behavior:

```txt
fetch forecast
→ display backend summary
→ display backend events
→ display backend warnings
→ display source health
```

## Stale Route Policy

Any stale forecast route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- use different account balance logic
- calculate debt active totals differently
- ignore bill advance payments
- ignore terminal debt statuses
- mutate finance state
- hide source warnings

## Health Check Requirements

Forecast health must verify:

1. Accounts source is available.
2. Salary source is available or explicitly disabled.
3. Bills source is available.
4. Debts source is available.
5. Reconciliation warnings are readable if enabled.
6. Source contract versions are reported.
7. Reversed ledger rows are excluded by account source.
8. Terminal debts are excluded from active debt totals.
9. Bill current-cycle totals match bills backend.
10. Forecast summary formula balances.
11. Forecast performs no writes.
12. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "forecast-v1",
  "checks": {
    "accounts_source_ok": true,
    "salary_source_ok": true,
    "bills_source_ok": true,
    "debts_source_ok": true,
    "source_versions_present": true,
    "formula_balances": true,
    "read_only": true
  },
  "sources": {
    "accounts": "accounts-v1",
    "salary": "salary-v1",
    "bills": "bills-v1",
    "debts": "debts-v1"
  },
  "warnings": []
}
```

## Acceptance Tests

### Test 1: Forecast reads account cash

Input:

```txt
account balance from ledger = 10000
```

Expected:

```txt
forecast cash_now = 10000
source = accounts-ledger-derived
no frontend recalculation required
```

### Test 2: Forecast reads salary

Input:

```txt
salary enabled
expected_income_amount = 119710
```

Expected:

```txt
forecast expected_income includes 119710
salary event appears
forecast does not create transaction
```

### Test 3: Forecast excludes disabled salary

Input:

```txt
salary enabled = false
```

Expected:

```txt
forecast expected_income excludes salary
warning or source note reports salary disabled
```

### Test 4: Forecast reads bill remaining

Input:

```txt
bill expected = 10000
bill paid = 4000
```

Expected:

```txt
forecast bill remaining outflow = 6000
source = bills-current-cycle
```

### Test 5: Forecast respects bill advance payment

Input:

```txt
future cycle bill already paid
```

Expected:

```txt
future forecast obligation reduced
current cycle unchanged unless paid
Paid-in-Advance source preserved
```

### Test 6: Forecast reads debt payable

Input:

```txt
active owe debt remaining = 15000
```

Expected:

```txt
forecast payable/outflow exposure includes 15000
terminal debts excluded
```

### Test 7: Forecast reads debt receivable

Input:

```txt
active owed debt remaining = 5000
```

Expected:

```txt
forecast receivable/inflow exposure includes 5000
terminal debts excluded
```

### Test 8: Forecast excludes closed debt

Input:

```txt
debt status = closed
remaining = 0
```

Expected:

```txt
forecast excludes debt from active payable/receivable totals
```

### Test 9: Reversal affects forecast through source modules

Input:

```txt
reverse debt payment or bill payment
```

Expected:

```txt
source module state repairs
forecast changes after source repair
forecast does not perform repair itself
```

### Test 10: Forecast read-only proof

Input:

```txt
call GET /api/forecast
```

Expected:

```txt
no transactions inserted
no bills changed
no debts changed
no accounts changed
no salary changed
```

## Implementation Order

1. Confirm current forecast backend response shape.
2. Confirm current forecast frontend expected shape.
3. Align backend response to `forecast-v1` or simplify frontend to backend truth.
4. Ensure forecast reads accounts backend source.
5. Ensure forecast reads salary backend source.
6. Ensure forecast reads bills backend source.
7. Ensure forecast reads debts backend source.
8. Add source versions and calculation policy.
9. Add warnings for unhealthy sources.
10. Add read-only health proof.
11. Run acceptance tests before moving to Hub.

## Non-Negotiable Close Criteria

Forecast is contract-safe only when:

- forecast is read-only
- cash_now comes from ledger-derived accounts
- salary expected income comes from salary backend
- bill remaining comes from bills backend
- debt payable/receivable comes from debts backend
- terminal debts are excluded
- reversed rows do not corrupt projection
- frontend renders backend totals only
- source versions are reported
- warnings are visible
- health proves no writes occurred

Until these pass, Forecast cannot be considered banking-grade.
