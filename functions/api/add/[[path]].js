/* /api/add/[[path]] — Add Transaction Orchestrator
 * Sovereign Finance v1.0.0-add-orchestrator-core
 *
 * Shipment 1 scope:
 * - GET  /api/add/context
 * - POST /api/add/preview
 * - POST /api/add/dry-run
 * - POST /api/add/commit
 *
 * Direct commit modes:
 * - expense
 * - income
 * - transfer
 *
 * Everything else is routed/advisory until its owner contract is locked.
 */

import { json } from '../_lib.js';

const VERSION = 'v1.0.0-add-orchestrator-core';

const DIRECT_MODES = new Set(['expense', 'income', 'transfer']);

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

  salary_income: {
    label: 'Salary Income',
    capability: 'advisory',
    route: 'transactions',
    suggested_mode: 'income',
    owner_url: '/salary.html'
  },
  international_purchase: {
    label: 'International Purchase',
    capability: 'preview_only',
    route: 'transaction_package',
    owner_url: '/add.html?mode=international_purchase'
  },

  bill_payment: {
    label: 'Bill Payment',
    capability: 'routed',
    route: 'bills',
    owner_url: '/bills.html'
  },
  debt_given: {
    label: 'Debt Given',
    capability: 'routed',
    route: 'debts',
    owner_url: '/debts.html'
  },
  debt_received: {
    label: 'Debt Received',
    capability: 'routed',
    route: 'debts',
    owner_url: '/debts.html'
  },
  cc_payment: {
    label: 'Credit Card Payment',
    capability: 'routed',
    route: 'credit_card',
    owner_url: '/cc.html'
  },
  cc_spend: {
    label: 'Credit Card Spend',
    capability: 'routed',
    route: 'credit_card',
    owner_url: '/cc.html'
  },
  atm_withdrawal: {
    label: 'ATM Withdrawal',
    capability: 'routed',
    route: 'atm',
    owner_url: '/atm.html'
  },
  merchant_learning: {
    label: 'Merchant Learning',
    capability: 'explicit_later',
    route: 'merchants',
    owner_url: '/merchants.html'
  }
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

  if (!text || !text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Invalid JSON body');
  }
}

async function handleContext(context) {
  const [accounts, categories, merchants] = await Promise.all([
    internalJSON(context, '/api/accounts'),
    internalJSON(context, '/api/categories'),
    internalJSON(context, '/api/merchants')
  ]);

  const accountsOk = accounts.ok && accounts.payload && accounts.payload.ok !== false;
  const categoriesOk = categories.ok && categories.payload && categories.payload.ok !== false;
  const merchantsOk = merchants.ok && merchants.payload && merchants.payload.ok !== false;

  return json({
    ok: true,
    version: VERSION,
    source_status: {
      accounts: accountsOk ? 'ok' : 'failed',
      categories: categoriesOk ? 'ok' : 'failed',
      merchants: merchantsOk ? 'ok' : 'failed_optional'
    },
    can_direct_write: accountsOk && categoriesOk,
    accounts: accountsOk ? unwrapArray(accounts.payload, ['accounts', 'items', 'rows', 'data']) : [],
    categories: categoriesOk ? unwrapArray(categories.payload, ['categories', 'items', 'rows', 'data']) : [],
    merchants: merchantsOk ? unwrapArray(merchants.payload, ['merchants', 'items', 'rows', 'data']) : [],
    mode_registry: MODE_REGISTRY,
    contract: {
      direct_modes: Array.from(DIRECT_MODES),
      dry_run_required: true,
      commit_requires_payload_hash: true,
      source_rule: 'Direct write requires live /api/accounts and /api/categories. No stale store fallback.',
      advanced_rule: 'Advanced modes are routed/advisory until their owner dry-run and commit contracts are locked.'
    }
  });
}

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

