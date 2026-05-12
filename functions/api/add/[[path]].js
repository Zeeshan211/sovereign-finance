/* Sovereign Finance — Add Orchestrator
 * v1.2.0-add-orchestrator-intl-package
 *
 * Direct-write modes:
 *   expense, income, transfer (Shipment 1, unchanged)
 *   international_purchase    (Shipment 2 / Layer 4g, NEW)
 *
 * International package writer:
 *   - subtype: 'foreign'   user enters foreign amount + currency + optional FX rate
 *   - subtype: 'pkr_base'  user enters PKR amount, no FX conversion
 *   - Engine reads rates from /api/intl-rates, FX rate from /api/intl-rates/fx
 *   - Computes all components: base + fx_fee + excise + advance_tax + pra + bank_charge
 *   - Commit writes intl_package parent row + N transaction rows atomically (D1 batch)
 *   - Hash-gated commit, same contract as other modes
 *
 * Hard rules:
 *   - International rows always use type='expense' (CHECK constraint allows it)
 *   - Each row links to its intl_package via intl_package_id column
 *   - Notes are auto-prefixed by component for ledger scanning
 *   - Same user-selected category applied to every row
 *   - rate_snapshot stores config row JSON at write time for audit
 */

const VERSION = 'v1.2.0-add-orchestrator-intl-package';

const DIRECT_MODES = new Set(['expense', 'income', 'transfer', 'international_purchase']);

const MODE_REGISTRY = {
  expense: {
    label: 'Expense',
    capability: 'direct',
    route: 'transactions',
    endpoint: '/api/transactions'
  },
  income: {
    label: 'Income',
    capability: 'direct',
    route: 'transactions',
    endpoint: '/api/transactions'
  },
  transfer: {
    label: 'Transfer',
    capability: 'direct',
    route: 'transactions',
    endpoint: '/api/transactions'
  },
  international_purchase: {
    label: 'International Purchase',
    capability: 'direct',
    route: 'intl_package',
    endpoint: 'internal://intl_package_writer'
  },
  bill_payment:        { label: 'Bill Payment', capability: 'advisory', route: 'bills', owner_url: '/bills.html', suggested_mode: 'expense' },
  debt_given:          { label: 'Debt Given', capability: 'advisory', route: 'debts', owner_url: '/debts.html', suggested_mode: 'expense' },
  debt_received:       { label: 'Debt Received', capability: 'advisory', route: 'debts', owner_url: '/debts.html', suggested_mode: 'income' },
  cc_payment:          { label: 'CC Payment', capability: 'advisory', route: 'cc', owner_url: '/cc.html', suggested_mode: 'transfer' },
  cc_spend:            { label: 'CC Spend', capability: 'advisory', route: 'cc', owner_url: '/cc.html' },
  atm_withdrawal:      { label: 'ATM Withdrawal', capability: 'advisory', route: 'atm', owner_url: '/atm.html', suggested_mode: 'transfer' },
  salary_income:       { label: 'Salary Income', capability: 'advisory', route: 'salary', owner_url: '/salary.html', suggested_mode: 'income' }
};

const INTL_COMPONENT_LABELS = {
  base: 'INTL BASE',
  fx_fee: 'INTL FX FEE',
  excise: 'INTL EXCISE',
  advance_tax: 'INTL ADVANCE TAX',
  pra: 'INTL PRA',
  bank_charge: 'INTL BANK CHARGE'
};

export async function onRequest(context) {
  try {
    const request = context.request;
    const method = request.method.toUpperCase();
    const path = normalizePath(context.params.path);

    if (method === 'GET' && path[0] === 'context') {
      return await handleContext(context);
    }

    if (method === 'POST' && path[0] === 'preview') {
      return await handlePreview(context);
    }

    if (method === 'POST' && path[0] === 'dry-run') {
      return await handleDryRun(context);
    }

    if (method === 'POST' && path[0] === 'commit') {
      return await handleCommit(context);
    }

    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported Add route',
      supported_routes: [
        'GET /api/add/context',
        'POST /api/add/preview',
        'POST /api/add/dry-run',
        'POST /api/add/commit'
      ]
    }, 404);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

