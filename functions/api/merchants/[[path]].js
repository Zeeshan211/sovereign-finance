/* ─── /api/merchants/[[path]] · Sovereign Finance Merchants & Payees ───
 * v0.2.0-merchants-counterparty-contract
 *
 * Contract:
 * - Merchants are classification/rules only.
 * - Merchants NEVER mutate money.
 * - Merchants help Add Transaction, Ledger, Bills, Nano Loans, ATM, Credit Card, and Reconciliation classify text.
 * - Statement text can match merchant/payee/biller/bank/wallet/loan_provider/payment_rail/person.
 * - Ambiguous people/payees require review.
 * - Backend is schema-safe for current D1 merchants table.
 *
 * Supported:
 * - GET    /api/merchants
 * - GET    /api/merchants?action=health
 * - GET    /api/merchants/health
 * - GET    /api/merchants/{id}
 * - POST   /api/merchants
 * - POST   /api/merchants/match
 * - POST   /api/merchants/seed
 * - POST   /api/merchants/{id}/touch
 * - PUT    /api/merchants/{id}
 * - DELETE /api/merchants/{id}
 */

const VERSION = 'v0.2.0-merchants-counterparty-contract';
const CONTRACT_VERSION = 'merchants-v1';

const SEED_COUNTERPARTIES = [
  /* Banks */
  seed('meezan_bank', 'Meezan Bank', ['Meezan', 'Meezan Bank Limited'], 'bank', 'transfer', null, 'meezan', false, true),
  seed('mashreq_bank', 'Mashreq Bank', ['Mashreq', 'Mashreq Bank Pakistan'], 'bank', 'transfer', null, 'mashreq', false, true),
  seed('ubl_bank', 'UBL', ['United Bank Limited', 'UBL Bank'], 'bank', 'transfer', null, 'ubl', false, true),
  seed('bank_alfalah', 'Bank Alfalah', ['Alfalah', 'Alfalah Bank'], 'bank', 'transfer', null, 'alfalah', false, true),
  seed('mcb_bank', 'MCB', ['MCB Bank', 'Muslim Commercial Bank'], 'bank', 'transfer', null, null, false, true),
  seed('hbl_bank', 'HBL', ['Habib Bank', 'Habib Bank Limited'], 'bank', 'transfer', null, null, false, true),
  seed('allied_bank', 'Allied Bank', ['ABL', 'Allied Bank Limited'], 'bank', 'transfer', null, null, false, true),
  seed('js_bank', 'JS Bank', ['JSBL'], 'bank', 'transfer', null, 'js_bank', false, true),

  /* Wallets */
  seed('easypaisa', 'Easypaisa', ['Easy Paisa', 'Telenor Microfinance Bank'], 'wallet', 'transfer', null, 'easypaisa', false, true),
  seed('jazzcash', 'JazzCash', ['Jazz Cash', 'Mobilink Microfinance Bank'], 'wallet', 'transfer', null, 'jazzcash', false, true),
  seed('nayapay', 'NayaPay', ['Naya Pay'], 'wallet', 'transfer', null, 'naya_pay', false, true),
  seed('sadapay', 'SadaPay', ['Sada Pay'], 'wallet', 'transfer', null, null, false, true),

  /* Payment rails */
  seed('raast', 'Raast', ['RAAST', 'Raast P2P', 'Raast Payment'], 'payment_rail', 'review', null, null, false, false),
  seed('one_link', '1LINK', ['1 Link', 'One Link', '1LINK ATM'], 'payment_rail', 'atm', null, null, false, true),
  seed('ibft', 'IBFT', ['Inter Bank Funds Transfer', 'Funds Transfer'], 'payment_rail', 'review', null, null, false, false),
  seed('atm', 'ATM', ['ATM Withdrawal', 'Cash Withdrawal', 'ATM fee', 'ATM withdraw'], 'payment_rail', 'atm', 'atm_fee', null, false, true),

  /* Billers / utilities */
  seed('mepco', 'MEPCO', ['Multan Electric Power Company', 'MEPCO Bill'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('lesco', 'LESCO', ['Lahore Electric Supply Company', 'LESCO Bill'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('fesco', 'FESCO', ['Faisalabad Electric Supply Company'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('gepco', 'GEPCO', ['Gujranwala Electric Power Company'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('iesco', 'IESCO', ['Islamabad Electric Supply Company'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('sngpl', 'SNGPL', ['Sui Northern Gas', 'Sui Gas'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('ptcl', 'PTCL', ['Pakistan Telecommunication Company'], 'biller', 'bills', 'internet_phone', null, false, true),
  seed('stormfiber', 'StormFiber', ['Storm Fiber'], 'biller', 'bills', 'internet_phone', null, false, true),
  seed('nayatel', 'Nayatel', ['Naya Tel'], 'biller', 'bills', 'internet_phone', null, false, true),

  /* Telco / recharge */
  seed('jazz', 'Jazz', ['Mobilink', 'Jazz Recharge'], 'merchant', 'transactions', 'mobile_recharge', null, false, true),
  seed('zong', 'Zong', ['Zong Recharge'], 'merchant', 'transactions', 'mobile_recharge', null, false, true),
  seed('ufone', 'Ufone', ['Ufone Recharge'], 'merchant', 'transactions', 'mobile_recharge', null, false, true),
  seed('telenor', 'Telenor', ['Telenor Recharge'], 'merchant', 'transactions', 'mobile_recharge', null, false, true),
  seed('onic', 'Onic', ['ONIC Recharge'], 'merchant', 'transactions', 'mobile_recharge', null, false, true),

  /* Fuel / transport */
  seed('pso', 'PSO', ['Pakistan State Oil'], 'merchant', 'transactions', 'fuel', null, true, true),
  seed('shell', 'Shell', ['Shell Pakistan'], 'merchant', 'transactions', 'fuel', null, true, true),
  seed('total_parco', 'Total PARCO', ['Total', 'TotalEnergies'], 'merchant', 'transactions', 'fuel', null, true, true),
  seed('caltex', 'Caltex', ['Chevron Caltex'], 'merchant', 'transactions', 'fuel', null, true, true),
  seed('careem', 'Careem', ['Careem Ride'], 'merchant', 'transactions', 'transport', null, false, true),
  seed('uber', 'Uber', ['Uber Trip'], 'merchant', 'transactions', 'transport', null, false, true),
  seed('indrive', 'inDrive', ['In Drive', 'Indrive'], 'merchant', 'transactions', 'transport', null, false, true),
  seed('yango', 'Yango', ['Yango Ride'], 'merchant', 'transactions', 'transport', null, false, true),

  /* Marketplaces / subscriptions */
  seed('daraz', 'Daraz', ['Daraz.pk'], 'merchant', 'transactions', 'shopping', null, false, true),
  seed('foodpanda', 'Foodpanda', ['Food Panda'], 'merchant', 'transactions', 'food_dining', null, false, true),
  seed('temu', 'Temu', ['Temu.com'], 'merchant', 'transactions', 'shopping', null, false, true),
  seed('aliexpress', 'AliExpress', ['Alibaba AliExpress'], 'merchant', 'transactions', 'shopping', null, false, true),
  seed('amazon', 'Amazon', ['Amazon Marketplace'], 'merchant', 'transactions', 'shopping', null, false, true),
  seed('apple', 'Apple', ['Apple Services', 'Apple.com/bill'], 'merchant', 'transactions', 'subscriptions', null, false, true),
  seed('google', 'Google', ['Google Play', 'Google Services'], 'merchant', 'transactions', 'subscriptions', null, false, true),
  seed('netflix', 'Netflix', ['Netflix.com'], 'merchant', 'transactions', 'subscriptions', null, false, true),
  seed('spotify', 'Spotify', ['Spotify AB'], 'merchant', 'transactions', 'subscriptions', null, false, true),
  seed('meta', 'Meta', ['Facebook', 'Instagram', 'Meta Ads'], 'merchant', 'transactions', 'subscriptions', null, false, true),

  /* Loan providers */
  seed('jinglecred', 'JINGLECRED', ['JingleCred', 'Jingle Cred', 'JINGLECRED MCB'], 'loan_provider', 'nano_loans', 'debt_payment', 'easypaisa', false, true),
  seed('barwaqt', 'Barwaqt', ['Barwaqt Loan'], 'loan_provider', 'nano_loans', 'debt_payment', null, false, true),
  seed('finja', 'Finja', ['Finja Loan'], 'loan_provider', 'nano_loans', 'debt_payment', null, false, true),
  seed('abhi', 'Abhi', ['Abhi Finance'], 'loan_provider', 'nano_loans', 'debt_payment', null, false, true),

  /* Statement-specific merchants/payees */
  seed('mepco_statement', 'MEPCO Statement Payee', ['MEPCO bill payment', 'Paid to MEPCO'], 'biller', 'bills', 'bills_utilities', null, false, true),
  seed('best_mobile_communication', 'Best Mobile Communication', ['Best Mobile Commuintion', 'Best Mobile'], 'merchant', 'transactions', 'mobile_recharge', null, false, true),
  seed('vip_store', 'VIP STORE', ['VIP Store'], 'merchant', 'transactions', 'shopping', null, false, true),

  /* People from statements: review required */
  seed('azeem_ahmed', 'Azeem Ahmed', ['Azeem Ahmed'], 'person', 'review', null, null, false, false),
  seed('shehzad_riaz', 'Shehzad Riaz', ['Shehzad Riaz'], 'person', 'review', null, null, false, false),
  seed('qaseem_munir', 'Qaseem Munir', ['Qaseem Munir'], 'person', 'review', null, null, false, false),
  seed('jawad_danish', 'Jawad Danish', ['Jawad Danish'], 'person', 'review', null, null, false, false),
  seed('naseem_bibi', 'Naseem Bibi', ['Naseem Bibi'], 'person', 'review', null, null, false, false),
  seed('safeena_tahir', 'Safeena Tahir', ['Safeena Tahir'], 'person', 'review', null, null, false, false),
  seed('yousra_urooj', 'Yousra Urooj', ['Yousra Urooj'], 'person', 'review', null, null, false, false),
  seed('naveed_ahmed', 'Naveed Ahmed', ['Naveed Ahmed'], 'person', 'review', null, null, false, false),
  seed('jamima_khan', 'Jamima Khan', ['Jamima Khan'], 'person', 'review', null, null, false, false),
  seed('muhammad_onaiz', 'Muhammad Onaiz', ['Muhammad Onaiz'], 'person', 'review', null, null, false, false),
  seed('ghulam_shabir', 'Ghulam Shabir', ['Ghulam Shabir'], 'person', 'review', null, null, false, false),
  seed('adil_ali', 'Adil Ali', ['Adil Ali'], 'person', 'review', null, null, false, false),
  seed('tahur_naqash', 'Tahur Naqash', ['Tahur Naqash', 'Tahur Naqash Ahmad'], 'person', 'review', null, null, false, false),
  seed('muhammad_saleem', 'Muhammad Saleem', ['Muhammad Saleem'], 'person', 'review', null, null, false, false),
  seed('muhammad_shahid_ramzan', 'Muhammad Shahid Ramzan', ['Muhammad Shahid Ramzan'], 'person', 'review', null, null, false, false),
  seed('allah_rakha', 'Allah Rakha', ['Allah Rakha'], 'person', 'review', null, null, false, false)
];

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const path = getPath(context);
    const action = cleanText(url.searchParams.get('action'), '', 80).toLowerCase();

    if (action === 'health' || path[0] === 'health') {
      return merchantsHealth(db);
    }

    const merchantId = cleanId(path[0] || '');
    const [merchantCols, categoryCols, accountCols] = await Promise.all([
      tableColumns(db, 'merchants'),
      tableColumns(db, 'categories'),
      tableColumns(db, 'accounts')
    ]);

    if (!merchantCols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'merchants table missing id column'
      }, 500);
    }

    if (merchantId) {
      const merchant = await loadMerchant(db, merchantCols, merchantId);

      if (!merchant) {
        return json({
          ok: false,
          version: VERSION,
          contract_version: CONTRACT_VERSION,
          error: 'merchant not found',
          code: 'MERCHANT_NOT_FOUND',
          id: merchantId
        }, 404);
      }

      return json({
        ok: true,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        merchant: enrichMerchant(merchant)
      });
    }

    const merchants = await loadMerchants(db, merchantCols);
    const enriched = merchants.map(enrichMerchant);
    const summary = summarizeMerchants(enriched);

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      route: '/api/merchants',
      supported_routes: [
        'GET /api/merchants',
        'GET /api/merchants?action=health',
        'GET /api/merchants/{id}',
        'POST /api/merchants',
        'POST /api/merchants/match',
        'POST /api/merchants/seed',
        'POST /api/merchants/{id}/touch',
        'PUT /api/merchants/{id}',
        'DELETE /api/merchants/{id}'
      ],
      count: enriched.length,
      merchants: enriched,
      seed_count: SEED_COUNTERPARTIES.length,
      seed_preview: SEED_COUNTERPARTIES,
      summary,
      rules: {
        money_mutation_allowed: false,
        classification_only: true,
        connects_to_add_transaction: true,
        connects_to_ledger_display: true,
        connects_to_bills: true,
        connects_to_nano_loans: true,
        connects_to_atm: true,
        connects_to_reconciliation: true,
        ambiguous_people_require_review: true
      },
      schema: {
        merchant_columns: Array.from(merchantCols),
        categories_available: categoryCols.has('id'),
        accounts_available: accountCols.has('id')
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
    const db = context.env.DB;
    const path = getPath(context);
    const body = await readJSON(context.request);
    const actionOrId = cleanText(path[0] || body.action || '', '', 120).toLowerCase();
    const subAction = cleanText(path[1] || '', '', 80).toLowerCase();

    if (actionOrId === 'match' || cleanText(body.action || '', '', 80).toLowerCase() === 'match') {
      return matchMerchantRoute(db, body);
    }

    if (actionOrId === 'seed' || cleanText(body.action || '', '', 80).toLowerCase() === 'seed') {
      return seedMerchantsRoute(db, body);
    }

    if (actionOrId && subAction === 'touch') {
      return touchMerchantRoute(db, actionOrId, body);
    }

    if (!path.length || actionOrId === 'create') {
      return createMerchantRoute(db, body);
    }

    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'Unsupported merchant POST route',
      code: 'UNSUPPORTED_MERCHANT_ROUTE',
      supported: [
        'POST /api/merchants',
        'POST /api/merchants/match',
        'POST /api/merchants/seed',
        'POST /api/merchants/{id}/touch'
      ]
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

export async function onRequestPut(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);
    const id = cleanId(path[0] || '');
    const body = await readJSON(context.request);

    if (!id) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'merchant id required',
        code: 'MERCHANT_ID_REQUIRED'
      }, 400);
    }

    return updateMerchantRoute(db, id, body);
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err),
      stage: 'onRequestPut'
    }, 500);
  }
}

export async function onRequestDelete(context) {
  try {
    const db = context.env.DB;
    const path = getPath(context);
    const id = cleanId(path[0] || '');

    if (!id) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'merchant id required',
        code: 'MERCHANT_ID_REQUIRED'
      }, 400);
    }

    const merchantCols = await tableColumns(db, 'merchants');

    if (!merchantCols.has('id')) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'merchants table missing id column',
        code: 'MERCHANTS_SCHEMA_INVALID'
      }, 500);
    }

    const existing = await loadMerchant(db, merchantCols, id);

    if (!existing) {
      return json({
        ok: false,
        version: VERSION,
        contract_version: CONTRACT_VERSION,
        error: 'merchant not found',
        code: 'MERCHANT_NOT_FOUND',
        id
      }, 404);
    }

    let deleteMode = 'hard_delete';

    if (merchantCols.has('deleted_at')) {
      deleteMode = 'soft_delete';
      await db.prepare(
        `UPDATE merchants SET deleted_at = ? WHERE id = ?`
      ).bind(nowISO(), id).run();
    } else if (merchantCols.has('archived_at')) {
      deleteMode = 'archive';
      await db.prepare(
        `UPDATE merchants SET archived_at = ? WHERE id = ?`
      ).bind(nowISO(), id).run();
    } else if (merchantCols.has('status')) {
      deleteMode = 'status_archived';
      await db.prepare(
        `UPDATE merchants SET status = ? WHERE id = ?`
      ).bind('archived', id).run();
    } else {
      await db.prepare(
        `DELETE FROM merchants WHERE id = ?`
      ).bind(id).run();
    }

    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_delete',
      id,
      delete_mode: deleteMode,
      money_mutation_allowed: false
    });
  } catch (err) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: err.message || String(err),
      stage: 'onRequestDelete'
    }, 500);
  }
}

