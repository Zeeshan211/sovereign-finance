/* Sovereign Finance money-contracts API v0.1.0
   Shipment 1: Backend money contracts

   Endpoint:
   GET /api/money-contracts

   Contract:
   - Read-only.
   - No ledger mutation.
   - No audit_log writes.
   - No schema migration.
   - Safely inspects existing D1 tables/columns.
   - Normalizes backend contract fields required by Finance v1 UI pages.
*/

const VERSION = "0.1.0";

const TABLES = {
  accounts: "accounts",
  transactions: "transactions",
  bills: "bills",
  debts: "debts",
  salary: "salary",
  settings: "settings",
  credit_cards: "credit_cards",
  reconciliation: "reconciliation",
  audit_log: "audit_log"
};

const CONTRACT_FIELDS = {
  account: [
    "id",
    "name",
    "label",
    "account_name",
    "kind",
    "type",
    "category",
    "balance",
    "current_balance",
    "available_balance",
    "status",
    "is_active",
    "updated_at",
    "created_at"
  ],
  transaction: [
    "id",
    "date",
    "dt",
    "dt_local",
    "created_at",
    "amount",
    "type",
    "kind",
    "category",
    "account_id",
    "from_account_id",
    "to_account_id",
    "linked_txn_id",
    "reversed_by",
    "reversed_at",
    "notes"
  ],
  bill: [
    "id",
    "name",
    "title",
    "label",
    "amount",
    "due_date",
    "next_due_date",
    "paid_date",
    "status",
    "cadence",
    "frequency",
    "category",
    "account_id",
    "payment_account_id",
    "paid_from_account_id",
    "autopay_account_id",
    "notes",
    "updated_at",
    "created_at"
  ],
  debt: [
    "id",
    "name",
    "title",
    "label",
    "kind",
    "type",
    "original_amount",
    "amount",
    "paid_amount",
    "remaining",
    "remaining_amount",
    "outstanding",
    "minimum_payment",
    "monthly_payment",
    "installment_amount",
    "due_date",
    "next_due_date",
    "installment_due_date",
    "snowball_order",
    "status",
    "notes",
    "updated_at",
    "created_at"
  ],
  salary: [
    "id",
    "month",
    "salary_month",
    "basic",
    "basic_salary",
    "net_salary",
    "gross_salary",
    "monthly_salary",
    "guaranteed_monthly",
    "wfh_allowance",
    "tax_paid",
    "tax_paid_to_date",
    "mbo",
    "overtime",
    "variable_pay",
    "confirmed_variable",
    "speculative_variable",
    "next_salary_date",
    "status",
    "updated_at",
    "created_at"
  ],
  creditCard: [
    "id",
    "account_id",
    "name",
    "label",
    "statement_day",
    "billing_day",
    "interest_free_days",
    "due_day",
    "minimum_payment",
    "minimum_due",
    "minimum_percent",
    "outstanding",
    "balance",
    "limit_amount",
    "credit_limit",
    "status",
    "updated_at",
    "created_at"
  ],
  reconciliation: [
    "id",
    "account_id",
    "declared_balance",
    "real_balance",
    "system_balance",
    "delta",
    "status",
    "reconciled_at",
    "updated_at",
    "created_at"
  ]
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
  return json({
    ok: false,
    version: VERSION,
    error: message,
    ...extra
  }, status);
}

function getDb(env) {
  return env.DB || env.SOVEREIGN_DB || env.FINANCE_DB || null;
}

function nowIso() {
  return new Date().toISOString();
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function firstValue(row, keys, fallback = null) {
  if (!row) return fallback;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }
  return fallback;
}

function firstNumber(row, keys, fallback = 0) {
  return toNumber(firstValue(row, keys, fallback), fallback);
}

function firstString(row, keys, fallback = "") {
  return cleanString(firstValue(row, keys, fallback), fallback);
}

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.ceil((b.getTime() - a.getTime()) / 86400000);
}

function addDays(date, days) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function nextMonthlyDate(day) {
  const today = new Date();
  const safeDay = Math.max(1, Math.min(28, Number(day || 1)));
  let d = new Date(today.getFullYear(), today.getMonth(), safeDay);
  if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, safeDay);
  return d;
}

async function tableExists(db, table) {
  const row = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).bind(table).first();

  return !!row;
}

async function getColumns(db, table) {
  if (!(await tableExists(db, table))) return [];

  const result = await db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  return (result.results || []).map(col => col.name);
}

