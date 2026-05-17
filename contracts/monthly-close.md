# Monthly Close Contract

## Purpose

Monthly Close freezes a financial month into an auditable review state.

This contract hardens the month-end loop:

```txt
Ledger + Accounts + Bills + Debts + Salary + Reconciliation + Forecast
→ monthly close review
→ warnings and exceptions surfaced
→ user confirms close
→ month snapshot is saved
→ future edits require explicit adjustment/reversal
```

Monthly Close must never silently rewrite historical money state.

## Contract Version

`monthly-close-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/monthly-close.js
```

Allowed supporting routes:

```txt
functions/api/monthly-close/health.js
functions/api/monthly-close/snapshots.js
```

Canonical frontend owner:

```txt
monthly-close.html
js/monthly-close.js
```

If filenames differ during implementation, the rule still stands: Monthly Close must be an audit/review layer over backend truth, not a hidden money writer.

## Core Rule

Monthly Close is a financial period lock and proof system.

Correct flow:

```txt
User reviews month
→ backend gathers source summaries
→ backend reports warnings/exceptions
→ user closes month explicitly
→ close snapshot is saved
→ historical money rows remain unchanged
```

Forbidden flow:

```txt
month close
→ backend silently changes transactions/accounts/debts/bills
```

## Monthly Close Source Inputs

Monthly Close may read:

- accounts summary
- ledger transactions
- reversed transaction state
- bills current/month cycle status
- debts active/terminal status
- salary expected/payout state
- reconciliation status
- forecast summary
- audit warnings
- module health checks

Monthly Close must identify source contract versions.

## Required Monthly Review Output

Before close, backend should return:

```json
{
  "ok": true,
  "contract_version": "monthly-close-v1",
  "month": "2026-05",
  "status": "open",
  "summary": {
    "starting_cash": 0,
    "ending_cash": 0,
    "income_total": 0,
    "expense_total": 0,
    "bill_paid_total": 0,
    "bill_remaining_total": 0,
    "debt_payment_total": 0,
    "debt_remaining_payable": 0,
    "debt_remaining_receivable": 0,
    "reconciliation_difference": 0,
    "warning_count": 0,
    "critical_count": 0
  },
  "sources": {
    "accounts": "accounts-v1",
    "transactions": "transactions-add-v1",
    "bills": "bills-v1",
    "debts": "debts-v1",
    "salary": "salary-v1",
    "forecast": "forecast-v1",
    "reconciliation": "reconciliation-v1"
  },
  "warnings": [],
  "exceptions": []
}
```

## Close Statuses

Supported statuses:

| Status | Meaning |
|---|---|
| open | Month is not closed |
| review_ready | Month can be reviewed |
| blocked | Month has critical unresolved issues |
| closed | Month is closed |
| reopened | Month was closed and later reopened |
| adjusted | Month is closed but later adjustment exists |

## Close Readiness Rules

A month can be closed only when critical integrity risks are resolved.

Blocking issues:

- account balance health failure
- unrepaired reversal mismatch
- orphan bill payment transaction
- orphan debt payment transaction
- reconciliation exception above allowed tolerance
- single-sided transfer
- missing source contract version
- failed module health check for core finance module

Warnings that may allow close:

- salary disabled intentionally
- pending reconciliation snapshot for unused account
- archived account with historical transactions
- minor stale data warning
- forecast source warning that does not affect ledger truth

Backend must clearly separate:

```txt
blocking exceptions
vs
non-blocking warnings
```

## Monthly Snapshot Contract

Closing a month saves a snapshot of month-end proof.

Minimum snapshot fields:

- id
- month
- closed_at
- closed_by if available
- status
- source_versions
- account_summary
- transaction_summary
- bill_summary
- debt_summary
- salary_summary
- reconciliation_summary
- forecast_summary
- warnings
- exceptions
- hash/checksum if available

Snapshot must not replace ledger truth.

Snapshot is proof of what the system believed at close time.

## Close Month Request

Preferred request:

```json
{
  "action": "close_month",
  "month": "2026-05",
  "confirmed": true,
  "notes": "Month reviewed and closed"
}
```

Required validation:

- month is valid
- month is not already closed unless reopening flow is used
- source health checks completed
- blocking exceptions are zero
- user confirmation is explicit
- snapshot can be saved atomically

## Close Month Response

Required response:

```json
{
  "ok": true,
  "action": "close_month",
  "contract_version": "monthly-close-v1",
  "month": "2026-05",
  "status": "closed",
  "snapshot": {
    "created": true,
    "id": "monthly_close_2026_05",
    "closed_at": "2026-05-31T23:59:59Z"
  },
  "ledger": {
    "changed": false
  },
  "warnings": []
}
```

