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
    if (ev.type === 'inspection_submitted') {
      parts.push(
        `${ev.payload.itemCount || 0} items, ${ev.payload.photoCount || 0} photos`
      );
      if (ev.payload.itemsWithoutPhotos > 0) {
        parts.push(`${ev.payload.itemsWithoutPhotos} without photos`);
      }
    }
    if (ev.type === 'changes_requested' && ev.payload.note) {
      parts.push(`"${ev.payload.note}"`);
    }
    if (ev.type === 'inspection_acknowledged') {
      parts.push('Inspection acknowledged and locked');
    }
    if (ev.type === 'move_out_started') {
      parts.push(
        `Move-out inspection started (${ev.payload.itemCount || 0} items cloned)`
      );
    }
    if (ev.type === 'invite_created' && ev.payload.expiresAt) {
      parts.push(
        `Active until ${new Date(ev.payload.expiresAt).toLocaleDateString()}`
      );
    }
    if (ev.type === 'invite_revoked') {
      parts.push('Link revoked');
    }
    if (ev.type === 'deduction_proposed' && ev.payload.amountPaise) {
      parts.push(`Proposed deduction: ${formatPaise(ev.payload.amountPaise)}`);
    }
    if (ev.type === 'deduction_accepted') {
      parts.push(
        ev.payload.note
          ? `Deduction accepted: "${ev.payload.note}"`
          : 'Deduction accepted'
      );
    }
    if (ev.type === 'deduction_disputed') {
      parts.push(`Deduction disputed: "${ev.payload.note}"`);
    }
    if (ev.type === 'deduction_withdrawn') {
      parts.push('Deduction withdrawn');
    }
    if (ev.type === 'tenancy_closed') {
      const closeParts = [
        `Accepted: ${formatPaise(ev.payload.acceptedPaise || 0)}`,
        `Unclaimed: ${formatPaise(ev.payload.unclaimedPaise || 0)}`,
      ];
      if (ev.payload.unresolvedAcknowledged) {
        closeParts.push('unresolved acknowledged');
      }
      parts.push(`Tenancy closed (${closeParts.join(', ')})`);
    }
    details.textContent = parts.join(' • ');
    item.appendChild(details);
  }

  return item;
}

function setupInspectionCard(cardActionEl, inspection, tenancyId, reloadFn) {
  if (!cardActionEl) return;
  cardActionEl.textContent = '';

  if (!inspection) return;

  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.gap = '0.75rem';
  container.style.alignItems = 'center';
  container.style.flexWrap = 'wrap';

  const link = document.createElement('a');
  link.href = `/inspection.html?id=${encodeURIComponent(inspection.id)}`;
  link.textContent =
    inspection.status === 'draft' ? 'Open editor →' : 'View inspection →';
  link.className = 'btn btn-secondary';
  link.style.width = 'auto';
  link.style.textDecoration = 'none';
  container.appendChild(link);

  if (inspection.status === 'draft') {
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn';
    submitBtn.style.width = 'auto';
    submitBtn.textContent = 'Submit for review';

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      try {
        const insp = await apiRequest(
          `/api/inspections/${encodeURIComponent(inspection.id)}`
        );
        const items = insp.items || [];
        if (items.length === 0) {
          alert(
            'Cannot submit: inspection has no items. Add items in the editor first.'
          );
          submitBtn.disabled = false;
          return;
        }

        const missingCondition = items.filter((it) => !it.condition);
        if (missingCondition.length > 0) {
          alert(
            `Cannot submit: ${missingCondition.length} item(s) are missing a condition in the editor.`
          );
          submitBtn.disabled = false;
          return;
        }

        const itemsWithoutPhotos = items.filter(
          (it) => !it.media || it.media.length === 0
        ).length;
        const msg =
          itemsWithoutPhotos > 0
            ? `Submit inspection for landlord review? ${itemsWithoutPhotos} item(s) have no photo.`
            : 'Submit inspection for landlord review?';

        if (!confirm(msg)) {
          submitBtn.disabled = false;
          return;
        }

        await apiRequest(
          `/api/inspections/${encodeURIComponent(inspection.id)}/submit`,
          { method: 'POST' }
        );
        await reloadFn();
      } catch (err) {
        alert(err.message || 'Failed to submit inspection');
      } finally {
        submitBtn.disabled = false;
      }
    });

    container.appendChild(submitBtn);
  }

  cardActionEl.appendChild(container);
}

