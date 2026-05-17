# Reconciliation Contract

## Purpose

Reconciliation compares real-world observed balances against Sovereign Finance ledger-derived balances.

This contract hardens the reconciliation loop:

```txt
Manual / real balance snapshot
→ compare against ledger-derived account balance
→ detect drift
→ report matched / pending / exception state
→ correction happens only through explicit adjustment transaction
```

Reconciliation must never silently overwrite accounts, ledger, debts, bills, salary, or forecast.

## Contract Version

`reconciliation-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/reconciliation.js
```

Allowed supporting routes:

```txt
functions/api/reconciliation/health.js
functions/api/reconciliation/snapshots.js
```

Canonical frontend owner:

```txt
reconciliation.html
js/reconciliation.js
```

If filenames differ during implementation, the rule still stands: reconciliation must compare backend truth and observed truth without hidden mutation.

## Core Rule

Reconciliation is a comparison and proof system.

Normal reconciliation must be read-only except when the user explicitly saves a manual snapshot.

Correct flow:

```txt
User records observed balance
→ backend saves manual snapshot
→ backend compares observed balance to ledger-derived balance
→ reconciliation reports difference
→ user may create explicit adjustment transaction if needed
```

Forbidden flow:

```txt
manual balance differs
→ backend silently changes account balance
```

## Source of Truth

Ledger-derived account balances remain the financial source of truth.

Manual snapshots are observed real-world values used for comparison.

Reconciliation may expose:

- ledger-computed balance
- manual/observed balance
- difference
- matched accounts
- pending accounts
- exception accounts
- warnings

Reconciliation must not directly replace ledger truth.

## Manual Snapshot Contract

A manual snapshot records observed account balances.

Minimum snapshot fields:

- id
- account_id
- observed_balance
- observed_at
- currency
- source
- notes
- created_at
- created_by if available

Preferred save snapshot request:

```json
{
  "action": "save_snapshot",
  "account_id": "meezan",
  "observed_balance": 8557,
  "observed_at": "2026-05-17",
  "currency": "PKR",
  "source": "manual",
  "notes": "Checked banking app"
}
```

Required validation:

- account exists
- account is not hard-deleted
- observed_balance is numeric
- observed_at is valid
- currency matches account currency unless FX reconciliation is explicitly supported
- source is known
- duplicate snapshot risk is checked

Required response:

```json
{
  "ok": true,
  "action": "save_snapshot",
  "contract_version": "reconciliation-v1",
  "snapshot": {
    "id": "snapshot_example",
    "account_id": "meezan",
    "observed_balance": 8557,
    "observed_at": "2026-05-17",
    "source": "manual"
  },
  "ledger": {
    "changed": false,
    "transaction_id": null
  },
  "warnings": []
}
```

## Reconciliation Summary Contract

Reconciliation summary must compare observed values to ledger-derived values.

Required output:

```json
{
  "ok": true,
  "contract_version": "reconciliation-v1",
  "summary": {
    "matched_count": 1,
    "pending_statement_count": 10,
    "exception_count": 0,
    "real_balance_total": 8557,
    "ledger_balance_total": 8557,
    "difference_total": 0
  },
  "rows": [],
  "warnings": []
}
```

## Reconciliation Row Contract

Each row should include:

```json
{
  "account_id": "meezan",
  "account_name": "Meezan",
  "currency": "PKR",
  "ledger_balance": 8557,
  "observed_balance": 8557,
  "difference": 0,
  "status": "matched",
  "last_snapshot_at": "2026-05-17",
  "warnings": []
}
```

Supported row statuses:

| Status | Meaning |
|---|---|
| matched | observed balance matches ledger balance |
| pending | no recent observed balance exists |
| exception | observed and ledger balances differ |
| stale | snapshot exists but is older than allowed window |
| unsupported | account type/currency not supported |

## Difference Rule

Difference must be calculated by backend:

```txt
difference = observed_balance - ledger_balance
```

Interpretation:

| Difference | Meaning |
|---:|---|
| 0 | ledger matches observed balance |
| positive | real balance is higher than ledger |
| negative | real balance is lower than ledger |

Frontend must not calculate authoritative difference independently.

## Tolerance Rule

Reconciliation may support a tolerance threshold.

Default exact rule:

```txt
matched when difference = 0
```

Optional tolerance rule:

```txt
matched when abs(difference) <= tolerance
```

If tolerance is used, backend must return it:

```json
{
  "policy": {
    "tolerance": 0,
    "currency": "PKR",
    "match_rule": "exact"
  }
}
```

## Adjustment Contract

If reconciliation discovers drift, correction must happen through an explicit ledger adjustment transaction.