function existingFields(columns, desired) {
  const set = new Set(columns);
  return desired.filter(field => set.has(field));
}

async function readRows(db, table, desiredFields, options = {}) {
  const exists = await tableExists(db, table);
  if (!exists) {
    return {
      exists: false,
      columns: [],
      rows: []
    };
  }

  const columns = await getColumns(db, table);
  const fields = existingFields(columns, desiredFields);
  const selectFields = fields.length ? fields.map(quoteIdent).join(", ") : "*";
  const limit = Math.max(1, Math.min(Number(options.limit || 500), 1000));

  let order = "";
  const orderCandidates = ["updated_at", "created_at", "date", "dt_local", "dt", "due_date", "id"];
  const orderCol = orderCandidates.find(col => columns.includes(col));
  if (orderCol) order = ` ORDER BY ${quoteIdent(orderCol)} DESC`;

  const result = await db.prepare(
    `SELECT ${selectFields} FROM ${quoteIdent(table)}${order} LIMIT ?`
  ).bind(limit).all();

  return {
    exists: true,
    columns,
    rows: result.results || []
  };
}

async function readSettings(db) {
  const exists = await tableExists(db, TABLES.settings);
  if (!exists) return {};

  const columns = await getColumns(db, TABLES.settings);
  const hasKey = columns.includes("key");
  const hasValue = columns.includes("value");

  if (!hasKey || !hasValue) return {};

  const result = await db.prepare(
    `SELECT ${quoteIdent("key")}, ${quoteIdent("value")} FROM ${quoteIdent(TABLES.settings)} LIMIT 300`
  ).all();

  const settings = {};
  for (const row of result.results || []) {
    settings[String(row.key)] = row.value;
  }

  return settings;
}

function normalizeAccount(row) {
  const id = firstString(row, ["id"]);
  const name = firstString(row, ["name", "label", "account_name"], id || "Account");
  const kind = firstString(row, ["kind", "type", "category"], "unknown").toLowerCase();
  const balance = firstNumber(row, ["balance", "current_balance", "available_balance"], 0);
  const status = firstString(row, ["status"], "active").toLowerCase();
  const isActiveRaw = firstValue(row, ["is_active"], null);

  const isLiability =
    kind.includes("liability") ||
    kind.includes("credit") ||
    kind.includes("debt") ||
    name.toLowerCase().includes("credit card");

  return {
    id,
    name,
    kind,
    balance,
    status,
    is_active: isActiveRaw === null ? status !== "inactive" && status !== "closed" : Boolean(isActiveRaw),
    is_liability: isLiability,
    is_asset: !isLiability,
    updated_at: firstValue(row, ["updated_at", "created_at"], null)
  };
}

function normalizeBill(row, accounts) {
  const id = firstString(row, ["id"]);
  const name = firstString(row, ["name", "title", "label"], id || "Bill");
  const amount = firstNumber(row, ["amount"], 0);
  const dueDate = dateOnly(firstValue(row, ["due_date", "next_due_date"], null));
  const paymentAccountId = firstString(row, [
    "payment_account_id",
    "paid_from_account_id",
    "autopay_account_id",
    "account_id"
  ], "");

  const paymentAccount = paymentAccountId
    ? accounts.find(account => account.id === paymentAccountId) || null
    : null;

  return {
    id,
    name,
    amount,
    due_date: dueDate,
    days_until_due: dueDate ? daysBetween(new Date(), dueDate) : null,
    status: firstString(row, ["status"], "unknown").toLowerCase(),
    cadence: firstString(row, ["cadence", "frequency"], "unknown"),
    category: firstString(row, ["category"], ""),
    payment_account_id: paymentAccountId || null,
    payment_account_name: paymentAccount ? paymentAccount.name : null,
    payment_account_status: paymentAccountId ? "linked" : "missing",
    contract_ready: Boolean(id && name && amount >= 0 && dueDate && paymentAccountId),
    blockers: [
      !dueDate ? "missing_due_date" : null,
      !paymentAccountId ? "missing_payment_account_id" : null
    ].filter(Boolean)
  };
}

