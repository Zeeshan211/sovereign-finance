/* Sovereign Finance — Reconciliation Commit
 * POST /api/reconciliation/commit
 * contract_version: reconciliation-v0.3
 *
 * Commits a saved dry-run plan, importing only safe classifications:
 *   MISSING_SAFE_TO_IMPORT   → create expense or income transaction
 *   TRANSFER_PAIR_FOUND      → create the missing side (expense or income)
 *
 * Never auto-commits: POSSIBLE_DUPLICATE, PENDING_UNPOSTED, NEEDS_REVIEW,
 *                     TRANSFER_PAIR_MISSING, DO_NOT_IMPORT
 *
 * All ledger writes go through POST /api/transactions (self-call).
 * Idempotency: re-running the same plan_id returns 0 new writes.
 *
 * Multi-tenancy: every SELECT/INSERT is scoped to the authenticated household.
 */

import { householdOf } from '../_lib.js';

const VERSION = 'reconciliation-v0.3';

const COMMIT_SAFE = new Set(['MISSING_SAFE_TO_IMPORT', 'TRANSFER_PAIR_FOUND']);

const EXCEPTION_TYPE_MAP = {
  POSSIBLE_DUPLICATE:    'DUPLICATE_RISK',
  TRANSFER_PAIR_MISSING: 'MISSING_COUNTERPARTY',
  PENDING_UNPOSTED:      'PENDING_UNPOSTED',
  NEEDS_REVIEW:          'WEAK_TRAIL',
};

const EXCEPTION_SEVERITY = {
  POSSIBLE_DUPLICATE:    'high',
  TRANSFER_PAIR_MISSING: 'medium',
  PENDING_UNPOSTED:      'low',
  NEEDS_REVIEW:          'medium',
};

