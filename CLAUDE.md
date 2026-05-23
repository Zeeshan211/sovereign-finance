# CLAUDE.md — sovereign-finance Backend Working Spec

> Read this file in full at the start of every session. Every rule here is non-negotiable.

## 1. Project Identity

sovereign-finance is the canonical ledger backend for the LiquidityOS personal finance system. Cloudflare Pages + D1 database. Read-mostly architecture with selective writes.

This repo is BACKEND ONLY. No frontend code. No HTML, no CSS, no JS for browser. All frontend work happens in the separate Zeeshan211/LiquidityOS repository (React + Vite, deploys to liquidityos.sherk3344.workers.dev). Any session on sovereign-finance that touches HTML, CSS, JS for browser, or React components is a mistake and should STOP. This repo's sole job: serve /api/* endpoints from Cloudflare Pages Functions.

Tech stack: Cloudflare Pages Functions, D1 (SQLite), JavaScript (functions/api/*.js).

Live URL: https://sovereign-finance.pages.dev

Frontend consumer: LiquidityOS Worker at https://liquidityos.sherk3344.workers.dev — proxies /api/* through to this backend.

## 2. Project Mission

This is the single source of truth for personal financial data. Transactions, accounts, balances, categories, debts, bills — all computed and served from here. Frontend must never compute authoritative balances; it asks here.

## 3. Hard Rules — Never Break

1. Push directly to main. NEVER create branches. NEVER open PRs.
2. Push after EVERY atomic commit, not at the end of a session.
3. NEVER use git reset --hard to resolve push conflicts. Use git stash → git pull --no-rebase → git stash pop → git push.
4. After every push, verify with git log origin/main --oneline -3 that the commit landed.
5. If usage limit warning appears, push current state immediately.
6. NEVER modify D1 data destructively (DROP TABLE, DELETE without WHERE) without explicit user confirmation.
7. D1 migrations must be backward-compatible. New columns: add as NULLABLE or with DEFAULT. Never remove a column the frontend depends on.
8. Every endpoint handler MUST return a Cloudflare Response object (new Response or Response.json()). Returning plain JavaScript objects causes Cloudflare Pages to fall back to alternate handlers — the dryRun bug is exactly this pattern.
9. Every endpoint MUST be tested against its actual HTTP method. Verify GET vs POST vs PATCH vs DELETE before declaring an endpoint complete.
10. No console.log in committed code. Use proper logging only.
11. Schema changes must include a migration file in migrations/ (or wherever migrations live) so they're versioned and replayable.
12. Frontend assumptions about response shapes are real contracts. Don't change response shapes without updating LiquidityOS frontend in lockstep.

## 4. Session Workflow

At session start (mandatory):
1. Read CLAUDE.md (this file).
2. Read BACKEND_AUDIT.md if it exists (the inventory report).
3. Read BACKEND_FIX_PLAN.md if it exists (the prioritized fix list).
4. State the task plainly.

During work:
1. Read source extensively before writing.
2. For schema changes: write the migration SQL FIRST, test it locally if possible, THEN write the endpoint handler.
3. Atomic commits, push after each.
4. Test every endpoint with curl or browser DevTools against the live URL after deploy.
5. If a fix touches more than one endpoint, commit each separately.

## 5. Git Safety Patterns

Same as LiquidityOS CLAUDE.md section 5. If push rejected:

    git stash
    git pull --no-rebase
    git stash pop
    git push origin main

NEVER git reset --hard. NEVER git push --force.

## 6. Quality Gates (every commit)

- Endpoint returns proper Response object (not plain JS object)
- HTTP method matches what frontend expects
- D1 schema migration committed alongside endpoint code
- No console.log
- git log origin/main --oneline -3 shows latest commit

## 7. Known Backend Bugs (discovered by LiquidityOS frontend)

These need fixing. Listed for future Claude sessions to address:

1. /api/add/dry-run handler returns plain JavaScript object instead of Response. Cloudflare Pages falls back to GET handler, returns "Unsupported GET route." Workaround in frontend: bypass to /api/transactions?dry_run=1.
2. transactions table missing idempotency_key column. Frontend sends it but backend rejects with "table has no idempotency_key column." Workaround in frontend: stop sending the field.

Both should be properly fixed here in sovereign-finance.

## 8. D1 Schema Awareness

This backend uses D1 (Cloudflare's SQLite). Schema is in migrations/ directory (or top-level .sql files).

Key tables (verify these exist before assuming):
- accounts
- transactions
- categories
- merchants
- bills
- debts
- snapshots

If a table or column you expect is missing, STOP and ask before adding. The frontend may have assumed something that needs design discussion.

## 9. Endpoint Inventory (to be replaced by BACKEND_AUDIT.md when written)

This section will be fleshed out by the audit session. For now, known endpoint families:

- /api/health
- /api/balances
- /api/accounts (GET only currently — POST returns 405)
- /api/transactions (GET, POST, dry-run via query param)
- /api/transactions/reverse
- /api/transactions/{id}
- /api/categories
- /api/merchants/* (full CRUD + match + touch + seed)
- /api/bills/* (full CRUD)
- /api/debts/* (full CRUD)
- /api/add/context (one-call form bootstrap)
- /api/add/dry-run (BROKEN — see section 7)
- /api/add/commit, /api/add/save
- /api/add/preview
- /api/hub, /api/forecast, /api/insights, /api/snapshots, /api/salary, /api/ledger, /api/audit, /api/finance-command-center, /api/monthly-close, /api/intl-rates, /api/atm, /api/cc, /api/reconciliation, /api/nano-loans

The audit will produce the definitive list.

## 10. Communication

- Same as LiquidityOS CLAUDE.md section 9
- User is non-technical, plain English
- Lead with status, end with concrete next steps
- User is on a token budget — don't over-engineer

## 11. Budget Discipline

- Audit session (read-only inventory): 6-8% of monthly budget
- Schema migration + endpoint fix (atomic): 3-5%
- Multi-endpoint fix session: 10-15%

To reduce burn:
- Inventory FIRST, fix LATER
- Read schema before writing migrations
- Test against live URL after each push instead of guessing
- Stop after each working endpoint, push, verify, move on

## 12. What to Do If About to Make a Mistake

Stop. Ask user. Give 2-3 options.

Specifically stop before:
- Running git reset --hard
- Creating a branch or PR
- Dropping a D1 table or column
- Running DELETE without WHERE
- Modifying the schema in a way that breaks frontend
- Changing an endpoint response shape without coordinating with LiquidityOS
