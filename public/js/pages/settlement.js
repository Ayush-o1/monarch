import { apiRequest } from '../api.js';
import { formatPaise } from '../money.js';
import { setText } from '../ui.js';

const urlParams = new URLSearchParams(window.location.search);
const tenancyId = urlParams.get('id');

const loadingState = document.getElementById('loading-state');
const generalError = document.getElementById('general-error');
const content = document.getElementById('settlement-content');
const backLink = document.getElementById('back-link');
const linesContainer = document.getElementById('lines-container');
const emptyLines = document.getElementById('empty-lines');
const closeSection = document.getElementById('close-section');
const openCloseModalBtn = document.getElementById('open-close-modal-btn');
const closeModal = document.getElementById('close-modal');
const closeModalDesc = document.getElementById('close-modal-desc');
const unresolvedAckGroup = document.getElementById('unresolved-ack-group');
const unresolvedCheckbox = document.getElementById('unresolved-checkbox');
const unresolvedCheckboxLabel = document.getElementById(
  'unresolved-checkbox-label'
);
const closeModalError = document.getElementById('close-modal-error');
const cancelCloseBtn = document.getElementById('cancel-close-btn');
const confirmCloseBtn = document.getElementById('confirm-close-btn');
const lightboxModal = document.getElementById('lightbox-modal');
const lightboxImg = document.getElementById('lightbox-img');

if (backLink && tenancyId) {
  backLink.href = `/tenancy.html?id=${encodeURIComponent(tenancyId)}`;
}

if (lightboxModal) {
  lightboxModal.addEventListener('click', () => {
    lightboxModal.classList.remove('active');
    lightboxImg.src = '';
  });
}

function openLightbox(mediaUrl) {
  if (lightboxModal && lightboxImg) {
    lightboxImg.src = mediaUrl;
    lightboxModal.classList.add('active');
  }
}

function getLinkedChangeBadge(linkedChange) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.marginLeft = '0.5rem';

  switch (linkedChange) {
    case 'worse':
      badge.className += ' badge-worse';
      badge.textContent = 'Condition worse at move-out';
      break;
    case 'new_at_move_out':
      badge.className += ' badge-new';
      badge.textContent = 'New item at move-out';
      break;
    case 'same':
      badge.className += ' badge-same';
      badge.textContent = 'No change recorded';
      break;
    case 'better':
      badge.className += ' badge-better';
      badge.textContent = 'Better at move-out';
      break;
    case 'not_linked':
    default:
      badge.style.background = '#f3f4f6';
      badge.style.color = '#4b5563';
      badge.textContent = 'Not linked to an item';
      break;
  }
  return badge;
}

function getStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.padding = '0.2rem 0.5rem';
  badge.style.borderRadius = '4px';
  badge.style.fontSize = '0.8rem';
  badge.style.fontWeight = '600';

  switch (status) {
    case 'proposed':
      badge.style.background = '#fef3c7';
      badge.style.color = '#92400e';
      badge.textContent = 'Awaiting response';
      break;
    case 'accepted':
      badge.style.background = '#dcfce7';
      badge.style.color = '#166534';
      badge.textContent = 'Accepted';
      break;
    case 'disputed':
      badge.style.background = '#fee2e2';
      badge.style.color = '#991b1b';
      badge.textContent = 'Disputed';
      break;
    case 'withdrawn':
      badge.style.background = '#f3f4f6';
      badge.style.color = '#6b7280';
      badge.textContent = 'Withdrawn';
      break;
    default:
      badge.style.background = '#e5e7eb';
      badge.style.color = '#374151';
      badge.textContent = status;
      break;
  }
  return badge;
}