const RECOMMENDED_ACTION = {
  POSSIBLE_DUPLICATE:    'Verify this is not a duplicate before importing',
  TRANSFER_PAIR_MISSING: 'Create matching transfer entry in the other account',
  PENDING_UNPOSTED:      'Wait for the transaction to post, then re-reconcile',
  NEEDS_REVIEW:          'Review and manually match or import',
};

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return json(errBody('DB binding missing', 'DB_BINDING_MISSING'), 500);

    const hh = householdOf(context);
    if (!hh) return json(errBody('Unauthorized', 'UNAUTHORIZED'), 401);

    const body      = await readJson(context.request);
    const planId    = clean(body.plan_id);
    const idemKey   = clean(body.idempotency_key);
    const confirmed = body.confirm === true;

    const rawCls = Array.isArray(body.selected_classifications)
      ? body.selected_classifications
      : null;
    const selectedCls = rawCls
      ? new Set(rawCls.filter(c => COMMIT_SAFE.has(c)))
      : COMMIT_SAFE;

    // Per-row user decisions (Phase 3). Keyed by statement-row id; each entry is
    // { intent, params }. When present, the user's explicit choice overrides the
    // engine's classification and routes the row to debts/bills/salary/transfer
    // or plain expense/income. Rows without an override keep the legacy
    // safe-classification behavior.
    const rowOverrides = buildOverrideMap(body.row_overrides || body.row_decisions);

    if (!planId)    return json(errBody('plan_id is required',         'PLAN_ID_REQUIRED'),         400);
    if (!confirmed) return json(errBody('confirm must be true',        'CONFIRM_REQUIRED'),         400);
    if (!idemKey)   return json(errBody('idempotency_key is required', 'IDEMPOTENCY_KEY_REQUIRED'), 400);

    await ensureExceptionsTable(db);

    // Scope reconciliation_plans SELECT by household_id when column exists
    const plansHhClause = await colExists(db, 'reconciliation_plans', 'user_id');
    const planRow = await db.prepare(
      `SELECT id, account_id, import_id, plan_json, committed_at
       FROM reconciliation_plans
       WHERE id = ?${plansHhClause ? ' AND user_id = ?' : ''}
       LIMIT 1`
    ).bind(...(plansHhClause ? [planId, hh] : [planId])).first().catch(() => null);

    if (!planRow) return json(errBody(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND'), 404);

    // Idempotent re-run: plan already committed
    if (planRow.committed_at) {
      return json({
        ok:                        true,
        version:                   VERSION,
        plan_id:                   planId,
        committed_count:           0,
        committed_transaction_ids: [],
        skipped_count:             0,
        skipped_to_exceptions:     [],
        projected_balance_before:  null,
        projected_balance_after:   null,
        warnings:                  ['Plan already committed — idempotent re-run returns no new writes.'],
        is_idempotent:             true
      });
    }

    let planData;
    try   { planData = JSON.parse(planRow.plan_json || '{}'); }
    catch (_) { planData = {}; }

    // Deterministic commit order (Phase 2): oldest first, and within the same
    // date, entity-creating rows before rows that pay against an existing
    // entity — so a "borrow" always commits before a payment that depends on
    // it. Stable sort preserves statement order for ties. (Dependency-aware
    // halt-on-failure lands with the create/pay row types in Phase 3; today's
    // safe rows — plain expense/income — are mutually independent.)
    const planItems = orderForCommit(
      Array.isArray(planData.plan) ? planData.plan : []
    );
    const origin    = new URL(context.request.url).origin;
    const now       = nowSql();

    const balanceBefore = await computeAppBalance(db, planRow.account_id, hh);

    const committedIds = [];
    const exceptionIds = [];
    const rowResults   = [];

    // Check household_id column existence once for exceptions table
    const excHhClause = await colExists(db, 'reconciliation_exceptions', 'user_id');

    for (const item of planItems) {
      const cls = item.classification;

      // Phase 3: explicit per-row user decision wins over the engine's class.
      const override = lookupOverride(rowOverrides, item.statement_row);
      if (override) {
        if (override.intent === 'skip') continue;
        const routed = await routeIntent({
          origin, override, stmt: item.statement_row,
          accountId: planRow.account_id, planId
        });
        if (routed.ok) {
          if (routed.id) committedIds.push(routed.id);
          rowResults.push({
            posted_date: item.statement_row?.posted_date,
            description: item.statement_row?.description || null,
            amount:      routed.signed_amount,
            intent:      override.intent,
            status:      routed.already_existed ? 'already_existed' : 'committed',
            transaction_id: routed.id || null
          });
        } else {
          const excId = `exc_${Date.now()}_${rand()}`;
          await writeException(db, {
            id: excId, plan_id: planId, account_id: planRow.account_id,
            user_id: excHhClause ? hh : undefined,
            stmt_tx_id: item.statement_row?.id || null, ledger_tx_id: null,
            type: 'ROUTE_FAILED', severity: 'high',
            amount: routed.signed_amount != null ? Math.abs(routed.signed_amount) : null,
            description: item.statement_row?.description || null,
            reason: routed.error || `Failed to add as ${override.intent}`,
            action: 'Review the chosen category and the linked debt/bill, then retry', now
          });
          exceptionIds.push(excId);
          rowResults.push({
            posted_date: item.statement_row?.posted_date,
            description: item.statement_row?.description || null,
            amount: routed.signed_amount, intent: override.intent,
            status: 'failed', reason: routed.error || `Failed to add as ${override.intent}`
          });
        }
        continue;
      }

      // Non-safe items: write exceptions for items that need attention
      if (!selectedCls.has(cls) || !COMMIT_SAFE.has(cls)) {
        if (EXCEPTION_TYPE_MAP[cls]) {
          const stmt = item.statement_row;
          const excId = `exc_${Date.now()}_${rand()}`;
          await writeException(db, {
            id:           excId,
            plan_id:      planId,
            account_id:   planRow.account_id,
            user_id: excHhClause ? hh : undefined,
            stmt_tx_id:   stmt?.id || null,
            ledger_tx_id: item.matched_ledger_id || null,
            type:         EXCEPTION_TYPE_MAP[cls],
            severity:     EXCEPTION_SEVERITY[cls] || 'medium',
            amount:       stmt != null ? Math.abs(stmt.debit ?? stmt.credit ?? 0) : null,
            description:  stmt?.description || item.matched_ledger?.notes || null,
            reason:       item.reason || cls,
            action:       RECOMMENDED_ACTION[cls] || 'Review manually',
            now
          });
          exceptionIds.push(excId);
        }
        continue;
      }

      // Safe items: commit via /api/transactions
      const stmt = item.statement_row;
      if (!stmt) continue;

      const isDebit  = stmt.debit != null;
      const amount   = isDebit
        ? Math.abs(stmt.debit ?? 0)
        : Math.abs(stmt.credit ?? 0);
      if (amount <= 0) continue;

      const txType  = isDebit ? 'expense' : 'income';
      // Content-based idempotency key (Phase 0 — no-flaw guard).
      // Keyed on the transaction's own identity (account + date + signed
      // amount + running balance), NOT the plan_id. This makes re-pasting the
      // same statement a guaranteed no-op even though it produces a new
      // plan_id, while the running balance disambiguates genuinely-distinct
      // same-day/same-amount transactions (they cannot share one balance).
      const rowIdem = await contentIdemKey(planRow.account_id, stmt, isDebit, amount);

      const txPayload = {
        type:            txType,
        amount,
        account_id:      planRow.account_id,
        date:            stmt.posted_date,
        notes:           stmt.description || null,
        idempotency_key: rowIdem,
        source_module:   'reconciliation',
        source_id:       planId,
        source_action:   'commit',
        created_by:      'reconciliation-commit-v0.3'
      };

      const result = await commitOneTransaction(origin, txPayload);

      if (result.ok || result.idempotent_replay) {
        const txId = result.id || result.transaction_id
          || (Array.isArray(result.ids) ? result.ids[0] : null)
          || rowIdem;
        committedIds.push(txId);
        rowResults.push({
          posted_date: stmt.posted_date,
          description: stmt.description || null,
          amount:      isDebit ? -amount : amount,
          status:      result.idempotent_replay ? 'already_existed' : 'committed',
          transaction_id: txId
        });
      } else {
        const excId = `exc_${Date.now()}_${rand()}`;
        await writeException(db, {
          id:           excId,
          plan_id:      planId,
          account_id:   planRow.account_id,
          user_id: excHhClause ? hh : undefined,
          stmt_tx_id:   stmt.id || null,
          ledger_tx_id: null,
          type:         'NO_STATEMENT_PROOF',
          severity:     'high',
          amount,
          description:  stmt.description || null,
          reason:       result.error || result.code || 'Transaction creation failed',
          action:       'Review and create the transaction manually',
          now
        });
        exceptionIds.push(excId);
        rowResults.push({
          posted_date: stmt.posted_date,
          description: stmt.description || null,
          amount:      isDebit ? -amount : amount,
          status:      'failed',
          reason:      result.error || result.code || 'Transaction creation failed'
        });
      }
    }

    // Mark plan as committed
    await db.prepare(
      `UPDATE reconciliation_plans SET committed_at = ? WHERE id = ?`
    ).bind(now, planId).run().catch(() => {});

    const balanceAfter = await computeAppBalance(db, planRow.account_id, hh);

    // Proof line (Phase 2): does the app balance now equal the statement's
    // closing balance? Equal → zero drift, every row accounted for. Not equal
    // → a row was missed or doubled; surface it now, not next month.
    const stmtClosing = await statementClosingBalance(db, planRow.import_id, hh);
    const proof = buildProof(balanceAfter, stmtClosing);

    return json({
      ok:                        true,
      version:                   VERSION,
      plan_id:                   planId,
      committed_count:           committedIds.length,
      committed_transaction_ids: committedIds,
      skipped_count:             exceptionIds.length,
      skipped_to_exceptions:     exceptionIds,
      projected_balance_before:  balanceBefore,
      projected_balance_after:   balanceAfter,
      row_results:               rowResults,
      proof,
      warnings:                  proof.matches === false
        ? ['Drift: app balance does not equal the statement closing balance — a transaction may be missing or doubled.']
        : []
    });

  } catch (e) {
    return json(errBody(e.message || String(e), 'COMMIT_FAILED'), 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

/* ─── Transaction self-call ─── */

async function commitOneTransaction(origin, payload) {
  try {
    // Step 1: dry-run to detect if balance override is needed
    let overrideToken = null;
    const dryRes = await fetch(`${origin}/api/transactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...payload, dry_run: true })
    });
    const dryData = await dryRes.json().catch(() => ({}));

    if (dryData.ok === false && !dryData.override_token) {
      // Hard failure (e.g. account not found, bad type)
      return { ok: false, error: dryData.error || 'Dry run validation failed', code: dryData.code };
    }
    if (dryData.override_token) {
      overrideToken = dryData.override_token;
    }

    // Step 2: actual commit
    const commitPayload = { ...payload };
    if (overrideToken) commitPayload.override_token = overrideToken;

    const commitRes = await fetch(`${origin}/api/transactions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(commitPayload)
    });
    return await commitRes.json().catch(() => ({ ok: false, error: 'Invalid JSON response', code: 'BAD_RESPONSE' }));
  } catch (e) {
    return { ok: false, error: e.message || 'fetch error', code: 'FETCH_ERROR' };
  }
}

/* ─── Exceptions table ─── */

async function writeException(db, { id, plan_id, account_id, user_id, stmt_tx_id, ledger_tx_id,
  type, severity, amount, description, reason, action, now }) {
  if (user_id !== undefined) {
    await db.prepare(
      `INSERT INTO reconciliation_exceptions
         (id, plan_id, account_id, user_id, statement_transaction_id, ledger_transaction_id,
          type, severity, amount, description, reason, recommended_action, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).bind(id, plan_id, account_id, user_id, stmt_tx_id, ledger_tx_id,
      type, severity, amount, description, reason, action, now).run();
  } else {
    await db.prepare(
      `INSERT INTO reconciliation_exceptions
         (id, plan_id, account_id, statement_transaction_id, ledger_transaction_id,
          type, severity, amount, description, reason, recommended_action, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).bind(id, plan_id, account_id, stmt_tx_id, ledger_tx_id,
      type, severity, amount, description, reason, action, now).run();
  }
}

async function ensureExceptionsTable(db) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
       id TEXT PRIMARY KEY,
       plan_id TEXT,
       account_id TEXT,
       user_id TEXT,
       statement_transaction_id TEXT,
       ledger_transaction_id TEXT,
       type TEXT,
       severity TEXT,
       amount REAL,
       description TEXT,
       reason TEXT,
       recommended_action TEXT,
       status TEXT DEFAULT 'open',
       created_at TEXT,
       resolved_at TEXT,
       resolution_note TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_status    ON reconciliation_exceptions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_account   ON reconciliation_exceptions(account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_plan      ON reconciliation_exceptions(plan_id)`,
    `CREATE INDEX IF NOT EXISTS idx_recon_excp_user ON reconciliation_exceptions(user_id)`
  ];
  for (const sql of ddl) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

/* ─── Balance helper ─── */

async function computeAppBalance(db, accountId, hh) {
  try {
    const POSITIVE = new Set(['income','salary','opening','borrow','debt_in','adjustment_positive']);
    const NEGATIVE = new Set(['expense','transfer','cc_spend','repay','atm','debt_out','cc_payment','adjustment_negative']);
    const hhClause = await colExists(db, 'transactions', 'user_id');
    const res = await db.prepare(
      `SELECT type, amount, reversed_by, reversed_at, notes
       FROM transactions
       WHERE account_id = ?${hhClause ? ' AND user_id = ?' : ''}`
    ).bind(...(hhClause ? [accountId, hh] : [accountId])).all();
    let balance = 0;
    for (const tx of res.results || []) {
      if (tx.reversed_by || tx.reversed_at) continue;
      const notes = String(tx.notes || '').toUpperCase();
      if (notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY ')) continue;
      const t = (tx.type || '').toLowerCase();
      const a = Math.abs(tx.amount || 0);
      if (POSITIVE.has(t))      balance += a;
      else if (NEGATIVE.has(t)) balance -= a;
    }
    return round2(balance);
  } catch (_) { return 0; }
}

/* ─── PRAGMA column-existence cache ─── */

const _colCache = new Map();

async function colExists(db, table, column) {
  const key = `${table}.${column}`;
  if (_colCache.has(key)) return _colCache.get(key);
  try {
    const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
    const cols = new Set((rows.results || []).map(r => r.name));
    const result = cols.has(column);
    _colCache.set(key, result);
    return result;
  } catch (_) {
    _colCache.set(key, false);
    return false;
  }
}

/* ─── Deterministic commit ordering + proof (Phase 2) ─── */

// Priority within the same date: lower commits first. Entity-creating rows
// (a new debt/bill) must precede rows that pay against an existing entity, so
// a same-day create-then-pay never references something not yet written.
// Today's safe classifications are independent; the create/pay types arrive
// in Phase 3 and slot into this table without changing the sort.
const COMMIT_PRIORITY = {
  MISSING_SAFE_TO_IMPORT: 1,
  TRANSFER_PAIR_FOUND:    1,
};

function orderForCommit(items) {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const da = a.item?.statement_row?.posted_date || '';
      const db = b.item?.statement_row?.posted_date || '';
      if (da !== db) return da < db ? -1 : 1;            // oldest first
      const pa = COMMIT_PRIORITY[a.item?.classification] ?? 5;
      const pb = COMMIT_PRIORITY[b.item?.classification] ?? 5;
      if (pa !== pb) return pa - pb;                      // creates before pays
      return a.i - b.i;                                   // stable: statement order
    })
    .map(x => x.item);
}

// The bank's closing balance for this statement, looked up via the plan's
// import. Returns null if unavailable (older plans without an import link).
async function statementClosingBalance(db, importId, hh) {
  if (!importId) return null;
  try {
    const hhClause = await colExists(db, 'statement_imports', 'user_id');
    const row = await db.prepare(
      `SELECT statement_closing_balance AS bal
       FROM statement_imports
       WHERE id = ?${hhClause ? ' AND user_id = ?' : ''}
       LIMIT 1`
    ).bind(...(hhClause ? [importId, hh] : [importId])).first();
    return row && row.bal != null ? Number(row.bal) : null;
  } catch (_) { return null; }
}

function buildProof(appBalance, stmtClosing) {
  if (stmtClosing == null) {
    return {
      app_balance: round2(appBalance),
      statement_closing_balance: null,
      matches: null,
      difference: null,
      note: 'No statement closing balance on file — cannot prove zero drift for this plan.'
    };
  }
  const matches = Math.round(appBalance * 100) === Math.round(stmtClosing * 100);
  return {
    app_balance: round2(appBalance),
    statement_closing_balance: round2(stmtClosing),
    matches,
    difference: round2(appBalance - stmtClosing),
    note: matches
      ? 'App balance equals the statement closing balance — every transaction accounted for.'
      : 'App balance does NOT equal the statement closing balance — a row is likely missing or doubled.'
  };
}

/* ─── Per-row intent routing (Phase 3) ─── */

// Normalize body.row_overrides (object keyed by row id, or array of
// {row_id|key, intent, params}) into a Map<string, {intent, params}>.
function buildOverrideMap(raw) {
  const map = new Map();
  if (!raw) return map;
  const add = (key, intent, params) => {
    const k = clean(key);
    if (k && intent) map.set(k, { intent: clean(intent), params: params || {} });
  };
  if (Array.isArray(raw)) {
    for (const o of raw) add(o.row_id || o.key || o.id, o.intent, o.params);
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') add(k, v.intent, v.params);
    }
  }
  return map;
}

// A row may be keyed by its statement-row id, or (fallback) by posted_date:amount.
function lookupOverride(map, stmt) {
  if (!map.size || !stmt) return null;
  if (stmt.id && map.has(stmt.id)) return map.get(stmt.id);
  const amt = stmt.debit != null ? stmt.debit : stmt.credit;
  const alt = `${stmt.posted_date}:${amt}`;
  return map.has(alt) ? map.get(alt) : null;
}

// Route one row to the correct domain endpoint based on the user's chosen
// intent. Every self-call carries a content-based idempotency key so a
// re-paste is a no-op across all intents (salary excepted — see note).
async function routeIntent({ origin, override, stmt, accountId, planId }) {
  const { intent, params } = override;
  const isDebit = stmt.debit != null;
  const amount  = Math.abs((isDebit ? stmt.debit : stmt.credit) ?? 0);
  const signed  = isDebit ? -amount : amount;
  if (amount <= 0) return { ok: false, error: 'Row has no amount', signed_amount: signed };

  const idem = await contentIdemKey(accountId, stmt, isDebit, amount);
  const base = {
    idempotency_key: idem,
    source_module: 'reconciliation', source_id: planId, source_action: 'commit',
    created_by: 'reconciliation-commit-v0.3'
  };
  const date  = stmt.posted_date;
  const notes = stmt.description || null;

  switch (intent) {
    case 'expense':
    case 'income': {
      const r = await postJson(`${origin}/api/transactions`, {
        ...base, type: intent, amount, account_id: accountId, date, notes
      }, true);
      return txResult(r, signed, idem);
    }
    case 'transfer': {
      const to = clean(params.transfer_to_account_id || params.to_account_id);
      if (!to) return { ok: false, error: 'transfer needs a destination account', signed_amount: signed };
      const r = await postJson(`${origin}/api/transactions`, {
        ...base, type: 'transfer', amount, account_id: accountId,
        transfer_to_account_id: to, date, notes
      }, true);
      return txResult(r, signed, idem);
    }
    case 'debt_borrow':   // credit in: new loan I'm taking
    case 'debt_lend': {   // debit out: new loan I'm giving
      const direction = intent === 'debt_borrow' ? 'i_owe' : 'owed_to_me';
      const r = await postJson(`${origin}/api/debts`, {
        ...base, action: 'create', direction,
        counterparty_name: clean(params.counterparty_name) || notes || 'Reconciled debt',
        amount, // Rs; the debts API converts to paisa
        funds_moved_at_creation: true,
        date_originated: date,
        ...(direction === 'i_owe'
          ? { destination_account_id: accountId }
          : { source_account_id: accountId }),
        description: notes
      });
      // createDebt writes the origination ledger entry itself — do NOT also
      // post a transaction.
      return debtResult(r, signed);
    }
    case 'debt_pay': {      // debit out: paying down an existing i_owe debt
      const debtId = clean(params.debt_id);
      if (!debtId) return { ok: false, error: 'debt_pay needs a debt_id', signed_amount: signed };
      const r = await postJson(`${origin}/api/debts`, {
        ...base, action: 'pay', debt_id: debtId, account_id: accountId, amount, date
      });
      return debtResult(r, signed);
    }
    case 'debt_receive': {  // credit in: someone repaid an owed_to_me debt
      const debtId = clean(params.debt_id);
      if (!debtId) return { ok: false, error: 'debt_receive needs a debt_id', signed_amount: signed };
      const r = await postJson(`${origin}/api/debts`, {
        ...base, action: 'receive_payment', debt_id: debtId,
        destination_account_id: accountId, account_id: accountId, amount, date
      });
      return debtResult(r, signed);
    }
    case 'bill_pay': {      // debit out: paying an existing bill
      const billId = clean(params.bill_id);
      if (!billId) return { ok: false, error: 'bill_pay needs a bill_id', signed_amount: signed };
      const r = await postJson(`${origin}/api/bills`, {
        ...base, action: 'pay', bill_id: billId, account_id: accountId,
        amount, payment_date: date
      });
      return { ok: !!(r.ok || r.idempotent_replay), id: r.payment_id || r.id || idem,
        already_existed: !!r.idempotent_replay, error: r.error || r.code, signed_amount: signed };
    }
    case 'salary': {        // credit in: a payslip deposit
      const r = await postJson(`${origin}/api/salary`, {
        ...base, action: 'add_payslip',
        gross_amount: amount, net_amount_estimate: amount,
        deposit_account_id: accountId, pay_date: date, notes
      });
      return { ok: !!r.ok, id: r.id || (r.data && r.data.id) || idem,
        error: r.error || r.code, signed_amount: signed };
    }
    default:
      return { ok: false, error: `Unknown intent "${intent}"`, signed_amount: signed };
  }
}

function txResult(r, signed, idem) {
  const ok = !!(r.ok || r.idempotent_replay);
  const id = r.id || r.transaction_id || (Array.isArray(r.ids) ? r.ids[0] : null) || idem;
  return { ok, id, already_existed: !!r.idempotent_replay, error: r.error || r.code, signed_amount: signed };
}

function debtResult(r, signed) {
  const ok = !!(r.ok || r.idempotent_replay || r.duplicate || r.already_exists);
  const id = (r.data && (r.data.id || r.data.debt_id)) || r.debt_id || r.id || r.payment_id || null;
  return { ok, id, already_existed: !!(r.idempotent_replay || r.duplicate),
    error: r.error || r.code, signed_amount: signed };
}

// POST helper. When dryThenCommit is true (ledger writes via /api/transactions),
// reuse the existing dry-run→override→commit dance.
async function postJson(url, payload, dryThenCommit = false) {
  if (dryThenCommit) return commitOneTransaction(url.replace(/\/api\/transactions$/, ''), payload);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => ({ ok: false, error: 'Invalid JSON response', code: 'BAD_RESPONSE' }));
  } catch (e) {
    return { ok: false, error: e.message || 'fetch error', code: 'FETCH_ERROR' };
  }
}

/* ─── Content-based idempotency key (Phase 0) ─── */

// Deterministic, plan-independent key for a statement row's ledger write.
// sha256(account_id | posted_date | signed_amount_paisa | running_balance_paisa)
// Re-pasting the same statement yields identical keys → the /api/transactions
// hard guard replays instead of writing a duplicate. When the running balance
// is absent (CSV fallback without a balance column), we fall back to
// account+date+signed-amount, which still de-dupes re-pastes for the common
// case but loses same-day/same-amount disambiguation.
async function contentIdemKey(accountId, stmt, isDebit, amount) {
  const signedPaisa  = Math.round((isDebit ? -amount : amount) * 100);
  const balancePaisa = (stmt && stmt.balance != null)
    ? String(Math.round(stmt.balance * 100))
    : 'nobal';
  const basis = `${accountId}|${stmt.posted_date}|${signedPaisa}|${balancePaisa}`;
  const hash  = await sha256Hex(basis);
  return `recon:v2:${hash}`;
}

async function sha256Hex(text) {
  const data   = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ─── Generic helpers ─── */

function errBody(message, code) {
  return { ok: false, version: VERSION, error: message, code };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function rand() { return Math.random().toString(36).slice(2, 8); }

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      ...corsHeaders()
    }
  });
}
