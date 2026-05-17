# Accounts Contract

## Purpose

Accounts are the balance containers of Sovereign Finance.

This contract defines how account balances are calculated, displayed, verified, and protected from corruption.

The core rule is simple:

```txt
Accounts do not own money truth.
Ledger owns money truth.
Accounts display ledger-derived balances.
```

No module should directly mutate account balances as the source of truth.

## Contract Version

`accounts-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/accounts/[[path]].js
```

Supporting balance engine:

```txt
functions/api/accounts/balances.js
```

Canonical frontend owner:

```txt
accounts.html
js/accounts.js
```

If file names differ during implementation, the contract still stands: there must be one canonical accounts API and one frontend consumer path.

## Core Rule

Account balances must be derived from canonical active ledger transactions.

Correct flow:

```txt
Transaction inserted
→ ledger stores money movement
→ accounts API computes balance from active transactions
→ frontend renders backend balance
→ forecast consumes backend account position
```

Frontend must not calculate authoritative account balances.

## Account Source of Truth

The source of truth for account balance is:

```txt
canonical active transactions
```

Accounts table may store metadata such as:

- id
- name
- type
- currency
- institution
- display order
- status
- opening balance reference if supported
- created_at
- updated_at

But account balance itself must be computed from ledger unless a cached balance is explicitly marked as non-authoritative and verified against ledger.

## Supported Account Types

Minimum supported account types:

| Type | Meaning | Normal Balance Behavior |
|---|---|---|
| cash | Physical cash | Positive asset |
| bank | Bank account | Positive asset |
| wallet | Digital wallet | Positive asset |
| savings | Savings account | Positive asset |
| credit_card | Credit card / liability | Liability balance |
| loan | Loan account / liability | Liability balance |
| other | Fallback account type | Must be explicitly handled |

Liability accounts must have documented sign behavior before being used in net worth, forecast, or hub totals.

## Account Status

Supported account statuses:

| Status | Meaning |
|---|---|
| active | Usable in transaction entry |
| archived | Hidden from normal entry but retained for history |
| disabled | Temporarily unavailable |
| deleted | Soft-deleted only; historical transactions remain |

Hard-deleting accounts with transactions is not allowed.

## Required Account API Output

Each account response must include:

```json
{
  "id": "meezan",
  "name": "Meezan",
  "type": "bank",
  "currency": "PKR",
  "status": "active",
  "balance": 10000,
  "balance_source": "ledger",
  "last_transaction_date": "2026-05-17",
  "warnings": [],
  "contract_version": "accounts-v1"
}
```

Required fields:

| Field | Required | Notes |
|---|---:|---|
| id | Yes | Stable account ID |
| name | Yes | Human-readable account name |
| type | Yes | Account type |
| currency | Yes | Account currency |
| status | Yes | Active/archive state |
| balance | Yes | Ledger-derived balance |
| balance_source | Yes | Must be `ledger` for authoritative output |
| last_transaction_date | Preferred | Helps detect stale accounts |
| warnings | Yes | Empty array if no warnings |
| contract_version | Yes | Must identify contract |

## Balance Calculation Rules

### Asset accounts

For asset accounts:

| Transaction Type | Balance Impact |
|---|---:|
| income | +amount |
| expense | -amount |
| transfer_in | +amount |
| transfer_out | -amount |
| adjustment_positive | +amount |
| adjustment_negative | -amount |

### Liability accounts

Liability behavior must be explicit.

Recommended rule:

| Transaction Type | Liability Meaning | Display Impact |
|---|---|---:|
| expense | New liability/spend on credit | increases outstanding |
| income | Payment/refund against liability | decreases outstanding |
| adjustment_positive | Increase liability | increases outstanding |
| adjustment_negative | Decrease liability | decreases outstanding |

Liability accounts should expose both:

```txt
raw_balance
display_balance
```

So UI can clearly show whether the account is an asset or amount owed.

## Opening Balance Rule

Opening balances must not be hidden magic.

If an account starts with an existing balance, it must be represented as one of:

1. an opening balance transaction, or
2. a documented account baseline included in the balance engine with proof.

Preferred approach:

```txt
[OPENING_BALANCE] account_id={account_id}
```

This keeps balances auditable.

## Required Account Summary Output

Accounts summary API should return:

```json
{
  "ok": true,
  "contract_version": "accounts-v1",
  "summary": {
    "asset_total": 100000,
    "liability_total": 25000,
    "net_worth": 75000,
    "liquid_total": 100000,
    "account_count": 4,
    "active_account_count": 3,
    "archived_account_count": 1
  },
  "warnings": []
}
```

Summary rules:

- `asset_total` must include active asset balances.
- `liability_total` must include active liability balances.
- `net_worth = asset_total - liability_total`.
- Archived accounts may be shown separately but must not pollute active operating totals unless explicitly requested.
- Reversed transactions must not affect totals.

## Reversed Transaction Exclusion

Accounts must exclude:

- reversed original rows
- reversal rows marked void/failed
- soft-deleted transactions
- non-financial probe rows
- pending/uncommitted rows

Accounts may include valid active reversal rows when they are the committed offset transaction.

Correct behavior:

```txt
Original expense -1000
Reversal income +1000 or reversal row impact +1000
Net account impact = 0
```

The exact reversal implementation may vary, but the account balance must return correctly.

## Transfers Between Accounts

Transfers must be handled as linked ledger rows.

Correct model:

```txt
transfer_out from source account
transfer_in to destination account
linked_transfer_id shared by both rows
```

A transfer is valid only when:

- both rows exist
- both rows have same absolute amount
- source and destination accounts are different
- both rows share a link ID
- reversal reverses both sides or blocks partial reversal

Single-sided transfers are not allowed as final committed state.

## Account Create Contract

Creating an account must:

1. Validate account name.
2. Validate account type.
3. Validate currency.
4. Create account metadata row.
5. Optionally create opening balance transaction if supplied.
6. Return account proof.

Required success response:

```json
{
  "ok": true,
  "action": "account_create",
  "contract_version": "accounts-v1",
  "account": {
    "id": "meezan",
    "name": "Meezan",
    "type": "bank",
    "currency": "PKR",
    "status": "active",
    "balance": 0,
    "balance_source": "ledger"
  },
  "transaction": {
    "created": false,
    "id": null
  },
  "warnings": []
}
```

If opening balance is supplied:

```json
{
  "transaction": {
    "created": true,
    "id": "tx_opening_balance",
    "marker": "[OPENING_BALANCE] account_id=meezan",
    "account_delta": 10000
  }
}
```

## Account Update Contract

Allowed account metadata updates:

- name
- display order
- institution
- status
- notes
- currency only if no transactions exist or migration is explicit

Not allowed silently:

- changing account ID after transactions exist
- changing account type in a way that changes historical meaning
- changing currency after ledger activity without migration proof
- directly editing computed balance

## Account Archive Contract

Archiving an account must:

1. Keep historical transactions.
2. Hide account from normal transaction entry.
3. Preserve account in historical ledger filters.
4. Exclude or separate it from active operating totals depending on summary mode.
5. Return proof.

Required response:

```json
{
  "ok": true,
  "action": "account_archive",
  "contract_version": "accounts-v1",
  "account_id": "old_account",
  "status": "archived",
  "historical_transactions_preserved": true,
  "warnings": []
}
```

An account with active scheduled bills, debts, salary payout, or pending transfers should return warnings before archive.

## Account Delete Policy

Hard delete is not allowed when transactions exist.

Delete must be soft delete or archive.

Allowed only if:

```txt
account has zero linked transactions
account has no module references
account has no reconciliation snapshots
```

Otherwise:

```txt
archive instead of delete
```

## Forecast Connection

Forecast reads account positions but does not write accounts.

Correct flow:

```txt
ledger changes
→ accounts balance changes
→ forecast reads updated cash_now / liability state
```

Forecast must not recalculate account balances independently if accounts API already provides canonical balance proof.

Forecast should consume:

- liquid cash accounts
- bank accounts
- savings accounts
- wallet accounts
- liability accounts if included in net worth or obligation calculations

## Hub Connection

Hub reads accounts summary.

Hub must not calculate account totals independently unless it is using the same backend account summary payload.

Hub should show:

- cash position
- liquid total
- liability total
- net worth
- account health warnings
- stale account warnings

## Reconciliation Connection

Reconciliation compares:

```txt
manual/real observed balance
vs
ledger-derived account balance
```

Reconciliation must not directly overwrite account balance.

If correction is needed, it must create an explicit adjustment transaction.

Recommended marker:

```txt
[RECON_ADJUSTMENT] account_id={account_id} snapshot_id={snapshot_id}
```

