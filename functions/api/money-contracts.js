/* Sovereign Finance money-contracts API v0.1.1
   Ship 4: Credit Card + Salary contract hardening

   Endpoint:
   GET /api/money-contracts

   Contract:
   - Read-only.
   - No ledger mutation.
   - No audit_log writes.
   - Uses current D1 schema fields where available.
   - Credit Card contract can derive from accounts table.
   - Salary contract separates guaranteed, confirmed variable, and speculative variable.
*/

const VERSION = "0.1.1";

const TABLES = {
  accounts: "accounts",
  transactions: "transactions",
  bills: "bills",
  debts: "debts",
  salary: "salary",
  settings: "settings",
  reconciliation: "reconciliation",
  audit_log: "audit_log"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function fail(message, status = 500, extra = {}) {
  return json({ ok: false, version: VERSION, error: message, ...extra }, status);
}

function getDb(env) {
  return env.DB || env.SOVEREIGN_DB || env.FINANCE_DB || null;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function n(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function s(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function first(row, keys, fallback = null) {
  if (!row) return fallback;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return fallback;
}

function firstNumber(row, keys, fallback = 0) {
  return n(first(row, keys, fallback), fallback);
}

function firstString(row, keys, fallback = "") {
  return s(first(row, keys, fallback), fallback);
}

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.ceil((b.getTime() - a.getTime()) / 86400000);
}

function nextMonthlyDate(day) {
  const safe = Math.max(1, Math.min(28, Math.floor(n(day, 1))));
  const now = todayStart();
  let d = new Date(now.getFullYear(), now.getMonth(), safe);
  if (d < now) d = new Date(now.getFullYear(), now.getMonth() + 1, safe);
  return d;
}

async function tableExists(db, table) {
  const row = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1"
  ).bind(table).first();
  return !!row;
}

async function getColumns(db, table) {
  if (!(await tableExists(db, table))) return [];
  const result = await db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  return (result.results || []).map(col => col.name);
}

async function readRows(db, table, limit = 500) {
  const exists = await tableExists(db, table);
  if (!exists) return { exists: false, columns: [], rows: [] };

  const columns = await getColumns(db, table);
  const orderCol = ["updated_at", "created_at", "date", "due_date", "id"].find(col => columns.includes(col));
  const order = orderCol ? ` ORDER BY ${quoteIdent(orderCol)} DESC` : "";

  const result = await db.prepare(
    `SELECT * FROM ${quoteIdent(table)}${order} LIMIT ?`
  ).bind(Math.max(1, Math.min(Number(limit || 500), 1000))).all();

  return { exists: true, columns, rows: result.results || [] };
}

async function readSettings(db) {
  const exists = await tableExists(db, TABLES.settings);
  if (!exists) return {};

  const columns = await getColumns(db, TABLES.settings);
  if (!columns.includes("key") || !columns.includes("value")) return {};

  const result = await db.prepare(
    `SELECT ${quoteIdent("key")}, ${quoteIdent("value")} FROM ${quoteIdent(TABLES.settings)} LIMIT 300`
  ).all();

  const out = {};
  for (const row of result.results || []) out[String(row.key)] = row.value;
  return out;
}

function normalizeAccount(row) {
  const id = firstString(row, ["id"]);
  const name = firstString(row, ["name", "label", "account_name"], id || "Account");
  const kind = firstString(row, ["kind", "type", "category"], "unknown").toLowerCase();
  const balance = firstNumber(row, ["balance", "current_balance", "available_balance", "opening_balance"], 0);
  const status = firstString(row, ["status"], "active").toLowerCase();

  const hay = `${id} ${name} ${kind}`.toLowerCase();
  const isCreditCard = kind === "cc" || hay.includes("credit card") || hay.includes("alfalah cc");
  const isLiability = isCreditCard || kind.includes("liability") || kind.includes("debt");

  return {
    id,
    name,
    kind,
    balance,
    status,
    is_active: status !== "inactive" && status !== "closed" && status !== "deleted",
    is_credit_card: isCreditCard,
    is_liability: isLiability,
    is_asset: !isLiability,
    credit_limit: firstNumber(row, ["credit_limit"], 0) || null,
    min_payment_amount: firstNumber(row, ["min_payment_amount"], 0) || null,
    statement_day: firstNumber(row, ["statement_day"], 0) || null,
    payment_due_day: firstNumber(row, ["payment_due_day"], 0) || null,
    updated_at: first(row, ["updated_at", "created_at"], null)
  };
}

function normalizeBill(row, accounts) {
  const id = firstString(row, ["id"]);
  const dueDay = firstNumber(row, ["due_day"], 0);
  const dueDate = dateOnly(first(row, ["due_date", "next_due_date"], null)) || (dueDay ? dateOnly(nextMonthlyDate(dueDay)) : null);

  const paymentAccountId = firstString(row, [
    "payment_account_id",
    "default_account_id",
    "last_paid_account_id",
    "paid_from_account_id",
    "autopay_account_id",
    "account_id"
  ], "");

  const paymentAccount = paymentAccountId ? accounts.find(a => a.id === paymentAccountId) : null;
  const status = firstString(row, ["status"], "unknown").toLowerCase();

  return {
    id,
    name: firstString(row, ["name", "title", "label"], id || "Bill"),
    amount: firstNumber(row, ["amount"], 0),
    due_day: dueDay || null,
    due_date: dueDate,
    days_until_due: dueDate ? daysBetween(new Date(), dueDate) : null,
    status,
    cadence: firstString(row, ["frequency", "cadence"], "monthly"),
    category: firstString(row, ["category", "category_id"], ""),
    payment_account_id: paymentAccountId || null,
    payment_account_name: paymentAccount ? paymentAccount.name : null,
    payment_account_status: paymentAccountId ? "linked" : "missing",
    contract_ready: status === "deleted" || status === "closed" || Boolean(id && dueDate && paymentAccountId),
    blockers: [
      status !== "deleted" && status !== "closed" && !dueDate ? "missing_due_date" : null,
      status !== "deleted" && status !== "closed" && !paymentAccountId ? "missing_payment_account_id" : null
    ].filter(Boolean)
  };
}

function normalizeDebt(row) {
  const id = firstString(row, ["id"]);
  const original = firstNumber(row, ["original_amount", "amount"], 0);
  const paid = firstNumber(row, ["paid_amount"], 0);
  const remaining = firstNumber(row, ["remaining", "remaining_amount", "outstanding"], Math.max(0, original - paid));
  const status = firstString(row, ["status"], "active").toLowerCase();
  const dueDay = firstNumber(row, ["due_day"], 0);
  const dueDate =
    dateOnly(first(row, ["next_due_date", "installment_due_date", "due_date"], null)) ||
    (dueDay ? dateOnly(nextMonthlyDate(dueDay)) : null);

  const installment = firstNumber(row, ["installment_amount", "minimum_payment", "monthly_payment"], 0);
  const closed = status === "closed" || status === "deleted" || remaining <= 0;

  return {
    id,
    name: firstString(row, ["name", "title", "label"], id || "Debt"),
    kind: firstString(row, ["kind", "type"], "unknown"),
    original_amount: original,
    paid_amount: paid,
    remaining_amount: remaining,
    installment_amount: installment || null,
    due_day: dueDay || null,
    next_due_date: dueDate,
    days_until_due: dueDate ? daysBetween(new Date(), dueDate) : null,
    snowball_order: first(row, ["snowball_order"], null),
    status: closed ? "closed" : status,
    contract_ready: closed || Boolean(id && dueDate && remaining >= 0),
    blockers: closed ? [] : [
      !dueDate ? "missing_next_due_date" : null,
      remaining > 0 && installment <= 0 ? "missing_installment_amount" : null
    ].filter(Boolean)
  };
}

function normalizeCreditCard(accounts, settings) {
  const cc = accounts.find(a => a.is_credit_card) || null;

  const statementDay =
    firstNumber(cc, ["statement_day"], 0) ||
    n(settings.cc_statement_day, 12);

  const paymentDueDay =
    firstNumber(cc, ["payment_due_day"], 0) ||
    n(settings.cc_payment_due_day, 0);

  const interestFreeDays = n(settings.cc_interest_free_days, 55);

  const statementDate = nextMonthlyDate(statementDay || 12);

  let dueDate = null;
  if (paymentDueDay) {
    dueDate = nextMonthlyDate(paymentDueDay);
    if (dueDate < statementDate) dueDate = new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, dueDate.getDate());
  } else {
    dueDate = new Date(statementDate);
    dueDate.setDate(dueDate.getDate() + interestFreeDays);
  }

  const outstanding = cc ? Math.abs(n(cc.balance, 0)) : 0;
  const configuredMinimum =
    firstNumber(cc, ["min_payment_amount"], 0) ||
    n(settings.cc_min_payment_amount, 0) ||
    n(settings.cc_minimum_fixed, 0);

  const percent = n(settings.cc_minimum_percent, 0);
  const percentMinimum = percent > 0 ? Math.ceil(outstanding * percent) : 0;
  const minimumPayment = configuredMinimum || percentMinimum || (outstanding > 0 ? Math.ceil(outstanding * 0.05) : 0);

  return {
    account_id: cc ? cc.id : null,
    account_name: cc ? cc.name : null,
    outstanding,
    credit_limit: cc ? cc.credit_limit : null,
    statement_day: statementDay,
    payment_due_day: paymentDueDay || null,
    interest_free_days: interestFreeDays,
    next_statement_date: dateOnly(statementDate),
    next_due_date: dateOnly(dueDate),
    days_until_due: dueDate ? daysBetween(new Date(), dueDate) : null,
    minimum_payment: minimumPayment,
    minimum_payment_source: configuredMinimum ? "accounts.min_payment_amount" : percentMinimum ? "settings.cc_minimum_percent" : outstanding > 0 ? "fallback_5_percent" : "zero_outstanding",
    utilization_percent: cc && cc.credit_limit ? Math.round((outstanding / cc.credit_limit) * 10000) / 100 : null,
    naming_contract: "Credit Card",
    contract_ready: Boolean(cc && statementDay && dueDate && minimumPayment !== null),
    blockers: [
      !cc ? "missing_credit_card_account" : null,
      !statementDay ? "missing_statement_day" : null,
      minimumPayment === null || minimumPayment === undefined ? "missing_minimum_payment_formula" : null
    ].filter(Boolean)
  };
}

function normalizeSalary(rows, settings) {
  const latest = rows && rows.length ? rows[0] : null;

  const guaranteedBase =
    firstNumber(latest, ["guaranteed_base_salary", "baseline_forecast_pkr", "expected_net_salary", "last_net_salary", "net_salary", "base_salary", "basic_salary"], 0) ||
    n(settings.salary_guaranteed_monthly, 0);

  const wfhUsd = firstNumber(latest, ["wfh_usd_amount"], 0) || n(settings.salary_wfh_usd_amount, 30);
  const fxRate = firstNumber(latest, ["salary_day_fx_rate"], 0) || n(settings.salary_day_fx_rate, 0);
  const expectedWfhPkr = firstNumber(latest, ["expected_wfh_pkr"], 0) || (wfhUsd > 0 && fxRate > 0 ? Math.round(wfhUsd * fxRate) : 0);

  const confirmedVariable =
    firstNumber(latest, ["confirmed_variable_pkr", "confirmed_variable"], 0) ||
    n(settings.salary_confirmed_variable_pkr, 0);

  const speculativeVariable =
    firstNumber(latest, ["speculative_variable_pkr", "speculative_variable"], 0) ||
    n(settings.salary_speculative_variable_pkr, 0);

  const baselineForecast =
    firstNumber(latest, ["baseline_forecast_pkr"], 0) ||
    guaranteedBase + expectedWfhPkr;

  const nextSalaryDate =
    dateOnly(first(latest, ["next_salary_date"], null)) ||
    dateOnly(settings.salary_next_date) ||
    dateOnly(nextMonthlyDate(firstNumber(latest, ["salary_day"], n(settings.salary_day, 1))));

  return {
    source: latest ? "salary_table" : Object.keys(settings).some(k => k.startsWith("salary_")) ? "settings" : "unknown",
    employer_name: firstString(latest, ["employer_name"], ""),
    guaranteed_base_salary: guaranteedBase,
    wfh_usd_amount: wfhUsd,
    salary_day_fx_rate: fxRate || null,
    expected_wfh_pkr: expectedWfhPkr,
    baseline_forecast_pkr: baselineForecast,
    confirmed_variable_pkr: confirmedVariable,
    speculative_variable_pkr: speculativeVariable,
    projected_next_salary: baselineForecast + confirmedVariable,
    next_salary_date: nextSalaryDate,
    tax_paid_to_date: firstNumber(latest, ["income_tax_paid_ytd", "tax_paid_to_date", "tax_paid"], 0),
    regular_gross_salary: firstNumber(latest, ["regular_gross_salary", "last_gross_salary", "gross_salary"], 0) || null,
    last_net_salary: firstNumber(latest, ["last_net_salary", "expected_net_salary"], 0) || null,
    baseline_rule: "guaranteed_base_plus_wfh_plus_confirmed_variable_only",
    excludes_from_baseline: ["speculative_variable_pkr", "unconfirmed_mbo", "unconfirmed_overtime"],
    contract_ready: baselineForecast > 0 && Boolean(nextSalaryDate),
    blockers: [
      baselineForecast <= 0 ? "missing_baseline_forecast" : null,
      !nextSalaryDate ? "missing_next_salary_date" : null
    ].filter(Boolean)
  };
}

function normalizeTransactionSummary(rows) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  let income30 = 0;
  let expense30 = 0;
  let transferCount = 0;

  for (const tx of rows.slice(0, 500)) {
    const d = new Date(first(tx, ["date", "dt", "dt_local", "created_at"], null));
    if (Number.isNaN(d.getTime()) || d < cutoff) continue;

    const amount = firstNumber(tx, ["amount"], 0);
    const type = firstString(tx, ["type", "kind", "category"], "").toLowerCase();

    if (type.includes("income") || type === "salary" || amount > 0) income30 += Math.abs(amount);
    if (type.includes("expense") || type.includes("spend") || amount < 0) expense30 += Math.abs(amount);
    if (type.includes("transfer") || first(tx, ["transfer_to_account_id", "from_account_id", "to_account_id"], null)) transferCount += 1;
  }

  return {
    rows_scanned: rows.slice(0, 500).length,
    income_30d: income30,
    expense_30d: expense30,
    daily_burn_30d: expense30 > 0 ? expense30 / 30 : 0,
    transfer_rows_30d: transferCount,
    transfer_contract: {
      required_url_params: ["type=transfer", "to=<account_key_or_id>"],
      required_payload_fields: ["type", "amount", "from_account_id", "to_account_id", "date"],
      ready_for_add_page: true
    }
  };
}