async function readJSON(request) {
  const text = await request.text();
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Invalid JSON body');
  }
}

/* ====================================================================== */
/* CONTEXT                                                                */
/* ====================================================================== */
async function handleContext(context) {
  const [accounts, categories, merchants, intlRates] = await Promise.all([
    internalJSON(context, '/api/accounts'),
    internalJSON(context, '/api/categories'),
    internalJSON(context, '/api/merchants'),
    internalJSON(context, '/api/intl-rates')
  ]);

  const accountsOk = accounts.ok && accounts.payload && accounts.payload.ok !== false;
  const categoriesOk = categories.ok && categories.payload && categories.payload.ok !== false;
  const merchantsOk = merchants.ok && merchants.payload && merchants.payload.ok !== false;
  const intlRatesOk = intlRates.ok && intlRates.payload && intlRates.payload.ok !== false;

  return json({
    ok: true,
    version: VERSION,
    source_status: {
      accounts: accountsOk ? 'ok' : 'failed',
      categories: categoriesOk ? 'ok' : 'failed',
      merchants: merchantsOk ? 'ok' : 'failed_optional',
      intl_rates: intlRatesOk ? 'ok' : 'failed_optional'
    },
    can_direct_write: accountsOk && categoriesOk,
    can_intl_package_write: accountsOk && categoriesOk && intlRatesOk,
    accounts: accountsOk ? unwrapArray(accounts.payload, ['accounts', 'items', 'rows', 'data']) : [],
    categories: categoriesOk ? unwrapArray(categories.payload, ['categories', 'items', 'rows', 'data']) : [],
    merchants: merchantsOk ? unwrapArray(merchants.payload, ['merchants', 'items', 'rows', 'data']) : [],
    intl_rate_config: intlRatesOk ? (intlRates.payload.config || null) : null,
    mode_registry: MODE_REGISTRY,
    contract: {
      direct_modes: Array.from(DIRECT_MODES),
      dry_run_required: true,
      commit_requires_payload_hash: true,
      source_rule: 'Direct write requires live /api/accounts and /api/categories. Intl package additionally requires /api/intl-rates.',
      advanced_rule: 'Advanced modes are routed/advisory until their owner dry-run and commit contracts are locked.',
      intl_subtypes: ['foreign', 'pkr_base'],
      intl_components: ['base', 'fx_fee', 'excise', 'advance_tax', 'pra', 'bank_charge']
    }
  });
}

/* ====================================================================== */
/* PREVIEW                                                                */
/* ====================================================================== */
async function handlePreview(context) {
  const body = await readJSON(context.request);
  const mode = normalizeMode(body.mode || body.type);
  const modeSpec = MODE_REGISTRY[mode];

  if (!modeSpec) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Unsupported Add mode',
      mode,
      supported_modes: Object.keys(MODE_REGISTRY)
    }, 400);
  }

  if (mode === 'international_purchase') {
    return await previewIntlPackage(context, body);
  }

  if (modeSpec.capability === 'direct') {
    const payload = buildTransactionPayload(body, mode);
    return json({
      ok: true,
      version: VERSION,
      mode,
      label: modeSpec.label,
      route: modeSpec.route,
      write_capability: 'direct',
      endpoint: modeSpec.endpoint,
      normalized_payload: payload,
      expected_effects: expectedEffects(payload),
      warnings: previewWarnings(payload),
      suggestions: previewSuggestions(body, mode),
      next_step: 'POST /api/add/dry-run'
    });
  }

  if (modeSpec.capability === 'advisory') {
    return json({
      ok: true,
      version: VERSION,
      mode,
      label: modeSpec.label,
      route: modeSpec.route,
      write_capability: 'advisory',
      owner_url: modeSpec.owner_url,
      suggested_mode: modeSpec.suggested_mode || null,
      normalized_payload: buildAdvisoryPayload(body, mode),
      expected_effects: [],
      warnings: [
        `${modeSpec.label} is advisory in this shipment. It will not mutate its source of truth from Add.`
      ],
      suggestions: previewSuggestions(body, mode),
      next_step: modeSpec.suggested_mode
        ? `Switch to ${modeSpec.suggested_mode} after review, then dry-run.`
        : 'Review only.'
    });
  }

  return json({
    ok: true,
    version: VERSION,
    mode,
    label: modeSpec.label,
    route: modeSpec.route,
    write_capability: modeSpec.capability,
    owner_url: modeSpec.owner_url,
    normalized_payload: buildAdvisoryPayload(body, mode),
    expected_effects: [],
    warnings: [
      `${modeSpec.label} is not a direct Add write in this shipment.`,
      'Open the owner workflow to preserve linked entity state and audit behavior.'
    ],
    suggestions: [],
    next_step: `Open ${modeSpec.owner_url}`
  });
}

