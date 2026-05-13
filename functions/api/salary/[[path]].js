/* /api/salary
 * Sovereign Finance · Salary Truth Engine
 * v0.3.0-sheet-parity-hardening
 *
 * Corporate-grade rules:
 * - /api/salary is the only salary truth contract.
 * - No ledger writes from salary.
 * - Salary received status is ledger-backed, read-only.
 * - Forecast consumes forecast_eligible_monthly.
 * - Variable income excluded unless variable_confirmed=true.
 * - Sheet parity with Finance_Salary.gs v1.6 defaults.
 */

const VERSION = 'v0.3.0-sheet-parity-hardening';

const DEFAULTS = {
  id: 'primary',
  employee_id: '113389',
  designation: 'Technical Support Specialist · CSP · Lahore',
  employer: 'ABS-Labs (Private) Limited',
  join_date: '2025-04-14',
  currency: 'PKR',
  pay_frequency: 'monthly',
  pay_day: 1,
  lands_in_account_id: 'meezan',
  lands_in_account_label: 'Meezan',

  basic: 74226,
  hra: 25979,
  medical: 7423,
  utility: 3705,

  wfh_usd: 30,
  wfh_fx_rate: 279.233333,
  wfh_allowance: 8377,
  include_wfh: true,

  overtime_days: 3,
  overtime_rate: 7000,
  mbo: 37500,
  referral_bonus: 0,
  spot_bonus: 0,
  kitty: 0,
  other_extra: 0,
  include_one_off_extras: false,
  variable_confirmed: false,

  tax_rate_pct: 2.75,

  fy_taxable: 1526636,
  fy_tax_total: 41930,
  fy_tax_paid: 39139,
  fy_tax_remaining: 2791,
  fy_effective_pct: 2.75,

  ytd_gross_total: 1281713,
  ytd_mbo: 94856,
  ytd_referral: 30000,
  ytd_spot: 6182,
  ytd_overtime: 72837,

  march_2026_basic: 74226,
  march_2026_hra: 25979,
  march_2026_medical: 7423,
  march_2026_utility: 3705,
  march_2026_contract_base: 111333,
  march_2026_wfh: 8377,
  march_2026_overtime: 7183,
  march_2026_gross: 126893,
  march_2026_tax_income: 930,
  march_2026_tax_variable: 1712,
  march_2026_eobi: 400,
  march_2026_deductions: 3042,
  march_2026_net: 123851,

  autodetect_account_id: 'meezan',
  autodetect_tolerance_pct: 10,

  notes: ''
};