function buildReadiness({ accounts, bills, debts, salary, creditCard, transactionSummary, tableHealth }) {
  const failures = [];
  const warnings = [];

  if (!tableHealth.accounts.exists) failures.push("accounts_table_missing");
  if (!tableHealth.transactions.exists) failures.push("transactions_table_missing");
  if (!accounts.length) failures.push("no_accounts_found");

  const activeBills = bills.filter(b => b.status !== "deleted" && b.status !== "closed");
  const billsMissingPaymentAccount = activeBills.filter(b => b.payment_account_status === "missing").length;
  const billsMissingDue = activeBills.filter(b => b.blockers.includes("missing_due_date")).length;

  if (billsMissingPaymentAccount) warnings.push(`${billsMissingPaymentAccount}_active_bill_rows_missing_payment_account`);
  if (billsMissingDue) warnings.push(`${billsMissingDue}_active_bill_rows_missing_due_date`);

  const activeDebts = debts.filter(d => d.status !== "closed");
  const debtsMissingDue = activeDebts.filter(d => d.blockers.includes("missing_next_due_date")).length;
  if (debtsMissingDue) warnings.push(`${debtsMissingDue}_active_debt_rows_missing_due_date`);

  if (!salary.contract_ready) warnings.push(...salary.blockers);
  if (!creditCard.contract_ready) warnings.push(...creditCard.blockers);
  if (!transactionSummary.transfer_contract.ready_for_add_page) failures.push("add_transfer_contract_not_ready");

  return {
    backend_score: Math.max(0, 100 - failures.length * 20 - warnings.length * 5),
    readiness: failures.length ? "FAIL" : warnings.length ? "READY_WITH_WARNINGS" : "PASS",
    failures,
    warnings
  };
}