async function createMerchantRoute(db, body) {
  const [merchantCols, categoryCols, accountCols] = await Promise.all([
    tableColumns(db, 'merchants'),
    tableColumns(db, 'categories'),
    tableColumns(db, 'accounts')
  ]);

  if (!merchantCols.has('id') || !merchantCols.has('name')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'merchants table missing required columns',
      code: 'MERCHANTS_SCHEMA_INVALID'
    }, 500);
  }

  const prepared = await prepareMerchantInput(db, merchantCols, categoryCols, accountCols, body, null);

  if (!prepared.ok) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_create',
      error: prepared.error,
      code: prepared.code,
      details: prepared.details || null,
      committed: false
    }, prepared.status || 400);
  }

  await db.prepare(
    `INSERT INTO merchants (${Object.keys(prepared.row).join(', ')})
     VALUES (${Object.keys(prepared.row).map(() => '?').join(', ')})`
  ).bind(...Object.values(prepared.row)).run();

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'merchant_create',
    committed: true,
    merchant: enrichMerchant(prepared.publicRow),
    money_mutation_allowed: false
  });
}

async function updateMerchantRoute(db, id, body) {
  const [merchantCols, categoryCols, accountCols] = await Promise.all([
    tableColumns(db, 'merchants'),
    tableColumns(db, 'categories'),
    tableColumns(db, 'accounts')
  ]);

  if (!merchantCols.has('id') || !merchantCols.has('name')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'merchants table missing required columns',
      code: 'MERCHANTS_SCHEMA_INVALID'
    }, 500);
  }

  const existing = await loadMerchant(db, merchantCols, id);

  if (!existing) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_update',
      error: 'merchant not found',
      code: 'MERCHANT_NOT_FOUND',
      id,
      committed: false
    }, 404);
  }

  const prepared = await prepareMerchantInput(db, merchantCols, categoryCols, accountCols, body, id);

  if (!prepared.ok) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_update',
      error: prepared.error,
      code: prepared.code,
      details: prepared.details || null,
      committed: false
    }, prepared.status || 400);
  }

  const entries = Object.entries(prepared.row).filter(([key]) => key !== 'id');

  if (!entries.length) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_update',
      error: 'nothing to update',
      code: 'NO_UPDATE_FIELDS',
      committed: false
    }, 400);
  }

  const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);

  await db.prepare(
    `UPDATE merchants SET ${setSql} WHERE id = ?`
  ).bind(...values, id).run();

  const updated = await loadMerchant(db, merchantCols, id);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'merchant_update',
    committed: true,
    merchant: enrichMerchant(updated),
    money_mutation_allowed: false
  });
}

