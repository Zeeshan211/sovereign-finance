// functions/api/finance-command-center.js
// v0.1.0 — Finance Command Centre backend read-only audit endpoint
//
// Contract:
// - Read-only only.
// - No D1 INSERT / UPDATE / DELETE / ALTER.
// - No ledger tests.
// - No transaction creation.
// - No backend finance logic rewrite.
// - No /api/money-contracts.
// - Unknown stays Unknown.
// - Suspicious source becomes blocked.

const VERSION = '0.1.0';

const REQUIRED_CORE_TABLES = [
  'accounts',
  'transactions',
  'bills',
  'debts',
  'categories',
  'reconciliation'
];

const OPTIONAL_TABLES = [
  'audit_log',
  'salary',
  'settings'
];

const FINANCE_REGISTRY = [
  {
    key: 'hub',
    label: 'Hub',
    pages: ['index.html'],
    apis: ['/api/balances?debug=1'],
    d1_tables: ['accounts', 'transactions', 'debts', 'bills'],
    depends_on: ['accounts', 'debts', 'bills'],
    impacts: ['whole cockpit']
  },
  {
    key: 'add',
    label: 'Add Transaction',
    pages: ['add.html'],
    apis: ['/api/accounts', '/api/categories', '/api/transactions'],
    d1_tables: ['accounts', 'transactions', 'categories'],
    depends_on: ['store', 'accounts', 'categories'],
    impacts: ['balances', 'transactions']
  },
  {
    key: 'transactions',
    label: 'Transactions',
    pages: ['transactions.html'],
    apis: ['/api/transactions'],
    d1_tables: ['transactions'],
    depends_on: ['accounts'],
    impacts: ['balances', 'forecast']
  },
  {
    key: 'accounts',
    label: 'Accounts',
    pages: ['accounts.html'],
    apis: ['/api/accounts'],
    d1_tables: ['accounts'],
    depends_on: ['transactions'],
    impacts: ['balances', 'reconciliation']
  },
  {
    key: 'credit_card',
    label: 'Credit Card',
    pages: ['cc.html'],
    apis: ['/api/accounts', '/api/balances?debug=1'],
    d1_tables: ['accounts', 'transactions'],
    depends_on: ['cc account', 'balances'],
    impacts: ['hub', 'forecast']
  },
  {
    key: 'bills',
    label: 'Bills',
    pages: ['bills.html'],
    apis: ['/api/bills'],
    d1_tables: ['bills'],
    depends_on: ['accounts'],
    impacts: ['forecast']
  },
  {
    key: 'debts',
    label: 'Debts',
    pages: ['debts.html'],
    apis: ['/api/debts'],
    d1_tables: ['debts'],
    depends_on: ['accounts'],
    impacts: ['forecast']
  },
  {
    key: 'salary',
    label: 'Salary',
    pages: ['salary.html'],
    apis: ['/api/salary'],
    d1_tables: ['salary', 'settings'],
    depends_on: ['salary config'],
    impacts: ['forecast']
  },
  {
    key: 'forecast',
    label: 'Forecast',
    pages: ['forecast.html'],
    apis: ['/api/forecast'],
    d1_tables: ['accounts', 'transactions', 'bills', 'debts'],
    depends_on: ['balances', 'bills', 'debts', 'salary'],
    impacts: ['command centre']
  },
  {
    key: 'reconciliation',
    label: 'Reconciliation',
    pages: ['reconciliation.html'],
    apis: ['/api/reconciliation'],
    d1_tables: ['reconciliation', 'accounts'],
    depends_on: ['accounts', 'transactions'],
    impacts: ['command centre']
  },
  {
    key: 'command_centre',
    label: 'Command Centre',
    pages: ['monthly-close.html'],
    apis: ['/api/finance-command-center'],
    d1_tables: ['all known finance tables'],
    depends_on: ['all known finance modules'],
    impacts: ['trial decision']
  }
];

