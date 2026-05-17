# Categories and Merchants Contract

## Purpose

Categories and Merchants define how transactions are classified, searched, reported, and summarized across Sovereign Finance.

This contract hardens the classification loop:

```txt
Transaction
→ category / merchant classification
→ ledger reporting
→ bills / debts / salary / forecast grouping
→ charts / insights / monthly close summaries
```

Categories and Merchants must never become money owners.

They describe money movement. They do not create money movement.

## Contract Version

`categories-merchants-v1`

## Ownership

Canonical backend owners:

```txt
functions/api/categories.js
functions/api/merchants.js
```

Allowed supporting routes:

```txt
functions/api/categories/health.js
functions/api/merchants/health.js
```

Canonical frontend owners:

```txt
merchants.html
js/merchants.js
```

Category selection may also appear in:

```txt
add.html
transactions.html
bills.html
debts.html
forecast.html
charts.html
insights.html
monthly-close.html
```

But category and merchant truth must come from canonical backend APIs.

## Core Rule

Categories and Merchants classify transactions.

They must not directly change:

- account balances
- debt paid amount
- bill paid amount
- salary expected income
- forecast cash position
- reconciliation snapshots

Correct flow:

```txt
User creates/updates classification
→ backend validates category/merchant
→ transactions reference classification
→ reports read classification
→ money totals still come from ledger
```

## Category Source of Truth

Categories should be backend-owned.

A category row should include:

- id
- name
- type
- parent_id if hierarchical
- status
- color/icon if UI uses it
- created_at
- updated_at

Category type must be explicit.

Recommended category types:

| Type | Meaning |
|---|---|
| income | Income classification |
| expense | Expense classification |
| transfer | Transfer classification |
| debt | Debt-related classification |
| bill | Bill-related classification |
| salary | Salary-related classification |
| adjustment | Manual/reconciliation adjustment |
| system | Internal/system category |

## Merchant Source of Truth

Merchants should be backend-owned.

A merchant row should include:

- id
- name
- normalized_name
- default_category_id
- status
- notes
- created_at
- updated_at

Merchants may help auto-classify transactions, but merchant auto-classification must not override backend transaction proof silently.

## Category Status Vocabulary

Supported statuses:

| Status | Meaning |
|---|---|
| active | Available for new transactions |
| archived | Hidden from normal selection but preserved for history |
| deleted | Soft-deleted only |
| system | Protected category |

Hard-deleting categories used by transactions is not allowed.

## Merchant Status Vocabulary

Supported statuses:

| Status | Meaning |
|---|---|
| active | Available for transaction classification |
| archived | Hidden from normal selection but preserved for history |
| deleted | Soft-deleted only |

Hard-deleting merchants used by transactions is not allowed.

## Required Category API Output

Category list response should include:

```json
{
  "ok": true,
  "contract_version": "categories-merchants-v1",
  "categories": [
    {
      "id": "food",
      "name": "Food",
      "type": "expense",
      "status": "active",
      "parent_id": null
    }
  ],
  "warnings": []
}
```

## Required Merchant API Output

Merchant list response should include:

```json
{
  "ok": true,
  "contract_version": "categories-merchants-v1",
  "merchants": [
    {
      "id": "merchant_example",
      "name": "Example Merchant",
      "normalized_name": "example merchant",
      "default_category_id": "food",
      "status": "active"
    }
  ],
  "warnings": []
}
```

## Category Create Contract

Creating a category must:

- validate name
- validate type
- prevent duplicate active category names within same type
- create category row
- not create ledger transaction
- not change account balance
- return proof

Preferred request:

```json
{
  "action": "create",
  "name": "Food",
  "type": "expense",
  "parent_id": null,
  "status": "active"
}
```

Required response:

```json
{
  "ok": true,
  "action": "category_create",
  "contract_version": "categories-merchants-v1",
  "category": {
    "id": "food",
    "name": "Food",
    "type": "expense",
    "status": "active"
  },
  "ledger": {
    "changed": false
  },
  "warnings": []
}
```

## Merchant Create Contract

Creating a merchant must:

- validate name
- normalize merchant name
- prevent duplicate active normalized names
- validate default category if supplied
- create merchant row
- not create ledger transaction
- not change account balance
- return proof

Preferred request:

```json
{
  "action": "create",
  "name": "Example Merchant",
  "default_category_id": "food",
  "notes": "Common grocery merchant"
}
```

Required response:

