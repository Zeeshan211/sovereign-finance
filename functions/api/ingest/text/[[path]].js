/* /api/ingest/text/[[path]] v0.1.2 - forced fresh deploy */
/* Same router order as v0.1.1 (UBL + Mashreq before Easypaisa) but version bump */
/* forces Cloudflare to invalidate any cached worker bundle from v0.1.0/v0.1.1 */

import { json, audit } from '../../_lib.js';

async function sha256Hex(s) {
  var enc = new TextEncoder();
  var data = enc.encode(s);
  var buf = await crypto.subtle.digest('SHA-256', data);
  var bytes = new Uint8Array(buf);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var h = bytes[i].toString(16);
    if (h.length < 2) h = '0' + h;
    hex += h;
  }
  return hex;
}

function genId(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateString(s) {
  if (!s) return todayISO();
  var m;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m) {
    var months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    var mo = months[m[2].toLowerCase()];
    if (mo) return m[3] + '-' + mo + '-' + (m[1].length < 2 ? '0' + m[1] : m[1]);
  }
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    var year = m[3].length === 2 ? '20' + m[3] : m[3];
    var d = m[1].length < 2 ? '0' + m[1] : m[1];
    var mo2 = m[2].length < 2 ? '0' + m[2] : m[2];
    return year + '-' + mo2 + '-' + d;
  }
  return todayISO();
}

function parseAmount(s) {
  if (!s) return null;
  var clean = String(s).replace(/[,\s]/g, '').replace(/Rs\.?|PKR/gi, '');
  var n = parseFloat(clean);
  if (isNaN(n) || n <= 0) return null;
  return n;
}

function isPromotional(text) {
  if (/loan hasil karein/i.test(text)) return true;
  if (/deeplink/i.test(text)) return true;
  if (/jazzcash\.com\.pk/i.test(text) && /loan|aasani|hasil/i.test(text)) return true;
  return false;
}

function isOTP(text) {
  if (/\bOTP\b.*valid for|is your One-Time-Password|is your OTP/i.test(text)) return true;
  if (/^\d{6}\s+is your/i.test(text)) return true;
  return false;
}

function isServiceRequest(text) {
  if (/Service Request/i.test(text)) return true;
  if (/reference no\./i.test(text) && /resolved|reviewing/i.test(text)) return true;
  return false;
}

function isBalanceInquiry(text) {
  if (/^BAL/i.test(text)) return true;
  if (/Avl Limit:/i.test(text) && !/used for PKR/i.test(text)) return true;
  return false;
}

function shouldIgnore(text) {
  if (isPromotional(text)) return { ignore: true, reason: 'promotional' };
  if (isOTP(text)) return { ignore: true, reason: 'otp' };
  if (isServiceRequest(text)) return { ignore: true, reason: 'service_request' };
  if (isBalanceInquiry(text)) return { ignore: true, reason: 'balance_inquiry' };
  return { ignore: false };
}

function parseEasypaisa(text) {
  var m = text.match(/You have Received Rs\.?([\d,]+(?:\.\d+)?)\s+from\s+(.+?)\s+in your Easypaisa Account No\.?\s*(\d+)\.?\s*Trx ID\s*(\d+)/i);
  if (m) {
    return {
      amount: parseAmount(m[1]),
      account_id: 'easypaisa',
      type: 'income',
      ref: 'EP-' + m[4],
      notes: 'Received from ' + m[2].trim() + ' (Easypaisa)',
      bank: 'easypaisa'
    };
  }
  m = text.match(/You sent Rs\.?([\d,]+(?:\.\d+)?)\s+to\s+(.+?)(?:\s+at|\s+from)/i);
  if (m && /Easypaisa/i.test(text)) {
    return {
      amount: parseAmount(m[1]),
      account_id: 'easypaisa',
      type: 'expense',
      ref: null,
      notes: 'Sent to ' + m[2].trim() + ' (Easypaisa)',
      bank: 'easypaisa'
    };
  }
  return null;
}