/* ====================================================================== */
/* DRY-RUN                                                                */
/* ====================================================================== */
async function handleDryRun(context) {
  const body = await readJSON(context.request);
  const mode = normalizeMode(body.mode || body.type);

  if (!DIRECT_MODES.has(mode)) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: true,
      writes_performed: false,
      error: 'Mode is not direct-write enabled in current Add shipment',
      mode,
      mode_spec: MODE_REGISTRY[mode] || null
    }, 400);
  }

  if (mode === 'international_purchase') {
    return await dryRunIntlPackage(context, body);
  }

  const txPayload = buildTransactionPayload(body, mode);
  const txDryRun = await callTransactions(context, txPayload, true);

  if (!txDryRun.ok || !txDryRun.payload || txDryRun.payload.ok === false) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: true,
      writes_performed: false,
      mode,
      route: 'transactions',
      error: txDryRun.payload?.error || txDryRun.error || 'Transaction dry-run failed',
      transaction_response: txDryRun.payload || null
    }, txDryRun.status || 400);
  }

  const normalized = txDryRun.payload.normalized_payload || txPayload;
  const payloadHash = await hashPayload({
    mode,
    route: 'transactions',
    normalized_payload: normalized
  });

  return json({
    ok: true,
    version: VERSION,
    dry_run: true,
    writes_performed: false,
    audit_performed: false,
    mode,
    route: 'transactions',
    payload_hash: payloadHash,
    normalized_payload: normalized,
    expected_writes: expectedWritesFromProof(txDryRun.payload.proof),
    proof: txDryRun.payload.proof || null,
    transaction_response: txDryRun.payload
  });
}

/* ====================================================================== */
/* COMMIT                                                                 */
/* ====================================================================== */
async function handleCommit(context) {
  const body = await readJSON(context.request);
  const mode = normalizeMode(body.mode || body.type);
  const suppliedHash = cleanText(body.dry_run_payload_hash || body.payload_hash, '', 200);

  if (!DIRECT_MODES.has(mode)) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Mode is not direct-write enabled in current Add shipment',
      mode,
      mode_spec: MODE_REGISTRY[mode] || null
    }, 400);
  }

  if (!suppliedHash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'dry_run_payload_hash required before commit',
      mode
    }, 400);
  }

  if (mode === 'international_purchase') {
    return await commitIntlPackage(context, body, suppliedHash);
  }

  const txPayload = buildTransactionPayload(body, mode);
  const txDryRun = await callTransactions(context, txPayload, true);
  if (!txDryRun.ok || !txDryRun.payload || txDryRun.payload.ok === false) {
    return json({
      ok: false,
      version: VERSION,
      error: txDryRun.payload?.error || txDryRun.error || 'Commit preflight dry-run failed',
      mode,
      dry_run_response: txDryRun.payload || null
    }, txDryRun.status || 400);
  }

  const normalized = txDryRun.payload.normalized_payload || txPayload;
  const recomputedHash = await hashPayload({
    mode,
    route: 'transactions',
    normalized_payload: normalized
  });

  if (recomputedHash !== suppliedHash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Payload changed after dry-run. Run dry-run again.',
      mode,
      supplied_hash: suppliedHash,
      recomputed_hash: recomputedHash,
      normalized_payload: normalized
    }, 409);
  }

  const txCommit = await callTransactions(context, txPayload, false);
  if (!txCommit.ok || !txCommit.payload || txCommit.payload.ok === false) {
    return json({
      ok: false,
      version: VERSION,
      error: txCommit.payload?.error || txCommit.error || 'Transaction commit failed',
      mode,
      route: 'transactions',
      transaction_response: txCommit.payload || null
    }, txCommit.status || 400);
  }

  return json({
    ok: true,
    version: VERSION,
    mode,
    route: 'transactions',
    writes_performed: true,
    audit_performed: txCommit.payload.audited === true,
    payload_hash: recomputedHash,
    normalized_payload: normalized,
    written: {
      transaction_id: txCommit.payload.id || null,
      linked_id: txCommit.payload.linked_id || null,
      ids: txCommit.payload.ids || (txCommit.payload.id ? [txCommit.payload.id] : [])
    },
    redirect: '/transactions.html',
    transaction_response: txCommit.payload
  });
}