export async function onRequestGet(context) {
  try {
    const db = context.env?.DB || null;
    const url = new URL(context.request.url);
    const month = normalizeMonth(url.searchParams.get('month')) || currentMonth();

    const stored = db ? await readSalaryRow(db) : null;
    const profile = normalizeProfile(stored || DEFAULTS);
    const computed = computeSalary(profile);
    const detection = db
      ? await detectSalaryForMonth(db, profile, computed, month)
      : emptyDetection(month, profile, computed, 'D1 unavailable');

    return json({
      ok: true,
      version: VERSION,
      schema_version: 'salary.v3',

      salary: buildSalaryObject(profile, computed),
      salary_truth: buildSalaryTruth(profile, computed),

      current_month: detection.current_month,
      detection: detection.detection,
      candidates: detection.candidates,
      history: detection.history,

      guaranteed_monthly: computed.guaranteed_net_monthly,
      variable_monthly: computed.variable_net_monthly,
      variable_confirmed: Boolean(profile.variable_confirmed),
      forecast_eligible_monthly: computed.forecast_eligible_monthly,

      contract: {
        source_of_truth: '/api/salary',
        sheet_source: 'Finance_Salary.gs v1.6',
        forecast_rule: 'guaranteed_net_monthly + variable_net_monthly only when variable_confirmed=true',
        ledger_rule: 'Salary received status is read-only and backed by /api/transactions rows.',
        write_rule: 'Salary API writes salary configuration only. It never writes ledger transactions.',
        add_salary_rule: 'Use Add/Transactions dry-run to create salary income rows.',
        command_centre_used: false
      },

      proof: buildReadProof(profile, computed, detection)
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env?.DB || null;
    if (!db) throw new Error('D1 binding DB is missing.');

    const url = new URL(context.request.url);
    const body = await readJson(context.request);
    const dryRun = isDryRun(url, body);

    const existing = await readSalaryRow(db);
    const normalized = normalizeProfileFromBody(body, existing || DEFAULTS);
    const computed = computeSalary(normalized);
    const validation = validateProfile(normalized, computed);

    if (!validation.ok) {
      return json({
        ok: false,
        version: VERSION,
        dry_run: dryRun,
        action: 'salary.config.save',
        error: validation.error,
        details: validation.details || null,
        normalized_payload: normalized
      }, validation.status || 400);
    }

    const payloadHash = await hashPayload({
      route: 'salary.config.save',
      normalized_payload: normalizeForHash(normalized)
    });

    const proof = buildWriteProof(normalized, computed, payloadHash);

    if (dryRun) {
      return json({
        ok: true,
        version: VERSION,
        dry_run: true,
        action: 'salary.config.save',
        writes_performed: false,
        audit_performed: false,
        payload_hash: payloadHash,
        salary: buildSalaryObject(normalized, computed),
        salary_truth: buildSalaryTruth(normalized, computed),
        guaranteed_monthly: computed.guaranteed_net_monthly,
        variable_monthly: computed.variable_net_monthly,
        variable_confirmed: Boolean(normalized.variable_confirmed),
        forecast_eligible_monthly: computed.forecast_eligible_monthly,
        proof,
        normalized_payload: normalized
      });
    }

    await ensureSalaryTable(db);

    const row = rowForStorage(normalized);
    await upsertSalaryRow(db, row);

    const saved = normalizeProfile(await readSalaryRow(db));
    const savedComputed = computeSalary(saved);

    return json({
      ok: true,
      version: VERSION,
      dry_run: false,
      action: 'salary.config.save',
      writes_performed: true,
      audit_performed: false,
      payload_hash: payloadHash,

      salary: buildSalaryObject(saved, savedComputed),
      salary_truth: buildSalaryTruth(saved, savedComputed),

      guaranteed_monthly: savedComputed.guaranteed_net_monthly,
      variable_monthly: savedComputed.variable_net_monthly,
      variable_confirmed: Boolean(saved.variable_confirmed),
      forecast_eligible_monthly: savedComputed.forecast_eligible_monthly,

      proof: buildWriteProof(saved, savedComputed, payloadHash)
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      error: err.message || String(err)
    }, 500);
  }
}

/* ─────────────────────────────
 * Salary profile / computation
 * ───────────────────────────── */

function normalizeProfile(row) {
  const profile = {
    id: clean(row.id || DEFAULTS.id, 80),
    employee_id: clean(row.employee_id || DEFAULTS.employee_id, 80),
    designation: clean(row.designation || DEFAULTS.designation, 180),
    employer: clean(row.employer || DEFAULTS.employer, 180),
    join_date: normalizeDate(row.join_date) || DEFAULTS.join_date,
    currency: clean(row.currency || DEFAULTS.currency, 12).toUpperCase(),
    pay_frequency: clean(row.pay_frequency || DEFAULTS.pay_frequency, 40).toLowerCase(),
    pay_day: clampInt(row.pay_day, 1, 31, DEFAULTS.pay_day),
    lands_in_account_id: clean(row.lands_in_account_id || DEFAULTS.lands_in_account_id, 120),
    lands_in_account_label: clean(row.lands_in_account_label || DEFAULTS.lands_in_account_label, 160),

    basic: moneyNumber(row.basic, DEFAULTS.basic),
    hra: moneyNumber(row.hra, DEFAULTS.hra),
    medical: moneyNumber(row.medical, DEFAULTS.medical),
    utility: moneyNumber(row.utility, DEFAULTS.utility),

    wfh_usd: moneyNumber(row.wfh_usd, DEFAULTS.wfh_usd),
    wfh_fx_rate: numberOr(row.wfh_fx_rate, DEFAULTS.wfh_fx_rate),
    wfh_allowance: moneyNumber(row.wfh_allowance, DEFAULTS.wfh_allowance),
    include_wfh: bool(row.include_wfh, DEFAULTS.include_wfh),

    overtime_days: numberOr(row.overtime_days, DEFAULTS.overtime_days),
    overtime_rate: moneyNumber(row.overtime_rate, DEFAULTS.overtime_rate),
    mbo: moneyNumber(row.mbo, DEFAULTS.mbo),
    referral_bonus: moneyNumber(row.referral_bonus, DEFAULTS.referral_bonus),
    spot_bonus: moneyNumber(row.spot_bonus, DEFAULTS.spot_bonus),
    kitty: moneyNumber(row.kitty, DEFAULTS.kitty),
    other_extra: moneyNumber(row.other_extra, DEFAULTS.other_extra),
    include_one_off_extras: bool(row.include_one_off_extras, DEFAULTS.include_one_off_extras),
    variable_confirmed: bool(row.variable_confirmed, DEFAULTS.variable_confirmed),

    tax_rate_pct: numberOr(row.tax_rate_pct, DEFAULTS.tax_rate_pct),

    fy_taxable: moneyNumber(row.fy_taxable, DEFAULTS.fy_taxable),
    fy_tax_total: moneyNumber(row.fy_tax_total, DEFAULTS.fy_tax_total),
    fy_tax_paid: moneyNumber(row.fy_tax_paid, DEFAULTS.fy_tax_paid),
    fy_tax_remaining: moneyNumber(row.fy_tax_remaining, DEFAULTS.fy_tax_remaining),
    fy_effective_pct: numberOr(row.fy_effective_pct, DEFAULTS.fy_effective_pct),

    ytd_gross_total: moneyNumber(row.ytd_gross_total, DEFAULTS.ytd_gross_total),
    ytd_mbo: moneyNumber(row.ytd_mbo, DEFAULTS.ytd_mbo),
    ytd_referral: moneyNumber(row.ytd_referral, DEFAULTS.ytd_referral),
    ytd_spot: moneyNumber(row.ytd_spot, DEFAULTS.ytd_spot),
    ytd_overtime: moneyNumber(row.ytd_overtime, DEFAULTS.ytd_overtime),

    march_2026_basic: moneyNumber(row.march_2026_basic, DEFAULTS.march_2026_basic),
    march_2026_hra: moneyNumber(row.march_2026_hra, DEFAULTS.march_2026_hra),
    march_2026_medical: moneyNumber(row.march_2026_medical, DEFAULTS.march_2026_medical),
    march_2026_utility: moneyNumber(row.march_2026_utility, DEFAULTS.march_2026_utility),
    march_2026_contract_base: moneyNumber(row.march_2026_contract_base, DEFAULTS.march_2026_contract_base),
    march_2026_wfh: moneyNumber(row.march_2026_wfh, DEFAULTS.march_2026_wfh),
    march_2026_overtime: moneyNumber(row.march_2026_overtime, DEFAULTS.march_2026_overtime),
    march_2026_gross: moneyNumber(row.march_2026_gross, DEFAULTS.march_2026_gross),
    march_2026_tax_income: moneyNumber(row.march_2026_tax_income, DEFAULTS.march_2026_tax_income),
    march_2026_tax_variable: moneyNumber(row.march_2026_tax_variable, DEFAULTS.march_2026_tax_variable),
    march_2026_eobi: moneyNumber(row.march_2026_eobi, DEFAULTS.march_2026_eobi),
    march_2026_deductions: moneyNumber(row.march_2026_deductions, DEFAULTS.march_2026_deductions),
    march_2026_net: moneyNumber(row.march_2026_net, DEFAULTS.march_2026_net),

    autodetect_account_id: clean(row.autodetect_account_id || DEFAULTS.autodetect_account_id, 120),
    autodetect_tolerance_pct: numberOr(row.autodetect_tolerance_pct, DEFAULTS.autodetect_tolerance_pct),

    notes: clean(row.notes || DEFAULTS.notes, 1000),
    updated_at: row.updated_at || null
  };

  if (!profile.currency || !/^[A-Z]{3}$/.test(profile.currency)) profile.currency = 'PKR';
  if (!['monthly', 'weekly', 'biweekly', 'yearly', 'custom'].includes(profile.pay_frequency)) {
    profile.pay_frequency = 'monthly';
  }

  return profile;
}

function normalizeProfileFromBody(body, base) {
  const merged = {
    ...base,

    employee_id: body.employee_id ?? base.employee_id,
    designation: body.designation ?? base.designation,
    employer: body.employer ?? base.employer,
    join_date: body.join_date ?? base.join_date,
    currency: body.currency ?? base.currency,
    pay_frequency: body.pay_frequency ?? base.pay_frequency,
    pay_day: body.pay_day ?? base.pay_day,
    lands_in_account_id: body.lands_in_account_id ?? body.account_id ?? base.lands_in_account_id,
    lands_in_account_label: body.lands_in_account_label ?? base.lands_in_account_label,

    basic: body.basic ?? body.basic_salary ?? base.basic,
    hra: body.hra ?? body.house_rent_allowance ?? base.hra,
    medical: body.medical ?? body.medical_allowance ?? base.medical,
    utility: body.utility ?? body.utility_allowance ?? base.utility,

    wfh_usd: body.wfh_usd ?? base.wfh_usd,
    wfh_fx_rate: body.wfh_fx_rate ?? body.fx_rate ?? base.wfh_fx_rate,
    wfh_allowance: body.wfh_allowance ?? body.guaranteed_wfh_allowance ?? base.wfh_allowance,
    include_wfh: body.include_wfh ?? base.include_wfh,

    overtime_days: body.overtime_days ?? body.ot_days ?? base.overtime_days,
    overtime_rate: body.overtime_rate ?? body.ot_rate ?? base.overtime_rate,
    mbo: body.mbo ?? body.variable_mbo ?? base.mbo,
    referral_bonus: body.referral_bonus ?? body.variable_bonus ?? base.referral_bonus,
    spot_bonus: body.spot_bonus ?? base.spot_bonus,
    kitty: body.kitty ?? base.kitty,
    other_extra: body.other_extra ?? body.variable_other ?? base.other_extra,
    include_one_off_extras: body.include_one_off_extras ?? base.include_one_off_extras,
    variable_confirmed: body.variable_confirmed ?? base.variable_confirmed,

    tax_rate_pct: body.tax_rate_pct ?? base.tax_rate_pct,

    notes: body.notes ?? base.notes
  };

  return normalizeProfile(merged);
}

function computeSalary(profile) {
  const contractBase = round2(profile.basic + profile.hra + profile.medical + profile.utility);
  const wfhAllowance = profile.include_wfh
    ? round2(profile.wfh_allowance || (profile.wfh_usd * profile.wfh_fx_rate))
    : 0;

  const overtime = round2(profile.overtime_days * profile.overtime_rate);
  const oneOffExtras = profile.include_one_off_extras
    ? round2(profile.referral_bonus + profile.spot_bonus + profile.kitty + profile.other_extra)
    : 0;

  const variableGross = round2(overtime + profile.mbo + oneOffExtras);
  const guaranteedGross = round2(contractBase + wfhAllowance);
  const totalGross = round2(guaranteedGross + variableGross);

  const guaranteedTax = round2(guaranteedGross * pct(profile.tax_rate_pct));
  const estimatedTax = round2(totalGross * pct(profile.tax_rate_pct));

  const guaranteedNet = round2(guaranteedGross - guaranteedTax);
  const netLanding = round2(totalGross - estimatedTax);
  const variableNet = round2(Math.max(0, netLanding - guaranteedNet));

  const forecastEligible = profile.variable_confirmed
    ? netLanding
    : guaranteedNet;

  const leanBaseline = round2(guaranteedGross - guaranteedTax);

  return {
    contract_base: contractBase,
    wfh_allowance: wfhAllowance,
    overtime,
    one_off_extras: oneOffExtras,
    variable_gross_monthly: variableGross,
    guaranteed_gross_monthly: guaranteedGross,
    total_gross_monthly: totalGross,
    guaranteed_tax_monthly: guaranteedTax,
    estimated_tax_monthly: estimatedTax,
    guaranteed_net_monthly: guaranteedNet,
    variable_net_monthly: variableNet,
    net_landing: netLanding,
    forecast_eligible_monthly: round2(forecastEligible),
    lean_baseline: leanBaseline,
    effective_tax_pct: profile.tax_rate_pct,
    anchors: [
      {
        id: 1,
        key: 'forecast_net',
        label: 'Forecast Net',
        amount: netLanding
      },
      {
        id: 2,
        key: 'lean_baseline',
        label: 'Lean baseline',
        amount: leanBaseline
      },
      {
        id: 3,
        key: 'march_historical',
        label: 'March historical',
        amount: profile.march_2026_net
      }
    ].filter(anchor => Number.isFinite(anchor.amount) && anchor.amount > 0)
  };
}

function buildSalaryObject(profile, computed) {
  return {
    id: profile.id,
    employee_id: profile.employee_id,
    designation: profile.designation,
    employer: profile.employer,
    join_date: profile.join_date,
    currency: profile.currency,
    pay_frequency: profile.pay_frequency,
    pay_day: profile.pay_day,
    lands_in_account_id: profile.lands_in_account_id,
    lands_in_account_label: profile.lands_in_account_label,

    basic: profile.basic,
    hra: profile.hra,
    medical: profile.medical,
    utility: profile.utility,
    contract_base: computed.contract_base,

    wfh_usd: profile.wfh_usd,
    wfh_fx_rate: profile.wfh_fx_rate,
    wfh_allowance: computed.wfh_allowance,
    include_wfh: profile.include_wfh,

    overtime_days: profile.overtime_days,
    overtime_rate: profile.overtime_rate,
    overtime: computed.overtime,
    mbo: profile.mbo,
    referral_bonus: profile.referral_bonus,
    spot_bonus: profile.spot_bonus,
    kitty: profile.kitty,
    other_extra: profile.other_extra,
    include_one_off_extras: profile.include_one_off_extras,

    variable_gross_monthly: computed.variable_gross_monthly,
    guaranteed_gross_monthly: computed.guaranteed_gross_monthly,
    total_gross_monthly: computed.total_gross_monthly,

    tax_rate_pct: profile.tax_rate_pct,
    estimated_tax_monthly: computed.estimated_tax_monthly,
    guaranteed_tax_monthly: computed.guaranteed_tax_monthly,

    guaranteed_monthly: computed.guaranteed_net_monthly,
    variable_monthly: computed.variable_net_monthly,
    variable_confirmed: profile.variable_confirmed,
    forecast_eligible_monthly: computed.forecast_eligible_monthly,
    net_landing: computed.net_landing,

    notes: profile.notes,
    updated_at: profile.updated_at
  };
}

function buildSalaryTruth(profile, computed) {
  return {
    expected_net: computed.forecast_eligible_monthly,
    forecast_net: computed.net_landing,
    guaranteed_net: computed.guaranteed_net_monthly,
    variable_net: computed.variable_net_monthly,
    currency: profile.currency,
    expected_account_id: profile.lands_in_account_id,
    expected_account_label: profile.lands_in_account_label,
    employer: profile.employer,
    payday: {
      day: profile.pay_day,
      frequency: profile.pay_frequency
    },
    tolerance_pct: profile.autodetect_tolerance_pct,
    anchors: computed.anchors
  };
}

/* ─────────────────────────────
 * Salary detection
 * ───────────────────────────── */

async function detectSalaryForMonth(db, profile, computed, month) {
  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('account_id')) {
    return emptyDetection(month, profile, computed, 'transactions.account_id missing');
  }

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'category_id',
    'notes',
    'reversed_by',
    'reversed_at',
    'created_at'
  ].filter(col => txCols.has(col));

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE date >= ?
       AND date < ?
     ORDER BY date DESC, ${txCols.has('created_at') ? 'datetime(created_at) DESC,' : ''} id DESC`
  ).bind(month + '-01', nextMonth(month) + '-01').all();

  const candidates = [];
  const allRows = result.results || [];

  for (const row of allRows) {
    if (isInactiveTransaction(row)) continue;

    const accountId = clean(row.account_id, 120).toLowerCase();
    const expectedAccount = clean(profile.autodetect_account_id || profile.lands_in_account_id, 120).toLowerCase();

    if (accountId !== expectedAccount) continue;

    const type = clean(row.type, 40).toLowerCase();
    if (type !== 'income' && type !== 'salary' && type !== 'manual_income') continue;

    const amount = rowAmount(row);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const match = bestAnchorMatch(amount, computed.anchors, profile.autodetect_tolerance_pct);

    candidates.push({
      id: row.id,
      date: row.date,
      type: row.type,
      account_id: row.account_id,
      category_id: row.category_id || null,
      amount,
      notes: row.notes || '',
      matched: Boolean(match),
      match,
      confidence: match ? confidenceFromVariance(match.variance_pct) : 'none'
    });
  }

  const matched = candidates.filter(candidate => candidate.matched);
  const best = matched.slice().sort((a, b) => a.match.variance_pct - b.match.variance_pct)[0] || null;

  let status = 'pending';
  let received = 0;
  let variance = round2(0 - computed.forecast_eligible_monthly);

  if (matched.length === 1) {
    received = matched[0].amount;
    variance = round2(received - computed.forecast_eligible_monthly);

    if (received < computed.forecast_eligible_monthly * 0.9) status = 'partial';
    else if (received > computed.forecast_eligible_monthly * 1.1) status = 'overpaid';
    else status = 'received';
  } else if (matched.length > 1) {
    received = round2(matched.reduce((sum, row) => sum + row.amount, 0));
    variance = round2(received - computed.forecast_eligible_monthly);
    status = 'ambiguous';
  }

  return {
    current_month: {
      month,
      status,
      expected: computed.forecast_eligible_monthly,
      forecast_net: computed.net_landing,
      received,
      variance,
      candidate_transaction_ids: matched.map(row => row.id),
      best_match: best,
      confidence: best ? best.confidence : 'none'
    },
    detection: {
      account_id: profile.autodetect_account_id || profile.lands_in_account_id,
      tolerance_pct: profile.autodetect_tolerance_pct,
      anchors: computed.anchors,
      rule: 'account + income type + active row + best anchor within tolerance'
    },
    candidates,
    history: []
  };
}

function emptyDetection(month, profile, computed, reason) {
  return {
    current_month: {
      month,
      status: 'unknown',
      expected: computed.forecast_eligible_monthly,
      forecast_net: computed.net_landing,
      received: 0,
      variance: round2(0 - computed.forecast_eligible_monthly),
      candidate_transaction_ids: [],
      best_match: null,
      confidence: 'none',
      reason
    },
    detection: {
      account_id: profile.autodetect_account_id || profile.lands_in_account_id,
      tolerance_pct: profile.autodetect_tolerance_pct,
      anchors: computed.anchors,
      rule: 'unavailable'
    },
    candidates: [],
    history: []
  };
}

function bestAnchorMatch(amount, anchors, tolerancePct) {
  const tolerance = Number(tolerancePct || 0);

  let best = null;

  for (const anchor of anchors || []) {
    if (!anchor || !Number.isFinite(anchor.amount) || anchor.amount <= 0) continue;

    const variancePct = round2(Math.abs(amount - anchor.amount) / anchor.amount * 100);

    if (variancePct <= tolerance) {
      const match = {
        anchor_id: anchor.id,
        anchor_key: anchor.key,
        anchor_label: anchor.label,
        anchor_amount: anchor.amount,
        variance_pct: variancePct,
        delta: round2(amount - anchor.amount)
      };

      if (!best || match.variance_pct < best.variance_pct) {
        best = match;
      }
    }
  }

  return best;
}

function confidenceFromVariance(variancePct) {
  const v = Number(variancePct);
  if (v <= 2) return 'high';
  if (v <= 5) return 'medium';
  return 'low';
}

function isInactiveTransaction(row) {
  const notes = String(row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function rowAmount(row) {
  const pkr = Number(row.pkr_amount);
  if (Number.isFinite(pkr) && pkr !== 0) return round2(pkr);

  const amount = Number(row.amount);
  if (Number.isFinite(amount)) return round2(amount);

  return 0;
}

/* ─────────────────────────────
 * Validation / proof
 * ───────────────────────────── */

function validateProfile(profile, computed) {
  const nonNegative = [
    'basic',
    'hra',
    'medical',
    'utility',
    'wfh_usd',
    'wfh_fx_rate',
    'wfh_allowance',
    'overtime_days',
    'overtime_rate',
    'mbo',
    'referral_bonus',
    'spot_bonus',
    'kitty',
    'other_extra',
    'tax_rate_pct'
  ];

  for (const key of nonNegative) {
    if (!Number.isFinite(Number(profile[key])) || Number(profile[key]) < 0) {
      return {
        ok: false,
        status: 400,
        error: key + ' must be a non-negative number'
      };
    }
  }

  if (computed.contract_base <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'Contract base must be greater than zero'
    };
  }

  if (computed.forecast_eligible_monthly <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'Forecast eligible salary must be greater than zero'
    };
  }

  if (!/^[A-Z]{3}$/.test(profile.currency)) {
    return {
      ok: false,
      status: 400,
      error: 'currency must be a valid 3-letter code'
    };
  }

  return { ok: true };
}

function buildReadProof(profile, computed, detection) {
  return {
    action: 'salary.read',
    version: VERSION,
    source_of_truth: '/api/salary',
    sheet_source: 'Finance_Salary.gs v1.6',
    writes_performed: false,
    checks: [
      proofCheck('contract_base_valid', 'pass', 'salary.components', 'Basic + HRA + Medical + Utility = ' + computed.contract_base),
      proofCheck('forecast_rule_valid', 'pass', 'salary.forecast', profile.variable_confirmed ? 'Variable included.' : 'Variable excluded.'),
      proofCheck('detection_rule_loaded', 'pass', 'transactions', detection.detection.rule),
      proofCheck('ledger_write_blocked', 'pass', 'salary.contract', 'Salary API does not write transactions.')
    ]
  };
}

function buildWriteProof(profile, computed, payloadHash) {
  return {
    action: 'salary.config.save',
    version: VERSION,
    payload_hash: payloadHash,
    writes_performed: false,
    audit_performed: false,
    write_model: 'salary_config_only',
    expected_salary_rows: 1,
    expected_transaction_rows: 0,
    expected_ledger_rows: 0,
    checks: [
      proofCheck('schema_safe', 'pass', 'D1.salary_config', 'Table and columns are created/added safely.'),
      proofCheck('amounts_valid', 'pass', 'request.salary_components', 'All salary amounts are non-negative.'),
      proofCheck('forecast_rule_valid', 'pass', 'computed.forecast_eligible_monthly', profile.variable_confirmed ? 'Guaranteed + variable net.' : 'Guaranteed net only.'),
      proofCheck('no_ledger_write', 'pass', 'api.contract', 'This endpoint never writes salary income transactions.')
    ],
    computed_summary: {
      contract_base: computed.contract_base,
      guaranteed_net_monthly: computed.guaranteed_net_monthly,
      variable_net_monthly: computed.variable_net_monthly,
      net_landing: computed.net_landing,
      forecast_eligible_monthly: computed.forecast_eligible_monthly
    }
  };
}

function proofCheck(check, status, source, detail) {
  return { check, status, source, detail };
}

/* ─────────────────────────────
 * D1 storage
 * ───────────────────────────── */

async function ensureSalaryTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS salary_config (
      id TEXT PRIMARY KEY,
      guaranteed_monthly REAL NOT NULL DEFAULT 0,
      variable_monthly REAL NOT NULL DEFAULT 0,
      variable_confirmed INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const columns = {
    employee_id: 'TEXT',
    designation: 'TEXT',
    employer: 'TEXT',
    join_date: 'TEXT',
    currency: 'TEXT',
    pay_frequency: 'TEXT',
    pay_day: 'INTEGER',
    lands_in_account_id: 'TEXT',
    lands_in_account_label: 'TEXT',

    basic: 'REAL',
    hra: 'REAL',
    medical: 'REAL',
    utility: 'REAL',

    wfh_usd: 'REAL',
    wfh_fx_rate: 'REAL',
    wfh_allowance: 'REAL',
    include_wfh: 'INTEGER',

    overtime_days: 'REAL',
    overtime_rate: 'REAL',
    mbo: 'REAL',
    referral_bonus: 'REAL',
    spot_bonus: 'REAL',
    kitty: 'REAL',
    other_extra: 'REAL',
    include_one_off_extras: 'INTEGER',

    tax_rate_pct: 'REAL',

    fy_taxable: 'REAL',
    fy_tax_total: 'REAL',
    fy_tax_paid: 'REAL',
    fy_tax_remaining: 'REAL',
    fy_effective_pct: 'REAL',

    ytd_gross_total: 'REAL',
    ytd_mbo: 'REAL',
    ytd_referral: 'REAL',
    ytd_spot: 'REAL',
    ytd_overtime: 'REAL',

    march_2026_basic: 'REAL',
    march_2026_hra: 'REAL',
    march_2026_medical: 'REAL',
    march_2026_utility: 'REAL',
    march_2026_contract_base: 'REAL',
    march_2026_wfh: 'REAL',
    march_2026_overtime: 'REAL',
    march_2026_gross: 'REAL',
    march_2026_tax_income: 'REAL',
    march_2026_tax_variable: 'REAL',
    march_2026_eobi: 'REAL',
    march_2026_deductions: 'REAL',
    march_2026_net: 'REAL',

    autodetect_account_id: 'TEXT',
    autodetect_tolerance_pct: 'REAL'
  };

  for (const [name, type] of Object.entries(columns)) {
    await safeAddColumn(db, 'salary_config', name, type);
  }
}

async function safeAddColumn(db, table, column, type) {
  const cols = await tableColumns(db, table);
  if (cols.has(column)) return;

  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    // Column may have been added by another request; safe to ignore.
  }
}

async function readSalaryRow(db) {
  try {
    await ensureSalaryTable(db);

    const row = await db.prepare(`
      SELECT *
      FROM salary_config
      WHERE id = 'primary'
      LIMIT 1
    `).first();

    return row || null;
  } catch {
    return null;
  }
}

function rowForStorage(profile) {
  const computed = computeSalary(profile);

  return {
    id: 'primary',
    guaranteed_monthly: computed.guaranteed_net_monthly,
    variable_monthly: computed.variable_net_monthly,
    variable_confirmed: profile.variable_confirmed ? 1 : 0,
    notes: profile.notes,
    updated_at: new Date().toISOString(),

    employee_id: profile.employee_id,
    designation: profile.designation,
    employer: profile.employer,
    join_date: profile.join_date,
    currency: profile.currency,
    pay_frequency: profile.pay_frequency,
    pay_day: profile.pay_day,
    lands_in_account_id: profile.lands_in_account_id,
    lands_in_account_label: profile.lands_in_account_label,

    basic: profile.basic,
    hra: profile.hra,
    medical: profile.medical,
    utility: profile.utility,

    wfh_usd: profile.wfh_usd,
    wfh_fx_rate: profile.wfh_fx_rate,
    wfh_allowance: profile.wfh_allowance,
    include_wfh: profile.include_wfh ? 1 : 0,

    overtime_days: profile.overtime_days,
    overtime_rate: profile.overtime_rate,
    mbo: profile.mbo,
    referral_bonus: profile.referral_bonus,
    spot_bonus: profile.spot_bonus,
    kitty: profile.kitty,
    other_extra: profile.other_extra,
    include_one_off_extras: profile.include_one_off_extras ? 1 : 0,

    tax_rate_pct: profile.tax_rate_pct,

    fy_taxable: profile.fy_taxable,
    fy_tax_total: profile.fy_tax_total,
    fy_tax_paid: profile.fy_tax_paid,
    fy_tax_remaining: profile.fy_tax_remaining,
    fy_effective_pct: profile.fy_effective_pct,

    ytd_gross_total: profile.ytd_gross_total,
    ytd_mbo: profile.ytd_mbo,
    ytd_referral: profile.ytd_referral,
    ytd_spot: profile.ytd_spot,
    ytd_overtime: profile.ytd_overtime,

    march_2026_basic: profile.march_2026_basic,
    march_2026_hra: profile.march_2026_hra,
    march_2026_medical: profile.march_2026_medical,
    march_2026_utility: profile.march_2026_utility,
    march_2026_contract_base: profile.march_2026_contract_base,
    march_2026_wfh: profile.march_2026_wfh,
    march_2026_overtime: profile.march_2026_overtime,
    march_2026_gross: profile.march_2026_gross,
    march_2026_tax_income: profile.march_2026_tax_income,
    march_2026_tax_variable: profile.march_2026_tax_variable,
    march_2026_eobi: profile.march_2026_eobi,
    march_2026_deductions: profile.march_2026_deductions,
    march_2026_net: profile.march_2026_net,

    autodetect_account_id: profile.autodetect_account_id,
    autodetect_tolerance_pct: profile.autodetect_tolerance_pct
  };
}

async function upsertSalaryRow(db, row) {
  const keys = Object.keys(row);
  const updateKeys = keys.filter(key => key !== 'id');

  await db.prepare(`
    INSERT INTO salary_config (${keys.join(', ')})
    VALUES (${keys.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${updateKeys.map(key => `${key} = excluded.${key}`).join(', ')}
  `).bind(...keys.map(key => row[key])).run();
}

/* ─────────────────────────────
 * Generic helpers
 * ───────────────────────────── */

async function tableColumns(db, table) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all();
    const set = new Set();

    for (const row of result.results || []) {
      if (row.name) set.add(row.name);
    }

    return set;
  } catch {
    return new Set();
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isDryRun(url, body) {
  return url.searchParams.get('dry_run') === '1' ||
    url.searchParams.get('dry_run') === 'true' ||
    body.dry_run === true ||
    body.dry_run === '1' ||
    body.dry_run === 'true';
}

function normalizeForHash(profile) {
  const copy = { ...profile };
  delete copy.updated_at;
  return copy;
}

async function hashPayload(value) {
  const canonical = JSON.stringify(sortKeys(value));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);

  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }

  return value;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function normalizeMonth(value) {
  const raw = clean(value, 20);
  return /^\d{4}-\d{2}$/.test(raw) ? raw : null;
}

function nextMonth(month) {
  const [year, mon] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, mon, 1));
  return d.toISOString().slice(0, 7);
}

function normalizeDate(value) {
  const raw = clean(value, 40);
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  return raw.slice(0, 10);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function moneyNumber(value, fallback) {
  return round2(numberOr(value, fallback));
}

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return Number(fallback || 0);
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number(fallback || 0);

  const cleaned = String(value)
    .replace(/rs/ig, '')
    .replace(/,/g, '')
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number(fallback || 0);
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'confirmed', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;

  return Boolean(fallback);
}

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache'
    }
  });
}