async function handleDryRun(context) {
  const body = await readJSON(context.request);
  const mode = normalizeMode(body.mode || body.type);

  if (!DIRECT_MODES.has(mode)) {
    return json({
      ok: false,
      version: VERSION,
      dry_run: true,
      writes_performed: false,
      error: 'Mode is not direct-write enabled in Add Shipment 1',
      mode,
      mode_spec: MODE_REGISTRY[mode] || null
    }, 400);
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

async function handleCommit(context) {
  const body = await readJSON(context.request);
  const mode = normalizeMode(body.mode || body.type);
  const suppliedHash = cleanText(
    body.dry_run_payload_hash || body.payload_hash,
    '',
    200
  );

  if (!DIRECT_MODES.has(mode)) {
    return json({
      ok: false,
      version: VERSION,
      error: 'Mode is not direct-write enabled in Add Shipment 1',
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
      ids: txCommit.payload.ids || (
        txCommit.payload.id ? [txCommit.payload.id] : []
      )
    },
    redirect: '/transactions.html',
    transaction_response: txCommit.payload
  });
}

async function callTransactions(context, payload, dryRun) {
  const path = dryRun ? '/api/transactions?dry_run=1' : '/api/transactions';
  return await internalJSON(context, path, {
    method: 'POST',
    body: {
      ...payload,
      dry_run: dryRun || undefined,
      created_by: payload.created_by || 'web-add-orchestrator'
    }
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

  const init = {
    method: options.method || 'GET',
    headers
  };

  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(target.toString(), init);
    const payload = await response.json().catch(() => null);

    return {
      ok: response.ok,
      status: response.status,
      payload,
      error: payload && payload.error ? payload.error : null
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      payload: null,
      error: err.message || String(err)
    };
  }
}

function buildTransactionPayload(body, mode) {
  const source = body.payload && typeof body.payload === 'object'
    ? { ...body.payload, ...body }
    : body;

  const notes = buildNotes(source);

  const payload = {
    date: normalizeDate(source.date),
    type: mode,
    amount: cleanAmount(source.amount),
    account_id: cleanText(
      source.account_id || source.from_account_id || source.source_account_id,
      '',
      160
    ),
    category_id: mode === 'transfer'
      ? null
      : cleanText(source.category_id || source.category, '', 160),
    notes,
    fee_amount: cleanNonNegativeAmount(source.fee_amount),
    pra_amount: cleanNonNegativeAmount(source.pra_amount),
    created_by: cleanText(source.created_by, 'web-add-orchestrator', 80)
  };

  if (mode === 'transfer') {
    payload.transfer_to_account_id = cleanText(
      source.transfer_to_account_id ||
      source.to_account_id ||
      source.destination_account_id,
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
    transfer_to_account_id: cleanText(
      body.transfer_to_account_id || body.to_account_id || body.destination_account_id,
      '',
      160
    ),
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
      {
        target: payload.account_id || 'source account',
        direction: 'decrease',
        amount: payload.amount
      },
      {
        target: payload.transfer_to_account_id || 'destination account',
        direction: 'increase',
        amount: payload.amount
      }
    ];
  }

  if (payload.type === 'income') {
    return [
      {
        target: payload.account_id || 'source account',
        direction: 'increase',
        amount: payload.amount
      }
    ];
  }

  return [
    {
      target: payload.account_id || 'source account',
      direction: 'decrease',
      amount: payload.amount
    }
  ];
}

function expectedWritesFromProof(proof) {
  if (!proof) return [];

  return [
    {
      model: proof.write_model || 'transaction',
      transaction_rows: proof.expected_transaction_rows ?? null,
      audit_rows: proof.expected_audit_rows ?? null
    }
  ];
}

function previewWarnings(payload) {
  const warnings = [];

  if (!payload.account_id) warnings.push('Source account is required.');
  if (!payload.amount || payload.amount <= 0) warnings.push('Amount must be greater than zero.');
  if (payload.type === 'transfer' && !payload.transfer_to_account_id) {
    warnings.push('Destination account is required for transfer.');
  }
  if (
    payload.type === 'transfer' &&
    payload.account_id &&
    payload.transfer_to_account_id &&
    payload.account_id === payload.transfer_to_account_id
  ) {
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
    suggestions.push({
      type: 'merchant_lookup',
      label: 'Merchant suggestion available',
      detail: 'Frontend may match this against /api/merchants context.'
    });
  }

  if ((mode === 'income' || mode === 'salary_income') && Number.isFinite(amount) && amount > 50000) {
    suggestions.push({
      type: 'salary_detector',
      label: 'Possible salary income',
      detail: 'Record income here; update salary source only from Salary page unless explicitly implemented.'
    });
  }

  if (mode === 'international_purchase') {
    suggestions.push({
      type: 'international_preview',
      label: 'International package preview only',
      detail: 'Multi-row package commit is not enabled in Shipment 1.'
    });
  }

  return suggestions;
}

async function hashPayload(value) {
  const canonical = canonicalJSONString(value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJSONString(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeys(value[key]);
        return acc;
      }, {});
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

function cleanText(value, fallback, maxLen) {
  const raw = value == null ? fallback : value;
  return String(raw == null ? '' : raw).trim().slice(0, maxLen || 500);
}

function token(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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