const API_REGISTRY = [
  { key: 'balances', path: '/api/balances?debug=1', required: true },
  { key: 'accounts', path: '/api/accounts', required: true },
  { key: 'transactions', path: '/api/transactions', required: true },
  { key: 'bills', path: '/api/bills', required: true },
  { key: 'debts', path: '/api/debts', required: true },
  { key: 'categories', path: '/api/categories', required: true },
  { key: 'reconciliation', path: '/api/reconciliation', required: false },
  { key: 'salary', path: '/api/salary', required: false },
  { key: 'forecast', path: '/api/forecast', required: false }
];

export async function onRequest(context) {
  const startedAt = new Date().toISOString();

  if (!['GET', 'HEAD'].includes(context.request.method)) {
    return send({
      ok: false,
      version: VERSION,
      computed_at: startedAt,
      verdict: 'blocked',
      error: 'Method not allowed. Finance Command Centre audit is read-only GET only.'
    }, 405);
  }

  try {
    const db = context.env.DB;
    if (!db) {
      return send(buildFailure(startedAt, 'missing_db_binding', 'D1 binding env.DB is unavailable.'), 500);
    }

    const hardBlockers = [];
    const warnings = [];
    const unknowns = [];
    const modules = buildModules();
    const pages = buildPages();
    const apis = await auditApis(context, warnings, unknowns, hardBlockers);
    const d1 = await auditD1(db, warnings, unknowns, hardBlockers);
    const businessRules = await auditBusinessRules(db, apis, d1, warnings, unknowns, hardBlockers);
    const scores = computeScores({ apis, d1, businessRules, unknowns, warnings, hardBlockers });
    const score = averageScore(scores);
    const verdict = computeVerdict(hardBlockers, warnings, unknowns);
    const nextActions = buildNextActions(hardBlockers, warnings, unknowns, businessRules, d1);

    return send({
      ok: hardBlockers.length === 0,
      version: VERSION,
      computed_at: startedAt,
      verdict,
      score,
      scores,
      hard_blockers: hardBlockers,
      warnings,
      unknowns,
      modules,
      pages,
      apis,
      d1,
      business_rules: businessRules,
      next_actions: nextActions
    });
  } catch (err) {
    return send({
      ok: false,
      version: VERSION,
      computed_at: startedAt,
      verdict: 'blocked',
      score: 0,
      scores: {
        frontend_registry: 0,
        api_health: 0,
        d1_truth: 0,
        business_rules: 0,
        write_safety: 0,
        runtime: 0
      },
      hard_blockers: [
        blocker('endpoint_exception', err.message || String(err), 'Fix endpoint exception before using Command Centre as a trial gate.')
      ],
      warnings: [],
      unknowns: [],
      modules: buildModules(),
      pages: buildPages(),
      apis: [],
      d1: {},
      business_rules: [],
      next_actions: ['Fix /api/finance-command-center exception and redeploy.']
    }, 500);
  }
}

function buildFailure(computedAt, key, message) {
  return {
    ok: false,
    version: VERSION,
    computed_at: computedAt,
    verdict: 'blocked',
    score: 0,
    scores: {
      frontend_registry: 0,
      api_health: 0,
      d1_truth: 0,
      business_rules: 0,
      write_safety: 0,
      runtime: 0
    },
    hard_blockers: [
      blocker(key, message, 'Restore the required backend binding before running Command Centre audit.')
    ],
    warnings: [],
    unknowns: [],
    modules: buildModules(),
    pages: buildPages(),
    apis: [],
    d1: {},
    business_rules: [],
    next_actions: ['Restore env.DB binding.']
  };
}

function buildModules() {
  return FINANCE_REGISTRY.map(module => ({
    key: module.key,
    label: module.label,
    status: 'registered',
    pages: module.pages,
    apis: module.apis,
    d1_tables: module.d1_tables,
    depends_on: module.depends_on,
    impacts: module.impacts
  }));
}

function buildPages() {
  return FINANCE_REGISTRY.flatMap(module =>
    module.pages.map(page => ({
      page,
      module: module.key,
      status: 'registered',
      runtime_status: 'unknown',
      note: 'Backend cannot prove browser runtime. Manual browser check remains required.'
    }))
  );
}