async function touchMerchantRoute(db, id, body) {
  const merchantCols = await tableColumns(db, 'merchants');

  if (!merchantCols.has('id')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      error: 'merchants table missing id column',
      code: 'MERCHANTS_SCHEMA_INVALID'
    }, 500);
  }

  const merchant = await loadMerchant(db, merchantCols, id);

  if (!merchant) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_touch',
      error: 'merchant not found',
      code: 'MERCHANT_NOT_FOUND',
      id,
      committed: false
    }, 404);
  }

  const previous = Number(merchant.learned_count || 0);
  const next = previous + 1;

  if (merchantCols.has('learned_count')) {
    const updates = ['learned_count = ?'];
    const values = [next];

    if (merchantCols.has('updated_at')) {
      updates.push('updated_at = ?');
      values.push(nowISO());
    }

    values.push(id);

    await db.prepare(
      `UPDATE merchants SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'MERCHANT_TOUCH',
    id,
    previous_count: previous,
    new_count: next,
    source: cleanText(body.source || 'manual', '', 80),
    transaction_id: cleanText(body.transaction_id || '', '', 160) || null,
    money_mutation_allowed: false
  });
}

async function matchMerchantRoute(db, body) {
  const text = cleanText(body.text || body.description || body.merchant || body.notes || '', '', 500);

  if (!text) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_match',
      error: 'text is required',
      code: 'TEXT_REQUIRED'
    }, 400);
  }

  const merchantCols = await tableColumns(db, 'merchants');
  const dbMerchants = merchantCols.has('id')
    ? (await loadMerchants(db, merchantCols)).map(enrichMerchant)
    : [];

  const candidates = buildCandidates(dbMerchants);
  const match = matchText(text, candidates);

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'merchant_match',
    input_text: text,
    normalized_text: normalizeText(text),
    matched: !!match.best,
    merchant: match.best ? publicMatch(match.best) : null,
    match_type: match.best ? match.best.match_type : null,
    confidence: match.best ? match.best.confidence : 0,
    review_required: match.best ? match.best.review_required : true,
    suggestions: match.suggestions.map(publicMatch),
    rules: {
      exact_or_alias_can_autofill: true,
      person_payees_require_review: true,
      payment_rails_require_context: true,
      fuzzy_match_never_auto_commits: true,
      money_mutation_allowed: false
    }
  });
}

async function seedMerchantsRoute(db, body) {
  const [merchantCols, categoryCols, accountCols] = await Promise.all([
    tableColumns(db, 'merchants'),
    tableColumns(db, 'categories'),
    tableColumns(db, 'accounts')
  ]);

  if (!merchantCols.has('id') || !merchantCols.has('name')) {
    return json({
      ok: false,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchant_seed',
      error: 'merchants table missing required columns',
      code: 'MERCHANTS_SCHEMA_INVALID',
      committed: false
    }, 500);
  }

  const mode = cleanText(body.mode || 'safe_missing_only', '', 80);
  const dryRun = body.dry_run !== false;
  const existing = await loadMerchants(db, merchantCols);
  const existingIds = new Set(existing.map(row => String(row.id)));
  const existingNames = new Set(existing.map(row => normalizeText(row.name)));

  const toInsert = [];

  for (const item of SEED_COUNTERPARTIES) {
    if (existingIds.has(item.id) || existingNames.has(normalizeText(item.name))) continue;

    const prepared = await prepareMerchantInput(db, merchantCols, categoryCols, accountCols, {
      id: item.id,
      name: item.name,
      aliases: item.aliases,
      default_category_id: item.default_category_id,
      default_account_id: item.default_account_id,
      is_pra_required: item.is_pra_required
    }, null, true);

    if (prepared.ok) {
      toInsert.push({
        seed: item,
        row: prepared.row,
        publicRow: prepared.publicRow
      });
    }
  }

  if (!dryRun) {
    const statements = toInsert.map(item => {
      const keys = Object.keys(item.row);
      return db.prepare(
        `INSERT INTO merchants (${keys.join(', ')})
         VALUES (${keys.map(() => '?').join(', ')})`
      ).bind(...keys.map(key => item.row[key]));
    });

    if (statements.length) {
      await db.batch(statements);
    }
  }

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'merchant_seed',
    mode,
    dry_run: dryRun,
    committed: !dryRun,
    inserted_count: dryRun ? 0 : toInsert.length,
    insertable_count: toInsert.length,
    skipped_existing_count: SEED_COUNTERPARTIES.length - toInsert.length,
    insertable: toInsert.map(item => enrichSeedPublic(item.seed, item.publicRow)),
    note: dryRun
      ? 'Seed preview only. Re-run with {"action":"seed","dry_run":false} to insert missing records.'
      : 'Seed records inserted where missing.',
    money_mutation_allowed: false
  });
}

async function merchantsHealth(db) {
  const [merchantCols, categoryCols, accountCols] = await Promise.all([
    tableColumns(db, 'merchants'),
    tableColumns(db, 'categories'),
    tableColumns(db, 'accounts')
  ]);

  if (!merchantCols.has('id') || !merchantCols.has('name')) {
    return json({
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'merchants.health',
      status: 'fail',
      checks: {
        merchants_table_has_id: merchantCols.has('id'),
        merchants_table_has_name: merchantCols.has('name')
      },
      errors: [
        {
          code: 'MERCHANTS_SCHEMA_INVALID',
          error: 'merchants table missing id or name column'
        }
      ]
    });
  }

  const [merchants, categories, accounts] = await Promise.all([
    loadMerchants(db, merchantCols),
    loadCategories(db, categoryCols),
    loadAccounts(db, accountCols)
  ]);

  const categoryIds = new Set(categories.map(row => String(row.id)));
  const accountIds = new Set(accounts.map(row => String(row.id)));

  const duplicateNames = findDuplicates(merchants.map(row => normalizeText(row.name)).filter(Boolean));
  const duplicateAliases = findDuplicateAliases(merchants);
  const missingCategoryRefs = [];
  const missingAccountRefs = [];
  const invalidPraFlags = [];
  const invalidLearnedCount = [];

  for (const merchant of merchants) {
    if (merchant.default_category_id && categoryCols.has('id') && !categoryIds.has(String(merchant.default_category_id))) {
      missingCategoryRefs.push({
        id: merchant.id,
        name: merchant.name,
        default_category_id: merchant.default_category_id,
        error: 'default_category_id not found in categories'
      });
    }

    if (merchant.default_account_id && accountCols.has('id') && !accountIds.has(String(merchant.default_account_id))) {
      missingAccountRefs.push({
        id: merchant.id,
        name: merchant.name,
        default_account_id: merchant.default_account_id,
        error: 'default_account_id not found in accounts'
      });
    }

    if (merchant.is_pra_required != null && !['0', '1', 'true', 'false', true, false, 0, 1].includes(merchant.is_pra_required)) {
      invalidPraFlags.push({
        id: merchant.id,
        value: merchant.is_pra_required,
        error: 'is_pra_required must be boolean/0/1'
      });
    }

    if (merchant.learned_count != null && Number(merchant.learned_count) < 0) {
      invalidLearnedCount.push({
        id: merchant.id,
        value: merchant.learned_count,
        error: 'learned_count cannot be negative'
      });
    }
  }

  const failCount =
    duplicateNames.length +
    duplicateAliases.length +
    missingCategoryRefs.length +
    missingAccountRefs.length +
    invalidPraFlags.length +
    invalidLearnedCount.length;

  const status = failCount ? 'fail' : 'pass';

  return json({
    ok: true,
    version: VERSION,
    contract_version: CONTRACT_VERSION,
    action: 'merchants.health',
    status,
    counts: {
      merchants: merchants.length,
      seed_counterparties: SEED_COUNTERPARTIES.length,
      categories: categories.length,
      accounts: accounts.length,
      duplicate_names: duplicateNames.length,
      duplicate_aliases: duplicateAliases.length,
      missing_category_refs: missingCategoryRefs.length,
      missing_account_refs: missingAccountRefs.length,
      invalid_pra_flags: invalidPraFlags.length,
      invalid_learned_count: invalidLearnedCount.length
    },
    checks: {
      merchants_table_has_id: true,
      merchants_table_has_name: true,
      category_refs_ok: missingCategoryRefs.length === 0,
      account_refs_ok: missingAccountRefs.length === 0,
      duplicate_names_ok: duplicateNames.length === 0,
      duplicate_aliases_ok: duplicateAliases.length === 0,
      pra_flags_ok: invalidPraFlags.length === 0,
      learned_count_ok: invalidLearnedCount.length === 0,
      money_mutation_allowed: false,
      health_is_read_only: true
    },
    duplicate_names: duplicateNames,
    duplicate_aliases: duplicateAliases,
    missing_category_refs: missingCategoryRefs,
    missing_account_refs: missingAccountRefs,
    invalid_pra_flags: invalidPraFlags,
    invalid_learned_count: invalidLearnedCount,
    rules: {
      classification_only: true,
      add_transaction_autofill: true,
      ledger_display_normalization: true,
      bills_biller_matching: true,
      nano_loan_provider_matching: true,
      atm_rail_matching: true,
      reconciliation_statement_matching: true
    }
  });
}

async function prepareMerchantInput(db, merchantCols, categoryCols, accountCols, body, updatingId, seedMode) {
  const name = cleanText(body.name || body.merchant_name || '', '', 160);
  const id = cleanId(body.id || name);
  const aliases = normalizeAliases(body.aliases);
  const defaultCategoryId = cleanId(body.default_category_id || body.category_id || '');
  const defaultAccountId = cleanId(body.default_account_id || body.account_id || '');
  const isPraRequired = boolean01(body.is_pra_required ?? body.pra_required ?? false);
  const now = nowISO();

  if (!name) {
    return {
      ok: false,
      status: 400,
      code: 'MERCHANT_NAME_REQUIRED',
      error: 'merchant name is required'
    };
  }

  if (!id) {
    return {
      ok: false,
      status: 400,
      code: 'MERCHANT_ID_REQUIRED',
      error: 'merchant id is required'
    };
  }

  const duplicate = await findDuplicateMerchant(db, merchantCols, id, name, updatingId);

  if (duplicate) {
    return {
      ok: false,
      status: 409,
      code: 'DUPLICATE_MERCHANT',
      error: 'merchant id or name already exists',
      details: duplicate
    };
  }

  if (defaultCategoryId && categoryCols.has('id')) {
    const cat = await db.prepare(
      `SELECT id FROM categories WHERE id = ? LIMIT 1`
    ).bind(defaultCategoryId).first();

    if (!cat && !seedMode) {
      return {
        ok: false,
        status: 409,
        code: 'CATEGORY_NOT_FOUND',
        error: 'default_category_id not found',
        details: { default_category_id: defaultCategoryId }
      };
    }
  }

  if (defaultAccountId && accountCols.has('id')) {
    const acc = await db.prepare(
      `SELECT id FROM accounts WHERE id = ? LIMIT 1`
    ).bind(defaultAccountId).first();

    if (!acc && !seedMode) {
      return {
        ok: false,
        status: 409,
        code: 'ACCOUNT_NOT_FOUND',
        error: 'default_account_id not found',
        details: { default_account_id: defaultAccountId }
      };
    }
  }

  const rawRow = {
    id,
    name,
    aliases: JSON.stringify(aliases),
    default_category_id: defaultCategoryId || null,
    default_account_id: defaultAccountId || null,
    is_pra_required: isPraRequired,
    learned_count: body.learned_count == null ? 0 : Math.max(0, Number(body.learned_count) || 0),
    created_at: now,
    updated_at: now
  };

  const row = filterToCols(merchantCols, rawRow);
  const publicRow = {
    ...rawRow,
    aliases,
    is_pra_required: !!isPraRequired
  };

  return {
    ok: true,
    row,
    publicRow
  };
}

async function findDuplicateMerchant(db, merchantCols, id, name, updatingId) {
  if (!merchantCols.has('id') || !merchantCols.has('name')) return null;

  const rows = await db.prepare(
    `SELECT id, name FROM merchants`
  ).all();

  const normalizedName = normalizeText(name);

  for (const row of rows.results || []) {
    if (updatingId && String(row.id) === String(updatingId)) continue;

    if (String(row.id) === String(id)) {
      return {
        id: row.id,
        name: row.name,
        reason: 'id'
      };
    }

    if (normalizeText(row.name) === normalizedName) {
      return {
        id: row.id,
        name: row.name,
        reason: 'name'
      };
    }
  }

  return null;
}

async function loadMerchant(db, cols, id) {
  if (!cols.has('id')) return null;

  const wanted = merchantSelectColumns(cols);

  const row = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM merchants
     WHERE id = ?
     LIMIT 1`
  ).bind(id).first();

  return row || null;
}

