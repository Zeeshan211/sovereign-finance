# Bank Statements Reconciliation Summary

**Extraction Date:** 2026-05-25  
**Cutoff:** 2026-05-02 onwards (value date)  
**Folder:** Google Drive — "Bank Statements and Truths" (ID: 14lhf8Oiat1xcbaLlOVPPNuw2IZNBsaOI)

| Bank | Account | IBAN | Period | Opening (Rs) | Closing (Rs) | Rows | CSV File |
|------|---------|------|--------|-------------|-------------|------|----------|
| Mashreq Bank | 089200002796 (ISCREM) | PK52MSHQ0000089200002796 | 2026-05-02 to 2026-05-24 | 203.65 | 9.93 | 30 | Mashreq_2796_recon_2026-05-02_to_2026-05-24.csv |
| Meezan Bank | 05110109447136 | PK17MEZN0005110109447136 | 2026-05-02 to 2026-05-24 | 133351.01 | 10.01 | 56 | Meezan_7136_recon_2026-05-02_to_2026-05-24.csv |
| NayaPay | meerzeeshan@nayapay / 03085091435 | PK57NAYA1234503085091435 | 2026-05-04 to 2026-05-24 | 0.31 | 0.31 | 18 | NayaPay_1435_recon_2026-05-04_to_2026-05-24.csv |
| UBL | 1226-248525196 (Mukammal Current) | PK20UNIL0109000248525196 | 2026-05-02 to 2026-05-04 | 97.29 | 0.00 | 9 | UBL_5196_recon_2026-05-02_to_2026-05-04.csv |
| Bank Alfalah CC | 402582XXXXXX1349 (VISA) | — | 2026-05-03 to 2026-05-15 | 78694.97 | 82011.24 | 10 | Alfalah_CC_1349_recon_2026-05-03_to_2026-05-15.csv |
| Easypaisa Bank | 03110039487 | PK43TMFB0000000042728548 | 2026-05-12 to 2026-05-17 | 8800.57 | 16316.82 | 6 | Easypaisa_8548_recon_2026-05-12_to_2026-05-17.csv |
| JS Bank | 0002433878 (Assan Digital) | PK16JSBL9559000002433878 | 2026-05-24 to 2026-05-24 | 0.71 | 0.71 | 2 | JSBank_3878_recon_2026-05-24_to_2026-05-24.csv |

**Total rows across all accounts:** 131

## Notes

- **Alfalah CC:** Opening = outstanding balance before first post-cutoff transaction (2026-05-03). Debit = spend/charge; credit = payment received. Balance = total outstanding. Transaction date (value date) used. Statement date 2026-05-15; statement covers up to May 15 only.
- **Easypaisa:** Source statement is reverse-chronological; rows reversed to chronological order in CSV. Opening B/F from statement: 8800.57.
- **Meezan:** Balance goes negative on 2026-05-24 row 55 (VIP STORE debit 200 from balance 20.01 = -179.99) — shown as -179.99. Confirmed by closing: -179.99 + 190 = 10.01. Several 2026-05-16 reversal pairs included as-is per spec (no dedup).
- **NayaPay:** First transaction is 2026-05-04; no activity on May 2–3. Opening 0.31 from 2026-05-01.
- **UBL:** Last transaction has posting date 2026-05-05 but value date 2026-05-04; CSV uses value date 2026-05-04.
- **JS Bank:** Zero activity between 2026-03-16 and 2026-05-24. Both May transactions have value date 2026-05-24 (posting date 2026-05-25).
- **Bank Alfalah Current (00761009651061 / PK77ALFH0076001009651061):** No transactions on or after 2026-05-02. Excluded.
- **UBL CC (410525XXXXXX2399):** Most recent statement available is Feb 2026; no May 2026 statement found in Drive. Excluded.
- **Faysal Bank Noor Card (5578-XXXX-XXXX-4012):** Most recent statement in Drive is Jul 2025. Excluded.
- **JS Bank CC (4770520034338050):** Most recent statement in Drive is Feb 2025. Excluded.
