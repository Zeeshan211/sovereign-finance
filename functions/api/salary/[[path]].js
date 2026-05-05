/* ─── /api/salary/[[path]] · v0.2.0 · TRACE-AUDIT FIXES ─── */
/*
 * Changes vs v0.1.0 (per TRACE audit findings 4, 8):
 *   - Audit signature fix: was {entity_type, details} → now {entity, detail} per _lib.js contract
 *   - Snapshot signature fix: was snapshot(db, {label, tables, where}) → now snapshot(env, label, createdBy)
 *   - Snap-before-mutate now actually fires (was silently failing — pure theater)
 *   - Audit detail now persists (was NULL — historical salary entries have lost detail)
 *
 * Schema (per SCHEMA.md):
 *   transactions: id, date, type, amount, account_id, transfer_to_account_id, category_id, notes, created_at
 *   No separate salary table — salary is stored as paired transactions:
 *     1 income to source account ("Meezan" by default) — full salary
 *     N transfers from source → prepaid sub-accounts (UBL Prepaid, etc) — splits
 */

import { json, audit, snapshot, uuid } from '../_lib.js';

export async function onRequestPost(context) {
  try {
    const db = context.env.DB;
    const body = await context.request.json();

    const amount = Number(body.amount);
    if (!amount || amount <= 0) {
      return json({ ok: false, error: 'Salary amount required (must be > 0)' }, 400);
    }

    const sourceAccountId = body.source_account_id || 'meezan';
    const date = body.date || new Date().toISOString().slice(0, 10);
    const splits = Array.isArray(body.splits) ? body.splits : [];
    const createdBy = body.created_by || 'web-salary';
    const month = date.slice(0, 7);

    // Validate splits sum doesn't exceed total
    const splitsTotal = splits.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    if (splitsTotal > amount) {
      return json({
        ok: false,
        error: 'Splits total (' + splitsTotal + ') exceeds salary amount (' + amount + ')'
      }, 400);
    }

    // Snapshot before batch mutation (correct signature — was silently failing in v0.1.0)
    await snapshot(context.env, 'pre-salary-' + month + '-' + Date.now(), createdBy);

    const createdTxns = [];

    // 1. Income transaction — full salary lands in source account
    const incomeTxnId = 'TXN-SAL-' + uuid();
    await db.prepare(
      "INSERT INTO transactions (id, date, type, amount, account_id, category_id, notes) VALUES (?, ?, 'income', ?, ?, 'salary', ?)"
    ).bind(
      incomeTxnId, date, amount, sourceAccountId,
      'Salary ' + month + (body.notes ? ' · ' + body.notes : '')
    ).run();
    createdTxns.push({ id: incomeTxnId, type: 'income', amount, account_id: sourceAccountId });

    // 2. Split transactions — transfer from source to each prepaid/sub-account
    for (const split of splits) {
      const splitAmount = Number(split.amount);
      if (!splitAmount || splitAmount <= 0) continue;
      if (!split.account_id) continue;

      const splitTxnId = 'TXN-SAL-SPLIT-' + uuid();
      await db.prepare(
        "INSERT INTO transactions (id, date, type, amount, account_id, transfer_to_account_id, category_id, notes) VALUES (?, ?, 'transfer', ?, ?, ?, 'transfer', ?)"
      ).bind(
        splitTxnId, date, splitAmount, sourceAccountId, split.account_id,
        'Salary split → ' + split.account_id + ' for ' + month
      ).run();
      createdTxns.push({
        id: splitTxnId,
        type: 'transfer',
        amount: splitAmount,
        from: sourceAccountId,
        to: split.account_id
      });
    }

    // Audit batch (correct signature)
    await audit(context.env, {
      action: 'SALARY_POST',
      entity: 'salary',
      entity_id: month,
      kind: 'mutation',
      detail: JSON.stringify({
        month,
        amount,
        source_account_id: sourceAccountId,
        splits_count: splits.length,
        splits_total: splitsTotal,
        retained_in_source: amount - splitsTotal,
        created_txns: createdTxns,
        date
      }),
      created_by: createdBy
    });

    return json({
      ok: true,
      month,
      income_txn_id: incomeTxnId,
      splits_created: createdTxns.length - 1,
      total_amount: amount,
      splits_total: splitsTotal,
      retained: amount - splitsTotal
    });

  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function onRequestGet(context) {
  try {
    const db = context.env.DB;
    const url = new URL(context.request.url);
    const month = url.searchParams.get('month');

    let query = "SELECT * FROM transactions WHERE category_id = 'salary' AND type = 'income' AND (reversed_at IS NULL OR reversed_at = '') ORDER BY date DESC LIMIT 50";
    const result = await db.prepare(query).all();
    let salaries = result.results || [];

    if (month) {
      salaries = salaries.filter(s => s.date && s.date.startsWith(month));
    }

    return json({ ok: true, salaries, count: salaries.length });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}
