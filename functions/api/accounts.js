/* ─── /api/accounts — reads all accounts from D1 ─── */
/* Cloudflare Pages Function v0.0.7 */

export async function onRequest(context) {
  try {
    const stmt = context.env.DB.prepare(
      'SELECT id, name, icon, type, kind, opening_balance, currency, display_order FROM accounts ORDER BY display_order'
    );
    const result = await stmt.all();

    return new Response(JSON.stringify({
      ok: true,
      count: result.results.length,
      accounts: result.results
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