## Audit Contract

Account actions should be audit logged.

Audited account actions:

- account_create
- account_update
- account_archive
- account_restore
- account_delete_rejected
- opening_balance_create
- reconciliation_adjustment

Audit row should include:

- timestamp
- route
- action
- account_id
- before summary
- after summary
- transaction_id if created
- result
- warnings

## Health Check Requirements

Accounts health must verify:

1. All active transactions reference valid accounts.
2. No active transaction references hard-deleted accounts.
3. Archived accounts preserve historical transactions.
4. Computed balances exclude reversed originals.
5. Transfer pairs are complete.
6. No single-sided transfer exists.
7. Opening balances are represented explicitly.
8. Account summary totals match account rows.
9. Liability sign handling is consistent.
10. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "accounts-v1",
  "checks": {
    "valid_transaction_accounts": true,
    "reversed_rows_excluded": true,
    "transfer_pairs_complete": true,
    "summary_matches_rows": true,
    "liability_signs_consistent": true
  },
  "counts": {
    "active_accounts": 0,
    "archived_accounts": 0,
    "orphan_transactions": 0,
    "single_sided_transfers": 0,
    "reversed_mismatches": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render account list
- render account summary
- show balances returned by backend
- show warnings
- open account detail drawer
- call create/update/archive APIs
- refresh after transaction writes

Frontend must not:

- calculate authoritative balances
- mutate cached balances directly
- hide account health warnings
- allow transaction entry into archived accounts
- create fake transfer balance changes
- override liability sign behavior locally

## Required Frontend States

Accounts page must support:

- loading state
- empty state
- error state
- health warning state
- active accounts list
- archived accounts toggle
- account detail expansion
- compact KPI strip

All states must use the shared shell/components and not introduce a separate visual system.

## API Route Policy

Canonical routes should be:

```txt
GET /api/accounts
GET /api/accounts?include_archived=1
GET /api/accounts/summary
POST /api/accounts
PATCH /api/accounts/{id}
POST /api/accounts/{id}/archive
GET /api/accounts/health
```

If current routes differ, stale routes must become shims or be removed after frontend migration.

No stale route may calculate balances differently from the canonical balance engine.

## Acceptance Tests

### Test 1: Expense updates account through ledger

Input:

```txt
create expense 1000 from Meezan
```

Expected:

```txt
transaction row created
Meezan ledger-derived balance decreases by 1000
frontend shows backend balance
forecast reads updated cash position
```

### Test 2: Income updates account through ledger

Input:

```txt
create income 5000 into Meezan
```

Expected:

```txt
transaction row created
Meezan ledger-derived balance increases by 5000
frontend shows backend balance
forecast reads updated cash position
```

### Test 3: Reversal restores balance

Input:

```txt
reverse previous expense
```

Expected:

```txt
original marked reversed
reversal row inserted
account balance returns by 1000
ledger history preserved
```

### Test 4: Archived account cannot receive new manual transaction

Input:

```txt
archive account
try to create transaction against archived account
```

Expected:

```txt
transaction rejected
no ledger row inserted
clear error returned
```

### Test 5: Transfer pair integrity

Input:

```txt
transfer 1000 from Meezan to Cash
```

Expected:

```txt
source transfer_out exists
destination transfer_in exists
linked_transfer_id matches
net worth unchanged
both account balances update correctly
```

### Test 6: Reconciliation adjustment

Input:

```txt
manual balance differs from ledger balance
create reconciliation adjustment
```

Expected:

```txt
adjustment transaction created
account balance changes through ledger
snapshot remains historical proof
```

## Implementation Order

1. Confirm current accounts API routes.
2. Confirm balance engine source.
3. Ensure accounts output includes `balance_source: ledger`.
4. Add account summary proof.
5. Add archived account behavior.
6. Add transfer pair health checks.
7. Add reversed-row exclusion proof.
8. Bind frontend to backend balances only.
9. Verify with acceptance tests.
10. Move to Debts contract only after Accounts passes.

## Non-Negotiable Close Criteria

Accounts are contract-safe only when:

- balances are ledger-derived
- frontend does not calculate authoritative balance
- reversed rows do not corrupt balance
- archived accounts keep history but block new writes
- transfer pairs are complete
- account summary totals match row totals
- forecast reads backend account truth
- hub reads backend account truth
- health endpoint reports contract proof

Until these pass, no module should claim full money correctness.
