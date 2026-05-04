/* ─── Sovereign Finance · Add Transaction Form v0.3.0 · Sub-1D-TXFER-POLISH ───
 * Honors URL query params from CC planner Pay buttons (and any future deep-link).
 *
 * URL contract (matches cc.js v0.1.0 generation):
 *   /add.html?type=transfer&amount=N&from=ACCT&to=ACCT&notes=ENCODED
 *   Supported: type ∈ {expense, income, transfer}, amount, from, to, notes
 *
 * Design notes:
 *   - URL consumption is IDEMPOTENT (guards on each field) — safe to call multiple times
 *   - Re-fires after refreshBalances completes (in case URL `from` only matches D1 ids,
 *     not FALLBACK_ACCOUNTS)
 *   - Re-fires after populateTransferToDropdown (so URL `to` lands once dest dropdown is ready)
 *   - Validates URL values against whitelist (type) and current dropdown options (from/to)
 *   - Shows a subtle "Prefilled from X — verify before saving" banner so operator knows
 *     the form was auto-populated
 *   - Defensive: bad URL values (typos, stale ids) are silently dropped, console.warn logged
 *
 * Changes vs v0.2.0:
 *   - NEW applyURLParams() → reads query string into _pendingURLParams
 *   - NEW consumeURLParams() → idempotent setter, called from init + after async refreshes
 *   - NEW showPrefillBanner() → subtle visual cue
 *   - populateAccountDropdown re-fires consume after API refresh
 *   - populateTransferToDropdown re-fires consume (so dest URL param lands)
 *
 * PRESERVED from v0.2.0:
 *   All transfer flow logic, type toggle, source-change handler, dual validation,
 *   defensive null checks for v0.6.0 HTML scaffold, console-log instrumentation.
 */

