# Bills Contract

## Purpose

Bills represent expected obligations, recurring expenses, current-cycle payments, and advance payments.

This contract hardens the full bill money loop:

```txt
Bill action
→ bill state
→ bill payment/link row when paid
→ ledger transaction when money moves
→ account balance derived from ledger
→ forecast reads expected remaining bill obligations
→ reversal repairs bill cycle and ledger together
```

Bills must never become separate from ledger, accounts, and forecast.

## Contract Version

`bills-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/bills/[[path]].js
```

Allowed supporting routes:

```txt
functions/api/bills/[id].js
functions/api/bills/health.js
functions/api/bills/payments.js
```

Canonical frontend owner:

```txt
bills.html
js/bills.js
```

Supporting routes may exist, but they must forward to canonical behavior or share the exact same implementation rules.

## Core Rule

A bill can exist without money movement, but a bill payment must always create ledger/account proof.

Correct flow:

```txt
User creates/updates/pays/reverses bill
→ canonical bills API validates request
→ bills table updates if needed
→ bill_payments row is created when paid
→ ledger transaction is created when money moves
→ accounts reflect ledger-derived balance
→ forecast reads unpaid/remaining bill obligations
```

Frontend must not calculate authoritative bill paid, remaining, cycle status, or account impact.

## Bill Row Minimum Fields

A bill row should include:

- id
- name
- amount
- due_day or due_date
- frequency
- category_id if available
- account_id if default payment account exists
- status
- notes
- created_at
- updated_at
- archived_at if terminal/archived

## Bill Status Vocabulary

Supported active status:

```txt
active
```

Supported inactive statuses:

```txt
archived
deleted
disabled
paused
closed
inactive
```

Default bill list must show active bills only unless `include_inactive=1` or equivalent is supplied.

## Bill Cycle Definition

Bill payment state must be cycle-aware.

A bill cycle should be represented as:

```txt
bill_month = YYYY-MM
```

For monthly bills, `bill_month` is the main cycle key.

For non-monthly bills, backend must still return a stable cycle key and explain the basis in the module response.

## Bill Create Contract

Creating a bill must:

- create bill row
- not create ledger transaction
- not change account balance
- become visible to forecast as an expected obligation
- return bill proof

Preferred request:

```json
{
  "action": "create",
  "name": "Internet",
  "amount": 5000,
  "due_day": 10,
  "frequency": "monthly",
  "category_id": "utilities",
  "account_id": "meezan",
  "notes": "Monthly internet bill",
  "idempotency_key": "client-generated-key"
}
```

Required validation:

- name is present
- amount is positive
- frequency is valid
- due_day or due_date is valid
- account exists if account_id is supplied
- category exists if category is required
- idempotency/duplicate risk is checked when key is supplied

Required response:

```json
{
  "ok": true,
  "action": "bill_create",
  "contract_version": "bills-v1",
  "bill": {
    "id": "bill_example",
    "name": "Internet",
    "amount": 5000,
    "status": "active",
    "frequency": "monthly",
    "due_day": 10
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

## Bill Update Contract

Updating a bill may change metadata such as:

- name
- expected amount
- due day/date
- frequency
- default account
- category
- notes
- status

Updating a bill must not rewrite historical payment rows.

If amount changes, backend must preserve history and apply the new expected amount only to future/current cycles according to the selected rule.

Required response must include:

```json
{
  "ok": true,
  "action": "bill_update",
  "contract_version": "bills-v1",
  "bill_id": "bill_example",
  "warnings": []
}
```

## Bill Payment Contract

A bill payment means money left an account to satisfy a bill cycle.

A successful bill payment must create:

1. canonical transaction row
2. bill payment/link row
3. updated cycle paid/remaining proof
4. audit row if audit exists

Correct impact:

```txt
bill payment
→ ledger expense
→ account decreases
→ bill cycle paid increases
→ cycle remaining decreases
→ forecast expected outflow decreases for that cycle
```

Required marker:

```txt
[BILL_PAYMENT] bill_id={bill_id} bill_month={YYYY-MM}
```

Preferred payment request:

```json
{
  "action": "payment",
  "bill_id": "bill_example",
  "amount": 5000,
  "account_id": "meezan",
  "date": "2026-05-17",
  "bill_month": "2026-05",
  "notes": "Paid May internet bill",
  "idempotency_key": "client-generated-key"
}
```

Required validation:

- bill exists
- bill is active unless paying archived bills is explicitly supported
- amount is positive
- account exists and is active
- date is valid
- bill_month/cycle is valid
- idempotency/duplicate risk is checked
- overpayment is either rejected or handled as advance payment

Required payment response:

```json
{
  "ok": true,
  "action": "bill_payment",
  "contract_version": "bills-v1",
  "bill": {
    "id": "bill_example",
    "name": "Internet",
    "expected_amount": 5000
  },
  "cycle": {
    "bill_month": "2026-05",
    "expected": 5000,
    "paid": 5000,
    "remaining": 0,
    "status": "paid"
  },
  "ledger": {
    "created": true,
    "transaction_id": "tx_bill_payment",
    "type": "expense",
    "amount": 5000,
    "account_id": "meezan",
    "account_delta": -5000,
    "marker": "[BILL_PAYMENT] bill_id=bill_example bill_month=2026-05"
  },
  "payment": {
    "created": true,
    "payment_id": "bill_payment_example"
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Advance Payment Contract

Advance payments are valid and must be cycle-aware.

If the user pays for a future cycle:

```txt
bill_month > current_month
```

Backend must:

- create bill payment row for selected future bill_month
- create ledger expense on actual payment date
- keep current cycle unpaid unless current cycle was also paid
- show future payment in Paid-in-Advance section
- reduce future forecast outflow for that cycle

Example:

```txt
Paid bill in May for June cycle
→ ledger date = May payment date
→ bill_month = June
→ May account balance decreases now
→ June forecast obligation decreases
```

Frontend must not infer advance payment state from dates alone. Backend must return cycle proof.

## Partial Payment Contract

Partial payments are allowed only if backend supports cycle paid/remaining math.

Partial payment behavior:

```txt
expected = 10000
payment = 4000
paid = 4000
remaining = 6000
status = partial
```

Multiple payments in the same cycle must sum correctly.

Frontend must render backend returned totals only.

## Overpayment Contract

Overpayment must be explicit.

Allowed options:

1. reject overpayment
2. treat excess as advance payment to next cycle
3. allow overpaid cycle with warning

Preferred safe default:

```txt
reject overpayment unless user selected advance cycle
```

Backend must never silently hide overpayment.

## Bill Payment Link Row

Each payment row should include:

- id
- bill_id
- transaction_id
- bill_month
- amount
- account_id
- paid_at or date
- status
- notes
- created_at
- reversed_at if reversed

If `bill_payments` table exists, it is the canonical bill-to-ledger link.

## Settlement and Cycle Status

Cycle status should be derived by backend:

| Status | Rule |
|---|---|
| unpaid | paid = 0 |
| partial | paid > 0 and paid < expected |
| paid | paid >= expected |
| advance | bill_month is future and payment exists |
| reversed | all payments for cycle were reversed |

Bill row status and bill cycle status are separate.

A bill can remain `active` even when the current cycle is `paid`.

## Reversal Contract

Bill-linked ledger reversals must repair bill payment state.

When reversing a `[BILL_PAYMENT]` transaction:

Required behavior:

```txt
original payment transaction is reversed
reversal transaction is inserted
linked bill payment row is marked reversed or excluded from active paid total
cycle paid decreases
cycle remaining increases
forecast obligation restores
account balance restores through ledger
```

Required module repair proof:

```json
{
  "module_repair": {
    "module": "bills",
    "action": "reverse_payment",
    "bill_id": "bill_example",
    "bill_month": "2026-05",
    "paid_before": 5000,
    "paid_after": 0,
    "remaining_before": 0,
    "remaining_after": 5000,
    "status_before": "paid",
    "status_after": "unpaid"
  }
}
```

## Forecast Connection

Forecast must read bill obligations from backend truth.

Forecast should consume:

- active bills
- current cycle expected amount
- current cycle paid amount
- current cycle remaining amount
- future/advance payments
- due dates
- disabled/archived status

Forecast must exclude inactive bills by default.

Forecast must not calculate bill paid/remaining from frontend-only state.

## Accounts Connection

Bill APIs must never directly edit account balances.

Correct account impact:

```txt
bill payment
→ transaction row inserted
→ accounts API computes balance from ledger
```

Bill API may return account impact proof, but account balance remains ledger-derived.

## Ledger Connection

Every bill-created ledger row must include:

- transaction id
- account id
- type = expense
- amount
- date
- source_module = bills if column exists
- source_id = bill id if column exists
- source_action = payment
- marker in notes

Required marker:

```txt
[BILL_PAYMENT] bill_id={bill_id} bill_month={YYYY-MM}
```

## Audit Contract

Bill actions should be audit logged.

Audited actions:

- bill_create
- bill_update
- bill_archive
- bill_restore
- bill_payment
- bill_advance_payment
- bill_reverse_payment
- bill_delete_rejected
- bill_repair

Audit minimum fields:

- timestamp
- route
- action
- bill_id
- bill_month if applicable
- transaction_id if created/reversed
- account_id if impacted
- before summary
- after summary
- result
- warnings

## Health Check Requirements

Bills health must verify:

1. Active bills have valid positive amounts.
2. Bill payments reference valid bills.
3. Bill payments reference valid transactions.
4. Payment transaction markers are parseable.
5. Payment transaction amount matches bill payment amount.
6. Reversed transactions are excluded from active paid totals.
7. Current cycle paid/remaining totals are correct.
8. Advance payments are assigned to the correct future cycle.
9. Forecast bill totals match bills backend totals.
10. Archived bills do not pollute active forecast obligations.
11. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "bills-v1",
  "checks": {
    "amounts_valid": true,
    "payments_linked_to_ledger": true,
    "markers_parseable": true,
    "reversed_rows_excluded": true,
    "cycle_totals_valid": true,
    "advance_payments_valid": true,
    "forecast_totals_match": true
  },
  "counts": {
    "active_bills": 0,
    "archived_bills": 0,
    "orphan_payment_rows": 0,
    "orphan_payment_transactions": 0,
    "reversal_mismatches": 0
  },
  "totals": {
    "expected_current_cycle": 0,
    "paid_current_cycle": 0,
    "remaining_current_cycle": 0,
    "advance_paid_total": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render bill list
- render expected/paid/remaining totals returned by backend
- render current cycle status
- render Paid-in-Advance section
- submit create/update/payment requests
- display backend proof
- show warnings
- refresh ledger/accounts/forecast after successful writes

Frontend must not:

- calculate authoritative bill paid totals
- calculate authoritative remaining totals
- invent cycle status
- directly alter account balance
- mark bill paid before backend confirms
- hide failed ledger writes
- call stale payment routes with conflicting behavior
- infer advance payment solely from frontend dates

## Canonical API Routes

Preferred canonical routes:

```txt
GET /api/bills
GET /api/bills?include_inactive=1
POST /api/bills
PATCH /api/bills/{id}
POST /api/bills/{id}/archive
GET /api/bills/health
```

Preferred action-based POSTs to canonical route:

```txt
POST /api/bills
action=create

POST /api/bills
action=payment

POST /api/bills
action=repair_ledger
```

If existing item routes remain, they must forward to canonical logic or share the exact same handler.

No route may implement different payment, cycle, reversal, or ledger rules.

## Required Frontend Submit Shapes

### Create bill

```json
{
  "action": "create",
  "name": "Internet",
  "amount": 5000,
  "due_day": 10,
  "frequency": "monthly",
  "category_id": "utilities",
  "account_id": "meezan",
  "notes": "Monthly internet bill",
  "idempotency_key": "client-generated-key"
}
```

### Pay current cycle

```json
{
  "action": "payment",
  "bill_id": "bill_example",
  "amount": 5000,
  "account_id": "meezan",
  "date": "2026-05-17",
  "bill_month": "2026-05",
  "notes": "Paid current cycle",
  "idempotency_key": "client-generated-key"
}
```

### Pay future cycle

```json
{
  "action": "payment",
  "bill_id": "bill_example",
  "amount": 5000,
  "account_id": "meezan",
  "date": "2026-05-17",
  "bill_month": "2026-06",
  "notes": "Advance payment for June",
  "idempotency_key": "client-generated-key"
}
```

## Stale Route Policy

Any stale bill route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- update paid totals without ledger
- create ledger without bill payment link
- calculate cycle totals differently
- skip advance payment rules
- skip reversal repair requirements
- use different status vocabulary

## Acceptance Tests

### Test 1: Create bill

Input:

```txt
name = Internet
amount = 5000
frequency = monthly
due_day = 10
```

Expected:

```txt
bill row created
no ledger transaction
account balance unchanged
forecast expected outflow increases
```

### Test 2: Pay current cycle bill

Input:

```txt
bill = Internet
amount = 5000
bill_month = current month
account = Meezan
```

Expected:

```txt
ledger expense created
bill payment row created
marker = [BILL_PAYMENT] bill_id=... bill_month=...
Meezan balance decreases by 5000 through ledger
current cycle paid = 5000
current cycle remaining = 0
forecast current obligation decreases
```

### Test 3: Partial bill payment

Input:

```txt
expected = 10000
payment = 4000
```

Expected:

```txt
cycle paid = 4000
cycle remaining = 6000
cycle status = partial
account decreases by 4000
```

### Test 4: Advance payment

Input:

```txt
pay June bill in May
bill_month = 2026-06
payment date = 2026-05-17
```

Expected:

```txt
ledger date is May payment date
bill payment cycle is June
May account balance decreases now
June forecast obligation decreases
Paid-in-Advance section shows payment
current cycle remains unchanged unless separately paid
```

### Test 5: Reject unsafe overpayment

Input:

```txt
expected = 5000
current cycle payment = 7000
no advance cycle selected
```

Expected:

```txt
request rejected or warning requires explicit advance handling
no silent hidden overpayment
```

### Test 6: Reverse bill payment

Input:

```txt
reverse [BILL_PAYMENT] transaction
```

Expected:

```txt
ledger reversal succeeds
account balance restores
bill payment row marked reversed or excluded
cycle paid decreases
cycle remaining increases
forecast obligation restores
health reports no reversal mismatch
```

### Test 7: Archived bill excluded

Input:

```txt
bill status = archived
```

Expected:

```txt
default /api/bills hides it
/api/bills?include_inactive=1 shows it
forecast excludes it from active obligations
historical payment rows remain visible
```

### Test 8: Cycle math backend truth

Input:

```txt
multiple payments in same bill_month
```

Expected:

```txt
backend returns expected, paid, remaining
frontend displays backend totals only
no frontend recalculation required
```

## Implementation Order

1. Confirm current bill table columns.
2. Confirm `bill_payments` table columns and `bill_month`.
3. Confirm canonical `/api/bills` route.
4. Keep current-cycle math backend-owned.
5. Keep advance-payment handling backend-owned.
6. Ensure payment writes ledger marker and link row.
7. Ensure payment response includes cycle proof.
8. Ensure reversal repair restores bill cycle totals.
9. Align frontend to canonical route only.
10. Add or strengthen health/proof output.
11. Run acceptance tests before moving to Salary.

## Non-Negotiable Close Criteria

Bills are contract-safe only when:

- bill create does not touch accounts
- bill payment creates ledger/account impact correctly
- payment rows link to ledger rows
- all bill ledger rows have parseable bill linkage
- current cycle math is backend truth
- advance payments are cycle-aware
- reversed payments restore bill remaining
- forecast bill totals match backend bill totals
- frontend calls only canonical bill API behavior
- health endpoint reports no orphan/mismatch issues

Until these pass, Bills cannot be called banking-grade.
