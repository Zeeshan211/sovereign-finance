/* ─── Sovereign Finance · Data Store v0.2.3 · No silent offline writes ─── */
/*
 * Layer 2 write-safety contract:
 *   - Financial writes must either reach D1 or fail loudly.
 *   - No silent offline queue for transactions.
 *   - No automatic replay of old queued writes.
 *   - UI callers still get normalized accounts/categories.
 */

(function () {
  const API = '';
  const STORAGE_KEY_TX = 'sovfin_offline_txns_v1';

  const FALLBACK_ACCOUNTS = [
    { id: 'cash', name: 'Cash', icon: '💵', kind: 'cash', type: 'asset', balance: 0 },
    { id: 'meezan', name: 'Meezan', icon: '🕌', kind: 'bank', type: 'asset', balance: 0 },
    { id: 'mashreq', name: 'Mashreq Bank', icon: '🏛', kind: 'bank', type: 'asset', balance: 0 },
    { id: 'ubl', name: 'UBL', icon: '🏦', kind: 'bank', type: 'asset', balance: 0 },
    { id: 'ubl_prepaid', name: 'UBL Prepaid', icon: '💳', kind: 'prepaid', type: 'asset', balance: 0 },
    { id: 'easypaisa', name: 'Easypaisa', icon: '📲', kind: 'wallet', type: 'asset', balance: 0 },
    { id: 'jazzcash', name: 'JazzCash', icon: '📱', kind: 'wallet', type: 'asset', balance: 0 },
    { id: 'naya_pay', name: 'Naya Pay', icon: '💠', kind: 'wallet', type: 'asset', balance: 0 },
    { id: 'js_bank', name: 'JS Bank', icon: '💼', kind: 'bank', type: 'asset', balance: 0 },
    { id: 'alfalah', name: 'Bank Alfalah', icon: '🏢', kind: 'bank', type: 'asset', balance: 0 },
    { id: 'cc', name: 'Alfalah CC', icon: '🪪', kind: 'cc', type: 'liability', balance: 0 }
  ];

  const FALLBACK_CATEGORIES = [
    { id: 'food', name: 'Food', icon: '🍔' },
    { id: 'grocery', name: 'Groceries', icon: '🛒' },
    { id: 'transport', name: 'Transport', icon: '🚗' },
    { id: 'bills', name: 'Bills', icon: '📄' },
    { id: 'health', name: 'Health', icon: '💊' },
    { id: 'personal', name: 'Personal', icon: '👕' },
    { id: 'family', name: 'Family', icon: '👨‍👩‍👧' },
    { id: 'debt', name: 'Debt Payment', icon: '💸' },
    { id: 'cc_pay', name: 'CC Payment', icon: '💳' },
    { id: 'cc_spend', name: 'CC Spend', icon: '🛍' },
    { id: 'salary', name: 'Salary', icon: '💰' },
    { id: 'transfer', name: 'Transfer', icon: '↔' },
    { id: 'other', name: 'Other', icon: '📌' }
  ];

  function normalizeAccounts(raw) {
    if (Array.isArray(raw)) return raw.map(a => ({ ...a }));

    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(id => ({ id, ...raw[id] }));
    }

    return FALLBACK_ACCOUNTS.slice();
  }

  function normalizeCategories(raw) {
    if (Array.isArray(raw) && raw.length) return raw.map(c => ({ ...c }));
    return FALLBACK_CATEGORIES.slice();
  }

  function toMap(rows) {
    const map = {};
    (rows || []).forEach(row => {
      if (row && row.id) map[row.id] = row;
    });
    return map;
  }

  async function safeJSON(res) {
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  const store = {
    version: 'v0.2.3',

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
      trueBurden: 0,
      receivables: 0
    },

    async refreshBalances() {
      try {
        const r = await fetch(API + '/api/balances', { cache: 'no-store' });
        const d = await r.json();

        if (!d.ok) throw new Error(d.error || 'balances failed');

        const rows = normalizeAccounts(d.accounts);

        this.cachedAccounts = rows;
        this.cachedAccountsById = toMap(rows);
        this.accounts = rows;
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
        console.warn('[store v0.2.3] refreshBalances failed:', e.message);

        this.cachedAccounts = FALLBACK_ACCOUNTS.slice();
        this.cachedAccountsById = toMap(this.cachedAccounts);
        this.accounts = this.cachedAccounts;
        this.accountsById = this.cachedAccountsById;

        return null;
      }
    },

    async refreshAccounts() {
      return this.refreshBalances();
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
        console.warn('[store v0.2.3] refreshCategories failed, using fallback:', e.message);

        this.cachedCategories = FALLBACK_CATEGORIES.slice();
        this.categories = this.cachedCategories;
        return this.categories;
      }
    },

    async refreshTransactions() {
      try {
        const r = await fetch(API + '/api/transactions', { cache: 'no-store' });
        const d = await r.json();

        if (!d.ok) throw new Error(d.error || 'transactions failed');

        this.cachedTransactions = d.transactions || [];
        this.transactionCount = Number(d.count || this.cachedTransactions.length || 0);
        this.hiddenReversalCount = Number(d.hidden_reversal_count || 0);

        return this.cachedTransactions;
      } catch (e) {
        console.warn('[store v0.2.3] refreshTransactions failed:', e.message);
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
        console.warn('[store v0.2.3] refreshDebts failed:', e.message);
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
        console.warn('[store v0.2.3] refreshBills failed:', e.message);
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
        console.warn('[store v0.2.3] refreshAuditLog failed:', e.message);
        this.cachedAuditLog = [];
        return [];
      }
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

    getAccount(id) {
      if (!id) return null;
      return this.accountsById[id] || (this.cachedAccounts || []).find(a => a.id === id) || null;
    },

    getCategory(id) {
      if (!id) return null;
      return (this.cachedCategories || []).find(c => c.id === id) || null;
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
        category_id: data.categoryId || null,
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
        return {
          ok: false,
          queued: false,
          offline: false,
          error: 'Network error. Transaction was NOT saved and NOT queued: ' + netErr.message,
          status: 0
        };
      }

      const d = await safeJSON(r);

      if (d && d.ok) {
        await Promise.all([
          this.refreshBalances(),
          this.refreshTransactions(),
          this.refreshAuditLog()
        ]);

        return {
          ok: true,
          id: d.id,
          linked_id: d.linked_id,
          ids: d.ids || null,
          audited: d.audited,
          status: r.status
        };
      }

      return {
        ok: false,
        queued: false,
        offline: false,
        error: (d && d.error) || ('HTTP ' + r.status + '. Transaction was NOT saved and NOT queued.'),
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

        const d = await safeJSON(r);

        if (!d || !d.ok) {
          return { ok: false, error: (d && d.error) || ('HTTP ' + r.status) };
        }

        await Promise.all([
          this.refreshBalances(),
          this.refreshTransactions(),
          this.refreshDebts(),
          this.refreshAuditLog()
        ]);

        return d;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    async deleteTransaction(id) {
      console.warn('[store v0.2.3] deleteTransaction is disabled, routing to reverseTransaction');
      return this.reverseTransaction(id, 'web-deprecated-delete');
    },

    async editTransaction(id) {
      const msg =
        'Editing transactions is disabled to preserve the audit trail.\n\n' +
        'To correct a mistake, reverse the wrong transaction and add the corrected one.';

      console.warn('[store v0.2.3] editTransaction blocked for id', id);

      if (typeof alert === 'function') alert(msg);

      return {
        ok: false,
        error: 'editTransaction disabled — use Reverse + new entry'
      };
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

      return { ok: true, cleared: true };
    },

    async drainOfflineQueue() {
      const queued = this.getOfflineQueue();

      if (queued.length) {
        console.warn('[store v0.2.3] offline queue is disabled. Clearing queued financial writes instead of replaying.', queued);
        this.clearOfflineQueue();
      }

      return {
        ok: true,
        disabled: true,
        drained: 0,
        failed: 0,
        cleared: queued.length,
        message: 'Offline transaction replay is disabled for financial safety.'
      };
    }
  };

  window.store = store;

  store.refreshCategories();

  if (typeof window !== 'undefined') {
    console.log('[store v0.2.3] loaded · offline write queue disabled');
  }
})();