Reconciliation must not directly mutate account balance.

Preferred adjustment request:

```json
{
  "action": "create_adjustment",
  "account_id": "meezan",
  "snapshot_id": "snapshot_example",
  "amount": 500,
  "type": "adjustment_positive",
  "date": "2026-05-17",
  "notes": "Reconciliation adjustment"
}
```

Required behavior:

```txt
validate snapshot
validate account
create canonical transaction
marker = [RECON_ADJUSTMENT] account_id={account_id} snapshot_id={snapshot_id}
account balance changes through ledger
snapshot remains historical proof
```

Required response:

```json
{
  "ok": true,
  "action": "reconciliation_adjustment",
  "contract_version": "reconciliation-v1",
  "snapshot_id": "snapshot_example",
  "ledger": {
    "created": true,
    "transaction_id": "tx_recon_adjustment",
    "type": "adjustment_positive",
    "amount": 500,
    "account_id": "meezan",
    "account_delta": 500,
    "marker": "[RECON_ADJUSTMENT] account_id=meezan snapshot_id=snapshot_example"
  },
  "warnings": []
}
```

## Adjustment Direction Rule

If:

```txt
observed_balance > ledger_balance
```

Then correction requires:

```txt
adjustment_positive
```

If:

```txt
observed_balance < ledger_balance
```

Then correction requires:

```txt
adjustment_negative
```

Backend must validate direction before commit.

## Accounts Connection

Reconciliation reads account balances from the Accounts contract.

Rules:

- use ledger-derived balances
- do not trust frontend account balance
- include active accounts by default
- include archived accounts only when explicitly requested
- preserve historical account references

Reconciliation must not directly edit account rows.

## Ledger Connection

Reconciliation adjustment must be a normal canonical transaction.

Required marker:

```txt
[RECON_ADJUSTMENT] account_id={account_id} snapshot_id={snapshot_id}
```

Reversal of a reconciliation adjustment must follow canonical ledger reversal behavior.

Reversing the adjustment must restore account balance through ledger.

## Forecast Connection

Forecast may read reconciliation warnings.

Forecast must not replace `cash_now` with observed balance unless an explicit policy says so.

Default rule:

```txt
forecast cash_now = ledger-derived account balance
```

If reconciliation drift exists, forecast and hub should show warning:

```txt
RECONCILIATION_DRIFT
```

## Hub Connection

Hub reads reconciliation summary.

Hub may display:

- matched count
- pending count
- exception count
- real balance total
- ledger balance total
- difference total
- warning strip
- action link to Reconciliation page

Hub must not perform reconciliation adjustments silently.

## Audit Contract

Reconciliation actions should be audit logged.

Audited actions:

- save_snapshot
- reconciliation_summary
- reconciliation_adjustment
- reconciliation_adjustment_reversal
- snapshot_delete_rejected
- snapshot_update
- reconciliation_health

Audit minimum fields:

- timestamp
- route
- action
- account_id
- snapshot_id
- transaction_id if adjustment created
- observed balance
- ledger balance
- difference
- result
- warnings

## Health Check Requirements

Reconciliation health must verify:

1. Account balances come from Accounts contract.
2. Snapshot rows reference valid accounts.
3. Observed balances are numeric.
4. Difference math is backend-owned.
5. Adjustment rows have reconciliation markers.
6. Adjustment transaction direction matches difference.
7. Reversed adjustment rows restore account state.
8. Stale snapshots are reported.
9. Exception rows are reported.
10. Forecast/Hub warnings are available.
11. No direct account balance mutation occurs.
12. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "reconciliation-v1",
  "checks": {
    "accounts_source_ok": true,
    "snapshots_valid": true,
    "difference_math_valid": true,
    "adjustment_markers_valid": true,
    "adjustment_direction_valid": true,
    "read_only_summary": true
  },
  "counts": {
    "matched_count": 0,
    "pending_statement_count": 0,
    "exception_count": 0,
    "stale_snapshot_count": 0,
    "orphan_snapshot_count": 0,
    "adjustment_count": 0
  },
  "totals": {
    "real_balance_total": 0,
    "ledger_balance_total": 0,
    "difference_total": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render reconciliation summary
- render account comparison rows
- submit manual snapshots
- display drift warnings
- display stale snapshot warnings
- submit explicit adjustment request
- link to related account/ledger rows

Frontend must not:

- calculate authoritative account balance
- calculate authoritative difference as final truth
- silently create adjustment transactions
- overwrite ledger balance
- hide exception rows
- hide stale snapshot warnings
- mutate account balances directly

## UI Layout Contract

Reconciliation must use the shared app shell.

Preferred layout:

```txt
compact status strip
KPI strip: matched / pending / exceptions / difference
snapshot entry row
account comparison rows
exception drawer
adjustment confirmation modal
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
GET /api/reconciliation
GET /api/reconciliation?include_archived=1
POST /api/reconciliation
GET /api/reconciliation/health
```

Preferred action-based POSTs:

```txt
POST /api/reconciliation
action=save_snapshot

POST /api/reconciliation
action=create_adjustment
```

If existing routes differ, stale routes must become shims or be removed after frontend migration.

No stale route may calculate balances differently from the Accounts contract.

## Required Frontend Submit Shapes

### Save manual snapshot

```json
{
  "action": "save_snapshot",
  "account_id": "meezan",
  "observed_balance": 8557,
  "observed_at": "2026-05-17",
  "currency": "PKR",
  "source": "manual",
  "notes": "Checked banking app"
}
```

### Create reconciliation adjustment

```json
{
  "action": "create_adjustment",
  "account_id": "meezan",
  "snapshot_id": "snapshot_example",
  "amount": 500,
  "type": "adjustment_positive",
  "date": "2026-05-17",
  "notes": "Reconciliation adjustment"
}
```

## Stale Route Policy

Any stale reconciliation route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- overwrite account balances
- calculate balances independently from Accounts
- silently create adjustments
- hide exceptions
- ignore reversed rows
- skip audit/proof response

## Acceptance Tests

### Test 1: Save manual snapshot

Input:

```txt
account = Meezan
observed_balance = 8557
```

Expected:

```txt
snapshot saved
no ledger transaction created
account balance unchanged
summary can compare observed vs ledger
```

### Test 2: Matched reconciliation

Input:

```txt
ledger_balance = 8557
observed_balance = 8557
```

Expected:

```txt
status = matched
difference = 0
matched_count increases
exception_count unchanged
```

### Test 3: Positive difference

Input:

```txt
ledger_balance = 8000
observed_balance = 8500
```

Expected:

```txt
difference = +500
status = exception
recommended adjustment type = adjustment_positive
```

### Test 4: Negative difference

Input:

```txt
ledger_balance = 9000
observed_balance = 8500
```

Expected:

```txt
difference = -500
status = exception
recommended adjustment type = adjustment_negative
```

### Test 5: Create adjustment

Input:

```txt
difference = +500
create adjustment_positive 500
```

Expected:

```txt
canonical transaction created
marker = [RECON_ADJUSTMENT] account_id=... snapshot_id=...
account balance increases through ledger
reconciliation difference becomes 0 after refresh
```

### Test 6: Wrong adjustment direction rejected

Input:

```txt
difference = +500
attempt adjustment_negative 500
```

Expected:

```txt
request rejected
no transaction inserted
clear error returned
```

### Test 7: Reversal of adjustment

Input:

```txt
reverse [RECON_ADJUSTMENT] transaction
```

Expected:

```txt
ledger reversal succeeds
account balance restores
reconciliation difference returns
history preserved
```

### Test 8: Stale snapshot warning

Input:

```txt
snapshot older than allowed window
```

Expected:

```txt
row status = stale
warning visible
Hub can surface stale reconciliation warning
```

### Test 9: Pending account

Input:

```txt
active account has no snapshot
```

Expected:

```txt
row status = pending
pending_statement_count increases
```

### Test 10: Read-only summary

Input:

```txt
GET /api/reconciliation
```

Expected:

```txt
no transaction inserted
no account changed
no debt changed
no bill changed
no salary changed
```

## Implementation Order

1. Confirm current reconciliation backend route.
2. Confirm snapshot storage table/fields.
3. Confirm account balances are pulled from Accounts contract.
4. Ensure save snapshot does not mutate ledger/accounts.
5. Ensure summary returns matched/pending/exception counts.
6. Ensure difference math is backend-owned.
7. Add explicit adjustment action only through ledger transaction.
8. Add reconciliation marker to adjustment rows.
9. Add health/proof output.
10. Align frontend to backend response only.
11. Run acceptance tests before moving to Monthly Close.

## Non-Negotiable Close Criteria

Reconciliation is contract-safe only when:

- snapshots save observed truth only
- ledger-derived account balance remains source of truth
- difference math is backend-owned
- no silent account overwrite exists
- adjustment creates canonical ledger transaction
- adjustment direction is validated
- adjustment reversal restores account state
- Hub/Forecast warnings surface drift
- frontend renders backend truth only
- health reports no orphan/mismatch issues

Until these pass, Reconciliation cannot be considered banking-grade.
