#!/bin/bash
# SessionStart hook: flags places where CLAUDE.md's factual claims have
# drifted from the actual repo state. Deterministic checks only (bindings,
# table names, migration numbering) — semantic claims like "is this known
# bug still true" are NOT checkable here and stay push-and-verify's job.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"

WARNINGS=""
add_warning() { WARNINGS="${WARNINGS}- $1
"; }

# 1. Bindings in wrangler.toml vs documented in CLAUDE.md
if [ -f wrangler.toml ]; then
  while IFS= read -r binding; do
    [ -z "$binding" ] && continue
    if ! grep -q "$binding" CLAUDE.md 2>/dev/null; then
      add_warning "wrangler.toml has binding \"${binding}\" not mentioned in CLAUDE.md's Bindings section"
    fi
  done < <(grep -oE '^binding = "[^"]+"' wrangler.toml | sed 's/binding = "//;s/"$//')
fi

# 2. Migration numbering — new gaps beyond the documented 14-16 one
if [ -d migrations ]; then
  nums=$(ls migrations/*.sql 2>/dev/null | grep -oE '/[0-9]+_' | tr -d '/_' | sort -n)
  prev=""
  for n in $nums; do
    n=$((10#$n))
    if [ -n "$prev" ]; then
      gap_start=$((prev + 1))
      gap_end=$((n - 1))
      if [ "$gap_end" -ge "$gap_start" ] && [ "$gap_start" -ne 14 ]; then
        add_warning "migrations/ has a numbering gap between ${prev} and ${n} that isn't the documented 14-16 gap — check CLAUDE.md's migration naming note"
      fi
    fi
    prev=$n
  done
fi

# 3. Required helpers actually exported from _lib.js
# (Note: the Key D1 tables list in CLAUDE.md is explicitly a non-exhaustive
# categorized summary with a grep command for the authoritative list, so we
# don't diff every table here — that would just be noise, not signal.)
if [ -f functions/api/_lib.js ]; then
  for fn in json uuid audit snapshot getUserId householdOf; do
    if ! grep -qE "export (async )?function ${fn}\b" functions/api/_lib.js 2>/dev/null; then
      add_warning "CLAUDE.md lists ${fn}() as a required helper but it's no longer exported from functions/api/_lib.js"
    fi
  done
fi

if [ -n "$WARNINGS" ]; then
  CONTEXT="STALE DOC CHECK (sovereign-finance/CLAUDE.md) — automated drift check found possible mismatches. Verify before trusting CLAUDE.md's claims, and fix CLAUDE.md if these are real:
${WARNINGS}"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput':{'hookEventName':'SessionStart','additionalContext': sys.argv[1]}}))" "$CONTEXT"
  else
    node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:process.argv[1]}}))" "$CONTEXT"
  fi
fi

exit 0
