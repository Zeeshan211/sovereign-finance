/* ─── Sovereign Finance · Edit Transaction v0.2.0 ─── */

(function () {
  document.addEventListener('DOMContentLoaded', init);

  let txId = null;
  let selectedType = 'expense';

  async function init() {
    const params = new URLSearchParams(window.location.search);
    txId = params.get('id');
    if (!txId) {
      showToast('No transaction ID', 'error');
      return;
    }

    populateAccountDropdown();
    populateCategoryDropdown();
    attachTypeToggle();
    attachSubmitHandler();
    attachDeleteHandler();

    await loadTransaction();
  }

  async function loadTransaction() {
    try {
      const res = await fetch('/api/transactions/' + encodeURIComponent(txId));
      const data = await res.json();
      if (!data.ok) {
        showToast(data.error || 'Could not load', 'error');
        return;
      }
      const tx = data.transaction;

      document.getElementById('edit-id-badge').textContent = 'ID ' + tx.id.slice(-6);
      document.getElementById('amountInput').value = tx.amount;
      document.getElementById('accountSelect').value = tx.account_id;
      document.getElementById('categorySelect').value = tx.category_id || 'other';
      document.getElementById('dateInput').value = tx.date;
      document.getElementById('notesInput').value = tx.notes || '';

      selectedType = tx.type;
      document.querySelectorAll('.type-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.type === tx.type);
      });
    } catch (e) {
      showToast('Network error', 'error');
    }
  }

  function populateAccountDropdown() {
    const sel = document.getElementById('accountSelect');
    sel.innerHTML = '<option value="">Pick account…</option>';
    window.store.accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.icon + '  ' + a.name;
      sel.appendChild(opt);
    });
  }

  function populateCategoryDropdown() {
    const sel = document.getElementById('categorySelect');
    window.store.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.icon + '  ' + c.name;
      sel.appendChild(opt);
    });
  }

  function attachTypeToggle() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedType = btn.dataset.type;
      });
    });
  }

  function attachSubmitHandler() {
    document.getElementById('editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      const payload = {
        type: selectedType,
        amount: document.getElementById('amountInput').value,
        account_id: document.getElementById('accountSelect').value,
        category_id: document.getElementById('categorySelect').value,
        date: document.getElementById('dateInput').value,
        notes: document.getElementById('notesInput').value
      };

      try {
        const res = await fetch('/api/transactions/' + encodeURIComponent(txId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          await Promise.all([window.store.refreshTransactions(), window.store.refreshBalances()]);
          showToast('Updated ✓', 'success');
          setTimeout(() => { window.location.href = '/transactions.html'; }, 700);
        } else {
          showToast(data.error || 'Update failed', 'error');
          btn.disabled = false;
          btn.textContent = 'Update Transaction';
        }
      } catch (e) {
        showToast('Network error', 'error');
        btn.disabled = false;
        btn.textContent = 'Update Transaction';
      }
    });
  }

  function attachDeleteHandler() {
    document.getElementById('deleteBtn').addEventListener('click', async () => {
      if (!confirm('Delete this transaction permanently?')) return;
      const btn = document.getElementById('deleteBtn');
      btn.disabled = true;
      btn.textContent = 'Deleting…';

      try {
        const res = await fetch('/api/transactions/' + encodeURIComponent(txId), {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.ok) {
          await Promise.all([window.store.refreshTransactions(), window.store.refreshBalances()]);
          showToast('Deleted ✓', 'success');
          setTimeout(() => { window.location.href = '/transactions.html'; }, 700);
        } else {
          showToast(data.error || 'Delete failed', 'error');
          btn.disabled = false;
          btn.textContent = 'Delete Transaction';
        }
      } catch (e) {
        showToast('Network error', 'error');
        btn.disabled = false;
        btn.textContent = 'Delete Transaction';
      }
    });
  }

  function showToast(msg, kind) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (kind || 'info');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2200);
  }
})();
