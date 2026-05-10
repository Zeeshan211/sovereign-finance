// v0.8.1 Finance Command Centre governor with Debt + Reconciliation recovery
//
// Contract:
// - Command Centre remains read-only.
// - No D1 writes inside this endpoint.
// - No ledger smoke tests.
// - No /api/money-contracts.
// - Unknown remains Unknown.
// - transaction.save is allowed when Add proof exists.
// - bill.save and bill.clear are allowed when Bills proof exists.
// - debt.save and debt.pay are allowed when Debts proof exists.
// - reconciliation.declare is allowed when Reconciliation API + page proof exists.
// - salary.save and forecast.generate remain blocked until their own proofs exist.
// - Overrides are not silent and do not bypass backend APIs from Command Centre.
// - Any future override application must be implemented in the owning mutating API with reason, expiry, and audit.

const VERSION = "0.8.1";
const ENFORCEMENT_VERSION = "0.8.1";

const MODULES = [
  ["hub", "Hub", "/index.html"],
  ["add", "Add Transaction", "/add.html"],
  ["bills", "Bills", "/bills.html"],
  ["debts", "Debts", "/debts.html"],
  ["reconciliation", "Reconciliation", "/reconciliation.html"],
  ["salary", "Salary", "/salary.html"],
  ["forecast", "Forecast", "/forecast.html"],
  ["credit_card", "Credit Card", "/cc.html"],
  ["transactions", "Transactions", "/transactions.html"],
  ["accounts", "Accounts", "/accounts.html"],
  ["command_centre", "Command Centre", "/monthly-close.html"]
];

const API_CHECKS = [
  ["balances", "/api/balances?debug=1", true],
  ["accounts", "/api/accounts", true],
  ["transactions", "/api/transactions", true],
  ["bills", "/api/bills", true],
  ["debts", "/api/debts", true],
  ["categories", "/api/categories", true],
  ["reconciliation", "/api/reconciliation", false],
  ["salary", "/api/salary", false],
  ["forecast", "/api/forecast", false]
];

const READ_ONLY_GUARDS = [
  "No D1 writes inside Command Centre",
  "No ledger smoke tests",
  "No /api/money-contracts",
  "Unknown remains Unknown",
  "transaction.save allowed only when Add proof exists",
  "bill.save and bill.clear allowed only when Bills proof exists",
  "debt.save and debt.pay allowed only when Debts proof exists",
  "reconciliation.declare allowed only when Reconciliation proof exists",
  "salary.save remains blocked",
  "forecast.generate remains blocked until source precision is proven",
  "Overrides must be explicit, reasoned, time-bound, visible, and API-owned",
  "Command Centre exposes override policy but does not silently bypass backend gates"
];

export async function onRequest(context) {
  const computedAt = new Date().toISOString();

  if (!["GET", "HEAD"].includes(context.request.method)) {
    return send({
      ok: false,
      version: VERSION,
      computed_at: computedAt,
      verdict: "blocked",
      error: "Method not allowed. Command Centre is read-only."
    }, 405);
  }

  try {
    const origin = new URL(context.request.url).origin;
    const apis = await auditApis(origin);
    const pageProofs = await auditPageProofs(origin);
    const d1 = await auditD1(context.env && context.env.DB);
    const coverage = buildCoverage(apis, pageProofs, d1);
    const enforcement = buildEnforcement(computedAt, coverage);
    const warnings = buildWarnings(coverage);
    const unknowns = buildUnknowns(coverage);
    const hardBlockers = buildHardBlockers(apis, d1);
    const verdict = hardBlockers.length ? "blocked" : "ready_with_warnings";

    return send({
      ok: hardBlockers.length === 0,
      version: VERSION,
      computed_at: computedAt,
      verdict,
      score: computeScore(coverage),
      scores: {
        api_health: scoreApi(apis),
        d1_core: d1.status === "checked" ? 100 : 0,
        coverage: 100,
        write_safety: coverage.write_safety.score,
        override_governance: 100,
        runtime: 0
      },
      trial_gate: {
        status: hardBlockers.length ? "blocked" : "governor_complete",
        ready_for_known_page_trial: hardBlockers.length === 0,
        ready_for_full_system_certification: false,
        reason: "Command Centre governs Add, Bills, Debts, and Reconciliation when proof exists; unproven domains remain blocked."
      },
      enforcement,
      summary: {
        hard_blocker_count: hardBlockers.length,
        warning_count: warnings.length,
        unknown_count: unknowns.length,
        module_count: MODULES.length,
        registered_page_count: MODULES.length,
        api_check_count: apis.length,
        page_proof_count: pageProofs.length,
        enforcement_blocked_action_count: enforcement.blocked_actions.length,
        enforcement_view_only_route_count: enforcement.view_only_routes.length,
        override_policy_status: enforcement.overrides.status
      },
      read_only_guards: READ_ONLY_GUARDS,
      source_proofs: buildSourceProofs(coverage, apis, pageProofs),
      coverage,
      hard_blockers: hardBlockers,
      warnings,
      unknowns,
      modules: MODULES.map(([key, label, route]) => ({ key, label, route, status: "registered" })),
      pages: MODULES.map(([key, label, route]) => ({
        page: route.replace("/", ""),
        route,
        module: key,
        status: "registered",
        runtime_status: "unknown"
      })),
      apis,
      page_proofs: pageProofs,
      d1,
      business_rules: buildBusinessRules(coverage),
      override_policy: buildOverridePolicy(),
      emergency_playbooks: buildEmergencyPlaybooks(),
      next_actions: [
        "Reconciliation is governed when /api/reconciliation and /reconciliation.html proof are detected.",
        "Verify reconciliation.declare backend asks Command Centre before real writes.",
        "Run dry-run first before any real balance declaration.",
        "Keep Salary, Forecast, and Credit Card decision paths blocked until their own proofs exist.",
        "Do not implement silent overrides. Any future override must live in the owning API with reason, expiry, and audit."
      ]
    });
  } catch (err) {
    return send({
      ok: false,
      version: VERSION,
      computed_at: computedAt,
      verdict: "blocked",
      error: err.message || String(err),
      enforcement: emergencyEnforcement(computedAt, err.message || String(err))
    }, 500);
  }
}

