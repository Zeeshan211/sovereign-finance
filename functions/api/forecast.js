/* /api/forecast
 * Sovereign Finance · Forecast Brain
 * v0.9.0-source-contract-hardening
 *
 * Backend hardening:
 * - Forecast orchestrates canonical APIs; it does not reinterpret money truth blindly.
 * - Bills use /api/bills current_cycle.remaining_amount/current_cycle.status.
 * - Salary uses /api/salary forecast_eligible_monthly.
 * - Source health is explicit: ready / degraded / source_error.
 * - Crisis attribution explains first breach and lowest-liquid day.
 * - CC minimum source is labelled api vs estimated_5pct.
 */

const VERSION = 'v0.9.0-source-contract-hardening';

const DEFAULT_CRISIS_FLOOR = 5000;
const DEFAULT_FORECAST_DAYS = 90;
const DEFAULT_FORECAST_MONTHS = 6;

const REQUIRED_SOURCES = {
  '/api/balances': true,
  '/api/salary': true,
  '/api/bills': true,
  '/api/debts': true,
  '/api/cc': false
};

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: jsonHeaders
  });
}

function asNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function round2(value) {
  return Math.round(asNumber(value, 0) * 100) / 100;
}

function todayDate() {
  return new Date();
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value, fallback = null) {
  if (!value) return fallback;

  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) return fallback;

  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function dateForMonthDay(anchor, dueDay) {
  const day = Math.max(
    1,
    Math.min(asNumber(dueDay, 1), daysInMonth(anchor.getUTCFullYear(), anchor.getUTCMonth()))
  );

  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), day));
}

