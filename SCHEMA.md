# D1 SCHEMA SNAPSHOT

**Last updated:** 2026-05-04 (post Sub-1D-DEBT-TOTAL diagnostic)
**Source:** PRAGMA table_info() output from production D1 console
**Update protocol:** re-run `PRAGMA table_info(<table>)` and update this file
whenever a schema migration runs. Glean reads this file before writing any SQL
against any table (mandatory schema-read rule, locked 2026-05-04).

12 live tables. Backup tables (`*_backup_*`) excluded.

---

## accounts (17 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| name | TEXT | 1 | — | 0 |
| icon | TEXT | 0 | — | 0 |
| type | TEXT | 1 | — | 0 |
| kind | TEXT | 1 | — | 0 |
| opening_balance | REAL | 0 | 0 | 0 |
| currency | TEXT | 0 | 'PKR' | 0 |
| color | TEXT | 0 | — | 0 |
| display_order | INTEGER | 0 | 0 | 0 |
| created_at | TEXT | 0 | CURRENT_TIMESTAMP | 0 |
| status | TEXT | 0 | 'active' | 0 |
| deleted_at | TEXT | 0 | — | 0 |
| archived_at | TEXT | 0 | — | 0 |
| credit_limit | REAL | 0 | — | 0 |
| min_payment_amount | REAL | 0 | — | 0 |
| statement_day | INTEGER | 0 | — | 0 |
| payment_due_day | INTEGER | 0 | — | 0 |

## audit_log (9 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| timestamp | TEXT | 1 | datetime('now') | 0 |
| action | TEXT | 1 | — | 0 |
| entity | TEXT | 0 | — | 0 |
| entity_id | TEXT | 0 | — | 0 |
| kind | TEXT | 0 | 'mutation' | 0 |
| detail | TEXT | 0 | — | 0 |
| created_by | TEXT | 0 | 'system' | 0 |
| ip | TEXT | 0 | — | 0 |

## bills (11 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| name | TEXT | 1 | — | 0 |
| amount | REAL | 1 | — | 0 |
| due_day | INTEGER | 0 | — | 0 |
| frequency | TEXT | 0 | 'monthly' | 0 |
| category_id | TEXT | 0 | — | 0 |
| default_account_id | TEXT | 0 | — | 0 |
| last_paid_date | TEXT | 0 | — | 0 |
| auto_post | INTEGER | 0 | 0 | 0 |
| status | TEXT | 0 | 'active' | 0 |
| deleted_at | TEXT | 0 | — | 0 |

## budgets (4 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| category_id | TEXT | 0 | — | 1 |
| monthly_amount | REAL | 1 | 0 | 0 |
| notes | TEXT | 0 | — | 0 |
| status | TEXT | 0 | 'active' | 0 |

## categories (8 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| name | TEXT | 1 | — | 0 |
| icon | TEXT | 0 | — | 0 |
| type | TEXT | 0 | — | 0 |
| parent_id | TEXT | 0 | — | 0 |
| monthly_budget | REAL | 0 | 0 | 0 |
| color | TEXT | 0 | — | 0 |
| display_order | INTEGER | 0 | 0 | 0 |

## debts (10 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| name | TEXT | 1 | — | 0 |
| kind | TEXT | 1 | — | 0 |
| original_amount | REAL | 1 | — | 0 |
| paid_amount | REAL | 0 | 0 | 0 |
| snowball_order | INTEGER | 0 | — | 0 |
| due_date | TEXT | 0 | — | 0 |
| status | TEXT | 0 | 'active' | 0 |
| notes | TEXT | 0 | — | 0 |
| created_at | TEXT | 0 | CURRENT_TIMESTAMP | 0 |

**Computed field:** `outstanding = original_amount - paid_amount`. No physical column.

## goals (9 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| name | TEXT | 1 | — | 0 |
| target_amount | REAL | 1 | — | 0 |
| current_amount | REAL | 1 | 0 | 0 |
| deadline | TEXT | 0 | — | 0 |
| source_account_id | TEXT | 0 | — | 0 |
| status | TEXT | 1 | 'active' | 0 |
| display_order | INTEGER | 1 | 0 | 0 |
| notes | TEXT | 0 | — | 0 |

