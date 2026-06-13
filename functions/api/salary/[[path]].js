/* /api/salary/[[path]]
 * Sovereign Finance · Salary & Payslips
 * v1.0.0-salary-payslips
 *
 * Actions (POST body.action):
 *   create_contract  – employer-based salary contract
 *   add_payslip      – monthly payslip + ledger income transaction
 *   update_contract  – update non-amount fields
 *   archive_contract – set status='archived'
 *   forecast_period  – N-month income projection
 *   update_config    – update salary_config table
 *   (none)           – backward compat legacy POST
 *
 * GET /api/salary          – list contracts + computed + payslips
 * GET /api/salary/forecast – 6-month projection
 * GET /api/salary/:id      – contract detail with payslips
 */

import { audit, householdOf } from '../_lib.js';

const VERSION = 'v1.0.0-salary-payslips';
const LEGACY_CONTRACT_ID = 'salary_contract_current';

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);
    if (!db) return dbMissing();
    const hh = householdOf(context);
    if (!hh) return json({ ok: false, version: VERSION, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);

    if (path[0] === 'forecast') return handleForecastGet(db, 6, hh);
    if (path[0] && path[0] !== 'forecast') return handleContractDetail(db, path[0], hh);
    return handleList(db, hh);
  } catch (err) {
    return json({ ok: false, version: VERSION, error: { code: 'GET_FAILED', message: err.message } }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    if (!db) return dbMissing();
    const body = await readJson(context.request);
    const path = getPath(context);
    const action = s(body.action || path[1] || '').toLowerCase();

    const hh  = householdOf(context);
    if (!hh) return json({ ok: false, version: VERSION, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    const uid = context.data?.user_id || null;

    switch (action) {
      case 'create_contract':  return handleCreateContract(db, body, context.env, hh, uid);
      case 'add_payslip':      return handleAddPayslip(db, body, context.env, hh, uid);
      case 'update_contract':  return handleUpdateContract(db, body, context.env, hh);
      case 'archive_contract': return handleArchiveContract(db, body, context.env, hh);
      case 'forecast_period':  return handleForecastPeriod(db, body, hh);
      case 'update_config':    return handleUpdateConfig(db, body);
      default:                 return handleLegacyPost(db, body, hh);
    }
  } catch (err) {
    return json({ ok: false, version: VERSION, error: { code: 'POST_FAILED', message: err.message } }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// ─── GET handlers ─────────────────────────────────────────────────────────────

async function handleList(db, hh) {
  const contractCols = await tableColumns(db, 'salary_contracts');
  const payslipCols  = await tableColumns(db, 'salary_payslips');

  const contracts = await loadContracts(db, contractCols, hh);
  const recentPayslips = payslipCols.has('id') ? await loadRecentPayslips(db, payslipCols, 12, hh) : [];

  const legacyContract = contracts.find(c => c.id === LEGACY_CONTRACT_ID) || contracts[0] || null;
  const normalized = legacyContract ? normalizeLegacy(legacyContract) : null;
  const computed = normalized ? computeSalary(normalized) : emptyComputed();
  const forecastSource = normalized ? buildForecastSource(normalized, computed) : disabledForecastSource('no contract');

  return json({
    ok: true,
    version: VERSION,
    source: 'salary_contract',
    contracts,
    active_contracts: contracts.filter(c => s(c.status) !== 'archived'),
    archived_contracts: contracts.filter(c => s(c.status) === 'archived'),
    payslips: recentPayslips,
    contract: normalized,
    computed,
    forecast_source: forecastSource,
    salary: normalized ? [normalized] : [],
    contract_health: {
      ok: Boolean(normalized),
      saved_contract_exists: Boolean(normalized),
      forecast_enabled: forecastSource.enabled,
    },
  });
}

async function handleContractDetail(db, contractId, hh) {
  const contractCols = await tableColumns(db, 'salary_contracts');
  const payslipCols  = await tableColumns(db, 'salary_payslips');
  const contract = await loadContract(db, contractCols, contractId, hh);
  if (!contract) return json({ ok: false, version: VERSION, error: { code: 'NOT_FOUND', message: 'Contract not found' } }, 404);
  const payslips = payslipCols.has('id') ? await loadContractPayslips(db, payslipCols, contractId) : [];
  return json({ ok: true, version: VERSION, contract, payslips });
}

async function handleForecastGet(db, months, hh) {
  const contractCols = await tableColumns(db, 'salary_contracts');
  const contracts = await loadContracts(db, contractCols, hh);
  const active = contracts.filter(c => s(c.status) !== 'archived');
  return json({ ok: true, version: VERSION, action: 'forecast', months, projections: buildProjections(active, months) });
}

// ─── POST action handlers ─────────────────────────────────────────────────────

async function handleCreateContract(db, body, env, hh, uid) {
  const cols = await tableColumns(db, 'salary_contracts');
  if (!cols.has('id')) return json({ ok: false, version: VERSION, action: 'create_contract', error: 'salary_contracts table missing', code: 'TABLE_MISSING' }, 500);

  const employerName = s(body.employer_name || body.employer || '').slice(0, 200);
  if (!employerName) return json({ ok: false, version: VERSION, action: 'create_contract', error: 'employer_name is required', code: 'EMPLOYER_REQUIRED' }, 400);

  const grossAmount     = moneyInt(body.gross_amount || body.gross || 0);
  const netEstimate     = moneyInt(body.net_amount_estimate || body.net || grossAmount);
  const frequency       = normalizeFrequency(body.frequency);
  const paydayDay       = normalizePayday(body.payday_day || body.payday);
  const depositAccount  = s(body.deposit_account_id || body.payout_account_id || 'meezan').slice(0, 120);
  const startDate       = cleanDate(body.start_date);
  const taxBracket      = s(body.tax_bracket || '').slice(0, 50);
  const currency        = s(body.currency || 'PKR').slice(0, 10);
  const notes           = s(body.notes || '').slice(0, 1000);
  const now             = nowISO();
  const contractId      = makeId('contract');
  const effectiveMonth  = startDate ? startDate.slice(0, 7) : now.slice(0, 7);

  const row = filterToCols(cols, {
    id: contractId,
    employer_name: employerName,
    gross_amount: grossAmount,
    net_amount_estimate: netEstimate,
    frequency,
    payday: paydayDay,
    payday_day: paydayDay,
    deposit_account_id: depositAccount,
    payout_account_id: depositAccount,
    start_date: startDate,
    tax_bracket: taxBracket,
    currency,
    status: 'active',
    notes,
    include_in_forecast: 1,
    basic: grossAmount,
    contract_base: grossAmount,
    deductions: Math.max(0, grossAmount - netEstimate),
    effective_month: effectiveMonth,
    user_id: hh || null,
    owner_user_id: uid || null,
    created_by_user_id: uid || null,
    created_at: now,
    updated_at: now,
  });

  await buildInsert(db, 'salary_contracts', row).run();

  await safeAudit(env, {
    action: 'SALARY_CONTRACT_CREATE',
    entity: 'salary_contract',
    entity_id: contractId,
    kind: 'mutation',
    detail: JSON.stringify({ contract_id: contractId, employer_name: employerName, gross_amount: grossAmount }),
    created_by: 'web-salary',
  });

  return json({
    ok: true,
    version: VERSION,
    action: 'create_contract',
    committed: true,
    writes_performed: true,
    contract_id: contractId,
    data: { id: contractId, employer_name: employerName, gross_amount: grossAmount, net_amount_estimate: netEstimate, frequency, payday_day: paydayDay, deposit_account_id: depositAccount, status: 'active' },
  });
}

async function handleAddPayslip(db, body, env, hh, uid) {
  const payslipCols  = await tableColumns(db, 'salary_payslips');
  const txCols       = await tableColumns(db, 'transactions');

  if (!payslipCols.has('id')) {
    return json({ ok: false, version: VERSION, action: 'add_payslip', error: 'salary_payslips table missing — run migration 18', code: 'TABLE_MISSING' }, 500);
  }

  const contractId      = s(body.contract_id || LEGACY_CONTRACT_ID);
  const period          = cleanPeriod(body.period);
  const gross           = moneyInt(body.gross || body.gross_amount || 0);
  const net             = moneyInt(body.net || body.net_amount || gross);
  const bonus           = moneyInt(body.bonus || 0);
  const depositDate     = cleanDate(body.deposit_date || body.date);
  const depositAccount  = s(body.deposit_account_id || body.account_id || '').slice(0, 120);
  const notes           = s(body.notes || '').slice(0, 1000);
  const components      = JSON.stringify(Array.isArray(body.components) ? body.components : []);
  const deductions      = JSON.stringify(Array.isArray(body.deductions) ? body.deductions : []);

  if (!period) return json({ ok: false, version: VERSION, action: 'add_payslip', error: 'period is required (YYYY-MM)', code: 'PERIOD_REQUIRED' }, 400);
  if (net <= 0)  return json({ ok: false, version: VERSION, action: 'add_payslip', error: 'net amount must be > 0', code: 'INVALID_NET' }, 400);
  if (!depositAccount) return json({ ok: false, version: VERSION, action: 'add_payslip', error: 'deposit_account_id is required', code: 'ACCOUNT_REQUIRED' }, 400);

  const now        = nowISO();
  const payslipId  = makeId('payslip');
  const txnId      = makeId('salaryin');
  const txnNotes   = `[SALARY_INCOME] payslip_id=${payslipId} period=${period} contract_id=${contractId} gross=${gross}`.slice(0, 240);

  const payslipRow = filterToCols(payslipCols, {
    id: payslipId,
    contract_id: contractId,
    period,
    gross,
    net,
    deductions,
    components,
    bonus,
    deposit_date: depositDate,
    deposit_account_id: depositAccount,
    transaction_id: txCols.has('id') ? txnId : null,
    notes,
    user_id: hh || null,
    created_by_user_id: uid || null,
    created_at: now,
    updated_at: now,
  });

  const stmts = [buildInsert(db, 'salary_payslips', payslipRow)];

  if (txCols.has('id') && txCols.has('type') && txCols.has('amount') && txCols.has('account_id')) {
    const txnRow = filterToCols(txCols, {
      id: txnId,
      date: depositDate,
      type: 'income',
      amount: net,
      pkr_amount: net,
      account_id: depositAccount,
      merchant: s(body.employer_name || 'Salary').slice(0, 200),
      notes: txnNotes,
      currency: 'PKR',
      fx_rate_at_commit: 1,
      fx_source: 'PKR-base',
      linked_txn_id: payslipId,
      source_module: 'salary',
      source_id: payslipId,
      source_action: 'payslip_income',
      user_id: hh || null,
      created_by_user_id: uid || null,
      created_by: 'web-salary',
      created_at: now,
      updated_at: now,
    });
    stmts.push(buildInsert(db, 'transactions', txnRow));
  }

  await db.batch(stmts);

  await safeAudit(env, {
    action: 'SALARY_PAYSLIP_ADD',
    entity: 'salary_payslip',
    entity_id: payslipId,
    kind: 'mutation',
    detail: JSON.stringify({ payslip_id: payslipId, contract_id: contractId, period, gross, net, deposit_account_id: depositAccount }),
    created_by: 'web-salary',
  });

  return json({
    ok: true,
    version: VERSION,
    action: 'add_payslip',
    committed: true,
    writes_performed: true,
    payslip_id: payslipId,
    transaction_id: txCols.has('id') ? txnId : null,
    data: { id: payslipId, contract_id: contractId, period, gross, net, deposit_account_id: depositAccount, deposit_date: depositDate },
  });
}

async function handleUpdateContract(db, body, env, hh) {
  const cols = await tableColumns(db, 'salary_contracts');
  const contractId = s(body.contract_id || LEGACY_CONTRACT_ID);
  const hhWhere = (hh && cols.has('user_id')) ? ' AND user_id = ?' : '';
  const hhBinds = (hh && cols.has('user_id')) ? [hh] : [];
  const existing = cols.has('id') ? await db.prepare(`SELECT id FROM salary_contracts WHERE id = ?${hhWhere} LIMIT 1`).bind(contractId, ...hhBinds).first() : null;
  if (!existing) return json({ ok: false, version: VERSION, action: 'update_contract', error: 'Contract not found', code: 'NOT_FOUND' }, 404);

  const updates = {};
  if (body.employer_name !== undefined) updates.employer_name = s(body.employer_name).slice(0, 200);
  if (body.notes         !== undefined) updates.notes         = s(body.notes).slice(0, 1000);
  if (body.frequency     !== undefined) updates.frequency     = normalizeFrequency(body.frequency);
  if (body.tax_bracket   !== undefined) updates.tax_bracket   = s(body.tax_bracket).slice(0, 50);
  if (body.currency      !== undefined) updates.currency      = s(body.currency).slice(0, 10);
  updates.updated_at = nowISO();

  const entries = Object.entries(updates).filter(([k]) => cols.has(k));
  if (entries.length <= 1) return json({ ok: true, version: VERSION, action: 'update_contract', committed: false, writes_performed: false });

  const setSql = entries.map(([k]) => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE salary_contracts SET ${setSql} WHERE id = ?${hhWhere}`).bind(...entries.map(([, v]) => v), contractId, ...hhBinds).run();

  return json({ ok: true, version: VERSION, action: 'update_contract', committed: true, writes_performed: true, contract_id: contractId });
}

async function handleArchiveContract(db, body, env, hh) {
  const cols = await tableColumns(db, 'salary_contracts');
  const contractId = s(body.contract_id || LEGACY_CONTRACT_ID);
  if (!cols.has('status')) return json({ ok: false, version: VERSION, action: 'archive_contract', error: 'status column missing — run migration 18', code: 'COLUMN_MISSING' }, 500);
  const hhWhere = (hh && cols.has('user_id')) ? ' AND user_id = ?' : '';
  const hhBinds = (hh && cols.has('user_id')) ? [hh] : [];
  await db.prepare(`UPDATE salary_contracts SET status = ?, updated_at = ? WHERE id = ?${hhWhere}`).bind('archived', nowISO(), contractId, ...hhBinds).run();
  await safeAudit(env, { action: 'SALARY_CONTRACT_ARCHIVE', entity: 'salary_contract', entity_id: contractId, kind: 'mutation', detail: JSON.stringify({ contract_id: contractId }), created_by: 'web-salary' });
  return json({ ok: true, version: VERSION, action: 'archive_contract', committed: true, writes_performed: true, contract_id: contractId, status: 'archived' });
}

async function handleForecastPeriod(db, body, hh) {
  const months = Math.min(24, Math.max(1, parseInt(body.months || 6, 10) || 6));
  const cols = await tableColumns(db, 'salary_contracts');
  const contracts = await loadContracts(db, cols, hh);
  const active = contracts.filter(c => s(c.status) !== 'archived');
  return json({ ok: true, version: VERSION, action: 'forecast_period', committed: false, writes_performed: false, months, projections: buildProjections(active, months) });
}

async function handleUpdateConfig(db, body) {
  const cols = await tableColumns(db, 'salary_config');
  if (!cols.has('id')) return json({ ok: false, version: VERSION, action: 'update_config', error: 'salary_config table missing — run migration 18', code: 'TABLE_MISSING' }, 500);
  const now  = nowISO();
  const id   = 'salary_config_current';
  const taxRates         = body.tax_rates         ? JSON.stringify(body.tax_rates)         : null;
  const defaultDeductions = body.default_deductions ? JSON.stringify(body.default_deductions) : null;
  const existing = await db.prepare('SELECT id FROM salary_config WHERE id = ? LIMIT 1').bind(id).first();
  if (existing) {
    const sets = []; const vals = [];
    if (taxRates         && cols.has('tax_rates'))          { sets.push('tax_rates = ?');          vals.push(taxRates); }
    if (defaultDeductions && cols.has('default_deductions')) { sets.push('default_deductions = ?'); vals.push(defaultDeductions); }
    sets.push('updated_at = ?'); vals.push(now);
    await db.prepare(`UPDATE salary_config SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  } else {
    const row = filterToCols(cols, { id, tax_rates: taxRates || '{}', default_deductions: defaultDeductions || '[]', updated_at: now });
    await buildInsert(db, 'salary_config', row).run();
  }
  return json({ ok: true, version: VERSION, action: 'update_config', committed: true, writes_performed: true });
}

// ─── Legacy backward-compat POST ──────────────────────────────────────────────

async function handleLegacyPost(db, body, hh) {
  const cols = await tableColumns(db, 'salary_contracts');
  if (!cols.has('id')) return json({ ok: false, version: VERSION, error: { code: 'SALARY_CONTRACTS_TABLE_MISSING', message: 'salary_contracts table does not exist.' } }, 500);

  const dryRun = body.dry_run === true || body.dry_run === '1';
  const contract = normalizeLegacy({
    id: LEGACY_CONTRACT_ID,
    effective_month: body.effective_month,
    basic: body.basic, hra: body.hra, medical: body.medical, utility: body.utility,
    contract_base: body.contract_base,
    wfh_usd: body.wfh_usd, wfh_fx_rate: body.wfh_fx_rate, include_wfh: body.include_wfh,
    other_allowance: body.other_allowance, deductions: body.deductions,
    payday: body.payday,
    payout_account_id: body.payout_account_id || body.deposit_account_id,
    deposit_account_id: body.deposit_account_id || body.payout_account_id,
    include_in_forecast: body.include_in_forecast,
    employer_name: body.employer_name || null,
    notes: body.notes, updated_at: nowISO(),
  });

  const computed = computeSalary(contract);
  const forecastSource = buildForecastSource(contract, computed);

  if (dryRun) {
    return json({ ok: true, version: VERSION, action: 'salary.contract.dry_run', dry_run: true, writes_performed: false, contract, computed, forecast_source: forecastSource });
  }

  await saveLegacyContract(db, cols, contract, hh);
  return json({ ok: true, version: VERSION, action: 'salary.contract.save', committed: true, writes_performed: true, contract, computed, forecast_source: forecastSource, salary: [contract] });
}

// ─── Data access ──────────────────────────────────────────────────────────────

async function loadContracts(db, cols, hh) {
  if (!cols.has('id')) return [];
  const wanted = ['id','employer_name','gross_amount','net_amount_estimate','frequency',
    'payday','payday_day','deposit_account_id','payout_account_id','status','start_date',
    'tax_bracket','currency','notes','basic','hra','medical','utility','contract_base',
    'wfh_usd','wfh_fx_rate','include_wfh','other_allowance','deductions',
    'include_in_forecast','effective_month','created_at','updated_at'].filter(c => cols.has(c));
  const orderBy = cols.has('updated_at') ? 'ORDER BY datetime(updated_at) DESC, id DESC' : 'ORDER BY id DESC';
  const useHH = hh && cols.has('user_id');
  const where = useHH ? 'WHERE user_id = ?' : '';
  const binds = useHH ? [hh] : [];
  const result = await db.prepare(`SELECT ${wanted.join(', ')} FROM salary_contracts ${where} ${orderBy}`).bind(...binds).all();
  return (result.results || []).map(enrichContract);
}

async function loadContract(db, cols, id, hh) {
  if (!cols.has('id')) return null;
  const wanted = ['id','employer_name','gross_amount','net_amount_estimate','frequency',
    'payday','payday_day','deposit_account_id','payout_account_id','status','start_date',
    'tax_bracket','currency','notes','basic','hra','medical','utility','contract_base',
    'wfh_usd','wfh_fx_rate','include_wfh','other_allowance','deductions',
    'include_in_forecast','effective_month','created_at','updated_at'].filter(c => cols.has(c));
  const useHH = hh && cols.has('user_id');
  const hhClause = useHH ? ' AND user_id = ?' : '';
  const binds = useHH ? [id, hh] : [id];
  const row = await db.prepare(`SELECT ${wanted.join(', ')} FROM salary_contracts WHERE id = ?${hhClause} LIMIT 1`).bind(...binds).first();
  return row ? enrichContract(row) : null;
}

async function loadContractPayslips(db, cols, contractId) {
  if (!cols.has('id')) return [];
  const wanted = ['id','contract_id','period','gross','net','bonus','deposit_date',
    'deposit_account_id','transaction_id','notes','created_at','updated_at'].filter(c => cols.has(c));
  const result = await db.prepare(`SELECT ${wanted.join(', ')} FROM salary_payslips WHERE contract_id = ? ORDER BY period DESC`).bind(contractId).all();
  return result.results || [];
}

async function loadRecentPayslips(db, cols, limit, hh) {
  if (!cols.has('id')) return [];
  const wanted = ['id','contract_id','period','gross','net','bonus',
    'deposit_date','deposit_account_id','transaction_id','notes','created_at','updated_at'].filter(c => cols.has(c));
  const useHH = hh && cols.has('user_id');
  const where = useHH ? 'WHERE user_id = ?' : '';
  const binds = useHH ? [hh, limit] : [limit];
  const result = await db.prepare(`SELECT ${wanted.join(', ')} FROM salary_payslips ${where} ORDER BY period DESC LIMIT ?`).bind(...binds).all();
  return result.results || [];
}

async function saveLegacyContract(db, cols, contract, hh) {
  const now = nowISO();
  const row = {
    id: LEGACY_CONTRACT_ID, effective_month: contract.effective_month,
    basic: contract.basic, hra: contract.hra, medical: contract.medical, utility: contract.utility,
    contract_base: contract.contract_base, wfh_usd: contract.wfh_usd, wfh_fx_rate: contract.wfh_fx_rate,
    include_wfh: contract.include_wfh ? 1 : 0, other_allowance: contract.other_allowance,
    deductions: contract.deductions, payday: contract.payday,
    payout_account_id: contract.payout_account_id, deposit_account_id: contract.deposit_account_id,
    include_in_forecast: contract.include_in_forecast ? 1 : 0,
    employer_name: contract.employer_name || null,
    gross_amount: contract.contract_base || 0,
    net_amount_estimate: (contract.contract_base || 0) - (contract.deductions || 0),
    status: 'active',
    user_id: hh || null,
    notes: contract.notes, updated_at: now, created_at: now,
  };
  const useHH = hh && cols.has('user_id');
  const hhClause = useHH ? ' AND user_id = ?' : '';
  const hhBinds  = useHH ? [hh] : [];
  const existing = cols.has('id') ? await db.prepare(`SELECT id FROM salary_contracts WHERE id = ?${hhClause} LIMIT 1`).bind(LEGACY_CONTRACT_ID, ...hhBinds).first() : null;
  if (existing) {
    const keys = Object.keys(row).filter(k => k !== 'id' && cols.has(k));
    if (!keys.length) return;
    await db.prepare(`UPDATE salary_contracts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map(k => row[k]), LEGACY_CONTRACT_ID).run();
  } else {
    const keys = Object.keys(row).filter(k => cols.has(k));
    if (!keys.length) return;
    await db.prepare(`INSERT INTO salary_contracts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => row[k])).run();
  }
}

// ─── Enrichment & computation ─────────────────────────────────────────────────

function enrichContract(row) {
  const gross  = row.gross_amount  || row.contract_base || ((row.basic||0)+(row.hra||0)+(row.medical||0)+(row.utility||0));
  const net    = row.net_amount_estimate || gross - (row.deductions || 0);
  const payday = row.payday_day || row.payday || 25;
  const depositAccount = row.deposit_account_id || row.payout_account_id || null;
  return {
    ...row,
    employer_name:       row.employer_name || null,
    gross_amount:        gross,
    net_amount_estimate: net,
    frequency:           row.frequency || 'monthly',
    payday_day:          payday,
    deposit_account_id:  depositAccount,
    status:              row.status || 'active',
    currency:            row.currency || 'PKR',
  };
}

function buildProjections(contracts, months) {
  const now = new Date();
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const perContract = contracts.map(c => {
      const payday = c.payday_day || c.payday || 25;
      const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return {
        period, contract_id: c.id, employer_name: c.employer_name || null,
        projected_gross: c.gross_amount || 0,
        projected_net: c.net_amount_estimate || 0,
        deposit_account_id: c.deposit_account_id || null,
        expected_date: `${period}-${String(Math.min(payday, maxDay)).padStart(2, '0')}`,
        frequency: c.frequency || 'monthly',
      };
    });
    return {
      period,
      contracts: perContract,
      total_projected_net:   perContract.reduce((s, p) => s + p.projected_net,   0),
      total_projected_gross: perContract.reduce((s, p) => s + p.projected_gross, 0),
    };
  });
}

// ─── Legacy contract normalization ────────────────────────────────────────────

function normalizeLegacy(input) {
  const basic   = wr(input.basic);
  const hra     = wr(input.hra);
  const medical = wr(input.medical);
  const utility = wr(input.utility);
  const providedBase  = num(input.contract_base);
  const derivedBase   = wr(basic + hra + medical + utility);
  const contractBase  = providedBase == null ? derivedBase : wr(providedBase);
  return {
    id: s(input.id || LEGACY_CONTRACT_ID).slice(0, 120),
    effective_month: normalizeEffectiveMonth(input.effective_month),
    basic, hra, medical, utility,
    contract_base: contractBase,
    wfh_usd: dm(input.wfh_usd, 0, 6),
    wfh_fx_rate: dm(input.wfh_fx_rate, 0, 6),
    include_wfh: toBool(input.include_wfh, false),
    other_allowance: wr(input.other_allowance),
    deductions: wr(input.deductions),
    payday: normalizePayday(input.payday),
    payout_account_id: s(input.payout_account_id || input.deposit_account_id || 'meezan').slice(0, 120),
    deposit_account_id: s(input.deposit_account_id || input.payout_account_id || 'meezan').slice(0, 120),
    include_in_forecast: toBool(input.include_in_forecast, true),
    employer_name: input.employer_name || null,
    gross_amount: contractBase,
    net_amount_estimate: wr(contractBase - wr(input.deductions)),
    frequency: normalizeFrequency(input.frequency),
    status: s(input.status || 'active'),
    notes: s(input.notes || '').slice(0, 1000),
    updated_at: input.updated_at || null,
  };
}

function computeSalary(c) {
  const wfhRaw = c.include_wfh ? (c.wfh_usd || 0) * (c.wfh_fx_rate || 0) : 0;
  const wfhAllowance = wr(wfhRaw);
  const gross = wr((c.contract_base || 0) + wfhAllowance + (c.other_allowance || 0));
  const net   = wr(gross - (c.deductions || 0));
  return {
    basic: wr(c.basic), hra: wr(c.hra), medical: wr(c.medical), utility: wr(c.utility),
    contract_base: wr(c.contract_base), wfh_usd: c.wfh_usd || 0, wfh_fx_rate: c.wfh_fx_rate || 0,
    wfh_allowance: wfhAllowance, include_wfh: Boolean(c.include_wfh),
    other_allowance: wr(c.other_allowance), deductions: wr(c.deductions),
    gross, net, paid: 0, remaining: net,
    payday: c.payday, expected_date: expectedDate(c.effective_month, c.payday),
    payout_account_id: c.payout_account_id, include_in_forecast: Boolean(c.include_in_forecast),
  };
}

function buildForecastSource(c, computed) {
  const enabled = Boolean(c && c.include_in_forecast && computed && computed.net > 0 && c.payout_account_id);
  if (!enabled) {
    const reason = !c ? 'no saved salary contract' : !c.include_in_forecast ? 'salary excluded from forecast' : !computed || computed.net <= 0 ? 'salary net amount is zero' : 'payout account missing';
    return disabledForecastSource(reason);
  }
  return {
    type: 'salary_income', source: 'salary_contract', enabled: true,
    monthly_salary_net: wr(computed.net), expected_income_amount: wr(computed.net),
    expected_payday: c.payday, expected_date: computed.expected_date,
    payout_account_id: c.payout_account_id, effective_month: c.effective_month, version: VERSION,
  };
}

function disabledForecastSource(reason) {
  return { type: 'salary_income', source: 'salary_contract', enabled: false, monthly_salary_net: 0, expected_income_amount: 0, expected_payday: null, expected_date: null, payout_account_id: null, reason, version: VERSION };
}

function emptyComputed() {
  return { basic: 0, hra: 0, medical: 0, utility: 0, contract_base: 0, wfh_usd: 0, wfh_fx_rate: 0, wfh_allowance: 0, include_wfh: false, other_allowance: 0, deductions: 0, gross: 0, net: 0, paid: 0, remaining: 0, payday: null, expected_date: null, payout_account_id: null, include_in_forecast: false };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function tableColumns(db, tableName) {
  try {
    const result = await db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set((result.results || []).map(r => r.name).filter(Boolean));
  } catch { return new Set(); }
}

function filterToCols(cols, row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) { if (cols.has(k)) out[k] = v; }
  return out;
}

function buildInsert(db, table, row) {
  const keys = Object.keys(row);
  if (!keys.length) throw new Error('No insertable columns for ' + table);
  return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...keys.map(k => row[k]));
}

function makeId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function nowISO() { return new Date().toISOString(); }
function s(v, fb = '') { return v === undefined || v === null ? fb : String(v).trim(); }
function moneyInt(v) { const n = Number(String(v || 0).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n) : 0; }
function num(v) { if (v === undefined || v === null || v === '') return null; const n = Number(String(v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : null; }
function wr(v)  { const n = num(v); return n == null ? 0 : Math.round(n); }
function dm(v, fb = 0, places = 6) { const n = num(v); if (n == null) return fb; const f = Math.pow(10, places); return Math.round(n * f) / f; }
function toBool(v, fb = false) { if (v === undefined || v === null || v === '') return fb; if (v === true || v === 1) return true; if (v === false || v === 0) return false; const r = String(v).toLowerCase(); return ['1','true','yes','on'].includes(r) ? true : ['0','false','no','off'].includes(r) ? false : fb; }
function normalizePayday(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(31, Math.max(1, n)) : 25; }
function normalizeFrequency(v) { const f = s(v).toLowerCase(); return ['monthly','biweekly','weekly'].includes(f) ? f : 'monthly'; }
function normalizeEffectiveMonth(v) { const raw = s(v); if (/^\d{4}-\d{2}$/.test(raw)) return raw; if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.slice(0, 7); const n = new Date(); return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`; }
function cleanPeriod(v) { const r = s(v); if (/^\d{4}-\d{2}$/.test(r)) return r; if (/^\d{4}-\d{2}-\d{2}$/.test(r)) return r.slice(0, 7); return null; }
function cleanDate(v) { const r = s(v); return /^\d{4}-\d{2}-\d{2}$/.test(r) ? r : new Date().toISOString().slice(0, 10); }
function expectedDate(effectiveMonth, payday) { const m = normalizeEffectiveMonth(effectiveMonth); const [y, mo] = m.split('-').map(Number); const maxDay = new Date(Date.UTC(y, mo, 0)).getUTCDate(); const day = Math.min(normalizePayday(payday), maxDay); return `${m}-${String(day).padStart(2, '0')}`; }

function getPath(context) {
  const raw = context.params && context.params.path;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw).split('/').filter(Boolean);
}

async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function dbMissing() { return json({ ok: false, version: VERSION, error: { code: 'DB_BINDING_MISSING', message: 'D1 binding DB not available.' } }, 500); }

async function safeAudit(env, event) {
  try {
    const result = await audit(env, { ...event, detail: typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail || {}) });
    return { ok: !!(result && result.ok), error: result?.error || null };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function corsHeaders() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', Pragma: 'no-cache' } }); }
