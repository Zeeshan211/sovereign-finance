# Debts Contract

## Purpose

Debts define money the user owes to others or money others owe to the user.

This contract hardens the full debt money loop:

```txt
Debt action
→ debt state
→ ledger transaction when money moves
→ account balance derived from ledger
→ forecast reads remaining debt/receivable
→ reversal repairs debt and ledger together
```

Debts must never become a separate money universe from ledger and accounts.

## Contract Version

`debts-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/debts/[[path]].js
```

Supporting routes may exist, but they must not implement conflicting debt money behavior.

Allowed supporting routes:

```txt
functions/api/debts/[id].js
functions/api/debts/health.js
functions/api/debts/payments.js
functions/api/debts/repair.js
```

Canonical frontend owner:

```txt
debts.html
js/debts.js
```

## Core Rule

Debt state and ledger state must always agree.

Correct flow:

```txt
User creates/pays/reverses debt
→ canonical debts API validates request
→ debts table updates
→ ledger row is created if money moved
→ debt-payment/origin linkage is stored
→ accounts reflect ledger-derived balance
→ forecast reads active remaining debt only
```

Frontend must not calculate authoritative debt remaining, settlement status, account impact, or forecast impact.

## Debt Kinds

| Kind | Meaning |
|---|---|
| owe | User owes someone else |
| owed | Someone else owes the user |

## Debt Status Vocabulary

Supported active status:

```txt
active
```

Supported terminal statuses:

```txt
settled
archived
closed
deleted
paid
finished
completed
done
```

Default debt lists must filter terminal statuses out.

Correct active filter:

```txt
status IS NULL
OR TRIM(status) = ''
OR LOWER(TRIM(status)) NOT IN terminal_statuses
```

Do not filter only by `status = active`, because historical data may contain valid terminal words like `closed`.

## Debt Row Minimum Fields

A debt row should include:

- id
- name
- kind
- original_amount
- paid_amount
- remaining_amount computed or returned
- status
- account_id if origin money moved
- origin_transaction_id if origin money moved
- notes
- created_at
- updated_at
- settled_at if terminal

If the database does not store `remaining_amount`, backend must compute it as:

```txt
remaining_amount = max(0, original_amount - paid_amount)
```

## Add Debt Without Money Movement

When creating a debt with no immediate money movement:

```txt
movement_now = false
```

Required behavior:

- create debt row
- do not create ledger transaction
- do not change account balance
- forecast includes remaining debt or receivable
- return proof that ledger was not changed

Expected response shape:

```json
{
  "ok": true,
  "action": "debt_create",
  "contract_version": "debts-v1",
  "debt": {
    "id": "debt_example",
    "kind": "owe",
    "original_amount": 10000,
    "paid_amount": 0,
    "remaining_amount": 10000,
    "status": "active"
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

## Add Debt With Money Movement

When creating a debt with immediate money movement:

```txt
movement_now = true
```

The backend must create both:

1. debt row
2. linked ledger transaction

### If `kind = owe`

Meaning:

```txt
User borrowed money and now owes someone.
```

Correct impact:

```txt
debt liability increases
ledger income/inflow is created
selected account increases
forecast payable increases
```

Example:

```txt
Borrow Rs 10,000 from Imran into Meezan
→ debt original_amount = 10000
→ ledger type = income
→ account_delta = +10000
```

Required marker:

```txt
[DEBT_ORIGIN] debt_id={debt_id}
```

### If `kind = owed`

Meaning:

```txt
User lent money and someone now owes the user.
```

Correct impact:

```txt
receivable increases
ledger expense/outflow is created
selected account decreases
forecast receivable increases
```

Example:

```txt
Give Rs 5,000 to Yusra from Meezan
→ debt original_amount = 5000
→ ledger type = expense
→ account_delta = -5000
```

Required marker:

```txt
[DEBT_ORIGIN] debt_id={debt_id}
```

## Required Add Debt Request

Preferred payload:

```json
{
  "action": "create",
  "name": "Imran",
  "kind": "owe",
  "original_amount": 10000,
  "paid_amount": 0,
  "movement_now": true,
  "account_id": "meezan",
  "movement_date": "2026-05-17",
  "notes": "Borrowed cash",
  "idempotency_key": "client-generated-key"
}
```

Required validation:

- name is present
- kind is `owe` or `owed`
- original_amount is positive
- paid_amount is zero or positive
- paid_amount does not exceed original_amount unless explicitly allowed as overpayment
- account_id is required if `movement_now = true`
- movement_date is required if `movement_now = true`
- account is active if money movement is requested
- idempotency/duplicate risk is checked when key is supplied

## Required Add Debt Response With Movement

```json
{
  "ok": true,
  "action": "debt_create",
  "contract_version": "debts-v1",
  "debt": {
    "id": "debt_example",
    "kind": "owe",
    "original_amount": 10000,
    "paid_amount": 0,
    "remaining_amount": 10000,
    "status": "active"
  },
  "ledger": {
    "created": true,
    "transaction_id": "tx_debt_origin",
    "type": "income",
    "amount": 10000,
    "account_id": "meezan",
    "account_delta": 10000,
    "marker": "[DEBT_ORIGIN] debt_id=debt_example"
  },
  "account": {
    "balance_source": "ledger",
    "impacted": true
  },
  "forecast": {
    "should_reflect": true,
    "debt_bucket": "payable"
  },
  "warnings": []
}
```

## Debt Payment Contract

Debt payment means reducing remaining debt.

### Paying an `owe` debt

Meaning:

```txt
User pays someone back.
```

Correct behavior:

```txt
ledger expense
account decreases
debt paid_amount increases
remaining_amount decreases
```

Required marker:

```txt
[DEBT_PAYMENT] debt_id={debt_id}
```

### Receiving payment on an `owed` debt

Meaning:

```txt
Someone pays the user back.
```

Correct behavior:

```txt
ledger income
account increases
debt paid_amount increases
remaining_amount decreases
```

Required marker:

```txt
[DEBT_RECEIVE] debt_id={debt_id}
```

## Required Payment Request

Preferred payload:

```json
{
  "action": "payment",
  "debt_id": "debt_example",
  "amount": 2500,
  "account_id": "meezan",
  "date": "2026-05-17",
  "notes": "Partial payment",
  "idempotency_key": "client-generated-key"
}
```

Required validation:

- debt exists
- debt is not terminal unless reopening is explicit
- amount is positive
- amount does not exceed remaining amount unless overpayment is explicitly supported
- account exists and is active
- date is valid
- idempotency/duplicate risk is checked

## Required Payment Write Behavior

A successful debt payment must write:

1. canonical transaction row
2. debt payment/link row if table exists
3. updated debt `paid_amount`
4. terminal status if remaining amount reaches zero
5. audit row if audit exists

The transaction must contain structured source fields where available:

```txt
source_module = debts
source_id = {debt_id}
source_action = payment
```

And must include marker text:

```txt
[DEBT_PAYMENT] debt_id={debt_id}
```

or

```txt
[DEBT_RECEIVE] debt_id={debt_id}
```

## Required Payment Response

```json
{
  "ok": true,
  "action": "debt_payment",
  "contract_version": "debts-v1",
  "debt": {
    "id": "debt_example",
    "kind": "owe",
    "original_amount": 10000,
    "paid_amount": 2500,
    "remaining_amount": 7500,
    "status": "active"
  },
  "ledger": {
    "created": true,
    "transaction_id": "tx_debt_payment",
    "type": "expense",
    "amount": 2500,
    "account_id": "meezan",
    "account_delta": -2500,
    "marker": "[DEBT_PAYMENT] debt_id=debt_example"
  },
  "payment": {
    "created": true,
    "payment_id": "payment_example"
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Settlement Rule

When:

```txt
paid_amount >= original_amount
```

Backend must mark debt terminal.

Preferred terminal status:

```txt
settled
```

Required behavior:

- default debt list hides it
- `include_inactive=1` or equivalent can show it
- forecast excludes it from active payable/receivable totals
- ledger history remains visible
- reversal can reactivate it if a payment is reversed

## Reversal Contract

Debt-linked ledger reversals must repair debt state.

### Reverse debt payment

When reversing a `[DEBT_PAYMENT]` or `[DEBT_RECEIVE]` transaction:

Required behavior:

```txt
original payment transaction is reversed
reversal transaction is inserted
debt paid_amount decreases
remaining_amount increases
settled debt becomes active again if needed
payment/link row is marked reversed if table supports it
```

Required module repair proof:

```json
{
  "module_repair": {
    "module": "debts",
    "action": "reverse_payment",
    "debt_id": "debt_example",
    "paid_amount_before": 10000,
    "paid_amount_after": 7500,
    "status_before": "settled",
    "status_after": "active"
  }
}
```

### Reverse debt origin

When reversing a `[DEBT_ORIGIN]` transaction:

If no payments exist:

```txt
reverse origin ledger transaction
archive or void linked debt
forecast excludes linked debt
```

If payments exist:

```txt
block reversal or return high-severity warning
require payment reversals first
do not leave account reversed while debt remains falsely active
```

Required response if blocked:

```json
{
  "ok": false,
  "action": "reverse_debt_origin",
  "contract_version": "debts-v1",
  "code": "DEBT_ORIGIN_HAS_PAYMENTS",
  "error": "Reverse debt payments before reversing the debt origin transaction.",
  "committed": false,
  "warnings": [
    "Origin reversal blocked because linked payments exist."
  ]
}
```

## Forecast Connection

Forecast must read active debt truth from backend.

Forecast must include:

| Debt kind | Forecast bucket |
|---|---|
| owe | payable / future outflow |
| owed | receivable / future inflow |

Forecast must exclude terminal debts by default.

Forecast should use:

```txt
remaining_amount = max(0, original_amount - paid_amount)
```

Forecast must not independently decide debt settlement status using frontend-only math.

## Accounts Connection

Debt APIs must never directly edit account balances.

Correct account impact:

```txt
debt creates or pays money movement
→ transaction row inserted
→ accounts API computes balance from ledger
```

Debt API may return account impact proof, but account balance remains ledger-derived.

## Ledger Connection

Every debt-created ledger row must include:

- transaction id
- account id
- type
- amount
- date
- source_module = debts if column exists
- source_id = debt id if column exists
- source_action
- marker in notes

Required markers:

```txt
[DEBT_ORIGIN] debt_id={debt_id}
[DEBT_PAYMENT] debt_id={debt_id}
[DEBT_RECEIVE] debt_id={debt_id}
```

## Audit Contract

Debt actions should be audit logged.

Audited actions:

- debt_create
- debt_create_with_origin
- debt_update
- debt_payment
- debt_receive
- debt_settle
- debt_archive
- debt_reverse_payment
- debt_reverse_origin
- debt_repair
- debt_delete_rejected

Audit minimum fields:

- timestamp
- route
- action
- debt_id
- transaction_id if created/reversed
- account_id if impacted
- before summary
- after summary
- result
- warnings

## Health Check Requirements

Debts health must verify:

1. Active debts have valid amounts.
2. `paid_amount` is not negative.
3. `remaining_amount` is not negative.
4. Fully paid debts are terminal or flagged.
5. Terminal debts are excluded from default active totals.
6. Debt payment transactions have debt markers or structured source links.
7. Debt origin transactions have debt markers or structured source links.
8. Payment/link rows match ledger rows where table exists.
9. Reversed debt payment rows have repaired debt paid_amount.
10. Reversed debt origin rows do not leave false active debts.
11. Forecast active debt totals match debts backend totals.
12. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "debts-v1",
  "checks": {
    "amounts_valid": true,
    "terminal_filter_valid": true,
    "payments_linked_to_ledger": true,
    "origins_linked_to_ledger": true,
    "reversal_repairs_valid": true,
    "forecast_totals_match": true
  },
  "counts": {
    "active_debts": 0,
    "terminal_debts": 0,
    "fully_paid_active_debts": 0,
    "orphan_payment_transactions": 0,
    "orphan_origin_transactions": 0,
    "reversal_mismatches": 0
  },
  "totals": {
    "payable_remaining": 0,
    "receivable_remaining": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render debt list
- render payable/receivable totals returned by backend
- submit create/payment/update requests
- display backend proof
- show warnings
- refresh ledger/accounts/forecast after successful writes

Frontend must not:

- calculate authoritative debt remaining
- invent settlement status
- directly alter account balance
- mark debt paid before backend confirms
- hide failed ledger writes
- call stale payment routes with conflicting behavior
- use different request shapes for the same action

## Canonical API Routes

Preferred canonical routes:

```txt
GET /api/debts
GET /api/debts?include_inactive=1
POST /api/debts
PATCH /api/debts/{id}
POST /api/debts/{id}/archive
GET /api/debts/health
```

Preferred action-based POSTs to canonical route:

```txt
POST /api/debts
action=create

POST /api/debts
action=payment

POST /api/debts
action=repair_ledger
```

If existing item routes remain, they must forward to canonical logic or share the exact same handler.

No route may implement different payment, settlement, or ledger rules.

## Stale Route Policy

Any stale debt route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- update `paid_amount` without ledger
- create ledger without debt link
- use different status vocabulary
- calculate account impact differently
- skip reversal repair requirements

## Required Frontend Submit Shapes

### Create debt without movement

```json
{
  "action": "create",
  "name": "Imran",
  "kind": "owe",
  "original_amount": 10000,
  "movement_now": false,
  "notes": "Manual debt record",
  "idempotency_key": "client-generated-key"
}
```

### Create debt with movement

```json
{
  "action": "create",
  "name": "Imran",
  "kind": "owe",
  "original_amount": 10000,
  "movement_now": true,
  "account_id": "meezan",
  "movement_date": "2026-05-17",
  "notes": "Borrowed into Meezan",
  "idempotency_key": "client-generated-key"
}
```

### Pay debt

```json
{
  "action": "payment",
  "debt_id": "debt_example",
  "amount": 2500,
  "account_id": "meezan",
  "date": "2026-05-17",
  "notes": "Partial payment",
  "idempotency_key": "client-generated-key"
}
```

## Acceptance Tests

### Test 1: Add `owe` debt without movement

Input:

```txt
kind = owe
amount = 10000
movement_now = false
```

Expected:

```txt
debt row created
no ledger transaction
account balance unchanged
forecast payable increases by 10000
```

### Test 2: Add `owe` debt with movement

Input:

```txt
kind = owe
amount = 10000
movement_now = true
account = Meezan
```

Expected:

```txt
debt row created
ledger income created
marker = [DEBT_ORIGIN] debt_id=...
Meezan balance increases by 10000 through ledger
forecast payable increases by 10000
```

### Test 3: Add `owed` debt with movement

Input:

```txt
kind = owed
amount = 5000
movement_now = true
account = Meezan
```

Expected:

```txt
debt row created
ledger expense created
marker = [DEBT_ORIGIN] debt_id=...
Meezan balance decreases by 5000 through ledger
forecast receivable increases by 5000
```

### Test 4: Pay `owe` debt

Input:

```txt
pay 2500 against owe debt
```

Expected:

```txt
ledger expense created
marker = [DEBT_PAYMENT] debt_id=...
account decreases by 2500
paid_amount increases by 2500
remaining_amount decreases by 2500
```

### Test 5: Receive `owed` debt

Input:

```txt
receive 2500 against owed debt
```

Expected:

```txt
ledger income created
marker = [DEBT_RECEIVE] debt_id=...
account increases by 2500
paid_amount increases by 2500
remaining_amount decreases by 2500
```

### Test 6: Full settlement

Input:

```txt
pay remaining amount
```

Expected:

```txt
paid_amount equals original_amount
remaining_amount = 0
status = settled
default active list hides debt
include_inactive shows debt
forecast excludes debt from active totals
```

### Test 7: Reverse debt payment

Input:

```txt
reverse [DEBT_PAYMENT] transaction
```

Expected:

```txt
ledger reversal succeeds
account balance restores
paid_amount decreases
debt becomes active if previously settled
health reports no reversal mismatch
```

### Test 8: Reverse unpaid debt origin

Input:

```txt
reverse [DEBT_ORIGIN] transaction with no payments
```

Expected:

```txt
ledger reversal succeeds
account balance restores
linked debt archived or voided
forecast excludes debt
```

### Test 9: Block paid debt origin reversal

Input:

```txt
reverse [DEBT_ORIGIN] transaction after payments exist
```

Expected:

```txt
request blocked or high-severity warning returned
no partial commit
user must reverse payments first
```

### Test 10: Terminal status filtering

Input:

```txt
debt status = closed
paid_amount = original_amount
```

Expected:

```txt
default /api/debts hides it
/api/debts?include_inactive=1 shows it
forecast excludes it
```

## Implementation Order

1. Confirm current debt table columns.
2. Confirm canonical `/api/debts` route.
3. Centralize terminal status filtering.
4. Make create debt response contract-compliant.
5. Add create-with-origin ledger behavior.
6. Add canonical payment behavior.
7. Ensure payment writes marker and link row.
8. Ensure full settlement marks terminal.
9. Align frontend to canonical route only.
10. Add reversal repair for debt payment.
11. Add reversal handling/blocking for debt origin.
12. Add health/proof output.
13. Run acceptance tests before moving to Bills.

## Non-Negotiable Close Criteria

Debts are contract-safe only when:

- `owe` and `owed` meanings are correct
- debt create without movement does not touch accounts
- debt create with movement creates ledger/account impact correctly
- debt payment creates ledger/account impact correctly
- all debt ledger rows have parseable debt linkage
- fully paid debts become terminal
- terminal debts are hidden from active totals
- reversals repair debt state
- forecast totals match active remaining debt
- frontend calls only canonical debt API behavior
- health endpoint reports no orphan/mismatch issues

Until these pass, Debts cannot be called banking-grade.
