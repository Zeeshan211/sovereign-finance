# Audit Contract

## Purpose

Audit is the trust layer for Sovereign Finance.

This contract hardens how financial actions are recorded, reviewed, and protected from silent corruption.

Correct flow:

```txt
Financial action
→ backend validates request
→ backend performs write or rejects it
→ audit records action/result/proof
→ health checks detect missing or suspicious audit coverage
```

Audit must never become a hidden money writer.

## Contract Version

`audit-v1`

## Ownership

Canonical backend owner:

```txt
functions/api/audit.js
```

Allowed supporting routes:

```txt
functions/api/audit/health.js
functions/api/audit/events.js
```

Canonical frontend owner:

```txt
audit.html
js/audit.js
```

If filenames differ during implementation, the rule still stands: audit records proof and warnings; it does not own money movement.

## Core Rule

Every financial write must be auditable.

Audited writes include:

- transaction create
- transaction edit
- transaction reversal
- account create/update/archive
- debt create/update/payment/reversal/repair
- bill create/update/payment/reversal/archive
- salary contract update
- salary payout/reversal
- reconciliation snapshot save
- reconciliation adjustment
- monthly close/reopen
- repair jobs
- admin overrides

Audit must record what happened, where it happened, what changed, and whether it succeeded or failed.

## Audit Is Not a Money Source

Audit must not:

- create transactions
- edit account balances
- settle debts
- mark bills paid
- create salary payouts
- change forecast values
- repair reconciliation drift

Audit may trigger or link to explicit repair flows only if the target module owns the repair and returns proof.

## Audit Event Minimum Fields

Each audit event should include:

- id
- timestamp
- actor
- route
- method
- action
- source_module
- source_id
- transaction_id if applicable
- account_id if applicable
- before_summary
- after_summary
- request_hash if available
- result
- error_code if failed
- warnings
- created_at

Recommended event shape:

```json
{
  "id": "audit_example",
  "timestamp": "2026-05-17T12:00:00Z",
  "actor": "user",
  "route": "/api/debts",
  "method": "POST",
  "action": "debt_payment",
  "source_module": "debts",
  "source_id": "debt_example",
  "transaction_id": "tx_debt_payment",
  "account_id": "meezan",
  "before_summary": {
    "paid_amount": 0,
    "remaining_amount": 10000
  },
  "after_summary": {
    "paid_amount": 2500,
    "remaining_amount": 7500
  },
  "result": "success",
  "warnings": [],
  "contract_version": "audit-v1"
}
```

## Result Types

Supported audit results:

| Result | Meaning |
|---|---|
| success | Action completed and committed |
| rejected | Request failed validation before write |
| failed | Request attempted but failed |
| partial_blocked | Backend blocked partial/unsafe commit |
| reversed | Action was reversed through ledger |
| repaired | Explicit repair completed |
| warning | Action completed with warning |
| read_only | Read/probe action only |

## Required Audit Categories

### Ledger audit

Must cover:

- transaction_create
- transaction_update
- transaction_reverse
- transfer_create
- transfer_reverse
- reconciliation_adjustment
- opening_balance_create

### Accounts audit

Must cover:

- account_create
- account_update
- account_archive
- account_restore
- account_delete_rejected

### Debts audit

Must cover:

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

### Bills audit

Must cover:

- bill_create
- bill_update
- bill_archive
- bill_payment
- bill_advance_payment
- bill_reverse_payment
- bill_repair

### Salary audit

Must cover:

- salary_save_contract
- salary_enable
- salary_disable
- salary_payout
- salary_reverse_payout
- salary_fx_update
- salary_wfh_update

### Reconciliation audit

Must cover:

- save_snapshot
- reconciliation_adjustment
- reconciliation_adjustment_reversal
- snapshot_update
- snapshot_delete_rejected

### Monthly Close audit

Must cover:

- monthly_review
- close_month
- close_blocked
- reopen_month
- monthly_close_adjustment

### Repair/admin audit

Must cover:

- repair_preview
- repair_apply
- repair_skipped
- admin_override
- unsafe_action_blocked

