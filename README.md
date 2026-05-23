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