async function auditApis(context, warnings, unknowns, hardBlockers) {
  const origin = new URL(context.request.url).origin;
  const results = [];

  for (const item of API_REGISTRY) {
    const url = origin + item.path;
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'x-finance-command-center-audit': VERSION
        }
      });

      const elapsed_ms = Date.now() - started;
      let parsed = null;
      let jsonReadable = false;
      let version = null;
      let error = null;

      try {
        parsed = await res.clone().json();
        jsonReadable = true;
        version = parsed && parsed.version ? String(parsed.version) : null;
      } catch (e) {
        error = 'Response is not readable JSON.';
      }

      const status = res.ok && jsonReadable ? 'pass' : (item.required ? 'blocked' : 'unknown');

      const auditRow = {
        key: item.key,
        path: item.path,
        required: item.required,
        status,
        http_status: res.status,
        ok: res.ok,
        json_readable: jsonReadable,
        version,
        elapsed_ms,
        error
      };

      results.push(auditRow);

      if (item.required && status === 'blocked') {
        hardBlockers.push(blocker(
          'api_' + item.key + '_unhealthy',
          item.path + ' did not return healthy JSON.',
          'Fix ' + item.path + ' before trial gate.'
        ));
      } else if (!item.required && status !== 'pass') {
        unknowns.push(unknown(
          'api_' + item.key + '_unknown',
          item.path + ' could not be verified. Optional module remains Unknown.'
        ));
      }
    } catch (err) {
      const status = item.required ? 'blocked' : 'unknown';
      results.push({
        key: item.key,
        path: item.path,
        required: item.required,
        status,
        ok: false,
        json_readable: false,
        error: err.message || String(err)
      });

      if (item.required) {
        hardBlockers.push(blocker(
          'api_' + item.key + '_fetch_failed',
          item.path + ' fetch failed: ' + (err.message || String(err)),
          'Fix required API availability before trial gate.'
        ));
      } else {
        unknowns.push(unknown(
          'api_' + item.key + '_fetch_unknown',
          item.path + ' fetch failed. Optional module remains Unknown.'
        ));
      }
    }
  }

  results.push({
    key: 'money_contracts',
    path: '/api/money-contracts',
    required: false,
    status: 'banned',
    ok: false,
    note: 'This endpoint is intentionally not called. It is not allowed as a trial-trust source.'
  });

  warnings.push(warning(
    'api_contract_depth_limited',
    'API health verifies availability and JSON readability. It does not prove every downstream formula yet.'
  ));

  return results;
}

async function auditD1(db, warnings, unknowns, hardBlockers) {
  const tables = await getTables(db);
  const tableNames = tables.map(t => t.name);
  const tableSet = new Set(tableNames);

  const tableAudits = [];
  const readAudits = [];
  const rowCounts = {};
  const columnsByTable = {};

  for (const table of REQUIRED_CORE_TABLES) {
    const exists = tableSet.has(table);
    tableAudits.push({
      table,
      required: true,
      exists,
      status: exists ? 'pass' : 'blocked'
    });

    if (!exists) {
      hardBlockers.push(blocker(
        'd1_missing_table_' + table,
        'Required D1 table is missing: ' + table,
        'Create or restore table before trial gate.'
      ));
      continue;
    }

    const columns = await getColumns(db, table);
    columnsByTable[table] = columns;

    const readResult = await readProbe(db, table);
    readAudits.push(readResult);

    if (readResult.status === 'blocked') {
      hardBlockers.push(blocker(
        'd1_unreadable_' + table,
        'Required D1 table is unreadable: ' + table,
        'Fix table read failure before trial gate.'
      ));
    }

    rowCounts[table] = await countRows(db, table);
  }

  for (const table of OPTIONAL_TABLES) {
    const exists = tableSet.has(table);
    tableAudits.push({
      table,
      required: false,
      exists,
      status: exists ? 'pass' : 'unknown'
    });

    if (exists) {
      columnsByTable[table] = await getColumns(db, table);
      readAudits.push(await readProbe(db, table));
      rowCounts[table] = await countRows(db, table);
    } else {
      unknowns.push(unknown(
        'd1_optional_table_' + table + '_missing',
        'Optional table ' + table + ' is not present. Related checks remain Unknown.'
      ));
    }
  }

  const accountTruth = await auditAccountsTruth(db, tableSet, columnsByTable, warnings, unknowns, hardBlockers);
  const billsTruth = await auditBillsTruth(db, tableSet, columnsByTable, warnings, unknowns, hardBlockers);
  const debtsTruth = await auditDebtsTruth(db, tableSet, columnsByTable, warnings, unknowns, hardBlockers);
  const categoriesTruth = await auditCategoriesTruth(db, tableSet, rowCounts, unknowns);
  const reconciliationTruth = await auditReconciliationTruth(db, tableSet, rowCounts, unknowns);
  const salaryTruth = await auditSalaryTruth(db, tableSet, columnsByTable, unknowns);

  return {
    status: hardBlockers.some(b => b.key.startsWith('d1_')) ? 'blocked' : 'checked',
    tables: tableAudits,
    reads: readAudits,
    row_counts: rowCounts,
    columns: columnsByTable,
    truth: {
      accounts: accountTruth,
      bills: billsTruth,
      debts: debtsTruth,
      categories: categoriesTruth,
      reconciliation: reconciliationTruth,
      salary: salaryTruth
    }
  };
}

