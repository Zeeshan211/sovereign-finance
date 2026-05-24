# Historical Import — Dry Run Report

**Batch ID:** `dd185a3f-24ed-408a-9471-9838cd0dc94e`  
**Generated:** 2026-05-24  
**Status:** DRY RUN ONLY — no data written to database

---

## Summary

| Metric | Value |
|--------|-------|
| Files parsed | 28 |
| Raw transactions collected | 3,141 |
| Intra-batch duplicates removed | 165 |
| **Net transactions to import** | **2,976** |
| HIGH confidence (ready to import) | 2,706 (91%) |
| MEDIUM/LOW confidence (flagged for review) | 270 (9%) |
| Date range | 2023-07-10 → 2026-05-24 |

---

## By Account

| Account | Transactions | HIGH | Flagged | Notes In | Notes Out |
|---------|-------------|------|---------|----------|-----------|
| alfalah | 4 | 4 | 0 | Rs 2,065 | Rs 2,065 |
| alfalah_cc | 194 | 192 | 2 | Rs 625,610 | Rs 584,127 |
| faysal_cc | 103 | 101 | 2 | Rs 61,724 | Rs 90,800 |
| faysal_cc_b | 93 | 90 | 3 | Rs 130,931 | Rs 132,369 |
| jazzcash_biz | 208 | 208 | 0 | Rs 752,476 | Rs 44,046 |
| meezan | 697 | 566 | 131 | Rs 3,322,492 | Rs 2,398,794 |
| nayapay | 564 | 551 | 13 | Rs 81,734 | Rs 1,777,898 |
| ubl | 1,113 | 994 | 119 | Rs 2,831,978 | Rs 5,995,269 |
| **TOTAL** | **2,976** | **2,706** | **270** | **Rs 7,809,009** | **Rs 11,025,369** |

> Note: "In" = income + cc_payment credits; "Out" = expenses + ATM withdrawals + transfers out.
> The out > in gap reflects NayaPay acting as payment relay (money flows through it) and UBL being
> the primary spending account funded from other sources not fully captured in this dataset.

---

## By Transaction Type

| Type | Count | Total Amount (Rs) |
|------|-------|-------------------|
| expense | 1,643 | 7,813,411 |
| income | 604 | 6,537,692 |
| cc_spend | 286 | 805,234 |
| cc_payment | 95 | 1,268,732 |
| atm | 114 | 1,516,657 |
| transfer | 234 | 889,339 |
| **TOTAL** | **2,976** | **18,831,065** |

---

## Monthly Distribution

| Month | Count | Month | Count | Month | Count |
|-------|-------|-------|-------|-------|-------|
| 2023-07 | 13 | 2024-08 | 341 | 2025-07 | 113 |
| 2023-08 | 2 | 2024-09 | 4 | 2025-08 | 183 |
| 2023-09 | 4 | 2024-10 | 7 | 2025-09 | 202 |
| 2023-10 | 5 | 2024-11 | 67 | 2025-10 | 256 |
| 2023-11 | 11 | 2024-12 | 88 | 2025-11 | 184 |
| 2023-12 | 4 | 2025-01 | 30 | 2025-12 | 170 |
| 2024-01 | 30 | 2025-02 | 30 | 2026-01 | 87 |
| 2024-02 | 27 | 2025-03 | 33 | 2026-02 | 128 |
| 2024-03 | 39 | 2025-04 | 250 | 2026-03 | 117 |
| 2024-04 | 31 | 2025-05 | 145 | 2026-04 | 72 |
| 2024-05 | 7 | 2025-06 | 158 | 2026-05 | 119 |
| 2024-06 | 9 | | | | |
| 2024-07 | 10 | | | | |

> Aug 2024 spike (341 txns): UBL statement covering a large period was parsed from this month.
> Apr 2025 spike (250 txns): UBL + Meezan statements both have high activity.

---

## CRITICAL: Account ID Mapping — MUST VERIFY

The account IDs below were inferred from slug-naming convention.
**These must be verified against the live database before Phase R7 (real import).**
If any ID is wrong, ALL transactions for that account will fail insertion with a foreign-key error.

| Slug Used | Expected Account | Verify At |
|-----------|-----------------|-----------|
| `alfalah` | Bank Alfalah Current A/C 009651061 | /accounts |
| `alfalah_cc` | Bank Alfalah Credit Card *1349 | /accounts |
| `faysal_cc` | Faysal Bank Noor Card *4012 | /accounts |
| `faysal_cc_b` | Faysal Bank Noor Card *2551 | /accounts |
| `jazzcash_biz` | JazzCash Business 03110039487 | /accounts |
| `meezan` | Meezan Bank 05110109447136 | /accounts |
| `nayapay` | NayaPay meerzeeshan@nayapay | /accounts |
| `ubl` | UBL Mukammal Current 248525196 | /accounts |

