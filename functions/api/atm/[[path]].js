/* ─── /api/atm/[[path]] · Sovereign Finance ATM Engine ───
 * v0.3.0-atm-provider-refundable-fees
 *
 * Contract:
 * - ATM withdrawal is source bank/wallet/prepaid/card account → cash.
 * - Source account decreases by withdrawal amount immediately.
 * - Cash account increases by withdrawal amount immediately.
 * - If same-bank ATM is used, fee is forced to 0 and no fee ledger row is created.
 * - If different-bank ATM is used and fee > 0, fee decreases the source account immediately.
 * - ATM fee is always a standalone source-account expense row, never linked to withdrawal pair.
 * - Fee can be final/non-refundable or refundable.
 * - Refundable fee rows appear in the ATM refund queue until bank refund is received.
 * - Pressing refund received creates a separate income row back into the source account.
 * - No direct account balance mutation.
 * - Accounts remain ledger-derived from transactions_canonical.
 */

const VERSION = 'v0.3.0-atm-provider-refundable-fees';
const CONTRACT_VERSION = 'atm-v1';

const DEFAULT_SOURCE_ACCOUNT_ID = 'mashreq';
const DEFAULT_DEST_ACCOUNT_ID = 'cash';
const DEFAULT_FEE_PKR = 35;
const REFUND_WINDOW_DAYS = 10;
const MONTHLY_CAP_HINT = 15;

