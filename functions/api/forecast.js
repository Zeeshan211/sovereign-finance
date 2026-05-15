/* Sovereign Finance Forecast API
 * /api/forecast
 * v0.2.0-forecast-contract-aggregate
 *
 * Phase 4 purpose:
 * - One backend aggregate source for Forecast page.
 * - Reads canonical account balances from transactions.
 * - Reads saved salary contract.
 * - Reads active debts.
 * - Returns forecast summary + events.
 * - Does NOT mutate ledger/accounts/debts/salary.
 */

const VERSION = 'v0.2.0-forecast-contract-aggregate';

const POSITIVE_TYPES = new Set([
  'income',
  'salary',
  'opening',
  'borrow',
  'debt_in'
]);

const NEGATIVE_TYPES = new Set([
  'expense',
  'transfer',
  'cc_spend',
  'repay',
  'atm',
  'debt_out',
  'cc_payment'
]);

const LIABILITY_TYPES = new Set([
  'liability',
  'credit_card',
  'cc',
  'loan',
  'debt'
]);

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);

    if (!db) {
      return json({
        ok: false,
        version: VERSION,
        error: {
          code: 'DB_BINDING_MISSING',
          message: 'Cloudflare D1 binding DB is not available.'
        }
      }, 500);
    }

    const horizonDays = clampInt(url.searchParams.get('horizon'), 30, 1, 365);
    const includeSalary = url.searchParams.get('salary') !== 'exclude';
    const debtMode = safeText(url.searchParams.get('debts') || 'due', 'due', 40).toLowerCase();
    const buffer = wholeRupee(url.searchParams.get('buffer') || 0);

    const today = todayISO();
    const horizonEnd = addDaysISO(today, horizonDays);

    const accounts = await loadCanonicalAccounts(db);
    const salary = await loadSalarySource(db, today, horizonEnd);
    const debts = await loadDebts(db, today);

    const cashNow = round2(accounts
      .filter(account => isLiquidAssetAccount(account))
      .reduce((sum, account) => sum + number(account.balance, 0), 0));

    const events = [];

    if (includeSalary && salary.enabled && salary.amount > 0 && inRange(salary.expected_date, today, horizonEnd)) {
      events.push({
        id: `salary_${salary.expected_date}`,
        source: 'salary',
        type: 'income',
        title: 'Expected salary income',
        label: 'Salary',
        amount: wholeRupee(salary.amount),
        date: salary.expected_date,
        account_id: salary.payout_account_id,
        status: 'expected',
        description: 'Saved salary contract forecast source',
        raw: salary
      });
    }

    if (debtMode !== 'exclude') {
      for (const debt of debts) {
        if (String(debt.status || 'active').toLowerCase() !== 'active') continue;

        const remaining = round2(
          debt.remaining_amount == null
            ? number(debt.original_amount, 0) - number(debt.paid_amount, 0)
            : number(debt.remaining_amount, 0)
        );

        if (remaining <= 0) continue;

        const dueDate = normalizeDate(debt.next_due_date || debt.due_date || computeNextDueDate(debt, today));
        const include =
          debtMode === 'all' ||
          (dueDate && inRange(dueDate, today, horizonEnd));

        if (!include) continue;

        const kind = String(debt.kind || '').toLowerCase();
        const isOwedToMe = kind === 'owed';

        events.push({
          id: `debt_${debt.id}_${dueDate || horizonEnd}`,
          source: 'debt',
          type: isOwedToMe ? 'income' : 'outflow',
          title: isOwedToMe
            ? `Debt expected: ${debt.name || debt.id}`
            : `Debt due: ${debt.name || debt.id}`,
          label: debt.name || debt.id,
          amount: isOwedToMe ? wholeRupee(remaining) : -wholeRupee(Math.abs(remaining)),
          date: dueDate || horizonEnd,
          account_id: '',
          status: dueDate ? 'due' : 'unscheduled',
          description: `${debt.kind || 'debt'} · ${debt.id}`,
          raw: debt
        });
      }
    }

    if (buffer !== 0) {
      events.push({
        id: 'manual_buffer',
        source: 'scenario',
        type: buffer > 0 ? 'income' : 'outflow',
        title: buffer > 0 ? 'Manual positive buffer' : 'Manual reserve buffer',
        label: 'Scenario buffer',
        amount: buffer,
        date: horizonEnd,
        account_id: 'scenario',
        status: 'planning',
        description: 'Scenario-only adjustment; no ledger impact',
        raw: { buffer }
      });
    }

    events.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const expectedIncome = wholeRupee(
      events
        .filter(event => number(event.amount, 0) > 0)
        .reduce((sum, event) => sum + number(event.amount, 0), 0)
    );

    const expectedOutflow = wholeRupee(
      Math.abs(
        events
          .filter(event => number(event.amount, 0) < 0)
          .reduce((sum, event) => sum + number(event.amount, 0), 0)
      )
    );

    const projectedEnd = wholeRupee(cashNow + expectedIncome - expectedOutflow);

    return json({
      ok: true,
      version: VERSION,
      horizon_days: horizonDays,
      date_start: today,
      date_end: horizonEnd,
      summary: {
        cash_now: cashNow,
        expected_income: expectedIncome,
        expected_outflow: expectedOutflow,
        buffer,
        projected_end: projectedEnd
      },
      sources: {
        accounts_count: accounts.length,
        active_asset_accounts_count: accounts.filter(isLiquidAssetAccount).length,
        account_balance_source: 'transactions_canonical',
        salary_enabled: salary.enabled,
        salary_amount: wholeRupee(salary.amount || 0),
        salary_expected_date: salary.expected_date || null,
        debts_count: debts.length
      },
      events,
      inputs: {
        accounts,
        salary,
        debts
      },
      contract: {
        forecast_is_read_only: true,
        mutates_ledger: false,
        mutates_accounts: false,
        mutates_salary: false,
        mutates_debts: false,
        account_balance_source: 'transactions_canonical',
        salary_source: 'salary_contracts',
        debt_source: 'debts',
        money_precision: 'cash uses 2 decimals, forecast income/outflow/projected_end use whole rupees'
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: {
        code: 'FORECAST_AGGREGATE_FAILED',
        message: err.message || String(err)
      },
      stack: String(err && err.stack ? err.stack : '')
        .split('\n')
        .slice(0, 6)
        .join('\n')
    }, 500);
  }
}

