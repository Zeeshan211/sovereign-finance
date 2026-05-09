// v0.7.0 Finance Command Centre final authority lock
//
// Contract:
// - Command Centre remains read-only.
// - transaction.save is allowed.
// - bill.preflight is allowed.
// - bill.save and bill.clear are allowed after Bills API + Bills page proof.
// - debt.save, reconciliation.declare, salary.save, forecast.generate remain blocked.
// - /api/money-contracts remains banned.
// - This is Command Centre complete enough to resume finance feature building.

const VERSION = "0.7.0";
const ENFORCEMENT_VERSION = "0.7.0";

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
  "transaction.save allowed",
  "bill.save allowed",
  "bill.clear allowed",
  "debt.save remains blocked",
  "reconciliation.declare remains blocked",
  "salary.save remains blocked",
  "forecast.generate remains blocked until source precision is proven"
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
        runtime: 0
      },
      trial_gate: {
        status: hardBlockers.length ? "blocked" : "governor_complete",
        ready_for_known_page_trial: hardBlockers.length === 0,
        ready_for_full_system_certification: false,
        reason: "Command Centre is complete enough to govern Add Transaction and Bills while keeping unproven domains blocked."
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
        enforcement_view_only_route_count: enforcement.view_only_routes.length
      },
      read_only_guards: READ_ONLY_GUARDS,
      source_proofs: buildSourceProofs(coverage, apis, pageProofs),
      coverage,
      hard_blockers: hardBlockers,
      warnings,
      unknowns,
      modules: MODULES.map(([key, label, route]) => ({ key, label, route, status: "registered" })),
      pages: MODULES.map(([key, label, route]) => ({ page: route.replace("/", ""), route, module: key, status: "registered", runtime_status: "unknown" })),
      apis,
      page_proofs: pageProofs,
      d1,
      business_rules: buildBusinessRules(coverage),
      next_actions: [
        "Command Centre governor is complete enough.",
        "Resume finance feature building with Bills cleanup first.",
        "Keep Debt, Reconciliation, Salary, and Forecast mutations blocked until each gets dry-run proof."
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
    await pageScriptProof(origin, "/bills.html", "/js/bills.js", "0.4.0", "bills_page_preflight")
  ];
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
  if (!database) return { status: "unknown", message: "D1 binding unavailable." };

  try {
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return { status: "checked", tables: tables.results || [] };
  } catch (err) {
    return { status: "unknown", error: err.message || String(err) };
  }
}

function buildCoverage(apis, pageProofs, d1) {
  const transactionsApi = apis.find(api => api.key === "transactions");
  const billsApi = apis.find(api => api.key === "bills");
  const addProof = pageProofs.find(proof => proof.key === "add_page_preflight");
  const billsProof = pageProofs.find(proof => proof.key === "bills_page_preflight");

  const transactionDryRun = transactionsApi && transactionsApi.status === "pass" && versionAtLeast(transactionsApi.version, "0.3.0");
  const addPreflight = addProof && addProof.status === "pass";
  const billsDryRun = billsApi && billsApi.status === "pass" && versionAtLeast(billsApi.version, "0.4.0");
  const billsPreflight = billsProof && billsProof.status === "pass";

  const transactionReady = transactionDryRun && addPreflight;
  const billsReady = billsDryRun && billsPreflight;

  return {
    d1,
    write_safety: {
      status: transactionReady && billsReady ? "command_centre_governor_complete" : billsPreflight ? "bills_preflight_ready" : transactionReady ? "transaction_save_ready" : "unknown",
      score: transactionReady && billsReady ? 92 : billsPreflight ? 88 : transactionReady ? 80 : 0,
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
      real_write_scope: [
        ...(transactionReady ? ["transaction.save"] : []),
        ...(billsReady ? ["bill.save", "bill.clear"] : [])
      ],
      debt_save: { allowed: false, reason: "debt.save dry-run proof does not exist yet." },
      reconciliation_declare: { allowed: false, reason: "reconciliation.declare dry-run proof does not exist yet." },
      salary_save: { allowed: false, reason: "salary.save dry-run proof does not exist yet." },
      forecast_generate: { allowed: false, reason: "forecast source precision is not complete." }
    },
    runtime: { status: "unknown", score: 0, note: "Browser runtime remains manually verified." }
  };
}