function renderDeductionLine(line, tenancyStatus, reloadFn) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '1rem';
  card.style.padding = '1.25rem';
  card.style.border = '1px solid var(--border-color)';
  card.style.borderRadius = '6px';
  card.style.background = line.status === 'withdrawn' ? '#fafafa' : '#ffffff';

  // Header row: description, amount, status
  const topRow = document.createElement('div');
  topRow.style.display = 'flex';
  topRow.style.justifyContent = 'space-between';
  topRow.style.alignItems = 'flex-start';
  topRow.style.flexWrap = 'wrap';
  topRow.style.gap = '0.75rem';
  topRow.style.marginBottom = '0.5rem';

  const leftTop = document.createElement('div');
  const descEl = document.createElement('strong');
  descEl.style.fontSize = '1.05rem';
  descEl.textContent = line.description;
  leftTop.appendChild(descEl);

  const rightTop = document.createElement('div');
  rightTop.style.display = 'flex';
  rightTop.style.alignItems = 'center';
  rightTop.style.gap = '0.75rem';

  const amtEl = document.createElement('span');
  amtEl.style.fontSize = '1.15rem';
  amtEl.style.fontWeight = '600';
  amtEl.textContent = formatPaise(line.amountPaise);

  rightTop.appendChild(amtEl);
  rightTop.appendChild(getStatusBadge(line.status));

  topRow.appendChild(leftTop);
  topRow.appendChild(rightTop);
  card.appendChild(topRow);

  // Meta row: linked item + change badge, created by, date
  const metaRow = document.createElement('div');
  metaRow.style.fontSize = '0.875rem';
  metaRow.style.color = 'var(--text-muted)';
  metaRow.style.marginBottom = '0.75rem';
  metaRow.style.display = 'flex';
  metaRow.style.alignItems = 'center';
  metaRow.style.flexWrap = 'wrap';
  metaRow.style.gap = '0.5rem';

  const creatorSpan = document.createElement('span');
  const createdDate = new Date(line.createdAt).toLocaleDateString();
  creatorSpan.textContent = `Proposed by ${line.createdByName} on ${createdDate}`;
  metaRow.appendChild(creatorSpan);

  if (line.itemId && line.itemName) {
    const itemSpan = document.createElement('span');
    itemSpan.textContent = `• Linked item: ${line.itemRoom} - ${line.itemName}`;
    metaRow.appendChild(itemSpan);
  }

  metaRow.appendChild(getLinkedChangeBadge(line.linkedChange));
  card.appendChild(metaRow);

  // Photos (thumbnails for moveIn and moveOut if available)
  const hasMoveInPhotos = line.photos?.moveIn?.length > 0;
  const hasMoveOutPhotos = line.photos?.moveOut?.length > 0;
  if (hasMoveInPhotos || hasMoveOutPhotos) {
    const photosContainer = document.createElement('div');
    photosContainer.style.display = 'flex';
    photosContainer.style.gap = '1rem';
    photosContainer.style.marginBottom = '0.75rem';
    photosContainer.style.flexWrap = 'wrap';

    if (hasMoveInPhotos) {
      const inBox = document.createElement('div');
      const inLabel = document.createElement('p');
      inLabel.style.fontSize = '0.75rem';
      inLabel.style.color = 'var(--text-muted)';
      inLabel.style.margin = '0 0 0.25rem 0';
      inLabel.textContent = 'Move-in Photo:';
      inBox.appendChild(inLabel);

      const inMediaId = line.photos.moveIn[0];
      const img = document.createElement('img');
      img.src = `/api/media/${encodeURIComponent(inMediaId)}/thumbnail`;
      img.alt = 'Move-in condition';
      img.style.width = '64px';
      img.style.height = '64px';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '4px';
      img.style.border = '1px solid var(--border-color)';
      img.style.cursor = 'pointer';
      img.addEventListener('click', () => {
        openLightbox(`/api/media/${encodeURIComponent(inMediaId)}/photo`);
      });
      inBox.appendChild(img);
      photosContainer.appendChild(inBox);
    }

    if (hasMoveOutPhotos) {
      const outBox = document.createElement('div');
      const outLabel = document.createElement('p');
      outLabel.style.fontSize = '0.75rem';
      outLabel.style.color = 'var(--text-muted)';
      outLabel.style.margin = '0 0 0.25rem 0';
      outLabel.textContent = 'Move-out Photo:';
      outBox.appendChild(outLabel);

      const outMediaId = line.photos.moveOut[0];
      const img = document.createElement('img');
      img.src = `/api/media/${encodeURIComponent(outMediaId)}/thumbnail`;
      img.alt = 'Move-out condition';
      img.style.width = '64px';
      img.style.height = '64px';
      img.style.objectFit = 'cover';
      img.style.borderRadius = '4px';
      img.style.border = '1px solid var(--border-color)';
      img.style.cursor = 'pointer';
      img.addEventListener('click', () => {
        openLightbox(`/api/media/${encodeURIComponent(outMediaId)}/photo`);
      });
      outBox.appendChild(img);
      photosContainer.appendChild(outBox);
    }

    card.appendChild(photosContainer);
  }

  // Tenant response note / date
  if (line.tenantNote) {
    const noteBox = document.createElement('div');
    noteBox.style.background = '#f9fafb';
    noteBox.style.borderLeft = '3px solid var(--border-color)';
    noteBox.style.padding = '0.5rem 0.75rem';
    noteBox.style.marginBottom = '0.75rem';
    noteBox.style.fontSize = '0.9rem';

    const noteText = document.createElement('p');
    noteText.style.margin = '0';
    noteText.textContent = `Tenant note: "${line.tenantNote}"`;
    noteBox.appendChild(noteText);

    if (line.respondedAt) {
      const respDate = document.createElement('p');
      respDate.style.margin = '0.25rem 0 0 0';
      respDate.style.fontSize = '0.75rem';
      respDate.style.color = 'var(--text-muted)';
      respDate.textContent = `Responded on ${new Date(line.respondedAt).toLocaleDateString()}`;
      noteBox.appendChild(respDate);
    }
    card.appendChild(noteBox);
  }

  // Action buttons (Accept & Dispute) - only while settling and status is proposed or disputed
  const isSettling = tenancyStatus === 'settling';
  const canRespond =
    isSettling && (line.status === 'proposed' || line.status === 'disputed');

  if (canRespond) {
    const actionsBox = document.createElement('div');
    actionsBox.style.borderTop = '1px solid var(--border-color)';
    actionsBox.style.paddingTop = '0.75rem';
    actionsBox.style.marginTop = '0.5rem';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '0.75rem';
    btnRow.style.alignItems = 'center';
    btnRow.style.flexWrap = 'wrap';

    // Accept Button
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'btn btn-primary';
    acceptBtn.style.width = 'auto';
    acceptBtn.textContent = 'Accept Deduction';

    acceptBtn.addEventListener('click', async () => {
      if (
        !confirm(
          `Accept deduction of ${formatPaise(line.amountPaise)} for "${line.description}"?`
        )
      ) {
        return;
      }
      acceptBtn.disabled = true;
      try {
        await apiRequest(`/api/deductions/${encodeURIComponent(line.id)}`, {
          method: 'PATCH',
          body: { action: 'accept' },
        });
        await reloadFn();
      } catch (err) {
        alert(err.message || 'Failed to accept deduction');
        acceptBtn.disabled = false;
      }
    });

    btnRow.appendChild(acceptBtn);

    // Dispute Button (only if status is proposed)
    if (line.status === 'proposed') {
      const toggleDisputeBtn = document.createElement('button');
      toggleDisputeBtn.type = 'button';
      toggleDisputeBtn.className = 'btn btn-secondary';
      toggleDisputeBtn.style.width = 'auto';
      toggleDisputeBtn.textContent = 'Dispute';

      const disputeForm = document.createElement('div');
      disputeForm.style.display = 'none';
      disputeForm.style.marginTop = '0.75rem';
      disputeForm.style.padding = '0.75rem';
      disputeForm.style.background = '#fef2f2';
      disputeForm.style.border = '1px solid #fecaca';
      disputeForm.style.borderRadius = '4px';

      const noteLabel = document.createElement('label');
      noteLabel.style.display = 'block';
      noteLabel.style.marginBottom = '0.25rem';
      noteLabel.style.fontWeight = '600';
      noteLabel.style.fontSize = '0.85rem';
      noteLabel.textContent =
        'Reason for disputing (required, 1-500 characters)';

      const noteInput = document.createElement('textarea');
      noteInput.rows = 2;
      noteInput.style.width = '100%';
      noteInput.maxLength = 500;
      noteInput.placeholder = 'Explain why you dispute this deduction...';
      noteInput.style.marginBottom = '0.5rem';

      const submitDisputeBtn = document.createElement('button');
      submitDisputeBtn.type = 'button';
      submitDisputeBtn.className = 'btn';
      submitDisputeBtn.style.width = 'auto';
      submitDisputeBtn.textContent = 'Submit Dispute';

      submitDisputeBtn.addEventListener('click', async () => {
        const note = noteInput.value.trim();
        if (!note) {
          alert(
            'Please enter a note explaining why you dispute this deduction.'
          );
          noteInput.focus();
          return;
        }

        submitDisputeBtn.disabled = true;
        try {
          await apiRequest(`/api/deductions/${encodeURIComponent(line.id)}`, {
            method: 'PATCH',
            body: { action: 'dispute', note },
          });
          await reloadFn();
        } catch (err) {
          alert(err.message || 'Failed to dispute deduction');
          submitDisputeBtn.disabled = false;
        }
      });

      disputeForm.appendChild(noteLabel);
      disputeForm.appendChild(noteInput);
      disputeForm.appendChild(submitDisputeBtn);

      toggleDisputeBtn.addEventListener('click', () => {
        disputeForm.style.display =
          disputeForm.style.display === 'none' ? 'block' : 'none';
      });

      btnRow.appendChild(toggleDisputeBtn);
      actionsBox.appendChild(btnRow);
      actionsBox.appendChild(disputeForm);
    } else {
      actionsBox.appendChild(btnRow);
    }

    card.appendChild(actionsBox);
  }

  return card;
}