/* ====================================================================== */
/* INTERNATIONAL PACKAGE                                                  */
/* ====================================================================== */

async function previewIntlPackage(context, body) {
  const built = await buildIntlPackage(context, body);

  return json({
    ok: built.ok,
    version: VERSION,
    mode: 'international_purchase',
    label: 'International Purchase',
    route: 'intl_package',
    write_capability: 'direct',
    subtype: built.payload?.subtype || null,
    normalized_payload: built.payload || null,
    package_preview: built.preview || null,
    rate_snapshot: built.rate_snapshot || null,
    fx_lookup: built.fx_lookup || null,
    warnings: built.warnings || [],
    errors: built.errors || [],
    next_step: built.ok ? 'POST /api/add/dry-run' : 'Fix errors and re-preview',
    suggestions: previewSuggestions(body, 'international_purchase')
  }, built.ok ? 200 : 400);
}

async function dryRunIntlPackage(context, body) {
  const built = await buildIntlPackage(context, body);

  if (!built.ok) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: true,
      writes_performed: false,
      mode: 'international_purchase',
      route: 'intl_package',
      error: 'International package validation failed',
      errors: built.errors,
      package_preview: built.preview || null
    }, 400);
  }

  const payloadHash = await hashPayload({
    mode: 'international_purchase',
    route: 'intl_package',
    normalized_payload: built.payload,
    package_preview: built.preview,
    rate_snapshot: built.rate_snapshot
  });

  return json({
    ok: true,
    version: VERSION,
    dry_run: true,
    writes_performed: false,
    audit_performed: false,
    mode: 'international_purchase',
    route: 'intl_package',
    payload_hash: payloadHash,
    normalized_payload: built.payload,
    package_preview: built.preview,
    rate_snapshot: built.rate_snapshot,
    fx_lookup: built.fx_lookup || null,
    expected_writes: [
      { model: 'intl_package', rows: 1 },
      { model: 'transactions', rows: built.preview.components.length }
    ],
    warnings: built.warnings || []
  });
}

async function commitIntlPackage(context, body, suppliedHash) {
  const built = await buildIntlPackage(context, body);

  if (!built.ok) {
    return json({
      ok: false,
      version: VERSION,
      error: 'International package validation failed at commit',
      mode: 'international_purchase',
      errors: built.errors
    }, 400);
  }

  const recomputedHash = await hashPayload({
    mode: 'international_purchase',
    route: 'intl_package',
    normalized_payload: built.payload,
    package_preview: built.preview,
    rate_snapshot: built.rate_snapshot
  });

  if (recomputedHash !== suppliedHash) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Payload changed after dry-run. Run dry-run again.',
      mode: 'international_purchase',
      supplied_hash: suppliedHash,
      recomputed_hash: recomputedHash,
      normalized_payload: built.payload,
      package_preview: built.preview
    }, 409);
  }

  const writeResult = await writeIntlPackageAtomic(context, built);

  if (!writeResult.ok) {
    return json({
      ok: false,
      version: VERSION,
      error: writeResult.error || 'Atomic intl package write failed',
      mode: 'international_purchase',
      route: 'intl_package'
    }, 500);
  }

  return json({
    ok: true,
    version: VERSION,
    mode: 'international_purchase',
    route: 'intl_package',
    writes_performed: true,
    audit_performed: false,
    payload_hash: recomputedHash,
    normalized_payload: built.payload,
    package_preview: built.preview,
    rate_snapshot: built.rate_snapshot,
    written: {
      intl_package_id: writeResult.intl_package_id,
      transaction_ids: writeResult.transaction_ids,
      row_count: writeResult.transaction_ids.length + 1
    },
    redirect: '/transactions.html'
  });
}

