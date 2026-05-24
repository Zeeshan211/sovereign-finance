# Import Workspace

This directory contains artifacts for the historical bank statement import.

## Batch ID
`dd185a3f-24ed-408a-9471-9838cd0dc94e`

## What's gitignored
- `import/pdfs/` — downloaded PDF files
- `import/extracted/` — per-PDF extracted text/tables
- `import/*.json` — parsed transaction data, dedup index, errors
- `import/parse_errors/` — per-line parse failures

## What's committed
- `import/README.md` — this file
- `import/dry_run_report.md` — pre-import audit
- `import/reconciliation.md` — post-import balance verification

## Rollback
If anything goes wrong, every imported transaction is tagged with the batch_id.
Rollback command (preview):
```bash
curl -X POST https://sovereign-finance.pages.dev/api/import/rollback \
  -H "Content-Type: application/json" \
  -d '{"batch_id": "dd185a3f-24ed-408a-9471-9838cd0dc94e"}'
```
Rollback command (real):
```bash
curl -X POST https://sovereign-finance.pages.dev/api/import/rollback \
  -H "Content-Type: application/json" \
  -d '{"batch_id": "dd185a3f-24ed-408a-9471-9838cd0dc94e", "confirm": true}'
```
