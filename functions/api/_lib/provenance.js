// _lib/provenance.js — FIFO fund-provenance tracer (read-only)
//
// Answers "where did the money in THIS transaction originally come from?" by
// walking funding backwards across accounts until it reaches an external
// origin (salary, manual income, borrow/debt, opening balance, or card credit).
//
// Money is fungible, so attribution uses a FIFO convention: a spend draws from
// the OLDEST un-spent money in its account first. Transfers are followed across
// accounts (the income/IN leg links back to the transfer/OUT leg in the source
// account, whose own funding is then traced — recursively).
//
// This module performs READS ONLY. It never mutates the ledger.

const IN_TYPES = new Set(['income', 'salary', 'opening', 'borrow', 'debt_in', 'adjustment_positive']);
const OUT_TYPES = new Set(['expense', 'transfer', 'cc_payment', 'cc_spend', 'repay', 'atm', 'debt_out', 'adjustment_negative']);

const ORIGIN_LABEL = {
  salary: 'Salary',
  income: 'Manual income',
  borrow: 'Borrowed (loan)',
  debt: 'Debt received',
  adjustment: 'Balance adjustment',
  opening: 'Opening balance',
  card: 'Credit card',
  other: 'Other inflow',
};

const DEFAULT_OPTS = { maxDepth: 24, maxNodes: 200 };

export async function buildProvenance(db, focalRow, opts = {}) {
  const { maxDepth, maxNodes } = { ...DEFAULT_OPTS, ...opts };
  const ctx = {
    db,
    maxDepth,
    maxNodes,
    nodeCount: 0,
    truncated: false,
    ledgers: new Map(),   // accountId -> ledger
    txnCache: new Map(),  // txnId -> row
    accountsTouched: new Set(),
    depthReached: 0,
  };

  const focalLedger = await getLedger(ctx, focalRow.account_id);
  const focalAmount = amt(focalRow);
  const signed = signedEffect(focalRow.type, focalAmount);

  const root = makeNode(ctx, {
    txn_id: String(focalRow.id),
    account_id: focalRow.account_id || null,
    account_name: focalLedger.accountName,
    type: focalRow.type || null,
    origin: 'self',
    label: focalLabel(focalRow),
    date: focalRow.date || null,
    amount: focalAmount,
    is_terminal: false,
  });

  if (isVoided(focalRow)) {
    root.is_terminal = true;
    root.origin = 'voided';
    root.label = 'This entry was reversed — provenance not applicable';
    return finalize(ctx, focalRow, focalLedger, root, focalAmount, 'voided');
  }

  let direction;
  if (signed < 0) {
    // Outflow (spend / transfer-out / repayment): trace what funded it.
    direction = isTransferOut(focalRow) ? 'transfer' : 'out';
    root.children = await traceOutflow(ctx, focalRow.account_id, String(focalRow.id), focalAmount, 1);
  } else if (isTransferIn(focalRow)) {
    // Inflow that is a transfer-in: trace the source account.
    direction = 'transfer';
    const source = await resolveTransferSource(ctx, focalRow);
    root.children = source
      ? await traceOutflow(ctx, source.accountId, source.outLegId, focalAmount, 1)
      : [untracedNode(ctx, focalAmount, 'transfer source missing')];
  } else {
    // Terminal inflow (salary / manual income / borrow / debt / opening): this IS the origin.
    direction = 'in';
    root.is_terminal = true;
    root.origin = originForType(focalRow.type);
    root.label = `${ORIGIN_LABEL[root.origin] || 'Inflow'} · ${focalLedger.accountName}`;
  }

  return finalize(ctx, focalRow, focalLedger, root, focalAmount, direction);
}

function finalize(ctx, focalRow, focalLedger, root, focalAmount, direction) {
  const leaves = [];
  collectLeaves(root, leaves);

  const byOrigin = new Map();
  let traced = 0;
  let untraced = 0;
  for (const leaf of leaves) {
    if (leaf === root) continue;
    if (leaf.origin === 'untraced') {
      untraced += leaf.amount;
      continue;
    }
    traced += leaf.amount;
    const key = leaf.origin;
    const prev = byOrigin.get(key) || { origin: key, label: ORIGIN_LABEL[key] || 'Inflow', amount: 0 };
    prev.amount = round(prev.amount + leaf.amount);
    byOrigin.set(key, prev);
  }

  const denom = focalAmount > 0 ? focalAmount : 1;
  const originsSummary = [...byOrigin.values()]
    .map(o => ({ ...o, pct: round((o.amount / denom) * 100) }))
    .sort((a, b) => b.amount - a.amount);

  if (untraced > 0) {
    originsSummary.push({ origin: 'untraced', label: 'Untraced', amount: round(untraced), pct: round((untraced / denom) * 100) });
  }

  return {
    policy: 'fifo',
    focal: {
      id: String(focalRow.id),
      type: focalRow.type || null,
      account_id: focalRow.account_id || null,
      account_name: focalLedger.accountName,
      amount: focalAmount,
      date: focalRow.date || null,
      direction,
    },
    tree: root,
    origins_summary: originsSummary,
    total_traced: round(traced),
    untraced: round(untraced),
    truncated: ctx.truncated,
    depth_reached: ctx.depthReached,
    accounts_touched: ctx.accountsTouched.size,
  };
}