function buildEnforcement(computedAt, coverage) {
  const txReady = Boolean(coverage.write_safety.transaction_save.real_writes_allowed);
  const billsReady = Boolean(coverage.write_safety.bills.real_writes_allowed);

  const actions = [
    actionGate("transaction.preflight", "add", !txReady, txReady ? "Add preflight is available." : "Add preflight is not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete Add proof.", true, true),
    actionGate("transaction.save", "add", !txReady, txReady ? "transaction.save is allowed after Add preflight." : "transaction.save is not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete Add proof.", true, true),
    actionGate("bill.preflight", "bills", !billsReady, billsReady ? "Bills preflight is available." : "Bills preflight is not ready.", "coverage.write_safety.bills", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("bill.save", "bills", !billsReady, billsReady ? "bill.save is allowed after Bills preflight." : "bill.save is not ready.", "coverage.write_safety.bills.bill_save_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("bill.clear", "bills", !billsReady, billsReady ? "bill.clear is allowed after Bills preflight." : "bill.clear is not ready.", "coverage.write_safety.bills.bill_clear_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("debt.save", "debts", true, "debt.save remains blocked until debt dry-run exists.", "coverage.write_safety.debt_save", "Add debt.save dry-run proof.", false, true),
    actionGate("reconciliation.declare", "reconciliation", true, "reconciliation.declare remains blocked until reconciliation dry-run exists.", "coverage.write_safety.reconciliation", "Add reconciliation dry-run proof.", false, true),
    actionGate("salary.save", "salary", true, "salary.save remains blocked until salary dry-run exists.", "coverage.write_safety.salary", "Add salary dry-run proof.", false, true),
    actionGate("forecast.generate", "forecast", true, "forecast.generate remains blocked until source precision is proven.", "business_rules.forecast_precision", "Complete forecast source verification.", false, true),
    actionGate("money_contracts.use_as_truth_source", "system", true, "/api/money-contracts is banned as a finance truth source.", "source_proofs.money_contracts", "Never lift.", true, true)
  ];

  const routes = [
    routeGate("/monthly-close.html", "command_centre", "pass", true, true, "Command Centre is authority surface.", "enforcement.policy", "None."),
    routeGate("/index.html", "hub", "pass", true, true, "Hub is viewable.", "enforcement.registry.hub", "None."),
    routeGate("/add.html", "add", txReady ? "pass" : "soft_block", true, txReady, txReady ? "Add Transaction is governed and allowed." : "Add Transaction not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete transaction proof."),
    routeGate("/bills.html", "bills", billsReady ? "pass" : "soft_block", true, billsReady, billsReady ? "Bills are governed and allowed." : "Bills proof not ready.", "coverage.write_safety.bills", billsReady ? "None." : "Complete Bills proof."),
    routeGate("/debts.html", "debts", "preflight_required", true, false, "Debts viewable but writes blocked.", "coverage.write_safety.debt_save", "Add debt proof."),
    routeGate("/reconciliation.html", "reconciliation", "preflight_required", true, false, "Reconciliation viewable but declarations blocked.", "coverage.write_safety.reconciliation", "Add reconciliation proof."),
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
    global_status: "warning",
    global_level: 1,
    ready_for_known_page_trial: true,
    ready_for_full_system_certification: false,
    policy: {
      unknown_blocks_ready: true,
      transaction_save_real_write_lifted: txReady,
      bill_save_real_write_lifted: billsReady,
      bill_clear_real_write_lifted: billsReady,
      remaining_mutations_blocked: true,
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
    lift_criteria: [],
    action_proof_status: {},
    block_explanations: actions.filter(action => !action.allowed).map(action => ({
      blocked_item: action.action,
      block_type: "action_block",
      reason: action.reason,
      source: action.source,
      required_fix: action.required_fix,
      override_allowed: false,
      backend_enforced: action.backend_enforced,
      frontend_enforced: action.frontend_enforced
    })),
    reasons: actions.filter(action => !action.allowed).map(action => action.reason),
    overrides: {
      allowed: false,
      requires_reason: true,
      audit_required: true,
      note: "Overrides remain disabled."
    },
    enforcement_status_note: "Command Centre governor is complete enough: Add Transaction and Bills are governed; unproven domains remain blocked."
  };
}

function buildBusinessRules(coverage) {
  return [
    rule("add_write_path", coverage.write_safety.transaction_save.real_writes_allowed ? "pass" : "blocked", "Add write path", "transaction.save governed."),
    rule("bills_write_path", coverage.write_safety.bills.real_writes_allowed ? "pass" : "blocked", "Bills write path", "Bills governed."),
    rule("remaining_mutations_blocked", "pass", "Remaining mutations blocked", "Debts, reconciliation, salary, and forecast remain blocked."),
    rule("money_contracts_banned", "pass", "Money contracts banned", "/api/money-contracts is not used."),
    rule("forecast_precision", "unknown", "Forecast precision", "Forecast source precision not complete.")
  ];
}

function buildWarnings(coverage) {
  return [
    warning("governor_complete_not_full_finance_complete", "Command Centre governor is complete enough, but debt/reconciliation/salary/forecast writes are intentionally blocked.")
  ];
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

  if (d1.status === "blocked") blockers.push(blocker("d1_blocked", "D1 audit failed.", "Fix D1 binding/read."));

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
      source: "/api/bills version >= v0.4.0",
      details: apis.find(api => api.key === "bills") || null
    },
    {
      key: "bills_page_preflight",
      status: coverage.write_safety.bills.page_preflight_wired ? "pass" : "unknown",
      source: "/bills.html script tag /js/bills.js?v=0.4.0+",
      details: pageProofs.find(proof => proof.key === "bills_page_preflight") || null
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
  return Math.round((100 + coverage.write_safety.score + 0) / 3);
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
    actions: [actionGate("system.trial", "system", true, message, "endpoint_exception", "Fix Command Centre exception.", false, false)],
    blocked_actions: ["system.trial"],
    view_only_routes: [],
    blocked_routes: [],
    policy: { unknown_blocks_ready: true },
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
    override: { allowed: false, reason_required: true }
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