function normalizeDebt(row) {
  const id = firstString(row, ["id"]);
  const name = firstString(row, ["name", "title", "label"], id || "Debt");
  const original = firstNumber(row, ["original_amount", "amount"], 0);
  const paid = firstNumber(row, ["paid_amount"], 0);
  const remaining = firstNumber(row, ["remaining", "remaining_amount", "outstanding"], Math.max(0, original - paid));
  const dueDate = dateOnly(firstValue(row, ["next_due_date", "installment_due_date", "due_date"], null));
  const installmentAmount = firstNumber(row, ["minimum_payment", "monthly_payment", "installment_amount"], 0);

  return {
    id,
    name,
    kind: firstString(row, ["kind", "type"], "unknown"),
    original_amount: original,
    paid_amount: paid,
    remaining_amount: remaining,
    installment_amount: installmentAmount || null,
    next_due_date: dueDate,
    days_until_due: dueDate ? daysBetween(new Date(), dueDate) : null,
    snowball_order: firstValue(row, ["snowball_order"], null),
    status: firstString(row, ["status"], "active").toLowerCase(),
    contract_ready: Boolean(id && name && dueDate && remaining >= 0),
    blockers: [
      !dueDate ? "missing_next_due_date" : null,
      remaining > 0 && installmentAmount <= 0 ? "missing_installment_amount" : null
    ].filter(Boolean)
  };
}

function normalizeSalary(rows, settings) {
  const latest = rows && rows.length ? rows[0] : null;

  const guaranteedMonthly =
    firstNumber(latest, ["guaranteed_monthly", "monthly_salary", "net_salary", "basic_salary", "basic"], 0) ||
    toNumber(settings.salary_guaranteed_monthly, 0);

  const wfhAllowance =
    firstNumber(latest, ["wfh_allowance"], 0) ||
    toNumber(settings.salary_wfh_allowance, 0);

  const confirmedVariable =
    firstNumber(latest, ["confirmed_variable", "mbo", "overtime", "variable_pay"], 0) ||
    toNumber(settings.salary_confirmed_variable, 0);

  const speculativeVariable =
    firstNumber(latest, ["speculative_variable"], 0) ||
    toNumber(settings.salary_speculative_variable, 0);

  const nextSalaryDate =
    dateOnly(firstValue(latest, ["next_salary_date"], null)) ||
    dateOnly(settings.salary_next_date) ||
    dateOnly(nextMonthlyDate(toNumber(settings.salary_day, 1)));

  return {
    source: latest ? "salary_table" : Object.keys(settings).some(k => k.startsWith("salary_")) ? "settings" : "unknown",
    guaranteed_monthly: guaranteedMonthly,
    wfh_allowance: wfhAllowance,
    confirmed_variable: confirmedVariable,
    speculative_variable: speculativeVariable,
    projected_next_salary: guaranteedMonthly + wfhAllowance + confirmedVariable,
    next_salary_date: nextSalaryDate,
    tax_paid_to_date: firstNumber(latest, ["tax_paid_to_date", "tax_paid"], toNumber(settings.salary_tax_paid_to_date, 0)),
    baseline_rule: "guaranteed_plus_confirmed_only",
    excludes_from_baseline: ["speculative_variable", "unconfirmed_mbo", "unconfirmed_overtime"],
    contract_ready: guaranteedMonthly > 0 && Boolean(nextSalaryDate),
    blockers: [
      guaranteedMonthly <= 0 ? "missing_guaranteed_monthly_salary" : null,
      !nextSalaryDate ? "missing_next_salary_date" : null
    ].filter(Boolean)
  };
}