// Trace the funding of an outflow (FIFO) and return child provenance nodes.
async function traceOutflow(ctx, accountId, txnId, amountToAttribute, depth) {
  ctx.depthReached = Math.max(ctx.depthReached, depth);
  if (depth > ctx.maxDepth || ctx.nodeCount >= ctx.maxNodes) {
    ctx.truncated = true;
    return [untracedNode(ctx, amountToAttribute, 'depth/size limit reached')];
  }

  const ledger = await getLedger(ctx, accountId);
  const result = computeAllocations(ledger, txnId);
  if (!result) {
    return [untracedNode(ctx, amountToAttribute, 'funding not found')];
  }

  const { allocations, untraced } = result;
  const targetTotal = allocations.reduce((s, a) => s + a.amount, 0) + untraced;
  const scale = targetTotal > 0 ? amountToAttribute / targetTotal : 0;
  const children = [];

  for (const alloc of allocations) {
    const scaled = round(alloc.amount * scale);
    if (scaled <= 0) continue;
    const lot = alloc.lot;

    if (lot.kind === 'opening') {
      children.push(makeNode(ctx, {
        txn_id: null,
        account_id: accountId,
        account_name: ledger.accountName,
        type: 'opening',
        origin: 'opening',
        label: `Opening balance · ${ledger.accountName}`,
        date: null,
        amount: scaled,
        is_terminal: true,
      }));
      continue;
    }

    const row = lot.row;

    if (isTransferIn(row)) {
      const source = await resolveTransferSource(ctx, row);
      const node = makeNode(ctx, {
        txn_id: String(row.id),
        account_id: source ? source.accountId : accountId,
        account_name: source ? source.accountName : ledger.accountName,
        type: row.type || null,
        origin: 'transfer',
        label: source ? `Transfer in from ${source.accountName}` : 'Transfer in (source unresolved)',
        date: row.date || null,
        amount: scaled,
        is_terminal: !source,
      });
      node.children = source
        ? await traceOutflow(ctx, source.accountId, source.outLegId, scaled, depth + 1)
        : [untracedNode(ctx, scaled, 'transfer source missing')];
      children.push(node);
      continue;
    }

    // Terminal external inflow.
    const origin = originForType(row.type);
    children.push(makeNode(ctx, {
      txn_id: String(row.id),
      account_id: accountId,
      account_name: ledger.accountName,
      type: row.type || null,
      origin,
      label: `${ORIGIN_LABEL[origin] || 'Inflow'} · ${ledger.accountName}`,
      date: row.date || null,
      amount: scaled,
      is_terminal: true,
    }));
  }

  const scaledUntraced = round(untraced * scale);
  if (scaledUntraced > 0) {
    children.push(untracedNode(ctx, scaledUntraced, 'older than recorded history'));
  }

  return children;
}

// Given a transfer-IN row, resolve its source account via the linked transfer-OUT
// leg (the OUT leg's account_id is the source). Returns null if unresolvable.
async function resolveTransferSource(ctx, inRow) {
  const linkedId = inRow.linked_txn_id || extractLinkedId(inRow.notes);
  if (!linkedId) return null;
  const outLeg = await fetchTxn(ctx, linkedId);
  if (!outLeg || !outLeg.account_id) return null;
  const srcLedger = await getLedger(ctx, outLeg.account_id);
  return { accountId: outLeg.account_id, accountName: srcLedger.accountName, outLegId: String(outLeg.id) };
}