async function auditBusinessRules(db, apis, d1, warnings, unknowns, hardBlockers) {
  const rules = [];

  const balancesApi = apis.find(a => a.key === 'balances');
  const accountsTruth = d1.truth && d1.truth.accounts ? d1.truth.accounts : {};
  const billsTruth = d1.truth && d1.truth.bills ? d1.truth.bills : {};
  const debtsTruth = d1.truth && d1.truth.debts ? d1.truth.debts : {};
  const salaryTruth = d1.truth && d1.truth.salary ? d1.truth.salary : {};

  rules.push(rule(
    'cc_outstanding_source',
    accountsTruth.cc_account_count > 0 && balancesApi && balancesApi.status === 'pass' ? 'pass' : 'unknown',
    'Credit Card outstanding must not come from lifetime spend.',
    accountsTruth.cc_account_count > 0
      ? 'Credit Card account exists. Backend audit treats /api/balances account-balance model as current source.'
      : 'No Credit Card account could be verified from accounts table.'
  ));

  if (!accountsTruth.cc_account_count) {
    unknowns.push(unknown(
      'cc_outstanding_source_unknown',
      'Credit Card account/balance truth could not be verified. CC outstanding must remain Unknown on trust surfaces.'
    ));
  }

  rules.push(rule(
    'cc_unknown_not_zero',
    'pass',
    'Missing CC outstanding must show Unknown, not fake zero.',
    'Audit contract enforces Unknown when CC truth source is unavailable.'
  ));

  rules.push(rule(
    'salary_baseline_split',
    salaryTruth.status === 'pass' ? 'pass' : 'unknown',
    'Salary baseline must separate guaranteed from variable/speculative.',
    salaryTruth.message || 'Salary baseline source not identified yet.'
  ));

  if (salaryTruth.status !== 'pass') {
    unknowns.push(unknown(
      'salary_baseline_unknown',
      'Salary baseline could not be fully verified. Forecast salary confidence remains Unknown.'
    ));
  }

  rules.push(rule(
    'forecast_precision',
    'unknown',
    'Forecast must not fake precision when sources are missing.',
    'Forecast precision requires frontend/backend forecast contract review in a later ship.'
  ));
  unknowns.push(unknown(
    'forecast_precision_not_deep_checked',
    'Forecast endpoint/page not deeply checked yet. Do not allow this to become Ready.'
  ));

  const missingDataStatus = billsTruth.zero_amount_active_count > 0 ? 'blocked' : 'pass';
  rules.push(rule(
    'missing_data_unknown_not_zero',
    missingDataStatus,
    'Missing data must show Unknown, not zero.',
    billsTruth.zero_amount_active_count > 0
      ? 'Active bills with zero/invalid amount detected.'
      : 'No active zero-amount bill detected by backend audit.'
  ));

  if (billsTruth.zero_amount_active_count > 0) {
    hardBlockers.push(blocker(
      'active_bill_zero_amount',
      'Active bill with zero or invalid amount detected.',
      'Correct bill amount or mark intentionally configured before trial.'
    ));
  }

  rules.push(rule(
    'add_write_path',
    'unknown',
    'Add must not silently queue failed saves.',
    'Write safety cannot be proven without dry-run support. Must remain Unknown.'
  ));
  unknowns.push(unknown(
    'add_write_safety_unknown',
    'Add write path is not dry-run verified. Do not mark write safety Ready.'
  ));

  rules.push(rule(
    'money_contracts_banned',
    'pass',
    'Money-contracts must not be used as a trial-trust source.',
    'This endpoint does not call /api/money-contracts and reports it as banned.'
  ));

  rules.push(rule(
    'month_activity_scope',
    'unknown',
    'Month activity must stay separate from full ledger truth.',
    'Month-vs-ledger source separation requires monthly-close frontend review in a later ship.'
  ));
  unknowns.push(unknown(
    'month_activity_scope_unknown',
    'Month activity separation is not deeply verified by backend endpoint v0.1.'
  ));

  if (debtsTruth.invalid_kind_count > 0) {
    rules.push(rule(
      'debt_direction',
      'blocked',
      'Active debts must have payable/receivable direction.',
      'Invalid debt kind rows detected.'
    ));
    hardBlockers.push(blocker(
      'debt_direction_invalid',
      'Active debt rows have missing or invalid kind.',
      'Fix debt kind to owe/owed before trial gate.'
    ));
  } else {
    rules.push(rule(
      'debt_direction',
      debtsTruth.status === 'pass' ? 'pass' : 'unknown',
      'Active debts must have payable/receivable direction.',
      debtsTruth.message || 'Debt direction check completed.'
    ));
  }

  return rules;
}

