/* ─── Sovereign Finance · Data Store v0.1.0 ─── */
/* D1-backed via /api/* with offline cache + queue */

(function () {
  const QUEUE_KEY = 'sov_pending_v1';
  const CACHE_TX_KEY = 'sov_cache_tx_v1';
  const CACHE_BAL_KEY = 'sov_cache_bal_v1';
  const CACHE_DEBTS_KEY = 'sov_cache_debts_v1';
  const ACCOUNTS_KEY = 'sov_accounts_v1';
  const MAX_NOTES_LENGTH = 200;

  const FALLBACK_ACCOUNTS = [
    { id: 'cash',     name: 'Cash',         icon: '💵', type: 'asset',     kind: 'cash',    balance: 0 },
    { id: 'jazzcash', name: 'JazzCash',     icon: '📱', type: 'asset',     kind: 'wallet',  balance: 0 },
    { id: 'easypaisa',name: 'Easypaisa',    icon: '📲', type: 'asset',     kind: 'wallet',  balance: 0 },
    { id: 'ubl',      name: 'UBL',          icon: '🏦', type: 'asset',     kind: 'bank',    balance: 0 },
    { id: 'meezan',   name: 'Meezan',       icon: '🕌', type: 'asset',     kind: 'bank',    balance: 0 },
    { id: 'mashreq',  name: 'Mashreq Bank', icon: '🏛', type: 'asset',     kind: 'bank',    balance: 0 },
    { id: 'js',       name: 'JS Bank',      icon: '💼', type: 'asset',     kind: 'bank',    balance: 0 },
    { id: 'nayapay',  name: 'Naya Pay',     icon: '💠', type: 'asset',     kind: 'wallet',  balance: 0 },
    { id: 'alfalah',  name: 'Bank Alfalah', icon: '🏢', type: 'asset',     kind: 'bank',    balance: 0 },
    { id: 'ublprep',  name: 'UBL Prepaid',  icon: '💳', type: 'asset',     kind: 'prepaid', balance: 0 },
    { id: 'cc',       name: 'Alfalah CC',   icon: '🪪', type: 'liability', kind: 'cc',      balance: 0 }
  ];

  const CATEGORIES = [
    { id: 'food',     name: 'Food',          icon: '🍔' },
    { id: 'grocery',  name: 'Groceries',     icon: '🛒' },
    { id: 'transport',name: 'Transport',     icon: '🚗' },
    { id: 'bills',    name: 'Bills',         icon: '📄' },
    { id: 'health',   name: 'Health',        icon: '💊' },
    { id: 'personal', name: 'Personal',      icon: '👕' },
    { id: 'family',   name: 'Family',        icon: '👨‍👩‍👧' },
    { id: 'debt',     name: 'Debt Payment',  icon: '💸' },
    { id: 'cc_pay',   name: 'CC Payment',    icon: '💳' },
    { id: 'salary',   name: 'Salary',        icon: '💰' },
    { id: 'gift',     name: 'Gift Received', icon: '🎁' },
    { id: 'other',    name: 'Other',         icon: '✨' }
  ];

  let cachedAccounts = readJson(ACCOUNTS_KEY, FALLBACK_ACCOUNTS);
  let cachedTransactions = readJson(CACHE_TX_KEY, []);
  let cachedBalances = readJson(CACHE_BAL_KEY, null) || {
    net_worth: 0, total_assets: 0, total_liabilities: 0, cc_outstanding: 0
  };
  let cachedDebts = readJson(CACHE_DEBTS_KEY, null) || {
    count: 0, total_owe: 0, total_owed: 0, debts: []
  };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.error('localStorage write failed', e); return false; }
  }

  function genId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function refreshBalances() {
    try {
      const res = await fetch('/api/balances');
      const data = await res.json();
      if (data.ok) {
        cachedBalances = {
          net_worth: data.net_worth,
          total_assets: data.total_assets,
          total_liabilities: data.total_liabilities,
          cc_outstanding: data.cc_outstanding
        };
        writeJson(CACHE_BAL_KEY, cachedBalances);
        if (Array.isArray(data.accounts)) {
          cachedAccounts = data.accounts;
          writeJson(ACCOUNTS_KEY, cachedAccounts);
        }
      }
    } catch (e) { console.warn('balances API offline'); }
    return cachedBalances;
  }

  async function refreshTransactions() {
    try {
      const res = await fetch('/api/transactions');
      const data = await res.json();
      if (data.ok && Array.isArray(data.transactions)) {
        cachedTransactions = data.transactions.map(tx => ({
          id: tx.id, date: tx.date, type: tx.type, amount: tx.amount,
          accountId: tx.account_id, categoryId: tx.category_id,
          notes: tx.notes, createdAt: tx.created_at
        }));
        writeJson(CACHE_TX_KEY, cachedTransactions);
      }
    } catch (e) { console.warn('transactions API offline'); }
    return cachedTransactions;
  }

  async function refreshDebts() {
    try {
      const res = await fetch('/api/debts');
      const data = await res.json();
      if (data.ok) {
        cachedDebts = {
          count: data.count, total_owe: data.total_owe,
          total_owed: data.total_owed, debts: data.debts || []
        };
        writeJson(CACHE_DEBTS_KEY, cachedDebts);
      }
    } catch (e) { console.warn('debts API offline'); }
    return cachedDebts;
  }

  function enqueue(payload) {
    const queue = readJson(QUEUE_KEY, []);
    queue.push({ id: genId(), payload, queuedAt: new Date().toISOString() });
    writeJson(QUEUE_KEY, queue);
  }

  async function flushQueue() {
    const queue = readJson(QUEUE_KEY, []);
    if (queue.length === 0) return { flushed: 0 };
    const remaining = []; let ok = 0;
    for (const item of queue) {
      try {
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (data.ok) ok++; else remaining.push(item);
      } catch (e) { remaining.push(item); }
    }
    writeJson(QUEUE_KEY, remaining);
    return { flushed: ok, remaining: remaining.length };
  }

  flushQueue();

  window.store = {
    get accounts() { return cachedAccounts; },
    get categories() { return CATEGORIES; },
    get balances() { return cachedBalances; },
    get debts() { return cachedDebts; },

    refreshBalances,
    refreshTransactions,
    refreshDebts,

    async addTransaction(input) {
      const amount = parseFloat(input.amount);
      if (isNaN(amount) || amount <= 0) return { ok: false, error: 'Amount must be greater than 0' };
      if (!input.accountId) return { ok: false, error: 'Pick an account' };
      if (!input.type) return { ok: false, error: 'Pick a type' };

      const payload = {
        type: input.type, amount: amount,
        account_id: input.accountId,
        category_id: input.categoryId || 'other',
        date: input.date || new Date().toISOString().slice(0, 10),
        notes: (input.notes || '').slice(0, MAX_NOTES_LENGTH)
      };

      try {
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.ok) return { ok: false, error: data.error || 'Save failed' };
        await Promise.all([refreshTransactions(), refreshBalances()]);
        return { ok: true, id: data.id };
      } catch (e) {
        enqueue(payload);
        return { ok: true, id: 'queued', queued: true };
      }
    },

    async getAll() {
      await refreshTransactions();
      return cachedTransactions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },

    getCachedAll() {
      return cachedTransactions.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },

    getAccount(id) {
      return cachedAccounts.find(a => a.id === id) || { name: 'Unknown', icon: '❓' };
    },

    getCategory(id) {
      return CATEGORIES.find(c => c.id === id) || { name: 'Other', icon: '✨' };
    }
  };

  refreshBalances();
})();