async function loadMerchants(db, cols) {
  if (!cols.has('id')) return [];

  const wanted = merchantSelectColumns(cols);
  const orderBy = cols.has('learned_count')
    ? 'learned_count DESC, name ASC'
    : (cols.has('name') ? 'name ASC' : 'id ASC');

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM merchants
     ORDER BY ${orderBy}`
  ).all();

  return result.results || [];
}

function merchantSelectColumns(cols) {
  return [
    'id',
    'name',
    'aliases',
    'default_category_id',
    'default_account_id',
    'is_pra_required',
    'learned_count',
    'created_at',
    'updated_at',
    'deleted_at',
    'archived_at',
    'status'
  ].filter(col => cols.has(col));
}

async function loadCategories(db, cols) {
  if (!cols.has('id')) return [];

  const wanted = ['id', 'name', 'type'].filter(col => cols.has(col));

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM categories
     ORDER BY ${cols.has('name') ? 'name' : 'id'}`
  ).all();

  return result.results || [];
}

async function loadAccounts(db, cols) {
  if (!cols.has('id')) return [];

  const wanted = ['id', 'name', 'type', 'kind', 'status', 'deleted_at', 'archived_at'].filter(col => cols.has(col));
  const where = activeAccountWhere(cols);

  const result = await db.prepare(
    `SELECT ${wanted.join(', ')}
     FROM accounts
     ${where ? 'WHERE ' + where : ''}
     ORDER BY ${cols.has('name') ? 'name' : 'id'}`
  ).all();

  return result.results || [];
}

