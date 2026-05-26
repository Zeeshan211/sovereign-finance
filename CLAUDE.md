# Sovereign Finance — Claude Code Rules

## Inheritance
This project inherits universal rules from:
https://github.com/Zeeshan211/claude-config/blob/main/CLAUDE.md

Claude MUST read claude-config/CLAUDE.md and claude-config/skills/*/SKILL.md at session start.
Universal rules apply UNLESS explicitly overridden here.

## Identity
- Repo: github.com/Zeeshan211/sovereign-finance
- Live: https://sovereign-finance.pages.dev
- Purpose: Backend API for LiquidityOS personal finance app
- Stack: Cloudflare Pages Functions (Workers runtime), D1 (SQLite), JavaScript — NO HTML/CSS/browser JS

## Project-specific conventions

### Append-only ledger (strict)
- transactions, bill_payments, debt_payments tables are IMMUTABLE
- DELETE/PUT on /api/transactions/:id → return 405 Method Not Allowed
- Edits = reversal + re-entry only via /api/transactions/reverse

### Canonical action-based POST
- All mutations: {action: "verb_noun", ...fields}
- Examples: create_contract, add_payslip, pay, reverse, defer, archive

### Migration naming
- Format: NN_descriptive_name.sql (e.g. 17_statement_files.sql)
- Always IF NOT EXISTS for tables; NULLABLE or DEFAULT for new columns on existing tables
- Sequential numbering (no gaps, no duplicates)

### Required helpers
- Use functions/api/_lib.js: json(), uuid(), audit(), snapshot()
- Never reimplement these inline

### User scoping (strict)
- Every query MUST include WHERE user_id = :session_uid
- No "OR user_id IS NULL" fallbacks (data leak vector)
- Audit log every mutation

## Bindings (keep in sync with wrangler.toml)
- DB → D1 database "sovereign-finance"
- STATEMENTS → R2 bucket "liquidityos-statements"
- GEMINI_API_KEY → secret
- MIGRATION_SECRET → secret

## Session docs to read (at session start)
1. BACKEND_AUDIT.md (if exists — definitive endpoint inventory)
2. BACKEND_FIX_PLAN.md (if exists — prioritized fix list)

## Key D1 tables
accounts, transactions, categories, merchants, bills, debts, snapshots

## Known bugs (unfixed — carry forward until resolved)
1. /api/add/dry-run returns plain JS object, not Response → Cloudflare falls back to GET → "Unsupported GET route." Frontend workaround: bypass to /api/transactions?dry_run=1
2. transactions missing idempotency_key column → backend rejects field. Frontend workaround: not sending it.

## Stop conditions specific
- wrangler.toml change → verify ALL existing bindings preserved before push
- Migration touches transactions table → double-check append-only rule preserved
- Endpoint returns plain JS object → fix to new Response() before push
- Any change to _middleware.js → smoke test login + register immediately after deploy

## Skills mandatory for this project
- bug-diagnoser when API errors reported
- push-and-verify after backend changes
- budget-guardian on tasks >5% budget
