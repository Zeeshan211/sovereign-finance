/* ─── Sovereign Finance · Data Store v0.2.0 · Sub-1D-CATEGORY-RECONCILE Ship B ───
 * Fetches live categories from /api/categories on init.
 * Falls back to FALLBACK_CATEGORIES if API unreachable (offline-friendly).
 *
 * Changes vs v0.1.0:
 *   - CATEGORIES renamed FALLBACK_CATEGORIES (matches FALLBACK_ACCOUNTS pattern)
 *   - FALLBACK_CATEGORIES updated to match D1 real IDs (was drifted: groceries→grocery, debt_payment→debt, cc_payment→cc_pay, added cc_spend/biller/transfer)
 *   - store.categories now starts as fallback, gets replaced by live D1 data on refreshCategories() success
 *   - New refreshCategories() method — fetches /api/categories, updates store.categories
 *   - getCachedAll() now also calls refreshCategories
 *   - getCategory(id) — unchanged interface, reads from store.categories (now live)
 *
 * PRESERVED from v0.1.0:
 *   - All 4xx vs 5xx discrimination logic in addTransaction
 *   - All other refresh* methods
 *   - Offline queue
 *   - All FALLBACK_ACCOUNTS (verified match D1)
 *   - Reverse, deleteTransaction, editTransaction (deprecated)
 *   - All public method signatures unchanged
 */

