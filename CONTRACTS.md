# Sovereign Finance Contracts

## Purpose

This document defines the non-negotiable contracts for Sovereign Finance.

The goal is to make the app reliable for daily personal finance usage by ensuring every money action has a clear backend owner, ledger proof, account impact, reversal behavior, audit trail, and forecast visibility.

Pages must not invent financial logic. Frontend pages render backend truth only.

---

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
