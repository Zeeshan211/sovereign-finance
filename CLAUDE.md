# Sovereign Finance — Claude Code Rules

## Inheritance
- Read ~/projects/claude-config/CLAUDE.md once at session start
- Skills auto-load from ~/.claude/skills/ — load ONLY skills triggered by task
- Never preload all skills (~15-20% budget waste per 2026-05-27 audit)

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
- Sequential numbering (no gaps, no duplicates) — note: 14-16 are missing from history
  (jumps from 13_auth_rate_limits.sql to 17_statement_files.sql); don't reuse those
  numbers, keep numbering forward from the latest file
- Latest migration: check `ls migrations/ | sort | tail -1` — don't hardcode a number here

### Required helpers
- Use functions/api/_lib.js: json(), uuid(), audit(), snapshot(), getUserId(context),
  householdOf(context)
- Never reimplement these inline

### User scoping (strict)
- Every query MUST include WHERE user_id = :session_uid
- No "OR user_id IS NULL" fallbacks (data leak vector)
- Audit log every mutation

## Bindings (keep in sync with wrangler.toml)
- DB → D1 database "sovereign-finance"
- STATEMENTS → R2 bucket "liquidityos-statements"
- AI → Cloudflare Workers AI binding
- GOOGLE_CLIENT_ID → var (in wrangler.toml `[vars]`, not a secret)
- GEMINI_API_KEY → secret (set via Cloudflare Pages dashboard, not wrangler.toml)
- MIGRATION_SECRET → secret (set via Cloudflare Pages dashboard, not wrangler.toml)

## Session docs to read (at session start)
1. BACKEND_COMPLETE_PLAN.md (definitive build plan / endpoint inventory)
2. BACKEND_AUDIT.md / BACKEND_FIX_PLAN.md (if they exist — they don't currently)

## Key D1 tables
Core finance: accounts, transactions, categories, merchants, bills, debts, snapshots
Auth: users, sessions, login_attempts, password_reset_tokens, oauth_identities, user_2fa
Statements/reconciliation: statement_files, statement_imports, statement_transactions,
  reconciliation_sessions, reconciliation_plans, reconciliation_exceptions
Credit cards: credit_cards, card_statements, card_statement_transactions, card_fees,
  card_interest_accruals, card_subscriptions, card_disputes, card_trips, card_benefit_usage
Household: households, household_members, household_settlements
Other: salary_config, salary_payslips, idempotency_keys, transaction_dry_runs,
  onboarding_completed
Run `grep -h "CREATE TABLE" migrations/*.sql` for the authoritative current list.

## Known bugs (unfixed — carry forward until resolved)
None currently tracked. The two previously-listed bugs are fixed:
dry-run returns a proper Response via json() (functions/api/add/[[path]].js), and
idempotency_key was added to transactions in migration 04_known_bugs.sql.

## Stop conditions specific
- wrangler.toml change → verify ALL existing bindings preserved before push
- Migration touches transactions table → double-check append-only rule preserved
- Endpoint returns plain JS object → fix to new Response() before push
- Any change to _middleware.js → smoke test login + register immediately after deploy

## Skills mandatory for this project
- bug-diagnoser when API errors reported
- push-and-verify after backend changes
- budget-guardian on tasks >5% budget
