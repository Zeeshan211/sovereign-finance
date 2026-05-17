# Transactions / Add Contract

## Purpose

The Transactions/Add flow is the emergency-safe daily ledger entry path for Sovereign Finance.

This contract exists so daily usage never stops, even while Debts, Bills, Forecast, Reconciliation, or other modules are being rebuilt.

If any module page is unstable, the user must still be able to record real income/expense movement through this path without corrupting accounts, ledger, or forecast.

## Contract Version

`transactions-add-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/transactions/[[path]].js
```

Canonical frontend owner:

```txt
add.html
js/add.js
transactions.html
js/transactions-v084.js
```

The exact frontend file may be renamed later, but only one frontend flow should submit normal ledger entries.

## Core Rule

A normal transaction must always follow this path:

```txt
User submits transaction
→ backend validates request
→ canonical transaction row is inserted
→ account balance changes only through ledger-derived calculation
→ transaction appears in ledger
→ accounts API reflects new balance
→ forecast reads updated account position
```

Frontend must not directly mutate account balances.

## Supported Transaction Types

| Type | Meaning | Account Impact |
|---|---|---:|
| income | Money entering selected account | Positive |
| expense | Money leaving selected account | Negative |
| transfer_out | Money leaving source account | Negative |
| transfer_in | Money entering destination account | Positive |
| adjustment_positive | Manual positive balance correction | Positive |
| adjustment_negative | Manual negative balance correction | Negative |

Transfer support may be handled as a paired transaction flow. If pair support is incomplete, transfers must be treated as unsafe until the Ledger Integrity Contract is implemented for transfer pairs.

## Required Request Fields

Every normal transaction create request must include:

| Field | Required | Notes |
|---|---:|---|
| amount | Yes | Must be positive numeric value |
| account_id | Yes | Must reference an active account |
| type | Yes | Must be allowed transaction type |
| date or occurred_at | Yes | User-selected transaction date |
| category_id | No | Required later when category contract is hardened |
| merchant | No | Optional display/search field |
| notes | No | Optional, but recommended |
| source_module | No | Defaults to `manual` |
| source_id | No | Empty for manual transactions |
| idempotency_key | Preferred | Used to prevent duplicate commits |

## Amount Rules

Backend must reject:

- Missing amount
- Zero amount
- Negative amount
- Non-numeric amount
- NaN / Infinity
- Amount with unsafe precision

Backend should normalize amount to a fixed money precision before insert.

Expected behavior:

```txt
amount = 1500
type = expense
account_delta = -1500
```

The request amount should stay positive. Direction comes from transaction type.

## Date Rules

A transaction must use the user-selected date.

Backend must not silently replace a supplied date with today.

Rules:

- `date` should represent financial posting date.
- `created_at` should represent system creation timestamp.
- Forecast and monthly close must use the financial date.
- Audit may use system timestamp.

Catch-up entries must preserve the historical transaction date.

## Catch-Up Entries

Missed historical entries are valid normal transactions.

Recommended note format:

```txt
[CATCHUP] Missed entry from YYYY-MM-DD
```

Catch-up entries must:

- create normal ledger rows
- impact account balances based on their transaction date
- appear in ledger search/filter
- be available to forecast/account calculations
- not require module linking at creation time

If later linked to Bills, Debts, or another module, that must happen through an explicit repair/link flow.

## Required Backend Validation

Before inserting a transaction, backend must validate:

1. Amount is valid and positive.
2. Account exists.
3. Account is active.
4. Type is allowed.
5. Date is valid.
6. Category exists if category is required.
7. Duplicate/idempotency risk is checked if key is supplied.
8. Request shape matches contract.

Invalid requests must fail before any write occurs.

## Required Insert Behavior

For a successful normal transaction, backend must insert one canonical transaction row.

Minimum row fields:

| Field | Required | Notes |
|---|---:|---|
| id | Yes | Stable transaction ID |
| account_id | Yes | Impacted account |
| type | Yes | Determines account delta |
| amount | Yes | Positive numeric amount |
| date / occurred_at | Yes | Financial date |
| category_id | No | Optional until category contract hardened |
| merchant | No | Optional |
| notes | No | Optional |
| source_module | Yes | `manual` for Add flow |
| source_id | No | Empty unless module-driven |
| source_action | Yes | `manual_create` |
| status / reversed flag | Yes | Must be active/not reversed |
| created_at | Yes | System timestamp |
| updated_at | Yes | System timestamp |

## Account Impact Rules

Backend must calculate and return account impact.

| Type | Account Delta |
|---|---:|
| income | `+amount` |
| expense | `-amount` |
| transfer_in | `+amount` |
| transfer_out | `-amount` |
| adjustment_positive | `+amount` |
| adjustment_negative | `-amount` |

Accounts must reflect this change only through ledger-derived balance calculation.

Do not update cached account balances directly unless the cache is explicitly treated as non-authoritative and verified against ledger.

## Required Success Response

A successful transaction create response must include proof.

