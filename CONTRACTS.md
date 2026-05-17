# Sovereign Finance Contracts

## Purpose

This document defines the non-negotiable contracts for Sovereign Finance.

The goal is to make the app reliable for daily personal finance usage by ensuring every money action has a clear backend owner, ledger proof, account impact, reversal behavior, audit trail, and forecast visibility.

Pages must not invent financial logic. Frontend pages render backend truth only.

## 0. Global Non-Negotiables

### 0.1 Backend is money truth

All financial totals must come from backend APIs.

Frontend may format, sort, filter, expand, collapse, and display data, but it must not independently calculate authoritative money state such as:

- Account balances
- Paid amount
- Remaining amount
- Forecast totals
- Debt settlement state
- Bill cycle totals
- Reversal state

### 0.2 Ledger is the source of account balances

Account balances must be derived from canonical transactions.

Do not directly mutate account balances from feature modules such as Debts, Bills, Salary, ATM, Credit Cards, or Nano Loans.

Correct flow:

```txt
Money action
→ canonical transaction row
→ account balance derived from ledger
→ module state linked to transaction
→ forecast reads active module/account state
```

### 0.3 Every money movement needs proof

Any action that changes money must return proof in the API response:

- `ok`
- `action`
- `transaction_id` if ledger was changed
- `account_id` if an account was impacted
- `account_delta`
- module entity ID such as `debt_id`, `bill_id`, or `salary_id`
- `audit_id` if audit logging exists
- `warnings`
- `contract_version`

### 0.4 Reversal, not deletion

Money corrections must use reversal rows.

Do not delete financial transaction rows to correct money.

Correct reversal behavior:

```txt
Original transaction remains visible for history
Original transaction is marked reversed
New reversal transaction is inserted
Account balance excludes reversed original and includes valid active rows only
Linked module state is repaired
```

### 0.5 Module state must match ledger state

A module cannot say one thing while the ledger says another.

Examples:

- A debt payment cannot update `paid_amount` without a linked ledger transaction.
- A bill cannot be marked paid without a linked bill payment transaction.
- A salary payout cannot impact account balance without a ledger transaction.
- A reversed ledger row must repair the linked module state.

### 0.6 Forecast is read-only

Forecast must never mutate financial state.

Forecast may read:

- Accounts
- Ledger
- Salary
- Bills
- Debts
- Credit card state
- Reconciliation snapshots
- Budget/goals data

Forecast must not write transactions, debts, bills, account balances, salary settings, or snapshots.

### 0.7 API contracts before UI overhaul

No page should be overhauled before its backend contract is defined.

Correct order:

```txt
Contract
→ backend API
→ health/probe
→ frontend binding
→ UI polish
```

### 0.8 One module owner per action

Each financial action must have one canonical backend owner.

Avoid split-brain logic where multiple files perform the same financial action differently.

Example:

```txt
Debt payment must have one canonical route.
Other routes may call it or forward to it, but must not reimplement different money behavior.
```

### 0.9 Every module needs a health check

Each core module should expose a health/proof endpoint or equivalent probe that verifies its financial consistency.

Minimum health proof:

- row counts
- linked transaction counts
- orphan link counts
- reversed mismatch counts
- active total
- terminal total
- warnings
- contract version

## 1. Money Movement Contract

Any action that moves money must follow this contract.

### 1.1 Required input fields

A money-moving request must identify:

- amount
- account_id
- date or occurred_at
- transaction type
- source module
- source entity ID if module-driven
- notes or description
- idempotency key if available

### 1.2 Valid transaction direction

Transaction type must determine account impact.

Standard account impact:

| Type | Account impact |
|---|---:|
| income | increases account |
| expense | decreases account |
| transfer_in | increases account |
| transfer_out | decreases account |
| adjustment_positive | increases account |
| adjustment_negative | decreases account |

Module routes must not invent new direction logic unless documented in that module contract.

### 1.3 Required output proof

Every money-moving API response must include:

```json
{
  "ok": true,
  "action": "example_action",
  "contract_version": "money-movement-v1",
  "transaction": {
    "created": true,
    "id": "tx_example",
    "type": "income",
    "amount": 1000,
    "account_id": "meezan",
    "account_delta": 1000
  },
  "module": {
    "name": "debts",
    "entity_id": "debt_example"
  },
  "warnings": []
}
```

If no ledger movement happened:

```json
{
  "transaction": {
    "created": false,
    "account_delta": 0
  }
}
```

### 1.4 Idempotency

Money routes should prevent duplicate commits caused by refresh, double-click, retry, or network replay.

Preferred behavior:

- accept an idempotency key
- reject duplicate active submission
- return the original result when safe
- log duplicate suspicion

### 1.5 Date handling

All financial writes must store a stable transaction date.

Rules:

- user-facing date can be local date
- backend must store a canonical timestamp/date
- forecast and monthly close must use the same date basis
- no route should silently use today's date if the user supplied a date

## 2. Ledger Integrity Contract

The ledger is the canonical history of money movement.

### 2.1 Ledger rows

A transaction row should include:

- id
- date / occurred_at
- account_id
- type
- amount
- category_id if applicable
- merchant/payee if applicable
- notes
- source_module
- source_id
- source_action
- reversed flag/status
- reversal_of transaction ID if applicable
- created_at
- updated_at

### 2.2 Active balance calculation

Account balance must include only active financial rows.

Exclude:

- reversed originals
- voided rows
- soft-deleted rows
- non-financial audit/probe rows
- failed/pending writes unless explicitly committed

### 2.3 Reversal behavior

A reversal must:

1. Find the original transaction.
2. Confirm it is not already reversed.
3. Insert a reversal transaction.
4. Mark the original as reversed.
5. Repair linked module state.
6. Return before/after proof.

Required reversal output:

```json
{
  "ok": true,
  "action": "reverse_transaction",
  "original_transaction_id": "tx_original",
  "reversal_transaction_id": "tx_reversal",
  "account_id": "meezan",
  "account_delta": -1000,
  "module_repair": {
    "module": "debts",
    "status": "repaired",
    "entity_id": "debt_example"
  },
  "warnings": []
}
```

### 2.4 Module markers

Module-created transactions must include parseable source linkage.

Preferred structured fields:

- `source_module`
- `source_id`
- `source_action`

Notes may also include human-readable markers:

```txt
[DEBT_ORIGIN] debt_id={debt_id}
[DEBT_PAYMENT] debt_id={debt_id}
[DEBT_RECEIVE] debt_id={debt_id}
[BILL_PAYMENT] bill_id={bill_id} bill_month={YYYY-MM}
[SALARY_PAYOUT] salary_id={salary_id}
```

Markers are not a replacement for structured source fields, but they help with repair, debugging, and audit.

## 3. Audit Contract

Audit is mandatory for financial trust.

### 3.1 Audited actions

Audit should cover:

- transaction create
- transaction edit
- transaction reverse
- account create/update/archive
- debt create/update/payment/reversal/repair
- bill create/update/payment/reversal/archive
- salary contract update
- forecast generation probe
- reconciliation snapshot save
- monthly close
- repair jobs
- admin overrides

### 3.2 Audit row minimum fields

Audit rows should include:

- id
- timestamp
- actor
- route
- action
- source_module
- source_id
- before summary
- after summary
- transaction_id if applicable
- request hash if available
- result status
- warnings/errors

### 3.3 No silent repair

Repair endpoints must be explicit.

A repair route must return:

- what it scanned
- what it changed
- what it skipped
- warnings
- dry-run support if possible

No endpoint should silently normalize money state without proof.

## 4. UI Shell Contract

UI overhaul must preserve the existing shared interface.

### 4.1 No foreign visual systems

Do not inject:

- standalone custom panels
- unrelated page-specific design systems
- second hero cards
- oversized blocks that break the app shell
- one-off visual styles that do not match the shared components