async function auditAccountsTruth(db, tableSet, columnsByTable, warnings, unknowns, hardBlockers) {
  if (!tableSet.has('accounts')) {
    return { status: 'blocked', message: 'accounts table missing' };
  }

  const columns = columnsByTable.accounts || [];
  const hasKind = columns.includes('kind');
  const hasType = columns.includes('type');
  const hasStatus = columns.includes('status');

  const whereActive = hasStatus
    ? "WHERE status IS NULL OR status = '' OR status = 'active'"
    : '';

  const activeCount = await scalar(db, `SELECT COUNT(*) AS n FROM accounts ${whereActive}`);
  const ccCondition = [
    hasKind ? "LOWER(COALESCE(kind, '')) IN ('cc', 'credit', 'credit_card')" : null,
    hasType ? "LOWER(COALESCE(type, '')) IN ('cc', 'credit', 'credit_card', 'liability')" : null
  ].filter(Boolean).join(' OR ');

  let ccAccountCount = 0;
  if (ccCondition) {
    ccAccountCount = await scalar(db, `SELECT COUNT(*) AS n FROM accounts WHERE ${ccCondition}`);
  } else {
    unknowns.push(unknown(
      'accounts_cc_columns_unknown',
      'accounts table does not expose kind/type columns for Credit Card detection.'
    ));
  }

  if (activeCount <= 0) {
    hardBlockers.push(blocker(
      'accounts_no_active_accounts',
      'No active accounts detected.',
      'Restore active accounts before trial gate.'
    ));
  }

  return {
    status: activeCount > 0 ? 'pass' : 'blocked',
    active_account_count: activeCount,
    cc_account_count: ccAccountCount,
    columns_checked: columns,
    message: activeCount > 0
      ? 'Active accounts readable.'
      : 'No active accounts found.'
  };
}

async function auditBillsTruth(db, tableSet, columnsByTable, warnings, unknowns, hardBlockers) {
  if (!tableSet.has('bills')) {
    return { status: 'blocked', message: 'bills table missing', zero_amount_active_count: 0 };
  }

  const columns = columnsByTable.bills || [];
  const hasAmount = columns.includes('amount');
  const hasStatus = columns.includes('status');
  const hasDueDate = columns.includes('due_date') || columns.includes('due_day') || columns.includes('day');

  if (!hasAmount) {
    unknowns.push(unknown(
      'bills_amount_column_unknown',
      'Bills amount column was not found. Bill amount validity remains Unknown.'
    ));
    return {
      status: 'unknown',
      zero_amount_active_count: 0,
      message: 'Bills amount column unknown.'
    };
  }

  const activeWhere = hasStatus
    ? "WHERE status IS NULL OR status = '' OR status = 'active'"
    : '';

  const zeroAmountActiveCount = await scalar(
    db,
    `SELECT COUNT(*) AS n FROM bills ${activeWhere} ${activeWhere ? 'AND' : 'WHERE'} (amount IS NULL OR amount <= 0)`
  );

  if (!hasDueDate) {
    unknowns.push(unknown(
      'bills_due_date_column_unknown',
      'Bills due date/day column was not clearly identified.'
    ));
  }

  return {
    status: zeroAmountActiveCount > 0 ? 'blocked' : 'pass',
    zero_amount_active_count: zeroAmountActiveCount,
    due_column_identified: hasDueDate,
    columns_checked: columns,
    message: zeroAmountActiveCount > 0
      ? 'Active bill with invalid zero amount detected.'
      : 'No active zero-amount bill detected.'
  };
}

