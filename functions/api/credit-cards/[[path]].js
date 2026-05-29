/*
 * Sovereign Finance — /api/credit-cards
 * v1.0.0-cc-contract-v1
 *
 * Contract version : credit-cards-v1
 * Route            : POST /api/credit-cards  (action in body — NEVER subroutes)
 *                    GET  /api/credit-cards
 *                    GET  /api/credit-cards?id=<card_id>
 *
 * 19 POST actions:
 *   create | update | record_purchase | record_cash_advance | record_intl_purchase
 *   record_payment | record_interest | record_fee | record_refund
 *   upload_statement | reconcile_statement | close_card
 *   convert_to_emi | record_balance_transfer | file_dispute | resolve_dispute
 *   detect_subscriptions | record_nsf_fee | configure_auto_pay
 *
 * Rules:
 *   - Auth via middleware — context.data.user_id is guaranteed present.
 *   - Every mutation checks idempotency_key via idempotency_keys table.
 *   - All amounts stored as INTEGER paisa; REAL amount = paisa / 100 for legacy.
 *   - D1 batch for every multi-row atomic write.
 *   - Canonical response: { ok, action, contract_version, ...payload, committed }
 *   - Canonical error: { ok:false, error, code, action, committed:false }
 *   - Existing /api/cc routes and accounts table are NOT modified here.
 */