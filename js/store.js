/* ─── Sovereign Finance · Data Store v0.0.10 · Sub-1D-3-PARITY ───
 * CHANGES from v0.0.9:
 *   - deleteTransaction() now ROUTES to /api/transactions/reverse (audit-safe soft reverse)
 *     was: DELETE row + remove from cache (destructive, no audit, no snapshot)
 *     now: POST /api/transactions/reverse → atomic snapshot + audit + linked-pair handling
 *   - editTransaction() flow neutralized: shows alert directing to Add page or Reverse
 *     was: opened modal that PUT-updated rows (also destructive)
 *     now: alert + return — caller can no longer mutate audit trail
 *   - All other store methods unchanged
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

  const CATEGORIES = [
    { id: 'food',         name: 'Food',           icon: '🍔', kind: 'expense' },
    { id: 'groceries',    name: 'Groceries',      icon: '🛒', kind: 'expense' },
    { id: 'transport',    name: 'Transport',      icon: '🚗', kind: 'expense' },
    { id: 'bills',        name: 'Bills',          icon: '📄', kind: 'expense' },
    { id: 'health',       name: 'Health',         icon: '💊', kind: 'expense' },
    { id: 'personal',     name: 'Personal',       icon: '👕', kind: 'expense' },
    { id: 'family',       name: 'Family',         icon: '👨‍👩‍👧', kind: 'expense' },
    { id: 'debt_payment', name: 'Debt Payment',   icon: '💸', kind: 'expense' },
    { id: 'cc_payment',   name: 'CC Payment',     icon: '💳', kind: 'transfer' },
    { id: 'salary',       name: 'Salary',         icon: '💰', kind: 'income' },
    { id: 'gift',         name: 'Gift Received',  icon: '🎁', kind: 'income' },
    { id: 'other',        name: 'Other',          icon: '📌', kind: 'expense' }
  ];

  const store = {
    accounts: FALLBACK_ACCOUNTS.slice(),
    categories: CATEGORIES,
    cachedAccounts: FALLBACK_ACCOUNTS.slice(),
    cachedTransactions: [],
    cachedDebts: [],
    cachedBills: [],
    cachedAuditLog: [],

    /* ─── Refresh balances + accounts ─── */
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

    /* ─── Refresh transactions ─── */
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

    /* ─── Refresh debts ─── */
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

    /* ─── Refresh bills ─── */
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

    /* ─── Refresh audit log ─── */
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

    /* ─── ADD TRANSACTION (audit-wired POST) ─── */
    async addTransaction(data) {
      const amount = parseFloat(data.amount);
      if (isNaN(amount) || amount <= 0) {
        return { ok: false, error: 'Amount must be > 0' };
      }
      if (!data.accountId) return { ok: false, error: 'Account required' };

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

      try {
        const r = await fetch(API + '/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const d = await r.json();
        if (!d.ok) {
          // Fall back to offline queue
          this._queueOffline(payload);
          return { ok: true, queued: true, offline: true, error: d.error };
        }
        // Refresh caches
        await Promise.all([this.refreshBalances(), this.refreshTransactions()]);
        return { ok: true, id: d.id, linked_id: d.linked_id, audited: d.audited };
      } catch (e) {
        this._queueOffline(payload);
        return { ok: true, queued: true, offline: true, error: e.message };
      }
    },

    /* ─── REVERSE TRANSACTION (audit-safe — replaces deleteTransaction) ─── */
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

    /* ─── DEPRECATED: deleteTransaction now routes to reverse ─── */
    async deleteTransaction(id) {
      console.warn('[store] deleteTransaction is deprecated — routing to reverseTransaction (audit-safe)');
      return this.reverseTransaction(id, 'web-deprecated-delete');
    },

    /* ─── DEPRECATED: editTransaction blocked (would bypass audit) ─── */
    async editTransaction(id /*, updates */) {
      const msg = 'Editing transactions is disabled to preserve the audit trail.\n\n' +
                  'To correct a mistake:\n' +
                  '  1. Click ↩ Reverse on the wrong transaction (creates an opposite entry + audit log)\n' +
                  '  2. Use the Add page to enter the correct transaction\n\n' +
                  'This is the banking-grade pattern — no row is ever silently changed.';
      console.warn('[store] editTransaction blocked for id', id);
      if (typeof alert === 'function') alert(msg);
      return { ok: false, error: 'editTransaction disabled — use Reverse + new entry' };
    },

    /* ─── Offline queue ─── */
    _queueOffline(payload) {
      try {
        const q = JSON.parse(localStorage.getItem(STORAGE_KEY_TX) || '[]');
        q.push({ ...payload, queued_at: Date.now() });
        localStorage.setItem(STORAGE_KEY_TX, JSON.stringify(q));
      } catch (e) { /* ignore */ }
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
})();
