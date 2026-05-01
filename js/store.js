/* ─── Sovereign Finance · Data Store v0.0.5 ─── */
/* localStorage layer. Will be swapped for Cloudflare D1 in v0.0.6 */

(function () {
  const STORAGE_KEY = 'sov_transactions_v1';
  const MAX_NOTES_LENGTH = 200;

  const ACCOUNTS = [
    { id: 'cash',     name: 'Cash',         icon: '💵', kind: 'asset' },
    { id: 'jazzcash', name: 'JazzCash',     icon: '🟠', kind: 'asset' },
    { id: 'easypaisa',name: 'Easypaisa',    icon: '🟢', kind: 'asset' },
    { id: 'ubl',      name: 'UBL',          icon: '🏦', kind: 'asset' },
    { id: 'meezan',   name: 'Meezan',       icon: '⭐', kind: 'asset' },
    { id: 'mashreq',  name: 'Mashreq Bank', icon: '🟦', kind: 'asset' },
    { id: 'js',       name: 'JS Bank',      icon: '🟪', kind: 'asset' },
    { id: 'nayapay',  name: 'Naya Pay',     icon: '💜', kind: 'asset' },
    { id: 'alfalah',  name: 'Bank Alfalah', icon: '🟡', kind: 'asset' },
    { id: 'ublprep',  name: 'UBL Prepaid',  icon: '💳', kind: 'asset' },
    { id: 'cc',       name: 'Alfalah CC',   icon: '💳', kind: 'liability' }
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

  function readAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      console.error('store: read failed, returning empty', e);
      return [];
    }
  }

  function writeAll(arr) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
      return { ok: true };
    } catch (e) {
      console.error('store: write failed', e);
      return { ok: false, error: e.name === 'QuotaExceededError'
        ? 'Storage full. Export old data first.'
        : 'Save failed: ' + e.message };
    }
  }

  function genId() {
    return 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  window.store = {
    accounts: ACCOUNTS,
    categories: CATEGORIES,

    addTransaction(input) {
      const amount = parseFloat(input.amount);
      if (isNaN(amount) || amount <= 0) return { ok: false, error: 'Amount must be greater than 0' };
      if (!input.accountId) return { ok: false, error: 'Pick an account' };
      if (!input.type) return { ok: false, error: 'Pick a type' };

      const accountExists = ACCOUNTS.find(a => a.id === input.accountId);
      if (!accountExists) return { ok: false, error: 'Unknown account' };

      const notes = (input.notes || '').slice(0, MAX_NOTES_LENGTH);

      const tx = {
        id: genId(),
        type: input.type,
        amount: amount,
        accountId: input.accountId,
        categoryId: input.categoryId || 'other',
        date: input.date || new Date().toISOString().slice(0, 10),
        notes: notes,
        createdAt: new Date().toISOString(),
        schema: 'v1'
      };

      const all = readAll();
      all.push(tx);
      const result = writeAll(all);
      if (!result.ok) return result;
      return { ok: true, id: tx.id };
    },

    getAll() {
      return readAll().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },

    getById(id) {
      return readAll().find(tx => tx.id === id) || null;
    },

    delete(id) {
      const filtered = readAll().filter(tx => tx.id !== id);
      return writeAll(filtered);
    },

    clear() {
      return writeAll([]);
    },

    getAccount(id) {
      return ACCOUNTS.find(a => a.id === id) || { name: 'Unknown', icon: '❓' };
    },

    getCategory(id) {
      return CATEGORIES.find(c => c.id === id) || { name: 'Other', icon: '✨' };
    }
  };
})();
