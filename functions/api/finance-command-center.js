const VERSION = "0.8.3-add-proof-inline";
const ENFORCEMENT_VERSION = "0.8.3";

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
  "Normal pages stay clean; Command Centre handles proof/audit language",
  "transaction.save allowed only when Transactions API and Add page proof exist",
  "bill.save and bill.pay allowed only when Bills API and Bills page proof exist",
  "debt.save and debt.pay allowed only when Debts API and Debts page proof exist",
  "Overrides must be explicit, reasoned, time-bound, visible, and API-owned",
  "Silent bypass is permanently blocked"
];

export async function onRequest(context) {
  const computedAt = new Date().toISOString();

  if (!["GET", "HEAD"].includes(context.request.method)) {
    return json({
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

    const hardBlockers = buildHardBlockers(apis, d1);
    const warnings = buildWarnings(coverage);

    return json({
      ok: hardBlockers.length === 0,
      version: VERSION,
      computed_at: computedAt,
      verdict: hardBlockers.length ? "blocked" : "ready_with_warnings",
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
        reason: "Command Centre governs recovered domains when proof exists."
      },

      enforcement,

      summary: {
        hard_blocker_count: hardBlockers.length,
        warning_count: warnings.length,
        unknown_count: 0,
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
      unknowns: [],

      modules: MODULES.map(([key, label, route]) => ({
        key,
        label,
        route,
        status: "registered"
      })),

      pages: MODULES.map(([key, label, route]) => ({
        page: route.replace("/", ""),
        route,
        module: key,
        label,
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
        "Verify Add Transaction with a tiny expense after transaction.save is allowed.",
        "Keep normal pages free of Command Centre/audit wording.",
        "Update finance docs after live behavior is verified.",
        "Do not implement silent overrides."
      ]
    });
  } catch (err) {
    return json({
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
    await customPageProof(origin, "/add.html", "add_page_preflight", detectAddPageProof),
    await customPageProof(origin, "/bills.html", "bills_page_preflight", detectBillsPageProof),
    await customPageProof(origin, "/debts.html", "debts_page_preflight", detectDebtsPageProof),
    await inlinePageProof(origin, "/reconciliation.html", "SovereignReconciliationUI", "1.0.0", "reconciliation_page"),
    await inlinePageProof(origin, "/salary.html", "SovereignSalaryUI", "1.0.0", "salary_page"),
    await inlinePageProof(origin, "/forecast.html", "SovereignForecastUI", "1.0.0", "forecast_page")
  ];
}

async function customPageProof(origin, pagePath, key, detector) {
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
    const detected = detector(html);

    return {
      key,
      path: pagePath,
      script: detected.proof_marker,
      required_version: detected.required_version,
      detected_version: detected.detected_version,
      status: res.ok && detected.page_preflight_wired ? "pass" : "unknown",
      ok: res.ok,
      http_status: res.status,
      elapsed_ms: Date.now() - started,
      page_preflight_wired: Boolean(res.ok && detected.page_preflight_wired),
      proof_marker: detected.proof_marker,
      source: detected.source
    };
  } catch (err) {
    return {
      key,
      path: pagePath,
      script: null,
      required_version: null,
      detected_version: null,
      status: "unknown",
      ok: false,
      error: err.message || String(err),
      elapsed_ms: Date.now() - started,
      page_preflight_wired: false
    };
  }
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

function detectAddPageProof(html) {
  const text = String(html || "");

  const inlineVersion =
    extractNamedWindowVersion(text, "SovereignAdd") ||
    extractConstVersionNear(text, "SovereignAdd") ||
    extractTokenVersion(text, /ui6-add-\d+/i);

  if (/SovereignAdd/i.test(text) && /^ui6-add-\d+$/i.test(String(inlineVersion || ""))) {
    return {
      status: "pass",
      detected_version: inlineVersion,
      page_preflight_wired: true,
      proof_marker: "inline:SovereignAdd",
      required_version: "ui6-add-2",
      source: "rebuilt_clean_add_page"
    };
  }

  const legacyVersion = extractScriptVersion(text, "/js/add.js");

  if (legacyVersion && versionAtLeast(legacyVersion, "0.4.5")) {
    return {
      status: "pass",
      detected_version: legacyVersion,
      page_preflight_wired: true,
      proof_marker: "/js/add.js",
      required_version: "0.4.5",
      source: "legacy_add_controller"
    };
  }

  return {
    status: "unknown",
    detected_version: inlineVersion || legacyVersion || null,
    page_preflight_wired: false,
    proof_marker: "inline:SovereignAdd",
    required_version: "ui6-add-2 or /js/add.js?v=0.4.5+",
    source: "add_page_unrecognized"
  };
}

function detectBillsPageProof(html) {
  const text = String(html || "");

  const inlineVersion =
    extractNamedWindowVersion(text, "SovereignBills") ||
    extractConstVersionNear(text, "SovereignBills") ||
    extractTokenVersion(text, /ui\d+-bills-\d+/i);

  if (/SovereignBills/i.test(text) && /^ui\d+-bills-\d+$/i.test(String(inlineVersion || ""))) {
    return {
      status: "pass",
      detected_version: inlineVersion,
      page_preflight_wired: true,
      proof_marker: "inline:SovereignBills",
      required_version: "ui4-bills-1+",
      source: "rebuilt_clean_bills_page"
    };
  }

  const legacyVersion = extractScriptVersion(text, "/js/bills.js");

  if (legacyVersion && versionAtLeast(legacyVersion, "0.4.0")) {
    return {
      status: "pass",
      detected_version: legacyVersion,
      page_preflight_wired: true,
      proof_marker: "/js/bills.js",
      required_version: "0.4.0",
      source: "legacy_bills_controller"
    };
  }

  return {
    status: "unknown",
    detected_version: inlineVersion || legacyVersion || null,
    page_preflight_wired: false,
    proof_marker: "inline:SovereignBills",
    required_version: "ui4-bills-1+ or /js/bills.js?v=0.4.0+",
    source: "bills_page_unrecognized"
  };
}

function detectDebtsPageProof(html) {
  const text = String(html || "");

  const inlineVersion =
    extractNamedWindowVersion(text, "SovereignDebts") ||
    extractConstVersionNear(text, "SovereignDebts") ||
    extractTokenVersion(text, /ui5-debts-\d+/i);

  if (/SovereignDebts/i.test(text) && /^ui5-debts-\d+$/i.test(String(inlineVersion || ""))) {
    return {
      status: "pass",
      detected_version: inlineVersion,
      page_preflight_wired: true,
      proof_marker: "inline:SovereignDebts",
      required_version: "ui5-debts-1+",
      source: "rebuilt_clean_debts_page"
    };
  }

  const legacyVersion = extractInlineGlobalVersion(text, "SovereignDebtsUI");

  if (legacyVersion && versionAtLeast(legacyVersion, "2.2.0")) {
    return {
      status: "pass",
      detected_version: legacyVersion,
      page_preflight_wired: true,
      proof_marker: "inline:SovereignDebtsUI",
      required_version: "2.2.0",
      source: "legacy_debts_inline_ui"
    };
  }

  return {
    status: "unknown",
    detected_version: inlineVersion || legacyVersion || null,
    page_preflight_wired: false,
    proof_marker: "inline:SovereignDebts",
    required_version: "ui5-debts-1+ or SovereignDebtsUI v2.2.0+",
    source: "debts_page_unrecognized"
  };
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
  const salaryApi = apis.find(api => api.key === "salary");
  const forecastApi = apis.find(api => api.key === "forecast");

  const addProof = pageProofs.find(proof => proof.key === "add_page_preflight");
  const billsProof = pageProofs.find(proof => proof.key === "bills_page_preflight");
  const debtsProof = pageProofs.find(proof => proof.key === "debts_page_preflight");
  const reconciliationProof = pageProofs.find(proof => proof.key === "reconciliation_page");
  const salaryProof = pageProofs.find(proof => proof.key === "salary_page");
  const forecastProof = pageProofs.find(proof => proof.key === "forecast_page");

  const transactionApiReady =
    transactionsApi &&
    transactionsApi.status === "pass" &&
    versionAtLeast(transactionsApi.version, "0.3.0");

  const addPageReady =
    addProof &&
    addProof.status === "pass" &&
    addProof.page_preflight_wired === true;

  const transactionReady = Boolean(transactionApiReady && addPageReady);

  const billsApiReady =
    billsApi &&
    billsApi.status === "pass" &&
    (versionAtLeast(billsApi.version, "0.5.0") || versionAtLeast(billsApi.version, "0.4.0") || versionAtLeast(billsApi.version, "0.3.0"));

  const billsPageReady =
    billsProof &&
    billsProof.status === "pass" &&
    billsProof.page_preflight_wired === true;

  const billsReady = Boolean(billsApiReady && billsPageReady);

  const debtsApiReady =
    debtsApi &&
    debtsApi.status === "pass" &&
    (versionAtLeast(debtsApi.version, "0.4.0") || versionAtLeast(debtsApi.version, "0.3.2"));

  const debtsPageReady =
    debtsProof &&
    debtsProof.status === "pass" &&
    debtsProof.page_preflight_wired === true;

  const debtsReady = Boolean(debtsApiReady && debtsPageReady);

  const reconciliationReady =
    reconciliationApi &&
    reconciliationApi.status === "pass" &&
    versionAtLeast(reconciliationApi.version, "0.1.0") &&
    reconciliationProof &&
    reconciliationProof.status === "pass";

  const salaryReady =
    salaryApi &&
    salaryApi.status === "pass" &&
    versionAtLeast(salaryApi.version, "0.1.0") &&
    salaryProof &&
    salaryProof.status === "pass";

  const forecastReady =
    forecastApi &&
    forecastApi.status === "pass" &&
    versionAtLeast(forecastApi.version, "1.0.0") &&
    forecastProof &&
    forecastProof.status === "pass";

  const score = forecastReady
    ? 100
    : salaryReady
      ? 100
      : reconciliationReady
        ? 99
        : debtsReady
          ? 98
          : billsReady
            ? 95
            : transactionReady
              ? 85
              : 0;

  return {
    d1,
    write_safety: {
      status: forecastReady
        ? "forecast_ready"
        : salaryReady
          ? "salary_ready"
          : reconciliationReady
            ? "reconciliation_ready"
            : debtsReady
              ? "debt_writes_ready"
              : billsReady
                ? "bill_writes_ready"
                : transactionReady
                  ? "transaction_save_ready"
                  : "unknown",
      score,

      transaction_save: {
        dry_run_available: Boolean(transactionApiReady),
        page_preflight_wired: Boolean(addPageReady),
        real_writes_allowed: Boolean(transactionReady)
      },

      bills: {
        dry_run_available: Boolean(billsApiReady),
        page_preflight_wired: Boolean(billsPageReady),
        real_writes_allowed: Boolean(billsReady),
        bill_save_allowed: Boolean(billsReady),
        bill_pay_allowed: Boolean(billsReady),
        bill_clear_allowed: Boolean(billsReady)
      },

      debts: {
        dry_run_available: Boolean(debtsApiReady),
        page_preflight_wired: Boolean(debtsPageReady),
        real_writes_allowed: Boolean(debtsReady),
        debt_save_allowed: Boolean(debtsReady),
        debt_pay_allowed: Boolean(debtsReady)
      },

      reconciliation: {
        dry_run_available: Boolean(reconciliationApi && reconciliationApi.status === "pass"),
        page_wired: Boolean(reconciliationProof && reconciliationProof.status === "pass"),
        real_writes_allowed: Boolean(reconciliationReady),
        reconciliation_declare_allowed: Boolean(reconciliationReady)
      },

      salary: {
        dry_run_available: Boolean(salaryApi && salaryApi.status === "pass"),
        page_wired: Boolean(salaryProof && salaryProof.status === "pass"),
        real_writes_allowed: Boolean(salaryReady),
        salary_save_allowed: Boolean(salaryReady)
      },

      forecast: {
        generate_available: Boolean(forecastApi && forecastApi.status === "pass"),
        page_wired: Boolean(forecastProof && forecastProof.status === "pass"),
        forecast_generate_allowed: Boolean(forecastReady),
        real_writes_allowed: Boolean(forecastReady)
      },

      real_write_scope: [
        ...(transactionReady ? ["transaction.save"] : []),
        ...(billsReady ? ["bill.save", "bill.pay"] : []),
        ...(debtsReady ? ["debt.save", "debt.pay"] : []),
        ...(reconciliationReady ? ["reconciliation.declare"] : []),
        ...(salaryReady ? ["salary.save"] : []),
        ...(forecastReady ? ["forecast.generate"] : [])
      ]
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
  const debtsReady = Boolean(coverage.write_safety.debts.real_writes_allowed);
  const reconciliationReady = Boolean(coverage.write_safety.reconciliation.real_writes_allowed);
  const salaryReady = Boolean(coverage.write_safety.salary.real_writes_allowed);
  const forecastReady = Boolean(coverage.write_safety.forecast.forecast_generate_allowed);

  const actions = [
    actionGate("transaction.save", "add", !txReady, txReady ? "transaction.save is allowed after Add proof." : "transaction.save is not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete Add proof.", true, true),

    actionGate("bill.save", "bills", !billsReady, billsReady ? "bill.save is allowed after Bills proof." : "bill.save is not ready.", "coverage.write_safety.bills.bill_save_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("bill.pay", "bills", !billsReady, billsReady ? "bill.pay is allowed after Bills proof." : "bill.pay is not ready.", "coverage.write_safety.bills.bill_pay_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),
    actionGate("bill.clear", "bills", !billsReady, billsReady ? "bill.clear is treated as bill.pay and allowed after Bills proof." : "bill.clear is not ready.", "coverage.write_safety.bills.bill_clear_allowed", billsReady ? "None." : "Complete Bills proof.", true, true),

    actionGate("debt.save", "debts", !debtsReady, debtsReady ? "debt.save is allowed after Debts proof." : "debt.save is blocked until Debts proof exists.", "coverage.write_safety.debts.debt_save_allowed", debtsReady ? "None." : "Complete Debts proof.", true, true),
    actionGate("debt.pay", "debts", !debtsReady, debtsReady ? "debt.pay is allowed after Debts proof." : "debt.pay is blocked until Debts proof exists.", "coverage.write_safety.debts.debt_pay_allowed", debtsReady ? "None." : "Complete Debts proof.", true, true),

    actionGate("reconciliation.declare", "reconciliation", !reconciliationReady, reconciliationReady ? "reconciliation.declare is allowed after Reconciliation proof." : "reconciliation.declare remains blocked until proof exists.", "coverage.write_safety.reconciliation", reconciliationReady ? "None." : "Add reconciliation proof.", true, true),
    actionGate("salary.save", "salary", !salaryReady, salaryReady ? "salary.save is allowed after Salary proof." : "salary.save remains blocked until proof exists.", "coverage.write_safety.salary", salaryReady ? "None." : "Add salary proof.", true, true),
    actionGate("forecast.generate", "forecast", !forecastReady, forecastReady ? "forecast.generate is allowed after Forecast proof." : "forecast.generate remains blocked until proof exists.", "coverage.write_safety.forecast", forecastReady ? "None." : "Add forecast proof.", true, true),

    actionGate("override.request", "command_centre", false, "Override request templates are available for emergencies.", "override_policy.request_schema", "None.", false, true),
    actionGate("override.apply", "system", true, "Command Centre does not directly apply overrides. Owning API must implement override enforcement with audit.", "override_policy.api_owned_application", "Implement API-owned override path only if truly required.", false, true),
    actionGate("override.silent_bypass", "system", true, "Silent bypass is permanently blocked.", "override_policy.silent_bypass_forbidden", "Never lift.", true, true),
    actionGate("money_contracts.use_as_truth_source", "system", true, "/api/money-contracts is banned as a finance truth source.", "source_proofs.money_contracts", "Never lift.", true, true)
  ];

  const routes = [
    routeGate("/monthly-close.html", "command_centre", "pass", true, true, "Command Centre is authority surface.", "enforcement.policy", "None."),
    routeGate("/index.html", "hub", "pass", true, true, "Hub is viewable.", "enforcement.registry.hub", "None."),
    routeGate("/add.html", "add", txReady ? "pass" : "soft_block", true, txReady, txReady ? "Add Transaction is governed and allowed." : "Add Transaction proof not ready.", "coverage.write_safety.transaction_save", txReady ? "None." : "Complete Add proof."),
    routeGate("/bills.html", "bills", billsReady ? "pass" : "soft_block", true, billsReady, billsReady ? "Bills are governed and allowed." : "Bills proof not ready.", "coverage.write_safety.bills", billsReady ? "None." : "Complete Bills proof."),
    routeGate("/debts.html", "debts", debtsReady ? "pass" : "soft_block", true, debtsReady, debtsReady ? "Debts are governed and allowed." : "Debts proof not ready.", "coverage.write_safety.debts", debtsReady ? "None." : "Complete Debts proof."),
    routeGate("/reconciliation.html", "reconciliation", reconciliationReady ? "pass" : "preflight_required", true, reconciliationReady, reconciliationReady ? "Reconciliation is governed and allowed." : "Reconciliation viewable but declarations blocked.", "coverage.write_safety.reconciliation", reconciliationReady ? "None." : "Add reconciliation proof."),
    routeGate("/salary.html", "salary", salaryReady ? "pass" : "preflight_required", true, salaryReady, salaryReady ? "Salary is governed and allowed." : "Salary viewable but saving blocked.", "coverage.write_safety.salary", salaryReady ? "None." : "Add salary proof."),
    routeGate("/forecast.html", "forecast", forecastReady ? "pass" : "soft_block", true, forecastReady, forecastReady ? "Forecast is governed and allowed." : "Forecast generation blocked until proof exists.", "coverage.write_safety.forecast", forecastReady ? "None." : "Add forecast proof."),
    routeGate("/cc.html", "credit_card", "warn", true, false, "Credit Card viewable; source should be verified next.", "business_rules.cc_outstanding_source", "Restore CC proof."),
    routeGate("/transactions.html", "transactions", "warn", true, false, "Transactions viewable; non-Add mutations blocked.", "coverage.write_safety.transaction_save", "Add separate proof for other mutations."),
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
      bill_pay_real_write_lifted: billsReady,
      debt_save_real_write_lifted: debtsReady,
      debt_pay_real_write_lifted: debtsReady,
      reconciliation_declare_real_write_lifted: reconciliationReady,
      salary_save_real_write_lifted: salaryReady,
      forecast_generate_lifted: forecastReady,
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

    action_proof_status: {
      "transaction.save": { status: txReady ? "pass" : "blocked" },
      "bill.save": { status: billsReady ? "pass" : "blocked" },
      "bill.pay": { status: billsReady ? "pass" : "blocked" },
      "bill.clear": { status: billsReady ? "pass" : "blocked" },
      "debt.save": { status: debtsReady ? "pass" : "blocked" },
      "debt.pay": { status: debtsReady ? "pass" : "blocked" },
      "reconciliation.declare": { status: reconciliationReady ? "pass" : "blocked" },
      "salary.save": { status: salaryReady ? "pass" : "blocked" },
      "forecast.generate": { status: forecastReady ? "pass" : "blocked" },
      "override.request": { status: "pass" },
      "override.apply": { status: "blocked" }
    },

    block_explanations: actions.filter(action => !action.allowed).map(action => ({
      blocked_item: action.action,
      block_type: "action_block",
      reason: action.reason,
      source: action.source,
      required_fix: action.required_fix,
      override_allowed: action.action !== "override.silent_bypass" && buildOverridePolicy().requestable_actions.includes(action.action),
      backend_enforced: action.backend_enforced,
      frontend_enforced: action.frontend_enforced
    })),

    reasons: actions.filter(action => !action.allowed).map(action => action.reason),
    overrides: buildOverridePolicy(),
    emergency_playbooks: buildEmergencyPlaybooks(),
    enforcement_status_note: txReady
      ? "Command Centre recognizes the clean inline Add page proof."
      : "Command Centre is active; Add proof is not recognized."
  };
}

function buildSourceProofs(coverage, apis, pageProofs) {
  return [
    sourceProof("transaction_save_dry_run", coverage.write_safety.transaction_save.dry_run_available, "/api/transactions version >= v0.3.0", coverage.write_safety.transaction_save),
    sourceProof("add_page_preflight", coverage.write_safety.transaction_save.page_preflight_wired, "/add.html inline SovereignAdd ui6-add-2 or /js/add.js?v=0.4.5+", pageProofs.find(proof => proof.key === "add_page_preflight") || null),

    sourceProof("bills_api_dry_run", coverage.write_safety.bills.dry_run_available, "/api/bills version >= v0.3.0", apis.find(api => api.key === "bills") || null),
    sourceProof("bills_page_preflight", coverage.write_safety.bills.page_preflight_wired, "/bills.html inline SovereignBills", pageProofs.find(proof => proof.key === "bills_page_preflight") || null),

    sourceProof("debts_api_dry_run", coverage.write_safety.debts.dry_run_available, "/api/debts version >= v0.3.2", apis.find(api => api.key === "debts") || null),
    sourceProof("debts_page_preflight", coverage.write_safety.debts.page_preflight_wired, "/debts.html inline SovereignDebts", pageProofs.find(proof => proof.key === "debts_page_preflight") || null),

    sourceProof("reconciliation_api", coverage.write_safety.reconciliation.dry_run_available, "/api/reconciliation version >= v0.1.0", apis.find(api => api.key === "reconciliation") || null),
    sourceProof("reconciliation_page", coverage.write_safety.reconciliation.page_wired, "/reconciliation.html inline SovereignReconciliationUI v1.0.0+", pageProofs.find(proof => proof.key === "reconciliation_page") || null),

    sourceProof("salary_api", coverage.write_safety.salary.dry_run_available, "/api/salary version >= v0.1.0", apis.find(api => api.key === "salary") || null),
    sourceProof("salary_page", coverage.write_safety.salary.page_wired, "/salary.html inline SovereignSalaryUI v1.0.0+", pageProofs.find(proof => proof.key === "salary_page") || null),

    sourceProof("forecast_api", coverage.write_safety.forecast.generate_available, "/api/forecast version >= v1.0.0", apis.find(api => api.key === "forecast") || null),
    sourceProof("forecast_page", coverage.write_safety.forecast.page_wired, "/forecast.html inline SovereignForecastUI v1.0.0+", pageProofs.find(proof => proof.key === "forecast_page") || null),

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
      details: {
        called: false,
        allowed_as_truth_source: false
      }
    }
  ];
}

function buildBusinessRules(coverage) {
  return [
    rule("add_write_path", coverage.write_safety.transaction_save.real_writes_allowed ? "pass" : "blocked", "Add write path", "transaction.save governed."),
    rule("bills_write_path", coverage.write_safety.bills.real_writes_allowed ? "pass" : "blocked", "Bills write path", "Bills governed."),
    rule("debts_write_path", coverage.write_safety.debts.real_writes_allowed ? "pass" : "blocked", "Debts write path", "Debts governed."),
    rule("reconciliation_write_path", coverage.write_safety.reconciliation.real_writes_allowed ? "pass" : "blocked", "Reconciliation write path", "Reconciliation governed."),
    rule("salary_write_path", coverage.write_safety.salary.real_writes_allowed ? "pass" : "blocked", "Salary write path", "Salary governed."),
    rule("forecast_generate_path", coverage.write_safety.forecast.forecast_generate_allowed ? "pass" : "blocked", "Forecast generate path", "Forecast governed."),
    rule("override_policy", "pass", "Emergency override policy", "Override policy is visible and does not silently bypass APIs."),
    rule("money_contracts_banned", "pass", "Money contracts banned", "/api/money-contracts is not used."),
    rule("cc_outstanding_source", "warn", "Credit Card source", "Credit Card source should be verified next.")
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
    ]
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
    }
  ];
}

function buildWarnings(coverage) {
  const warnings = [
    warning("cc_source_should_be_verified", "Credit Card source should be verified next for full forecast confidence."),
    warning("override_application_not_enabled", "Override policy is complete, but Command Centre does not directly apply overrides. This prevents silent bypass.")
  ];

  if (!coverage.write_safety.transaction_save.real_writes_allowed) {
    warnings.push(warning("add_proof_missing", "Add Transaction is blocked until inline SovereignAdd or legacy add.js proof is recognized."));
  }

  return warnings;
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

function sourceProof(key, passed, source, details) {
  return {
    key,
    status: passed ? "pass" : "unknown",
    source,
    details
  };
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
    override: {
      allowed: false,
      reason_required: true
    }
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
  return {
    key,
    message,
    next_action: nextAction,
    severity: "hard_blocker"
  };
}

function warning(key, message) {
  return {
    key,
    message,
    severity: "warning"
  };
}

function extractInlineGlobalVersion(html, globalName) {
  const text = String(html || "");
  const globalEscaped = escapeRegExp(globalName);
  if (!new RegExp(globalEscaped).test(text)) return null;

  const objectVersion = extractNamedWindowVersion(text, globalName);
  if (objectVersion) return objectVersion;

  const constVersion = extractConstVersionNear(text, globalName);
  if (constVersion) return constVersion;

  const numericVersionMatch = text.match(/const\s+VERSION\s*=\s*["']([0-9]+(?:\.[0-9]+){1,3})["']/);
  return numericVersionMatch ? numericVersionMatch[1] : null;
}

function extractScriptVersion(html, scriptPath) {
  const text = String(html || "");
  const escaped = escapeRegExp(scriptPath);
  const re = new RegExp(escaped + "\\?v=([^\"'\\s>]+)", "i");
  const match = text.match(re);
  return match ? match[1] : null;
}

function extractNamedWindowVersion(html, globalName) {
  const text = String(html || "");
  const escaped = escapeRegExp(globalName);

  const direct = text.match(new RegExp("window\\." + escaped + "\\s*=\\s*\\{[\\s\\S]{0,900}?version\\s*:\\s*VERSION", "i"));
  if (direct) {
    const constMatch = text.match(/const\s+VERSION\s*=\s*["']([^"']+)["']/);
    if (constMatch) return constMatch[1];
  }

  const inline = text.match(new RegExp(escaped + "[\\s\\S]{0,900}?version\\s*:\\s*[\"']([^\"']+)[\"']", "i"));
  return inline ? inline[1] : null;
}

function extractConstVersionNear(html, marker) {
  const text = String(html || "");
  const index = text.search(new RegExp(escapeRegExp(marker), "i"));
  if (index < 0) return null;

  const start = Math.max(0, index - 1500);
  const end = Math.min(text.length, index + 1500);
  const windowText = text.slice(start, end);
  const match = windowText.match(/const\s+VERSION\s*=\s*["']([^"']+)["']/);

  return match ? match[1] : null;
}

function extractTokenVersion(html, pattern) {
  const text = String(html || "");
  const match = text.match(pattern);
  return match ? match[0] : null;
}

function versionAtLeast(actual, required) {
  if (!actual || !required) return false;

  const actualText = String(actual);
  const requiredText = String(required);

  const actualUi = actualText.match(/^ui(\d+)-([a-z]+)-(\d+)$/i);
  const requiredUi = requiredText.match(/^ui(\d+)-([a-z]+)-(\d+)/i);

  if (actualUi && requiredUi) {
    if (actualUi[2].toLowerCase() !== requiredUi[2].toLowerCase()) return false;
    const actualMajor = Number(actualUi[1]);
    const requiredMajor = Number(requiredUi[1]);
    const actualPatch = Number(actualUi[3]);
    const requiredPatch = Number(requiredUi[3]);

    if (actualMajor > requiredMajor) return true;
    if (actualMajor < requiredMajor) return false;
    return actualPatch >= requiredPatch;
  }

  const a = parseVersion(actualText);
  const r = parseVersion(requiredText);

  for (let i = 0; i < Math.max(a.length, r.length); i += 1) {
    const av = a[i] || 0;
    const rv = r[i] || 0;
    if (av > rv) return true;
    if (av < rv) return false;
  }

  return true;
}

function parseVersion(value) {
  const parts = String(value || "")
    .replace(/^v/i, "")
    .match(/\d+/g);

  if (!parts) return [0];

  return parts.map(part => Number(part)).map(number => Number.isFinite(number) ? number : 0);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