function normalizeCreditCard(accounts, creditRows, settings) {
  const explicit = creditRows && creditRows.length ? creditRows[0] : null;

  const ccAccounts = accounts.filter(account => {
    const hay = `${account.name} ${account.kind}`.toLowerCase();
    return hay.includes("credit") || hay.includes("cc");
  });

  const primaryAccount = explicit
    ? accounts.find(account => account.id === firstString(explicit, ["account_id"], "")) || ccAccounts[0] || null
    : ccAccounts[0] || null;

  const outstandingFromRow = firstNumber(explicit, ["outstanding", "balance"], 0);
  const outstandingFromAccount = primaryAccount ? Math.abs(Math.min(0, primaryAccount.balance)) || Math.abs(primaryAccount.balance) : 0;
  const outstanding = outstandingFromRow || outstandingFromAccount;

  const statementDay =
    firstNumber(explicit, ["statement_day", "billing_day"], 0) ||
    toNumber(settings.cc_statement_day, 12);

  const interestFreeDays =
    firstNumber(explicit, ["interest_free_days"], 0) ||
    toNumber(settings.cc_interest_free_days, 55);

  const statementDate = nextMonthlyDate(statementDay);
  const dueDate = addDays(statementDate, interestFreeDays);

  const minimumPercent =
    firstNumber(explicit, ["minimum_percent"], 0) ||
    toNumber(settings.cc_minimum_percent, 0);

  const fixedMinimum =
    firstNumber(explicit, ["minimum_payment", "minimum_due"], 0) ||
    toNumber(settings.cc_minimum_fixed, 0);

  const computedMinimum =
    fixedMinimum > 0
      ? fixedMinimum
      : minimumPercent > 0
        ? Math.ceil(outstanding * minimumPercent)
        : null;

  return {
    account_id: primaryAccount ? primaryAccount.id : null,
    account_name: primaryAccount ? primaryAccount.name : null,
    outstanding,
    credit_limit: firstNumber(explicit, ["limit_amount", "credit_limit"], toNumber(settings.cc_credit_limit, 0)) || null,
    statement_day: statementDay,
    interest_free_days: interestFreeDays,
    next_statement_date: dateOnly(statementDate),
    next_due_date: dateOnly(dueDate),
    days_until_due: dueDate ? daysBetween(new Date(), dueDate) : null,
    minimum_payment: computedMinimum,
    minimum_payment_source: fixedMinimum > 0 ? "fixed_configured" : minimumPercent > 0 ? "percent_configured" : "unknown",
    naming_contract: "Credit Card",
    contract_ready: Boolean(primaryAccount && statementDay && interestFreeDays && computedMinimum !== null),
    blockers: [
      !primaryAccount ? "missing_credit_card_account" : null,
      !computedMinimum ? "missing_minimum_payment_formula" : null
    ].filter(Boolean)
  };
}