async function auditDebtsTruth(db, tableSet, columnsByTable, warnings, unknowns, hardBlockers) {
  if (!tableSet.has('debts')) {
    return { status: 'blocked', message: 'debts table missing', invalid_kind_count: 0 };
  }

  const columns = columnsByTable.debts || [];
  const hasKind = columns.includes('kind');
  const hasStatus = columns.includes('status');

  if (!hasKind) {
    unknowns.push(unknown(
      'debts_kind_column_unknown',
      'Debts kind column missing. Payable/receivable direction remains Unknown.'
    ));
    return {
      status: 'unknown',
      invalid_kind_count: 0,
      message: 'Debt direction column unknown.'
    };
  }

  const activeWhere = hasStatus
    ? "WHERE status IS NULL OR status = '' OR status = 'active'"
    : '';

  const invalidKindCount = await scalar(
    db,
    `SELECT COUNT(*) AS n FROM debts ${activeWhere} ${activeWhere ? 'AND' : 'WHERE'} LOWER(COALESCE(kind, '')) NOT IN ('owe', 'owed')`
  );

  return {
    status: invalidKindCount > 0 ? 'blocked' : 'pass',
    invalid_kind_count: invalidKindCount,
    columns_checked: columns,
    message: invalidKindCount > 0
      ? 'Invalid debt kind rows detected.'
      : 'Debt direction values are readable.'
  };
}

async function auditCategoriesTruth(db, tableSet, rowCounts, unknowns) {
  if (!tableSet.has('categories')) {
    return { status: 'blocked', message: 'categories table missing' };
  }

  const count = rowCounts.categories || 0;
  if (count <= 0) {
    unknowns.push(unknown(
      'categories_empty',
      'Categories table is readable but empty. Add/Transactions category confidence remains Unknown.'
    ));
    return { status: 'unknown', row_count: count, message: 'Categories table empty.' };
  }

  return { status: 'pass', row_count: count, message: 'Categories readable.' };
}

async function auditReconciliationTruth(db, tableSet, rowCounts, unknowns) {
  if (!tableSet.has('reconciliation')) {
    return { status: 'blocked', message: 'reconciliation table missing' };
  }

  const count = rowCounts.reconciliation || 0;
  if (count <= 0) {
    unknowns.push(unknown(
      'reconciliation_empty',
      'Reconciliation table is readable but has no rows. Declared balance confidence remains Unknown.'
    ));
    return { status: 'unknown', row_count: count, message: 'Reconciliation has no rows.' };
  }

  return { status: 'pass', row_count: count, message: 'Reconciliation readable.' };
}

async function auditSalaryTruth(db, tableSet, columnsByTable, unknowns) {
  if (tableSet.has('salary')) {
    return {
      status: 'pass',
      source: 'salary',
      columns_checked: columnsByTable.salary || [],
      message: 'salary table exists and is readable.'
    };
  }

  if (tableSet.has('settings')) {
    return {
      status: 'unknown',
      source: 'settings',
      columns_checked: columnsByTable.settings || [],
      message: 'settings table exists, but salary baseline contract is not confirmed.'
    };
  }

  unknowns.push(unknown(
    'salary_source_missing',
    'No salary table/config source identified. Salary baseline must remain Unknown.'
  ));

  return {
    status: 'unknown',
    source: null,
    message: 'No salary source identified.'
  };
}

