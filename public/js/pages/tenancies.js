import { apiRequest, ApiError } from '../api.js';
import { parseRupeesToPaise, formatPaise } from '../money.js';
import {
  setText,
  clearFieldErrors,
  setFieldError,
  setButtonLoading,
  showMessage,
  clearMessage,
} from '../ui.js';

const form = document.getElementById('create-tenancy-form');
const submitBtn = document.getElementById('submit-btn');
const logoutBtn = document.getElementById('logout-btn');
const tenanciesList = document.getElementById('tenancies-list');
const emptyState = document.getElementById('empty-state');
const loadingState = document.getElementById('loading-state');
const container = document.getElementById('tenancies-container');

async function loadTenancies() {
  try {
    const tenancies = await apiRequest('/api/tenancies');
    loadingState.style.display = 'none';
    container.style.display = 'block';

    tenanciesList.textContent = '';

    if (!tenancies || tenancies.length === 0) {
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    for (const t of tenancies) {
      const card = document.createElement('div');
      card.className = 'tenancy-card card';
      card.style.border = '1px solid var(--border-color)';
      card.style.borderRadius = '6px';
      card.style.padding = '1.25rem';
      card.style.marginBottom = '1rem';

      const titleLink = document.createElement('a');
      titleLink.href = `/tenancy.html?id=${encodeURIComponent(t.id)}`;
      titleLink.style.fontSize = '1.15rem';
      titleLink.style.fontWeight = '600';
      titleLink.textContent = t.property_label;

      const meta = document.createElement('p');
      meta.style.margin = '0.5rem 0';
      meta.style.fontSize = '0.95rem';
      meta.textContent = `Deposit: ${formatPaise(t.deposit_paise)} • Status: ${t.status.toUpperCase()}`;

      if (t.address) {
        const addr = document.createElement('p');
        addr.style.margin = '0.25rem 0';
        addr.style.fontSize = '0.9rem';
        addr.style.color = 'var(--text-muted)';
        addr.textContent = `Address: ${t.address}`;
        card.appendChild(addr);
      }

      const actions = document.createElement('div');
      actions.style.marginTop = '0.75rem';
      const viewLink = document.createElement('a');
      viewLink.href = `/tenancy.html?id=${encodeURIComponent(t.id)}`;
      viewLink.textContent = 'View record & timeline →';
      actions.appendChild(viewLink);

      card.prepend(titleLink);
      card.appendChild(meta);
      card.appendChild(actions);

      tenanciesList.appendChild(card);
    }
  } catch (err) {
    loadingState.style.display = 'none';
    showMessage('general-error', err.message || 'Failed to load tenancies');
  }
}

async function init() {
  try {
    const user = await apiRequest('/api/me');
    setText('user-greeting', `Signed in as ${user.name}`);
    await loadTenancies();
  } catch {
    window.location.href = '/login.html';
  }
}

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login.html';
    }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessage('general-error');
  clearFieldErrors(form);

  const propertyLabel = document.getElementById('propertyLabel').value;
  const address = document.getElementById('address').value;
  const landlordName = document.getElementById('landlordName').value;
  const depositRupeesRaw = document.getElementById('depositRupees').value;
  const refundWindowRaw = document.getElementById('refundWindowDays').value;
  const leaseStartDateRaw = document.getElementById('leaseStartDate').value;

  let depositPaise;
  try {
    depositPaise = parseRupeesToPaise(depositRupeesRaw);
  } catch (err) {
    setFieldError('depositRupees', err.message);
    return;
  }

  let refundWindowDays = null;
  if (refundWindowRaw && refundWindowRaw.trim() !== '') {
    const parsedDays = Number(refundWindowRaw.trim());
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365) {
      setFieldError(
        'refundWindowDays',
        'Refund window must be an integer between 1 and 365 days'
      );
      return;
    }
    refundWindowDays = parsedDays;
  }

  const payload = {
    propertyLabel,
    address: address.trim() || null,
    landlordName: landlordName.trim() || null,
    depositPaise,
    refundWindowDays,
    leaseStartDate: leaseStartDateRaw.trim() || null,
  };

  setButtonLoading(submitBtn, true, 'Creating...');

  try {
    const created = await apiRequest('/api/tenancies', {
      method: 'POST',
      body: payload,
    });
    window.location.href = `/tenancy.html?id=${encodeURIComponent(created.id)}`;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      const fieldMap = {
        property_label: 'propertyLabel',
        deposit_paise: 'depositRupees',
        landlord_name: 'landlordName',
        refund_window_days: 'refundWindowDays',
        lease_start_date: 'leaseStartDate',
      };
      for (const [field, message] of Object.entries(err.details || {})) {
        const inputId = fieldMap[field] || field;
        setFieldError(inputId, message);
      }
    } else {
      showMessage('general-error', err.message || 'Failed to create tenancy');
    }
  } finally {
    setButtonLoading(submitBtn, false);
  }
});

init();