function enrichMerchant(row) {
  const aliases = normalizeAliases(row.aliases);
  const seedMatch = SEED_COUNTERPARTIES.find(seedItem =>
    normalizeText(seedItem.name) === normalizeText(row.name) ||
    seedItem.id === row.id ||
    seedItem.aliases.some(alias => normalizeText(alias) === normalizeText(row.name))
  );

  return {
    id: row.id,
    name: row.name,
    aliases,
    default_category_id: row.default_category_id || seedMatch?.default_category_id || null,
    default_account_id: row.default_account_id || seedMatch?.default_account_id || null,
    is_pra_required: booleanBool(row.is_pra_required ?? seedMatch?.is_pra_required ?? false),
    learned_count: Number(row.learned_count || 0),
    counterparty_type: seedMatch?.counterparty_type || inferCounterpartyType(row.name, aliases),
    default_module: seedMatch?.default_module || inferDefaultModule(row.name, aliases),
    auto_apply_allowed: seedMatch ? !!seedMatch.auto_apply_allowed : false,
    review_required: seedMatch ? !seedMatch.auto_apply_allowed : true,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function enrichSeedPublic(seedItem, publicRow) {
  return {
    ...publicRow,
    counterparty_type: seedItem.counterparty_type,
    default_module: seedItem.default_module,
    auto_apply_allowed: seedItem.auto_apply_allowed,
    review_required: !seedItem.auto_apply_allowed
  };
}

function buildCandidates(dbMerchants) {
  const candidates = [];

  for (const row of dbMerchants) {
    candidates.push({
      source: 'db',
      id: row.id,
      name: row.name,
      aliases: normalizeAliases(row.aliases),
      counterparty_type: row.counterparty_type || inferCounterpartyType(row.name, row.aliases),
      default_module: row.default_module || inferDefaultModule(row.name, row.aliases),
      default_category_id: row.default_category_id || null,
      default_account_id: row.default_account_id || null,
      is_pra_required: !!row.is_pra_required,
      auto_apply_allowed: !!row.auto_apply_allowed,
      review_required: row.review_required !== false
    });
  }

  for (const row of SEED_COUNTERPARTIES) {
    candidates.push({
      source: 'seed',
      ...row,
      review_required: !row.auto_apply_allowed
    });
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];

  for (const candidate of candidates) {
    const key = candidate.id || normalizeText(candidate.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }

  return out;
}

function matchText(text, candidates) {
  const normalized = normalizeText(text);
  const suggestions = [];

  for (const candidate of candidates) {
    const names = [candidate.name].concat(candidate.aliases || []);
    let bestScore = 0;
    let bestType = '';

    for (const name of names) {
      const n = normalizeText(name);
      if (!n) continue;

      if (normalized === n) {
        bestScore = Math.max(bestScore, 1);
        bestType = 'exact';
      } else if (normalized.includes(n) || n.includes(normalized)) {
        const score = Math.min(0.94, 0.74 + Math.min(n.length, normalized.length) / 100);
        if (score > bestScore) {
          bestScore = score;
          bestType = 'contains';
        }
      } else {
        const tokenScore = tokenOverlapScore(normalized, n);
        if (tokenScore > bestScore) {
          bestScore = tokenScore;
          bestType = 'token';
        }
      }
    }

    if (bestScore >= 0.42) {
      suggestions.push({
        ...candidate,
        confidence: round2(bestScore),
        match_type: bestType,
        review_required: candidate.counterparty_type === 'person' ? true : !candidate.auto_apply_allowed
      });
    }
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);

  const best = suggestions[0] || null;

  return {
    best: best && best.confidence >= 0.55 ? best : null,
    suggestions: suggestions.slice(0, 8)
  };
}

function publicMatch(match) {
  return {
    source: match.source,
    id: match.id,
    name: match.name,
    aliases: normalizeAliases(match.aliases),
    counterparty_type: match.counterparty_type,
    default_module: match.default_module,
    default_category_id: match.default_category_id || null,
    default_account_id: match.default_account_id || null,
    is_pra_required: !!match.is_pra_required,
    auto_apply_allowed: !!match.auto_apply_allowed,
    review_required: !!match.review_required,
    confidence: match.confidence,
    match_type: match.match_type
  };
}

function summarizeMerchants(merchants) {
  const byType = {};

  for (const merchant of merchants) {
    const type = merchant.counterparty_type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;
  }

  return {
    total: merchants.length,
    by_type: byType,
    auto_apply_allowed: merchants.filter(row => row.auto_apply_allowed).length,
    review_required: merchants.filter(row => row.review_required).length
  };
}

function inferCounterpartyType(name, aliases) {
  const joined = normalizeText([name].concat(aliases || []).join(' '));

  if (joined.includes('bank')) return 'bank';
  if (joined.includes('easypaisa') || joined.includes('jazzcash') || joined.includes('nayapay') || joined.includes('sadapay')) return 'wallet';
  if (joined.includes('mepco') || joined.includes('lesco') || joined.includes('sngpl') || joined.includes('ptcl')) return 'biller';
  if (joined.includes('jinglecred') || joined.includes('barwaqt') || joined.includes('finja')) return 'loan_provider';
  if (joined.includes('atm') || joined.includes('raast') || joined.includes('ibft') || joined.includes('1link')) return 'payment_rail';

  return 'merchant';
}

function inferDefaultModule(name, aliases) {
  const type = inferCounterpartyType(name, aliases);

  if (type === 'biller') return 'bills';
  if (type === 'loan_provider') return 'nano_loans';
  if (type === 'payment_rail') return 'review';
  if (type === 'person') return 'review';

  return 'transactions';
}

function findDuplicates(values) {
  const seen = new Map();
  const duplicates = [];

  for (const value of values) {
    if (!value) continue;

    if (seen.has(value)) {
      duplicates.push({
        value,
        count: (seen.get(value) || 1) + 1
      });
    } else {
      seen.set(value, 1);
    }
  }

  return duplicates;
}

function findDuplicateAliases(merchants) {
  const aliasMap = new Map();
  const duplicates = [];

  for (const merchant of merchants) {
    const aliases = normalizeAliases(merchant.aliases);

    for (const alias of aliases) {
      const key = normalizeText(alias);
      if (!key) continue;

      if (aliasMap.has(key) && aliasMap.get(key) !== merchant.id) {
        duplicates.push({
          alias,
          first_merchant_id: aliasMap.get(key),
          second_merchant_id: merchant.id
        });
      } else {
        aliasMap.set(key, merchant.id);
      }
    }
  }

  return duplicates;
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(a.split(' ').filter(Boolean));
  const bTokens = new Set(b.split(' ').filter(Boolean));

  if (!aTokens.size || !bTokens.size) return 0;

  let overlap = 0;

  for (const token of bTokens) {
    if (aTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(aTokens.size, bTokens.size);
}

function seed(id, name, aliases, counterpartyType, defaultModule, defaultCategoryId, defaultAccountId, isPraRequired, autoApplyAllowed) {
  return {
    id,
    name,
    aliases: aliases || [],
    counterparty_type: counterpartyType,
    default_module: defaultModule,
    default_category_id: defaultCategoryId,
    default_account_id: defaultAccountId,
    is_pra_required: !!isPraRequired,
    auto_apply_allowed: !!autoApplyAllowed,
    review_required: !autoApplyAllowed
  };
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

function activeAccountWhere(cols) {
  const clauses = [];

  if (cols.has('deleted_at')) clauses.push("(deleted_at IS NULL OR deleted_at = '')");
  if (cols.has('archived_at')) clauses.push("(archived_at IS NULL OR archived_at = '')");
  if (cols.has('status')) clauses.push("(status IS NULL OR status = '' OR LOWER(TRIM(status)) = 'active')");

  return clauses.join(' AND ');
}

function filterToCols(cols, row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (cols.has(key)) out[key] = value;
  }

  return out;
}

function normalizeAliases(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map(v => cleanText(v, '', 160)).filter(Boolean)));
  }

  if (value == null || value === '') return [];

  const raw = String(value).trim();

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeAliases(parsed);
    }
  } catch {
    /* continue */
  }

  return Array.from(new Set(raw.split(',').map(v => cleanText(v, '', 160)).filter(Boolean)));
}

function boolean01(value) {
  if (value === true || value === 1 || value === '1') return 1;
  if (String(value || '').toLowerCase() === 'true') return 1;
  return 0;
}

function booleanBool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function cleanText(value, fallback = '', max = 500) {
  const raw = value == null ? fallback : value;

  return String(raw == null ? '' : raw)
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nowISO() {
  return new Date().toISOString();
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

function round2(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.round(n * 100) / 100;
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