(function () {
  document.addEventListener('DOMContentLoaded', initAddForm);

  let selectedType = 'expense';
  let _pendingURLParams = null;

  function localToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function initAddForm() {
    populateAccountDropdown();
    populateCategoryDropdown();
    setDateToToday();
    attachTypeToggle();
    attachAmountValidation();
    attachSourceChangeHandler();
    attachSubmitHandler();
    attachDefensiveRefocus();
    applyTypeMode(selectedType);
    applyURLParams();
    console.log('[add v0.3.0] init complete · selectedType=', selectedType);
  }

  function buildAccountOptions(sel, excludeId) {
    sel.innerHTML = '<option value="">Pick account…</option>';
    (window.store.accounts || []).forEach(a => {
      if (excludeId && a.id === excludeId) return;
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = (a.icon || '🏦') + '  ' + a.name;
      sel.appendChild(opt);
    });
  }

  function populateAccountDropdown() {
    const sel = document.getElementById('accountSelect');
    if (!sel) return;
    buildAccountOptions(sel);
    sel.addEventListener('change', updateSubmitState);
    console.log('[add] populated', sel.options.length - 1, 'accounts (first pass)');

    if (window.store && typeof window.store.refreshBalances === 'function') {
      window.store.refreshBalances().then(() => {
        const current = sel.value;
        buildAccountOptions(sel);
        sel.value = current;
        if (selectedType === 'transfer') populateTransferToDropdown();
        console.log('[add] re-populated', sel.options.length - 1, 'accounts (after API)');
        consumeURLParams(); // retry any deferred URL params now that real accounts loaded
      }).catch(err => {
        console.warn('[add] refreshBalances failed:', err.message);
      });
    }
  }

  function populateTransferToDropdown() {
    const sel = document.getElementById('transferToSelect');
    if (!sel) return;
    const sourceId = (document.getElementById('accountSelect') || {}).value || '';
    const current = sel.value;
    buildAccountOptions(sel, sourceId);
    if (current && current !== sourceId) sel.value = current;
    console.log('[add] populated', sel.options.length - 1, 'destination accounts (excluding', sourceId || 'none', ')');
    consumeURLParams(); // retry deferred URL params (esp. transfer dest)
  }

  function populateCategoryDropdown() {
    const sel = document.getElementById('categorySelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">Pick category…</option>';
    (window.store.categories || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = (c.icon || '📝') + '  ' + c.name;
      sel.appendChild(opt);
    });
    console.log('[add] populated', sel.options.length - 1, 'categories');
  }

  function attachDefensiveRefocus() {
    const accSel = document.getElementById('accountSelect');
    const catSel = document.getElementById('categorySelect');
    const toSel = document.getElementById('transferToSelect');
    if (accSel) {
      accSel.addEventListener('focus', () => {
        if (accSel.options.length < 2) populateAccountDropdown();
      });
    }
    if (catSel) {
      catSel.addEventListener('focus', () => {
        if (catSel.options.length < 2) populateCategoryDropdown();
      });
    }
    if (toSel) {
      toSel.addEventListener('focus', () => {
        if (toSel.options.length < 2) populateTransferToDropdown();
      });
      toSel.addEventListener('change', updateSubmitState);
    }
  }

  function attachSourceChangeHandler() {
    const accSel = document.getElementById('accountSelect');
    if (!accSel) return;
    accSel.addEventListener('change', () => {
      if (selectedType === 'transfer') populateTransferToDropdown();
    });
  }

  function setDateToToday() {
    const dateEl = document.getElementById('dateInput');
    if (!dateEl) return;
    dateEl.value = localToday();
  }

  function attachTypeToggle() {
    document.querySelectorAll('.type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedType = btn.dataset.type;
        applyTypeMode(selectedType);
        updateSubmitState();
      });
    });
  }

  function applyTypeMode(type) {
    const transferWrap = document.getElementById('transferToWrap');
    const categoryWrap = document.getElementById('categoryWrap');
    const fromLabel    = document.getElementById('accountFromLabel');
    const isTransfer   = type === 'transfer';

    if (transferWrap) transferWrap.hidden = !isTransfer;
    if (categoryWrap) categoryWrap.hidden = isTransfer;
    if (fromLabel)    fromLabel.textContent = isTransfer ? 'From Account' : 'Account';

    if (isTransfer) populateTransferToDropdown();
  }

  function attachAmountValidation() {
    const amt = document.getElementById('amountInput');
    if (amt) amt.addEventListener('input', updateSubmitState);
  }

  function updateSubmitState() {
    const amount  = parseFloat(document.getElementById('amountInput').value);
    const account = document.getElementById('accountSelect').value;
    const btn     = document.getElementById('submitBtn');
    let ok = (amount > 0 && !!account);
    if (selectedType === 'transfer') {
      const destSel = document.getElementById('transferToSelect');
      const dest = destSel ? destSel.value : '';
      ok = ok && !!dest && dest !== account;
    }
    btn.disabled = !ok;
  }

  /* ─── URL Param Prefill (Sub-1D-TXFER-POLISH) ─── */

  function applyURLParams() {
    const params = new URLSearchParams(window.location.search);
    if (!params.toString()) return;

    _pendingURLParams = {
      type:   params.get('type'),
      amount: params.get('amount'),
      from:   params.get('from'),
      to:     params.get('to'),
      notes:  params.get('notes')
    };

    // Visual cue so operator knows the form was auto-populated
    const source = (_pendingURLParams.notes && _pendingURLParams.notes.toLowerCase().includes('cc paydown'))
      ? 'CC Planner'
      : 'link';
    showPrefillBanner(source);

    consumeURLParams();
  }

  function consumeURLParams() {
    if (!_pendingURLParams) return;
    const p = _pendingURLParams;

    // 1. Type — apply once if valid and different from current
    const validTypes = ['expense', 'income', 'transfer'];
    if (p.type && validTypes.includes(p.type) && selectedType !== p.type) {
      const btn = document.querySelector('.type-btn[data-type="' + p.type + '"]');
      if (btn) btn.click(); // triggers attachTypeToggle handler → applyTypeMode
    }

    // 2. Amount — apply once if input still empty
    if (p.amount && !isNaN(parseFloat(p.amount))) {
      const amtInput = document.getElementById('amountInput');
      if (amtInput && !amtInput.value) {
        amtInput.value = parseFloat(p.amount);
      }
    }

    // 3. From — only if option exists and different from current
    let fromConsumed = !p.from;
    if (p.from) {
      const accSel = document.getElementById('accountSelect');
      if (accSel) {
        const hasOption = [...accSel.options].some(o => o.value === p.from);
        if (hasOption) {
          if (accSel.value !== p.from) {
            accSel.value = p.from;
            accSel.dispatchEvent(new Event('change'));
          }
          fromConsumed = true;
        }
      }
    }

    // 4. To — only meaningful in transfer mode
    let toConsumed = !p.to;
    if (p.to && selectedType === 'transfer') {
      const toSel = document.getElementById('transferToSelect');
      if (toSel) {
        const hasOption = [...toSel.options].some(o => o.value === p.to);
        if (hasOption) {
          if (toSel.value !== p.to) toSel.value = p.to;
          toConsumed = true;
        }
      }
    } else if (p.to && selectedType !== 'transfer') {
      // Non-transfer with a `to` param — silently ignore (param doesn't apply)
      toConsumed = true;
    }

    // 5. Notes — apply once if input still empty
    if (p.notes) {
      const notesInput = document.getElementById('notesInput');
      if (notesInput && !notesInput.value) {
        notesInput.value = p.notes.slice(0, 200);
      }
    }

    updateSubmitState();

    if (fromConsumed && toConsumed) {
      console.log('[add v0.3.0] URL params fully consumed:', p);
      _pendingURLParams = null;
    } else {
      console.log('[add v0.3.0] URL params partially consumed (from:', fromConsumed, 'to:', toConsumed, ') — will retry on next refresh');
    }
  }

  function showPrefillBanner(source) {
    const form = document.getElementById('addForm');
    if (!form) return;
    const existing = document.querySelector('.prefill-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.className = 'prefill-banner';
    banner.style.cssText = 'background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);color:var(--accent,#22c55e);padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;text-align:center';
    banner.textContent = '✨ Prefilled from ' + source + ' — verify before saving';
    form.insertBefore(banner, form.firstChild);
  }

  /* ─── Submit ─── */

  function attachSubmitHandler() {
    const form = document.getElementById('addForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Saving…';

      const sourceId = document.getElementById('accountSelect').value;
      const data = {
        type:       selectedType,
        amount:     document.getElementById('amountInput').value,
        accountId:  sourceId,
        categoryId: document.getElementById('categorySelect').value,
        date:       document.getElementById('dateInput').value || localToday(),
        notes:      document.getElementById('notesInput').value
      };

      if (selectedType === 'transfer') {
        const destSel = document.getElementById('transferToSelect');
        const destId = destSel ? destSel.value : '';
        if (!destId) {
          showToast('Pick a destination account for the transfer', 'error');
          btn.disabled = false;
          btn.textContent = 'Save Transaction';
          return;
        }
        if (destId === sourceId) {
          showToast('Source and destination cannot be the same', 'error');
          btn.disabled = false;
          btn.textContent = 'Save Transaction';
          return;
        }
        data.transferToAccountId = destId;
        data.categoryId = ''; // backend hardcodes 'transfer' for transfer rows
      }

      const result = await window.store.addTransaction(data);

      if (result.ok) {
        let msg;
        if (result.queued) msg = 'Queued (offline) ✓';
        else if (selectedType === 'transfer') msg = 'Transfer saved ✓';
        else msg = 'Saved to cloud ✓';
        showToast(msg, 'success');
        setTimeout(() => { window.location.href = '/transactions.html'; }, 700);
      } else {
        showToast(result.error || 'Save failed', 'error');
        btn.disabled = false;
        btn.textContent = 'Save Transaction';
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