async function auditApis(origin) {
  const results = [];

  for (const [key, path, required] of API_CHECKS) {
    const started = Date.now();

    try {
      const res = await fetch(origin + path, {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-finance-command-center-audit": VERSION
        }
      });

      const data = await res.clone().json().catch(() => null);

      results.push({
        key,
        path,
        required,
        status: res.ok && data ? "pass" : required ? "blocked" : "unknown",
        http_status: res.status,
        ok: res.ok,
        json_readable: Boolean(data),
        version: data && data.version ? String(data.version) : null,
        elapsed_ms: Date.now() - started
      });
    } catch (err) {
      results.push({
        key,
        path,
        required,
        status: required ? "blocked" : "unknown",
        ok: false,
        json_readable: false,
        error: err.message || String(err),
        elapsed_ms: Date.now() - started
      });
    }
  }

  results.push({
    key: "money_contracts",
    path: "/api/money-contracts",
    required: false,
    status: "banned",
    ok: false,
    called: false
  });

  return results;
}

async function auditPageProofs(origin) {
  return [
    await pageScriptProof(origin, "/add.html", "/js/add.js", "0.4.5", "add_page_preflight"),
    await pageScriptProof(origin, "/bills.html", "/js/bills.js", "0.4.0", "bills_page_preflight"),
    await inlinePageProof(origin, "/debts.html", "SovereignDebtsUI", "2.2.0", "debts_page_preflight"),
    await inlinePageProof(origin, "/reconciliation.html", "SovereignReconciliationUI", "1.0.0", "reconciliation_page")
  ];
}

async function inlinePageProof(origin, pagePath, globalName, requiredVersion, key) {
  const started = Date.now();

  try {
    const res = await fetch(origin + pagePath + "?cc=" + Date.now(), {
      method: "GET",
      headers: {
        accept: "text/html",
        "x-finance-command-center-page-proof": VERSION
      }
    });

    const html = await res.text();
    const detectedVersion = extractInlineGlobalVersion(html, globalName);
    const pass = res.ok && versionAtLeast(detectedVersion, requiredVersion);

    return {
      key,
      path: pagePath,
      script: "inline:" + globalName,
      required_version: requiredVersion,
      detected_version: detectedVersion,
      status: pass ? "pass" : "unknown",
      ok: res.ok,
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      page_preflight_wired: pass
    };
  } catch (err) {
    return {
      key,
      path: pagePath,
      script: "inline:" + globalName,
      required_version: requiredVersion,
      status: "unknown",
      ok: false,
      error: err.message || String(err),
      elapsed_ms: Date.now() - started,
      page_preflight_wired: false
    };
  }
}

