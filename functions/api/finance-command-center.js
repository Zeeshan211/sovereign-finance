// functions/api/finance-command-center.js
// v0.1.2 — Finance Command Centre backend read-only audit + enforcement schema
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
// - Enforcement is schema-only in this version.
// - Every blocked route/action must explain: what, why, source, required fix, override status.

const VERSION = '0.1.2';
const ENFORCEMENT_VERSION = '0.1.0';

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
    route: '/index.html',
    pages: ['index.html'],
    apis: ['/api/balances?debug=1'],
    d1_tables: ['accounts', 'transactions', 'debts', 'bills'],
    depends_on: ['accounts', 'debts', 'bills'],
    impacts: ['whole cockpit']
  },
  {
    key: 'add',
    label: 'Add Transaction',
    route: '/add.html',
    pages: ['add.html'],
    apis: ['/api/accounts', '/api/categories', '/api/transactions'],
    d1_tables: ['accounts', 'transactions', 'categories'],
    depends_on: ['store', 'accounts', 'categories'],
    impacts: ['balances', 'transactions']
  },
  {
    key: 'transactions',
    label: 'Transactions',
    route: '/transactions.html',
    pages: ['transactions.html'],
    apis: ['/api/transactions'],
    d1_tables: ['transactions'],
    depends_on: ['accounts'],
    impacts: ['balances', 'forecast']
  },
  {
    key: 'accounts',
    label: 'Accounts',
    route: '/accounts.html',
    pages: ['accounts.html'],
    apis: ['/api/accounts'],
    d1_tables: ['accounts'],
    depends_on: ['transactions'],
    impacts: ['balances', 'reconciliation']
  },
  {
    key: 'credit_card',
    label: 'Credit Card',
    route: '/cc.html',
    pages: ['cc.html'],
    apis: ['/api/accounts', '/api/balances?debug=1'],
    d1_tables: ['accounts', 'transactions'],
    depends_on: ['cc account', 'balances'],
    impacts: ['hub', 'forecast']
  },
  {
    key: 'bills',
    label: 'Bills',
    route: '/bills.html',
    pages: ['bills.html'],
    apis: ['/api/bills'],
    d1_tables: ['bills'],
    depends_on: ['accounts'],
    impacts: ['forecast']
  },
  {
    key: 'debts',
    label: 'Debts',
    route: '/debts.html',
    pages: ['debts.html'],
    apis: ['/api/debts'],
    d1_tables: ['debts'],
    depends_on: ['accounts'],
    impacts: ['forecast']
  },
  {
    key: 'salary',
    label: 'Salary',
    route: '/salary.html',
    pages: ['salary.html'],
    apis: ['/api/salary'],
    d1_tables: ['salary', 'settings'],
    depends_on: ['salary config'],
    impacts: ['forecast']
  },
  {
    key: 'forecast',
    label: 'Forecast',
    route: '/forecast.html',
    pages: ['forecast.html'],
    apis: ['/api/forecast'],
    d1_tables: ['accounts', 'transactions', 'bills', 'debts'],
    depends_on: ['balances', 'bills', 'debts', 'salary'],
    impacts: ['command centre']
  },
  {
    key: 'reconciliation',
    label: 'Reconciliation',
    route: '/reconciliation.html',
    pages: ['reconciliation.html'],
    apis: ['/api/reconciliation'],
    d1_tables: ['reconciliation', 'accounts'],
    depends_on: ['accounts', 'transactions'],
    impacts: ['command centre']
  },
  {
    key: 'command_centre',
    label: 'Command Centre',
    route: '/monthly-close.html',
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

const READ_ONLY_GUARDS = [
  'No D1 INSERT',
  'No D1 UPDATE',
  'No D1 DELETE',
  'No D1 ALTER',
  'No ledger smoke tests',
  'No transaction creation',
  'No /api/money-contracts',
  'Unknown remains Unknown',
  'Runtime/browser checks remain manual',
  'Write safety remains Unknown until dry-run exists',
  'Enforcement v0.1.0 is schema-only and does not yet mutate or reject API calls'
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
    const coverage = buildCoverage(modules, pages, apis, d1, businessRules, warnings, unknowns);
    const scores = computeScores({ apis, d1, businessRules, coverage });
    const score = averageScore(scores);
    const verdict = computeVerdict(hardBlockers, warnings, unknowns);
    const trialGate = computeTrialGate(verdict, hardBlockers, warnings, unknowns, scores, businessRules);
    const sourceProofs = buildSourceProofs(apis, d1);
    const enforcement = buildEnforcement({
      computedAt: startedAt,
      verdict,
      hardBlockers,
      warnings,
      unknowns,
      scores,
      trialGate,
      sourceProofs,
      coverage,
      businessRules,
      d1
    });
    const nextActions = buildNextActions(hardBlockers, warnings, unknowns, businessRules, d1, trialGate, enforcement);

    return send({
      ok: hardBlockers.length === 0,
      version: VERSION,
      computed_at: startedAt,
      verdict,
      score,
      scores,
      trial_gate: trialGate,
      enforcement,
      summary: {
        hard_blocker_count: hardBlockers.length,
        warning_count: warnings.length,
        unknown_count: unknowns.length,
        module_count: modules.length,
        registered_page_count: pages.length,
        api_check_count: apis.length,
        business_rule_count: businessRules.length,
        enforcement_blocked_action_count: enforcement.blocked_actions.length,
        enforcement_view_only_route_count: enforcement.view_only_routes.length
      },
      read_only_guards: READ_ONLY_GUARDS,
      source_proofs: sourceProofs,
      coverage,
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
    const hardBlockers = [
      blocker('endpoint_exception', err.message || String(err), 'Fix endpoint exception before using Command Centre as a trial gate.')
    ];

    const enforcement = buildEmergencyEnforcement(startedAt, hardBlockers[0]);

    return send({
      ok: false,
      version: VERSION,
      computed_at: startedAt,
      verdict: 'blocked',
      score: 0,
      scores: emptyScores(),
      trial_gate: {
        status: 'blocked',
        ready_for_known_page_trial: false,
        ready_for_full_system_certification: false,
        reason: 'Endpoint exception occurred.'
      },
      enforcement,
      summary: {
        hard_blocker_count: 1,
        warning_count: 0,
        unknown_count: 0,
        module_count: FINANCE_REGISTRY.length,
        registered_page_count: FINANCE_REGISTRY.length,
        api_check_count: 0,
        business_rule_count: 0,
        enforcement_blocked_action_count: enforcement.blocked_actions.length,
        enforcement_view_only_route_count: enforcement.view_only_routes.length
      },
      read_only_guards: READ_ONLY_GUARDS,
      source_proofs: [],
      coverage: {},
      hard_blockers: hardBlockers,
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
  const hard = blocker(key, message, 'Restore the required backend binding before running Command Centre audit.');
  const enforcement = buildEmergencyEnforcement(computedAt, hard);

  return {
    ok: false,
    version: VERSION,
    computed_at: computedAt,
    verdict: 'blocked',
    score: 0,
    scores: emptyScores(),
    trial_gate: {
      status: 'blocked',
      ready_for_known_page_trial: false,
      ready_for_full_system_certification: false,
      reason: message
    },
    enforcement,
    summary: {
      hard_blocker_count: 1,
      warning_count: 0,
      unknown_count: 0,
      module_count: FINANCE_REGISTRY.length,
      registered_page_count: FINANCE_REGISTRY.length,
      api_check_count: 0,
      business_rule_count: 0,
      enforcement_blocked_action_count: enforcement.blocked_actions.length,
      enforcement_view_only_route_count: enforcement.view_only_routes.length
    },
    read_only_guards: READ_ONLY_GUARDS,
    source_proofs: [],
    coverage: {},
    hard_blockers: [hard],
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
    route: module.route,
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
      route: module.route,
      module: module.key,
      status: 'registered',
      runtime_status: 'unknown',
      note: 'Backend can register this page but cannot prove browser runtime. Manual browser check remains required.'
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
          accept: 'application/json',
          'x-finance-command-center-audit': VERSION
        }
      });

      const elapsed_ms = Date.now() - started;
      let parsed = null;
      let jsonReadable = false;
      let version = null;
      let error = null;
      let shape = null;

      try {
        parsed = await res.clone().json();
        jsonReadable = true;
        version = parsed && parsed.version ? String(parsed.version) : null;
        shape = summarizeJsonShape(parsed);
      } catch (e) {
        error = 'Response is not readable JSON.';
      }

      const status = res.ok && jsonReadable ? 'pass' : (item.required ? 'blocked' : 'unknown');

      results.push({
        key: item.key,
        path: item.path,
        required: item.required,
        status,
        http_status: res.status,
        ok: res.ok,
        json_readable: jsonReadable,
        version,
        elapsed_ms,
        shape,
        error
      });

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
    called: false,
    note: 'This endpoint is intentionally not called. It is not allowed as a trial-trust source.'
  });

  warnings.push(warning(
    'api_contract_depth_limited',
    'API health verifies route availability and JSON readability. It does not prove every downstream formula yet.'
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

  const accountTruth = await auditAccountsTruth(db, tableSet, columnsByTable, unknowns, hardBlockers);
  const transactionTruth = await auditTransactionsTruth(tableSet, rowCounts, unknowns);
  const billsTruth = await auditBillsTruth(db, tableSet, columnsByTable, unknowns);
  const debtsTruth = await auditDebtsTruth(db, tableSet, columnsByTable, unknowns);
  const categoriesTruth = await auditCategoriesTruth(tableSet, rowCounts, unknowns);
  const reconciliationTruth = await auditReconciliationTruth(tableSet, rowCounts, unknowns);
  const salaryTruth = await auditSalaryTruth(tableSet, columnsByTable, unknowns);

  return {
    status: hardBlockers.some(b => b.key.startsWith('d1_')) ? 'blocked' : 'checked',
    tables: tableAudits,
    reads: readAudits,
    row_counts: rowCounts,
    columns: columnsByTable,
    truth: {
      accounts: accountTruth,
      transactions: transactionTruth,
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
  const transactionsTruth = d1.truth && d1.truth.transactions ? d1.truth.transactions : {};

  const ccSourceStatus = accountsTruth.cc_account_count > 0 && accountsTruth.cc_balance_source
    ? 'pass'
    : 'unknown';

  rules.push(rule(
    'cc_outstanding_source',
    ccSourceStatus,
    'Credit Card outstanding must not come from lifetime spend.',
    ccSourceStatus === 'pass'
      ? 'Credit Card source proof found from accounts table balance column: ' + accountsTruth.cc_balance_source + '. Lifetime spend is not used.'
      : 'Credit Card realtime account/balance source could not be fully proven. Must remain Unknown on trust surfaces.'
  ));

  if (ccSourceStatus !== 'pass') {
    unknowns.push(unknown(
      'cc_outstanding_source_unknown',
      'Credit Card account/balance truth could not be fully verified. CC outstanding must remain Unknown on trust surfaces.'
    ));
  }

  rules.push(rule(
    'cc_unknown_not_zero',
    'pass',
    'Missing CC outstanding must show Unknown, not fake zero.',
    'Audit contract requires Unknown if CC truth source is unavailable.'
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
    'Forecast endpoint/page contract is not deeply verified by this backend version. Forecast precision remains Unknown.'
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
    transactionsTruth.status === 'pass' ? 'warning' : 'unknown',
    'Month activity must stay separate from full ledger truth.',
    'Transactions table exists, but month-vs-ledger separation is not deeply verified here.'
  ));

  warnings.push(warning(
    'month_activity_scope_not_deep_checked',
    'Month activity separation is not deeply verified by backend endpoint v0.1.2.'
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

function buildEnforcement(ctx) {
  const hardBlockers = ctx.hardBlockers || [];
  const warnings = ctx.warnings || [];
  const unknowns = ctx.unknowns || [];
  const sourceProofs = ctx.sourceProofs || [];
  const businessRules = ctx.businessRules || [];
  const coverage = ctx.coverage || {};
  const scores = ctx.scores || {};
  const trialGate = ctx.trialGate || {};

  const policy = {
    unknown_blocks_ready: true,
    hard_blockers_block_actions: true,
    write_safety_required_for_mutations: true,
    runtime_required_for_trial: false,
    backend_required_for_authority: true,
    frontend_only_never_final: true,
    command_centre_never_hides_truth: true,
    every_block_must_show_reason: true
  };

  const blockExplanations = [];
  const routes = [];
  const actions = [];

  const hasHardBlockers = hardBlockers.length > 0;
  const writeSafetyUnknown = Number(scores.write_safety || 0) === 0 || getPath(coverage, 'write_safety.status') === 'unknown';
  const runtimeUnknown = Number(scores.runtime || 0) === 0 || getPath(coverage, 'runtime.status') === 'unknown';
  const forecastUnknown = ruleStatus(businessRules, 'forecast_precision') === 'unknown';
  const ccSourceUnknown = ruleStatus(businessRules, 'cc_outstanding_source') === 'unknown';
  const salaryUnknown = ruleStatus(businessRules, 'salary_baseline_split') === 'unknown';
  const billsBlocked = ruleStatus(businessRules, 'missing_data_unknown_not_zero') === 'blocked';
  const debtsBlocked = ruleStatus(businessRules, 'debt_direction') === 'blocked';

  const ccProof = sourceProofs.find(p => p.key === 'credit_card');
  const moneyContractsProof = sourceProofs.find(p => p.key === 'money_contracts');

  routes.push(routeGate({
    route: '/monthly-close.html',
    module: 'command_centre',
    status: 'pass',
    level: 0,
    viewAllowed: true,
    actionsAllowed: true,
    reason: 'Command Centre is the authority and diagnostic surface.',
    source: 'enforcement.policy.command_centre_never_hides_truth',
    requiredFix: 'None.'
  }));

  routes.push(routeGate({
    route: '/index.html',
    module: 'hub',
    status: hasHardBlockers ? 'warn' : 'pass',
    level: hasHardBlockers ? 1 : 0,
    viewAllowed: true,
    actionsAllowed: !hasHardBlockers,
    reason: hasHardBlockers ? 'System has hard blockers. Hub remains visible for diagnosis.' : 'No hub-specific blocker returned.',
    source: hasHardBlockers ? 'hard_blockers' : 'enforcement.registry.hub',
    requiredFix: hasHardBlockers ? 'Resolve hard blockers shown in Command Centre.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/add.html',
    module: 'add',
    status: writeSafetyUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: writeSafetyUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(writeSafetyUnknown || hasHardBlockers),
    reason: writeSafetyUnknown ? 'Write safety is unknown. Add page can be inspected, but save actions must stay blocked.' : 'No add-specific blocker returned.',
    source: writeSafetyUnknown ? 'coverage.write_safety.status' : 'enforcement.registry.add',
    requiredFix: writeSafetyUnknown ? 'Add dry-run write safety before allowing trial writes.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/cc.html',
    module: 'credit_card',
    status: ccSourceUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: ccSourceUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(ccSourceUnknown || hasHardBlockers),
    reason: ccSourceUnknown ? 'Credit Card source proof is unknown. CC can be inspected, but decisions must stay blocked.' : 'Credit Card source proof is available.',
    source: ccSourceUnknown ? 'business_rules.cc_outstanding_source' : (ccProof && ccProof.source ? ccProof.source : 'source_proofs.credit_card'),
    requiredFix: ccSourceUnknown ? 'Prove realtime Credit Card account/balance source. Never use lifetime spend.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/forecast.html',
    module: 'forecast',
    status: forecastUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: forecastUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(forecastUnknown || hasHardBlockers),
    reason: forecastUnknown ? 'Forecast precision is unknown because forecast source checks are incomplete.' : 'No forecast-specific blocker returned.',
    source: forecastUnknown ? 'business_rules.forecast_precision' : 'enforcement.registry.forecast',
    requiredFix: forecastUnknown ? 'Complete forecast source verification before enabling forecast decisions.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/salary.html',
    module: 'salary',
    status: salaryUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: salaryUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(salaryUnknown || hasHardBlockers),
    reason: salaryUnknown ? 'Salary baseline split is unknown.' : 'Salary baseline source is available.',
    source: salaryUnknown ? 'business_rules.salary_baseline_split' : 'source_proofs.salary',
    requiredFix: salaryUnknown ? 'Prove guaranteed salary baseline separately from variable/speculative income.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/bills.html',
    module: 'bills',
    status: billsBlocked || writeSafetyUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: billsBlocked || writeSafetyUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(billsBlocked || writeSafetyUnknown || hasHardBlockers),
    reason: billsBlocked ? 'Bill data has an active zero/invalid amount blocker.' : writeSafetyUnknown ? 'Write safety is unknown.' : 'No bills-specific blocker returned.',
    source: billsBlocked ? 'business_rules.missing_data_unknown_not_zero' : writeSafetyUnknown ? 'coverage.write_safety.status' : 'enforcement.registry.bills',
    requiredFix: billsBlocked ? 'Fix invalid active bill amount or mark it intentionally configured.' : writeSafetyUnknown ? 'Add dry-run write safety before allowing bill mutations.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/debts.html',
    module: 'debts',
    status: debtsBlocked || writeSafetyUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: debtsBlocked || writeSafetyUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(debtsBlocked || writeSafetyUnknown || hasHardBlockers),
    reason: debtsBlocked ? 'Debt direction/kind is unsafe.' : writeSafetyUnknown ? 'Write safety is unknown.' : 'No debts-specific blocker returned.',
    source: debtsBlocked ? 'business_rules.debt_direction' : writeSafetyUnknown ? 'coverage.write_safety.status' : 'enforcement.registry.debts',
    requiredFix: debtsBlocked ? 'Fix debt kind/direction.' : writeSafetyUnknown ? 'Add dry-run write safety before allowing debt mutations.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/reconciliation.html',
    module: 'reconciliation',
    status: writeSafetyUnknown || hasHardBlockers ? 'soft_block' : 'pass',
    level: writeSafetyUnknown || hasHardBlockers ? 2 : 0,
    viewAllowed: true,
    actionsAllowed: !(writeSafetyUnknown || hasHardBlockers),
    reason: writeSafetyUnknown ? 'Write safety is unknown. Reconciliation declarations must stay blocked.' : 'No reconciliation-specific blocker returned.',
    source: writeSafetyUnknown ? 'coverage.write_safety.status' : 'enforcement.registry.reconciliation',
    requiredFix: writeSafetyUnknown ? 'Add dry-run write safety before allowing reconciliation declarations.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/transactions.html',
    module: 'transactions',
    status: writeSafetyUnknown || hasHardBlockers ? 'warn' : 'pass',
    level: writeSafetyUnknown || hasHardBlockers ? 1 : 0,
    viewAllowed: true,
    actionsAllowed: !(writeSafetyUnknown || hasHardBlockers),
    reason: writeSafetyUnknown ? 'Transactions are viewable, but mutating actions remain unsafe until write safety is proven.' : 'No transactions-specific blocker returned.',
    source: writeSafetyUnknown ? 'coverage.write_safety.status' : 'enforcement.registry.transactions',
    requiredFix: writeSafetyUnknown ? 'Add dry-run write safety before allowing transaction mutations.' : 'None.'
  }));

  routes.push(routeGate({
    route: '/accounts.html',
    module: 'accounts',
    status: writeSafetyUnknown || hasHardBlockers ? 'warn' : 'pass',
    level: writeSafetyUnknown || hasHardBlockers ? 1 : 0,
    viewAllowed: true,
    actionsAllowed: !(writeSafetyUnknown || hasHardBlockers),
    reason: writeSafetyUnknown ? 'Accounts are viewable, but mutating actions remain unsafe until write safety is proven.' : 'No accounts-specific blocker returned.',
    source: writeSafetyUnknown ? 'coverage.write_safety.status' : 'enforcement.registry.accounts',
    requiredFix: writeSafetyUnknown ? 'Add dry-run write safety before allowing account mutations.' : 'None.'
  }));

  actions.push(actionGate({
    action: 'transaction.save',
    module: 'add',
    blocked: writeSafetyUnknown || hasHardBlockers,
    reason: writeSafetyUnknown ? 'Write safety is unknown.' : 'Hard blocker exists.',
    source: writeSafetyUnknown ? 'coverage.write_safety.status' : 'hard_blockers',
    requiredFix: writeSafetyUnknown ? 'Add dry-run write safety check before allowing trial writes.' : 'Resolve hard blockers shown in Command Centre.'
  }));

  actions.push(actionGate({
    action: 'bill.save',
    module: 'bills',
    blocked: writeSafetyUnknown || billsBlocked || hasHardBlockers,
    reason: billsBlocked ? 'Bill data has a blocker.' : writeSafetyUnknown ? 'Write safety is unknown.' : 'Hard blocker exists.',
    source: billsBlocked ? 'business_rules.missing_data_unknown_not_zero' : writeSafetyUnknown ? 'coverage.write_safety.status' : 'hard_blockers',
    requiredFix: billsBlocked ? 'Fix invalid active bill amount.' : writeSafetyUnknown ? 'Add dry-run write safety check.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'debt.save',
    module: 'debts',
    blocked: writeSafetyUnknown || debtsBlocked || hasHardBlockers,
    reason: debtsBlocked ? 'Debt direction is unsafe.' : writeSafetyUnknown ? 'Write safety is unknown.' : 'Hard blocker exists.',
    source: debtsBlocked ? 'business_rules.debt_direction' : writeSafetyUnknown ? 'coverage.write_safety.status' : 'hard_blockers',
    requiredFix: debtsBlocked ? 'Fix debt kind/direction.' : writeSafetyUnknown ? 'Add dry-run write safety check.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'reconciliation.declare',
    module: 'reconciliation',
    blocked: writeSafetyUnknown || hasHardBlockers,
    reason: writeSafetyUnknown ? 'Write safety is unknown.' : 'Hard blocker exists.',
    source: writeSafetyUnknown ? 'coverage.write_safety.status' : 'hard_blockers',
    requiredFix: writeSafetyUnknown ? 'Add dry-run write safety check before allowing declarations.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'salary.save',
    module: 'salary',
    blocked: writeSafetyUnknown || salaryUnknown || hasHardBlockers,
    reason: salaryUnknown ? 'Salary baseline is unknown.' : writeSafetyUnknown ? 'Write safety is unknown.' : 'Hard blocker exists.',
    source: salaryUnknown ? 'business_rules.salary_baseline_split' : writeSafetyUnknown ? 'coverage.write_safety.status' : 'hard_blockers',
    requiredFix: salaryUnknown ? 'Prove salary baseline split.' : writeSafetyUnknown ? 'Add dry-run write safety check.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'forecast.generate',
    module: 'forecast',
    blocked: forecastUnknown || hasHardBlockers,
    reason: forecastUnknown ? 'Forecast precision is unknown.' : 'Hard blocker exists.',
    source: forecastUnknown ? 'business_rules.forecast_precision' : 'hard_blockers',
    requiredFix: forecastUnknown ? 'Complete forecast source verification before enabling forecast decisions.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'forecast.mark_ready',
    module: 'forecast',
    blocked: forecastUnknown || hasHardBlockers,
    reason: forecastUnknown ? 'Forecast precision is unknown.' : 'Hard blocker exists.',
    source: forecastUnknown ? 'business_rules.forecast_precision' : 'hard_blockers',
    requiredFix: forecastUnknown ? 'Complete forecast source verification.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'cc.use_for_decision',
    module: 'credit_card',
    blocked: ccSourceUnknown || hasHardBlockers,
    reason: ccSourceUnknown ? 'Credit Card outstanding source is not fully proven.' : 'Hard blocker exists.',
    source: ccSourceUnknown ? 'business_rules.cc_outstanding_source' : (ccProof && ccProof.source ? ccProof.source : 'hard_blockers'),
    requiredFix: ccSourceUnknown ? 'Prove realtime Credit Card account/balance source. Never use lifetime spend.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'cc.use_for_forecast',
    module: 'credit_card',
    blocked: ccSourceUnknown || forecastUnknown || hasHardBlockers,
    reason: ccSourceUnknown ? 'Credit Card source is unknown.' : forecastUnknown ? 'Forecast precision is unknown.' : 'Hard blocker exists.',
    source: ccSourceUnknown ? 'business_rules.cc_outstanding_source' : forecastUnknown ? 'business_rules.forecast_precision' : 'hard_blockers',
    requiredFix: ccSourceUnknown ? 'Prove realtime Credit Card account/balance source.' : forecastUnknown ? 'Complete forecast source verification.' : 'Resolve hard blockers.'
  }));

  actions.push(actionGate({
    action: 'money_contracts.use_as_truth_source',
    module: 'system',
    blocked: true,
    reason: '/api/money-contracts is banned as a finance-truth source.',
    source: moneyContractsProof && moneyContractsProof.source ? moneyContractsProof.source : 'source_proofs.money_contracts',
    requiredFix: 'Do not use /api/money-contracts for trial-trust pages.'
  }));

  routes.forEach(route => {
    if (route.status === 'soft_block' || route.status === 'blocked') {
      blockExplanations.push(blockExplanation({
        blockedItem: route.route,
        blockType: route.status === 'blocked' ? 'route_block' : 'route_soft_block',
        reason: route.reason,
        source: route.source,
        requiredFix: route.required_fix,
        overrideAllowed: false,
        backendEnforced: false,
        frontendEnforced: false
      }));
    }
  });

  actions.forEach(action => {
    if (!action.allowed) {
      blockExplanations.push(blockExplanation({
        blockedItem: action.action,
        blockType: 'action_block',
        reason: action.reason,
        source: action.source,
        requiredFix: action.required_fix,
        overrideAllowed: false,
        backendEnforced: false,
        frontendEnforced: false
      }));
    }
  });

  hardBlockers.forEach(item => {
    blockExplanations.push(blockExplanation({
      blockedItem: item.key,
      blockType: 'hard_blocker',
      reason: item.message,
      source: 'hard_blockers.' + item.key,
      requiredFix: item.next_action || 'Resolve hard blocker.',
      overrideAllowed: false,
      backendEnforced: false,
      frontendEnforced: false
    }));
  });

  const blockedActions = actions.filter(a => !a.allowed).map(a => a.action);
  const viewOnlyRoutes = routes.filter(r => r.view_allowed && !r.actions_allowed).map(r => r.route);
  const blockedRoutes = routes.filter(r => !r.view_allowed).map(r => r.route);

  const globalStatus = hasHardBlockers ? 'blocked' : warnings.length ? 'warning' : unknowns.length ? 'ready_with_unknown' : 'ready';
  const globalLevel = hasHardBlockers ? 3 : blockedActions.length ? 2 : warnings.length ? 1 : 0;

  return {
    version: ENFORCEMENT_VERSION,
    endpoint_version: VERSION,
    mode: 'authority',
    computed_at: ctx.computedAt,
    schema_only: true,
    global_status: globalStatus,
    global_level: globalLevel,
    ready_for_known_page_trial: Boolean(trialGate.ready_for_known_page_trial),
    ready_for_full_system_certification: Boolean(trialGate.ready_for_full_system_certification),
    policy,
    routes,
    actions,
    blocked_routes: blockedRoutes,
    view_only_routes: viewOnlyRoutes,
    blocked_actions: blockedActions,
    block_explanations: blockExplanations,
    reasons: dedupe(blockExplanations.map(b => b.reason)),
    overrides: {
      allowed: false,
      requires_reason: true,
      requires_operator_confirmation: true,
      expires_minutes: 30,
      audit_required: true,
      note: 'Overrides are disabled in enforcement schema v0.1.0.'
    },
    enforcement_status_note: 'This version defines authority policy only. Frontend and mutating APIs do not yet enforce it.'
  };
}

function buildEmergencyEnforcement(computedAt, hardBlocker) {
  const action = actionGate({
    action: 'system.trial',
    module: 'system',
    blocked: true,
    reason: hardBlocker.message,
    source: 'hard_blockers.' + hardBlocker.key,
    requiredFix: hardBlocker.next_action || 'Fix backend audit before continuing.'
  });

  const explanation = blockExplanation({
    blockedItem: 'system.trial',
    blockType: 'hard_blocker',
    reason: hardBlocker.message,
    source: 'hard_blockers.' + hardBlocker.key,
    requiredFix: hardBlocker.next_action || 'Fix backend audit before continuing.',
    overrideAllowed: false,
    backendEnforced: false,
    frontendEnforced: false
  });

  return {
    version: ENFORCEMENT_VERSION,
    endpoint_version: VERSION,
    mode: 'authority',
    computed_at: computedAt,
    schema_only: true,
    global_status: 'blocked',
    global_level: 3,
    ready_for_known_page_trial: false,
    ready_for_full_system_certification: false,
    policy: {
      unknown_blocks_ready: true,
      hard_blockers_block_actions: true,
      write_safety_required_for_mutations: true,
      runtime_required_for_trial: false,
      backend_required_for_authority: true,
      frontend_only_never_final: true,
      command_centre_never_hides_truth: true,
      every_block_must_show_reason: true
    },
    routes: [],
    actions: [action],
    blocked_routes: [],
    view_only_routes: [],
    blocked_actions: ['system.trial'],
    block_explanations: [explanation],
    reasons: [hardBlocker.message],
    overrides: {
      allowed: false,
      requires_reason: true,
      requires_operator_confirmation: true,
      expires_minutes: 30,
      audit_required: true,
      note: 'Overrides are disabled in enforcement schema v0.1.0.'
    },
    enforcement_status_note: 'Emergency enforcement schema generated because backend audit failed.'
  };
}

function routeGate({ route, module, status, level, viewAllowed, actionsAllowed, reason, source, requiredFix }) {
  return {
    route,
    module,
    status,
    level,
    view_allowed: Boolean(viewAllowed),
    actions_allowed: Boolean(actionsAllowed),
    reason,
    source,
    required_fix: requiredFix,
    override: {
      allowed: false,
      reason_required: true
    }
  };
}

function actionGate({ action, module, blocked, reason, source, requiredFix }) {
  return {
    action,
    module,
    status: blocked ? 'blocked' : 'pass',
    level: blocked ? 3 : 0,
    allowed: !blocked,
    reason: blocked ? reason : 'No enforcement block returned for this action.',
    source: blocked ? source : 'enforcement.policy',
    required_fix: blocked ? requiredFix : 'None.',
    backend_enforced: false,
    frontend_enforced: false,
    override: {
      allowed: false,
      reason_required: true
    }
  };
}

function blockExplanation({ blockedItem, blockType, reason, source, requiredFix, overrideAllowed, backendEnforced, frontendEnforced }) {
  return {
    blocked_item: blockedItem,
    block_type: blockType,
    reason,
    source,
    required_fix: requiredFix,
    override_allowed: Boolean(overrideAllowed),
    backend_enforced: Boolean(backendEnforced),
    frontend_enforced: Boolean(frontendEnforced)
  };
}

async function auditAccountsTruth(db, tableSet, columnsByTable, unknowns, hardBlockers) {
  if (!tableSet.has('accounts')) {
    return { status: 'blocked', message: 'accounts table missing' };
  }

  const columns = columnsByTable.accounts || [];
  const hasStatus = columns.includes('status');
  const hasKind = columns.includes('kind');
  const hasType = columns.includes('type');
  const hasName = columns.includes('name');
  const balanceColumn = pickFirstColumn(columns, [
    'balance',
    'current_balance',
    'available_balance',
    'amount',
    'current_amount'
  ]);

  const whereActive = hasStatus
    ? "WHERE status IS NULL OR status = '' OR LOWER(status) = 'active'"
    : '';

  const activeCount = await scalar(db, `SELECT COUNT(*) AS n FROM accounts ${whereActive}`);

  const ccClauses = [];
  if (hasKind) ccClauses.push("LOWER(COALESCE(kind, '')) IN ('cc', 'credit', 'credit_card')");
  if (hasType) ccClauses.push("LOWER(COALESCE(type, '')) IN ('cc', 'credit', 'credit_card', 'liability')");
  if (hasName) ccClauses.push("LOWER(COALESCE(name, '')) LIKE '%credit%'");

  let ccAccountCount = 0;
  let ccBalanceReadable = false;
  let ccBalanceSource = null;

  if (ccClauses.length) {
    const ccWhere = ccClauses.join(' OR ');
    ccAccountCount = await scalar(db, `SELECT COUNT(*) AS n FROM accounts WHERE ${ccWhere}`);

    if (ccAccountCount > 0 && balanceColumn) {
      const sample = await firstRow(
        db,
        `SELECT ${safeIdentifier(balanceColumn)} AS balance_value FROM accounts WHERE ${ccWhere} LIMIT 1`
      );

      ccBalanceReadable = sample && Object.prototype.hasOwnProperty.call(sample, 'balance_value');
      ccBalanceSource = ccBalanceReadable ? 'accounts.' + balanceColumn : null;
    }
  } else {
    unknowns.push(unknown(
      'accounts_cc_columns_unknown',
      'accounts table does not expose kind/type/name columns for Credit Card detection.'
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
    cc_balance_readable: ccBalanceReadable,
    cc_balance_source: ccBalanceSource,
    balance_column_identified: balanceColumn,
    columns_checked: columns,
    message: activeCount > 0 ? 'Active accounts readable.' : 'No active accounts found.'
  };
}

async function auditTransactionsTruth(tableSet, rowCounts, unknowns) {
  if (!tableSet.has('transactions')) {
    return { status: 'blocked', message: 'transactions table missing' };
  }

  const count = rowCounts.transactions || 0;

  if (count <= 0) {
    unknowns.push(unknown(
      'transactions_empty',
      'Transactions table is readable but empty. Ledger truth remains Unknown.'
    ));

    return {
      status: 'unknown',
      row_count: count,
      message: 'Transactions table empty.'
    };
  }

  return {
    status: 'pass',
    row_count: count,
    message: 'Transactions table has rows.'
  };
}

async function auditBillsTruth(db, tableSet, columnsByTable, unknowns) {
  if (!tableSet.has('bills')) {
    return { status: 'blocked', message: 'bills table missing', zero_amount_active_count: 0 };
  }

  const columns = columnsByTable.bills || [];
  const amountColumn = pickFirstColumn(columns, ['amount', 'expected_amount', 'monthly_amount']);
  const hasStatus = columns.includes('status');
  const hasDueDate = columns.includes('due_date') || columns.includes('due_day') || columns.includes('day');

  if (!amountColumn) {
    unknowns.push(unknown(
      'bills_amount_column_unknown',
      'Bills amount column was not found. Bill amount validity remains Unknown.'
    ));

    return {
      status: 'unknown',
      zero_amount_active_count: 0,
      due_column_identified: hasDueDate,
      columns_checked: columns,
      message: 'Bills amount column unknown.'
    };
  }

  const activeWhere = hasStatus
    ? "WHERE status IS NULL OR status = '' OR LOWER(status) = 'active'"
    : '';

  const zeroAmountActiveCount = await scalar(
    db,
    `SELECT COUNT(*) AS n FROM bills ${activeWhere} ${activeWhere ? 'AND' : 'WHERE'} (${safeIdentifier(amountColumn)} IS NULL OR ${safeIdentifier(amountColumn)} <= 0)`
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
    amount_column_identified: amountColumn,
    due_column_identified: hasDueDate,
    columns_checked: columns,
    message: zeroAmountActiveCount > 0
      ? 'Active bill with invalid zero amount detected.'
      : 'No active zero-amount bill detected.'
  };
}

async function auditDebtsTruth(db, tableSet, columnsByTable, unknowns) {
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
      columns_checked: columns,
      message: 'Debt direction column unknown.'
    };
  }

  const activeWhere = hasStatus
    ? "WHERE status IS NULL OR status = '' OR LOWER(status) = 'active'"
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

async function auditCategoriesTruth(tableSet, rowCounts, unknowns) {
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

async function auditReconciliationTruth(tableSet, rowCounts, unknowns) {
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

async function auditSalaryTruth(tableSet, columnsByTable, unknowns) {
  if (tableSet.has('salary')) {
    return {
      status: 'pass',
      source: 'salary',
      columns_checked: columnsByTable.salary || [],
      message: 'salary table exists and is readable. Baseline split still depends on salary schema meaning.'
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

function buildCoverage(modules, pages, apis, d1, businessRules, warnings, unknowns) {
  const registeredModules = modules.length;
  const registeredPages = pages.length;
  const checkedApis = apis.filter(a => a.key !== 'money_contracts').length;
  const requiredApis = apis.filter(a => a.required);
  const passedRequiredApis = requiredApis.filter(a => a.status === 'pass').length;
  const requiredTables = Array.isArray(d1.tables) ? d1.tables.filter(t => t.required) : [];
  const passedRequiredTables = requiredTables.filter(t => t.status === 'pass').length;
  const passedRules = businessRules.filter(r => r.status === 'pass').length;

  return {
    status: unknowns.length ? 'unknown' : 'checked',
    registry: {
      modules_registered: registeredModules,
      pages_registered: registeredPages,
      registry_completeness: 'known_modules_only',
      note: 'Backend can verify registered modules only. Anything outside registry remains unknown.'
    },
    api: {
      required_api_count: requiredApis.length,
      required_api_pass_count: passedRequiredApis,
      checked_api_count: checkedApis
    },
    d1: {
      required_table_count: requiredTables.length,
      required_table_pass_count: passedRequiredTables
    },
    business_rules: {
      rule_count: businessRules.length,
      pass_count: passedRules,
      unknown_count: businessRules.filter(r => r.status === 'unknown').length,
      warning_count: businessRules.filter(r => r.status === 'warning').length,
      blocked_count: businessRules.filter(r => r.status === 'blocked').length
    },
    runtime: {
      status: 'unknown',
      note: 'Backend cannot prove browser runtime.'
    },
    write_safety: {
      status: 'unknown',
      note: 'No write dry-run endpoint exists yet.'
    }
  };
}

function buildSourceProofs(apis, d1) {
  const accountsTruth = d1.truth && d1.truth.accounts ? d1.truth.accounts : {};
  const salaryTruth = d1.truth && d1.truth.salary ? d1.truth.salary : {};
  const balancesApi = apis.find(a => a.key === 'balances');

  return [
    {
      key: 'credit_card',
      status: accountsTruth.cc_balance_source ? 'pass' : 'unknown',
      source: accountsTruth.cc_balance_source || null,
      message: accountsTruth.cc_balance_source
        ? 'Credit Card balance source proof comes from accounts table, not lifetime spend.'
        : 'Credit Card balance source proof unavailable.'
    },
    {
      key: 'balances_api',
      status: balancesApi && balancesApi.status === 'pass' ? 'pass' : 'unknown',
      source: '/api/balances?debug=1',
      message: balancesApi && balancesApi.status === 'pass'
        ? 'Balances API is reachable and returns JSON.'
        : 'Balances API not verified.'
    },
    {
      key: 'salary',
      status: salaryTruth.status || 'unknown',
      source: salaryTruth.source || null,
      message: salaryTruth.message || 'Salary source not identified.'
    },
    {
      key: 'money_contracts',
      status: 'banned',
      source: '/api/money-contracts',
      message: 'Endpoint is banned and intentionally not called.'
    }
  ];
}

function computeScores({ apis, d1, businessRules, coverage }) {
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
  const warningRules = businessRules.filter(r => r.status === 'warning').length;
  const unknownRules = businessRules.filter(r => r.status === 'unknown').length;
  const passedRules = businessRules.filter(r => r.status === 'pass').length;

  const businessRuleScore = businessRules.length
    ? Math.max(
      0,
      Math.round((passedRules / businessRules.length) * 100) -
      (blockedRules * 25) -
      (warningRules * 10) -
      (unknownRules * 6)
    )
    : 0;

  const frontendRegistry = coverage && coverage.registry && coverage.registry.modules_registered
    ? 85
    : 0;

  return {
    frontend_registry: frontendRegistry,
    api_health: apiHealth,
    d1_truth: d1Truth,
    business_rules: businessRuleScore,
    write_safety: 0,
    runtime: 0
  };
}

function computeTrialGate(verdict, hardBlockers, warnings, unknowns, scores, businessRules) {
  const blocked = hardBlockers.length > 0;
  const writeUnknown = Number(scores.write_safety) === 0;
  const runtimeUnknown = Number(scores.runtime) === 0;
  const hasWarnings = warnings.length > 0;
  const hasUnknowns = unknowns.length > 0;

  let status = verdict;
  let reason = 'Backend audit completed.';

  if (blocked) {
    status = 'blocked';
    reason = 'Hard blocker exists.';
  } else if (hasWarnings) {
    status = 'ready_with_warnings';
    reason = 'No hard blockers, but warning-level risk remains.';
  } else if (hasUnknowns || writeUnknown || runtimeUnknown) {
    status = 'ready_with_unknown';
    reason = 'Known backend checks passed, but unknowns/runtime/write safety remain.';
  } else {
    status = 'ready';
    reason = 'Known backend checks passed without blockers, warnings, or unknowns.';
  }

  return {
    status,
    ready_for_known_page_trial: !blocked,
    ready_for_full_system_certification: !blocked && !hasWarnings && !hasUnknowns && !writeUnknown && !runtimeUnknown,
    reason,
    hard_blockers: hardBlockers.length,
    warnings: warnings.length,
    unknowns: unknowns.length,
    business_rules_passed: businessRules.filter(r => r.status === 'pass').length,
    business_rules_total: businessRules.length
  };
}

function computeVerdict(hardBlockers, warnings, unknowns) {
  if (hardBlockers.length) return 'blocked';
  if (warnings.length) return 'warning';
  if (unknowns.length) return 'ready_with_unknown';
  return 'ready';
}

function buildNextActions(hardBlockers, warnings, unknowns, businessRules, d1, trialGate, enforcement) {
  const actions = [];

  hardBlockers.slice(0, 5).forEach(item => {
    actions.push(item.next_action || item.message);
  });

  if (!hardBlockers.length && enforcement && enforcement.blocked_actions && enforcement.blocked_actions.length) {
    actions.push('Display enforcement blocks in Command Centre before enabling frontend soft blocks.');
  }

  if (!hardBlockers.length && unknowns.length) {
    unknowns.slice(0, 5).forEach(item => {
      actions.push('Resolve Unknown: ' + item.message);
    });
  }

  if (!hardBlockers.length && !unknowns.length && warnings.length) {
    warnings.slice(0, 3).forEach(item => {
      actions.push('Review warning: ' + item.message);
    });
  }

  if (!actions.length && trialGate.ready_for_known_page_trial && !trialGate.ready_for_full_system_certification) {
    actions.push('Run manual browser/runtime verification for monthly-close.html and core finance pages.');
    actions.push('Add future dry-run write safety endpoint before full system certification.');
  }

  if (!actions.length) {
    actions.push('Keep Command Centre as display-only truth cockpit and update state file with current pass.');
  }

  return dedupe(actions);
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

async function firstRow(db, sql) {
  try {
    return await db.prepare(sql).first();
  } catch (e) {
    return null;
  }
}

function summarizeJsonShape(value) {
  if (!value || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length
    };
  }

  return {
    type: 'object',
    keys: Object.keys(value).slice(0, 20)
  };
}

function emptyScores() {
  return {
    frontend_registry: 0,
    api_health: 0,
    d1_truth: 0,
    business_rules: 0,
    write_safety: 0,
    runtime: 0
  };
}

function averageScore(scores) {
  const values = Object.values(scores).map(n => Number(n) || 0);
  if (!values.length) return 0;

  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
}

function ruleStatus(rules, key) {
  const found = (rules || []).find(r => r.key === key);
  return found ? found.status : 'unknown';
}

function getPath(obj, path) {
  return String(path || '').split('.').reduce((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return acc[key];
  }, obj);
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

function pickFirstColumn(columns, candidates) {
  for (const candidate of candidates) {
    if (columns.includes(candidate)) return candidate;
  }

  return null;
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