```json
{
  "ok": true,
  "action": "transaction_create",
  "contract_version": "transactions-add-v1",
  "transaction": {
    "created": true,
    "id": "tx_example",
    "type": "expense",
    "amount": 1500,
    "account_id": "meezan",
    "account_delta": -1500,
    "date": "2026-05-17",
    "source_module": "manual",
    "source_action": "manual_create"
  },
  "ledger": {
    "visible": true,
    "reversed": false
  },
  "account": {
    "balance_source": "ledger",
    "impacted": true
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Required Error Response

Failed writes must return a clear error and must not partially commit.

```json
{
  "ok": false,
  "action": "transaction_create",
  "contract_version": "transactions-add-v1",
  "error": "Invalid amount",
  "code": "INVALID_AMOUNT",
  "committed": false,
  "warnings": []
}
```

## Idempotency Contract

The Add flow should prevent accidental duplicate entries from:

- double-click
- browser retry
- page refresh
- network timeout
- repeated submit

Preferred request field:

```txt
idempotency_key
```

Expected behavior:

| Scenario | Behavior |
|---|---|
| First request | Commit and return transaction |
| Duplicate same payload/key | Return original transaction result |
| Same key different payload | Reject as idempotency conflict |
| No key | Allow but run duplicate suspicion check |

Duplicate suspicion should compare:

- amount
- account_id
- type
- date
- merchant
- notes
- created within short time window

## Reversal Contract

Normal transactions must be reversible through the canonical ledger reversal flow.

The Add flow does not own reversal logic, but its rows must contain enough data to reverse safely.

A manual transaction reversal must:

1. Keep original transaction row.
2. Mark original as reversed.
3. Insert reversal row.
4. Return reversal proof.
5. Make account balance return correctly through ledger-derived balance.

Manual reversal does not need module repair unless `source_module` is not `manual`.

## Forecast Contract

Forecast must treat manual transactions as account-position changes.

Add Transaction does not write forecast data.

Correct flow:

```txt
transaction inserted
→ account balance changes through ledger
→ forecast reads updated balance
```

Forecast must not require a separate forecast write after transaction creation.

## Audit Contract

Every successful transaction create should be audit-logged.

Audit minimum fields:

- timestamp
- route
- action: `transaction_create`
- source_module: `manual`
- transaction_id
- account_id
- amount
- type
- account_delta
- result: success
- warnings

Failed validation attempts may be audit-logged as rejected attempts, but must not appear as committed money movement.

## Health Check Requirements

Transactions/Add health must verify:

1. Manual transaction rows have valid account IDs.
2. Manual transaction rows have valid positive amounts.
3. Transaction type is allowed.
4. Reversed rows are excluded from active balance.
5. Reversal rows link to originals.
6. Recent Add-created transactions appear in ledger.
7. Account derived balance matches transaction math.
8. No orphan account references exist.
9. Duplicate suspicion count is visible.
10. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "transactions-add-v1",
  "checks": {
    "valid_accounts": true,
    "valid_amounts": true,
    "valid_types": true,
    "reversal_integrity": true,
    "ledger_visibility": true,
    "balance_derivation": true
  },
  "counts": {
    "manual_transactions": 0,
    "orphan_account_transactions": 0,
    "duplicate_suspicions": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- collect form input
- validate required fields before submit
- show loading state
- submit to canonical backend route
- display backend proof
- show success toast
- refresh ledger/accounts/forecast views

Frontend must not:

- calculate authoritative account balance
- write directly to account state
- mark transaction as committed before backend confirms
- hide backend validation errors
- retry blindly without idempotency protection
- call stale routes that bypass the transaction contract

## Required Frontend Submit Shape

Preferred payload:

```json
{
  "action": "create",
  "amount": 1500,
  "account_id": "meezan",
  "type": "expense",
  "date": "2026-05-17",
  "category_id": "food",
  "merchant": "Example Merchant",
  "notes": "[CATCHUP] Missed entry from 2026-05-15",
  "source_module": "manual",
  "source_action": "manual_create",
  "idempotency_key": "client-generated-key"
}
```

If current backend does not support `action`, the route may infer create from POST, but the response must still follow this contract.

## Stale Route Policy

Any stale route that creates transactions must be either:

1. converted into a shim that forwards to the canonical transaction create handler, or
2. removed after frontend no longer calls it.

No stale route may independently implement different transaction math.

## Acceptance Tests

### Test 1: Add expense

Input:

```txt
type = expense
amount = 1000
account = meezan
```

Expected:

```txt
transaction created
account_delta = -1000
ledger shows transaction
accounts balance decreases by 1000
forecast cash_now reflects lower account balance
```

### Test 2: Add income

Input:

```txt
type = income
amount = 5000
account = meezan
```

Expected:

```txt
transaction created
account_delta = +5000
ledger shows transaction
accounts balance increases by 5000
forecast cash_now reflects higher account balance
```

### Test 3: Catch-up historical expense

Input:

```txt
type = expense
amount = 750
date = three days ago
notes = [CATCHUP] Missed entry from YYYY-MM-DD
```

Expected:

```txt
transaction uses supplied date
created_at uses current timestamp
ledger displays historical transaction date
account balance includes transaction
monthly filters respect financial date
```

### Test 4: Invalid amount

Input:

```txt
amount = -500
```

Expected:

```txt
request rejected
no transaction inserted
no account impact
clear error returned
```

### Test 5: Duplicate submit

Input:

```txt
same idempotency_key
same payload
submitted twice
```

Expected:

```txt
only one transaction committed
second response returns original result or duplicate-safe response
```

### Test 6: Manual reversal

Input:

```txt
reverse manual transaction
```

Expected:

```txt
original marked reversed
reversal row inserted
account balance returns correctly
ledger keeps both rows visible when include_reversed is enabled
```

## Implementation Order

1. Confirm current transaction create route.
2. Confirm Add frontend submit route.
3. Align request payload.
4. Align success/error response.
5. Add account impact proof.
6. Add idempotency support or duplicate suspicion warning.
7. Add health/probe output.
8. Verify with acceptance tests.
9. Only then proceed to Accounts contract.

## Non-Negotiable Close Criteria

Transactions/Add is contract-safe only when:

- normal expense works
- normal income works
- historical catch-up works
- invalid amount is rejected
- ledger row appears
- account balance updates through ledger
- forecast reflects updated account position
- reversal works
- duplicate submit does not double-commit
- backend response includes proof

Until these pass, no other page overhaul should take priority over fixing the daily ledger path.