export async function onRequest(context) {
  const startedAt = new Date().toISOString();
  const db = getDb(context.env || {});

  if (!db) return fail("D1 binding not found. Expected env.DB, env.SOVEREIGN_DB, or env.FINANCE_DB.", 500);

  try {
    const settings = await readSettings(db);

    const [accountData, transactionData, billData, debtData, salaryData, reconciliationData, auditData] = await Promise.all([
      readRows(db, TABLES.accounts, 500),
      readRows(db, TABLES.transactions, 700),
      readRows(db, TABLES.bills, 500),
      readRows(db, TABLES.debts, 500),
      readRows(db, TABLES.salary, 80),
      readRows(db, TABLES.reconciliation, 200),
      readRows(db, TABLES.audit_log, 20)
    ]);

    const accounts = accountData.rows.map(normalizeAccount);
    const bills = billData.rows.map(row => normalizeBill(row, accounts));
    const debts = debtData.rows.map(normalizeDebt);
    const salary = normalizeSalary(salaryData.rows, settings);
    const creditCard = normalizeCreditCard(accounts, settings);
    const transactionSummary = normalizeTransactionSummary(transactionData.rows);

    const liquidBalance = accounts
      .filter(a => a.is_asset && a.is_active)
      .reduce((sum, a) => sum + n(a.balance, 0), 0);

    const liabilityBalance = accounts
      .filter(a => a.is_liability && a.is_active)
      .reduce((sum, a) => sum + Math.abs(n(a.balance, 0)), 0);

    const dueSoon14 = bills
      .filter(b => b.status !== "deleted" && b.days_until_due !== null && b.days_until_due >= 0 && b.days_until_due <= 14)
      .reduce((sum, b) => sum + n(b.amount, 0), 0);

    const debtDueSoon14 = debts
      .filter(d => d.status !== "closed" && d.days_until_due !== null && d.days_until_due >= 0 && d.days_until_due <= 14)
      .reduce((sum, d) => sum + n(d.installment_amount, 0), 0);

    const tableHealth = {
      accounts: { exists: accountData.exists, columns: accountData.columns },
      transactions: { exists: transactionData.exists, columns: transactionData.columns },
      bills: { exists: billData.exists, columns: billData.columns },
      debts: { exists: debtData.exists, columns: debtData.columns },
      salary: { exists: salaryData.exists, columns: salaryData.columns },
      reconciliation: { exists: reconciliationData.exists, columns: reconciliationData.columns },
      audit_log: { exists: auditData.exists, columns: auditData.columns }
    };

    const readiness = buildReadiness({ accounts, bills, debts, salary, creditCard, transactionSummary, tableHealth });

    return json({
      ok: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      mode: "read_only_backend_contract",
      readiness,
      contracts: {
        accounts: {
          count: accounts.length,
          liquid_balance: liquidBalance,
          liability_balance: liabilityBalance,
          payment_account_options: accounts
            .filter(a => a.is_asset && a.is_active)
            .map(a => ({ id: a.id, name: a.name, balance: a.balance, kind: a.kind })),
          rows: accounts
        },
        bills: {
          count: bills.length,
          due_soon_14d: dueSoon14,
          requires_payment_account_selector: true,
          required_fields: ["id", "name", "amount", "due_date", "payment_account_id"],
          missing_payment_account_count: bills.filter(b => b.status !== "deleted" && b.payment_account_status === "missing").length,
          missing_due_date_count: bills.filter(b => b.status !== "deleted" && b.blockers.includes("missing_due_date")).length,
          rows: bills
        },
        debts: {
          count: debts.length,
          installment_due_soon_14d: debtDueSoon14,
          required_fields: ["id", "name", "remaining_amount", "next_due_date", "installment_amount"],
          missing_due_date_count: debts.filter(d => d.status !== "closed" && d.blockers.includes("missing_next_due_date")).length,
          rows: debts
        },
        credit_card: creditCard,
        salary,
        transactions: transactionSummary,
        forecast_inputs: {
          liquid_balance: liquidBalance,
          liability_balance: liabilityBalance,
          daily_burn_30d: transactionSummary.daily_burn_30d,
          due_soon_14d: dueSoon14 + debtDueSoon14,
          next_salary_date: salary.next_salary_date,
          next_salary_amount: salary.projected_next_salary,
          credit_card_due_date: creditCard.next_due_date,
          credit_card_minimum_payment: creditCard.minimum_payment
        },
        add_transaction: {
          route_contracts: [
            {
              route: "/add.html?type=transfer&to=cc",
              expected_type: "transfer",
              expected_target: "credit_card",
              required_payload_fields: ["type", "amount", "from_account_id", "to_account_id", "date"]
            }
          ]
        }
      },
      table_health: tableHealth,
      production_notes: {
        backend_100_definition: [
          "No missing core tables",
          "Bills expose payment account contract",
          "Debts expose due date and installment contract",
          "Credit Card exposes statement day, due date, and minimum payment contract",
          "Salary separates guaranteed, confirmed variable, and speculative variable",
          "Forecast inputs are returned from one backend source"
        ],
        no_mutation_performed: true,
        next_layer: "Forecast cockpit final"
      }
    });
  } catch (error) {
    return fail("money-contracts endpoint failed", 500, {
      details: error && error.message ? error.message : String(error)
    });
  }
}
