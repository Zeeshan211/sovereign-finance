# Credit Cards Contract

## Purpose

Credit Cards represent liability-based spending, payments, limits, statement cycles, and repayment obligations in Sovereign Finance.

This contract hardens the credit card loop:

```txt
Credit card spend
→ liability increases
→ ledger records card transaction
→ repayment decreases cash account and card liability
→ forecast reads upcoming payment obligation
→ reversal repairs both sides
```

Credit Cards must not become a separate money system from ledger, accounts, bills, forecast, and reconciliation.

## Contract Version

`credit-cards-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/cc.js
```

Allowed supporting routes:

```txt
functions/api/cc/health.js
functions/api/cc/payments.js
functions/api/cc/statements.js
```

Canonical frontend owner:

```txt
cc.html
js/cc.js
```

If filenames differ during implementation, the rule still stands: credit card state must be backend-owned and ledger-linked.

## Core Rule

Credit card balance must be treated as a liability.

Correct flow:

```txt
User records credit card spend
→ ledger records liability-side expense/card charge
→ credit card outstanding increases
→ account/cash balance does not decrease immediately unless paid from cash
→ forecast includes repayment obligation

User records credit card payment
→ cash/bank account decreases
→ credit card outstanding decreases
→ ledger links both sides
```

Frontend must not calculate authoritative card outstanding, available credit, statement balance, or repayment impact.

## Credit Card Account Model

A credit card should be represented as either:

1. an account with type `credit_card`, or
2. a dedicated credit card entity linked to a liability account.

Required fields:

- id
- name
- account_id or liability_account_id
- limit
- currency
- statement_day
- due_day
- status
- created_at
- updated_at

## Credit Card Status Vocabulary

Supported statuses:

```txt
active
paused
archived
closed
deleted
```

Default list must show active cards only unless `include_inactive=1`.

## Card Spend Contract

Card spend means the user purchased something using credit.

Correct impact:

```txt
credit card outstanding increases
cash account does not decrease immediately
ledger records expense/card liability movement
forecast repayment obligation increases
```

Preferred request:

```json
{
  "action": "card_spend",
  "card_id": "cc_hbl",
  "amount": 2500,
  "date": "2026-05-17",
  "category_id": "food",
  "merchant": "Example Merchant",
  "notes": "Dinner",
  "idempotency_key": "client-generated-key"
}
```

Required marker:

```txt
[CC_SPEND] card_id={card_id}
```

Required response:

```json
{
  "ok": true,
  "action": "card_spend",
  "contract_version": "credit-cards-v1",
  "card": {
    "id": "cc_hbl",
    "outstanding_delta": 2500,
    "available_credit_delta": -2500
  },
  "ledger": {
    "created": true,
    "transaction_id": "tx_cc_spend",
    "type": "expense",
    "amount": 2500,
    "marker": "[CC_SPEND] card_id=cc_hbl"
  },
  "forecast": {
    "should_reflect": true
  },
  "warnings": []
}
```

## Card Payment Contract

Card payment means cash leaves a bank/wallet account to reduce credit card liability.

Correct impact:

```txt
cash/bank account decreases
credit card outstanding decreases
available credit increases
forecast repayment obligation decreases
```

Preferred request:

```json
{
  "action": "card_payment",
  "card_id": "cc_hbl",
  "from_account_id": "meezan",
  "amount": 10000,
  "date": "2026-05-17",
  "notes": "Credit card payment",
  "idempotency_key": "client-generated-key"
}
```

Required marker:

```txt
[CC_PAYMENT] card_id={card_id} from_account_id={account_id}
```

Required response:

```json
{
  "ok": true,
  "action": "card_payment",
  "contract_version": "credit-cards-v1",
  "card": {
    "id": "cc_hbl",
    "outstanding_delta": -10000,
    "available_credit_delta": 10000
  },
  "ledger": {
    "created": true,
    "transaction_id": "tx_cc_payment",
    "type": "expense",
    "amount": 10000,
    "account_id": "meezan",
    "account_delta": -10000,
    "marker": "[CC_PAYMENT] card_id=cc_hbl from_account_id=meezan"
  },
  "warnings": []
}
```

