import { apiRequest } from '../api.js';
import { formatPaise } from '../money.js';
import { setText, showMessage } from '../ui.js';

const urlParams = new URLSearchParams(window.location.search);
const tenancyId = urlParams.get('id');

const loadingState = document.getElementById('loading-state');
const content = document.getElementById('tenancy-content');
const timelineList = document.getElementById('timeline-list');
const emptyTimeline = document.getElementById('empty-timeline');

function renderEventItem(ev) {
  const item = document.createElement('div');
  item.className = 'timeline-item';
  item.style.marginBottom = '1.25rem';
  item.style.position = 'relative';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'baseline';
  header.style.gap = '0.5rem';
  header.style.flexWrap = 'wrap';

  const title = document.createElement('strong');
  title.style.fontSize = '0.95rem';
  title.textContent = ev.type.replace(/_/g, ' ').toUpperCase();

  const actor = document.createElement('span');
  actor.style.fontSize = '0.85rem';
  actor.style.color = 'var(--text-muted)';
  actor.textContent = `by ${ev.actor_label} (${ev.actor_type})`;

  const date = document.createElement('span');
  date.style.fontSize = '0.8rem';
  date.style.color = 'var(--text-muted)';
  date.textContent = new Date(ev.created_at).toLocaleString();

  header.appendChild(title);
  header.appendChild(actor);
  header.appendChild(date);
  item.appendChild(header);

  if (ev.payload && Object.keys(ev.payload).length > 0) {
    const details = document.createElement('p');
    details.style.margin = '0.25rem 0 0 0';
    details.style.fontSize = '0.875rem';
    details.style.color = 'var(--text-color)';

    const parts = [];
    if (ev.payload.depositPaise) {
      parts.push(`Deposit: ${formatPaise(ev.payload.depositPaise)}`);
    }
    if (ev.payload.propertyLabel) {
      parts.push(`Property: ${ev.payload.propertyLabel}`);
    }
    if (ev.payload.refundWindowDays) {
      parts.push(`Refund Window: ${ev.payload.refundWindowDays} days`);
    }
    if (ev.payload.leaseStartDate) {
      parts.push(`Lease Start: ${ev.payload.leaseStartDate}`);
    }
    details.textContent = parts.join(' • ');
    item.appendChild(details);
  }

  return item;
}

async function loadTenancy() {
  if (!tenancyId) {
    window.location.href = '/tenancies.html';
    return;
  }

  try {
    const [tenancy, events] = await Promise.all([
      apiRequest(`/api/tenancies/${encodeURIComponent(tenancyId)}`),
      apiRequest(`/api/tenancies/${encodeURIComponent(tenancyId)}/events`),
    ]);

    loadingState.style.display = 'none';
    content.style.display = 'block';

    setText('property-label', tenancy.property_label);
    setText('tenancy-status', tenancy.status.toUpperCase());
    setText('deposit-amount', formatPaise(tenancy.deposit_paise));

    if (tenancy.address) {
      setText('address-val', tenancy.address);
      const row = document.getElementById('address-row');
      if (row) row.style.display = 'block';
    }

    if (tenancy.landlord_name) {
      setText('landlord-val', tenancy.landlord_name);
      const row = document.getElementById('landlord-row');
      if (row) row.style.display = 'block';
    }

    if (tenancy.refund_window_days) {
      setText('refund-val', `${tenancy.refund_window_days} days`);
      const row = document.getElementById('refund-row');
      if (row) row.style.display = 'block';
    }

    if (tenancy.lease_start_date) {
      setText('lease-val', tenancy.lease_start_date);
      const row = document.getElementById('lease-row');
      if (row) row.style.display = 'block';
    }

    // Inspections
    const moveInAction = document.getElementById('move-in-action');
    if (tenancy.inspections && tenancy.inspections.moveIn) {
      setText(
        'move-in-status',
        tenancy.inspections.moveIn.status.toUpperCase()
      );
      if (moveInAction) {
        moveInAction.textContent = '';
        const link = document.createElement('a');
        link.href = `/inspection.html?id=${encodeURIComponent(tenancy.inspections.moveIn.id)}`;
        link.textContent =
          tenancy.inspections.moveIn.status === 'draft'
            ? 'Open editor →'
            : 'View inspection →';
        moveInAction.appendChild(link);
      }
    } else {
      setText('move-in-status', 'NOT STARTED');
    }

    const moveOutAction = document.getElementById('move-out-action');
    if (tenancy.inspections && tenancy.inspections.moveOut) {
      setText(
        'move-out-status',
        tenancy.inspections.moveOut.status.toUpperCase()
      );
      if (moveOutAction) {
        moveOutAction.textContent = '';
        const link = document.createElement('a');
        link.href = `/inspection.html?id=${encodeURIComponent(tenancy.inspections.moveOut.id)}`;
        link.textContent =
          tenancy.inspections.moveOut.status === 'draft'
            ? 'Open editor →'
            : 'View inspection →';
        moveOutAction.appendChild(link);
      }
    } else {
      setText('move-out-status', 'NOT STARTED');
      if (moveOutAction) {
        moveOutAction.textContent = '';
        const p = document.createElement('p');
        p.style.fontSize = '0.875rem';
        p.style.color = 'var(--text-muted)';
        p.textContent = 'Move-out comparison arrives in Phase 7.';
        moveOutAction.appendChild(p);
      }
    }

    // Timeline events
    timelineList.textContent = '';
    if (!events || events.length === 0) {
      emptyTimeline.style.display = 'block';
    } else {
      emptyTimeline.style.display = 'none';
      for (const ev of events) {
        timelineList.appendChild(renderEventItem(ev));
      }
    }
  } catch (err) {
    loadingState.style.display = 'none';
    showMessage(
      'general-error',
      err.message || 'Tenancy not found or could not be loaded.'
    );
  }
}

async function init() {
  try {
    await apiRequest('/api/me');
    await loadTenancy();
  } catch {
    window.location.href = '/login.html';
  }
}

init();
