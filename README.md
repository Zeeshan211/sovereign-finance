# sovereign-finance (Backend Only)

Personal finance API backend. Single-user with multi-user-ready schema.

**This repository is BACKEND-ONLY.** Frontend lives in https://github.com/Zeeshan211/LiquidityOS

## Architecture

- **Backend**: Cloudflare Pages Functions + D1 SQLite database
- **Frontend (separate repo)**: LiquidityOS React app at https://liquidityos.sherk3344.workers.dev
- **API base URL**: https://sovereign-finance.pages.dev/api/*

## Status

Production. Serving the LiquidityOS frontend. 44+ API endpoints. Multi-user schema in place (single-user mode active).

## Key Files

- functions/api/ — All API endpoint handlers (Cloudflare Pages Functions)
- migrations/ — D1 database migrations (versioned SQL)
- CLAUDE.md — Working spec for Claude Code sessions on this repo
- BACKEND_COMPLETE_PLAN.md — Comprehensive backend plan + audit
- D1_SCHEMA_SNAPSHOT.md — Live database schema reference
- LEGACY_FINANCE_INVENTORY.md — Inventory of original Apps Script finance system (source repo: sovereign-ops-private_sheet)

## How to Work on This Repo

1. Read CLAUDE.md first (mandatory)
2. Read BACKEND_COMPLETE_PLAN.md to understand what's planned
3. Read D1_SCHEMA_SNAPSHOT.md to understand current database
4. Push directly to main, no branches, no PRs (see CLAUDE.md)

## Deployment

Auto-deploys to https://sovereign-finance.pages.dev on every push to main via Cloudflare Pages.

## Reconciliation — How to Commit a Dry-Run Plan (v0.3)

After running a dry-run via `POST /api/reconciliation/dry-run` and receiving a `plan_id`, you can
commit the safe rows to the ledger in two steps from the UI or via API:

### Step 1 — Run a dry-run (Phase 1, unchanged)

```bash
# Import statement CSV
curl -X POST https://sovereign-finance.pages.dev/api/reconciliation/import-statement \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"meezan","csv_text":"date,description,debit,credit,balance\n..."}'
# Returns: { "import_id": "stmt_import_..." }

# Run dry-run matching engine
curl -X POST https://sovereign-finance.pages.dev/api/reconciliation/dry-run \
  -H 'Content-Type: application/json' \
  -d '{"import_id":"stmt_import_...","account_id":"meezan"}'
# Returns: { "plan_id": "recon_plan_...", "plan": [...], "classification_counts": {...} }
```

### Step 2 — Commit safe rows (Phase 2, new)

```bash
curl -X POST https://sovereign-finance.pages.dev/api/reconciliation/commit \
  -H 'Content-Type: application/json' \
  -d '{
    "plan_id": "recon_plan_...",
    "confirm": true,
    "idempotency_key": "commit-meezan-2026-05-25"
  }'
```

**Response:**
```json
{
  "ok": true,
  "version": "reconciliation-v0.3",
  "plan_id": "recon_plan_...",
  "committed_count": 4,
  "committed_transaction_ids": ["tx_...", "tx_...", "tx_...", "tx_..."],
  "skipped_count": 0,
  "skipped_to_exceptions": [],
  "projected_balance_before": 448.01,
  "projected_balance_after": 10.01,
  "warnings": []
}
```

**Rules:**
- Only `MISSING_SAFE_TO_IMPORT` and `TRANSFER_PAIR_FOUND` rows are committed.
- `POSSIBLE_DUPLICATE`, `PENDING_UNPOSTED`, `NEEDS_REVIEW`, `TRANSFER_PAIR_MISSING`, `DO_NOT_IMPORT` are never auto-committed.
- Re-running the same `plan_id` is idempotent — returns `committed_count: 0`, `is_idempotent: true`.
- Failed commits are written to `reconciliation_exceptions` as `NO_STATEMENT_PROOF`.

### Step 3 — Resolve an exception (Phase 2, new)

```bash
curl -X POST https://sovereign-finance.pages.dev/api/reconciliation/exceptions/exc_.../resolve \
  -H 'Content-Type: application/json' \
  -d '{"resolution_note": "Verified duplicate — original entry exists"}'
```

### Migration

Run `migrations/12_reconciliation_exceptions.sql` once against D1 to add the Phase 2 columns:

```bash
wrangler d1 execute sovereign-finance-db --file migrations/12_reconciliation_exceptions.sql
```

Duplicate-column errors on the `ALTER TABLE` lines can be ignored (column already exists from Phase 1).
