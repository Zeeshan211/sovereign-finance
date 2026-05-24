# Historical Import + May 24 Transactions — Reconciliation

**Batch:** `dd185a3f-24ed-408a-9471-9838cd0dc94e`  
**Date:** 2026-05-24  
**Status:** Browser import script generated — pending execution

---

## What Will Be Imported

| Category | Count |
|----------|-------|
| Historical HIGH confidence transactions | 2,706 |
| Today's May 24 manual transactions | 24 |
| **Total** | **2,730** |
| Date range | 2023-07-10 → 2026-05-24 |

(270 MEDIUM/LOW flagged transactions held back — available in `flagged.json` for future import)

---

## Account ID Remapping Applied

| Original Slug | Corrected DB Slug | Transactions Affected |
|--------------|-------------------|-----------------------|
| `alfalah_cc` | `cc` | 192 |
| `faysal_cc` | `faysal_cc_a` | 101 |
| `nayapay` | `naya_pay` | 551 |
| alfalah | alfalah (unchanged) | 4 |
| faysal_cc_b | faysal_cc_b (unchanged) | 90 |
| jazzcash_biz | jazzcash_biz (unchanged) | 208 |
| meezan | meezan (unchanged) | 566 |
| ubl | ubl (unchanged) | 994 |

---

## May 24 Manual Transactions (24 entries)

| Description | Account | Amount | Type |
|-------------|---------|--------|------|
| Loan from Imran Bhai | meezan | +3,000 | income |
| Payment to Naseem Bibi | meezan | -500 | expense |
| CC payment to Alfalah (2,000) | meezan → cc | 2,000 | cc_payment |
| CC payment to Alfalah (500) | meezan → cc | 500 | cc_payment |
| Inflow for plot payment | mashreq | +100,000 | income |
| ATM withdrawal Allied Bank | mashreq | -100,000 | atm |
| Cash in (from ATM) | cash | +100,000 | income |
| Plot payment to Aunt | cash | -100,000 | expense |
| Noodles transfer | mashreq → meezan | 20 | transfer |
| Noodles - NayaPay portion | naya_pay | -190 | expense |
| Noodles - Meezan portion | meezan | -10 | expense |
| Zain returned (cat treats) | cash | +650 | income |
| Zain returned (house maid) | cash | +500 | income |
| Cat treats | cash | -650 | expense |
| House Maid salary advance | cash | -500 | expense |
| Google Claude Subscription | cc | -4,900 | cc_spend |
| Foreign transaction fee | cc | -220.50 | cc_spend |
| 16% Excise Duty | cc | -35.28 | cc_spend |
| 236Y 5% Advance Tax | cc | -245 | cc_spend |
| PTCL Islamabad | cc | -2,000 | cc_spend |
| PTCL second entry | cc | -2,000 | cc_spend |

---

## Debts to Create (8)

| Name | Direction | Original | Paid | Outstanding |
|------|-----------|----------|------|-------------|
| Imran Bhai — Plot Funding | I owe | 250,000 | 0 | 250,000 |
| Imran Bhai — Short-term May 24 | I owe | 3,000 | 0 | 3,000 |
| Imran Bhai — Historical | I owe | 10,000 | 0 | 10,000 |
| Aunt — Plot Purchase | I owe | 700,000 | 300,000 | 400,000 |
| Naseem Bibi | I owe | 820 | 500 | 320 |
| Mashal | I owe | 8,500 | 0 | 8,500 |
| Jamima Khan | Owed to me | 1,000 | 0 | 1,000 |
| Zain Easypaisa | Owed to me | 1,150 | 1,150 | 0 (settled) |

**Total I owe:** Rs 671,820  
**Total owed to me:** Rs 1,000 (net outstanding)

---

## Bills to Create (6)

| Name | Amount | Frequency | Account |
|------|--------|-----------|---------|
| K-Electric | variable | monthly | meezan |
| SNGPL | variable | monthly | meezan |
| PTCL Islamabad | 2,000 | monthly | cc |
| Google Claude Subscription | 4,900 | monthly | cc |
| House Maid Salary | 500 | monthly | cash |
| StormFiber | ~3,000 | monthly | naya_pay |

---

## Account Balance Verification (Post-Import)

*Fill in after running the import script — compare app balances to statement closing balances.*

| Account | Statement Closing | App Balance | Match? |
|---------|------------------|-------------|--------|
| meezan | ~verify in app | TBD | TBD |
| ubl | ~verify in app | TBD | TBD |
| mashreq | ~9.93 (pre-May 24) | TBD | TBD |
| naya_pay | 0.31 (Jun 2024) | TBD | TBD |
| cc (Alfalah *1349) | ~261.45 available | TBD | TBD |
| faysal_cc_a (*4012) | TBD | TBD | TBD |
| faysal_cc_b (*2551) | TBD | TBD | TBD |
| jazzcash_biz | TBD | TBD | TBD |

---

## People to Manually Review

The following people appear in transaction notes and may need debt/contact linking:

- **Yousra** — appears in UBL transfers
- **Nasir Ali Khan** — appears in meezan transfers
- **Qaseem Munir** — appears in UBL transfers
- **Nisar Ahmad** — occasional transfers

---

## Rollback Command

If anything goes wrong:

```
POST /api/import/rollback
{ "batch_id": "dd185a3f-24ed-408a-9471-9838cd0dc94e" }
→ Preview

POST /api/import/rollback
{ "batch_id": "dd185a3f-24ed-408a-9471-9838cd0dc94e", "confirm": true }
→ Delete all historical_import=1 with this batch_id
```

---

## How to Execute the Import

1. Open **https://sovereign-finance.pages.dev** in Chrome/Firefox
2. Open DevTools → Console (F12)
3. Paste the contents of `import/browser_full_import.js` and press Enter
4. Script runs: dry run → real import → debts → bills
5. Copy the FINAL SUMMARY numbers from the console
6. Verify in the app: /accounts, /debts, /bills, / (Hub)
