# Statement Reconciliation v0.2 — Testing Guide

## Overview

Phase 1 adds three new capabilities:
- `POST /api/reconciliation/import-statement` — parse + store a bank CSV
- `POST /api/reconciliation/dry-run` — match against ledger, return plan
- `GET /api/reconciliation` — upgraded to v0.2.0 with `import_summary`

No ledger writes happen in Phase 1. The dry-run is always safe to run.

---

## Step 1 — Run the migration

```bash
wrangler d1 execute sovereign-finance \
  --file=migrations/11_statement_reconciliation.sql
```

Or paste the SQL in Cloudflare Dashboard → D1 → sovereign-finance → Console.

---

## Step 2 — Import your Meezan CSV

```bash
curl -X POST https://<your-worker>/api/reconciliation/import-statement \
  -H 'Content-Type: application/json' \
  -d '{
    "account_id": "meezan",
    "csv_text": "date,description,debit,credit,balance\n2026-05-22,\"Naseem Momos cash withdrawal\",820,,448.01\n2026-05-24,\"Imran Bhai loan IBFT\",,3000,3448.01\n2026-05-24,\"NASEEM AHMED IBFT\",500,,2948.01"
  }'
```

Save the `import_id` from the response.

---

## Step 3 — Run the dry-run

```bash
curl -X POST https://<your-worker>/api/reconciliation/dry-run \
  -H 'Content-Type: application/json' \
  -d '{
    "import_id": "<import_id from step 2>",
    "account_id": "meezan"
  }'
```

### Expected response fields

| Field | Expected value |
|---|---|
| `statement_rows` | 3 (or 7 for full CSV) |
| `projected_balance` | last row’s `balance` column |
| `app_balance_now` | app ledger total for the account |
| `drift` | `app_balance_now − projected_balance` |
| `classification_counts.MATCHED_EXISTING` | rows that exist in ledger |
| `classification_counts.MISSING_SAFE_TO_IMPORT` | rows not yet in ledger |

---

## Full 7-row test CSV (Meezan May 22–24)

Replace the `csv_text` value with your complete Meezan statement export.
The format Meezan exports is:

```
date,description,debit,credit,balance
2026-05-22,"Naseem Momos cash withdrawal",820,,448.01
2026-05-24,"Imran Bhai loan IBFT",,3000,3448.01
2026-05-24,"NASEEM AHMED IBFT",500,,2948.01
... (add remaining 4 rows)
```

### What the plan should show (all 7 rows in ledger)

- `classification_counts.MATCHED_EXISTING` = 7
- `classification_counts.MISSING_SAFE_TO_IMPORT` = 0
- `projected_balance` = 10.01 (statement closing balance)
- `app_balance_now` = 448.01 (app ledger balance)
- `drift` = 438.00

---

## Matching Rules Summary

| Match type | Conditions |
|---|---|
| EXACT | Same account + same amount + date ±2 days + description overlap ≥60% |
| FUZZY | Same account + same amount + date ±5 days |
| TRANSFER_PAIR_FOUND | Debit in A + matching credit in B within 2 days |
| TRANSFER_PAIR_MISSING | Description hints at IBFT/transfer but no other-account match |
| POSSIBLE_DUPLICATE | 2 statement rows match 1 ledger row |
| PENDING_UNPOSTED | Ledger entry in last 3 days with no statement counterpart |

---

## Using the UI

Navigate to `/reconciliation` in LiquidityOS:
1. Select your Meezan account from the dropdown
2. Paste your CSV into the textarea
3. Click **Run Dry-Run**
4. Review the plan table and summary cards

No data is written to the ledger from the UI in Phase 1.

---

## Files modified / created

| File | Change |
|---|---|
| `migrations/11_statement_reconciliation.sql` | New — 3 new tables |
| `functions/api/reconciliation/import-statement.js` | New endpoint |
| `functions/api/reconciliation/dry-run.js` | New endpoint + matching engine |
| `functions/api/reconciliation/[[path]].js` | Modified — VERSION → v0.2.0, added `import_summary` to GET |
| `src/pages/ReconciliationPage.tsx` (LiquidityOS) | New page |
| `src/App.tsx` (LiquidityOS) | Modified — added `/reconciliation` route |
