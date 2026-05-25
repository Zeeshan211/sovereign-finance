/*  Sovereign Finance  /api/reconciliation/cleanup-scan  v1.0.0  */
/*
 * POST /api/reconciliation/cleanup-scan
 * Returns phantom_candidates: transactions whose notes match recovery/phantom/bandaid patterns
 * Safe: read-only scan, no mutations
 */

import { json } from '../_lib.js';

const VERSION = 'v1.0.0';

const PHANTOM_PATTERNS = [
  'RECOVERY-',
  'phantom',
  'bandaid',
  'BANDAID',
  'PHANTOM',
  'recovery-'
];

export async function onRequestPost(context) {
  try {
    // Build LIKE conditions for each pattern
    const conditions = PHANTOM_PATTERNS.map(() => `notes LIKE ?`).join(' OR ');
    const bindings = PHANTOM_PATTERNS.map(p => `%${p}%`);

    const result = await context.env.DB.prepare(
      `SELECT
         t.id,
         t.amount,
         t.notes,
         t.date,
         t.category,
         t.account_id,
         a.name AS account_name
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE (${conditions})
         AND t.reversed_by IS NULL
       ORDER BY t.date DESC, t.id DESC
       LIMIT 200`
    ).bind(...bindings).all();

    const candidates = (result.results || []).map(row => ({
      id: row.id,
      amount: row.amount,
      notes: row.notes,
      date: row.date,
      category: row.category,
      account_id: row.account_id,
      account_name: row.account_name,
      pattern: PHANTOM_PATTERNS.find(p =>
        String(row.notes || '').toLowerCase().includes(p.toLowerCase())
      ) || 'unknown'
    }));

    return json({
      ok: true,
      version: VERSION,
      count: candidates.length,
      phantom_candidates: candidates
    });
  } catch (e) {
    return json({ ok: false, version: VERSION, error: e.message || String(e) }, 500);
  }
}