async function buildIntlPackage(context, body) {
  const errors = [];
  const warnings = [];

  const subtype = (cleanText(body.subtype, 'foreign', 20) || 'foreign').toLowerCase();
  if (subtype !== 'foreign' && subtype !== 'pkr_base') {
    errors.push(`Invalid subtype: ${subtype}. Must be 'foreign' or 'pkr_base'.`);
    return { ok: false, errors };
  }

  const date = normalizeDate(body.date);
  const accountId = cleanText(body.account_id || body.from_account_id || body.source_account_id, '', 160);
  const categoryId = cleanText(body.category_id || body.category, '', 160);
  const merchant = cleanText(body.merchant || body.source || body.person, '', 120);
  const reference = cleanText(body.reference || body.ref, '', 120);
  const userNotes = cleanText(body.notes || body.memo || body.description, '', 200);

  if (!accountId) errors.push('Account is required.');
  if (!categoryId) errors.push('Category is required.');

  const ratesResp = await internalJSON(context, '/api/intl-rates');
  if (!ratesResp.ok || !ratesResp.payload?.config) {
    errors.push('Failed to load intl_rate_config from /api/intl-rates');
    return { ok: false, errors };
  }
  const config = ratesResp.payload.config;

  let foreignAmount = null;
  let foreignCurrency = null;
  let fxRate = null;
  let fxLookup = null;
  let basePkr = null;

  if (subtype === 'foreign') {
    foreignAmount = cleanAmount(body.foreign_amount ?? body.amount);
    foreignCurrency = (cleanText(body.foreign_currency || body.currency, config.default_currency || 'USD', 8) || 'USD').toUpperCase();

    if (!foreignAmount || foreignAmount <= 0) {
      errors.push('Foreign amount must be greater than zero for subtype=foreign.');
    }
    if (!/^[A-Z]{3}$/.test(foreignCurrency)) {
      errors.push(`Invalid foreign currency code: ${foreignCurrency}`);
    }

    const overrideRate = Number(body.fx_rate);
    if (Number.isFinite(overrideRate) && overrideRate > 0) {
      fxRate = overrideRate;
      fxLookup = { source: 'user_override', rate: fxRate };
    } else if (foreignCurrency) {
      const fxResp = await internalJSON(context, `/api/intl-rates/fx?from=${encodeURIComponent(foreignCurrency)}&to=PKR`);
      if (fxResp.ok && fxResp.payload?.ok && Number.isFinite(fxResp.payload.rate)) {
        fxRate = Number(fxResp.payload.rate);
        fxLookup = {
          source: fxResp.payload.source,
          rate: fxRate,
          fetched_at: fxResp.payload.fetched_at,
          stale: fxResp.payload.stale === true,
          provider: fxResp.payload.provider
        };
        if (fxResp.payload.stale) {
          warnings.push('FX rate served from stale cache (provider unavailable).');
        }
      } else {
        errors.push(`FX rate lookup failed for ${foreignCurrency} -> PKR. Provide fx_rate manually or retry.`);
      }
    }

    if (fxRate && foreignAmount) {
      basePkr = round2(foreignAmount * fxRate);
    }
  } else {
    basePkr = cleanAmount(body.pkr_amount ?? body.amount);
    if (!basePkr || basePkr <= 0) {
      errors.push('PKR amount must be greater than zero for subtype=pkr_base.');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const fxFeePct = Number(config.fx_fee_pct) || 0;
  const excisePct = Number(config.excise_on_fx_fee_pct) || 0;
  const advanceTaxPct = Number(config.advance_tax_pct) || 0;
  const praPct = Number(config.pra_pct) || 0;
  const defaultBankCharge = Number(config.default_bank_charge) || 0;

  const userBankCharge = body.bank_charge_override === undefined
    ? defaultBankCharge
    : cleanNonNegativeAmount(body.bank_charge_override);

  let fxFeePkr = 0;
  let excisePkr = 0;
  if (subtype === 'foreign') {
    fxFeePkr = round2(basePkr * (fxFeePct / 100));
    excisePkr = round2(fxFeePkr * (excisePct / 100));
  }
  const advanceTaxPkr = round2(basePkr * (advanceTaxPct / 100));
  const praPkr = round2(basePkr * (praPct / 100));
  const bankChargePkr = round2(userBankCharge);

  const totalPkr = round2(basePkr + fxFeePkr + excisePkr + advanceTaxPkr + praPkr + bankChargePkr);

  const components = [
    { component: 'base', amount: basePkr, label: INTL_COMPONENT_LABELS.base }
  ];
  if (fxFeePkr > 0) components.push({ component: 'fx_fee', amount: fxFeePkr, label: INTL_COMPONENT_LABELS.fx_fee });
  if (excisePkr > 0) components.push({ component: 'excise', amount: excisePkr, label: INTL_COMPONENT_LABELS.excise });
  if (advanceTaxPkr > 0) components.push({ component: 'advance_tax', amount: advanceTaxPkr, label: INTL_COMPONENT_LABELS.advance_tax });
  if (praPkr > 0) components.push({ component: 'pra', amount: praPkr, label: INTL_COMPONENT_LABELS.pra });
  if (bankChargePkr > 0) components.push({ component: 'bank_charge', amount: bankChargePkr, label: INTL_COMPONENT_LABELS.bank_charge });

  const payload = {
    mode: 'international_purchase',
    subtype,
    date,
    account_id: accountId,
    category_id: categoryId,
    merchant,
    reference,
    notes: userNotes,
    foreign_amount: subtype === 'foreign' ? foreignAmount : null,
    foreign_currency: subtype === 'foreign' ? foreignCurrency : null,
    fx_rate: subtype === 'foreign' ? fxRate : null,
    base_pkr: basePkr,
    bank_charge_override: userBankCharge,
    created_by: cleanText(body.created_by, 'web-add-orchestrator', 80)
  };

  const preview = {
    subtype,
    base_pkr: basePkr,
    fx_fee_pkr: fxFeePkr,
    excise_pkr: excisePkr,
    advance_tax_pkr: advanceTaxPkr,
    pra_pkr: praPkr,
    bank_charge_pkr: bankChargePkr,
    total_pkr: totalPkr,
    foreign_amount: subtype === 'foreign' ? foreignAmount : null,
    foreign_currency: subtype === 'foreign' ? foreignCurrency : null,
    fx_rate: subtype === 'foreign' ? fxRate : null,
    components
  };

  return {
    ok: true,
    payload,
    preview,
    rate_snapshot: config,
    fx_lookup: fxLookup,
    warnings,
    errors: []
  };
}

async function writeIntlPackageAtomic(context, built) {
  const db = context.env.DB;
  const { payload, preview, rate_snapshot } = built;

  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const packageId = `INTLPKG-${ts}-${rand}`;

  const transactionRows = preview.components.map((c, idx) => {
    const txnRand = Math.random().toString(36).slice(2, 8).toUpperCase();
    const txnId = `TXN-INTL-${ts}-${String(idx).padStart(2, '0')}-${txnRand}`;
    const componentNotes = `[${c.label}] ${payload.notes || payload.merchant || 'International'}`.slice(0, 200);
    return { id: txnId, component: c.component, amount: c.amount, notes: componentNotes };
  });

  const stmts = [];

  stmts.push(
    db.prepare(`
      INSERT INTO intl_package
        (id, account_id, category_id, merchant, reference, notes, subtype,
         foreign_amount, foreign_currency, fx_rate, base_pkr,
         fx_fee_pkr, excise_pkr, advance_tax_pkr, pra_pkr, bank_charge_pkr, total_pkr,
         rate_snapshot, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed')
    `).bind(
      packageId,
      payload.account_id,
      payload.category_id,
      payload.merchant || null,
      payload.reference || null,
      payload.notes || null,
      payload.subtype,
      payload.foreign_amount,
      payload.foreign_currency,
      payload.fx_rate,
      preview.base_pkr,
      preview.fx_fee_pkr,
      preview.excise_pkr,
      preview.advance_tax_pkr,
      preview.pra_pkr,
      preview.bank_charge_pkr,
      preview.total_pkr,
      JSON.stringify(rate_snapshot)
    )
  );

  for (const row of transactionRows) {
    stmts.push(
      db.prepare(`
        INSERT INTO transactions
          (id, date, type, amount, account_id, category_id, notes, intl_package_id, created_at)
        VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, datetime('now'))
      `).bind(
        row.id,
        payload.date,
        row.amount,
        payload.account_id,
        payload.category_id,
        row.notes,
        packageId
      )
    );
  }

  try {
    await db.batch(stmts);
    return {
      ok: true,
      intl_package_id: packageId,
      transaction_ids: transactionRows.map(r => r.id)
    };
  } catch (err) {
    return {
      ok: false,
      error: `D1 batch failed: ${err.message || String(err)}`
    };
  }
}

/* ====================================================================== */
/* SHARED HELPERS                                                         */
/* ====================================================================== */
async function callTransactions(context, payload, dryRun) {
  const path = dryRun ? '/api/transactions?dry_run=1' : '/api/transactions';
  return await internalJSON(context, path, {
    method: 'POST',
    body: { ...payload, dry_run: dryRun || undefined, created_by: payload.created_by || 'web-add-orchestrator' }
  });
}

async function internalJSON(context, path, options = {}) {
  const requestUrl = new URL(context.request.url);
  const target = new URL(path, requestUrl.origin);
  const headers = new Headers();
  headers.set('accept', 'application/json');
  const incoming = context.request.headers;
  copyHeader(incoming, headers, 'cookie');
  copyHeader(incoming, headers, 'authorization');
  copyHeader(incoming, headers, 'cf-access-jwt-assertion');
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(target.toString(), init);
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload, error: payload && payload.error ? payload.error : null };
  } catch (err) {
    return { ok: false, status: 500, payload: null, error: err.message || String(err) };
  }
}