function setupMoveOutCard(cardActionEl, moveOut, moveIn, tenancyId, reloadFn) {
  if (!cardActionEl) return;
  cardActionEl.textContent = '';

  // 1. Move-in must be submitted or acknowledged before move-out can start
  if (
    !moveIn ||
    (moveIn.status !== 'submitted' && moveIn.status !== 'acknowledged')
  ) {
    const p = document.createElement('p');
    p.style.fontSize = '0.875rem';
    p.style.color = 'var(--text-muted)';
    p.textContent =
      'Move-in inspection must be submitted and reviewed before starting move-out.';
    cardActionEl.appendChild(p);
    return;
  }

  // 2. Ready to start move-out inspection
  if (!moveOut) {
    const startBtn = document.createElement('button');
    startBtn.id = 'start-move-out-btn';
    startBtn.type = 'button';
    startBtn.className = 'btn btn-primary';
    startBtn.style.width = 'auto';
    startBtn.textContent = 'Start Move-out Inspection';

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await apiRequest(
          `/api/tenancies/${encodeURIComponent(tenancyId)}/move-out`,
          {
            method: 'POST',
          }
        );
        await reloadFn();
      } catch (err) {
        alert(err.message || 'Failed to start move-out inspection');
        startBtn.disabled = false;
      }
    });

    cardActionEl.appendChild(startBtn);
    return;
  }

  // 3. Move-out exists
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.gap = '0.75rem';
  container.style.alignItems = 'center';
  container.style.flexWrap = 'wrap';

  const link = document.createElement('a');
  link.href = `/inspection.html?id=${encodeURIComponent(moveOut.id)}`;
  link.textContent =
    moveOut.status === 'draft' ? 'Open editor →' : 'View inspection →';
  link.className = 'btn btn-secondary';
  link.style.width = 'auto';
  link.style.textDecoration = 'none';
  container.appendChild(link);

  if (moveOut.status === 'draft') {
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'btn';
    submitBtn.style.width = 'auto';
    submitBtn.textContent = 'Submit for review';

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      try {
        const insp = await apiRequest(
          `/api/inspections/${encodeURIComponent(moveOut.id)}`
        );
        const items = insp.items || [];
        if (items.length === 0) {
          alert(
            'Cannot submit: inspection has no items. Add items in the editor first.'
          );
          submitBtn.disabled = false;
          return;
        }

        const missingCondition = items.filter((it) => !it.condition);
        if (missingCondition.length > 0) {
          alert(
            `Cannot submit: ${missingCondition.length} item(s) are missing a condition in the editor.`
          );
          submitBtn.disabled = false;
          return;
        }

        const itemsWithoutPhotos = items.filter(
          (it) => !it.media || it.media.length === 0
        ).length;
        const msg =
          itemsWithoutPhotos > 0
            ? `Submit move-out inspection for landlord review? ${itemsWithoutPhotos} item(s) have no photo.`
            : 'Submit move-out inspection for landlord review?';

        if (!confirm(msg)) {
          submitBtn.disabled = false;
          return;
        }

        await apiRequest(
          `/api/inspections/${encodeURIComponent(moveOut.id)}/submit`,
          { method: 'POST' }
        );
        await reloadFn();
      } catch (err) {
        alert(err.message || 'Failed to submit move-out inspection');
      } finally {
        submitBtn.disabled = false;
      }
    });

    container.appendChild(submitBtn);
  } else if (
    moveOut.status === 'submitted' ||
    moveOut.status === 'acknowledged'
  ) {
    const compareLink = document.createElement('a');
    compareLink.id = 'view-comparison-btn';
    compareLink.href = `/compare.html?id=${encodeURIComponent(tenancyId)}`;
    compareLink.textContent = 'View Comparison →';
    compareLink.className = 'btn btn-primary';
    compareLink.style.width = 'auto';
    compareLink.style.textDecoration = 'none';
    container.appendChild(compareLink);
  }

  cardActionEl.appendChild(container);
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
      setupInspectionCard(
        moveInAction,
        tenancy.inspections.moveIn,
        tenancyId,
        loadTenancy
      );
    } else {
      setText('move-in-status', 'NOT STARTED');
    }

    const moveOutAction = document.getElementById('move-out-action');
    if (tenancy.inspections && tenancy.inspections.moveOut) {
      setText(
        'move-out-status',
        tenancy.inspections.moveOut.status.toUpperCase()
      );
      setupMoveOutCard(
        moveOutAction,
        tenancy.inspections.moveOut,
        tenancy.inspections?.moveIn,
        tenancyId,
        loadTenancy
      );
    } else {
      setText('move-out-status', 'NOT STARTED');
      setupMoveOutCard(
        moveOutAction,
        null,
        tenancy.inspections?.moveIn,
        tenancyId,
        loadTenancy
      );
    }

    // Settlement section link
    const settlementSection = document.getElementById('settlement-section');
    const settlementLink = document.getElementById('settlement-link');
    if (settlementSection && settlementLink) {
      if (tenancy.status === 'settling' || tenancy.status === 'closed') {
        settlementSection.style.display = 'block';
        settlementLink.href = `/settlement.html?id=${encodeURIComponent(tenancyId)}`;
      } else {
        settlementSection.style.display = 'none';
      }
    }

    // Share with landlord section
    const newLinkContainer = document.getElementById('new-link-container');
    const newLinkInput = document.getElementById('new-link-input');
    const newLinkExpiry = document.getElementById('new-link-expiry');
    const copyLinkBtn = document.getElementById('copy-link-btn');
    const createLinkBtn = document.getElementById('create-link-btn');
    const revokeLinkBtn = document.getElementById('revoke-link-btn');

    if (tenancy.invite && tenancy.invite.active) {
      const expDate = tenancy.invite.expiresAt
        ? new Date(tenancy.invite.expiresAt).toLocaleDateString()
        : 'unknown';
      const lastOpened = tenancy.invite.lastUsedAt
        ? new Date(tenancy.invite.lastUsedAt).toLocaleString()
        : 'never';
      setText(
        'share-status-text',
        `Link active until ${expDate}, last opened ${lastOpened}`
      );
      if (createLinkBtn) createLinkBtn.textContent = 'Replace Link';
      if (revokeLinkBtn) revokeLinkBtn.style.display = 'inline-block';
    } else {
      setText('share-status-text', 'No active link');
      if (createLinkBtn) createLinkBtn.textContent = 'Create Review Link';
      if (revokeLinkBtn) revokeLinkBtn.style.display = 'none';
    }

    if (createLinkBtn) {
      createLinkBtn.onclick = async () => {
        createLinkBtn.disabled = true;
        try {
          const res = await apiRequest(
            `/api/tenancies/${encodeURIComponent(tenancyId)}/invite`,
            { method: 'POST' }
          );
          if (newLinkInput && newLinkExpiry && newLinkContainer) {
            newLinkInput.value = res.url;
            newLinkExpiry.textContent = new Date(
              res.expiresAt
            ).toLocaleDateString();
            newLinkContainer.style.display = 'block';
          }
          await loadTenancy();
        } catch (err) {
          alert(err.message || 'Failed to create review link');
        } finally {
          createLinkBtn.disabled = false;
        }
      };
    }

    if (revokeLinkBtn) {
      revokeLinkBtn.onclick = async () => {
        if (
          !confirm(
            'Are you sure you want to revoke the review link? The landlord will no longer be able to access it.'
          )
        ) {
          return;
        }
        revokeLinkBtn.disabled = true;
        try {
          await apiRequest(
            `/api/tenancies/${encodeURIComponent(tenancyId)}/invite`,
            { method: 'DELETE' }
          );
          if (newLinkContainer) newLinkContainer.style.display = 'none';
          await loadTenancy();
        } catch (err) {
          alert(err.message || 'Failed to revoke review link');
        } finally {
          revokeLinkBtn.disabled = false;
        }
      };
    }

    if (copyLinkBtn && newLinkInput) {
      copyLinkBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(newLinkInput.value);
          copyLinkBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyLinkBtn.textContent = 'Copy';
          }, 2000);
        } catch {
          newLinkInput.select();
          document.execCommand('copy');
          copyLinkBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyLinkBtn.textContent = 'Copy';
          }, 2000);
        }
      };
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