(function () {
  const API = '';
  const STORAGE_KEY_TX = 'sovfin_offline_txns_v1';

  const FALLBACK_ACCOUNTS = [
    { id: 'cash',        name: 'Cash',         icon: '💵', kind: 'cash',    type: 'asset',     balance: 0 },
    { id: 'meezan',      name: 'Meezan',       icon: '🕌', kind: 'bank',    type: 'asset',     balance: 0 },
    { id: 'mashreq',     name: 'Mashreq Bank', icon: '🏛', kind: 'bank',    type: 'asset',     balance: 0 },
    { id: 'ubl',         name: 'UBL',          icon: '🏦', kind: 'bank',    type: 'asset',     balance: 0 },
    { id: 'ubl_prepaid', name: 'UBL Prepaid',  icon: '💳', kind: 'prepaid', type: 'asset',     balance: 0 },
    { id: 'easypaisa',   name: 'Easypaisa',    icon: '📲', kind: 'wallet',  type: 'asset',     balance: 0 },
    { id: 'jazzcash',    name: 'JazzCash',     icon: '📱', kind: 'wallet',  type: 'asset',     balance: 0 },
    { id: 'naya_pay',    name: 'Naya Pay',     icon: '💠', kind: 'wallet',  type: 'asset',     balance: 0 },
    { id: 'js_bank',     name: 'JS Bank',      icon: '💼', kind: 'bank',    type: 'asset',     balance: 0 },
    { id: 'alfalah',     name: 'Bank Alfalah', icon: '🏢', kind: 'bank',    type: 'asset',     balance: 0 },
    { id: 'cc',          name: 'Alfalah CC',   icon: '🪪', kind: 'cc',      type: 'liability', balance: 0 }
  ];

  // FALLBACK only — used when /api/categories unreachable. Real categories live in D1.
  // IDs MUST match D1 (per SCHEMA.md REAL DATA section, captured 2026-05-04)
  const FALLBACK_CATEGORIES = [
    { id: 'food',      name: 'Food',          icon: '🍔', type: null, display_order: 1 },
    { id: 'grocery',   name: 'Groceries',     icon: '🛒', type: null, display_order: 2 },
    { id: 'transport', name: 'Transport',     icon: '🚗', type: null, display_order: 3 },
    { id: 'bills',     name: 'Bills',         icon: '📄', type: null, display_order: 4 },
    { id: 'health',    name: 'Health',        icon: '💊', type: null, display_order: 5 },
    { id: 'personal',  name: 'Personal',      icon: '👕', type: null, display_order: 6 },
    { id: 'family',    name: 'Family',        icon: '👨‍👩‍👧', type: null, display_order: 7 },
    { id: 'debt',      name: 'Debt Payment',  icon: '💸', type: null, display_order: 8 },
    { id: 'cc_pay',    name: 'CC Payment',    icon: '💳', type: null, display_order: 9 },
    { id: 'cc_spend',  name: 'CC Spend',      icon: '🛍', type: null, display_order: 10 },
    { id: 'biller',    name: 'Biller Charge', icon: '🏷', type: null, display_order: 11 },
    { id: 'salary',    name: 'Salary',        icon: '💰', type: null, display_order: 12 },
    { id: 'gift',      name: 'Gift Received', icon: '🎁', type: null, display_order: 13 },
    { id: 'transfer',  name: 'Transfer',      icon: '↔', type: null, display_order: 14 },
    { id: 'other',     name: 'Other',         icon: '📌', type: null, display_order: 15 }
  ];

  const store = {
    accounts: FALLBACK_ACCOUNTS.slice(),
    categories: FALLBACK_CATEGORIES.slice(),
    cachedAccounts: FALLBACK_ACCOUNTS.slice(),
    cachedCategories: FALLBACK_CATEGORIES.slice(),
    cachedTransactions: [],
    cachedDebts: [],
    cachedBills: [],
    cachedAuditLog: [],

    async refreshBalances() {
      try {
        const r = await fetch(API + '/api/balances', { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'balances failed');
        this.cachedAccounts = d.accounts || FALLBACK_ACCOUNTS;
        this.accounts = this.cachedAccounts;
        this.totals = {
          netWorth:  d.net_worth,
          liquid:    d.total_liquid_assets,
          cc:        d.cc_outstanding,
          debts:     d.total_owe || d.total_debts || 0
        };
        return d;
      } catch (e) {
        console.warn('[store] refreshBalances failed:', e.message);
        return null;
      }
    },

    async refreshCategories() {
      try {
        const r = await fetch(API + '/api/categories', { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'categories failed');
        if (Array.isArray(d.categories) && d.categories.length > 0) {
          this.cachedCategories = d.categories;
          this.categories = this.cachedCategories;
        }
        return this.categories;
      } catch (e) {
        console.warn('[store] refreshCategories failed (using fallback):', e.message);
        return this.categories;
      }
    },

    async refreshTransactions() {
      try {
        const r = await fetch(API + '/api/transactions', { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'txns failed');
        this.cachedTransactions = d.transactions || [];
        return this.cachedTransactions;
      } catch (e) {
        console.warn('[store] refreshTransactions failed:', e.message);
        return [];
      }
    },

    async refreshDebts() {
      try {
        const r = await fetch(API + '/api/debts', { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'debts failed');
        this.cachedDebts = d.debts || [];
        return this.cachedDebts;
      } catch (e) {
        console.warn('[store] refreshDebts failed:', e.message);
        return [];
      }
    },

    async refreshBills() {
      try {
        const r = await fetch(API + '/api/bills', { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'bills failed');
        this.cachedBills = d.bills || [];
        return this.cachedBills;
      } catch (e) {
        console.warn('[store] refreshBills failed:', e.message);
        return [];
      }
    },

    async refreshAuditLog(limit = 50) {
      try {
        const r = await fetch(API + '/api/audit?limit=' + limit, { cache: 'no-store' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'audit failed');
        this.cachedAuditLog = d.rows || [];
        return this.cachedAuditLog;
      } catch (e) {
        console.warn('[store] refreshAuditLog failed:', e.message);
        return [];
      }
    },

    async refreshAccounts() { return this.refreshBalances(); },
    getAccount(id)  { return (this.cachedAccounts || []).find(a => a.id === id) || null; },
    getCategory(id) { return (this.cachedCategories || []).find(c => c.id === id) || null; },

    async getCachedAll() {
      await Promise.all([
        this.refreshBalances(),
        this.refreshCategories(),
        this.refreshTransactions(),
        this.refreshDebts(),
        this.refreshBills()
      ]);
      return {
        balances: this.totals,
        accounts: this.cachedAccounts,
        categories: this.cachedCategories,
        transactions: this.cachedTransactions,
        debts: this.cachedDebts,
        bills: this.cachedBills
      };
    },

    get balances() { return this.totals || {}; },
    get debts() { return this.cachedDebts; },
    get bills() { return this.cachedBills; },
    get transactions() { return this.cachedTransactions; },

    async addTransaction(data) {
      const amount = parseFloat(data.amount);
      if (isNaN(amount) || amount <= 0) {
        return { ok: false, error: 'Amount must be > 0', status: 0 };
      }
      if (!data.accountId) return { ok: false, error: 'Account required', status: 0 };

      const payload = {
        date:        data.date || new Date().toISOString().slice(0, 10),
        type:        data.type || 'expense',
        amount:      amount,
        account_id:  data.accountId,
        category_id: data.categoryId || 'other',
        notes:       (data.notes || '').slice(0, 200),
        created_by:  data.createdBy || 'web-add'
      };
      if (data.transferToAccountId) {
        payload.transfer_to_account_id = data.transferToAccountId;
      }

      let r;
      try {
        r = await fetch(API + '/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        console.warn('[store] addTransaction network error — queueing for retry:', netErr.message);
        this._queueOffline(payload);
        return { ok: true, queued: true, offline: true, error: netErr.message, status: 0 };
      }

      let d = null;
      try { d = await r.json(); }
      catch (parseErr) {
        if (r.status >= 500) {
          console.warn('[store] addTransaction 5xx with non-JSON body — queueing:', r.status);
          this._queueOffline(payload);
          return { ok: true, queued: true, offline: true, error: 'HTTP ' + r.status + ' (no JSON body)', status: r.status };
        }
        console.warn('[store] addTransaction non-JSON response — surfacing error:', r.status);
        return { ok: false, error: 'HTTP ' + r.status + ' (no JSON body)', status: r.status };
      }

      if (d && d.ok) {
        await Promise.all([this.refreshBalances(), this.refreshTransactions()]);
        return { ok: true, id: d.id, linked_id: d.linked_id, audited: d.audited, status: r.status };
      }

      const errMsg = (d && d.error) || ('HTTP ' + r.status);

      if (r.status >= 500) {
        console.warn('[store] addTransaction 5xx — queueing for retry:', errMsg);
        this._queueOffline(payload);
        return { ok: true, queued: true, offline: true, error: errMsg, status: r.status };
      }

      console.warn('[store] addTransaction rejected (' + r.status + '):', errMsg);
      return { ok: false, error: errMsg, status: r.status };
    },

    async reverseTransaction(id, createdBy = 'web-store') {
      if (!id) return { ok: false, error: 'id required' };
      try {
        const r = await fetch(API + '/api/transactions/reverse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, created_by: createdBy })
        });
        const d = await r.json();
        if (!d.ok) return { ok: false, error: d.error };
        await Promise.all([this.refreshBalances(), this.refreshTransactions(), this.refreshDebts()]);
        return d;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async deleteTransaction(id) {
      console.warn('[store] deleteTransaction is deprecated — routing to reverseTransaction');
      return this.reverseTransaction(id, 'web-deprecated-delete');
    },

    async editTransaction(id) {
      const msg = 'Editing transactions is disabled to preserve the audit trail.\n\n' +
                  'To correct a mistake:\n' +
                  '  1. Click ↩ Reverse on the wrong transaction\n' +
                  '  2. Use the Add page to enter the correct one\n\n' +
                  'Banking-grade pattern — no row is ever silently changed.';
      console.warn('[store] editTransaction blocked for id', id);
      if (typeof alert === 'function') alert(msg);
      return { ok: false, error: 'editTransaction disabled — use Reverse + new entry' };
    },

    _queueOffline(payload) {
      try {
        const q = JSON.parse(localStorage.getItem(STORAGE_KEY_TX) || '[]');
        q.push({ ...payload, queued_at: Date.now() });
        localStorage.setItem(STORAGE_KEY_TX, JSON.stringify(q));
      } catch (e) {}
    },

    getOfflineQueue() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY_TX) || '[]'); }
      catch (e) { return []; }
    },

    clearOfflineQueue() {
      try { localStorage.removeItem(STORAGE_KEY_TX); } catch (e) {}
    }
  };

  window.store = store;

  // Auto-refresh categories on script load (non-blocking)
  store.refreshCategories();
})();