const ATM_PROVIDERS = [
  { id: 'mashreq', name: 'Mashreq', aliases: ['mashreq', 'mashreq bank'] },
  { id: 'meezan', name: 'Meezan Bank', aliases: ['meezan', 'meezan bank'] },
  { id: 'ubl', name: 'UBL', aliases: ['ubl', 'united bank', 'united bank limited'] },
  { id: 'naya_pay', name: 'NayaPay', aliases: ['nayapay', 'naya pay', 'naya_pay'] },
  { id: 'easypaisa', name: 'Easypaisa', aliases: ['easypaisa', 'easy paisa', 'telenor microfinance bank'] },
  { id: 'jazzcash', name: 'JazzCash', aliases: ['jazzcash', 'jazz cash', 'mobilink microfinance bank'] },
  { id: 'hbl', name: 'HBL', aliases: ['hbl', 'habib bank', 'habib bank limited'] },
  { id: 'mcb', name: 'MCB Bank', aliases: ['mcb', 'mcb bank', 'muslim commercial bank'] },
  { id: 'abl', name: 'Allied Bank', aliases: ['abl', 'allied bank'] },
  { id: 'alfalah', name: 'Bank Alfalah', aliases: ['alfalah', 'bank alfalah'] },
  { id: 'bop', name: 'Bank of Punjab', aliases: ['bop', 'bank of punjab'] },
  { id: 'faysal', name: 'Faysal Bank', aliases: ['faysal', 'faysal bank'] },
  { id: 'standard_chartered', name: 'Standard Chartered', aliases: ['standard chartered', 'scb'] },
  { id: 'askari', name: 'Askari Bank', aliases: ['askari', 'askari bank'] },
  { id: 'js_bank', name: 'JS Bank', aliases: ['js', 'js bank'] },
  { id: 'bankislami', name: 'BankIslami', aliases: ['bankislami', 'bank islami'] },
  { id: 'dib', name: 'Dubai Islamic Bank', aliases: ['dib', 'dubai islamic', 'dubai islamic bank'] },
  { id: 'soneri', name: 'Soneri Bank', aliases: ['soneri', 'soneri bank'] },
  { id: 'samba', name: 'Samba Bank', aliases: ['samba', 'samba bank'] },
  { id: 'silkbank', name: 'Silkbank', aliases: ['silkbank', 'silk bank'] },
  { id: 'nbp', name: 'National Bank of Pakistan', aliases: ['nbp', 'national bank', 'national bank of pakistan'] },
  { id: 'sindh_bank', name: 'Sindh Bank', aliases: ['sindh bank', 'sindh_bank'] },
  { id: 'other_1link', name: 'Other 1LINK ATM', aliases: ['other', '1link', '1link atm', 'other 1link'] }
];

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = cleanText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (action === 'health' || path[0] === 'health') {
      return atmHealth(db);
    }

    if (action === 'providers' || path[0] === 'providers') {
      return json({
        ok: true,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        action: 'atm.providers',
        atm_providers: ATM_PROVIDERS.map(provider => ({
          id: provider.id,
          name: provider.name
        })),
        rules: {
          same_bank_fee_policy: 'same source provider and ATM provider forces fee to 0 and creates no fee row',
          different_bank_fee_policy: 'fee amount must be supplied by user; backend records it as final or refundable',
          provider_matching: 'source account id/name/kind aliases matched against provider aliases'
        }
      });
    }

    const [accountCols, txCols] = await Promise.all([
      tableColumns(db, 'accounts'),
      tableColumns(db, 'transactions')
    ]);

    const accounts = await loadAccounts(db, accountCols);
    const pendingFees = await loadPendingFees(db, txCols);
    const recentRows = await loadRecentATMRows(db, txCols);
    const feeStats = await loadFeeStats30d(db, txCols);

    const sourceAccounts = accounts.filter(account => {
      return String(account.type || '').toLowerCase() === 'asset' &&
        String(account.kind || '').toLowerCase() !== 'cc';
    });

    const destinationAccounts = accounts.filter(account => {
      return String(account.type || '').toLowerCase() === 'asset' &&
        String(account.kind || '').toLowerCase() !== 'cc';
    });

    const totalPending = pendingFees.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const overdueCount = pendingFees.filter(row => Number(row.age_days) > REFUND_WINDOW_DAYS).length;

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      route: '/api/atm',
      supported_routes: [
        'GET /api/atm',
        'GET /api/atm?action=health',
        'GET /api/atm?action=providers',
        'POST /api/atm',
        'POST /api/atm/withdraw',
        'POST /api/atm/reverse',
        'POST /api/atm/refund'
      ],
      defaults: {
        source_account_id: DEFAULT_SOURCE_ACCOUNT_ID,
        destination_account_id: DEFAULT_DEST_ACCOUNT_ID,
        fee_pkr_hint: DEFAULT_FEE_PKR,
        refund_window_days: REFUND_WINDOW_DAYS,
        monthly_cap_hint: MONTHLY_CAP_HINT
      },
      atm_providers: ATM_PROVIDERS.map(provider => ({
        id: provider.id,
        name: provider.name
      })),
      accounts,
      source_accounts: sourceAccounts,
      destination_accounts: destinationAccounts,
      pending_fees: pendingFees,
      refundable_fees: pendingFees,
      pending_count: pendingFees.length,
      pending_fee_count: pendingFees.length,
      total_pending_pkr: round2(totalPending),
      pending_fee_total: round2(totalPending),
      overdue_count: overdueCount,
      fees_30d: feeStats,
      fees_paid: feeStats.paid,
      fees_reversed: feeStats.refunded,
      fees_refunded: feeStats.refunded,
      fees_final: feeStats.final,
      fees_net: feeStats.net,
      default_fee: DEFAULT_FEE_PKR,
      recent_atm_rows: recentRows,
      recent_rows: recentRows,
      rules: {
        source_account_impact: 'negative',
        cash_account_impact: 'positive',
        fee_account_impact: 'negative_immediate',
        fee_refund_account_impact: 'positive_when_bank_refunds',
        same_bank_fee_policy: 'force_fee_zero_and_create_no_fee_row',
        different_bank_fee_policy: 'user_supplied_fee_recorded_immediately',
        fee_is_linked_to_withdrawal_pair: false,
        refundable_fee_marker: '[ATM_FEE_REFUNDABLE]',
        final_fee_marker: '[ATM_FEE_FINAL]',
        refund_marker: '[ATM_FEE_REFUND]',
        pending_fee_meaning: 'fee already charged, awaiting possible bank refund',
        refund_action_creates_income_row: true,
        no_direct_balance_mutation: true,
        balance_source: 'transactions_canonical',
        pending_fee_filter_excludes_final_fee_rows: true,
        pending_fee_filter_excludes_refund_rows: true,
        pending_fee_filter_excludes_refunded_fee_rows: true
      }
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err),
      stage: 'onRequestGet'
    }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const path = getPath(context);
    const body = await readJSON(context.request);
    const action = cleanText(path[0] || body.action || 'withdrawal', 'withdrawal', 80).toLowerCase();

    if (['withdraw', 'withdrawal', 'atm_withdrawal', 'create'].includes(action)) {
      return createATMWithdraw(context, body);
    }

    if (['reverse', 'fee_reverse', 'reverse_fee', 'refund', 'fee_refund', 'refund_fee'].includes(action)) {
      return refundATMFee(context, body);
    }

    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'Unsupported ATM action',
      code: 'UNSUPPORTED_ATM_ACTION',
      action,
      supported: ['/api/atm', '/api/atm/withdraw', '/api/atm/reverse', '/api/atm/refund']
    }, 400);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err),
      stage: 'onRequestPost'
    }, 500);
  }
}

