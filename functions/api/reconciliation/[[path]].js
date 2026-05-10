/* Sovereign Finance Reconciliation API v0.1.0
   /api/reconciliation

   Contract:
   - GET returns account balances and reconciliation status.
   - POST dry_run validates a balance declaration and performs no write.
   - POST real declare asks Command Centre before writing.
   - Real declare creates one adjustment transaction only when declared balance differs.
   - No fake smoke entries.
   - No /api/money-contracts.
*/

const VERSION = 'v0.1.0';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const accounts = await listAccounts(db);

    return jsonResponse({
      ok: true,
      version: VERSION,
      accounts,
      summary: {
        account_count: accounts.length,
        active_account_count: accounts.filter(a => a.status === 'active').length,
        total_balance: round2(accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0))
      }
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const body = await readJSON(context.request);
    const dryRun = isDryRunRequest(context, body);

    const accountId = safeText(body.account_id, '', 160);
    const declaredBalance = Number(body.declared_balance);
    const declaredAt = normalizeDate(body.declared_at || body.date) || todayISO();
    const notes = safeText(body.notes, '', 500);

    if (!accountId) {
      return jsonResponse({ ok: false, version: VERSION, error: 'account_id required' }, 400);
    }

    if (!Number.isFinite(declaredBalance)) {
      return jsonResponse({ ok: false, version: VERSION, error: 'declared_balance must be numeric' }, 400);
    }

    const account = await readAccount(db, accountId);

    if (!account) {
      return jsonResponse({ ok: false, version: VERSION, error: 'Account not found' }, 404);
    }

    if (!isActiveAccount(account)) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Account is not active',
        account_id: accountId,
        status: account.status || null
      }, 409);
    }

    const currentBalance = await computeAccountBalance(db, accountId);
    const delta = round2(declaredBalance - currentBalance);
    const absDelta = Math.abs(delta);
    const action = 'reconciliation.declare';

    const proof = buildReconciliationProof({
      account,
      currentBalance,
      declaredBalance,
      delta,
      declaredAt,
      notes
    });

    if (dryRun) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        dry_run: true,
        action,
        writes_performed: false,
        audit_performed: false,
        proof,
        normalized_payload: {
          account_id: account.id,
          account_name: account.name || account.id,
          current_balance: currentBalance,
          declared_balance: round2(declaredBalance),
          delta,
          declared_at: declaredAt,
          notes
        }
      });
    }

    const allowed = await commandAllowsAction(context, action);

    if (!allowed) {
      return jsonResponse({
        ok: false,
        version: VERSION,
        error: 'Command Centre blocked reconciliation declaration',
        action,
        dry_run: false,
        writes_performed: false,
        audit_performed: false,
        enforcement: {
          action,
          allowed: false,
          status: 'blocked',
          reason: 'reconciliation.declare real write blocked by Command Centre.',
          source: 'coverage.write_safety.reconciliation_declare',
          backend_enforced: true
        },
        proof
      }, 423);
    }

    if (absDelta < 0.01) {
      return jsonResponse({
        ok: true,
        version: VERSION,
        action,
        writes_performed: false,
        audit_performed: false,
        no_adjustment_needed: true,
        account_id: account.id,
        current_balance: currentBalance,
        declared_balance: round2(declaredBalance),
        delta,
        proof
      });
    }

    const txId = 'tx_reconcile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const txType = delta >= 0 ? 'income' : 'expense';
    const amount = round2(Math.abs(delta));
    const txNotes = safeText(
      notes || ('Balance declaration for ' + (account.name || account.id) + ': declared ' + declaredBalance + ', app ' + currentBalance),
      '',
      500
    );

    await db.prepare(
      `INSERT INTO transactions
       (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, fee_amount, pra_amount)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, 0)`
    ).bind(
      txId,
      declaredAt,
      txType,
      amount,
      account.id,
      txNotes
    ).run();

    const finalBalance = await computeAccountBalance(db, accountId);

    return jsonResponse({
      ok: true,
      version: VERSION,
      action,
      tx_id: txId,
      account_id: account.id,
      account_name: account.name || account.id,
      previous_balance: currentBalance,
      declared_balance: round2(declaredBalance),
      delta,
      final_balance: finalBalance,
      writes_performed: true,
      audit_performed: false,
      proof
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function listAccounts(db) {
  const res = await db.prepare(
    `SELECT id, name, kind, type, status
     FROM accounts
     WHERE (deleted_at IS NULL OR deleted_at = '')
     ORDER BY name`
  ).all();

  const rows = res.results || [];

  const accounts = [];

  for (const row of rows) {
    const balance = await computeAccountBalance(db, row.id);
    accounts.push({
      id: safeText(row.id, '', 160),
      name: safeText(row.name, row.id, 160),
      kind: safeText(row.kind || row.type, '', 80),
      type: safeText(row.type || row.kind, '', 80),
      status: safeText(row.status, 'active', 40).toLowerCase() || 'active',
      balance
    });
  }

  return accounts;
}

async function readAccount(db, id) {
  return db.prepare(
    `SELECT id, name, kind, type, status
     FROM accounts
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();
}

async function computeAccountBalance(db, accountId) {
  const income = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE account_id = ?
     AND type = 'income'`
  ).bind(accountId).first();

  const expense = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE account_id = ?
     AND type = 'expense'`
  ).bind(accountId).first();

  const transferIn = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE transfer_to_account_id = ?`
  ).bind(accountId).first();

  const transferOut = await db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM transactions
     WHERE account_id = ?
     AND type = 'transfer'`
  ).bind(accountId).first();

  return round2(
    Number(income && income.total || 0)
    - Number(expense && expense.total || 0)
    + Number(transferIn && transferIn.total || 0)
    - Number(transferOut && transferOut.total || 0)
  );
}

function buildReconciliationProof(input) {
  return {
    action: 'reconciliation.declare',
    version: VERSION,
    writes_performed: false,
    audit_performed: false,
    validation_status: 'pass',
    write_model: 'balance_declaration_command_centre_gated',
    expected_transaction_rows: Math.abs(input.delta) < 0.01 ? 0 : 1,
    expected_ledger_rows: 0,
    expected_audit_rows: 0,
    normalized_summary: {
      account_id: input.account.id,
      account_name: input.account.name || input.account.id,
      current_balance: input.currentBalance,
      declared_balance: round2(input.declaredBalance),
      delta: input.delta,
      declared_at: input.declaredAt
    },
    checks: [
      proofCheck('account_exists', 'pass', 'accounts.id', 'Account exists.'),
      proofCheck('account_active', isActiveAccount(input.account) ? 'pass' : 'blocked', 'accounts.status', 'Account is active.'),
      proofCheck('declared_balance_valid', Number.isFinite(Number(input.declaredBalance)) ? 'pass' : 'blocked', 'request.declared_balance', 'Declared balance is numeric.'),
      proofCheck('delta_computed', 'pass', 'computed.delta', 'Delta is computed from declared balance minus current app balance.'),
      proofCheck('command_gate_required', 'pass', 'finance-command-center', 'Real declaration asks Command Centre before writing.'),
      proofCheck('dry_run_no_write', 'pass', 'api.contract', 'Dry-run returns before transaction insert.')
    ]
  };
}

async function commandAllowsAction(context, action) {
  try {
    const origin = new URL(context.request.url).origin;
    const res = await fetch(origin + '/api/finance-command-center?gate=' + encodeURIComponent(action) + '&cb=' + Date.now(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-sovereign-reconciliation-gate': action
      }
    });

    const data = await res.json().catch(() => null);
    const found = data && data.enforcement && Array.isArray(data.enforcement.actions)
      ? data.enforcement.actions.find(item => item.action === action)
      : null;

    return Boolean(found && found.allowed);
  } catch (err) {
    return false;
  }
}

function isActiveAccount(account) {
  const status = String(account && account.status || 'active').trim().toLowerCase();
  return status === '' || status === 'active';
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

function normalizeDate(value) {
  const raw = safeText(value, '', 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isDryRunRequest(context, body) {
  const url = new URL(context.request.url);

  return url.searchParams.get('dry_run') === '1'
    || url.searchParams.get('dry_run') === 'true'
    || body.dry_run === true
    || body.dry_run === '1'
    || body.dry_run === 'true';
}

function safeText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch (err) {
    return {};
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}