To verify: open your LiquidityOS app, go to Accounts, and check that each account's ID
(visible in the URL or dev tools) matches the slug above.

---

## Flagged Transactions (270) — Pattern Breakdown

These transactions have MEDIUM or LOW confidence and will be imported with `historical_import=1`
but may need manual categorization after import.

| Pattern | Count | Notes |
|---------|-------|-------|
| NayaPay wallet loads (Meezan→NayaPay) | 134 | Could classify as `transfer` but type unclear |
| Credit card payments (Faysal, JS Bank) | 50 | Classified as `cc_payment` but missing merchant link |
| Bank charges / FED taxes | 27 | Small amounts (Rs 4–635), classified as `expense` |
| Other unclassified | 49 | Mixed; requires manual review after import |
| Reversals/refunds | 5 | Classified as `income`, verify correct account |
| ATM/cash with no detail | 3 | Already typed as `atm` |
| Utility bill payments | 2 | 1BILL system; classified as `expense` |

All 270 flagged transactions WILL be included in the import with `historical_import=1`.
They can be reviewed and re-categorized via the LiquidityOS UI after import.

---

## Files Parsed

| File | Account | Transactions | Notes |
|------|---------|-------------|-------|
| alfalah_cc_sep2025.txt | alfalah_cc | 13 | |
| alfalah_cc_oct2025.txt | alfalah_cc | 5 | |
| alfalah_cc_nov2025.txt | alfalah_cc | 34 | |
| alfalah_cc_dec2025.txt | alfalah_cc | 2 | |
| alfalah_cc_jan2026.txt | alfalah_cc | 18 | |
| alfalah_cc_feb2026.txt | alfalah_cc | 27 | |
| alfalah_cc_mar2026.txt | alfalah_cc | 38 | |
| alfalah_cc_apr2026.txt | alfalah_cc | 43 | |
| alfalah_cc_may2026_latest.txt | alfalah_cc | 29 | |
| alfalah_current.txt | alfalah | 4 | |
| meezan_short2.txt | meezan | 25 | Single-line format, May 2026 |
| ubl_2025_2026.txt | meezan | 696 | **File mislabeled UBL — actually Meezan (PK17MEZN)** |
| ubl_2024_2026.txt | ubl | 647 | Jan 2024–Feb 2026 |
| meezan_2025b.txt | ubl | 552 | **File mislabeled Meezan — actually UBL (PK20UNIL)** |
| nayapay_y2023.txt | nayapay | 69 | Jul 2023–Jun 2024 |
| nayapay_y2024.txt | nayapay | 467 | Jul 2024–Jun 2025 |
| nayapay_m112025.txt | nayapay | 11 | |
| nayapay_m122025.txt | nayapay | 3 | |
| nayapay_m022026.txt | nayapay | 3 | |
| nayapay_m032026.txt | nayapay | 4 | |
| nayapay_m052026.txt | nayapay | 18 | |
| jazzcash_biz.txt | jazzcash_biz | 208 | |
| combo_faysal_js_alfalah_meezan.txt | faysal_cc / faysal_cc_b | 225 | Two Faysal CC accounts |

---

## API Dry Run Status

Attempted live dry-run POST to `/api/import/bulk` — **blocked by Cloudflare edge (HTTP 403)**.
This report is generated from local `consolidated.json` + `flagged.json` data.

The `/api/import/bulk` endpoint itself will perform server-side deduplication against the live DB
on real import. Server-side dedup key: `(date, amount, account_id, COALESCE(notes,''))`.
Any transactions already in the DB with matching keys will be skipped (not duplicated).

---

## Rollback Plan

If real import needs to be undone:

```
POST /api/import/rollback
{ "batch_id": "dd185a3f-24ed-408a-9471-9838cd0dc94e" }
→ preview of what would be deleted

POST /api/import/rollback
{ "batch_id": "dd185a3f-24ed-408a-9471-9838cd0dc94e", "confirm": true }
→ deletes all transactions with import_batch_id = dd185a3f-24ed-408a-9471-9838cd0dc94e
```

Only transactions tagged `historical_import=1` are deleted — existing live transactions are untouched.

---

## Next Step

**Phase R7 requires explicit "PROCEED WITH IMPORT" from the user.**

Before confirming, please verify:
1. Account IDs in the table above match your actual account slugs in LiquidityOS
2. You are satisfied with 270 flagged transactions being included (they can be reviewed post-import)
3. You acknowledge rollback is available if needed