### 4.2 Preferred layout

Use:

- compact toolbar
- thin status strip
- KPI strip
- compact rows/cards
- filter chips
- inline expandable row details
- shared modals
- shared toasts
- shared empty/loading/error states

### 4.3 Frontend responsibility

Frontend may:

- validate required fields before submit
- call backend APIs
- display backend proof
- render compact summaries
- expand details
- show warnings/errors

Frontend must not:

- authoritatively calculate account balances
- authoritatively calculate debt remaining
- authoritatively calculate bill paid/remaining
- invent settlement status
- hide backend errors
- call stale or conflicting API routes

## 5. Accounts Contract

Accounts are balance containers derived from ledger activity.

### 5.1 Source of truth

Account balance must be calculated from canonical active transactions.

### 5.2 Required account API output

Accounts API should return:

- account id
- name
- type
- currency
- active balance
- available balance if applicable
- last transaction date
- warning count
- ledger proof version

### 5.3 Account health checks

Account health must detect:

- transactions with missing account IDs
- transactions linked to archived accounts
- balance mismatch between computed and cached values
- reversed rows incorrectly included
- orphan transfer pairs

## 6. Transactions/Add Contract

Transactions/Add is the emergency-safe daily ledger entry path.

### 6.1 Purpose

The Add Transaction flow must always work, even if module pages are being rebuilt.

### 6.2 Required behavior

Adding a normal transaction must:

1. Validate amount, account, type, and date.
2. Insert canonical transaction.
3. Return account impact proof.
4. Make the transaction visible in ledger.
5. Make account balance update through ledger-derived calculation.
6. Make forecast reflect the updated account position.

### 6.3 Catch-up entries

Missed historical entries should be supported with notes like:

```txt
[CATCHUP] Missed entry from YYYY-MM-DD
```

Catch-up entries are normal ledger transactions unless later linked to a module by an explicit repair flow.

## 7. Debts Contract

Debts must define money owed by the user or owed to the user.

### 7.1 Debt kinds

| Kind | Meaning |
|---|---|
| owe | user owes someone |
| owed | someone owes user |

### 7.2 Add debt without money movement

When adding a debt with no money movement:

- create debt row
- do not create ledger transaction
- do not change account balance
- forecast includes remaining debt/receivable

### 7.3 Add debt with money movement

When `movement_now = true`:

For `owe`:

```txt
User borrowed money
→ debt liability increases
→ ledger income/inflow
→ selected account increases
→ forecast payable increases
```

For `owed`:

```txt
User lent money
→ receivable increases
→ ledger expense/outflow
→ selected account decreases
→ forecast receivable increases
```

Required marker:

```txt
[DEBT_ORIGIN] debt_id={debt_id}
```

### 7.4 Debt payment

For `owe` payment:

```txt
User pays someone back
→ ledger expense
→ account decreases
→ debt paid_amount increases
```

Required marker:

```txt
[DEBT_PAYMENT] debt_id={debt_id}
```

For `owed` receive:

```txt
Someone pays user back
→ ledger income
→ account increases
→ debt paid_amount increases
```

Required marker:

```txt
[DEBT_RECEIVE] debt_id={debt_id}
```

### 7.5 Settlement

When `paid_amount >= original_amount`, debt must become terminal.

Allowed terminal statuses:

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

Default active debt list must filter terminal statuses out.

### 7.6 Debt reversal

Reversing a debt payment must:

- reverse ledger transaction
- reduce debt paid_amount
- reactivate debt if it was settled
- return module repair proof

Reversing a debt origin must:

- reverse ledger transaction
- archive/void linked debt if no payments exist
- block or warn if payments already exist
- never leave account reversed while debt remains falsely active

## 8. Bills Contract

Bills must represent expected obligations and payment cycles.

### 8.1 Bill payment

A bill payment must:

- create ledger transaction
- create bill payment/link row
- update paid amount for the correct cycle
- preserve advance payment behavior
- return cycle proof

Required marker:

```txt
[BILL_PAYMENT] bill_id={bill_id} bill_month={YYYY-MM}
```

### 8.2 Bill reversal

Reversing a bill payment must:

- reverse ledger transaction
- remove or mark reversed linked payment
- restore bill remaining amount for the cycle
- preserve advance payment math

### 8.3 Backend truth

Frontend must not calculate authoritative bill paid/remaining totals.

Backend must return:

- expected
- paid
- remaining
- cycle
- advance status
- linked payment proof

## 9. Salary Contract

Salary must be a source contract for forecast.

### 9.1 Salary output

Salary API should return:

- enabled
- net salary
- gross salary if available
- payday
- payout account
- WFH allowance if applicable
- FX snapshot if applicable
- expected income amount

### 9.2 Salary payout

If salary payout creates money movement, it must create a ledger transaction.

Required marker:

```txt
[SALARY_PAYOUT] salary_id={salary_id}
```

## 10. Forecast Contract

Forecast is a read-only aggregate.

### 10.1 Forecast inputs

Forecast may consume:

- current account balances
- salary expected income
- active bills
- active debts
- receivables
- credit card obligations
- buffers
- goals
- reconciliation warnings

### 10.2 Forecast output

Forecast should return:

- cash_now
- expected_income
- expected_outflow
- projected_end
- active debt payable
- active debt receivable
- bill obligations
- warnings
- source versions

### 10.3 Forecast safety

Forecast must not write financial state.

Forecast errors should not block ledger/account usage.

## 11. Reconciliation Contract

Reconciliation compares declared/manual truth with computed ledger truth.

### 11.1 Snapshot behavior

A snapshot records observed balances at a point in time.

Snapshot must not mutate ledger unless an explicit adjustment transaction is created.

### 11.2 Reconciliation output

Reconciliation should return:

- computed balance
- real/manual balance
- difference
- matched count
- pending count
- exception count
- warnings

## 12. Hub Contract

Hub is a dashboard, not a money owner.

### 12.1 Hub inputs

Hub reads from:

- accounts
- ledger
- bills
- debts
- salary
- forecast
- reconciliation
- health endpoints

### 12.2 Hub output

Hub should show:

- overall health
- cash position
- upcoming obligations
- forecast summary
- reconciliation warnings
- module alerts

### 12.3 Hub safety

Hub must not calculate or mutate money state independently.

Hub only aggregates backend truth.

## 13. Module Contract Checklist

Every module contract must answer:

1. What is the module source of truth?
2. What tables does it read?
3. What tables does it write?
4. Does it create ledger transactions?
5. How does it impact account balance?
6. How does it impact forecast?
7. What is the reversal behavior?
8. What is the audit behavior?
9. What is the health check?
10. What frontend API route is canonical?
11. What stale routes must be removed or converted to shims?
12. What proof must the API return?

## 14. Overhaul Order

The rebuild order must be:

1. Contracts foundation
2. Transactions/Add
3. Accounts
4. Debts
5. Bills
6. Salary
7. Forecast
8. Hub
9. Reconciliation
10. Monthly Close
11. Audit
12. Remaining pages

Do not overhaul all pages at once.

Do not change UI shell before backend contract is stable.

## 15. Daily Usage Rule During Overhaul

The app must remain usable during rebuild.

If module pages are uncertain, daily spending/income should be entered through the canonical Add Transaction path.

Use notes for catch-up entries:

```txt
[CATCHUP] Missed entry from YYYY-MM-DD
```

Module repair/linking can happen later through explicit repair flows.

## 16. Definition of Banking-Grade for Sovereign Finance

Sovereign Finance is banking-grade for personal use when:

- ledger is append-only for money history
- account balances are ledger-derived
- every money movement has proof
- every module write is auditable
- every reversal repairs linked module state
- forecast is read-only
- health checks detect drift
- frontend renders backend truth only
- no module silently corrupts money totals
- no stale route performs conflicting financial logic

This is the standard every overhaul must meet.