## Before / After Summary Rule

Audit should store compact summaries, not huge raw payloads.

Examples:

```json
{
  "before_summary": {
    "status": "active",
    "paid_amount": 7500,
    "remaining_amount": 2500
  },
  "after_summary": {
    "status": "settled",
    "paid_amount": 10000,
    "remaining_amount": 0
  }
}
```

Do not store sensitive secrets, tokens, or unnecessary raw request bodies.

## Request Hash Rule

Where possible, audit should store a request hash.

Purpose:

- detect duplicate submissions
- support idempotency review
- detect tampering
- verify what was committed

Recommended fields used for hash:

- route
- method
- action
- source_module
- source_id
- account_id
- amount
- date
- request body normalized

## Tamper-Evidence Rule

Audit should move toward tamper-evident logging.

Preferred future model:

```txt
audit_hash = hash(previous_audit_hash + normalized_event_payload)
```

Required current behavior:

- audit rows are append-only where possible
- direct edit/delete of audit events is not allowed from UI
- audit repair actions create new audit events instead of rewriting old ones
- missing audit coverage is reported by health

## Audit Write Timing

For successful financial writes:

```txt
validate request
→ perform financial write atomically
→ write audit event
→ return proof
```

If audit write fails after financial commit, response must include a warning:

```json
{
  "warnings": [
    "Financial write committed, but audit event failed."
  ]
}
```

Preferred stronger behavior:

```txt
financial write and audit write happen in same transaction when supported
```

## Failed Request Audit

Rejected or failed financial attempts may be audited.

Rejected attempts should include:

- route
- action
- reason
- code
- committed = false

Example:

```json
{
  "action": "debt_payment",
  "result": "rejected",
  "error_code": "INVALID_AMOUNT",
  "committed": false
}
```

## Repair Audit

Repair routes must be explicit and auditable.

Repair audit must record:

- dry_run or apply
- scanned rows
- changed rows
- skipped rows
- warnings
- source module
- repair reason

Repair must not silently normalize money state.

Preferred repair response:

```json
{
  "ok": true,
  "action": "debt_repair",
  "dry_run": false,
  "scanned": 12,
  "changed": 2,
  "skipped": 10,
  "audit_id": "audit_repair_example",
  "warnings": []
}
```

## Admin Override Audit

Admin overrides must be rare and explicit.

Admin override audit must include:

- override reason
- affected module
- affected entity
- before summary
- after summary
- actor
- timestamp
- warning severity

No override should bypass ledger/reversal rules for money movement.

## Audit API Output

Audit list endpoint should return:

```json
{
  "ok": true,
  "contract_version": "audit-v1",
  "events": [],
  "summary": {
    "event_count": 0,
    "success_count": 0,
    "rejected_count": 0,
    "failed_count": 0,
    "warning_count": 0,
    "critical_count": 0
  },
  "warnings": []
}
```

## Audit Filters

Audit API should support filters:

- date range
- module
- action
- result
- account_id
- transaction_id
- source_id
- severity

Preferred routes:

```txt
GET /api/audit
GET /api/audit?module=debts
GET /api/audit?action=debt_payment
GET /api/audit?result=failed
GET /api/audit?start=YYYY-MM-DD&end=YYYY-MM-DD
GET /api/audit/health
```

## Audit Health Requirements

Audit health must verify:

1. Core financial writes have audit coverage.
2. Recent transaction creates have audit events.
3. Recent reversals have audit events.
4. Debt payments have audit events.
5. Bill payments have audit events.
6. Salary payouts have audit events.
7. Reconciliation adjustments have audit events.
8. Monthly close actions have audit events.
9. Repair actions have audit events.
10. Failed/blocked actions are visible.
11. Audit rows are not directly editable from frontend.
12. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "audit-v1",
  "checks": {
    "transaction_audit_present": true,
    "reversal_audit_present": true,
    "debt_audit_present": true,
    "bill_audit_present": true,
    "salary_audit_present": true,
    "reconciliation_audit_present": true,
    "monthly_close_audit_present": true,
    "repair_audit_present": true,
    "append_only_policy": true
  },
  "counts": {
    "events": 0,
    "missing_transaction_audits": 0,
    "missing_debt_audits": 0,
    "missing_bill_audits": 0,
    "missing_reversal_audits": 0,
    "failed_events": 0,
    "warning_events": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render audit events
- filter audit events
- render warnings
- render failed/rejected actions
- link to source transaction/module
- show before/after summaries
- show repair proof

Frontend must not:

- edit audit events
- delete audit events
- hide failed financial writes
- hide repair actions
- mutate money from audit page
- create hidden repairs on page load
- calculate audit health independently from backend

## UI Layout Contract

Audit page must use the shared app shell.

Preferred layout:

```txt
compact status strip
KPI strip: events / warnings / failures / missing coverage
filter toolbar
audit event rows
expandable before/after drawer
source links
health warnings
```

Use compact rows/cards and expandable details.

Do not introduce:

- oversized standalone panels
- foreign visual blocks
- page-specific design systems
- duplicated hero cards

## Stale Route Policy

Any stale audit route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale audit routes must not:

- mutate financial state
- hide failed events
- calculate coverage differently
- delete audit rows
- bypass module contracts

## Acceptance Tests

### Test 1: Audit transaction create

Input:

```txt
create manual expense transaction
```

Expected:

```txt
transaction committed
audit event created with action = transaction_create
transaction_id included
result = success
```

### Test 2: Audit rejected transaction

Input:

```txt
create transaction with invalid amount
```

Expected:

```txt
transaction rejected
no ledger row inserted
audit event optionally created with result = rejected
committed = false
```

### Test 3: Audit debt payment

Input:

```txt
pay debt
```

Expected:

```txt
ledger transaction created
debt paid_amount updated
audit event action = debt_payment
before/after summaries included
```

### Test 4: Audit bill payment

Input:

```txt
pay bill
```

Expected:

```txt
ledger transaction created
bill payment row created
audit event action = bill_payment
bill_month included
```

### Test 5: Audit reversal

Input:

```txt
reverse ledger transaction
```

Expected:

```txt
reversal row inserted
original marked reversed
audit event action = transaction_reverse
original and reversal transaction IDs included
```

### Test 6: Audit repair

Input:

```txt
run explicit repair endpoint
```

Expected:

```txt
repair output includes scanned/changed/skipped
audit event action = repair_apply or repair_preview
no silent normalization
```

### Test 7: Audit monthly close

Input:

```txt
close month
```

Expected:

```txt
monthly close snapshot created
audit event action = close_month
month and snapshot_id included
```

### Test 8: Audit page read-only

Input:

```txt
GET /api/audit
```

Expected:

```txt
no transactions inserted
no accounts changed
no debts changed
no bills changed
no salary changed
```

### Test 9: Missing coverage warning

Input:

```txt
recent debt payment has no audit event
```

Expected:

```txt
audit health reports missing_debt_audits > 0
Hub can surface warning
```

### Test 10: Audit immutability

Input:

```txt
attempt to edit/delete audit event from frontend
```

Expected:

```txt
request blocked
audit history preserved
warning/audit event created if supported
```

## Implementation Order

1. Confirm current audit API/page exists.
2. Confirm audit table/schema or create documented storage.
3. Add audit helper used by money routes.
4. Add audit events for Transactions/Add first.
5. Add audit events for Accounts.
6. Add audit events for Debts.
7. Add audit events for Bills.
8. Add audit events for Salary.
9. Add audit events for Reconciliation.
10. Add audit events for Monthly Close.
11. Add audit health coverage checks.
12. Align frontend to backend audit output only.

## Non-Negotiable Close Criteria

Audit is contract-safe only when:

- every core money write has audit coverage
- reversals are audited
- repairs are audited
- failed/rejected writes are visible
- audit rows are append-only or protected
- audit does not mutate money state
- frontend cannot edit/delete audit events
- health reports missing coverage
- Hub can surface audit warnings
- contract version is reported

Until these pass, Sovereign Finance cannot be considered banking-grade.