function buildTransactionPayload(body, mode) {
  const source = body.payload && typeof body.payload === 'object' ? { ...body.payload, ...body } : body;
  const notes = buildNotes(source);
  const payload = {
    date: normalizeDate(source.date),
    type: mode,
    amount: cleanAmount(source.amount),
    account_id: cleanText(source.account_id || source.from_account_id || source.source_account_id, '', 160),
    category_id: mode === 'transfer' ? null : cleanText(source.category_id || source.category, '', 160),
    notes,
    fee_amount: cleanNonNegativeAmount(source.fee_amount),
    pra_amount: cleanNonNegativeAmount(source.pra_amount),
    created_by: cleanText(source.created_by, 'web-add-orchestrator', 80)
  };
  if (mode === 'transfer') {
    payload.transfer_to_account_id = cleanText(
      source.transfer_to_account_id || source.to_account_id || source.destination_account_id,
      '',
      160
    );
  }
  return payload;
}

function buildAdvisoryPayload(body, mode) {
  return {
    mode,
    date: normalizeDate(body.date),
    amount: cleanAmount(body.amount),
    account_id: cleanText(body.account_id || body.from_account_id, '', 160),
    transfer_to_account_id: cleanText(body.transfer_to_account_id || body.to_account_id || body.destination_account_id, '', 160),
    category_id: cleanText(body.category_id || body.category, '', 160),
    merchant: cleanText(body.merchant || body.source || body.person, '', 120),
    reference: cleanText(body.reference || body.ref, '', 120),
    notes: cleanText(body.notes || body.memo || body.description, '', 240)
  };
}