async function createATMWithdraw(context, body) {
  const db = context.env.DB;

  const amount = moneyNumber(body.amount, null);
  const sourceId = cleanId(body.source_account_id || body.from_account_id || body.account_id || DEFAULT_SOURCE_ACCOUNT_ID);
  const destId = cleanId(body.cash_account_id || body.destination_account_id || body.to_account_id || DEFAULT_DEST_ACCOUNT_ID);
  const sourceProviderIdInput = cleanProviderId(body.source_provider_id || body.source_bank_id || body.card_provider_id || '');
  const atmProviderId = cleanProviderId(body.atm_provider_id || body.atm_bank_id || body.atm_provider || body.atm_bank || body.atm_name || body.atm || '');
  const atmProvider = resolveProvider(atmProviderId);
  const atmName = cleanText(body.atm_provider_name || body.atm_name || body.atm || (atmProvider ? atmProvider.name : 'ATM'), 'ATM', 80);
  const date = cleanDate(body.date || body.withdrawal_date);
  const notes = cleanText(body.notes || `ATM withdrawal at ${atmName}`, '', 300);
  const createdBy = cleanText(body.created_by || 'web-atm', '', 100);
  const idempotencyKey = cleanText(body.idempotency_key || body.client_request_id || '', '', 180);
  const feeRefundable = boolValue(body.fee_refundable ?? body.is_fee_refundable ?? body.refundable ?? body.reversible ?? false);

  if (amount == null || amount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'amount must be greater than 0',
      code: 'INVALID_AMOUNT',
      committed: false
    }, 400);
  }

  if (!sourceId || !destId) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source and destination accounts are required',
      code: 'ACCOUNTS_REQUIRED',
      committed: false
    }, 400);
  }

  if (sourceId === destId) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source and destination accounts cannot match',
      code: 'SAME_SOURCE_AND_DESTINATION',
      committed: false
    }, 400);
  }

  const [accountCols, txCols] = await Promise.all([
    tableColumns(db, 'accounts'),
    tableColumns(db, 'transactions')
  ]);

  if (!accountCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'accounts table missing id column',
      code: 'ACCOUNTS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  if (!txCols.has('id') || !txCols.has('account_id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'transactions table missing required columns',
      code: 'TRANSACTIONS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  const accounts = await loadAccountMap(db, accountCols, [sourceId, destId]);

  if (!accounts[sourceId]) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'source account not found or inactive',
      code: 'SOURCE_ACCOUNT_NOT_FOUND',
      account_id: sourceId,
      committed: false
    }, 404);
  }

  if (!accounts[destId]) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'destination account not found or inactive',
      code: 'DESTINATION_ACCOUNT_NOT_FOUND',
      account_id: destId,
      committed: false
    }, 404);
  }

  const source = accounts[sourceId];
  const dest = accounts[destId];

  if (String(source.type || '').toLowerCase() !== 'asset' || String(dest.type || '').toLowerCase() !== 'asset') {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'ATM source and destination must both be asset accounts',
      code: 'ATM_ACCOUNTS_MUST_BE_ASSETS',
      committed: false
    }, 400);
  }

  const sourceProviderId = sourceProviderIdInput || inferProviderIdFromAccount(source);
  const sameBank = !!sourceProviderId && !!atmProviderId && sourceProviderId === atmProviderId;

  const requestedFee = body.no_fee || sameBank
    ? 0
    : moneyNumber(body.fee_amount ?? body.fee ?? 0, 0);

  if (requestedFee < 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_withdrawal',
      error: 'fee_amount cannot be negative',
      code: 'INVALID_FEE_AMOUNT',
      committed: false
    }, 400);
  }

  const feeAmount = sameBank ? 0 : requestedFee;
  const shouldCreateFee = feeAmount > 0;
  const shouldQueueRefund = shouldCreateFee && feeRefundable;
  const atmId = makeTxnId('atm');
  const outId = makeTxnId('atmout');
  const inId = makeTxnId('atmin');
  const feeId = shouldCreateFee ? makeTxnId('atmfee') : null;
  const createdAt = nowISO();

  const providerMeta = [
    `atm_provider_id=${atmProviderId || 'unknown'}`,
    `atm_provider_name=${safeToken(atmName)}`,
    `source_provider_id=${sourceProviderId || 'unknown'}`,
    `same_bank=${sameBank ? 'true' : 'false'}`
  ].join(' ');

  const outRow = filterToCols(txCols, {
    id: outId,
    date,
    type: 'transfer',
    amount,
    pkr_amount: amount,
    account_id: sourceId,
    transfer_to_account_id: destId,
    linked_txn_id: inId,
    category_id: null,
    merchant_id: null,
    merchant: atmName,
    notes: `[ATM_WITHDRAWAL] atm_id=${atmId} side=source ${providerMeta} source_account_id=${sourceId} cash_account_id=${destId} ${notes} [linked: ${inId}]`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: atmId,
    source_action: 'withdrawal_source',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:source` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const inRow = filterToCols(txCols, {
    id: inId,
    date,
    type: 'income',
    amount,
    pkr_amount: amount,
    account_id: destId,
    transfer_to_account_id: sourceId,
    linked_txn_id: outId,
    category_id: null,
    merchant_id: null,
    merchant: atmName,
    notes: `[ATM_WITHDRAWAL] atm_id=${atmId} side=cash ${providerMeta} source_account_id=${sourceId} cash_account_id=${destId} ${notes} [linked: ${outId}]`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: atmId,
    source_action: 'withdrawal_cash',
    idempotency_key: idempotencyKey ? `${idempotencyKey}:cash` : null,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const statements = [
    buildInsert(db, 'transactions', outRow),
    buildInsert(db, 'transactions', inRow)
  ];

  let feeRow = null;

  if (shouldCreateFee) {
    const feeCategoryId = await resolveCategoryId(db, 'atm_fee');
    const feeMarker = shouldQueueRefund ? '[ATM_FEE_REFUNDABLE]' : '[ATM_FEE_FINAL]';
    const feeAction = shouldQueueRefund ? 'withdrawal_fee_refundable' : 'withdrawal_fee_final';

    feeRow = filterToCols(txCols, {
      id: feeId,
      date,
      type: 'atm',
      amount: feeAmount,
      pkr_amount: feeAmount,
      account_id: sourceId,
      transfer_to_account_id: null,
      linked_txn_id: null,
      category_id: feeCategoryId,
      merchant_id: null,
      merchant: atmName,
      notes: `${feeMarker} atm_id=${atmId} ${providerMeta} source_account_id=${sourceId} ATM fee charged now${shouldQueueRefund ? '; awaiting bank refund' : '; final non-refundable cost'}`.slice(0, 240),
      fee_amount: 0,
      pra_amount: 0,
      currency: 'PKR',
      fx_rate_at_commit: 1,
      fx_source: 'PKR-base',
      source_module: 'atm',
      source_id: atmId,
      source_action: feeAction,
      idempotency_key: idempotencyKey ? `${idempotencyKey}:fee` : null,
      created_by: createdBy,
      created_at: createdAt,
      updated_at: createdAt
    });

    statements.push(buildInsert(db, 'transactions', feeRow));
  }

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm_withdrawal',
    committed: true,
    atm_id: atmId,
    transaction_ids: shouldCreateFee ? [outId, inId, feeId] : [outId, inId],
    ids: shouldCreateFee ? [outId, inId, feeId] : [outId, inId],
    source_provider_id: sourceProviderId || null,
    atm_provider_id: atmProviderId || null,
    atm_provider_name: atmName,
    same_bank_atm: sameBank,
    transfer_pair: {
      source_transaction_id: outId,
      cash_transaction_id: inId,
      linked: true,
      amount
    },
    fee_transaction: shouldCreateFee
      ? {
        id: feeId,
        amount: feeAmount,
        account_id: sourceId,
        type: 'atm',
        charged_now: true,
        refundable: shouldQueueRefund,
        final: !shouldQueueRefund,
        awaiting_possible_refund: shouldQueueRefund,
        linked_to_transfer_pair: false
      }
      : null,
    account_impact: {
      balance_source: 'transactions_canonical',
      source_account_id: sourceId,
      source_withdrawal_delta: round2(-amount),
      source_fee_delta: shouldCreateFee ? round2(-feeAmount) : 0,
      source_account_delta: round2(-amount - (shouldCreateFee ? feeAmount : 0)),
      cash_account_id: destId,
      cash_account_delta: amount,
      liquid_total_delta: shouldCreateFee ? round2(-feeAmount) : 0
    },
    ledger: {
      rows_created: shouldCreateFee ? 3 : 2,
      withdrawal_pair_created: true,
      fee_row_created: shouldCreateFee,
      fee_row_charged_now: shouldCreateFee,
      fee_row_refundable: shouldQueueRefund,
      fee_row_final: shouldCreateFee && !shouldQueueRefund,
      fee_row_linked_to_pair: false,
      refund_requires_separate_action: shouldQueueRefund
    },
    warnings: sameBank && requestedFee > 0
      ? ['Same-bank ATM detected; fee was forced to 0 and no fee row was created.']
      : []
  });
}

async function refundATMFee(context, body) {
  const db = context.env.DB;
  const createdBy = cleanText(body.created_by || 'web-atm-refund', '', 100);
  const feeTxnId = cleanText(body.fee_txn_id || body.id || body.transaction_id || '', '', 160);
  const amount = body.amount != null ? Number(body.amount) : null;

  const txCols = await tableColumns(db, 'transactions');
  const pending = await loadPendingFees(db, txCols);

  let target = null;

  if (feeTxnId) {
    target = pending.find(row => row.id === feeTxnId);
  } else if (amount && Number.isFinite(amount) && amount > 0) {
    target = pending.find(row => Math.abs((Number(row.amount) || 0) - amount) < 0.01);
  } else {
    target = pending[0] || null;
  }

  if (!target) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_fee_refund',
      error: 'No matching refundable ATM fee found',
      code: 'NO_REFUNDABLE_ATM_FEE_FOUND',
      committed: false
    }, 404);
  }

  const refundId = makeTxnId('atmrefund');
  const date = cleanDate(body.date);
  const createdAt = nowISO();
  const refundAmount = round2(Number(target.amount) || 0);

  if (refundAmount <= 0) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm_fee_refund',
      error: 'ATM fee amount is invalid',
      code: 'INVALID_REFUNDABLE_FEE_AMOUNT',
      committed: false,
      fee_txn_id: target.id
    }, 400);
  }

  const refundRow = filterToCols(txCols, {
    id: refundId,
    date,
    type: 'income',
    amount: refundAmount,
    pkr_amount: refundAmount,
    account_id: target.account_id,
    transfer_to_account_id: null,
    linked_txn_id: null,
    category_id: target.category_id || null,
    merchant_id: null,
    merchant: target.merchant || 'ATM',
    notes: `[ATM_FEE_REFUND] fee_txn_id=${target.id} atm_id=${extractAtmId(target.notes) || target.source_id || target.id} Bank refund received for refundable ATM fee`.slice(0, 240),
    fee_amount: 0,
    pra_amount: 0,
    currency: 'PKR',
    fx_rate_at_commit: 1,
    fx_source: 'PKR-base',
    source_module: 'atm',
    source_id: extractAtmId(target.notes) || target.source_id || target.id,
    source_action: 'fee_refund',
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt
  });

  const statements = [buildInsert(db, 'transactions', refundRow)];

  const updateParts = [];
  const values = [];

  if (txCols.has('notes')) {
    updateParts.push('notes = ?');
    values.push(`${target.notes || ''} [ATM_FEE_REFUNDED_BY: ${refundId}]`.slice(0, 240));
  }

  if (txCols.has('updated_at')) {
    updateParts.push('updated_at = ?');
    values.push(createdAt);
  }

  if (updateParts.length) {
    values.push(target.id);
    statements.push(
      db.prepare(`UPDATE transactions SET ${updateParts.join(', ')} WHERE id = ?`).bind(...values)
    );
  }

  await db.batch(statements);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm_fee_refund',
    committed: true,
    fee_txn_id: target.id,
    refund_id: refundId,
    amount: refundAmount,
    account_id: target.account_id,
    linked_to_withdrawal_pair: false,
    account_impact: {
      account_id: target.account_id,
      refund_delta: refundAmount,
      balance_source: 'transactions_canonical'
    }
  });
}

async function atmHealth(db) {
  const txCols = await tableColumns(db, 'transactions');

  if (!txCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'atm.health',
      error: 'transactions table missing id column'
    }, 500);
  }

  const rows = await loadRecentATMRows(db, txCols, 500);
  const byId = new Map(rows.map(row => [String(row.id), row]));

  const withdrawalRows = rows.filter(row => {
    const notes = String(row.notes || '');
    return notes.includes('[ATM_WITHDRAWAL]') || notes.includes('[ATM_WITHDRAW]');
  });

  const refundableFeeRows = rows.filter(row => isActiveRefundableFeeRow(row));
  const finalFeeRows = rows.filter(row => isFinalFeeRow(row));
  const refundRows = rows.filter(row => {
    const notes = String(row.notes || '');
    return notes.includes('[ATM_FEE_REFUND]') || notes.includes('[ATM_FEE_REVERSAL]');
  });

  const orphanPairs = [];
  const amountMismatches = [];
  const badFeeLinks = [];
  const finalRowsInPending = [];

  for (const row of withdrawalRows) {
    if (isInactive(row)) continue;

    const linkedId = row.linked_txn_id || extractLinkedId(row.notes);

    if (!linkedId) {
      orphanPairs.push({
        id: row.id,
        error: 'ATM withdrawal row missing linked id'
      });
      continue;
    }

    const linked = byId.get(String(linkedId));

    if (!linked) {
      orphanPairs.push({
        id: row.id,
        linked_id: linkedId,
        error: 'Linked ATM row not found in ATM scan'
      });
      continue;
    }

    const amount = rowAmount(row);
    const linkedAmount = rowAmount(linked);

    if (amount !== linkedAmount) {
      amountMismatches.push({
        id: row.id,
        linked_id: linkedId,
        amount,
        linked_amount: linkedAmount,
        error: 'ATM withdrawal pair amount mismatch'
      });
    }
  }

  for (const row of [...refundableFeeRows, ...finalFeeRows]) {
    if (row.linked_txn_id || extractLinkedId(row.notes)) {
      badFeeLinks.push({
        id: row.id,
        linked_id: row.linked_txn_id || extractLinkedId(row.notes),
        error: 'ATM fee must not be linked to withdrawal pair'
      });
    }
  }

  for (const row of finalFeeRows) {
    if (isActivePendingFeeRow(row)) {
      finalRowsInPending.push({
        id: row.id,
        error: 'Final ATM fee must not appear in refundable pending queue'
      });
    }
  }

  const status = orphanPairs.length || amountMismatches.length || badFeeLinks.length || finalRowsInPending.length
    ? 'fail'
    : 'pass';

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'atm.health',
    status,
    counts: {
      scanned_rows: rows.length,
      withdrawal_rows: withdrawalRows.length,
      active_refundable_fee_rows: refundableFeeRows.length,
      final_fee_rows: finalFeeRows.length,
      fee_refund_rows: refundRows.length,
      orphan_pairs: orphanPairs.length,
      amount_mismatches: amountMismatches.length,
      bad_fee_links: badFeeLinks.length,
      final_rows_in_pending: finalRowsInPending.length
    },
    checks: {
      withdrawal_pairs_complete: orphanPairs.length === 0,
      withdrawal_pair_amounts_match: amountMismatches.length === 0,
      fee_rows_not_linked_to_pairs: badFeeLinks.length === 0,
      final_fee_rows_not_counted_as_pending: finalRowsInPending.length === 0,
      charged_fee_rows_count_as_expense_immediately: true,
      fee_refund_rows_not_counted_as_pending: true,
      same_bank_fee_policy_declared: true,
      provider_model_declared: true,
      health_is_read_only: true
    },
    orphan_pairs: orphanPairs,
    amount_mismatches: amountMismatches,
    bad_fee_links: badFeeLinks,
    final_rows_in_pending: finalRowsInPending,
    rules: {
      withdrawal_source_type: 'transfer',
      withdrawal_cash_type: 'income',
      fee_type: 'atm',
      fee_refund_type: 'income',
      same_bank_fee_policy: 'no fee row',
      different_bank_fee_policy: 'fee row created only when fee amount > 0',
      refundable_fee_marker: '[ATM_FEE_REFUNDABLE]',
      final_fee_marker: '[ATM_FEE_FINAL]',
      fee_refund_marker: '[ATM_FEE_REFUND]',
      fee_link_policy: 'fee row is separate and not linked to withdrawal pair',
      pending_fee_meaning: 'refundable fee charged now, awaiting possible bank refund',
      canonical_withdrawal_marker: '[ATM_WITHDRAWAL]'
    }
  });
}

async function loadAccounts(db, cols) {
  if (!cols.has('id')) return [];

  const wanted = [
    'id',
    'name',
    'icon',
    'type',
    'kind',
    'status',
    'display_order',
    'deleted_at',
    'archived_at'
  ].filter(col => cols.has(col));

  const where = activeAccountWhere(cols);
  const orderBy = cols.has('display_order')
    ? 'display_order, name'
    : (cols.has('name') ? 'name' : 'id');

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${orderBy}`
  ).all();

  return (rows.results || []).map(row => ({
    id: row.id,
    name: row.name || row.id,
    icon: row.icon || '',
    type: row.type || 'asset',
    kind: row.kind || row.type || 'asset',
    provider_id: inferProviderIdFromAccount(row),
    display_order: row.display_order == null ? 999 : Number(row.display_order)
  }));
}

