# D1 Migration: Historical Import Columns

**Migration file:** `migrations/10_import_batch_columns.sql`

## What it adds

Two new columns to the `transactions` table:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `historical_import` | INTEGER | 0 | Flag: 1 = imported from bank statement |
| `import_batch_id` | TEXT | NULL | UUID of the import batch (for rollback) |

Plus one index:
- `idx_transactions_import_batch` on `(import_batch_id)`

## How to apply

### Option A — Cloudflare D1 Console (recommended)

1. Open Cloudflare Dashboard → D1 → sovereign-finance → Console
2. Paste and run:

```sql
ALTER TABLE transactions ADD COLUMN historical_import INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN import_batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_import_batch ON transactions(import_batch_id);
```

### Option B — wrangler CLI

```bash
wrangler d1 execute sovereign-finance --file=migrations/10_import_batch_columns.sql
```

## Verify it worked

```sql
PRAGMA table_info(transactions);
-- Look for historical_import and import_batch_id in the output
```

## Rollback (if needed)

SQLite does not support `DROP COLUMN` in older versions. To undo:
- These columns are additive and harmless if unused.
- All historical import transactions can be deleted by batch_id using `/api/import/rollback`.

## Batch ID for this session

`dd185a3f-24ed-408a-9471-9838cd0dc94e`