// FIFO replay of an account's ledger; returns the funding allocations for the
// target outflow row (which lots, oldest first, and how much from each).
function computeAllocations(ledger, targetTxnId) {
  const queue = [];
  if (ledger.opening > 0) {
    queue.push({ lot: { kind: 'opening' }, remaining: ledger.opening });
  }

  for (const row of ledger.rows) {
    const value = signedEffect(row.type, amt(row));
    if (value > 0) {
      queue.push({ lot: { kind: 'inflow', row }, remaining: amt(row) });
    } else if (value < 0) {
      let need = amt(row);
      const allocations = [];
      while (need > 1e-6 && queue.length) {
        const head = queue[0];
        const take = Math.min(head.remaining, need);
        if (take > 0) allocations.push({ lot: head.lot, amount: round(take) });
        head.remaining = round(head.remaining - take);
        need = round(need - take);
        if (head.remaining <= 1e-6) queue.shift();
      }
      if (String(row.id) === String(targetTxnId)) {
        return { allocations, untraced: need > 1e-6 ? round(need) : 0 };
      }
    }
  }
  return null;
}

async function getLedger(ctx, accountId) {
  const key = String(accountId || '');
  if (ctx.ledgers.has(key)) return ctx.ledgers.get(key);

  let opening = 0;
  let accountName = key || 'Unknown account';
  let accountKind = null;
  try {
    const acct = await ctx.db.prepare('SELECT * FROM accounts WHERE id = ? LIMIT 1').bind(accountId).first();
    if (acct) {
      opening = Number(acct.opening_balance || 0);
      accountName = acct.name || key;
      accountKind = acct.kind || null;
    }
  } catch { /* accounts unreadable — degrade to id */ }

  let rows = [];
  try {
    const res = await ctx.db.prepare(
      `SELECT * FROM transactions
       WHERE account_id = ?
       ORDER BY date ASC, datetime(created_at) ASC, id ASC`
    ).bind(accountId).all();
    rows = (res.results || []).filter(r => !isVoided(r));
  } catch { /* transactions unreadable */ }

  const ledger = { accountName, accountKind, opening, rows };
  ctx.ledgers.set(key, ledger);
  ctx.accountsTouched.add(key);
  return ledger;
}

async function fetchTxn(ctx, id) {
  const key = String(id || '');
  if (ctx.txnCache.has(key)) return ctx.txnCache.get(key);
  let row = null;
  try {
    row = await ctx.db.prepare('SELECT * FROM transactions WHERE id = ? LIMIT 1').bind(id).first();
  } catch { /* unreadable */ }
  ctx.txnCache.set(key, row || null);
  return row || null;
}

function makeNode(ctx, node) {
  ctx.nodeCount += 1;
  return { children: [], ...node };
}

function untracedNode(ctx, amount, reason) {
  return makeNode(ctx, {
    txn_id: null,
    account_id: null,
    account_name: null,
    type: null,
    origin: 'untraced',
    label: `Untraced — ${reason}`,
    date: null,
    amount: round(amount),
    is_terminal: true,
  });
}

function collectLeaves(node, out) {
  if (!node.children || node.children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of node.children) collectLeaves(child, out);
}

function normalizeType(type) {
  return String(type || '').trim().toLowerCase();
}

function signedEffect(type, amount) {
  const t = normalizeType(type);
  const n = Math.abs(Number(amount) || 0);
  if (IN_TYPES.has(t)) return n;
  if (OUT_TYPES.has(t)) return -n;
  return -n; // default to outflow, mirroring balances.js
}

function amt(row) {
  return round(Math.abs(Number(row.pkr_amount != null ? row.pkr_amount : (row.amount || 0))));
}

function isTransferIn(row) {
  // A transfer's IN leg is stored as type 'income' with a link back to the OUT leg.
  return normalizeType(row.type) === 'income' && !!(row.linked_txn_id || extractLinkedId(row.notes));
}

function isTransferOut(row) {
  return normalizeType(row.type) === 'transfer';
}

function originForType(type) {
  const t = normalizeType(type);
  if (t === 'salary') return 'salary';
  if (t === 'income') return 'income';
  if (t === 'borrow') return 'borrow';
  if (t === 'debt_in') return 'debt';
  if (t === 'adjustment_positive') return 'adjustment';
  if (t === 'opening') return 'opening';
  if (t === 'cc_spend') return 'card';
  return 'other';
}

function isVoided(row) {
  const notes = String(row && row.notes || '').toUpperCase();
  return !!(row.reversed_by || row.reversed_at || notes.includes('[REVERSAL OF ') || notes.includes('[REVERSED BY '));
}

function extractLinkedId(notes) {
  const match = String(notes || '').match(/\[linked:\s*([^\]]+)\]/i);
  return match ? match[1].trim() : null;
}

function focalLabel(row) {
  const t = normalizeType(row.type);
  if (t === 'expense') return 'This spend';
  if (t === 'transfer') return 'This transfer';
  return `This ${t || 'entry'}`;
}

function round(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