async function loadPendingFees(db, txCols) {
  if (!txCols.has('id')) return [];

  const rows = await loadRecentATMRows(db, txCols, 500);

  return rows
    .filter(row => isActiveRefundableFeeRow(row))
    .slice(0, 50)
    .map(row => ({
      ...row,
      status: 'awaiting_bank_refund',
      refundable: true,
      action_label: 'Refund received',
      age_days: daysSince(row.date)
    }));
}

async function loadRecentATMRows(db, txCols, limit = 40) {
  if (!txCols.has('id')) return [];

  const wanted = [
    'id',
    'date',
    'type',
    'amount',
    'pkr_amount',
    'account_id',
    'category_id',
    'merchant',
    'notes',
    'created_at',
    'linked_txn_id',
    'reversed_by',
    'reversed_at',
    'source_module',
    'source_id',
    'source_action'
  ].filter(col => txCols.has(col));

  const predicates = [
    "type = 'atm'",
    "notes LIKE '%[ATM_WITHDRAWAL]%'",
    "notes LIKE '%[ATM_WITHDRAW]%'",
    "notes LIKE '%[ATM_FEE_REFUNDABLE]%'",
    "notes LIKE '%[ATM_FEE_FINAL]%'",
    "notes LIKE '%[ATM_FEE_AWAITING_REFUND]%'",
    "notes LIKE '%[ATM_FEE_PENDING]%'",
    "notes LIKE '%[ATM_FEE_REFUND]%'",
    "notes LIKE '%[ATM_FEE_REVERSAL]%'",
    "notes LIKE '%ATM withdraw%'",
    "notes LIKE '%ATM fee%'",
    "notes LIKE '%PENDING reversal%'"
  ];

  if (txCols.has('source_module')) {
    predicates.unshift("source_module = 'atm'");
  }

  const rows = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM transactions
     WHERE ${predicates.join(' OR ')}
     ORDER BY ${buildOrderBy(txCols)}
     LIMIT ?`
  ).bind(limit).all();

  return rows.results || [];
}

async function loadFeeStats30d(db, txCols) {
  if (!txCols.has('id')) {
    return {
      paid: 0,
      refundable: 0,
      final: 0,
      refunded: 0,
      reversed: 0,
      net: 0
    };
  }

  const rows = await loadRecentATMRows(db, txCols, 500);
  const cutoff = daysAgoISO(30);

  const feeRows = rows.filter(row => {
    const d = String(row.date || '').slice(0, 10);
    const notes = String(row.notes || '');
    return d >= cutoff &&
      (
        notes.includes('[ATM_FEE_REFUNDABLE]') ||
        notes.includes('[ATM_FEE_FINAL]') ||
        notes.includes('[ATM_FEE_AWAITING_REFUND]') ||
        notes.includes('[ATM_FEE_PENDING]')
      );
  });

  const refundable = feeRows
    .filter(row => isRefundableFeeRow(row))
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  const final = feeRows
    .filter(row => isFinalFeeRow(row))
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  const paid = feeRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  const refunded = rows
    .filter(row => {
      const d = String(row.date || '').slice(0, 10);
      const notes = String(row.notes || '');
      return d >= cutoff &&
        (
          notes.includes('[ATM_FEE_REFUND]') ||
          notes.includes('[ATM_FEE_REVERSAL]')
        );
    })
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  return {
    paid: round2(paid),
    refundable: round2(refundable),
    final: round2(final),
    refunded: round2(refunded),
    reversed: round2(refunded),
    net: round2(paid - refunded)
  };
}

async function loadAccountMap(db, cols, ids) {
  const out = {};

  if (!cols.has('id')) return out;

  const where = activeAccountWhere(cols);

  for (const id of ids) {
    if (!id) continue;

    const wanted = [
      'id',
      'name',
      'icon',
      'type',
      'kind',
      'status',
      'deleted_at',
      'archived_at'
    ].filter(col => cols.has(col));

    const row = await db.prepare(
      `SELECT ${wanted.join(', ')}
       FROM accounts
       WHERE id = ?
       ${where ? 'AND ' + where : ''}
       LIMIT 1`
    ).bind(id).first();

    if (row && row.id) out[row.id] = row;
  }

  return out;
}

async function resolveCategoryId(db, preferredId) {
  const cols = await tableColumns(db, 'categories');

  if (!cols.has('id')) return null;

  const exact = await db.prepare(
    `SELECT id FROM categories WHERE id = ? LIMIT 1`
  ).bind(preferredId).first();

  if (exact && exact.id) return exact.id;

  const fallback = await db.prepare(
    `SELECT id
     FROM categories
     WHERE LOWER(id) IN ('atm_fee', 'bank_fee', 'misc')
        OR LOWER(name) LIKE '%atm%'
        OR LOWER(name) LIKE '%fee%'
     ORDER BY id
     LIMIT 1`
  ).first();

  return fallback && fallback.id ? fallback.id : null;
}

function isActivePendingFeeRow(row) {
  return isActiveRefundableFeeRow(row);
}

function isActiveRefundableFeeRow(row) {
  const notes = String(row.notes || '').toUpperCase();

  if (!isRefundableFeeRow(row)) return false;
  if (notes.includes('[ATM_FEE_REFUND]')) return false;
  if (notes.includes('[ATM_FEE_REVERSAL]')) return false;
  if (notes.includes('[ATM_FEE_REFUNDED_BY:')) return false;
  if (notes.includes('[ATM_FEE_REVERSED_BY:')) return false;
  if (row.reversed_by || row.reversed_at) return false;

  return true;
}

function isRefundableFeeRow(row) {
  const notes = String(row.notes || '').toUpperCase();

  return notes.includes('[ATM_FEE_REFUNDABLE]') ||
    notes.includes('[ATM_FEE_AWAITING_REFUND]') ||
    notes.includes('[ATM_FEE_PENDING]') ||
    (notes.includes('PENDING REVERSAL') && notes.includes('ATM'));
}

function isFinalFeeRow(row) {
  const notes = String(row.notes || '').toUpperCase();

  return notes.includes('[ATM_FEE_FINAL]');
}

function activeAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");

  return clauses.join(' AND ');
}

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

function filterToCols(cols, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function buildInsert(db, table, row) {
  const keys = Object.keys(row);

  if (!keys.length) {
    throw new Error('No insertable columns for ' + table);
  }

  return db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`
  ).bind(...keys.map(key => row[key]));
}

