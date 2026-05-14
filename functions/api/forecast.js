/* Sovereign Finance Forecast API
 * /api/forecast
 * v0.1.0-forecast-source-aggregate
 *
 * Purpose:
 * - Single lightweight endpoint for forecast page.
 * - Reads accounts, saved salary contract, and active debts from D1.
 * - Does not mutate ledger/accounts.
 */

const VERSION = 'v0.1.0-forecast-source-aggregate';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);

    const horizonDays = clampInt(url.searchParams.get('horizon'), 30, 1, 365);
    const includeSalary = url.searchParams.get('salary') !== 'exclude';
    const debtMode = url.searchParams.get('debts') || 'due';
    const buffer = moneyNumber(url.searchParams.get('buffer'), 0);

    const accounts = await loadAccounts(db);
    const salary = await loadSalarySource(db);
    const debts = await loadDebts(db);

    const today = todayISO();
    const horizonEnd = addDaysISO(horizonDays);

    const cashNow = round2(accounts.reduce((sum, account) => {
      if (!isCashAccount(account)) return sum;
      return sum + moneyNumber(account.balance, 0);
    }, 0));

    const events = [];

    if (includeSalary && salary.enabled && salary.amount > 0 && inRange(salary.expected_date, today, horizonEnd)) {
      events.push({
        id: 'salary_income',
        source: 'salary',
        type: 'income',
        title: 'Expected salary income',
        amount: salary.amount,
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

        const remaining = round2(moneyNumber(debt.original_amount, 0) - moneyNumber(debt.paid_amount, 0));
        if (remaining <= 0) continue;

        const dueDate = normalizeDate(debt.due_date || debt.next_due_date);
        const include =
          debtMode === 'all' ||
          (dueDate && inRange(dueDate, today, horizonEnd));

        if (!include) continue;

        events.push({
          id: `debt_${debt.id}`,
          source: 'debt',
          type: 'outflow',
          title: `Debt due: ${debt.name || debt.id}`,
          amount: -Math.abs(remaining),
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
        amount: buffer,
        date: horizonEnd,
        account_id: 'scenario',
        status: 'planning',
        description: 'Scenario-only adjustment; no ledger impact',
        raw: { buffer }
      });
    }

    events.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    const expectedIncome = round2(events.filter(e => e.amount > 0).reduce((sum, e) => sum + e.amount, 0));
    const expectedOutflow = round2(Math.abs(events.filter(e => e.amount < 0).reduce((sum, e) => sum + e.amount, 0)));
    const projectedEnd = round2(cashNow + expectedIncome - expectedOutflow);

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
        salary_enabled: salary.enabled,
        salary_amount: salary.amount,
        debts_count: debts.length
      },
      events,
      inputs: {
        accounts,
        salary,
        debts
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err),
      stack: String(err && err.stack ? err.stack : '').split('\n').slice(0, 6).join('\n')
    }, 500);
  }
}

/* -----------------------------
 * Loaders
 * ----------------------------- */

async function loadAccounts(db) {
  const cols = await tableColumns(db, 'accounts');
  if (!cols.size) return [];

  const select = [
    'id',
    cols.has('name') ? 'name' : null,
    cols.has('type') ? 'type' : null,
    cols.has('kind') ? 'kind' : null,
    cols.has('balance') ? 'balance' : null,
    cols.has('current_balance') ? 'current_balance' : null,
    cols.has('amount') ? 'amount' : null,
    cols.has('status') ? 'status' : null,
    cols.has('deleted_at') ? 'deleted_at' : null,
    cols.has('archived_at') ? 'archived_at' : null
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM accounts`
  ).all();

  return (res.results || []).map(row => ({
    id: row.id,
    name: row.name || row.id,
    type: row.type || row.kind || 'account',
    status: row.status || 'active',
    balance: moneyNumber(row.balance ?? row.current_balance ?? row.amount, 0),
    deleted_at: row.deleted_at || null,
    archived_at: row.archived_at || null
  }));
}

async function loadSalarySource(db) {
  const cols = await tableColumns(db, 'salary_contracts');

  if (!cols.size) {
    return {
      enabled: false,
      amount: 0,
      expected_date: '',
      payout_account_id: '',
      reason: 'salary_contracts table missing'
    };
  }

  const row = await db.prepare(
    `SELECT *
     FROM salary_contracts
     ORDER BY datetime(updated_at) DESC
     LIMIT 1`
  ).first();

  if (!row) {
    return {
      enabled: false,
      amount: 0,
      expected_date: '',
      payout_account_id: '',
      reason: 'no saved salary contract'
    };
  }

  const contractBase = moneyNumber(row.contract_base, 0);
  const wfhAllowance = Number(row.include_wfh || 0)
    ? round2(moneyNumber(row.wfh_usd, 0) * moneyNumber(row.wfh_fx_rate, 0))
    : 0;
  const otherAllowance = moneyNumber(row.other_allowance, 0);
  const deductions = moneyNumber(row.deductions, 0);
  const gross = round2(contractBase + wfhAllowance + otherAllowance);
  const net = round2(Math.max(0, gross - deductions));
  const expectedDate = expectedDateForMonth(row.effective_month || currentMonth(), row.payday || 1);

  return {
    enabled: Boolean(Number(row.include_in_forecast ?? 1)),
    amount: net,
    gross,
    deductions,
    expected_date: expectedDate,
    expected_payday: Number(row.payday || 1),
    payout_account_id: row.payout_account_id || '',
    effective_month: row.effective_month || currentMonth(),
    contract: row
  };
}

async function loadDebts(db) {
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
    cols.has('next_due_date') ? 'next_due_date' : null,
    cols.has('notes') ? 'notes' : null,
    cols.has('created_at') ? 'created_at' : null
  ].filter(Boolean);

  const res = await db.prepare(
    `SELECT ${select.join(', ')}
     FROM debts
     WHERE status IS NULL OR status = '' OR status = 'active'
     ORDER BY due_date ASC, name ASC`
  ).all();

  return (res.results || []).map(row => ({
    id: row.id,
    name: row.name || row.id,
    kind: row.kind || '',
    original_amount: moneyNumber(row.original_amount, 0),
    paid_amount: moneyNumber(row.paid_amount, 0),
    remaining_amount: row.remaining_amount == null
      ? round2(moneyNumber(row.original_amount, 0) - moneyNumber(row.paid_amount, 0))
      : moneyNumber(row.remaining_amount, 0),
    status: row.status || 'active',
    due_date: normalizeDate(row.next_due_date || row.due_date),
    notes: row.notes || '',
    created_at: row.created_at || null
  }));
}

/* -----------------------------
 * Helpers
 * ----------------------------- */

async function tableColumns(db, table) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${table})`).all();
    return new Set((res.results || []).map(row => row.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function isCashAccount(account) {
  const status = String(account.status || '').toLowerCase();
  if (['inactive', 'deleted', 'archived'].includes(status)) return false;
  if (account.deleted_at || account.archived_at) return false;

  const type = String(account.type || '').toLowerCase();
  if (['credit_card', 'loan', 'debt', 'liability'].includes(type)) return false;

  return true;
}

function moneyNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? round2(n) : fallback;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return '';
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function inRange(date, start, end) {
  const d = normalizeDate(date);
  if (!d) return false;
  return d >= start && d <= end;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function expectedDateForMonth(month, payday) {
  const normalized = /^\d{4}-\d{2}$/.test(String(month || ''))
    ? String(month)
    : currentMonth();

  const [yearText, monthText] = normalized.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Number(payday || 1)), maxDay);

  return `${normalized}-${String(day).padStart(2, '0')}`;
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