## Limit and Available Credit Rules

Backend must calculate:

```txt
available_credit = credit_limit - outstanding_balance
```

Rules:

- outstanding balance must be backend-owned
- available credit must be backend-owned
- frontend must not silently override limit math
- over-limit state must return warning

Warning example:

```json
{
  "severity": "warning",
  "code": "CARD_OVER_LIMIT",
  "message": "Credit card outstanding exceeds configured limit."
}
```

## Statement Cycle Contract

Credit card statements should be cycle-aware.

Minimum statement fields:

- card_id
- statement_month
- statement_start
- statement_end
- due_date
- statement_balance
- paid_amount
- remaining_amount
- status

Supported statement statuses:

```txt
open
generated
partial
paid
overdue
reversed
```

Backend must return statement proof. Frontend must not invent statement state.

## Forecast Connection

Forecast should include credit card repayment obligation.

Forecast may consume:

- current outstanding balance
- statement balance
- due date
- minimum payment if supported
- full payment target if configured
- overdue status

Default safe rule:

```txt
expected_outflow includes credit card payment obligation by due date
```

Forecast must not create card payment transactions.

## Accounts Connection

Credit card payment impacts cash/bank account through ledger.

Credit card spend should not reduce cash account immediately unless explicitly modeled as instant settlement.

Accounts must remain ledger-derived.

## Ledger Connection

Every card-created ledger row must include:

```txt
[CC_SPEND] card_id={card_id}
[CC_PAYMENT] card_id={card_id} from_account_id={account_id}
[CC_FEE] card_id={card_id}
[CC_INTEREST] card_id={card_id}
```

Structured fields where supported:

- source_module = `credit_cards`
- source_id = card id
- source_action = spend/payment/fee/interest

## Reversal Contract

### Reverse card spend

Required behavior:

```txt
original spend transaction reversed
card outstanding decreases
available credit increases
forecast obligation decreases
```

### Reverse card payment

Required behavior:

```txt
payment transaction reversed
cash account restores through ledger
card outstanding increases
available credit decreases
forecast obligation restores
```

Required module repair proof:

```json
{
  "module_repair": {
    "module": "credit_cards",
    "action": "reverse_card_payment",
    "card_id": "cc_hbl",
    "outstanding_before": 15000,
    "outstanding_after": 25000
  }
}
```

## Audit Contract

Audited actions:

- card_create
- card_update
- card_archive
- card_spend
- card_payment
- card_fee
- card_interest
- card_statement_generate
- card_reverse_spend
- card_reverse_payment

Audit minimum fields:

- timestamp
- route
- action
- card_id
- transaction_id if created/reversed
- account_id if cash account impacted
- amount
- before summary
- after summary
- result
- warnings

## Health Check Requirements

Credit Cards health must verify:

1. Card outstanding balance is computable.
2. Card payments reference valid cash accounts.
3. Card spend rows have parseable markers.
4. Card payment rows have parseable markers.
5. Reversed card spend repairs outstanding.
6. Reversed card payment repairs outstanding.
7. Available credit equals limit minus outstanding.
8. Over-limit cards are flagged.
9. Statement totals match card ledger rows.
10. Forecast obligation matches backend card state.
11. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "credit-cards-v1",
  "checks": {
    "outstanding_valid": true,
    "payment_accounts_valid": true,
    "markers_parseable": true,
    "reversal_repairs_valid": true,
    "available_credit_valid": true,
    "statement_totals_valid": true,
    "forecast_matches_cards": true
  },
  "counts": {
    "active_cards": 0,
    "archived_cards": 0,
    "orphan_card_transactions": 0,
    "reversal_mismatches": 0,
    "over_limit_cards": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render cards
- render outstanding balance returned by backend
- render available credit returned by backend
- submit card spend
- submit card payment
- render statement cycles
- show warnings

Frontend must not:

- calculate authoritative outstanding balance
- calculate authoritative available credit
- directly mutate cash account balance
- mark card payment complete before backend confirms
- hide over-limit warnings
- hide reversal mismatch warnings

## Canonical API Routes

Preferred routes:

```txt
GET /api/cc
GET /api/cc?include_inactive=1
POST /api/cc
PATCH /api/cc/{id}
POST /api/cc/{id}/archive
GET /api/cc/health
```

Preferred action-based POSTs:

```txt
POST /api/cc
action=card_spend

POST /api/cc
action=card_payment

POST /api/cc
action=generate_statement
```

## Required Frontend Submit Shapes

### Card spend

```json
{
  "action": "card_spend",
  "card_id": "cc_hbl",
  "amount": 2500,
  "date": "2026-05-17",
  "category_id": "food",
  "merchant": "Example Merchant",
  "notes": "Dinner",
  "idempotency_key": "client-generated-key"
}
```

### Card payment

```json
{
  "action": "card_payment",
  "card_id": "cc_hbl",
  "from_account_id": "meezan",
  "amount": 10000,
  "date": "2026-05-17",
  "notes": "Credit card payment",
  "idempotency_key": "client-generated-key"
}
```

## Stale Route Policy

Any stale credit card route must become:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- calculate outstanding differently
- mutate account balances directly
- skip ledger markers
- skip reversal repair
- skip audit/proof response

## Acceptance Tests

### Test 1: Card spend

Input:

```txt
card spend = 2500
card = HBL
```

Expected:

```txt
ledger row created
marker = [CC_SPEND] card_id=...
card outstanding increases by 2500
cash account unchanged
forecast repayment obligation increases
```

### Test 2: Card payment

Input:

```txt
payment = 10000
from_account = Meezan
```

Expected:

```txt
ledger row created
marker = [CC_PAYMENT] card_id=...
Meezan balance decreases by 10000 through ledger
card outstanding decreases by 10000
forecast obligation decreases
```

### Test 3: Over-limit warning

Input:

```txt
outstanding > card limit
```

Expected:

```txt
backend returns CARD_OVER_LIMIT warning
frontend shows warning
```

### Test 4: Reverse card spend

Input:

```txt
reverse [CC_SPEND]
```

Expected:

```txt
ledger reversal succeeds
card outstanding decreases
available credit restores
```

### Test 5: Reverse card payment

Input:

```txt
reverse [CC_PAYMENT]
```

Expected:

```txt
cash account restores
card outstanding increases
available credit decreases
```

### Test 6: Statement cycle

Input:

```txt
statement generated for month
```

Expected:

```txt
statement balance equals backend card transaction totals
due date returned
frontend renders backend statement proof
```

## Implementation Order

1. Confirm current `cc.html`, `js/cc.js`, and `/api/cc` behavior.
2. Confirm whether credit cards are accounts or separate entities.
3. Define backend outstanding calculation.
4. Add spend/payment proof responses.
5. Add ledger markers.
6. Add reversal repair.
7. Add forecast obligation read model.
8. Add health/proof endpoint.
9. Align frontend to backend truth.
10. Run acceptance tests before moving to Health/Sanity.

## Non-Negotiable Close Criteria

Credit Cards are contract-safe only when:

- outstanding is backend-owned
- card spend does not reduce cash account immediately
- card payment reduces cash and card liability correctly
- all card ledger rows have parseable markers
- reversals repair card state
- available credit is backend-calculated
- forecast reads card obligation from backend
- frontend renders backend truth only
- health reports no orphan/mismatch issues
- contract version is reported

Until these pass, Credit Cards cannot be considered banking-grade.