function sameMonthDate(anchor, explicitDate, dueDay) {
  const parsed = parseDate(explicitDate, null);
  if (parsed) return parsed;

  return dateForMonthDay(anchor, dueDay || 1);
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthName(date) {
  return date.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function isClosedStatus(status) {
  return ['settled', 'archived', 'closed', 'paid', 'cleared'].includes(String(status || '').toLowerCase());
}

function getArray(payload, keys) {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }

  return [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

async function readInternal(request, path) {
  const url = new URL(path, request.url);
  const headers = new Headers();

  headers.set('accept', 'application/json');

  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);

  const authorization = request.headers.get('authorization');
  if (authorization) headers.set('authorization', authorization);

  const cfAccessJwt = request.headers.get('cf-access-jwt-assertion');
  if (cfAccessJwt) headers.set('cf-access-jwt-assertion', cfAccessJwt);

  const response = await fetch(url.toString(), {
    headers,
    cache: 'no-store'
  });

  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  let payload = null;
  let parseError = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    parseError = error.message;
  }

  return {
    path,
    ok: response.ok && payload !== null && typeof payload === 'object' && payload.ok !== false,
    status: response.status,
    content_type: contentType,
    version: payload?.version || payload?.api_version || payload?.meta?.version || null,
    payload,
    debug: {
      parse_error: parseError,
      text_preview: text.slice(0, 500)
    }
  };
}

/* ─────────────────────────────
 * Source normalization
 * ───────────────────────────── */

function normalizeAccounts(balancesPayload) {
  const rawAccounts = balancesPayload?.accounts || {};
  const entries = Array.isArray(rawAccounts)
    ? rawAccounts.map(account => [account.id || account.account_id, account])
    : Object.entries(rawAccounts);

  return entries
    .filter(([id]) => id)
    .map(([id, account]) => {
      const type = String(account.type || account.kind || '').toLowerCase();
      const balance = round2(account.balance ?? account.current_balance ?? account.amount);

      return {
        id,
        name: account.name || account.label || id,
        type,
        kind: account.kind || type,
        balance,
        opening_balance: round2(account.opening_balance),
        included_in_liquid: type !== 'liability' && id !== 'cc'
      };
    });
}

function normalizeBalanceSource(balancesPayload) {
  const accounts = normalizeAccounts(balancesPayload);

  const liquidFromAccounts = accounts
    .filter(account => account.included_in_liquid)
    .reduce((sum, account) => sum + account.balance, 0);

  const liquidNow = round2(firstDefined(
    balancesPayload?.totals?.liquid,
    balancesPayload?.totals?.assets,
    balancesPayload?.total_liquid,
    balancesPayload?.cash,
    balancesPayload?.total_liquid_assets,
    liquidFromAccounts
  ));

  const ccOutstanding = round2(firstDefined(
    balancesPayload?.cc_outstanding,
    balancesPayload?.cc,
    Math.max(0, -asNumber(accounts.find(account => account.id === 'cc')?.balance, 0))
  ));

  const payableDebt = round2(firstDefined(
    balancesPayload?.payable_debt_remaining,
    balancesPayload?.total_owed,
    balancesPayload?.total_debts,
    0
  ));

  const receivables = round2(firstDefined(
    balancesPayload?.total_receivables,
    balancesPayload?.receivables_from_debts,
    0
  ));

  return {
    source_version: balancesPayload?.version || null,
    liquid_now: liquidNow,
    net_worth: round2(balancesPayload?.net_worth ?? balancesPayload?.totals?.net_worth),
    true_burden: round2(balancesPayload?.true_burden),
    cc_outstanding: ccOutstanding,
    payable_debt_remaining: payableDebt,
    total_receivables: receivables,
    accounts
  };
}

function normalizeSalary(salaryPayload, anchorDate) {
  const root = salaryPayload?.salary || salaryPayload?.data || salaryPayload?.current || salaryPayload || {};
  const truth = salaryPayload?.salary_truth || {};

  const guaranteed = round2(firstDefined(
    root.guaranteed_monthly,
    root.guaranteed_net_monthly,
    truth.guaranteed_net,
    salaryPayload?.guaranteed_monthly,
    root.net_monthly,
    0
  ));

  const variableConfirmed = Boolean(firstDefined(
    root.variable_confirmed,
    salaryPayload?.variable_confirmed,
    false
  ));

  const variableMonthly = variableConfirmed
    ? round2(firstDefined(root.variable_monthly, root.variable_net_monthly, truth.variable_net, salaryPayload?.variable_monthly, 0))
    : 0;

  const forecastEligible = round2(firstDefined(
    root.forecast_eligible_monthly,
    truth.expected_net,
    salaryPayload?.forecast_eligible_monthly,
    guaranteed + variableMonthly
  ));

  const salaryMonth = root.salary_month || salaryPayload?.salary_month || salaryPayload?.current_month?.month || monthKey(anchorDate);
  const payDay = asNumber(root.pay_day || truth.payday?.day, 1);
  const salaryDate = dateForMonthDay(anchorDate, payDay);

  if (salaryDate < anchorDate) {
    salaryDate.setUTCMonth(salaryDate.getUTCMonth() + 1);
  }

  const breakdown = root.variable_breakdown || salaryPayload?.variable_breakdown || {};

  return {
    id: root.id || 'primary',
    source_version: salaryPayload?.version || null,
    schema_version: salaryPayload?.schema_version || null,
    salary_month: salaryMonth,
    forecast_date: isoDate(salaryDate),
    guaranteed_monthly: guaranteed,
    variable_confirmed: variableConfirmed,
    variable_monthly: variableMonthly,
    forecast_eligible_monthly: forecastEligible,

    wfh_included: Boolean(firstDefined(root.wfh_included, root.include_wfh, salaryPayload?.wfh_included, breakdown.wfh_allowance ? true : false)),
    wfh_usd: round2(firstDefined(root.wfh_usd, salaryPayload?.wfh_usd, breakdown.wfh_usd, 0)),
    wfh_fx_rate: round2(firstDefined(root.wfh_fx_rate, salaryPayload?.wfh_fx_rate, breakdown.wfh_fx_rate, 0)),
    wfh_allowance: round2(firstDefined(root.wfh_allowance, salaryPayload?.wfh_allowance, breakdown.wfh_allowance, 0)),

    mbo_included: Boolean(firstDefined(root.mbo_included, salaryPayload?.mbo_included, root.variable_confirmed, false)),
    mbo_amount: round2(firstDefined(root.mbo_amount, root.mbo, salaryPayload?.mbo_amount, breakdown.mbo, 0)),
    mbo_tax: round2(firstDefined(root.mbo_tax, salaryPayload?.mbo_tax, 0)),
    mbo_net: round2(firstDefined(root.mbo_net, salaryPayload?.mbo_net, breakdown.mbo_net, 0)),

    other_extras_included: Boolean(firstDefined(root.other_extras_included, root.include_one_off_extras, salaryPayload?.other_extras_included, false)),
    other_extras_gross: round2(firstDefined(root.other_extras_gross, root.one_off_extras, salaryPayload?.other_extras_gross, 0)),
    other_extras_tax: round2(firstDefined(root.other_extras_tax, salaryPayload?.other_extras_tax, 0)),
    other_extras_net: round2(firstDefined(root.other_extras_net, salaryPayload?.other_extras_net, 0)),

    annual_taxable_income: round2(firstDefined(root.annual_taxable_income, root.fy_taxable, salaryPayload?.annual_taxable_income, 0)),
    annual_tax_liability: round2(firstDefined(root.annual_tax_liability, root.fy_tax_total, salaryPayload?.annual_tax_liability, 0)),
    effective_tax_rate: round2(firstDefined(root.effective_tax_rate, root.tax_rate_pct, salaryPayload?.effective_tax_rate, 0)),
    marginal_tax_rate: round2(firstDefined(root.marginal_tax_rate, salaryPayload?.marginal_tax_rate, 0)),

    current_month: salaryPayload?.current_month || null,
    variable_breakdown: breakdown,
    engine: root.salary_engine || salaryPayload?.salary_engine || salaryPayload?.schema_version || null
  };
}

function normalizeBills(billsPayload, anchorDate) {
  const rows = getArray(billsPayload, ['bills', 'data', 'results']);

  return rows.map(bill => {
    const cycle = bill.current_cycle || {};
    const amount = round2(firstDefined(
      cycle.amount,
      cycle.amount_paisa != null ? asNumber(cycle.amount_paisa) / 100 : undefined,
      bill.amount,
      bill.expected_amount,
      bill.monthly_amount,
      0
    ));

    const remaining = round2(firstDefined(
      cycle.remaining_amount,
      cycle.remaining_paisa != null ? asNumber(cycle.remaining_paisa) / 100 : undefined,
      bill.remaining_amount,
      bill.remaining_paisa != null ? asNumber(bill.remaining_paisa) / 100 : undefined,
      null
    ));

    const paid = round2(firstDefined(
      cycle.paid_amount,
      cycle.paid_paisa != null ? asNumber(cycle.paid_paisa) / 100 : undefined,
      bill.paid_amount,
      0
    ));

    const status = String(firstDefined(
      cycle.status,
      bill.payment_status,
      bill.status,
      ''
    )).toLowerCase();

    let dueDate = sameMonthDate(anchorDate, bill.due_date, bill.due_day);

    if (dueDate < anchorDate && remaining > 0) {
      dueDate = anchorDate;
    }

    const ignoredPayments = Array.isArray(cycle.ignored_payments) ? cycle.ignored_payments : [];
    const ledgerReversedExcluded = ignoredPayments.filter(payment => (
      payment.effective_status === 'ledger_reversed' ||
      payment.ledger_reversed === true
    )).length;

    const remainingAmount = Number.isFinite(remaining)
      ? Math.max(0, remaining)
      : (status === 'paid' || status === 'cleared' ? 0 : amount);

    return {
      id: bill.id,
      name: bill.name || bill.title || bill.bill_name || bill.label || bill.id,
      category_id: bill.category_id || null,
      amount,
      paid_amount: paid,
      remaining_amount: round2(remainingAmount),
      due_day: bill.due_day || null,
      due_date: isoDate(dueDate),
      current_month_cleared: status === 'paid' || status === 'cleared',
      status,
      current_cycle_status: status,
      raw_payment_count: asNumber(cycle.raw_payment_count, 0),
      active_payment_count: asNumber(cycle.active_payment_count, 0),
      ignored_payment_count: asNumber(cycle.ignored_payment_count, 0),
      ledger_reversed_excluded_count: ledgerReversedExcluded,
      source: 'bills.current_cycle'
    };
  });
}

function normalizeDebts(debtsPayload, anchorDate) {
  const rows = getArray(debtsPayload, ['debts', 'data', 'results']);
  const activeRows = rows.filter(debt => !isClosedStatus(debt.status));

  const payable = [];
  const receivable = [];

  for (const debt of activeRows) {
    const kind = String(debt.kind || debt.type || debt.direction || '').toLowerCase();
    const original = asNumber(firstDefined(debt.original_amount, debt.amount, debt.total_amount, 0), 0);
    const paid = asNumber(firstDefined(debt.paid_amount, debt.received_amount, debt.settled_amount, 0), 0);
    const remaining = round2(firstDefined(debt.remaining_amount, debt.remaining, debt.balance, Math.max(0, original - paid)));

    if (remaining <= 0) continue;

    const dueDate = parseDate(
      firstDefined(debt.due_date, debt.next_due_date, debt.follow_up_date),
      null
    );

    const normalized = {
      id: debt.id,
      name: debt.name || debt.person || debt.creditor || debt.debtor || debt.counterparty || debt.title || debt.id,
      kind,
      status: debt.status || 'active',
      original_amount: original,
      paid_amount: paid,
      remaining_amount: remaining,
      due_date: dueDate ? isoDate(dueDate) : null,
      source: 'debts'
    };

    if (kind === 'owe') payable.push(normalized);
    if (kind === 'owed') receivable.push(normalized);
  }

  payable.sort((a, b) => {
    const ad = parseDate(a.due_date, addDays(anchorDate, 365));
    const bd = parseDate(b.due_date, addDays(anchorDate, 365));
    return ad - bd;
  });

  receivable.sort((a, b) => {
    const ad = parseDate(a.due_date, addDays(anchorDate, 365));
    const bd = parseDate(b.due_date, addDays(anchorDate, 365));
    return ad - bd;
  });

  return { payable, receivable };
}

function normalizeCc(ccPayload, balanceCcOutstanding, anchorDate) {
  const rows = getArray(ccPayload, ['accounts', 'cards', 'credit_cards', 'creditCards', 'data']);

  let totalOutstanding = firstDefined(
    ccPayload?.total_outstanding,
    ccPayload?.totalOutstanding,
    ccPayload?.summary?.total_outstanding,
    ccPayload?.summary?.outstanding,
    ccPayload?.totals?.outstanding,
    null
  );

  if (totalOutstanding === null) {
    totalOutstanding = rows.reduce((sum, card) => {
      const balance = asNumber(firstDefined(card.balance, card.current_balance, 0));

      const outstanding = firstDefined(
        card.outstanding,
        card.cc_outstanding,
        card.current_outstanding,
        balance < 0 ? Math.abs(balance) : undefined,
        0
      );

      return sum + asNumber(outstanding, 0);
    }, 0);
  }

  if (!totalOutstanding && balanceCcOutstanding) totalOutstanding = balanceCcOutstanding;

  const primary = rows[0] || {};
  const outstanding = round2(totalOutstanding);

  const minimumDueRaw = firstDefined(
    primary.minimum_due,
    primary.minimumDue,
    primary.minimum_payment,
    primary.min_payment_amount,
    primary.minimum_payment_amount,
    ccPayload?.minimum_due,
    ccPayload?.summary?.minimum_due,
    null
  );

  const minimumDue = round2(minimumDueRaw === null ? outstanding * 0.05 : minimumDueRaw);

  const dueDate = parseDate(
    firstDefined(primary.payment_due_date, primary.due_date, primary.next_due_date, ccPayload?.due_date),
    null
  );

  return {
    outstanding,
    minimum_due: minimumDue,
    minimum_due_source: minimumDueRaw === null ? 'estimated_outstanding_5pct' : 'api',
    due_date: dueDate ? isoDate(dueDate) : null,
    days_until_due: primary.days_until_payment_due ?? primary.days_until_due ?? null,
    accounts: rows
  };
}

/* ─────────────────────────────
 * Forecast construction
 * ───────────────────────────── */

function buildEvents({ anchorDate, salary, bills, debts, cc, mode }) {
  const events = [];

  if (salary.forecast_eligible_monthly > 0) {
    events.push({
      date: salary.forecast_date,
      type: 'salary',
      label: 'Salary forecast',
      amount: salary.forecast_eligible_monthly,
      direction: 'inflow',
      required: true,
      source_id: 'salary.primary',
      source: 'salary'
    });
  }

  for (const bill of bills) {
    if (bill.remaining_amount <= 0) continue;

    events.push({
      date: bill.due_date,
      type: 'bill',
      label: bill.name,
      amount: bill.remaining_amount,
      direction: 'outflow',
      required: true,
      source_id: bill.id,
      source: 'bills',
      metadata: {
        status: bill.current_cycle_status,
        paid_amount: bill.paid_amount,
        ignored_payment_count: bill.ignored_payment_count,
        ledger_reversed_excluded_count: bill.ledger_reversed_excluded_count
      }
    });
  }

  const payableDue = debts.payable.filter(debt => debt.due_date);
  const payableNoDate = debts.payable.filter(debt => !debt.due_date);

  for (const debt of payableDue) {
    const planned = mode === 'survival'
      ? 0
      : Math.min(debt.remaining_amount, mode === 'aggressive' ? debt.remaining_amount : debt.remaining_amount);

    if (planned <= 0) continue;

    events.push({
      date: debt.due_date,
      type: 'debt_payable',
      label: `Debt payment: ${debt.name}`,
      amount: planned,
      direction: 'outflow',
      required: mode !== 'aggressive',
      source_id: debt.id,
      source: 'debts'
    });
  }

  if (mode === 'aggressive' && payableNoDate.length) {
    const salaryDate = parseDate(salary.forecast_date, addDays(anchorDate, 20));

    for (const debt of payableNoDate) {
      events.push({
        date: isoDate(salaryDate),
        type: 'debt_payable',
        label: `Debt payment: ${debt.name}`,
        amount: debt.remaining_amount,
        direction: 'outflow',
        required: false,
        source_id: debt.id,
        source: 'debts'
      });
    }
  }

  for (const debt of debts.receivable) {
    if (!debt.due_date) continue;

    events.push({
      date: debt.due_date,
      type: 'debt_receivable',
      label: `Receivable: ${debt.name}`,
      amount: debt.remaining_amount,
      direction: 'inflow_optional',
      required: false,
      source_id: debt.id,
      source: 'debts'
    });
  }

  if (cc.minimum_due > 0 && cc.due_date) {
    events.push({
      date: cc.due_date,
      type: 'credit_card_minimum',
      label: 'Credit card minimum due',
      amount: cc.minimum_due,
      direction: 'outflow',
      required: true,
      source_id: 'cc',
      source: 'cc',
      metadata: {
        minimum_due_source: cc.minimum_due_source,
        outstanding: cc.outstanding
      }
    });
  }

  events.sort((a, b) => {
    const ad = parseDate(a.date, anchorDate);
    const bd = parseDate(b.date, anchorDate);

    if (ad.getTime() !== bd.getTime()) return ad - bd;

    return String(a.type).localeCompare(String(b.type));
  });

  return events;
}

function buildDailyProjection({ anchorDate, horizonDays, liquidNow, crisisFloor, events }) {
  const eventMap = new Map();

  for (const event of events) {
    if (!event.date) continue;
    if (!eventMap.has(event.date)) eventMap.set(event.date, []);
    eventMap.get(event.date).push(event);
  }

  const projection = [];

  let runningRequired = round2(liquidNow);
  let runningWithReceivables = round2(liquidNow);

  for (let i = 0; i <= horizonDays; i += 1) {
    const date = addDays(anchorDate, i);
    const key = isoDate(date);
    const dayEvents = eventMap.get(key) || [];

    const openingRequired = runningRequired;
    const openingWithReceivables = runningWithReceivables;

    const inflows = dayEvents
      .filter(event => event.direction === 'inflow')
      .reduce((sum, event) => sum + event.amount, 0);

    const optionalInflows = dayEvents
      .filter(event => event.direction === 'inflow_optional')
      .reduce((sum, event) => sum + event.amount, 0);

    const outflows = dayEvents
      .filter(event => event.direction === 'outflow')
      .reduce((sum, event) => sum + event.amount, 0);

    runningRequired = round2(runningRequired + inflows - outflows);
    runningWithReceivables = round2(runningWithReceivables + inflows + optionalInflows - outflows);

    const requiredGap = round2(runningRequired - crisisFloor);
    const withReceivablesGap = round2(runningWithReceivables - crisisFloor);

    projection.push({
      date: key,
      opening_liquid: round2(openingRequired),
      opening_liquid_with_receivables: round2(openingWithReceivables),
      inflows: round2(inflows),
      optional_inflows: round2(optionalInflows),
      outflows: round2(outflows),
      closing_liquid: runningRequired,
      closing_liquid_with_receivables: runningWithReceivables,
      crisis_floor: crisisFloor,
      gap_to_crisis_floor: requiredGap,
      gap_to_crisis_floor_with_receivables: withReceivablesGap,
      below_crisis_floor: runningRequired < crisisFloor,
      status: runningRequired < crisisFloor
        ? 'crisis'
        : runningRequired < crisisFloor + 5000
          ? 'danger'
          : runningRequired < crisisFloor + 15000
            ? 'watch'
            : 'safe',
      events: dayEvents
    });
  }

  return projection;
}

function summarizeMonthly({ anchorDate, months, liquidNow, crisisFloor, salary, bills, debts, cc }) {
  const rows = [];

  let opening = round2(liquidNow);
  let debtRemaining = round2(debts.payable.reduce((sum, debt) => sum + debt.remaining_amount, 0));
  let debtFreeDate = null;

  for (let i = 0; i < months; i += 1) {
    const monthStart = addMonths(anchorDate, i);
    const key = monthKey(monthStart);

    const salaryAmount = salary.forecast_eligible_monthly;

    const billAmount = bills
      .filter(bill => bill.remaining_amount > 0)
      .reduce((sum, bill) => sum + bill.remaining_amount, 0);

    const ccMinimum = cc.minimum_due;

    const availableAfterRequired = round2(opening + salaryAmount - billAmount - ccMinimum);
    const surplusAboveFloor = Math.max(0, round2(availableAfterRequired - crisisFloor));
    const debtPayment = Math.min(debtRemaining, surplusAboveFloor);

    debtRemaining = round2(debtRemaining - debtPayment);

    const closing = round2(availableAfterRequired - debtPayment);
    const savedAboveFloor = Math.max(0, round2(closing - crisisFloor));

    if (!debtFreeDate && debtRemaining <= 0) {
      debtFreeDate = isoDate(monthStart);
    }

    rows.push({
      month: key,
      label: monthName(monthStart),
      opening_liquid: opening,
      salary: round2(salaryAmount),
      bills: round2(billAmount),
      cc_minimum: round2(ccMinimum),
      debt_payment_applied_from_surplus: round2(debtPayment),
      closing_liquid: closing,
      crisis_floor: crisisFloor,
      saved_above_crisis_floor: savedAboveFloor,
      debt_remaining: debtRemaining,
      is_debt_free: debtRemaining <= 0,
      mode: 'debt_free_surplus_after_floor'
    });

    opening = closing;
  }

  return { rows, debtFreeDate };
}

function buildInsights({ dailyProjection, monthlyProjection, crisisFloor, liquidNow, debts }) {
  const lowest = dailyProjection.reduce((min, row) => {
    if (!min) return row;
    return row.closing_liquid < min.closing_liquid ? row : min;
  }, null);

  const crisisBreaches = dailyProjection.filter(row => row.below_crisis_floor);
  const payableDebtRemaining = round2(debts.payable.reduce((sum, debt) => sum + debt.remaining_amount, 0));
  const receivableRemaining = round2(debts.receivable.reduce((sum, debt) => sum + debt.remaining_amount, 0));
  const firstDebtFreeMonth = monthlyProjection.find(row => row.is_debt_free) || null;
  const thisMonth = monthlyProjection[0] || null;
  const nextMonth = monthlyProjection[1] || null;

  return {
    liquid_now: liquidNow,
    crisis_floor: crisisFloor,
    lowest_liquid_date: lowest?.date || null,
    lowest_liquid_amount: lowest ? lowest.closing_liquid : null,
    lowest_liquid_gap_to_floor: lowest ? round2(lowest.closing_liquid - crisisFloor) : null,
    crisis_floor_breaches: crisisBreaches.map(row => ({
      date: row.date,
      closing_liquid: row.closing_liquid,
      gap_to_crisis_floor: row.gap_to_crisis_floor
    })),
    first_crisis_breach_date: crisisBreaches[0]?.date || null,
    payable_debt_remaining: payableDebtRemaining,
    receivable_remaining: receivableRemaining,
    debt_free_date: firstDebtFreeMonth?.month || null,
    months_to_debt_free: firstDebtFreeMonth ? monthlyProjection.indexOf(firstDebtFreeMonth) + 1 : null,
    expected_saved_this_month: thisMonth?.saved_above_crisis_floor ?? null,
    expected_saved_next_month: nextMonth?.saved_above_crisis_floor ?? null,
    required_cash_to_avoid_crisis: lowest ? Math.max(0, round2(crisisFloor - lowest.closing_liquid)) : 0,
    status: crisisBreaches.length
      ? 'crisis'
      : lowest && lowest.closing_liquid < crisisFloor + 5000
        ? 'danger'
        : lowest && lowest.closing_liquid < crisisFloor + 15000
          ? 'watch'
          : 'safe'
  };
}

function buildCrisisAnalysis({ dailyProjection, insights, crisisFloor }) {
  const firstBreach = insights.first_crisis_breach_date
    ? dailyProjection.find(row => row.date === insights.first_crisis_breach_date)
    : null;

  const lowest = insights.lowest_liquid_date
    ? dailyProjection.find(row => row.date === insights.lowest_liquid_date)
    : null;

  const driverMap = new Map();

  for (const row of dailyProjection) {
    for (const event of row.events || []) {
      if (event.direction !== 'outflow') continue;
      const key = event.type;
      driverMap.set(key, round2((driverMap.get(key) || 0) + event.amount));
    }
  }

  const topDrivers = Array.from(driverMap.entries())
    .map(([type, amount]) => ({ type, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    first_breach_date: insights.first_crisis_breach_date,
    first_breach: firstBreach ? {
      date: firstBreach.date,
      opening_liquid: firstBreach.opening_liquid,
      inflows: firstBreach.inflows,
      optional_inflows: firstBreach.optional_inflows,
      outflows: firstBreach.outflows,
      closing_liquid: firstBreach.closing_liquid,
      crisis_floor: firstBreach.crisis_floor,
      gap_to_crisis_floor: firstBreach.gap_to_crisis_floor,
      events: firstBreach.events
    } : null,
    lowest_date: insights.lowest_liquid_date,
    lowest: lowest ? {
      date: lowest.date,
      opening_liquid: lowest.opening_liquid,
      inflows: lowest.inflows,
      optional_inflows: lowest.optional_inflows,
      outflows: lowest.outflows,
      closing_liquid: lowest.closing_liquid,
      crisis_floor: lowest.crisis_floor,
      gap_to_crisis_floor: lowest.gap_to_crisis_floor,
      events: lowest.events
    } : null,
    required_cash_to_avoid_crisis: insights.required_cash_to_avoid_crisis,
    crisis_floor: crisisFloor,
    top_drivers: topDrivers
  };
}

function buildSourcePolicy(sourceStatus) {
  const requiredFailed = sourceStatus.filter(source => REQUIRED_SOURCES[source.path] && !source.ok);
  const optionalFailed = sourceStatus.filter(source => !REQUIRED_SOURCES[source.path] && !source.ok);

  let status = 'ready';

  if (requiredFailed.some(source => source.path === '/api/balances')) {
    status = 'source_error';
  } else if (requiredFailed.length || optionalFailed.length) {
    status = 'degraded';
  }

  return {
    status,
    required_failed: requiredFailed.map(source => source.path),
    optional_failed: optionalFailed.map(source => source.path),
    required_sources: Object.keys(REQUIRED_SOURCES).filter(path => REQUIRED_SOURCES[path]),
    optional_sources: Object.keys(REQUIRED_SOURCES).filter(path => !REQUIRED_SOURCES[path])
  };
}

function buildProof({ balances, salary, bills, debts, cc, sourcePolicy }) {
  return {
    version: VERSION,
    forecast_role: 'orchestrator',
    source_policy_status: sourcePolicy.status,
    balance_source: balances.source_version || null,
    salary_source: salary.source_version || null,
    bills_rule: 'current_cycle.remaining_amount',
    bills_source: 'api_bills_current_cycle',
    debt_source: 'api_debts_remaining_amount',
    cc_source: 'api_cc_or_balance_fallback',
    cc_minimum_rule: cc.minimum_due_source,
    receivables_policy: 'optional_inflow_not_required_safety_cash',
    debt_policy: 'surplus_above_crisis_floor',
    checks: [
      {
        check: 'balances_required',
        status: sourcePolicy.required_failed.includes('/api/balances') ? 'fail' : 'pass',
        detail: 'Forecast cannot run without liquid balance truth.'
      },
      {
        check: 'bills_effective_state',
        status: 'pass',
        detail: 'Bills use current_cycle.remaining_amount and preserve ignored payment metadata.'
      },
      {
        check: 'salary_forecast_eligible',
        status: salary.forecast_eligible_monthly > 0 ? 'pass' : 'warn',
        detail: 'Salary forecast uses /api/salary forecast_eligible_monthly.'
      },
      {
        check: 'cc_minimum_source',
        status: cc.minimum_due_source === 'api' ? 'pass' : 'warn',
        detail: cc.minimum_due_source === 'api'
          ? 'Credit card minimum due is API-backed.'
          : 'Credit card minimum due is estimated at 5% of outstanding.'
      }
    ],
    summary: {
      bills_remaining: round2(bills.reduce((sum, bill) => sum + bill.remaining_amount, 0)),
      debt_payable_remaining: round2(debts.payable.reduce((sum, debt) => sum + debt.remaining_amount, 0)),
      debt_receivable_remaining: round2(debts.receivable.reduce((sum, debt) => sum + debt.remaining_amount, 0)),
      cc_outstanding: cc.outstanding,
      cc_minimum_due: cc.minimum_due
    }
  };
}

/* ─────────────────────────────
 * Handler
 * ───────────────────────────── */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return json({
      ok: false,
      version: VERSION,
      error: 'method_not_allowed'
    }, 405);
  }

  const anchorDate = todayDate();
  const crisisFloor = Math.max(0, asNumber(url.searchParams.get('crisis_floor'), DEFAULT_CRISIS_FLOOR));
  const horizonDays = Math.max(30, Math.min(365, asNumber(url.searchParams.get('days'), DEFAULT_FORECAST_DAYS)));
  const horizonMonths = Math.max(3, Math.min(24, asNumber(url.searchParams.get('months'), DEFAULT_FORECAST_MONTHS)));
  const mode = String(url.searchParams.get('mode') || 'normal').toLowerCase();

  const [balancesResult, salaryResult, billsResult, debtsResult, ccResult] = await Promise.all([
    readInternal(request, '/api/balances'),
    readInternal(request, '/api/salary'),
    readInternal(request, '/api/bills'),
    readInternal(request, '/api/debts'),
    readInternal(request, '/api/cc')
  ]);

  const sourceStatus = [
    balancesResult,
    salaryResult,
    billsResult,
    debtsResult,
    ccResult
  ].map(source => ({
    path: source.path,
    ok: source.ok,
    required: Boolean(REQUIRED_SOURCES[source.path]),
    status: source.status,
    content_type: source.content_type,
    version: source.version,
    parse_error: source.debug?.parse_error || null,
    preview: source.debug?.text_preview || null
  }));

  const sourcePolicy = buildSourcePolicy(sourceStatus);

  if (!balancesResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      status: 'source_error',
      error: 'balances_source_unavailable',
      generated_at: new Date().toISOString(),
      forecast_meta: {
        as_of_date: isoDate(anchorDate),
        forecast_days: horizonDays,
        forecast_months: horizonMonths,
        crisis_floor: crisisFloor,
        mode
      },
      sources: sourceStatus,
      source_policy: sourcePolicy,
      debug: {
        request_url: request.url,
        balances_status: balancesResult.status,
        balances_version: balancesResult.version,
        balances_payload_keys: balancesResult.payload && typeof balancesResult.payload === 'object'
          ? Object.keys(balancesResult.payload)
          : [],
        balances_payload_preview: balancesResult.payload
      }
    }, 200);
  }

  const balances = normalizeBalanceSource(balancesResult.payload || {});
  const salary = normalizeSalary(salaryResult.payload || {}, anchorDate);
  const bills = normalizeBills(billsResult.payload || {}, anchorDate);
  const debts = normalizeDebts(debtsResult.payload || {}, anchorDate);
  const cc = normalizeCc(ccResult.payload || {}, balances.cc_outstanding, anchorDate);

  const events = buildEvents({
    anchorDate,
    salary,
    bills,
    debts,
    cc,
    mode
  });

  const dailyProjection = buildDailyProjection({
    anchorDate,
    horizonDays,
    liquidNow: balances.liquid_now,
    crisisFloor,
    events
  });

  const monthlyResult = summarizeMonthly({
    anchorDate,
    months: horizonMonths,
    liquidNow: balances.liquid_now,
    crisisFloor,
    salary,
    bills,
    debts,
    cc
  });

  const monthlyProjection = monthlyResult.rows;

  const insights = buildInsights({
    dailyProjection,
    monthlyProjection,
    crisisFloor,
    liquidNow: balances.liquid_now,
    debts
  });

  const crisisAnalysis = buildCrisisAnalysis({
    dailyProjection,
    insights,
    crisisFloor
  });

  const obligationsThisMonth = {
    bills_remaining: round2(bills.reduce((sum, bill) => sum + bill.remaining_amount, 0)),
    bills_ledger_reversed_excluded_count: bills.reduce((sum, bill) => sum + asNumber(bill.ledger_reversed_excluded_count, 0), 0),
    bills_ignored_payment_count: bills.reduce((sum, bill) => sum + asNumber(bill.ignored_payment_count, 0), 0),
    debt_payable_remaining: round2(debts.payable.reduce((sum, debt) => sum + debt.remaining_amount, 0)),
    debt_receivable_remaining: round2(debts.receivable.reduce((sum, debt) => sum + debt.remaining_amount, 0)),
    cc_outstanding: cc.outstanding,
    cc_minimum_due: cc.minimum_due,
    cc_minimum_due_source: cc.minimum_due_source
  };

  const projectedCashAfterRequired = round2(
    balances.liquid_now +
    salary.forecast_eligible_monthly -
    obligationsThisMonth.bills_remaining -
    obligationsThisMonth.cc_minimum_due
  );

  const projectedCashAfterDebtPressure = round2(
    projectedCashAfterRequired -
    obligationsThisMonth.debt_payable_remaining
  );

  const projectedCashIfReceivablesCollected = round2(
    projectedCashAfterDebtPressure +
    obligationsThisMonth.debt_receivable_remaining
  );

  const proof = buildProof({
    balances,
    salary,
    bills,
    debts,
    cc,
    sourcePolicy
  });

  return json({
    ok: true,
    version: VERSION,
    status: sourcePolicy.status,
    generated_at: new Date().toISOString(),

    forecast_meta: {
      as_of_date: isoDate(anchorDate),
      forecast_days: horizonDays,
      forecast_months: horizonMonths,
      crisis_floor: crisisFloor,
      mode,
      source_policy: 'canonical recovered APIs only; Forecast orchestrates and simulates.',
      receivables_policy: 'optional upside, not required crisis safety cash',
      debt_policy: 'surplus_above_crisis_floor'
    },

    sources: sourceStatus,
    source_policy: sourcePolicy,

    current_position: {
      liquid_now: balances.liquid_now,
      net_worth: balances.net_worth,
      true_burden: balances.true_burden,
      cc_outstanding: balances.cc_outstanding,
      payable_debt_remaining: balances.payable_debt_remaining,
      total_receivables: balances.total_receivables,
      accounts: balances.accounts
    },

    salary,
    bills,
    debts,
    credit_card: cc,

    obligations_this_month: obligationsThisMonth,

    forecast: {
      projected_cash_after_required_obligations: projectedCashAfterRequired,
      projected_cash_after_debt_pressure: projectedCashAfterDebtPressure,
      projected_cash_if_receivables_collected: projectedCashIfReceivablesCollected,
      projected_cash_after_obligations: projectedCashAfterDebtPressure
    },

    daily_projection: dailyProjection,
    daily_cash_projection_30d: dailyProjection.slice(0, 31),
    monthly_projection: monthlyProjection,
    insights,
    crisis_analysis: crisisAnalysis,
    proof,

    compatibility: {
      inputs: {
        total_liquid: balances.liquid_now,
        guaranteed_salary: salary.forecast_eligible_monthly,
        bills_remaining_this_month: obligationsThisMonth.bills_remaining,
        debt_payable_remaining: obligationsThisMonth.debt_payable_remaining,
        debt_receivable_remaining: obligationsThisMonth.debt_receivable_remaining,
        credit_card_outstanding: obligationsThisMonth.cc_outstanding
      },
      salary: {
        forecast_eligible_monthly: salary.forecast_eligible_monthly,
        guaranteed_salary: salary.guaranteed_monthly,
        variable_monthly: salary.variable_monthly,
        variable_confirmed: salary.variable_confirmed
      },
      bills: {
        remaining_this_month: obligationsThisMonth.bills_remaining,
        ignored_payment_count: obligationsThisMonth.bills_ignored_payment_count,
        ledger_reversed_excluded_count: obligationsThisMonth.bills_ledger_reversed_excluded_count,
        rule: 'current_cycle.remaining_amount'
      },
      credit_card: {
        outstanding: cc.outstanding,
        minimum_due: cc.minimum_due,
        minimum_due_source: cc.minimum_due_source
      },
      cash_projection_summary: {
        ending_balance_30d: dailyProjection[30]?.closing_liquid ??
          dailyProjection[dailyProjection.length - 1]?.closing_liquid ??
          null,
        ending_balance_30d_with_receivables: dailyProjection[30]?.closing_liquid_with_receivables ?? null,
        lowest_projected_balance: insights.lowest_liquid_amount,
        first_unsafe_date: insights.first_crisis_breach_date,
        runway_status: insights.status
      },
      debt_free_forecast: {
        total_debt_remaining: insights.payable_debt_remaining,
        debt_count: debts.payable.length,
        estimated_debt_free_date_conservative: insights.debt_free_date,
        months_to_debt_free_conservative: insights.months_to_debt_free,
        conservative_monthly_free_cash_after_obligations: insights.expected_saved_this_month,
        policy: 'surplus_above_crisis_floor'
      }
    }
  });
}