```json
{
  "ok": true,
  "action": "merchant_create",
  "contract_version": "categories-merchants-v1",
  "merchant": {
    "id": "merchant_example",
    "name": "Example Merchant",
    "normalized_name": "example merchant",
    "default_category_id": "food",
    "status": "active"
  },
  "ledger": {
    "changed": false
  },
  "warnings": []
}
```

## Transaction Classification Contract

Transactions may reference:

- category_id
- merchant_id
- merchant text/name

If category is required for a transaction type, backend must validate it before transaction commit.

If merchant default category is used, backend must return proof:

```json
{
  "classification": {
    "merchant_id": "merchant_example",
    "category_id": "food",
    "category_source": "merchant_default"
  }
}
```

Frontend must not silently assign authoritative category if backend rejects it.

## Category Type Compatibility

Backend should validate category compatibility with transaction type.

Recommended compatibility:

| Transaction Type | Allowed Category Types |
|---|---|
| income | income, salary, system |
| expense | expense, bill, debt, adjustment, system |
| transfer_in | transfer, system |
| transfer_out | transfer, system |
| adjustment_positive | adjustment, system |
| adjustment_negative | adjustment, system |

If compatibility is not enforced yet, backend must at least return warning when mismatched.

## Bills Connection

Bills may reference category_id.

Rules:

- bill category must exist if supplied
- archived categories may remain on historical bills
- active bill creation should not use archived/deleted category
- bill payment ledger row should carry bill/category linkage when supported

Bills category does not control bill paid/remaining math.

## Debts Connection

Debts may reference category_id if supported.

Rules:

- debt origin/payment category must be compatible
- debt ledger markers remain primary linkage
- category cannot replace `debt_id` source linkage

Debt category does not control debt paid/remaining math.

## Salary Connection

Salary payout may use salary category.

Rules:

- salary category must be income-compatible
- salary expected income still comes from Salary contract
- category cannot create salary income by itself

## Forecast Connection

Forecast may group events by category/merchant.

Forecast must not use category/merchant classification to change cash totals.

Correct behavior:

```txt
cash totals from ledger/accounts
classification from category/merchant
```

Forecast may show category-level outflow summaries but the source amount must come from backend transaction/bill/debt data.

## Charts and Insights Connection

Charts and Insights may use categories and merchants for grouping.

Allowed summaries:

- spend by category
- income by category
- top merchants
- recurring merchant patterns
- uncategorized transaction count
- category drift warnings

Charts/Insights must not mutate category or merchant data unless user explicitly edits classification through canonical route.

## Monthly Close Connection

Monthly Close may use category/merchant summaries for review.

Monthly Close must not block solely because a transaction is uncategorized unless policy requires categorization completeness.

If categorization completeness is required, backend must return it as a warning or exception based on policy.

## Reconciliation Connection

Reconciliation does not depend on categories/merchants for balance truth.

Reconciliation may show category/merchant context for adjustment transactions, but observed-vs-ledger balance must not depend on classification.

## Audit Contract

Category and merchant actions should be audit logged.

Audited actions:

- category_create
- category_update
- category_archive
- category_delete_rejected
- merchant_create
- merchant_update
- merchant_archive
- merchant_delete_rejected
- transaction_recategorize
- merchant_default_category_update

Audit minimum fields:

- timestamp
- route
- action
- category_id if applicable
- merchant_id if applicable
- transaction_id if recategorizing
- before summary
- after summary
- result
- warnings

## Health Check Requirements

Categories/Merchants health must verify:

1. Active transactions do not reference missing categories.
2. Active transactions do not reference missing merchants.
3. Active bills do not reference missing categories.
4. Active merchants do not reference missing default categories.
5. Deleted categories are not used for new writes.
6. Archived categories remain valid for historical rows.
7. Duplicate active category names are flagged.
8. Duplicate active merchant normalized names are flagged.
9. Category type compatibility warnings are reported.
10. Contract version is reported.

Suggested health output:

```json
{
  "ok": true,
  "contract_version": "categories-merchants-v1",
  "checks": {
    "transaction_categories_valid": true,
    "transaction_merchants_valid": true,
    "bill_categories_valid": true,
    "merchant_default_categories_valid": true,
    "duplicates_absent": true,
    "type_compatibility_valid": true
  },
  "counts": {
    "categories": 0,
    "merchants": 0,
    "missing_category_refs": 0,
    "missing_merchant_refs": 0,
    "duplicate_categories": 0,
    "duplicate_merchants": 0,
    "uncategorized_transactions": 0
  },
  "warnings": []
}
```

## Frontend Contract

Frontend may:

- render category list
- render merchant list
- create/update/archive categories
- create/update/archive merchants
- select category during transaction creation
- select merchant during transaction creation
- show uncategorized warnings
- show category/merchant reports

Frontend must not:

- directly mutate account balance
- infer authoritative money totals from category alone
- delete used categories permanently
- delete used merchants permanently
- silently recategorize transactions without backend confirmation
- hide backend classification warnings

## UI Layout Contract

Categories/Merchants pages must use the shared app shell.

Preferred layout:

```txt
compact status strip
KPI strip: categories / merchants / uncategorized / warnings
filter toolbar
compact category rows
compact merchant rows
expandable detail drawer
```

Do not introduce:

- oversized standalone panels
- foreign visual blocks
- page-specific design systems
- duplicated hero cards

## Canonical API Routes

Preferred routes:

```txt
GET /api/categories
POST /api/categories
PATCH /api/categories/{id}
POST /api/categories/{id}/archive
GET /api/categories/health

GET /api/merchants
POST /api/merchants
PATCH /api/merchants/{id}
POST /api/merchants/{id}/archive
GET /api/merchants/health
```

If existing routes differ, stale routes must become shims or be removed after frontend migration.

## Required Frontend Submit Shapes

### Create category

```json
{
  "action": "create",
  "name": "Food",
  "type": "expense",
  "parent_id": null
}
```

### Create merchant

```json
{
  "action": "create",
  "name": "Example Merchant",
  "default_category_id": "food",
  "notes": "Common merchant"
}
```

### Update merchant default category

```json
{
  "action": "update_default_category",
  "merchant_id": "merchant_example",
  "default_category_id": "groceries"
}
```

### Recategorize transaction

```json
{
  "action": "recategorize_transaction",
  "transaction_id": "tx_example",
  "category_id": "food",
  "merchant_id": "merchant_example"
}
```

## Stale Route Policy

Any stale category or merchant route must be handled as one of:

1. canonical implementation
2. shim forwarding to canonical implementation
3. removed after frontend migration

Stale routes must not:

- calculate money totals
- mutate transaction amount
- mutate account balance
- hard-delete used classifications
- skip audit/proof response

## Acceptance Tests

### Test 1: Create category

Input:

```txt
name = Food
type = expense
```

Expected:

```txt
category created
no ledger row created
account balance unchanged
category appears in transaction category selector
```

### Test 2: Create merchant with default category

Input:

```txt
merchant = Example Merchant
default_category = Food
```

Expected:

```txt
merchant created
normalized name stored
default category linked
no money state changed
```

### Test 3: Transaction uses merchant default category

Input:

```txt
manual expense with merchant default category
```

Expected:

```txt
transaction category is assigned by backend or accepted by backend
response includes classification proof
ledger amount and account impact unchanged by classification itself
```

### Test 4: Missing category rejected

Input:

```txt
create transaction with category_id that does not exist
```

Expected:

```txt
request rejected or warning returned based on current policy
no partial money write if category is required
```

### Test 5: Archive used category

Input:

```txt
archive category used by historical transactions
```

Expected:

```txt
category archived
historical transactions still display category
new transactions cannot use archived category by default
```

### Test 6: Duplicate merchant normalized name

Input:

```txt
create merchant "KFC"
create merchant "kfc"
```

Expected:

```txt
duplicate detected
second create rejected or merged through explicit flow
```

### Test 7: Charts grouping

Input:

```txt
transactions grouped by category
```

Expected:

```txt
chart totals match ledger transaction amounts
category only controls grouping
```

### Test 8: Health detects orphan category

Input:

```txt
transaction references missing category
```

Expected:

```txt
health warning returned
Hub can surface warning
money totals remain ledger-derived
```

## Implementation Order

1. Confirm current categories and merchants APIs.
2. Confirm category IDs used in real D1 data.
3. Confirm transactions category/merchant fields.
4. Align Add Transaction category validation.
5. Add merchant normalized-name rule.
6. Add archive-not-hard-delete behavior.
7. Add category/merchant health checks.
8. Bind frontend selectors to backend source.
9. Run acceptance tests.
10. Move to Credit Cards contract.

## Non-Negotiable Close Criteria

Categories/Merchants are contract-safe only when:

- categories and merchants are backend-owned
- classification does not mutate money
- used categories/merchants are not hard-deleted
- transaction category references are valid
- merchant defaults are validated
- frontend renders backend classification truth
- charts/insights use classification only for grouping
- health reports orphan/duplicate classification issues
- audit records classification changes
- contract version is reported

Until these pass, reporting cannot be considered banking-grade.
