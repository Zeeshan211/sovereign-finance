-- Migration 07: Set type column on all categories (data migration)
-- Run: wrangler d1 execute sovereign-finance --file=migrations/07_category_types_data.sql
-- Safe to run multiple times (idempotent SET).

UPDATE categories SET type = 'expense'
  WHERE id IN ('food', 'grocery', 'transport', 'bills', 'health', 'personal', 'family', 'gift', 'cc_spend', 'biller');

UPDATE categories SET type = 'income'
  WHERE id = 'salary';

UPDATE categories SET type = 'transfer'
  WHERE id = 'transfer';

UPDATE categories SET type = 'system'
  WHERE id IN ('debt', 'cc_pay', 'other');

-- Verify:
-- SELECT id, name, type FROM categories ORDER BY type, name;
-- SELECT COUNT(*) FROM categories WHERE type IS NULL;  -- Should be 0