function parseUBL(text) {
  var m = text.match(/PKR\s*([\d,]+(?:\.\d+)?)\s+sent to\s+(.+?)\s+from\s+(?:your\s+)?A\/?C[#\s]*(?:xxx)?(\d+).*?on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})(?:.*?TID:?\s*(\d+))?/i);
  if (m) {
    var acct = m[3];
    var account_id = (acct === '7136' || acct === 'xxx7136') ? 'ubl' :
                     (acct === '4113' || acct === 'xxx4113') ? 'ubl_prepaid' : null;
    if (!account_id) return null;
    return {
      amount: parseAmount(m[1]),
      account_id: account_id,
      type: 'expense',
      date: parseDateString(m[4]),
      ref: m[5] ? 'UBL-' + m[5] : null,
      notes: 'Sent to ' + m[2].trim() + ' (UBL)',
      bank: 'ubl'
    };
  }
  m = text.match(/PKR\s*([\d,]+(?:\.\d+)?)\s+received from\s+(.+?)\s+to your A\/?C[#\s]*(?:xxx)?(\d+).*?on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
  if (m) {
    var acct2 = m[3];
    var account_id2 = (acct2 === '7136' || acct2 === 'xxx7136') ? 'ubl' :
                      (acct2 === '4113' || acct2 === 'xxx4113') ? 'ubl_prepaid' : null;
    if (!account_id2) return null;
    return {
      amount: parseAmount(m[1]),
      account_id: account_id2,
      type: 'income',
      date: parseDateString(m[4]),
      ref: null,
      notes: 'Received from ' + m[2].trim() + ' (UBL)',
      bank: 'ubl'
    };
  }
  return null;
}

function parseMashreq(text) {
  var m = text.match(/Islamic PayPak.*?ending with\s+(\d+)\s+was used for(?:\s+a)?\s+cash withdrawal of PKR\s*([\d,]+(?:\.\d+)?)\s+at\s+(.+?),?\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
  if (m) {
    return {
      amount: parseAmount(m[2]),
      account_id: 'mashreq',
      type: 'atm',
      date: parseDateString(m[4]),
      ref: null,
      notes: 'Cash withdrawal at ' + m[3].trim() + ' (Mashreq Debit ' + m[1] + ')',
      bank: 'mashreq'
    };
  }
  m = text.match(/PKR\s*([\d,]+(?:\.\d+)?)\s+was received in\s+\*+(\d+)\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4}).*?Trx Ref\s+(\S+)/i);
  if (m && m[2] === '2796') {
    return {
      amount: parseAmount(m[1]),
      account_id: 'mashreq',
      type: 'income',
      date: parseDateString(m[3]),
      ref: 'MSQ-' + m[4],
      notes: 'Received in Mashreq ****' + m[2],
      bank: 'mashreq'
    };
  }
  m = text.match(/PKR\s*([\d,]+(?:\.\d+)?)\s+with PKR\s*([\d,]+(?:\.\d+)?)\s+fee sent from\s+\*+(\d+)\s+to\s+(.+?)\s+via.*?on\s+([\d/]+).*?Trx Ref\s+(\S+)/i);
  if (m && m[3] === '2796') {
    return {
      amount: parseAmount(m[1]),
      account_id: 'mashreq',
      type: 'expense',
      date: parseDateString(m[5]),
      ref: 'MSQ-' + m[6],
      notes: 'Sent to ' + m[4].trim() + ' (Mashreq, fee Rs ' + m[2] + ')',
      bank: 'mashreq'
    };
  }
  m = text.match(/POS transaction of PKR\s*([\d,]+(?:\.\d+)?)\s+was reversed on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
  if (m && /credited to your account/i.test(text)) {
    return {
      amount: parseAmount(m[1]),
      account_id: 'mashreq',
      type: 'income',
      date: parseDateString(m[2]),
      ref: null,
      notes: 'POS reversal credit (Mashreq)',
      bank: 'mashreq'
    };
  }
  return null;
}

function parseAlfalahCC(text) {
  var m = text.match(/Bank Alfalah card\s*\((\d+)\)\s+used for PKR\s*([\d,]+(?:\.\d+)?)\s+on\s+([\d/]+)\s+at\s+[\d:]+\s+at\s+(.+?)(?:\.|$)/i);
  if (m && m[1] === '91349') {
    return {
      amount: parseAmount(m[2]),
      account_id: 'cc',
      type: 'cc_spend',
      date: parseDateString(m[3]),
      ref: null,
      notes: 'CC charge at ' + m[4].trim() + ' (Alfalah ' + m[1] + ')',
      bank: 'alfalah_cc'
    };
  }
  m = text.match(/Bank Alfalah Credit Card payment for the amount\s*([\d,]+(?:\.\d+)?)\s+has been received on\s+([\d/]+)/i);
  if (m) {
    return {
      amount: parseAmount(m[1]),
      account_id: 'cc',
      type: 'cc_payment',
      date: parseDateString(m[2]),
      ref: null,
      notes: 'CC payment received (Alfalah)',
      bank: 'alfalah_cc'
    };
  }
  return null;
}

function parseJSBank(text) {
  if (/JS Bank Credit Card payment/i.test(text)) {
    return { skip: true, skipReason: 'js_bank_cc_closed' };
  }
  return null;
}

function detectBankAndParse(text) {
  if (/JS Bank|JSBL|JS bank card/i.test(text)) {
    var js = parseJSBank(text);
    if (js && js.skip) return { skip: true, skipReason: js.skipReason, bank: 'js_bank' };
    if (js) return js;
  }

  if (/Bank Alfalah|Alfalah card|Alfalah Credit Card/i.test(text)) {
    return parseAlfalahCC(text);
  }

  if (/PKR.*A\/?C.*xxx?(7136|4113)|UBL/i.test(text)) {
    return parseUBL(text);
  }

  if (/Islamic PayPak|Mashreq|\*+2796|ending with 8946/i.test(text)) {
    return parseMashreq(text);
  }

  if (/Easypaisa/i.test(text)) {
    return parseEasypaisa(text);
  }

  return null;
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var params = context.params;
  var path = params.path;
  var segments;
  if (!path) {
    segments = [];
  } else if (Array.isArray(path)) {
    segments = path;
  } else {
    segments = [path];
  }
  var method = request.method;
  var db = env.DB;

  try {
    if (segments.length === 0 && method === 'POST') {
      return await handleIngest(env, request);
    }
    if (segments.length === 0 && method === 'GET') {
      return await handleList(db, request);
    }
    return json({ ok: false, error: 'Method not allowed. Use POST to ingest, GET to list.' }, 405);
  } catch (e) {
    console.error('[ingest/text]', e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
}

async function handleList(db, request) {
  var url = new URL(request.url);
  var status = url.searchParams.get('status') || null;
  var limit = parseInt(url.searchParams.get('limit') || '50', 10);
  if (limit > 200) limit = 200;

  var query, params;
  if (status) {
    query = "SELECT * FROM txn_ingest_log WHERE parsed_status = ? ORDER BY received_at DESC LIMIT ?";
    params = [status, limit];
  } else {
    query = "SELECT * FROM txn_ingest_log ORDER BY received_at DESC LIMIT ?";
    params = [limit];
  }
  var stmt = db.prepare(query);
  var rs = await stmt.bind.apply(stmt, params).all();
  return json({ ok: true, log: rs.results || [], count: (rs.results || []).length, version: 'v0.1.2' });
}

async function handleIngest(env, request) {
  var db = env.DB;
  var body;
  try { body = await request.json(); } catch (_) { body = {}; }

  var text = body.text ? String(body.text).trim() : '';
  var sender = body.sender ? String(body.sender).trim() : null;
  var receivedAt = body.received_at || new Date().toISOString();
  var source = body.source || 'sms';
  var sourceApp = body.source_app || null;

  if (!text) return json({ ok: false, error: 'text is required' }, 400);
  if (text.length > 5000) return json({ ok: false, error: 'text too long (max 5000)' }, 400);

  var rawHash = await sha256Hex(text + '|' + (sender || '') + '|' + receivedAt);
  var logId = genId('ING');

  var existing = await db.prepare("SELECT id, parsed_status, created_txn_id FROM txn_ingest_log WHERE raw_hash = ?").bind(rawHash).first();
  if (existing) {
    return json({
      ok: true,
      duplicate: true,
      log_id: existing.id,
      parsed_status: existing.parsed_status,
      created_txn_id: existing.created_txn_id
    });
  }

  var ignoreCheck = shouldIgnore(text);
  if (ignoreCheck.ignore) {
    await db.prepare(
      "INSERT INTO txn_ingest_log (id, raw_text, raw_hash, source, source_app, sender, parsed_status, error_reason, received_at, parsed_at) VALUES (?, ?, ?, ?, ?, ?, 'ignored', ?, ?, datetime('now'))"
    ).bind(logId, text, rawHash, source, sourceApp, sender, ignoreCheck.reason, receivedAt).run();
    return json({ ok: true, log_id: logId, parsed_status: 'ignored', reason: ignoreCheck.reason, version: 'v0.1.2' });
  }

  var parsed = detectBankAndParse(text);

  if (parsed && parsed.skip) {
    await db.prepare(
      "INSERT INTO txn_ingest_log (id, raw_text, raw_hash, source, source_app, sender, bank_detected, parsed_status, error_reason, received_at, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ignored', ?, ?, datetime('now'))"
    ).bind(logId, text, rawHash, source, sourceApp, sender, parsed.bank, parsed.skipReason, receivedAt).run();
    return json({ ok: true, log_id: logId, parsed_status: 'ignored', reason: parsed.skipReason, version: 'v0.1.2' });
  }

  if (!parsed || !parsed.amount || !parsed.account_id || !parsed.type) {
    await db.prepare(
      "INSERT INTO txn_ingest_log (id, raw_text, raw_hash, source, source_app, sender, parsed_status, error_reason, received_at, parsed_at) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, datetime('now'))"
    ).bind(logId, text, rawHash, source, sourceApp, sender, 'no_parser_match_or_incomplete', receivedAt).run();
    return json({ ok: true, log_id: logId, parsed_status: 'failed', reason: 'no_parser_match_or_incomplete', version: 'v0.1.2' });
  }

  var txnId = genId('TXN');
  var txnDate = parsed.date || todayISO();

  try {
    await db.prepare(
      "INSERT INTO transactions (id, type, amount, date, account_id, category_id, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(
      txnId,
      parsed.type,
      parsed.amount,
      txnDate,
      parsed.account_id,
      'auto-sms',
      parsed.notes || ('Auto-ingested from ' + (parsed.bank || 'sms'))
    ).run();

    await db.prepare(
      "INSERT INTO txn_ingest_log (id, raw_text, raw_hash, source, source_app, sender, bank_detected, parsed_status, parsed_amount, parsed_account_id, parsed_type, parsed_ref, parsed_notes, created_txn_id, received_at, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(
      logId, text, rawHash, source, sourceApp, sender, parsed.bank,
      parsed.amount, parsed.account_id, parsed.type, parsed.ref, parsed.notes,
      txnId, receivedAt
    ).run();

    await audit(env, {
      action: 'TXN_AUTO_INGEST',
      entity: 'transaction',
      entity_id: txnId,
      kind: 'mutation',
      detail: JSON.stringify({
        log_id: logId,
        bank: parsed.bank,
        amount: parsed.amount,
        type: parsed.type,
        account_id: parsed.account_id,
        source: source,
        sender: sender,
        version: 'v0.1.2'
      }),
      created_by: 'auto-ingest-' + (parsed.bank || 'sms')
    });

    return json({
      ok: true,
      log_id: logId,
      parsed_status: 'parsed',
      txn_id: txnId,
      bank: parsed.bank,
      amount: parsed.amount,
      account_id: parsed.account_id,
      type: parsed.type,
      date: txnDate,
      version: 'v0.1.2'
    });

  } catch (e) {
    await db.prepare(
      "INSERT INTO txn_ingest_log (id, raw_text, raw_hash, source, source_app, sender, bank_detected, parsed_status, parsed_amount, parsed_account_id, parsed_type, error_reason, received_at, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(
      logId, text, rawHash, source, sourceApp, sender, parsed.bank,
      parsed.amount, parsed.account_id, parsed.type,
      'txn_insert_error: ' + e.message,
      receivedAt
    ).run();
    return json({ ok: false, log_id: logId, parsed_status: 'failed', error: e.message, version: 'v0.1.2' }, 500);
  }
}
