/* ─── Sovereign Finance · Data Store v0.0.9 ─── */
/* D1-backed via /api/* with localStorage offline fallback */

(function () {
  const QUEUE_KEY = 'sov_pending_v1';
  const CACHE_KEY = 'sov_cache_v1';
  const ACCOUNTS_KEY = 'sov_accounts_v1';
  const MAX_NOTES_LENGTH = 200;

  // Fallback in case API is down on first load
  const FALLBACK_ACCOUNTS = [
    { id: 'cash',     name: 'Cash',         icon: '💵', kind: 'asset' },
    { id: 'jazzcash', name: 'JazzCash',     icon: '📱', kind: 'asset' },
    { id: 'easypaisa',name: 'Easypaisa',    icon: '📲', kind: 'asset' },
    { id: 'ubl',      name: 'UBL',          icon: '🏦', kind: 'asset' },
    { id: 'meezan',   name: 'Meezan',       icon: '🕌', kind: 'asset' },
    { id: 'mashreq',  name: 'Mashreq Bank', icon: '🏛', kind: 'asset' },
    { id: 'js',       name: 'JS Bank',      icon: '💼', kind: 'asset' },
    { id: 'nayapay',  name: 'Naya Pay',     icon: '💠', kind: 'asset' },
    { id: 'alfalah',  name: 'Bank Alfalah', icon: '🏢', kind: 'asset' },
    { id: 'ublprep',  name: 'UBL Prepaid',  icon: '💳', kind: 'asset' },
    { id: 'cc',       name: 'Alfalah CC',   icon: '🪪', kind: 'liability' }
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
  let cachedTransactions = readJson(CACHE_KEY, []);

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('localStorage write failed', e);
      return false;
    }
  }

  function genId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Fetch accounts from API, update cache, fall back to cache on error
  async function refreshAccounts() {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      if (data.ok && Array.isArray(data.accounts)) {
        cachedAccounts = data.accounts.map(a => ({
          id: a.id, name: a.name, icon: a.icon, kind: a.type
        }));
        writeJson(ACCOUNTS_KEY, cachedAccounts);
      }
    } catch (e) {
      console.warn('accounts API offline, using cache');
    }
    return cachedAccounts;
  }

  async function refreshTransactions() {
    try {
      const res = await fetch('/api/transactions');
      const data = await res.json();
      if (data.ok && Array.isArray(data.transactions)) {
        cachedTransactions = data.transactions.map(tx => ({
          id: tx.id,
          date: tx.date,
          type: tx.type,
          amount: tx.amount,
          accountId: tx.account_id,
          categoryId: tx.category_id,
          notes: tx.notes,
          createdAt: tx.created_at
        }));
        writeJson(CACHE_KEY, cachedTransactions);
      }
    } catch (e) {
      console.warn('transactions API offline, using cache');
    }
    return cachedTransactions;
  }

  // Queue offline writes
  function enqueue(payload) {
    const queue = readJson(QUEUE_KEY, []);
    queue.push({ id: genId(), payload, queuedAt: new Date().toISOString() });
    writeJson(QUEUE_KEY, queue);
  }

  async function flushQueue() {
    const queue = readJson(QUEUE_KEY, []);
    if (queue.length === 0) return { flushed: 0 };
    const remaining = [];
    let ok = 0;
    for (const item of queue) {
      try {
        const res = await fetch('/api/transactions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (data.ok) ok++; else remaining.push(item);
      } catch (e) {
        remaining.push(item);
      }
    }
    writeJson(QUEUE_KEY, remaining);
    return { flushed: ok, remaining: remaining.length };
  }

  // Try to flush on page load
  flushQueue();

  window.store = {
    get accounts() { return cachedAccounts; },
    get categories() { return CATEGORIES; },

    refreshAccounts,
    refreshTransactions,

    async addTransaction(input) {
      const amount = parseFloat(input.amount);
      if (isNaN(amount) || amount <= 0) return { ok: false, error: 'Amount must be greater than 0' };
      if (!input.accountId) return { ok: false, error: 'Pick an account' };
      if (!input.type) return { ok: false, error: 'Pick a type' };

      const payload = {
        type: input.type,
        amount: amount,
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
        // refresh cache
        await refreshTransactions();
        return { ok: true, id: data.id };
      } catch (e) {
        // Offline — queue for later
        enqueue(payload);
        return { ok: true, id: 'queued', queued: true };
      }
    },

    async getAll() {
      await refreshTransactions();
      return cachedTransactions.sort((a, b) =>
        (b.createdAt || '').localeCompare(a.createdAt || '')
      );
    },

    getCachedAll() {
      return cachedTransactions.sort((a, b) =>
        (b.createdAt || '').localeCompare(a.createdAt || '')
      );
    },

    getAccount(id) {
      return cachedAccounts.find(a => a.id === id) || { name: 'Unknown', icon: '❓' };
    },

    getCategory(id) {
      return CATEGORIES.find(c => c.id === id) || { name: 'Other', icon: '✨' };
    },

    async clearAllTransactions() {
      writeJson(CACHE_KEY, []);
      cachedTransactions = [];
    }
  };

  // Refresh accounts on load (non-blocking)
  refreshAccounts();
})();