/* ─────────────────────────────
 * Accounts / balances
 * ───────────────────────────── */

async function loadCanonicalAccounts(db) {
  const accountCols = await tableColumns(db, 'accounts');
  const transactionCols = await tableColumns(db, 'transactions');

  if (!accountCols.size) return [];

  const accountSelect = [
    'id',
    accountCols.has('name') ? 'name' : null,
    accountCols.has('type') ? 'type' : null,
    accountCols.has('kind') ? 'kind' : null,
    accountCols.has('currency') ? 'currency' : null,
    accountCols.has('status') ? 'status' : null,
    accountCols.has('display_order') ? 'display_order' : null,
    accountCols.has('credit_limit') ? 'credit_limit' : null,
    accountCols.has('deleted_at') ? 'deleted_at' : null,
    accountCols.has('archived_at') ? 'archived_at' : null
  ].filter(Boolean);

  const accountRows = await db.prepare(
    `SELECT ${accountSelect.join(', ')}
     FROM accounts
     ORDER BY ${accountCols.has('display_order') ? 'display_order,' : ''} id`
  ).all();

  const accounts = (accountRows.results || []).map(row => ({
    id: row.id,
    name: row.name || row.id,
    type: row.type || 'asset',
    kind: row.kind || row.type || 'account',
    currency: row.currency || 'PKR',
    status: row.status || 'active',
    display_order: row.display_order == null ? null : Number(row.display_order),
    credit_limit: row.credit_limit == null ? null : number(row.credit_limit, null),
    deleted_at: row.deleted_at || null,
    archived_at: row.archived_at || null,
    balance: 0,
    current_balance: 0,
    amount: 0,
    transaction_count: 0,
    included_transaction_count: 0,
    skipped_inactive_transaction_count: 0,
    balance_source: 'transactions_canonical',
    balance_version: VERSION
  }));

  if (!transactionCols.size) return accounts;

  const txSelect = [
    'id',
    transactionCols.has('type') ? 'type' : null,
    transactionCols.has('transaction_type') ? 'transaction_type' : null,
    'amount',
    'account_id',
    transactionCols.has('transfer_to_account_id') ? 'transfer_to_account_id' : null,
    transactionCols.has('notes') ? 'notes' : null,
    transactionCols.has('reversed_by') ? 'reversed_by' : null,
    transactionCols.has('reversed_at') ? 'reversed_at' : null,
    transactionCols.has('linked_txn_id') ? 'linked_txn_id' : null
  ].filter(Boolean);

  const txRows = await db.prepare(
    `SELECT ${txSelect.join(', ')}
     FROM transactions`
  ).all();

  const byId = new Map(accounts.map(account => [String(account.id), account]));

  for (const tx of txRows.results || []) {
    const accountId = String(tx.account_id || '');
    const account = byId.get(accountId);
    if (!account) continue;

    account.transaction_count += 1;

    if (isInactiveTransaction(tx)) {
      account.skipped_inactive_transaction_count += 1;
      continue;
    }

    const signed = signedAmount(tx);
    account.balance = round2(account.balance + signed);
    account.current_balance = account.balance;
    account.amount = account.balance;
    account.included_transaction_count += 1;
  }

  return accounts;
}