## merchants (8 cols, currently unused by app)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| name | TEXT | 1 | — | 0 |
| aliases | TEXT | 0 | — | 0 |
| default_category_id | TEXT | 0 | — | 0 |
| default_account_id | TEXT | 0 | — | 0 |
| is_pra_required | INTEGER | 0 | 0 | 0 |
| learned_count | INTEGER | 0 | 0 | 0 |
| created_at | TEXT | 0 | CURRENT_TIMESTAMP | 0 |

## reconciliation (7 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| account_id | TEXT | 0 | — | 1 |
| declared_balance | REAL | 1 | — | 0 |
| declared_at | TEXT | 1 | datetime('now') | 0 |
| declared_by | TEXT | 0 | 'operator' | 0 |
| notes | TEXT | 0 | — | 0 |
| id | TEXT | 0 | — | 0 |
| diff_amount | REAL | 0 | — | 0 |

## settings (3 cols, currently unused by app)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| key | TEXT | 0 | — | 1 |
| value | TEXT | 1 | — | 0 |
| updated_at | TEXT | 0 | CURRENT_TIMESTAMP | 0 |

## snapshot_data (5 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | INTEGER | 0 | — | 1 |
| snapshot_id | TEXT | 1 | — | 0 |
| table_name | TEXT | 1 | — | 0 |
| row_count | INTEGER | 1 | 0 | 0 |
| json_data | TEXT | 1 | — | 0 |

## snapshots (7 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| created_at | TEXT | 1 | datetime('now') | 0 |
| label | TEXT | 1 | — | 0 |
| status | TEXT | 1 | 'complete' | 0 |
| row_count_total | INTEGER | 1 | 0 | 0 |
| created_by | TEXT | 0 | 'system' | 0 |
| notes | TEXT | 0 | — | 0 |

## transactions (17 cols)

| col | type | notnull | default | pk |
|---|---|---|---|---|
| id | TEXT | 0 | — | 1 |
| date | TEXT | 1 | — | 0 |
| type | TEXT | 1 | — | 0 |
| amount | REAL | 1 | — | 0 |
| account_id | TEXT | 1 | — | 0 |
| transfer_to_account_id | TEXT | 0 | — | 0 |
| category_id | TEXT | 0 | — | 0 |
| merchant_id | TEXT | 0 | — | 0 |
| notes | TEXT | 0 | — | 0 |
| fee_amount | REAL | 0 | 0 | 0 |
| pra_amount | REAL | 0 | 0 | 0 |
| is_pending_reversal | INTEGER | 0 | 0 | 0 |
| reversal_due_date | TEXT | 0 | — | 0 |
| created_at | TEXT | 0 | CURRENT_TIMESTAMP | 0 |
| reversed_by | TEXT | 0 | — | 0 |
| reversed_at | TEXT | 0 | — | 0 |
| linked_txn_id | TEXT | 0 | — | 0 |

---

## SCHEMA QUIRKS / GOTCHAS

- **debts has NO `outstanding` column** — compute as `original_amount - paid_amount`
- **debts has NO `closed_at` column** — closed via `status != 'active'`
- **bills + accounts use status + deleted_at pattern** (status='active'/'archived'/'deleted', deleted_at timestamp)
- **debts uses ONLY status pattern** (status='active'/'closed', no deleted_at)
- **budgets uses category_id as PK** (no separate id column, one budget per category)
- **reconciliation has BOTH account_id (pk) AND id (non-pk)** — id is for individual reconciliation events, account_id pks the latest declared balance per account
- **transactions has merchant_id column** — currently unused by app, populated when merchants module ships
- **merchants + settings tables seeded but currently unused** by app code

---

## UPDATE PROTOCOL

When you run a schema migration:
1. Run `PRAGMA table_info(<changed_table>)` in D1 console
2. Replace that table's section in this file with new output
3. Bump the "Last updated" date at top
4. Commit with message: `SCHEMA.md update — <table> migration <YYYY-MM-DD>`

Glean reads this file before writing SQL against any table. If schema in this
file disagrees with what Glean expects, schema in this file wins.
