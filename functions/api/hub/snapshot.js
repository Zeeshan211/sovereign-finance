/* Sovereign Finance Hub Snapshot API
 * GET /api/hub/snapshot
 * v1.0.0-hub-snapshot
 *
 * Single aggregation endpoint for HubPage.
 * Cached 30s per user in D1.
 */

const VERSION = 'v1.0.0-hub-snapshot';
const CONTRACT_VERSION = 'hub-v1';

const POSITIVE_TYPES = new Set([
  'income', 'salary', 'opening', 'borrow', 'debt_in', 'adjustment_positive'
]);

const LIQUID_ACCOUNT_TYPES = new Set([
  'checking', 'savings', 'cash', 'wallet', 'current'
]);

export async function onRequestGet(context) {
  const db = context.env.DB;
  const userId = context.data.user_id;
  if (!userId) return jsonErr('Unauthorized', 401);

  const now = new Date();
  const generatedAt = now.toISOString();

  try {
    // Check cache
    const cached = await db.prepare(
      `SELECT snapshot_json, generated_at FROM hub_snapshot_cache WHERE user_id = ? ORDER BY generated_at DESC LIMIT 1`
    ).bind(userId).first().catch(() => null);

    if (cached && cached.snapshot_json) {
      const cacheAge = Date.now() - new Date(cached.generated_at).getTime();
      if (cacheAge < 30_000) {
        return json(JSON.parse(cached.snapshot_json));
      }
    }

    // Fetch all data in parallel
    const [
      accountRows,
      txRows30d,
      txRows7d,
      billRows,
      salaryRows,
      dismissalRows,
      insightDismissalRows,
    ] = await Promise.all([
      db.prepare(`SELECT id, name, type, kind, currency, status, archived_at, deleted_at FROM accounts WHERE user_id = ? AND deleted_at IS NULL`).bind(userId).all(),
      db.prepare(`SELECT t.id, t.account_id, t.amount, t.type, t.category_id, t.description, t.merchant, t.transacted_at, t.created_at FROM transactions t WHERE t.user_id = ? AND t.reversed_at IS NULL AND t.is_reversal = 0 AND t.transacted_at >= date('now', '-30 days') ORDER BY t.transacted_at DESC`).bind(userId).all(),
      db.prepare(`SELECT t.id, t.account_id, t.amount, t.type, t.category_id, t.description, t.merchant, t.transacted_at FROM transactions t WHERE t.user_id = ? AND t.reversed_at IS NULL AND t.is_reversal = 0 AND t.transacted_at >= date('now', '-7 days') ORDER BY t.transacted_at DESC`).bind(userId).all(),
      db.prepare(`SELECT id, name, amount, due_day, due_date, status, account_id, category_id, next_due_date FROM bills WHERE user_id = ? AND status = 'active' ORDER BY due_date ASC`).bind(userId).all(),
      db.prepare(`SELECT id, payday_day, monthly_salary_net, payout_account_id, enabled FROM salary_contracts WHERE user_id = ? AND enabled = 1 LIMIT 1`).bind(userId).first().catch(() => null),
      db.prepare(`SELECT item_signature FROM hub_dismissals WHERE user_id = ? AND dismissed_at >= datetime('now', '-7 days')`).bind(userId).all().catch(() => ({ results: [] })),
      db.prepare(`SELECT insight_signature FROM hub_insight_dismissals WHERE user_id = ? AND dismissed_at >= datetime('now', '-7 days')`).bind(userId).all().catch(() => ({ results: [] })),
    ]);

    const accounts = accountRows?.results ?? [];
    const txs30d = txRows30d?.results ?? [];
    const txs7d = txRows7d?.results ?? [];
    const bills = billRows?.results ?? [];
    const salary = salaryRows ?? null;
    const dismissedSigs = new Set((dismissalRows?.results ?? []).map(r => r.item_signature));
    const dismissedInsightSigs = new Set((insightDismissalRows?.results ?? []).map(r => r.insight_signature));

    // Compute balances from transactions
    const balanceMap = await computeBalances(db, userId);

    // Build pulse
    const pulse = buildPulse(accounts, balanceMap, txs30d, now);

    // Build priority inbox
    const priorityInbox = buildPriorityInbox(accounts, balanceMap, bills, txs30d, txs7d, salary, dismissedSigs, now);

    // Build next 7 days
    const next7Days = buildNext7Days(accounts, balanceMap, bills, txs30d, salary, now);

    // Build insights
    const insights = buildInsights(txs30d, accounts, dismissedInsightSigs, now);

    // Build quick actions
    const quickActions = [
      { id: 'add_transaction', label: 'Add Transaction', icon: 'Plus', action: '/add', shortcut: 'A', primary: true },
      { id: 'snap_receipt', label: 'Snap Receipt', icon: 'Camera', action: '/receipts', shortcut: 'R', primary: false },
      { id: 'upload_statement', label: 'Upload Statement', icon: 'Upload', action: '/reconciliation', shortcut: 'U', primary: false },
      { id: 'view_accounts', label: 'View Accounts', icon: 'Layers', action: '/accounts', shortcut: 'V', primary: false },
    ];

    // Build accounts health
    const accountsHealth = buildAccountsHealth(accounts, balanceMap, txs30d);

    const snapshot = {
      ok: true,
      version: VERSION,
      contract_version: CONTRACT_VERSION,
      action: 'snapshot',
      committed: false,
      writes_performed: false,
      data: {
        generated_at: generatedAt,
        user_id: userId,
        pulse,
        priority_inbox: priorityInbox,
        next_7_days: next7Days,
        insights,
        quick_actions: quickActions,
        accounts_health: accountsHealth,
      },
    };

    // Cache snapshot
    await db.prepare(
      `INSERT OR REPLACE INTO hub_snapshot_cache (user_id, snapshot_json, generated_at) VALUES (?, ?, ?)`
    ).bind(userId, JSON.stringify(snapshot), generatedAt).run().catch(() => null);

    return json(snapshot);

  } catch (err) {
    return jsonErr(`Snapshot failed: ${err.message || String(err)}`, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Cookie',
    },
  });
}