function buildNotes(source) {
  const parts = [];
  const merchant = cleanText(source.merchant || source.source || source.person, '', 120);
  const reference = cleanText(source.reference || source.ref, '', 120);
  const notes = cleanText(source.notes || source.memo || source.description, '', 200);
  if (merchant) parts.push(merchant);
  if (reference) parts.push('ref=' + reference);
  if (notes) parts.push(notes);
  return parts.join(' | ').slice(0, 200);
}

function expectedEffects(payload) {
  if (payload.type === 'transfer') {
    return [
      { target: payload.account_id || 'source account', direction: 'decrease', amount: payload.amount },
      { target: payload.transfer_to_account_id || 'destination account', direction: 'increase', amount: payload.amount }
    ];
  }
  if (payload.type === 'income') {
    return [{ target: payload.account_id || 'source account', direction: 'increase', amount: payload.amount }];
  }
  return [{ target: payload.account_id || 'source account', direction: 'decrease', amount: payload.amount }];
}

function expectedWritesFromProof(proof) {
  if (!proof) return [];
  return [{ model: proof.write_model || 'transaction', transaction_rows: proof.expected_transaction_rows ?? null, audit_rows: proof.expected_audit_rows ?? null }];
}

function previewWarnings(payload) {
  const warnings = [];
  if (!payload.account_id) warnings.push('Source account is required.');
  if (!payload.amount || payload.amount <= 0) warnings.push('Amount must be greater than zero.');
  if (payload.type === 'transfer' && !payload.transfer_to_account_id) warnings.push('Destination account is required for transfer.');
  if (payload.type === 'transfer' && payload.account_id && payload.transfer_to_account_id && payload.account_id === payload.transfer_to_account_id) {
    warnings.push('Source and destination accounts cannot match.');
  }
  if (payload.type !== 'transfer' && !payload.category_id) {
    warnings.push('Category is required for expense/income. Backend may canonicalize aliases.');
  }
  return warnings;
}

