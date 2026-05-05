/* ─── Sovereign Finance · Data Store v0.2.2 · Layer 2 caller contract repair ─── */
/*
 * Changes vs v0.2.1:
 *   - Normalizes /api/balances accounts object map into an array for UI callers.
 *   - Keeps accountsById map for lookup.
 *   - Preserves addTransaction payload contract.
 *   - Preserves offline queue.
 *   - Preserves reverseTransaction.
 *
 * Layer 2 rule:
 *   UI pages should not care whether an API returns accounts as object map or array.
 *   store.js absorbs that contract difference.
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

  function normalizeAccounts(raw) {
    if (Array.isArray(raw)) return raw.map(a => ({ ...a }));

    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(id => ({
        id,
        ...raw[id]
      }));
    }

    return FALLBACK_ACCOUNTS.slice();
  }

  function toMap(rows) {
    const map = {};
    (rows || []).forEach(row => {
      if (row && row.id) map[row.id] = row;
    });
    return map;
  }

  function normalizeCategories(raw) {
    if (Array.isArray(raw) && raw.length) return raw.map(c => ({ ...c }));
    return FALLBACK_CATEGORIES.slice();
  }

  const store = {
    accounts: FALLBACK_ACCOUNTS.slice(),
    accountsById: toMap(FALLBACK_ACCOUNTS),
    categories: FALLBACK_CATEGORIES.slice(),

    cachedAccounts: FALLBACK_ACCOUNTS.slice(),
    cachedAccountsById: toMap(FALLBACK_ACCOUNTS),
    cachedCategories: FALLBACK_CATEGORIES.slice(),
    cachedTransactions: [],
    cachedDebts: [],
    cachedBills: [],
    cachedAuditLog: [],

    totals: {
      netWorth: 0,
      liquid: 0,
      cc: 0,
      debts: 0,
      trueBurden: 0
    },

    _draining: false,

    async refreshBalances() {
      try {
        const r = await fetch(API + '/api/balances', { cache: 'no-store' });
        const d = await r.json();

        if (!d.ok) throw new Error(d.error || 'balances failed');

        const accountRows = normalizeAccounts(d.accounts);

        this.cachedAccounts = accountRows;
        this.cachedAccountsById = toMap(accountRows);
        this.accounts = accountRows;
        this.accountsById = this.cachedAccountsById;

        this.totals = {
          netWorth: Number(d.net_worth) || 0,
          liquid: Number(d.total_liquid || d.total_liquid_assets || d.cash_accessible || 0),
          cc: Number(d.cc_outstanding || d.cc || 0),
          debts: Number(d.total_owed || d.total_owe || d.total_debts || 0),
          trueBurden: Number(d.true_burden || 0),
          receivables: Number(d.total_receivables || 0)
        };

        return d;
      } catch (e) {
        console.warn('[store v0.2.2] refreshBalances failed:', e.message);

        this.cachedAccounts = FALLBACK_ACCOUNTS.slice();
        this.cachedAccountsById = toMap(this.cachedAccounts);
        this.accounts = this.cachedAccounts;
        this.accountsById = this.cachedAccountsById;

        return null;
      }
    },

    async refreshCategories() {
      try {
        const r = await fetch(API + '/api/categories', { cache: 'no-store' });
        const d = await r.json();

        if (!d.ok) throw new Error(d.error || 'categories failed');

        this.cachedCategories = normalizeCategories(d.categories);
        this.categories = this.cachedCategories;

        return this.categories;
      } catch (e) {
        console.warn('[store v0.2.2] refreshCategories failed, using fallback:', e.message);

        this.cachedCategories = FALLBACK_CATEGORIES.slice();
        this.categories = this.cachedCategories;

        return this.categories;
      }
    },

    async refreshTransactions() {
      try {
        const r = await fetch(API + '/api/transactions', { cache: 'no-store' });
        const d = await r.json();

        if (!d.ok) throw new Error(d.error || 'txns failed');

        this.cachedTransactions = d.transactions || [];
        this.transactionCount = Number(d.count || this.cachedTransactions.length || 0);
        this.hiddenReversalCount = Number(d.hidden_reversal_count || 0);

        return this.cachedTransactions;
      } catch (e) {
        console.warn('[store v0.2.2] refreshTransactions failed:', e.message);
        this.cachedTransactions = [];
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
        console.warn('[store v0.2.2] refreshDebts failed:', e.message);
        this.cachedDebts = [];
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
        console.warn('[store v0.2.2] refreshBills failed:', e.message);
        this.cachedBills = [];
        return [];
      }
    },

    async refreshAuditLog(limit = 50) {
      try {
        const r = await fetch(API + '/api/audit?limit=' + encodeURIComponent(limit), { cache: 'no-store' });
        const d = await r.json();

        if (!d.ok) throw new Error(d.error || 'audit failed');

        this.cachedAuditLog = d.rows || d.audit || d.events || [];
        return this.cachedAuditLog;
      } catch (e) {
        console.warn('[store v0.2.2] refreshAuditLog failed:', e.message);
        this.cachedAuditLog = [];
        return [];
      }
    },

    async refreshAccounts() {
      return this.refreshBalances();
    },

    getAccount(id) {
      if (!id) return null;
      return this.accountsById[id] || (this.cachedAccounts || []).find(a => a.id === id) || null;
    },

    getCategory(id) {
      if (!id) return null;
      return (this.cachedCategories || []).find(c => c.id === id) || null;
    },

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
        accountsById: this.cachedAccountsById,
        categories: this.cachedCategories,
        transactions: this.cachedTransactions,
        debts: this.cachedDebts,
        bills: this.cachedBills
      };
    },

    get balances() {
      return this.totals || {};
    },

    get debts() {
      return this.cachedDebts || [];
    },

    get bills() {
      return this.cachedBills || [];
    },

    get transactions() {
      return this.cachedTransactions || [];
    },

    async addTransaction(data) {
      const amount = parseFloat(data.amount);

      if (isNaN(amount) || amount <= 0) {
        return { ok: false, error: 'Amount must be > 0', status: 0 };
      }

      if (!data.accountId) {
        return { ok: false, error: 'Account required', status: 0 };
      }

      const payload = {
        date: data.date || new Date().toISOString().slice(0, 10),
        type: data.type || 'expense',
        amount,
        account_id: data.accountId,
        category_id: data.categoryId || 'other',
        notes: (data.notes || '').slice(0, 200),
        created_by: data.createdBy || 'web-add'
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
        console.warn('[store v0.2.2] addTransaction network error, queueing:', netErr.message);
        this._queueOffline(payload);
        return { ok: true, queued: true, offline: true, error: netErr.message, status: 0 };
      }

      let d = null;

      try {
        d = await r.json();
      } catch (parseErr) {
        if (r.status >= 500) {
          this._queueOffline(payload);
          return {
            ok: true,
            queued: true,
            offline: true,
            error: 'HTTP ' + r.status + ' (no JSON body)',
            status: r.status
          };
        }

        return {
          ok: false,
          error: 'HTTP ' + r.status + ' (no JSON body)',
          status: r.status
        };
      }

      if (d && d.ok) {
        await Promise.all([
          this.refreshBalances(),
          this.refreshTransactions()
        ]);

        return {
          ok: true,
          id: d.id,
          linked_id: d.linked_id,
          audited: d.audited,
          status: r.status
        };
      }

      const errMsg = (d && d.error) || ('HTTP ' + r.status);

      if (r.status >= 500) {
        this._queueOffline(payload);
        return {
          ok: true,
          queued: true,
          offline: true,
          error: errMsg,
          status: r.status
        };
      }

      return {
        ok: false,
        error: errMsg,
        status: r.status
      };
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

        if (!d.ok) return { ok: false, error: d.error || 'reverse failed' };

        await Promise.all([
          this.refreshBalances(),
          this.refreshTransactions(),
          this.refreshDebts()
        ]);

        return d;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async deleteTransaction(id) {
      console.warn('[store v0.2.2] deleteTransaction is deprecated, routing to reverseTransaction');
      return this.reverseTransaction(id, 'web-deprecated-delete');
    },

    async editTransaction(id) {
      const msg =
        'Editing transactions is disabled to preserve the audit trail.\n\n' +
        'To correct a mistake:\n' +
        '1. Reverse the wrong transaction\n' +
        '2. Add the corrected transaction\n\n' +
        'No row is silently changed.';

      console.warn('[store v0.2.2] editTransaction blocked for id', id);

      if (typeof alert === 'function') alert(msg);

      return {
        ok: false,
        error: 'editTransaction disabled — use Reverse + new entry'
      };
    },

    _queueOffline(payload) {
      try {
        const q = JSON.parse(localStorage.getItem(STORAGE_KEY_TX) || '[]');
        q.push({ ...payload, queued_at: Date.now() });
        localStorage.setItem(STORAGE_KEY_TX, JSON.stringify(q));
      } catch (e) {}
    },

    getOfflineQueue() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY_TX) || '[]');
      } catch (e) {
        return [];
      }
    },

    clearOfflineQueue() {
      try {
        localStorage.removeItem(STORAGE_KEY_TX);
      } catch (e) {}
    },

    async drainOfflineQueue() {
      if (this._draining) {
        return { drained: 0, failed: 0, kept: 0, skipped: true };
      }

      this._draining = true;

      try {
        const queue = this.getOfflineQueue();

        if (queue.length === 0) {
          this._draining = false;
          return { drained: 0, failed: 0, kept: 0 };
        }

        let drained = 0;
        let failed = 0;
        const remaining = [];

        for (let i = 0; i < queue.length; i++) {
          const item = queue[i];
          const { queued_at, ...payload } = item;

          try {
            const r = await fetch(API + '/api/transactions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            let d = null;
            try {
              d = await r.json();
            } catch (e) {}

            if (d && d.ok) {
              drained++;
              continue;
            }

            if (r.status >= 400 && r.status < 500) {
              failed++;
              continue;
            }

            remaining.push(item);
          } catch (netErr) {
            remaining.push(item);

            for (let j = i + 1; j < queue.length; j++) {
              remaining.push(queue[j]);
            }

            break;
          }
        }

        if (remaining.length === 0) {
          this.clearOfflineQueue();
        } else {
          localStorage.setItem(STORAGE_KEY_TX, JSON.stringify(remaining));
        }

        if (drained > 0) {
          await Promise.all([
            this.refreshBalances(),
            this.refreshTransactions()
          ]);
        }

        this._draining = false;
        return { drained, failed, kept: remaining.length };
      } catch (err) {
        this._draining = false;
        return {
          drained: 0,
          failed: 0,
          kept: this.getOfflineQueue().length,
          error: err.message
        };
      }
    }
  };

  window.store = store;

  store.refreshCategories();

  if (typeof window !== 'undefined') {
    if (navigator.onLine !== false) {
      setTimeout(() => store.drainOfflineQueue(), 2000);
    }

    window.addEventListener('online', () => {
      store.drainOfflineQueue();
    });
  }
})();