let currentSettlementData = null;

async function loadSettlement() {
  if (!tenancyId) {
    window.location.href = '/tenancies.html';
    return;
  }

  loadingState.style.display = 'block';
  content.style.display = 'none';
  generalError.style.display = 'none';

  try {
    const data = await apiRequest(
      `/api/tenancies/${encodeURIComponent(tenancyId)}/settlement`
    );
    currentSettlementData = data;

    loadingState.style.display = 'none';
    content.style.display = 'block';

    const t = data.tenancy || {};
    const s = data.settlement || {};
    const lines = data.lines || [];

    // Header info
    setText('property-label', t.propertyLabel);
    setText('property-address', t.address || '');
    setText('tenancy-status', (t.status || 'settling').toUpperCase());

    // Settlement Totals
    setText('total-deposit-val', formatPaise(s.depositPaise || 0));
    setText('accepted-val', formatPaise(s.acceptedPaise || 0));
    setText('awaiting-val', formatPaise(s.proposedPaise || 0));
    setText('disputed-val', formatPaise(s.disputedPaise || 0));
    setText('unclaimed-val', formatPaise(s.unclaimedPaise || 0));

    // Timeline information (neutral wording, never claims legal deadline)
    const timelineParts = [];
    if (typeof s.daysSinceMoveOut === 'number') {
      timelineParts.push(
        `${s.daysSinceMoveOut} day(s) elapsed since move-out inspection submitted`
      );
    }
    if (s.refundWindowDays) {
      timelineParts.push(`Agreed refund window: ${s.refundWindowDays} days`);
      if (typeof s.windowRemainingDays === 'number') {
        if (s.windowRemainingDays >= 0) {
          timelineParts.push(
            `${s.windowRemainingDays} day(s) remaining in agreed refund window`
          );
        } else {
          timelineParts.push(
            `${Math.abs(s.windowRemainingDays)} day(s) past agreed refund window`
          );
        }
      }
    }
    setText(
      'timeline-text',
      timelineParts.length > 0
        ? timelineParts.join(' • ')
        : 'Deposit settlement in progress'
    );

    // Close Tenancy Section (only if settling)
    if (t.status === 'settling') {
      closeSection.style.display = 'flex';
    } else {
      closeSection.style.display = 'none';
    }

    // Deduction Lines List
    linesContainer.textContent = '';
    if (lines.length === 0) {
      emptyLines.style.display = 'block';
    } else {
      emptyLines.style.display = 'none';
      for (const line of lines) {
        linesContainer.appendChild(
          renderDeductionLine(line, t.status, loadSettlement)
        );
      }
    }
  } catch (err) {
    loadingState.style.display = 'none';
    generalError.style.display = 'block';
    generalError.textContent =
      err.message || 'Settlement record not found or could not be loaded.';
  }
}