async function getTables(db) {
  const res = await db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
     ORDER BY name`
  ).all();

  return (res.results || [])
    .map(row => ({ name: row.name }))
    .filter(row => row.name && !String(row.name).startsWith('sqlite_'));
}

async function getColumns(db, table) {
  try {
    const res = await db.prepare(`PRAGMA table_info(${safeIdentifier(table)})`).all();
    return (res.results || []).map(row => row.name).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function readProbe(db, table) {
  try {
    await db.prepare(`SELECT * FROM ${safeIdentifier(table)} LIMIT 1`).all();
    return {
      table,
      status: 'pass',
      readable: true
    };
  } catch (err) {
    return {
      table,
      status: 'blocked',
      readable: false,
      error: err.message || String(err)
    };
  }
}

async function countRows(db, table) {
  try {
    return await scalar(db, `SELECT COUNT(*) AS n FROM ${safeIdentifier(table)}`);
  } catch (e) {
    return null;
  }
}

async function scalar(db, sql) {
  const row = await db.prepare(sql).first();
  if (!row) return 0;
  if (row.n != null) return Number(row.n) || 0;
  const firstKey = Object.keys(row)[0];
  return Number(row[firstKey]) || 0;
}

function computeScores({ apis, d1, businessRules, unknowns, warnings, hardBlockers }) {
  const requiredApis = apis.filter(a => a.required);
  const passedRequiredApis = requiredApis.filter(a => a.status === 'pass').length;
  const apiHealth = requiredApis.length
    ? Math.round((passedRequiredApis / requiredApis.length) * 100)
    : 0;

  const requiredTables = d1.tables ? d1.tables.filter(t => t.required) : [];
  const passedRequiredTables = requiredTables.filter(t => t.status === 'pass').length;
  const d1Truth = requiredTables.length
    ? Math.round((passedRequiredTables / requiredTables.length) * 100)
    : 0;

  const blockedRules = businessRules.filter(r => r.status === 'blocked').length;
  const unknownRules = businessRules.filter(r => r.status === 'unknown').length;
  const passedRules = businessRules.filter(r => r.status === 'pass').length;
  const businessRuleScore = businessRules.length
    ? Math.max(0, Math.round((passedRules / businessRules.length) * 100) - (blockedRules * 20) - (unknownRules * 5))
    : 0;

  return {
    frontend_registry: 80,
    api_health: apiHealth,
    d1_truth: d1Truth,
    business_rules: businessRuleScore,
    write_safety: 0,
    runtime: 0
  };
}

function averageScore(scores) {
  const values = Object.values(scores).map(n => Number(n) || 0);
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
}

function computeVerdict(hardBlockers, warnings, unknowns) {
  if (hardBlockers.length) return 'blocked';
  if (warnings.length) return 'warning';
  if (unknowns.length) return 'ready_with_unknown';
  return 'ready';
}

function buildNextActions(hardBlockers, warnings, unknowns, businessRules, d1) {
  const actions = [];

  hardBlockers.slice(0, 5).forEach(item => {
    actions.push(item.next_action || item.message);
  });

  if (!hardBlockers.length && unknowns.length) {
    unknowns.slice(0, 5).forEach(item => {
      actions.push('Resolve Unknown: ' + item.message);
    });
  }

  if (!actions.length && warnings.length) {
    warnings.slice(0, 3).forEach(item => {
      actions.push('Review warning: ' + item.message);
    });
  }

  if (!actions.length) {
    actions.push('Connect monthly-close.html to /api/finance-command-center and display backend verdict.');
  }

  return dedupe(actions);
}

function rule(key, status, ruleText, message) {
  return {
    key,
    status,
    rule: ruleText,
    message
  };
}

function blocker(key, message, nextAction) {
  return {
    key,
    severity: 'hard_blocker',
    message,
    next_action: nextAction
  };
}

function warning(key, message) {
  return {
    key,
    severity: 'warning',
    message
  };
}

function unknown(key, message) {
  return {
    key,
    severity: 'unknown',
    message
  };
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function safeIdentifier(identifier) {
  const value = String(identifier || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('Unsafe SQL identifier: ' + value);
  }
  return value;
}

function send(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