function buildOrderBy(cols) {
  const parts = [];

  if (cols.has('date')) parts.push('date DESC');
  if (cols.has('created_at')) parts.push('datetime(created_at) DESC');
  if (cols.has('id')) parts.push('id DESC');

  return parts.length ? parts.join(', ') : 'rowid DESC';
}

function rowAmount(row) {
  const pkr = Number(row.pkr_amount);

  if (Number.isFinite(pkr) && pkr !== 0) return round2(Math.abs(pkr));

  const amount = Number(row.amount);

  if (Number.isFinite(amount)) return round2(Math.abs(amount));

  return 0;
}

function isInactive(row) {
  const notes = String(row.notes || '').toUpperCase();

  return !!(
    row.reversed_by ||
    row.reversed_at ||
    notes.includes('[REVERSAL OF ') ||
    notes.includes('[REVERSED BY ')
  );
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function extractAtmId(notes) {
  const match = String(notes || '').match(/atm_id=([A-Za-z0-9_-]+)/i);
  return match ? match[1].trim() : null;
}

function inferProviderIdFromAccount(account) {
  const joined = [
    account && account.id,
    account && account.name,
    account && account.kind,
    account && account.type
  ].map(value => normalizeProviderText(value)).join(' ');

  for (const provider of ATM_PROVIDERS) {
    const tokens = [provider.id, provider.name, ...(provider.aliases || [])]
      .map(value => normalizeProviderText(value))
      .filter(Boolean);

    if (tokens.some(token => token && joined.includes(token))) {
      return provider.id;
    }
  }

  return '';
}

function resolveProvider(providerId) {
  const clean = cleanProviderId(providerId);

  if (!clean) return null;

  return ATM_PROVIDERS.find(provider => provider.id === clean) || null;
}

function cleanProviderId(value) {
  const raw = normalizeProviderText(value);

  if (!raw) return '';

  for (const provider of ATM_PROVIDERS) {
    const candidates = [provider.id, provider.name, ...(provider.aliases || [])]
      .map(candidate => normalizeProviderText(candidate));

    if (candidates.includes(raw)) return provider.id;
  }

  return raw
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function normalizeProviderText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeToken(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]+/g, '')
    .slice(0, 80);
}

function boolValue(value) {
  if (value === true) return true;
  if (value === false) return false;

  const raw = String(value || '').trim().toLowerCase();

  return ['1', 'true', 'yes', 'y', 'on', 'refundable', 'reversible'].includes(raw);
}

function moneyNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const n = typeof value === 'number'
    ? value
    : Number(String(value).replace(/rs/ig, '').replace(/,/g, '').trim());

  return Number.isFinite(n) ? round2(n) : fallback;
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function cleanText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function cleanDate(value) {
  const raw = String(value || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function makeTxnId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function round2(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
}

function daysSince(dateValue) {
  const raw = String(dateValue || '').slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

  const then = new Date(raw + 'T00:00:00.000Z').getTime();
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return Math.floor((today - then) / 86400000);
}

function daysAgoISO(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function getPath(context) {
  const raw = context.params && context.params.path;

  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);

  return String(raw).split('/').filter(Boolean);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache'
    }
  });
}