function signedAmount(tx) {
  const type = String(tx.type || tx.transaction_type || '').trim().toLowerCase();
  const amount = Math.abs(number(tx.amount, 0));

  if (POSITIVE_TYPES.has(type)) return amount;
  if (NEGATIVE_TYPES.has(type)) return -amount;

  return -amount;
}

function isInactiveTransaction(tx) {
  const notes = String(tx.notes || '').toUpperCase();

  return Boolean(
    tx.reversed_by ||
    tx.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function isLiquidAssetAccount(account) {
  const status = String(account.status || '').toLowerCase();
  const type = String(account.type || '').toLowerCase();
  const kind = String(account.kind || '').toLowerCase();

  if (['inactive', 'deleted', 'archived'].includes(status)) return false;
  if (account.deleted_at || account.archived_at) return false;
  if (LIABILITY_TYPES.has(type) || LIABILITY_TYPES.has(kind)) return false;

  return true;
}

/* ─────────────────────────────
 * Salary
 * ───────────────────────────── */

async function loadSalarySource(db, today, horizonEnd) {
  const cols = await tableColumns(db, 'salary_contracts');

  if (!cols.size) {
    return disabledSalary('salary_contracts table missing');
  }

  const row = await db.prepare(
    `SELECT *
     FROM salary_contracts
     ORDER BY ${cols.has('updated_at') ? 'datetime(updated_at) DESC' : 'rowid DESC'}
     LIMIT 1`
  ).first();

  if (!row) {
    return disabledSalary('no saved salary contract');
  }

  const contract = normalizeSalaryContract(row);
  const computed = computeSalary(contract);
  const includeInForecast = toBool(contract.include_in_forecast, true);
  const expectedDate = nextPaydayWithinHorizon(today, horizonEnd, contract.payday);

  if (!includeInForecast) {
    return {
      ...disabledSalary('salary excluded from forecast'),
      contract,
      computed
    };
  }

  if (computed.net <= 0) {
    return {
      ...disabledSalary('salary net amount is zero'),
      contract,
      computed
    };
  }

  if (!expectedDate) {
    return {
      enabled: false,
      amount: wholeRupee(computed.net),
      monthly_salary_net: wholeRupee(computed.net),
      expected_income_amount: wholeRupee(computed.net),
      expected_date: '',
      expected_payday: contract.payday,
      payout_account_id: contract.payout_account_id,
      effective_month: contract.effective_month,
      reason: 'salary payday is outside forecast horizon',
      contract,
      computed
    };
  }

  return {
    enabled: true,
    amount: wholeRupee(computed.net),
    monthly_salary_net: wholeRupee(computed.net),
    expected_income_amount: wholeRupee(computed.net),
    gross: wholeRupee(computed.gross),
    deductions: wholeRupee(computed.deductions),
    expected_date: expectedDate,
    expected_payday: contract.payday,
    payout_account_id: contract.payout_account_id,
    effective_month: contract.effective_month,
    contract,
    computed
  };
}

function disabledSalary(reason) {
  return {
    enabled: false,
    amount: 0,
    monthly_salary_net: 0,
    expected_income_amount: 0,
    expected_date: '',
    expected_payday: null,
    payout_account_id: '',
    reason
  };
}

function normalizeSalaryContract(row) {
  const basic = wholeRupee(row.basic);
  const hra = wholeRupee(row.hra);
  const medical = wholeRupee(row.medical);
  const utility = wholeRupee(row.utility);
  const derivedBase = wholeRupee(basic + hra + medical + utility);
  const contractBase = row.contract_base == null || row.contract_base === ''
    ? derivedBase
    : wholeRupee(row.contract_base);

  return {
    id: row.id || 'salary_contract_current',
    effective_month: normalizeEffectiveMonth(row.effective_month),
    basic,
    hra,
    medical,
    utility,
    contract_base: contractBase,
    wfh_usd: decimalMoney(row.wfh_usd, 0, 6),
    wfh_fx_rate: decimalMoney(row.wfh_fx_rate, 0, 6),
    include_wfh: toBool(row.include_wfh, false),
    other_allowance: wholeRupee(row.other_allowance),
    deductions: wholeRupee(row.deductions),
    payday: normalizePayday(row.payday),
    payout_account_id: safeText(row.payout_account_id || 'meezan', 'meezan', 120),
    include_in_forecast: toBool(row.include_in_forecast, true),
    notes: row.notes || '',
    updated_at: row.updated_at || null
  };
}

function computeSalary(contract) {
  const wfhAllowance = contract.include_wfh
    ? wholeRupee(decimal(contract.wfh_usd) * decimal(contract.wfh_fx_rate))
    : 0;

  const gross = wholeRupee(
    contract.contract_base +
    wfhAllowance +
    contract.other_allowance
  );

  const net = wholeRupee(Math.max(0, gross - contract.deductions));

  return {
    basic: contract.basic,
    hra: contract.hra,
    medical: contract.medical,
    utility: contract.utility,
    contract_base: contract.contract_base,
    wfh_usd: contract.wfh_usd,
    wfh_fx_rate: contract.wfh_fx_rate,
    wfh_allowance: wfhAllowance,
    include_wfh: contract.include_wfh,
    other_allowance: contract.other_allowance,
    deductions: contract.deductions,
    gross,
    net,
    remaining: net,
    payday: contract.payday,
    payout_account_id: contract.payout_account_id,
    include_in_forecast: contract.include_in_forecast
  };
}

function nextPaydayWithinHorizon(today, horizonEnd, payday) {
  const start = parseIsoDate(today);
  const end = parseIsoDate(horizonEnd);

  if (!start || !end) return '';

  const candidates = [
    paydayDate(start.getUTCFullYear(), start.getUTCMonth(), payday),
    paydayDate(start.getUTCFullYear(), start.getUTCMonth() + 1, payday),
    paydayDate(start.getUTCFullYear(), start.getUTCMonth() + 2, payday)
  ];

  for (const candidate of candidates) {
    const iso = dateOnly(candidate);
    if (iso >= today && iso <= horizonEnd) return iso;
  }

  return '';
}

function paydayDate(year, monthIndex, payday) {
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(normalizePayday(payday), maxDay);

  return new Date(Date.UTC(year, monthIndex, day));
}

/* ─────────────────────────────
 * Debts
 * ───────────────────────────── */

async function loadDebts(db, today) {
  const cols = await tableColumns(db, 'debts');

  if (!cols.size) return [];

  const select = [
    'id',
    'name',
    'kind',
    'original_amount',
    'paid_amount',
    cols.has('remaining_amount') ? 'remaining_amount' : null,
    'status',
    'due_date',
    cols.has('due_day') ? 'due_day' : null,
    cols.has('next_due_date') ? 'next_due_date' : null,
    cols.has('installment_amount') ? 'installment_amount' : null,
    cols.has('frequency') ? 'frequency' : null,
    cols.has('notes') ? 'notes' : null,
    cols.has('created_at') ? 'created_at' : null
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM debts
     WHERE status IS NULL OR status = '' OR status = 'active'
     ORDER BY due_date ASC, name ASC`
  ).all();

  return (res.results || []).map(row => {
    const original = number(row.original_amount, 0);
    const paid = number(row.paid_amount, 0);
    const remaining = row.remaining_amount == null
      ? round2(original - paid)
      : number(row.remaining_amount, 0);

    const dueDate = normalizeDate(row.next_due_date || row.due_date || computeNextDueDate(row, today));

    return {
      id: row.id,
      name: row.name || row.id,
      kind: row.kind || '',
      original_amount: round2(original),
      paid_amount: round2(paid),
      remaining_amount: round2(Math.max(0, remaining)),
      status: row.status || 'active',
      due_date: dueDate,
      next_due_date: dueDate,
      due_day: row.due_day == null ? null : normalizePayday(row.due_day),
      installment_amount: row.installment_amount == null ? null : number(row.installment_amount, null),
      frequency: row.frequency || null,
      notes: row.notes || '',
      created_at: row.created_at || null
    };
  });
}

function computeNextDueDate(debt, today) {
  const explicit = normalizeDate(debt.next_due_date || debt.due_date);
  if (explicit) return explicit;

  const dueDay = normalizeNullablePayday(debt.due_day);
  if (!dueDay) return '';

  const start = parseIsoDate(today);
  if (!start) return '';

  const thisMonth = paydayDate(start.getUTCFullYear(), start.getUTCMonth(), dueDay);
  const thisMonthIso = dateOnly(thisMonth);

  if (thisMonthIso >= today) return thisMonthIso;

  return dateOnly(paydayDate(start.getUTCFullYear(), start.getUTCMonth() + 1, dueDay));
}

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

async function tableColumns(db, table) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function number(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? n : fallback;
}

function decimal(value) {
  return number(value, 0);
}

function decimalMoney(value, fallback = 0, places = 6) {
  const n = number(value, fallback);
  const factor = Math.pow(10, places);

  return Math.round(n * factor) / factor;
}

function round2(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function wholeRupee(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

function safeText(value, fallback = '', max = 500) {
  const raw = value === undefined || value === null ? fallback : value;

  return String(raw === undefined || raw === null ? '' : raw).trim().slice(0, max);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(raw)) return false;

  return fallback;
}

function normalizeDate(value) {
  const raw = String(value || '').trim();

  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  return '';
}

function normalizeEffectiveMonth(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7);

  return currentMonth();
}

function normalizePayday(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 1;

  return Math.min(31, Math.max(1, Math.floor(n)));
}

function normalizeNullablePayday(value) {
  if (value === undefined || value === null || value === '') return null;

  const n = Number(value);

  if (!Number.isFinite(n) || n < 1 || n > 31) return null;

  return Math.floor(n);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(startIso, days) {
  const d = parseIsoDate(startIso) || new Date();

  d.setUTCDate(d.getUTCDate() + Number(days || 0));

  return dateOnly(d);
}

function parseIsoDate(value) {
  const raw = normalizeDate(value);

  if (!raw) return null;

  const d = new Date(raw + 'T00:00:00.000Z');

  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function inRange(date, start, end) {
  const d = normalizeDate(date);

  if (!d) return false;

  return d >= start && d <= end;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