// ─── Balance computation ──────────────────────────────────────────

async function computeBalances(db, userId) {
  const rows = await db.prepare(
    `SELECT t.account_id, t.type, SUM(t.amount) as total
     FROM transactions t
     WHERE t.user_id = ?
       AND t.reversed_at IS NULL
       AND t.is_reversal = 0
     GROUP BY t.account_id, t.type`
  ).bind(userId).all();

  const balanceMap = {};
  for (const row of rows?.results ?? []) {
    if (!balanceMap[row.account_id]) balanceMap[row.account_id] = 0;
    const amount = Number(row.total) || 0;
    if (POSITIVE_TYPES.has(row.type)) {
      balanceMap[row.account_id] += amount;
    } else {
      balanceMap[row.account_id] -= amount;
    }
  }
  return balanceMap;
}

// ─── Pulse ────────────────────────────────────────────────────────

function buildPulse(accounts, balanceMap, txs30d, now) {
  const activeAccounts = accounts.filter(a => !a.archived_at && !a.deleted_at);

  // Net worth
  let assets = 0;
  let liabilities = 0;
  for (const acc of activeAccounts) {
    const bal = balanceMap[acc.id] ?? 0;
    const isLiability = acc.kind === 'cc' || acc.kind === 'credit_card' || acc.kind === 'loan' || acc.type === 'liability';
    if (isLiability) {
      liabilities += Math.abs(bal);
    } else {
      assets += bal;
    }
  }
  const netWorth = assets - liabilities;

  // Simple sparkline from 30d transactions (8 daily buckets)
  const sparkline = buildSparkline(txs30d, now, 8);

  // Determine direction
  const lastVal = sparkline[sparkline.length - 2] ?? netWorth;
  const currVal = sparkline[sparkline.length - 1] ?? netWorth;
  const direction = currVal > lastVal + 100 ? 'up' : currVal < lastVal - 100 ? 'down' : 'flat';

  // Delta approximations from transaction activity
  const delta24h = computeDelta(txs30d, now, 1);
  const delta7d = computeDelta(txs30d, now, 7);
  const delta30d = computeDelta(txs30d, now, 30);

  // Runway
  const liquidBalance = activeAccounts
    .filter(a => {
      const k = (a.kind || '').toLowerCase();
      const t = (a.type || '').toLowerCase();
      return k !== 'cc' && k !== 'credit_card' && k !== 'loan' && t !== 'liability' && a.status !== 'frozen';
    })
    .reduce((sum, a) => sum + (balanceMap[a.id] ?? 0), 0);

  const expenseTxs = txs30d.filter(t => !POSITIVE_TYPES.has(t.type));
  const dailyBurnRate = expenseTxs.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0) / 30;
  const daysRemaining = dailyBurnRate > 0 ? Math.floor(liquidBalance / dailyBurnRate) : 999;

  const txDaysCount = new Set(txs30d.map(t => t.transacted_at?.slice(0, 10))).size;
  const runwayConfidence = txDaysCount >= 30 ? 'high' : txDaysCount >= 14 ? 'medium' : 'low';

  const excludedAccounts = activeAccounts
    .filter(a => a.status === 'frozen' || a.kind === 'cc' || a.kind === 'credit_card')
    .map(a => a.name);

  // Month story
  const monthStory = buildMonthStory(txs30d, now);

  return {
    net_worth: {
      current: Math.round(netWorth),
      currency: 'PKR',
      delta_24h: Math.round(delta24h),
      delta_7d: Math.round(delta7d),
      delta_30d: Math.round(delta30d),
      trend_7d_sparkline: sparkline,
      direction,
    },
    cash_runway: {
      days_remaining: daysRemaining,
      confidence: runwayConfidence,
      calculation_method: '30d_avg_burn',
      daily_burn_rate: Math.round(dailyBurnRate),
      liquid_balance: Math.round(liquidBalance),
      excluded_accounts: excludedAccounts,
    },
    month_story: monthStory,
  };
}