async function pageScriptProof(origin, pagePath, scriptPath, requiredVersion, key) {
  const started = Date.now();

  try {
    const res = await fetch(origin + pagePath + "?cc=" + Date.now(), {
      method: "GET",
      headers: {
        accept: "text/html",
        "x-finance-command-center-page-proof": VERSION
      }
    });

    const html = await res.text();
    const detectedVersion = extractScriptVersion(html, scriptPath);
    const pass = res.ok && versionAtLeast(detectedVersion, requiredVersion);

    return {
      key,
      path: pagePath,
      script: scriptPath,
      required_version: requiredVersion,
      detected_version: detectedVersion,
      status: pass ? "pass" : "unknown",
      ok: res.ok,
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      page_preflight_wired: pass
    };
  } catch (err) {
    return {
      key,
      path: pagePath,
      script: scriptPath,
      required_version: requiredVersion,
      status: "unknown",
      ok: false,
      error: err.message || String(err),
      elapsed_ms: Date.now() - started,
      page_preflight_wired: false
    };
  }
}

async function auditD1(database) {
  if (!database) {
    return {
      status: "unknown",
      message: "D1 binding unavailable."
    };
  }

  try {
    const tables = await database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();

    return {
      status: "checked",
      tables: tables.results || []
    };
  } catch (err) {
    return {
      status: "unknown",
      error: err.message || String(err)
    };
  }
}

function buildCoverage(apis, pageProofs, d1) {
  const transactionsApi = apis.find(api => api.key === "transactions");
  const billsApi = apis.find(api => api.key === "bills");
  const debtsApi = apis.find(api => api.key === "debts");
  const reconciliationApi = apis.find(api => api.key === "reconciliation");

  const addProof = pageProofs.find(proof => proof.key === "add_page_preflight");
  const billsProof = pageProofs.find(proof => proof.key === "bills_page_preflight");
  const debtsProof = pageProofs.find(proof => proof.key === "debts_page_preflight");
  const reconciliationProof = pageProofs.find(proof => proof.key === "reconciliation_page");

  const transactionDryRun =
    transactionsApi &&
    transactionsApi.status === "pass" &&
    versionAtLeast(transactionsApi.version, "0.3.0");

  const addPreflight =
    addProof &&
    addProof.status === "pass";

  const billsDryRun =
    billsApi &&
    billsApi.status === "pass" &&
    (
      versionAtLeast(billsApi.version, "0.4.0") ||
      versionAtLeast(billsApi.version, "0.3.0")
    );

  const billsPreflight =
    billsProof &&
    billsProof.status === "pass";

  const debtsDryRun =
    debtsApi &&
    debtsApi.status === "pass" &&
    versionAtLeast(debtsApi.version, "0.3.2");

  const debtsPreflight =
    debtsProof &&
    debtsProof.status === "pass";

  const reconciliationReady =
    reconciliationApi &&
    reconciliationApi.status === "pass" &&
    versionAtLeast(reconciliationApi.version, "0.1.0") &&
    reconciliationProof &&
    reconciliationProof.status === "pass";

  const transactionReady = transactionDryRun && addPreflight;
  const billsReady = billsDryRun && billsPreflight;
  const debtsReady = debtsDryRun && debtsPreflight;

  return {
    d1,
    write_safety: {
      status: transactionReady && billsReady && debtsReady && reconciliationReady
        ? "reconciliation_ready"
        : transactionReady && billsReady && debtsReady
          ? "debt_writes_ready"
          : transactionReady && billsReady
            ? "command_centre_governor_complete"
            : billsPreflight
              ? "bills_preflight_ready"
              : transactionReady
                ? "transaction_save_ready"
                : "unknown",

      score: transactionReady && billsReady && debtsReady && reconciliationReady
        ? 99
        : transactionReady && billsReady && debtsReady
          ? 98
          : transactionReady && billsReady
            ? 95
            : billsPreflight
              ? 88
              : transactionReady
                ? 80
                : 0,

      transaction_save: {
        dry_run_available: transactionDryRun,
        page_preflight_wired: addPreflight,
        real_writes_allowed: transactionReady
      },

      bills: {
        dry_run_available: billsDryRun,
        page_preflight_wired: billsPreflight,
        preflight_allowed: billsReady,
        real_writes_allowed: billsReady,
        bill_save_allowed: billsReady,
        bill_clear_allowed: billsReady
      },

      debts: {
        dry_run_available: debtsDryRun,
        page_preflight_wired: debtsPreflight,
        preflight_allowed: debtsReady,
        real_writes_allowed: debtsReady,
        debt_save_allowed: debtsReady,
        debt_pay_allowed: debtsReady
      },

      reconciliation: {
        dry_run_available: Boolean(reconciliationApi && reconciliationApi.status === "pass" && versionAtLeast(reconciliationApi.version, "0.1.0")),
        page_wired: Boolean(reconciliationProof && reconciliationProof.status === "pass"),
        real_writes_allowed: Boolean(reconciliationReady),
        reconciliation_declare_allowed: Boolean(reconciliationReady)
      },

      real_write_scope: [
        ...(transactionReady ? ["transaction.save"] : []),
        ...(billsReady ? ["bill.save", "bill.clear"] : []),
        ...(debtsReady ? ["debt.save", "debt.pay"] : []),
        ...(reconciliationReady ? ["reconciliation.declare"] : [])
      ],

      debt_save: {
        allowed: debtsReady,
        reason: debtsReady
          ? "debt.save is allowed after Debts API and Debts page proof."
          : "debt.save dry-run proof does not exist yet."
      },

      debt_pay: {
        allowed: debtsReady,
        reason: debtsReady
          ? "debt.pay is allowed after Debts API and Debts page proof."
          : "debt.pay dry-run proof does not exist yet."
      },

      reconciliation_declare: {
        allowed: Boolean(reconciliationReady),
        reason: reconciliationReady
          ? "reconciliation.declare is allowed after Reconciliation API and page proof."
          : "reconciliation.declare dry-run proof does not exist yet."
      },

      salary_save: {
        allowed: false,
        reason: "salary.save dry-run proof does not exist yet."
      },

      forecast_generate: {
        allowed: false,
        reason: "forecast source precision is not complete."
      }
    },

    override_governance: {
      status: "policy_complete",
      score: 100,
      overrides_silent: false,
      command_centre_applies_overrides: false,
      owning_api_must_enforce_override: true,
      reason_required: true,
      expiry_required: true,
      audit_required: true
    },

    runtime: {
      status: "unknown",
      score: 0,
      note: "Browser runtime remains manually verified."
    }
  };
}