function previewSuggestions(body, mode) {
  const suggestions = [];
  const merchant = cleanText(body.merchant || body.source || body.person, '', 120);
  const amount = Number(body.amount);
  if (merchant) {
    suggestions.push({ type: 'merchant_lookup', label: 'Merchant suggestion available', detail: 'Frontend may match this against /api/merchants context.' });
  }
  if ((mode === 'income' || mode === 'salary_income') && Number.isFinite(amount) && amount > 50000) {
    suggestions.push({ type: 'salary_detector', label: 'Possible salary income', detail: 'Record income here; update salary source only from Salary page unless explicitly implemented.' });
  }
  return suggestions;
}

async function hashPayload(value) {
  const canonical = canonicalJSONString(value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function canonicalJSONString(value) { return JSON.stringify(sortKeys(value)); }
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => { acc[key] = sortKeys(value[key]); return acc; }, {});
  }
  return value;
}

function normalizePath(path) {
  if (!path) return [];
  if (Array.isArray(path)) return path;
  return [path];
}

function normalizeMode(value) {
  const raw = token(value || 'expense');
  if (raw === 'salary') return 'salary_income';
  if (raw === 'manual_income') return 'income';
  if (raw === 'international') return 'international_purchase';
  if (raw === 'bill') return 'bill_payment';
  if (raw === 'debt_out') return 'debt_given';
  if (raw === 'debt_in') return 'debt_received';
  if (raw === 'credit_card_payment') return 'cc_payment';
  if (raw === 'credit_card_spend') return 'cc_spend';
  if (raw === 'atm') return 'atm_withdrawal';
  return raw;
}

function normalizeDate(value) {
  const raw = cleanText(value, '', 40);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function cleanAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function cleanNonNegativeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 100) / 100;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function token(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function unwrapArray(payload, keys) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data) {
    if (Array.isArray(payload.data)) return payload.data;
    for (const key of keys) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return [];
}

function copyHeader(from, to, key) {
  const value = from.get(key);
  if (value) to.set(key, value);
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}