function buildSparkline(txs30d, now, buckets) {
  const bucketTotals = Array(buckets).fill(0);
  const msPerBucket = (7 * 24 * 60 * 60 * 1000) / buckets;
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  for (const tx of txs30d) {
    const txTime = new Date(tx.transacted_at).getTime();
    if (txTime < cutoff) continue;
    const bucketIdx = Math.min(Math.floor((txTime - cutoff) / msPerBucket), buckets - 1);
    const amount = Number(tx.amount) || 0;
    bucketTotals[bucketIdx] += POSITIVE_TYPES.has(tx.type) ? amount : -amount;
  }

  // Running cumulative
  let running = 0;
  return bucketTotals.map(v => { running += v; return Math.round(running); });
}

function computeDelta(txs30d, now, days) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let delta = 0;
  for (const tx of txs30d) {
    if ((tx.transacted_at || '').slice(0, 10) >= cutoff) {
      const amount = Number(tx.amount) || 0;
      delta += POSITIVE_TYPES.has(tx.type) ? amount : -amount;
    }
  }
  return delta;
}

function buildMonthStory(txs30d, now) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthTxs = txs30d.filter(t => (t.transacted_at || '').slice(0, 10) >= monthStart);

  let income = 0;
  let expenses = 0;
  for (const tx of monthTxs) {
    const amount = Number(tx.amount) || 0;
    if (POSITIVE_TYPES.has(tx.type)) income += amount;
    else expenses += amount;
  }

  const netChange = income - expenses;
  const periodLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Compare against rough 6-month average (using 30d data as proxy for now)
  const dailyNetAvg = netChange / now.getDate();
  const projectedMonthly = dailyNetAvg * 30;
  const vsAveragePct = projectedMonthly !== 0 ? ((netChange - projectedMonthly * 0.9) / Math.abs(projectedMonthly * 0.9)) * 100 : 0;

  let tightest;
  let narrative;
  const savingsShortfall = Math.abs(Math.min(0, netChange));

  if (netChange < 0 && Math.abs(netChange) > 10000) {
    tightest = 'tightest';
    narrative = `${periodLabel.split(' ')[0]} was your tightest month — Rs ${formatAmount(savingsShortfall)} net outflow.`;
  } else if (netChange > 20000) {
    tightest = 'loosest';
    narrative = `${periodLabel.split(' ')[0]} was a strong month — Rs ${formatAmount(netChange)} net positive.`;
  } else if (netChange >= 0) {
    tightest = 'above_average';
    narrative = `${periodLabel.split(' ')[0]} is on track — Rs ${formatAmount(netChange)} net positive so far.`;
  } else {
    tightest = 'below_average';
    narrative = `${periodLabel.split(' ')[0]} is slightly negative — Rs ${formatAmount(Math.abs(netChange))} outflow.`;
  }

  return {
    period: periodLabel,
    net_change: Math.round(netChange),
    vs_average_pct: Math.round(vsAveragePct),
    tightest_or_loosest: tightest,
    narrative,
    income_total: Math.round(income),
    expense_total: Math.round(expenses),
    transaction_count: monthTxs.length,
  };
}

// ─── Priority Inbox ───────────────────────────────────────────────

