# Salary Contract

## Purpose

Salary defines expected recurring income for Sovereign Finance.

This contract hardens the salary loop:

```txt
Salary contract
→ expected income source
→ optional salary payout transaction
→ account balance derived from ledger
→ forecast reads salary source
→ hub displays expected income safely
```

Salary must be treated as a source contract for forecast, not as frontend-calculated income.

## Contract Version

`salary-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/salary/[[path]].js
```

Allowed supporting route:

```txt
functions/api/salary/health.js
```

Canonical frontend owner:

```txt
salary.html
js/salary.js
```

## Core Rule

Salary settings define expected income.

Salary does not impact account balance unless a salary payout transaction is explicitly created.

Correct flow:

```txt
User saves salary contract
→ backend stores expected salary source
→ forecast reads expected salary
→ no account balance change yet

User records salary payout
→ backend creates ledger income transaction
→ account balance increases through ledger
→ forecast/hub reflect updated position
```

Frontend must not calculate authoritative salary forecast values.

## Salary Source of Truth

Salary source must come from backend-stored salary contract fields.

Minimum source fields:

- enabled
- monthly_salary_net
- monthly_salary_gross if available
- payday
- payout_account_id
- expected_income_amount
- WFH allowance if applicable
- FX rate/snapshot if applicable
- currency
- status
- updated_at
- contract_version

## Required Salary API Output

Salary API should return:

```json
{
  "ok": true,
  "contract_version": "salary-v1",
  "salary": {
    "enabled": true,
    "monthly_salary_net": 119710,
    "monthly_salary_gross": 119710,
    "expected_income_amount": 119710,
    "payday": 1,
    "payout_account_id": "meezan",
    "currency": "PKR",
    "status": "active"
  },
  "allowances": {
    "wfh_enabled": true,
    "wfh_amount": 8377,
    "fx_rate": 279.233333
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Salary Save Contract

Saving salary settings must:

- validate salary amount
- validate payday
- validate payout account if supplied
- store salary source
- not create ledger transaction
- not change account balance
- return forecast proof

Preferred request:

```json
{
  "action": "save_contract",
  "enabled": true,
  "monthly_salary_net": 119710,
  "monthly_salary_gross": 119710,
  "payday": 1,
  "payout_account_id": "meezan",
  "currency": "PKR",
  "wfh_enabled": true,
  "wfh_amount": 8377,
  "fx_rate": 279.233333
}
```

Required validation:

- enabled is boolean
- monthly salary is positive when enabled
- payday is valid for month range
- payout account exists if supplied
- payout account is active if salary payout will use it
- FX rate is positive if supplied
- WFH allowance is zero or positive

Required response:

```json
{
  "ok": true,
  "action": "salary_save_contract",
  "contract_version": "salary-v1",
  "salary": {
    "enabled": true,
    "monthly_salary_net": 119710,
    "expected_income_amount": 119710,
    "payday": 1,
    "payout_account_id": "meezan"
  },
  "ledger": {
    "created": false,
    "transaction_id": null,
    "account_delta": 0
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Salary Payout Contract

Salary payout is a real money movement.

A salary payout must create:

1. canonical transaction row
2. salary payout proof/link if table exists
3. account impact proof
4. audit row if audit exists

Correct impact:

```txt
salary payout
→ ledger income
→ selected payout account increases
→ forecast cash position updates through accounts
```

Required marker:

```txt
[SALARY_PAYOUT] salary_id={salary_id}
```

Preferred payout request:

```json
{
  "action": "payout",
  "salary_id": "salary_main",
  "amount": 119710,
  "account_id": "meezan",
  "date": "2026-05-01",
  "notes": "Monthly salary payout",
  "idempotency_key": "client-generated-key"
}
```

Required validation:

- salary contract exists
- salary is enabled
- amount is positive
- account exists and is active
- date is valid
- duplicate/idempotency risk is checked
- payout for same cycle is not duplicated unless explicitly allowed

Required payout response:

```json
{
  "ok": true,
  "action": "salary_payout",
  "contract_version": "salary-v1",
  "salary": {
    "id": "salary_main",
    "expected_income_amount": 119710,
    "payday": 1
  },
  "ledger": {
    "created": true,
    "transaction_id": "tx_salary_payout",
    "type": "income",
    "amount": 119710,
    "account_id": "meezan",
    "account_delta": 119710,
    "marker": "[SALARY_PAYOUT] salary_id=salary_main"
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Salary Forecast Contract

Forecast may use salary as expected income only when:

```txt
salary.enabled = true
```

Forecast should consume:

- expected_income_amount
- payday
- payout account
- currency
- WFH allowance if included in net
- FX snapshot if salary is converted

Forecast must not mutate salary.

Forecast must not create payout transactions automatically unless an explicit salary payout action exists.

## Expected Income Rules

Salary expected income should be stable and backend-owned.

Rules:

- expected income must come from salary API
- frontend must not recalculate net/gross as authoritative
- WFH allowance inclusion must be explicit
- FX rate must be snapshotted if used
- forecast must identify salary source version

Recommended output:

```json
{
  "salary_source": {
    "enabled": true,
    "amount": 119710,
    "payday": 1,
    "source": "salary-contract",
    "contract_version": "salary-v1"
  }
}
```

## FX Snapshot Rule

If salary includes FX conversion, the conversion must be snapshotted.

Required FX fields when applicable:

- source currency
- target currency
- fx_rate
- fx_rate_date
- converted_amount
- source amount
- conversion source if available

Salary forecast must not silently recalculate historical expected salary using a new FX rate unless the salary contract is intentionally updated.

## WFH Allowance Rule

WFH allowance must be explicit.

Backend must specify whether WFH allowance is:

- included in monthly_salary_net
- stored separately but included in expected_income_amount
- stored separately and excluded from expected_income_amount

No frontend page should guess this.

## Reversal Contract

Salary payout reversal must repair ledger/account state.

When reversing a `[SALARY_PAYOUT]` transaction:

Required behavior:

```txt
original payout transaction is reversed
reversal transaction is inserted
account balance restores through ledger
salary contract remains unchanged
forecast reads updated account position
```

Salary contract itself should not be disabled or changed because a payout transaction was reversed.

Required module repair proof:

```json
{
  "module_repair": {
    "module": "salary",
    "action": "reverse_payout",
    "salary_id": "salary_main",
    "contract_changed": false,
    "payout_reversed": true
  }
}
```

## Accounts Connection

Salary APIs must never directly edit account balances.

Correct account impact:

```txt
salary payout
→ transaction row inserted
→ accounts API computes balance from ledger
```

Salary API may return account impact proof, but account balance remains ledger-derived.

## Ledger Connection

Every salary payout ledger row must include:

- transaction id
- account id
- type = income
- amount
- date
- source_module = salary if column exists
- source_id = salary id if column exists
- source_action = payout
- marker in notes

Required marker:

```txt
[SALARY_PAYOUT] salary_id={salary_id}
```

## Audit Contract

Salary actions should be audit logged.

Audited actions:

- salary_save_contract
- salary_disable
- salary_enable
- salary_payout
- salary_reverse_payout
- salary_fx_update
- salary_wfh_update

Audit minimum fields:

- timestamp
- route
- action
- salary_id
- transaction_id if payout/reversal
- account_id if impacted
- before summary
- after summary
- result
- warnings

## Health Check Requirements

Salary health must verify:

1. Salary contract exists when enabled.
2. Salary amount is valid and positive.
3. Payday is valid.
4. Payout account exists if configured.
5. Payout account is active if used.
6. Expected income equals backend salary source.
7. FX snapshot is valid if FX is used.
8. WFH allowance handling is explicit.
9. Salary payout transactions have parseable markers.
10. Reversed salary payout rows restore account state.
11. Forecast salary amount matches salary API amount.
12. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "salary-v1",
  "checks": {
    "contract_exists": true,
    "amount_valid": true,
    "payday_valid": true,
    "payout_account_valid": true,
    "fx_valid": true,
    "wfh_explicit": true,
    "payout_markers_valid": true,
    "forecast_matches_salary": true
  },
  "salary": {
    "enabled": true,
    "expected_income_amount": 119710,
    "payday": 1,
    "payout_account_id": "meezan"
  },
  "counts": {
    "payout_transactions": 0,
    "orphan_payout_transactions": 0,
    "reversal_mismatches": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render salary settings
- submit salary contract updates
- render expected income returned by backend
- submit explicit payout request
- show salary health warnings
- refresh forecast/accounts/hub after payout

Frontend must not:

- calculate authoritative expected salary
- silently change account balance
- mark payout complete before backend confirms
- auto-create salary payout without explicit action
- hide duplicate payout warnings
- recalculate FX-backed salary without backend confirmation

## Canonical API Routes

Preferred canonical routes:

```txt
GET /api/salary
POST /api/salary
GET /api/salary/health
```

Preferred action-based POSTs:

```txt
POST /api/salary
action=save_contract

POST /api/salary
action=payout
```

If existing routes differ, stale routes must become shims or be removed after frontend migration.

No stale route may calculate expected income differently from the canonical salary API.

## Required Frontend Submit Shapes

### Save salary contract

```json
{
  "action": "save_contract",
  "enabled": true,
  "monthly_salary_net": 119710,
  "monthly_salary_gross": 119710,
  "payday": 1,
  "payout_account_id": "meezan",
  "currency": "PKR",
  "wfh_enabled": true,
  "wfh_amount": 8377,
  "fx_rate": 279.233333
}
```

### Record salary payout

```json
{
  "action": "payout",
  "salary_id": "salary_main",
  "amount": 119710,
  "account_id": "meezan",
  "date": "2026-05-01",
  "notes": "Monthly salary payout",
  "idempotency_key": "client-generated-key"
}
```

## Stale Route Policy

Any stale salary route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- mutate account balances directly
- write forecast state
- calculate expected income differently
- create payout transactions without marker
- skip payout duplicate checks
- skip audit/proof response

## Acceptance Tests

### Test 1: Save salary contract

Input:

```txt
enabled = true
monthly_salary_net = 119710
payday = 1
payout_account = Meezan
```

Expected:

```txt
salary contract saved
no ledger transaction created
account balance unchanged
forecast expected_income = 119710
```

### Test 2: Disable salary

Input:

```txt
enabled = false
```

Expected:

```txt
salary disabled
no ledger transaction created
forecast expected_income excludes salary
historical payout transactions remain visible
```

### Test 3: Salary payout

Input:

```txt
amount = 119710
account = Meezan
date = payday
```

Expected:

```txt
ledger income created
marker = [SALARY_PAYOUT] salary_id=...
Meezan balance increases by 119710 through ledger
forecast cash_now reflects updated account position
```

### Test 4: Duplicate payout protection

Input:

```txt
same salary cycle submitted twice
```

Expected:

```txt
second request rejected or returns duplicate-safe original result
no double income committed
warning returned
```

### Test 5: Reverse salary payout

Input:

```txt
reverse [SALARY_PAYOUT] transaction
```

Expected:

```txt
ledger reversal succeeds
account balance restores
salary contract remains unchanged
forecast expected salary source remains intact
```

### Test 6: FX-backed salary

Input:

```txt
salary includes FX conversion
```

Expected:

```txt
FX rate is snapshotted
expected income uses backend converted value
forecast reads backend expected income
frontend does not recalculate authoritative salary
```

### Test 7: WFH allowance

Input:

```txt
WFH allowance enabled
```

Expected:

```txt
backend clearly states whether WFH is included in expected_income_amount
forecast uses backend amount only
```

## Implementation Order

1. Confirm current salary API route.
2. Confirm salary storage fields.
3. Ensure salary save does not create ledger movement.
4. Ensure salary API returns expected income proof.
5. Ensure forecast consumes salary backend source.
6. Add explicit payout action if not already present.
7. Ensure payout creates ledger income marker.
8. Add duplicate payout protection.
9. Add salary health/proof output.
10. Run acceptance tests before moving to Forecast.

## Non-Negotiable Close Criteria

Salary is contract-safe only when:

- salary settings are backend-owned
- saving salary does not affect account balance
- forecast reads salary API expected income
- payout creates canonical ledger income
- payout account impact is ledger-derived
- payout has parseable salary marker
- duplicate payout does not double-commit income
- reversal restores account balance without changing salary contract
- frontend renders backend salary truth only
- health endpoint reports no salary/forecast mismatch

Until these pass, Salary cannot be considered banking-grade.