## Blocked Close Response

If the month cannot close:

```json
{
  "ok": false,
  "action": "close_month",
  "contract_version": "monthly-close-v1",
  "month": "2026-05",
  "status": "blocked",
  "committed": false,
  "exceptions": [
    {
      "source": "debts",
      "code": "DEBT_REVERSAL_MISMATCH",
      "message": "Debt payment reversal has not repaired paid_amount."
    }
  ],
  "warnings": []
}
```

No snapshot should be marked closed if blocking exceptions exist.

## Historical Edits After Close

Closed months must not be silently changed.

If a user edits or reverses a transaction dated inside a closed month:

Backend must either:

1. block the edit and require reopening, or
2. allow explicit adjustment flow with audit proof.

Preferred safe policy:

```txt
closed month historical transaction edits are blocked
corrections use dated adjustment/reversal rows with audit proof
```

## Reopen Contract

Reopening a month must be explicit.

Preferred request:

```json
{
  "action": "reopen_month",
  "month": "2026-05",
  "reason": "Need to correct missed transaction"
}
```

Required behavior:

- mark close snapshot as reopened
- preserve original close snapshot
- audit the reopen action
- allow correction through normal ledger routes
- require re-close after correction

Reopen response:

```json
{
  "ok": true,
  "action": "reopen_month",
  "contract_version": "monthly-close-v1",
  "month": "2026-05",
  "status": "reopened",
  "original_snapshot_preserved": true,
  "warnings": []
}
```

## Adjustment After Close

If adjustment without reopen is supported, it must create a canonical transaction.

Required marker:

```txt
[MONTHLY_CLOSE_ADJUSTMENT] month={YYYY-MM}
```

Adjustment must include:

- account_id
- amount
- type
- date
- reason
- related close snapshot ID
- audit proof

Monthly Close must then report status:

```txt
adjusted
```

## Ledger Connection

Monthly Close reads ledger truth.

Rules:

- include active transactions in month summary
- exclude reversed originals from active totals
- include reversal rows according to ledger policy
- preserve historical transaction rows
- never delete or rewrite ledger rows during close

Monthly income/expense totals must be backend-computed.

Frontend must not calculate authoritative close totals.

## Accounts Connection

Monthly Close reads Accounts contract summary.

Rules:

- use ledger-derived balances
- include account health warnings
- include reconciliation difference if available
- no direct account balance mutation

## Bills Connection

Monthly Close reads Bills contract summary.

Must include:

- expected bills for month
- paid bills for month
- remaining bills for month
- advance payments affecting future cycles
- bill warnings/exceptions

A month should not close as pass if current cycle bill payment links are broken.

## Debts Connection

Monthly Close reads Debts contract summary.

Must include:

- debt payments made in month
- active payable remaining
- active receivable remaining
- terminal debts settled in month
- debt reversal warnings/exceptions

A month should not close as pass if debt ledger links are broken.

## Salary Connection

Monthly Close reads Salary contract.

Must include:

- expected salary for month
- salary payout received or not received
- payout transaction link if payout occurred
- duplicate payout warnings

Salary missing may be a warning or blocker depending on salary enabled state and policy.

## Reconciliation Connection

Monthly Close reads Reconciliation contract.

Must include:

- matched count
- pending count
- exception count
- real balance total
- ledger balance total
- difference total

Close should be blocked if reconciliation difference exceeds allowed tolerance.

Default tolerance:

```txt
0
```

## Forecast Connection

Monthly Close may read Forecast contract for review context.

Forecast should not block close by itself unless source health indicates financial integrity risk.

Forecast is projection; Monthly Close is historical proof.

## Audit Contract

Monthly Close actions must be audit logged.

Audited actions:

- monthly_review
- close_month
- close_blocked
- reopen_month
- monthly_close_adjustment
- monthly_close_health

Audit minimum fields:

- timestamp
- route
- action
- month
- snapshot_id if created
- source versions
- warning count
- exception count
- result
- notes/reason

## Health Check Requirements

Monthly Close health must verify:

1. Month parameter is valid.
2. Source modules are reachable.
3. Source contract versions are present.
4. Ledger totals are computable.
5. Reversed rows are handled correctly.
6. Account balances are ledger-derived.
7. Bill cycle totals are valid.
8. Debt link/reversal health is valid.
9. Reconciliation difference is within tolerance.
10. Existing close snapshots are immutable/preserved.
11. Close does not mutate financial rows.
12. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "monthly-close-v1",
  "month": "2026-05",
  "checks": {
    "sources_reachable": true,
    "source_versions_present": true,
    "ledger_totals_valid": true,
    "accounts_valid": true,
    "bills_valid": true,
    "debts_valid": true,
    "reconciliation_valid": true,
    "snapshots_preserved": true,
    "read_only_review": true
  },
  "status": "review_ready",
  "warnings": [],
  "exceptions": []
}
```

## Frontend Contract

Frontend may:

- render monthly review summary
- render source health
- render warnings and exceptions
- submit explicit close request
- submit explicit reopen request
- link to modules needing repair
- show closed/reopened/adjusted status

Frontend must not:

- calculate authoritative monthly totals
- hide blocking exceptions
- close a month without backend confirmation
- silently create adjustment rows
- directly mutate ledger/accounts/bills/debts
- remove close history

## UI Layout Contract

Monthly Close must use the shared app shell.

Preferred layout:

```txt
compact month selector
status strip
KPI strip
source health rows
warnings/exceptions list
close confirmation panel
closed snapshot history
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
GET /api/monthly-close?month=YYYY-MM
POST /api/monthly-close
GET /api/monthly-close/health?month=YYYY-MM
```

Preferred action-based POSTs:

```txt
POST /api/monthly-close
action=close_month

POST /api/monthly-close
action=reopen_month
```

If existing routes differ, stale routes must become shims or be removed after frontend migration.

## Required Frontend Submit Shapes

### Close month

```json
{
  "action": "close_month",
  "month": "2026-05",
  "confirmed": true,
  "notes": "Month reviewed and closed"
}
```

### Reopen month

```json
{
  "action": "reopen_month",
  "month": "2026-05",
  "reason": "Need to correct missed transaction"
}
```

## Stale Route Policy

Any stale Monthly Close route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- calculate totals differently
- hide source warnings
- mutate financial rows during review
- overwrite close snapshots
- bypass audit/proof response

## Acceptance Tests

### Test 1: Review open month

Input:

```txt
GET monthly close for current month
```

Expected:

```txt
summary returned
source versions returned
warnings/exceptions returned
no financial rows changed
```

### Test 2: Close clean month

Input:

```txt
no blocking exceptions
confirmed = true
```

Expected:

```txt
monthly close snapshot created
status = closed
ledger/accounts/debts/bills unchanged
audit row created
```

### Test 3: Block close with debt mismatch

Input:

```txt
debts health has reversal mismatch
```

Expected:

```txt
close blocked
no closed snapshot created
exception visible
action points to Debts
```

### Test 4: Block close with reconciliation drift

Input:

```txt
difference_total != 0
tolerance = 0
```

Expected:

```txt
close blocked or warning based on configured policy
drift visible
no silent account adjustment
```

### Test 5: Historical edit blocked after close

Input:

```txt
attempt direct edit to transaction dated in closed month
```

Expected:

```txt
edit blocked or requires reopen/adjustment flow
audit warning created
no silent rewrite
```

### Test 6: Reopen month

Input:

```txt
closed month
action = reopen_month
reason supplied
```

Expected:

```txt
month status = reopened
original close snapshot preserved
audit row created
corrections can proceed through canonical routes
```

### Test 7: Re-close reopened month

Input:

```txt
reopened month after correction
no blocking exceptions
```

Expected:

```txt
new close snapshot created
previous snapshot preserved
status = closed
history shows reopen/reclose chain
```

### Test 8: Read-only review proof

Input:

```txt
GET /api/monthly-close?month=YYYY-MM
```

Expected:

```txt
no transaction inserted
no account changed
no bill changed
no debt changed
no salary changed
no reconciliation snapshot created
```

## Implementation Order

1. Confirm current Monthly Close page/API exists.
2. Confirm source modules expose health/proof.
3. Build read-only monthly review response.
4. Add source version reporting.
5. Add warnings/exceptions separation.
6. Add close snapshot storage.
7. Add blocked close behavior.
8. Add reopen behavior if needed.
9. Align frontend to backend response only.
10. Run acceptance tests before moving to Audit.

## Non-Negotiable Close Criteria

Monthly Close is contract-safe only when:

- review is read-only
- all source versions are visible
- blocking exceptions prevent close
- close snapshot preserves proof
- financial rows are not silently changed
- historical edits after close are blocked or audited
- reopen preserves original close snapshot
- frontend renders backend truth only
- warnings/exceptions are visible
- health proves no hidden mutation

Until these pass, Monthly Close cannot be considered banking-grade.