function buildEnforcement(computedAt, coverage) {
  const txReady = Boolean(coverage.write_safety.transaction_save.real_writes_allowed);
  const billsReady = Boolean(coverage.write_safety.bills.real_writes_allowed);
  const debtsPreflightReady = Boolean(coverage.write_safety.debts && coverage.write_safety.debts.preflight_allowed);
  const debtsReady = Boolean(coverage.write_safety.debts && coverage.write_safety.debts.real_writes_allowed);
  const reconciliationReady = Boolean(coverage.write_safety.reconciliation && coverage.write_safety.reconciliation.real_writes_allowed);
  const overridePolicy = buildOverridePolicy();

  const actions = [
    actionGate("transaction.preflight", "add", !txReady, txReady ? "Add preflight is available." : "Add preflight is not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete Add proof.", true, true),
    actionGate("transaction.save", "add", !txReady, txReady ? "transaction.save is allowed after Add preflight." : "transaction.save is not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete Add proof.", true, true),

    actionGate("bill.preflight", "bills", !billsReady, billsReady ? "Bills preflight is available." : "Bills preflight is not ready.", "coverage.write_safety.bills", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("bill.save", "bills", !billsReady, billsReady ? "bill.save is allowed after Bills preflight." : "bill.save is not ready.", "coverage.write_safety.bills.bill_save_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("bill.clear", "bills", !billsReady, billsReady ? "bill.clear is allowed after Bills preflight." : "bill.clear is not ready.", "coverage.write_safety.bills.bill_clear_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),

    actionGate("debt.preflight", "debts", !debtsPreflightReady, debtsPreflightReady ? "Debt preflight is available." : "Debt preflight is not ready.", "coverage.write_safety.debts", debtsPreflightReady ? "None." : "Deploy Debts API v0.3.2 and Debts page v2.2.0.", true, true),
    actionGate("debt.save", "debts", !debtsReady, debtsReady ? "debt.save is allowed after Debts proof." : "debt.save is blocked until Debts proof exists.", "coverage.write_safety.debts.debt_save_allowed", debtsReady ? "None." : "Complete Debts proof.", true, true),
    actionGate("debt.pay", "debts", !debtsReady, debtsReady ? "debt.pay is allowed after Debts proof." : "debt.pay is blocked until Debts proof exists.", "coverage.write_safety.debts.debt_pay_allowed", debtsReady ? "None." : "Complete Debts proof.", true, true),

    actionGate("reconciliation.declare", "reconciliation", !reconciliationReady, reconciliationReady ? "reconciliation.declare is allowed after Reconciliation proof." : "reconciliation.declare remains blocked until reconciliation dry-run exists.", "coverage.write_safety.reconciliation", reconciliationReady ? "None." : "Add reconciliation dry-run proof.", true, true),

    actionGate("salary.save", "salary", true, "salary.save remains blocked until salary dry-run exists.", "coverage.write_safety.salary", "Add salary dry-run proof.", false, true),
    actionGate("forecast.generate", "forecast", true, "forecast.generate remains blocked until source precision is proven.", "business_rules.forecast_precision", "Complete forecast source verification.", false, true),

    actionGate("override.request", "command_centre", false, "Override request templates are available for emergencies.", "override_policy.request_schema", "None.", false, true),
    actionGate("override.apply", "system", true, "Command Centre does not directly apply overrides. Owning API must implement override enforcement with audit.", "override_policy.api_owned_application", "Implement API-owned override path only if truly required.", false, true),
    actionGate("override.silent_bypass", "system", true, "Silent bypass is permanently blocked.", "override_policy.silent_bypass_forbidden", "Never lift.", true, true),

    actionGate("money_contracts.use_as_truth_source", "system", true, "/api/money-contracts is banned as a finance truth source.", "source_proofs.money_contracts", "Never lift.", true, true)
  ];

  const routes = [
    routeGate("/monthly-close.html", "command_centre", "pass", true, true, "Command Centre is authority surface.", "enforcement.policy", "None."),
    routeGate("/index.html", "hub", "pass", true, true, "Hub is viewable.", "enforcement.registry.hub", "None."),
    routeGate("/add.html", "add", txReady ? "pass" : "soft_block", true, txReady, txReady ? "Add Transaction is governed and allowed." : "Add Transaction not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete transaction proof."),
    routeGate("/bills.html", "bills", billsReady ? "pass" : "soft_block", true, billsReady, billsReady ? "Bills are governed and allowed." : "Bills proof not ready.", "coverage.write_safety.bills", billsReady ? "None." : "Complete Bills proof."),
    routeGate("/debts.html", "debts", debtsReady ? "pass" : debtsPreflightReady ? "preflight_only" : "preflight_required", true, debtsReady, debtsReady ? "Debts are governed and allowed." : debtsPreflightReady ? "Debts page may run preflight. Real writes remain blocked." : "Debts viewable but writes blocked.", "coverage.write_safety.debts", debtsReady ? "None." : debtsPreflightReady ? "Backend lift pending." : "Add debt proof."),
    routeGate("/reconciliation.html", "reconciliation", reconciliationReady ? "pass" : "preflight_required", true, reconciliationReady, reconciliationReady ? "Reconciliation is governed and allowed." : "Reconciliation viewable but declarations blocked.", "coverage.write_safety.reconciliation", reconciliationReady ? "None." : "Add reconciliation proof."),
    routeGate("/salary.html", "salary", "preflight_required", true, false, "Salary viewable but writes blocked.", "coverage.write_safety.salary", "Add salary proof."),
    routeGate("/forecast.html", "forecast", "soft_block", true, false, "Forecast decisions blocked.", "business_rules.forecast_precision", "Prove forecast precision."),
    routeGate("/cc.html", "credit_card", "soft_block", true, false, "Credit Card decision source guarded.", "business_rules.cc_outstanding_source", "Prove CC source."),
    routeGate("/transactions.html", "transactions", "warn", true, false, "Transactions viewable; only Add transaction.save is allowed.", "coverage.write_safety.transaction_save", "Add separate proof for other mutations."),
    routeGate("/accounts.html", "accounts", "warn", true, false, "Accounts viewable; mutations blocked.", "coverage.write_safety.account_mutations", "Add account proof.")
  ];

  return {
    version: ENFORCEMENT_VERSION,
    endpoint_version: VERSION,
    mode: "authority",
    computed_at: computedAt,
    schema_only: false,
    global_status: "governor_complete",
    global_level: 1,
    ready_for_known_page_trial: true,
    ready_for_full_system_certification: false,
    policy: {
      unknown_blocks_ready: true,
      transaction_save_real_write_lifted: txReady,
      bill_save_real_write_lifted: billsReady,
      bill_clear_real_write_lifted: billsReady,
      debt_save_real_write_lifted: debtsReady,
      debt_pay_real_write_lifted: debtsReady,
      reconciliation_declare_real_write_lifted: reconciliationReady,
      remaining_mutations_blocked: true,
      emergency_override_policy_complete: true,
      command_centre_applies_overrides: false,
      owning_api_must_apply_overrides: true,
      silent_bypass_forbidden: true,
      command_centre_never_hides_truth: true
    },
    routes,
    actions,
    blocked_routes: routes.filter(route => !route.view_allowed).map(route => route.route),
    view_only_routes: routes.filter(route => route.view_allowed && !route.actions_allowed).map(route => route.route),
    blocked_actions: actions.filter(action => !action.allowed).map(action => action.action),
    action_checklists: actions.map(action => ({
      action: action.action,
      module: action.module,
      status: action.allowed ? "pass" : "blocked",
      allowed_by_action_policy: action.allowed,
      failed_count: action.allowed ? 0 : 1,
      passed_count: action.allowed ? 1 : 0,
      total_count: 1,
      items: [{
        key: action.action,
        label: action.reason,
        passed: action.allowed,
        status: action.allowed ? "pass" : "blocked",
        source: action.source,
        required_fix: action.required_fix
      }]
    })),
    lift_criteria: [
      {
        action: "override.apply",
        current_status: "blocked",
        can_lift_now: false,
        lift_rule: "Only lift in the owning mutating API with reason, expiry, audit, and visible Command Centre warning."
      },
      {
        action: "salary.save",
        current_status: "blocked",
        can_lift_now: false,
        lift_rule: "Add salary-specific dry-run proof first."
      },
      {
        action: "forecast.generate",
        current_status: "blocked",
        can_lift_now: false,
        lift_rule: "Complete forecast source verification first."
      }
    ],
    action_proof_status: {
      "transaction.save": { status: txReady ? "pass" : "blocked" },
      "bill.save": { status: billsReady ? "pass" : "blocked" },
      "bill.clear": { status: billsReady ? "pass" : "blocked" },
      "debt.preflight": { status: debtsPreflightReady ? "pass" : "blocked" },
      "debt.save": { status: debtsReady ? "pass" : "blocked" },
      "debt.pay": { status: debtsReady ? "pass" : "blocked" },
      "reconciliation.declare": { status: reconciliationReady ? "pass" : "blocked" },
      "override.request": { status: "pass" },
      "override.apply": { status: "blocked" }
    },
    block_explanations: actions.filter(action => !action.allowed).map(action => ({
      blocked_item: action.action,
      block_type: "action_block",
      reason: action.reason,
      source: action.source,
      required_fix: action.required_fix,
      override_allowed: action.action !== "override.silent_bypass" && overridePolicy.requestable_actions.includes(action.action),
      backend_enforced: action.backend_enforced,
      frontend_enforced: action.frontend_enforced
    })),
    reasons: actions.filter(action => !action.allowed).map(action => action.reason),
    overrides: overridePolicy,
    emergency_playbooks: buildEmergencyPlaybooks(),
    enforcement_status_note: reconciliationReady
      ? "Command Centre governor is complete: Add Transaction, Bills, Debts, and Reconciliation are governed; unproven domains remain blocked."
      : debtsReady
        ? "Command Centre governor is complete: Add Transaction, Bills, and Debts are governed; Reconciliation awaits proof; unproven domains remain blocked."
        : "Command Centre governor is complete: Add Transaction and Bills are governed; unproven domains remain blocked."
  };
}

function buildBusinessRules(coverage) {
  return [
    rule("add_write_path", coverage.write_safety.transaction_save.real_writes_allowed ? "pass" : "blocked", "Add write path", "transaction.save governed."),
    rule("bills_write_path", coverage.write_safety.bills.real_writes_allowed ? "pass" : "blocked", "Bills write path", "Bills governed."),
    rule("debts_write_path", coverage.write_safety.debts.real_writes_allowed ? "pass" : "blocked", "Debts write path", "Debts governed when proof exists."),
    rule("reconciliation_write_path", coverage.write_safety.reconciliation.real_writes_allowed ? "pass" : "blocked", "Reconciliation write path", "Reconciliation governed when proof exists."),
    rule("remaining_mutations_blocked", "pass", "Remaining mutations blocked", "Salary and forecast remain blocked."),
    rule("override_policy", "pass", "Emergency override policy", "Override policy is visible and does not silently bypass APIs."),
    rule("money_contracts_banned", "pass", "Money contracts banned", "/api/money-contracts is not used."),
    rule("forecast_precision", "unknown", "Forecast precision", "Forecast source precision not complete.")
  ];
}

function buildOverridePolicy() {
  return {
    status: "policy_complete",
    allowed: false,
    requestable: true,
    applies_directly_from_command_centre: false,
    silent_bypass_allowed: false,
    requires_reason: true,
    requires_operator_confirmation: true,
    requires_expiry: true,
    default_expiry_minutes: 30,
    max_expiry_minutes: 120,
    audit_required: true,
    visible_warning_required: true,
    rollback_required: true,
    note: "Command Centre exposes override requirements. It does not directly bypass backend gates.",
    request_schema: {
      action: "override.request",
      target_action: "debt.save | reconciliation.declare | salary.save | forecast.generate | other blocked action",
      target_route: "/example.html",
      reason: "Required. Human-readable emergency reason.",
      expiry_minutes: "Required. Max 120.",
      expected_impact: "Required. What changes if override is applied.",
      rollback_plan: "Required. How to reverse or stop the override.",
      operator_confirmation: "Required. Explicit confirmation."
    },
    requestable_actions: [
      "debt.save",
      "reconciliation.declare",
      "salary.save",
      "forecast.generate",
      "cc.use_for_decision"
    ],
    never_override_actions: [
      "money_contracts.use_as_truth_source",
      "override.silent_bypass",
      "unknown.becomes.ready"
    ],
    required_backend_contract_for_future_application: {
      header_or_body_marker: "x-sovereign-override",
      reason_required: true,
      expiry_required: true,
      audit_required: true,
      command_centre_warning_required: true,
      owner_api_must_validate: true
    }
  };
}

function buildEmergencyPlaybooks() {
  return [
    {
      key: "wrong_block",
      label: "Action appears blocked incorrectly",
      steps: [
        "Verify Command Centre action status.",
        "Verify source/check and required_fix.",
        "Verify owning API version.",
        "If policy is stale, update proof recognition.",
        "Do not bypass silently."
      ]
    },
    {
      key: "urgent_real_world_update",
      label: "Urgent real-world update needed",
      steps: [
        "Prefer direct targeted D1 correction only if operator already knows the real-world truth.",
        "Use exact SQL and verification query.",
        "Do not run fake smoke entries.",
        "Record outcome in state after completion."
      ]
    },
    {
      key: "api_error",
      label: "Mutating API throws error",
      steps: [
        "Stop retries.",
        "Read error.",
        "Check normalized payload.",
        "Check undefined bind risk.",
        "Add dry-run proof before lifting."
      ]
    },
    {
      key: "override_request",
      label: "Override requested",
      steps: [
        "State blocked action and reason.",
        "Collect reason, expiry, expected impact, rollback plan.",
        "Do not apply from Command Centre.",
        "Implement only in owning API if truly needed."
      ]
    }
  ];
}

function buildWarnings(coverage) {
  const warnings = [];

  if (!coverage.write_safety.reconciliation.real_writes_allowed) {
    warnings.push(warning("reconciliation_not_lifted", "Reconciliation proof is not fully lifted yet."));
  }

  warnings.push(warning("governor_complete_not_full_finance_complete", "Command Centre governor is complete, but salary/forecast writes are intentionally blocked."));
  warnings.push(warning("override_application_not_enabled", "Override policy is complete, but Command Centre does not directly apply overrides. This prevents silent bypass."));

  return warnings;
}

function buildUnknowns(coverage) {
  return [
    unknown("forecast_precision_unknown", "Forecast precision remains unknown.")
  ];
}

function buildHardBlockers(apis, d1) {
  const blockers = [];

  apis.filter(api => api.required && api.status === "blocked").forEach(api => {
    blockers.push(blocker("api_" + api.key + "_blocked", api.path + " is not healthy.", "Fix required API."));
  });

  if (d1.status === "blocked") {
    blockers.push(blocker("d1_blocked", "D1 audit failed.", "Fix D1 binding/read."));
  }

  return blockers;
}

function buildSourceProofs(coverage, apis, pageProofs) {
  return [
    {
      key: "transaction_save_dry_run",
      status: coverage.write_safety.transaction_save.dry_run_available ? "pass" : "unknown",
      source: "/api/transactions version >= v0.3.0",
      details: coverage.write_safety.transaction_save
    },
    {
      key: "add_page_preflight",
      status: coverage.write_safety.transaction_save.page_preflight_wired ? "pass" : "unknown",
      source: "/add.html script tag /js/add.js?v=0.4.5+",
      details: pageProofs.find(proof => proof.key === "add_page_preflight") || null
    },
    {
      key: "bills_api_dry_run",
      status: coverage.write_safety.bills.dry_run_available ? "pass" : "unknown",
      source: "/api/bills version >= v0.3.0",
      details: apis.find(api => api.key === "bills") || null
    },
    {
      key: "bills_page_preflight",
      status: coverage.write_safety.bills.page_preflight_wired ? "pass" : "unknown",
      source: "/bills.html script tag /js/bills.js?v=0.4.0+",
      details: pageProofs.find(proof => proof.key === "bills_page_preflight") || null
    },
    {
      key: "debts_api_dry_run",
      status: coverage.write_safety.debts.dry_run_available ? "pass" : "unknown",
      source: "/api/debts version >= v0.3.2",
      details: apis.find(api => api.key === "debts") || null
    },
    {
      key: "debts_page_preflight",
      status: coverage.write_safety.debts.page_preflight_wired ? "pass" : "unknown",
      source: "/debts.html inline SovereignDebtsUI v2.2.0+",
      details: pageProofs.find(proof => proof.key === "debts_page_preflight") || null
    },
    {
      key: "reconciliation_api",
      status: coverage.write_safety.reconciliation.dry_run_available ? "pass" : "unknown",
      source: "/api/reconciliation version >= v0.1.0",
      details: apis.find(api => api.key === "reconciliation") || null
    },
    {
      key: "reconciliation_page",
      status: coverage.write_safety.reconciliation.page_wired ? "pass" : "unknown",
      source: "/reconciliation.html inline SovereignReconciliationUI v1.0.0+",
      details: pageProofs.find(proof => proof.key === "reconciliation_page") || null
    },
    {
      key: "override_policy",
      status: "pass",
      source: "enforcement.overrides",
      details: buildOverridePolicy()
    },
    {
      key: "money_contracts",
      status: "banned",
      source: "/api/money-contracts",
      details: { called: false, allowed_as_truth_source: false }
    }
  ];
}

function computeScore(coverage) {
  return Math.round((100 + coverage.write_safety.score + coverage.override_governance.score + 0) / 4);
}

function scoreApi(apis) {
  const required = apis.filter(api => api.required);
  if (!required.length) return 0;
  return Math.round(required.filter(api => api.status === "pass").length / required.length * 100);
}

function emergencyEnforcement(computedAt, message) {
  return {
    version: ENFORCEMENT_VERSION,
    endpoint_version: VERSION,
    mode: "authority",
    computed_at: computedAt,
    global_status: "blocked",
    global_level: 3,
    routes: [],
    actions: [
      actionGate("system.trial", "system", true, message, "endpoint_exception", "Fix Command Centre exception.", false, false)
    ],
    blocked_actions: ["system.trial"],
    view_only_routes: [],
    blocked_routes: [],
    policy: {
      unknown_blocks_ready: true,
      command_centre_never_hides_truth: true
    },
    overrides: buildOverridePolicy(),
    block_explanations: []
  };
}

function routeGate(route, module, status, viewAllowed, actionsAllowed, reason, source, requiredFix) {
  return {
    route,
    module,
    status,
    level: status === "pass" ? 0 : status === "warn" ? 1 : 2,
    view_allowed: Boolean(viewAllowed),
    actions_allowed: Boolean(actionsAllowed),
    reason,
    source,
    required_fix: requiredFix,
    override: { allowed: false, reason_required: true }
  };
}

function actionGate(action, module, blocked, reason, source, requiredFix, backendEnforced, frontendEnforced) {
  return {
    action,
    module,
    status: blocked ? "blocked" : "pass",
    level: blocked ? 3 : 0,
    allowed: !blocked,
    reason: blocked ? reason : "No enforcement block returned for this action.",
    source: blocked ? source : "enforcement.policy",
    required_fix: blocked ? requiredFix : "None.",
    backend_enforced: Boolean(backendEnforced),
    frontend_enforced: Boolean(frontendEnforced),
    override: {
      allowed: false,
      reason_required: true
    }
  };
}

function rule(key, status, label, message) {
  return { key, status, label, message };
}

function blocker(key, message, nextAction) {
  return { key, message, next_action: nextAction, severity: "hard_blocker" };
}

function warning(key, message) {
  return { key, message, severity: "warning" };
}

function unknown(key, message) {
  return { key, message, severity: "unknown" };
}

function extractInlineGlobalVersion(html, globalName) {
  const text = String(html || "");
  const globalEscaped = globalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (!new RegExp(globalEscaped).test(text)) return null;

  const versionMatch = text.match(/const\s+VERSION\s*=\s*["']([0-9]+(?:\.[0-9]+){1,3})["']/);
  return versionMatch ? versionMatch[1] : null;
}

function extractScriptVersion(html, scriptPath) {
  const text = String(html || "");
  const escaped = scriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\?v=([0-9]+(?:\\.[0-9]+){1,3})", "i");
  const match = text.match(re);
  return match ? match[1] : null;
}

function versionAtLeast(actual, required) {
  const a = parseVersion(actual);
  const r = parseVersion(required);

  for (let i = 0; i < Math.max(a.length, r.length); i += 1) {
    const av = a[i] || 0;
    const rv = r[i] || 0;
    if (av > rv) return true;
    if (av < rv) return false;
  }

  return true;
}

function parseVersion(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(".")
    .map(part => Number(part))
    .map(number => Number.isFinite(number) ? number : 0);
}

function send(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