// Close Modal logic
if (openCloseModalBtn) {
  openCloseModalBtn.addEventListener('click', () => {
    if (!currentSettlementData) return;
    const s = currentSettlementData.settlement || {};
    const proposedCount = s.proposedCount || 0;
    const disputedCount = s.disputedCount || 0;
    const unresolvedCount = proposedCount + disputedCount;

    closeModalError.style.display = 'none';
    unresolvedCheckbox.checked = false;

    if (unresolvedCount > 0) {
      closeModalDesc.textContent = `There are ${unresolvedCount} unresolved deduction line(s) (${proposedCount} awaiting response, ${disputedCount} disputed). Closing the tenancy will finalize the record with these amounts unresolved.`;
      unresolvedAckGroup.style.display = 'block';
      unresolvedCheckboxLabel.textContent = `I acknowledge that there are ${unresolvedCount} unresolved deduction(s) and wish to close the tenancy.`;
      confirmCloseBtn.disabled = true;
    } else {
      closeModalDesc.textContent =
        'All deduction lines are resolved. Closing the tenancy will finalize the deposit settlement and close the record permanently.';
      unresolvedAckGroup.style.display = 'none';
      confirmCloseBtn.disabled = false;
    }

    closeModal.style.display = 'flex';
  });
}

if (unresolvedCheckbox) {
  unresolvedCheckbox.addEventListener('change', () => {
    confirmCloseBtn.disabled = !unresolvedCheckbox.checked;
  });
}

if (cancelCloseBtn) {
  cancelCloseBtn.addEventListener('click', () => {
    closeModal.style.display = 'none';
  });
}

if (confirmCloseBtn) {
  confirmCloseBtn.addEventListener('click', async () => {
    if (!currentSettlementData) return;
    const s = currentSettlementData.settlement || {};
    const unresolvedCount = (s.proposedCount || 0) + (s.disputedCount || 0);

    confirmCloseBtn.disabled = true;
    closeModalError.style.display = 'none';

    try {
      const body = {};
      if (unresolvedCount > 0) {
        body.acknowledgeUnresolved = true;
      }
      await apiRequest(
        `/api/tenancies/${encodeURIComponent(tenancyId)}/close`,
        {
          method: 'POST',
          body,
        }
      );
      closeModal.style.display = 'none';
      await loadSettlement();
    } catch (err) {
      closeModalError.style.display = 'block';
      closeModalError.textContent =
        err.message || 'Failed to close tenancy. Please try again.';
      confirmCloseBtn.disabled = false;
    }
  });
}

async function init() {
  try {
    await apiRequest('/api/me');
    await loadSettlement();
  } catch {
    window.location.href = '/login.html';
  }
}

init();
