# Sovereign Finance Formula Spec

Version: v1.0  
Status: Ground Layer locked  
Last verified: 2026-05-05

## Purpose

This file is the source of truth for Sovereign Finance math.

If Cloudflare code disagrees with this file, the code is wrong.

## Canonical D1 transaction types

The Cloudflare D1 transactions.type vocabulary is:

- income
- expense
- transfer
- borrow
- repay
- cc_payment
- cc_spend
- atm

Sheet semantic mapping:

- Sheet Income -> D1 income
- Sheet Expense -> D1 expense
- Sheet Transfer -> D1 transfer
- Sheet Debt In -> D1 borrow
- Sheet Debt Out -> D1 repay

## Active transaction rule

A transaction is active only if it is not reversed.

Rows are considered reversed if either of these is true:

- reversed_by is not null
- reversed_at is not null
- notes contains [REVERSED BY ...]
- notes contains [REVERSAL OF ...]

Imported Sheet reversals may exist only in notes, so all formula APIs must bridge both models.

Verified current ledger:

- Total transactions: 110
- Active transactions: 78
- Hidden reversal rows: 32

## Account balance formula

For every account:

Balance(A) =
opening_balance
+ income
+ borrow
- expense
- repay
- transfer
- cc_spend
- atm

Fees and PRA amounts reduce the source account when present.

## Transfer model

Legacy Sheet transfers are two rows:

OUT row:

- type = transfer
- account_id = source account
- amount = X

IN row:

- type = income
- account_id = destination account
- amount = X
- notes contains From: ... [linked: ...]

Modern D1 transfers may use:

- type = transfer or cc_payment
- account_id = source account
- transfer_to_account_id = destination account
- amount = X

Current formula APIs must support both models.

Verified current transfer invariant:

- Legacy transfer OUT sum: 289764
- Legacy transfer IN sum: 289764
- Difference: 0

## Credit card outstanding

Credit card account balance uses the same account formula.

Outstanding is the inverse of the negative balance:

CC Outstanding = MAX(0, -Balance(Alfalah CC))

Verified current value:

- Alfalah CC balance: -78766.33
- CC outstanding: 78766.33

## Total liquid

Total liquid is the sum of all non-liability, non-credit-card account balances.

Verified current value:

- Total liquid: 16466.32

## Net worth

Net worth excludes personal debts and receivables.

Net Worth = Total Liquid - CC Outstanding

Verified current value:

- Net worth = 16466.32 - 78766.33
- Net worth = -62300.01

## Personal debts

Personal debts live in the debts table.

For each active debt:

Outstanding = MAX(0, original_amount - paid_amount)

Total owed:

Total Owed = SUM(active outstanding debts)

Verified current value:

- Total owed: 123500
- Active debt count: 2

## Receivables

Receivables are optional.

If the receivables table does not exist, APIs must treat receivables as zero and expose the missing table only in debug output.

Verified current value:

- Total receivables: 0
- Receivables table: not present

## True burden

True burden is the real recovery metric.

True Burden = Net Worth - Total Owed + Total Receivables

Verified current value:

- True burden = -62300.01 - 123500 + 0
- True burden = -185800.01

## APIs currently locked to this spec

- /api/balances v0.5.2
- /api/accounts v0.2.5
- /api/transactions v0.1.1

## UI currently aligned enough for Ground Layer verification

- hub.js v0.7.9
- transactions.js v0.7.2

## Ground Layer status

Read-side finance logic is locked.

- balances math: clean
- account math: clean
- transaction active/audit split: clean
- transfer invariant: clean
- reversal bridge: clean

## Next layer

After this spec is committed, move to Layer 2:

- API callers and write paths
- transaction create
- transfer create
- debt payment create
- reversal create
- account mutation safety