function buildPriorityInbox(accounts, balanceMap, bills, txs30d, txs7d, salary, dismissedSigs, now) {
  const items = [];
  const today = now.toISOString().slice(0, 10);
  const in3days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Bill due within 3 days
  for (const bill of bills) {
    const dueDate = bill.next_due_date || bill.due_date;
    if (dueDate && dueDate >= today && dueDate <= in3days) {
      const sig = `bill_due:${bill.id}:${dueDate}`;
      if (!dismissedSigs.has(sig)) {
        items.push({
          id: `bill_${bill.id}`,
          type: 'bill_due',
          severity: dueDate === today ? 'critical' : 'warning',
          title: `${bill.name} due ${dueDate === today ? 'today' : 'in ' + daysDiff(today, dueDate) + ' days'}`,
          body: `Rs ${formatAmount(bill.amount)} due on ${formatDate(dueDate)}`,
          action_label: 'Pay now',
          action_url: `/bills/${bill.id}`,
          dismissible: true,
          entity_ref: { type: 'bill', id: bill.id },
          created_at: now.toISOString(),
          _sig: sig,
        });
      }
    }
  }

  // Low balance warnings
  const activeAccounts = accounts.filter(a => !a.archived_at && !a.deleted_at);
  for (const acc of activeAccounts) {
    const bal = balanceMap[acc.id] ?? 0;
    if (bal < 5000 && bal >= 0 && acc.kind !== 'cc' && acc.kind !== 'credit_card') {
      const sig = `low_balance:${acc.id}:${today}`;
      if (!dismissedSigs.has(sig)) {
        items.push({
          id: `low_bal_${acc.id}`,
          type: 'low_balance',
          severity: bal < 1000 ? 'critical' : 'warning',
          title: `${acc.name} balance low`,
          body: `Rs ${formatAmount(bal)} remaining — consider topping up.`,
          action_label: 'View account',
          action_url: `/accounts`,
          dismissible: true,
          entity_ref: { type: 'account', id: acc.id },
          created_at: now.toISOString(),
          _sig: sig,
        });
      }
    }
  }

  // Unusual activity: transaction in last 24h > 2x avg
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const recentBigTxs = txs7d.filter(t => {
    if (t.transacted_at < last24h) return false;
    if (POSITIVE_TYPES.has(t.type)) return false;
    const amount = Math.abs(Number(t.amount) || 0);
    const avgTx = txs30d.filter(tx => !POSITIVE_TYPES.has(tx.type)).reduce((s, tx) => s + Math.abs(Number(tx.amount) || 0), 0) / Math.max(txs30d.length, 1);
    return amount > avgTx * 3 && amount > 10000;
  });

  for (const tx of recentBigTxs.slice(0, 1)) {
    const sig = `unusual:${tx.id}`;
    if (!dismissedSigs.has(sig)) {
      items.push({
        id: `unusual_${tx.id}`,
        type: 'unusual_activity',
        severity: 'info',
        title: 'Unusual large transaction',
        body: `Rs ${formatAmount(Math.abs(Number(tx.amount)))} at ${tx.merchant || tx.description || 'unknown'} — larger than usual.`,
        action_label: 'View transaction',
        action_url: `/transactions`,
        dismissible: true,
        entity_ref: { type: 'transaction', id: tx.id },
        created_at: now.toISOString(),
        _sig: sig,
      });
    }
  }

  // Sort: critical > warning > info, then by created_at DESC
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

  // Strip internal _sig field and cap at 5
  return items.slice(0, 5).map(({ _sig, ...item }) => item);
}

// ─── Next 7 Days ──────────────────────────────────────────────────

function buildNext7Days(accounts, balanceMap, bills, txs30d, salary, now) {
  const events = [];
  const redZoneDates = [];

  // Add bill events for next 7 days
  for (let d = 0; d < 7; d++) {
    const date = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().slice(0, 10);

    for (const bill of bills) {
      const dueDate = bill.next_due_date || bill.due_date;
      if (dueDate === dateStr) {
        events.push({
          id: `bill_${bill.id}_${dateStr}`,
          date: dateStr,
          type: 'bill',
          amount: -Math.abs(Number(bill.amount) || 0),
          account_id: bill.account_id || null,
          account_name: accounts.find(a => a.id === bill.account_id)?.name || null,
          label: bill.name,
          confidence: 'confirmed',
          can_defer: true,
        });
      }
    }

    // Salary expected
    if (salary?.payday_day) {
      const payday = Number(salary.payday_day);
      if (date.getDate() === payday) {
        events.push({
          id: `salary_${dateStr}`,
          date: dateStr,
          type: 'salary',
          amount: Number(salary.monthly_salary_net) || 0,
          account_id: salary.payout_account_id || null,
          account_name: accounts.find(a => a.id === salary.payout_account_id)?.name || null,
          label: 'Salary deposit',
          confidence: 'projected',
          can_defer: false,
        });
      }
    }
  }

  // Sort events by date
  events.sort((a, b) => a.date.localeCompare(b.date));

  // Compute projected balances per account to find red zones
  const projectedBalances = {};
  for (const acc of accounts.filter(a => !a.archived_at && !a.deleted_at)) {
    projectedBalances[acc.id] = balanceMap[acc.id] ?? 0;
  }

  for (const event of events) {
    if (event.account_id) {
      projectedBalances[event.account_id] = (projectedBalances[event.account_id] ?? 0) + event.amount;
      if ((projectedBalances[event.account_id] ?? 0) < 0) {
        const acc = accounts.find(a => a.id === event.account_id);
        redZoneDates.push({
          date: event.date,
          projected_balance: Math.round(projectedBalances[event.account_id]),
          account_id: event.account_id,
          account_name: acc?.name || 'Unknown account',
          cause: `${event.label} payment`,
        });
      }
    }
  }

  const netProjected = events.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

  return {
    events,
    red_zone_dates: redZoneDates,
    net_projected: Math.round(netProjected),
  };
}

