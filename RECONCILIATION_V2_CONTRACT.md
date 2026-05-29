# Statement Reconciliation v2 Contract
Table card_statement_transactions EXISTS with columns: id, statement_id, card_id, user_id, transaction_date, description, amount_paisa, txn_type, raw_text, match_status, matched_ledger_txn_id, match_confidence, match_method, extraction_provider, created_at, updated_at

## 5 Backend Actions (functions/api/credit-cards/[[path]].js)
1. parse_statement_pdf(statement_id, file_url) - Cloudflare AI extracts txns, inserts rows
2. run_reconciliation(statement_id) - match algorithm, updates match_status
3. import_statement_transaction(statement_txn_id) - inserts into transactions ledger
4. mark_statement_txn_disputed(statement_txn_id, reason)
5. get_reconciliation_view(statement_id) - returns 4 buckets

## Match Algorithm (priority)
a. EXACT: same date + amount within Rs 5 = confidence 1.0
b. FUZZY DATE: amount matches, date within 3 days = 0.8
c. FUZZY AMOUNT: date matches, amount within 10% = 0.6

## AI Model
@cf/meta/llama-3.2-11b-vision-instruct via env.AI binding
Prompt: Extract Pakistani CC statement transactions as JSON array with date, description, amount_paisa, txn_type fields

## Frontend
Route: /credit-card/:cardId/statements/:stmtId/reconcile
4 sections: Matched (green), Missing-in-ledger (red+Add btn), Not-on-stmt (amber), Mismatches (orange)
Hooks: useCCReconciliationView, useCCParseStatement, useCCRunReconciliation, useCCImportStatementTxn

## Rules
- Imported txns: description prefix "[from statement]" + source_tag='statement_reconciliation'
- Idempotent: re-parsing checks existing statement_id rows
- AI fail: mark parsing_status=failed, allow manual entry
