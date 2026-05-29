# Stmt Reconciliation v2 Contract
Table card_statement_transactions ALREADY CREATED.

## 5 Actions (functions/api/credit-cards/[[path]].js)
1. parse_statement_pdf(statement_id, file_url) → AI extract → insert rows
2. run_reconciliation(statement_id) → match algo → update match_status
3. import_statement_transaction(statement_txn_id) → insert into transactions
4. mark_statement_txn_disputed(statement_txn_id, reason)
5. get_reconciliation_view(statement_id) → 4 buckets

## Match algorithm (priority order)
a. EXACT: same date+amount(±5) → confidence=1.0
b. FUZZY DATE: amount match, date±3d → 0.8
c. FUZZY AMOUNT: date match, amount±10% → 0.6

## AI prompt (Cloudflare @cf/meta/llama-3.2-11b-vision-instruct)
"Extract Pakistani CC statement transactions. Return JSON array: [{date:'YYYY-MM-DD', description, amount_paisa, txn_type:'debit|credit|fee|interest|refund|payment'}]"

## Frontend page /credit-card/:cardId/statements/:stmtId/reconcile
4 sections: Matched(green) | Missing-in-ledger(red+Add btn) | Not-on-stmt(amber) | Mismatches(orange)
Hooks: useCCReconciliationView, useCCParseStatement, useCCRunReconciliation, useCCImportStatementTxn

## Rules
- Imported txns get description prefix "[from statement]" + source_tag='statement_reconciliation'
- Re-running parse is idempotent (check statement_id)
- AI fail → parsing_status='failed', allow manual
- ±Rs 5 amount tolerance, ±3 day date tolerance

## Existing assets (do NOT rebuild)
- env.AI binding live
- card_statements table populated
- ReconcilePage shell from Session 3