// ─── Insights ─────────────────────────────────────────────────────

function buildInsights(txs30d, accounts, dismissedInsightSigs, now) {
  const insights = [];

  // Category spending anomaly: look for top categories
  const catTotals = {};
  const expenseTxs = txs30d.filter(t => !POSITIVE_TYPES.has(t.type));
  for (const tx of expenseTxs) {
    const cat = tx.category_id || 'uncategorized';
    catTotals[cat] = (catTotals[cat] ?? 0) + Math.abs(Number(tx.amount) || 0);
  }

  const totalExpense = Object.values(catTotals).reduce((s, v) => s + v, 0);
  const entries = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  for (const [catId, amount] of entries.slice(0, 3)) {
    const pct = totalExpense > 0 ? (amount / totalExpense) * 100 : 0;
    if (pct > 35) {
      const sig = `spending_anomaly:${catId}`;
      if (!dismissedInsightSigs.has(sig)) {
        insights.push({
          id: `insight_cat_${catId}`,
          type: 'spending_anomaly',
          strength: Math.min(Math.round(pct * 1.5), 95),
          title: `${formatCategoryName(catId)} is your biggest expense`,
          body: `Rs ${formatAmount(amount)} (${Math.round(pct)}% of spending) went to ${formatCategoryName(catId)} this month.`,
          data_link: { type: 'category', id: catId, view: '/transactions' },
          dismissible: true,
          generated_at: now.toISOString(),
          _sig: sig,
        });
        break;
      }
    }
  }

  // Cash sitting idle opportunity
  const liquidAccounts = accounts.filter(a => {
    const k = (a.kind || '').toLowerCase();
    return !a.archived_at && k !== 'cc' && k !== 'credit_card' && k !== 'loan';
  });
  // (strength check is approximate for now)

  // Sort by strength, filter > 60, cap at 3
  const filtered = insights
    .filter(i => i.strength > 60)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3)
    .map(({ _sig, ...i }) => i);

  return filtered;
}

// ─── Accounts Health ──────────────────────────────────────────────

function buildAccountsHealth(accounts, balanceMap, txs30d) {
  const active = accounts.filter(a => !a.archived_at && !a.deleted_at);

  // "Fresh" = has a transaction in last 14 days
  const recentAccountIds = new Set(
    txs30d
      .filter(t => {
        const d = new Date(t.transacted_at);
        return Date.now() - d.getTime() < 14 * 24 * 60 * 60 * 1000;
      })
      .map(t => t.account_id)
  );

  const freshAccounts = active.filter(a => recentAccountIds.has(a.id));
  const staleAccounts = active.filter(a => !recentAccountIds.has(a.id));

  // Drift: accounts with no recent activity might have drift; use balance as proxy
  let driftTotal = 0;
  let worstDrift = null;
  let worstDriftAmount = 0;

  for (const acc of staleAccounts) {
    const bal = Math.abs(balanceMap[acc.id] ?? 0);
    driftTotal += bal;
    if (bal > worstDriftAmount) {
      worstDriftAmount = bal;
      worstDrift = acc;
    }
  }

  return {
    total_count: active.length,
    fresh_count: freshAccounts.length,
    stale_count: staleAccounts.length,
    drift_total: Math.round(driftTotal),
    worst_drift_account: worstDrift ? {
      id: worstDrift.id,
      name: worstDrift.name,
      drift_amount: Math.round(worstDriftAmount),
    } : null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function formatAmount(n) {
  const num = Math.abs(Math.round(Number(n) || 0));
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)}k`;
  return String(num);
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function daysDiff(from, to) {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000));
}

function formatCategoryName(catId) {
  return (catId || 'uncategorized')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function jsonErr(message, status = 500) {
  return json({ ok: false, version: VERSION, error: message }, status);
}