function normalizeTransactionSummary(rows) {
  const recent = rows.slice(0, 200);
  let income30 = 0;
  let expense30 = 0;
  let transferCount = 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  for (const tx of recent) {
    const date = new Date(firstValue(tx, ["date", "dt", "dt_local", "created_at"], null));
    const amount = firstNumber(tx, ["amount"], 0);
    const type = firstString(tx, ["type", "kind", "category"], "").toLowerCase();

    if (!Number.isNaN(date.getTime()) && date >= cutoff) {
      if (type.includes("income") || amount > 0) income30 += Math.abs(amount);
      if (type.includes("expense") || amount < 0) expense30 += Math.abs(amount);
      if (type.includes("transfer") || firstValue(tx, ["from_account_id"], null) || firstValue(tx, ["to_account_id"], null)) transferCount += 1;
    }
  }

  return {
    rows_scanned: recent.length,
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

  const billsMissingPaymentAccount = bills.filter(b => b.payment_account_status === "missing").length;
  if (billsMissingPaymentAccount) warnings.push(`${billsMissingPaymentAccount}_bill_rows_missing_payment_account`);

  const debtsMissingDue = debts.filter(d => d.blockers.includes("missing_next_due_date")).length;
  if (debtsMissingDue) warnings.push(`${debtsMissingDue}_debt_rows_missing_due_date`);

  if (!salary.contract_ready) warnings.push(...salary.blockers);
  if (!creditCard.contract_ready) warnings.push(...creditCard.blockers);
  if (!transactionSummary.transfer_contract.ready_for_add_page) failures.push("add_transfer_contract_not_ready");

  const scoreBase = 100;
  const score =
    Math.max(0, scoreBase - failures.length * 20 - warnings.length * 5);

  return {
    backend_score: score,
    readiness: failures.length ? "FAIL" : warnings.length ? "READY_WITH_WARNINGS" : "PASS",
    failures,
    warnings
  };
}

export async function onRequest(context) {
  const startedAt = nowIso();
  const db = getDb(context.env || {});

  if (!db) {
    return fail("D1 binding not found. Expected env.DB, env.SOVEREIGN_DB, or env.FINANCE_DB.", 500);
  }

  try {
    const settings = await readSettings(db);

    const [
      accountData,
      transactionData,
      billData,
      debtData,
      salaryData,
      creditCardData,
      reconciliationData
    ] = await Promise.all([
      readRows(db, TABLES.accounts, CONTRACT_FIELDS.account, { limit: 500 }),
      readRows(db, TABLES.transactions, CONTRACT_FIELDS.transaction, { limit: 700 }),
      readRows(db, TABLES.bills, CONTRACT_FIELDS.bill, { limit: 500 }),
      readRows(db, TABLES.debts, CONTRACT_FIELDS.debt, { limit: 500 }),
      readRows(db, TABLES.salary, CONTRACT_FIELDS.salary, { limit: 60 }),
      readRows(db, TABLES.credit_cards, CONTRACT_FIELDS.creditCard, { limit: 20 }),
      readRows(db, TABLES.reconciliation, CONTRACT_FIELDS.reconciliation, { limit: 200 })
    ]);

    const accounts = accountData.rows.map(normalizeAccount);
    const bills = billData.rows.map(row => normalizeBill(row, accounts));
    const debts = debtData.rows.map(normalizeDebt);
    const salary = normalizeSalary(salaryData.rows, settings);
    const creditCard = normalizeCreditCard(accounts, creditCardData.rows, settings);
    const transactionSummary = normalizeTransactionSummary(transactionData.rows);

    const liquidBalance = accounts
      .filter(account => account.is_asset && account.is_active)
      .reduce((sum, account) => sum + account.balance, 0);

    const liabilityBalance = accounts
      .filter(account => account.is_liability && account.is_active)
      .reduce((sum, account) => sum + Math.abs(account.balance), 0);

    const dueSoon14 = bills
      .filter(bill => bill.days_until_due !== null && bill.days_until_due >= 0 && bill.days_until_due <= 14)
      .reduce((sum, bill) => sum + bill.amount, 0);

    const debtDueSoon14 = debts
      .filter(debt => debt.days_until_due !== null && debt.days_until_due >= 0 && debt.days_until_due <= 14)
      .reduce((sum, debt) => sum + (debt.installment_amount || 0), 0);

    const tableHealth = {
      accounts: { exists: accountData.exists, columns: accountData.columns },
      transactions: { exists: transactionData.exists, columns: transactionData.columns },
      bills: { exists: billData.exists, columns: billData.columns },
      debts: { exists: debtData.exists, columns: debtData.columns },
      salary: { exists: salaryData.exists, columns: salaryData.columns },
      credit_cards: { exists: creditCardData.exists, columns: creditCardData.columns },
      reconciliation: { exists: reconciliationData.exists, columns: reconciliationData.columns }
    };

    const readiness = buildReadiness({
      accounts,
      bills,
      debts,
      salary,
      creditCard,
      transactionSummary,
      tableHealth
    });

    return json({
      ok: true,
      version: VERSION,
      generated_at: nowIso(),
      started_at: startedAt,
      mode: "read_only_backend_contract",

      readiness,

      contracts: {
        accounts: {
          count: accounts.length,
          liquid_balance: liquidBalance,
          liability_balance: liabilityBalance,
          payment_account_options: accounts
            .filter(account => account.is_asset && account.is_active)
            .map(account => ({
              id: account.id,
              name: account.name,
              balance: account.balance,
              kind: account.kind
            })),
          rows: accounts
        },

        bills: {
          count: bills.length,
          due_soon_14d: dueSoon14,
          requires_payment_account_selector: true,
          required_fields: ["id", "name", "amount", "due_date", "payment_account_id"],
          missing_payment_account_count: bills.filter(bill => bill.payment_account_status === "missing").length,
          rows: bills
        },

        debts: {
          count: debts.length,
          installment_due_soon_14d: debtDueSoon14,
          required_fields: ["id", "name", "remaining_amount", "next_due_date", "installment_amount"],
          missing_due_date_count: debts.filter(debt => debt.blockers.includes("missing_next_due_date")).length,
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
            },
            {
              route: "/add.html?type=expense",
              expected_type: "expense",
              required_payload_fields: ["type", "amount", "account_id", "date", "category"]
            },
            {
              route: "/add.html?type=income",
              expected_type: "income",
              required_payload_fields: ["type", "amount", "account_id", "date", "category"]
            }
          ]
        }
      },

      table_health: tableHealth,

      production_notes: {
        backend_100_definition: [
          "No missing core tables",
          "No missing account base",
          "Bills expose payment account contract",
          "Debts expose due date and installment contract",
          "Credit Card exposes statement day, due date, and minimum payment contract",
          "Salary separates guaranteed, confirmed variable, and speculative variable",
          "Forecast inputs are returned from one backend source"
        ],
        no_mutation_performed: true,
        next_layer: "Add + Transactions closeout"
      }
    });
  } catch (error) {
    return fail("money-contracts endpoint failed", 500, {
      details: error && error.message ? error.message : String(error)
    });
  }
}
