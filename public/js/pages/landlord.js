import { formatPaise } from '../money.js';

// Extract token from path: /l/:token
const pathSegments = window.location.pathname.split('/').filter(Boolean);
const token = pathSegments[0] === 'l' && pathSegments[1] ? pathSegments[1] : '';

const loadingState = document.getElementById('loading-state');
const generalError = document.getElementById('general-error');
const invalidState = document.getElementById('link-invalid-state');
const expiredState = document.getElementById('link-expired-state');
const emptyState = document.getElementById('empty-state');
const content = document.getElementById('landlord-content');
const inspectionsContainer = document.getElementById('inspections-container');

function setElText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

function getConditionDisplay(condition) {
  switch (condition) {
    case 'good':
      return { icon: '✓', label: 'Good', color: '#059669' };
    case 'minor_wear':
      return { icon: '⚠', label: 'Minor Wear', color: '#d97706' };
    case 'damaged':
      return { icon: '✕', label: 'Damaged', color: '#dc2626' };
    case 'missing':
      return { icon: '⊘', label: 'Missing', color: '#6b7280' };
    default:
      return { icon: '•', label: 'Not specified', color: '#9ca3af' };
  }
}

function renderInspection(insp, tenancyStatus) {
  const card = document.createElement('section');
  card.className = 'card';
  card.style.marginBottom = '2rem';
  card.style.padding = '1.5rem';
  card.style.border = '1px solid var(--border-color)';
  card.style.borderRadius = '6px';

  // Header
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.flexWrap = 'wrap';
  header.style.gap = '0.5rem';
  header.style.marginBottom = '1.25rem';

  const title = document.createElement('h3');
  title.style.margin = '0';
  title.textContent =
    insp.type === 'move_out' ? 'Move-out Inspection' : 'Move-in Inspection';

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.style.padding = '0.25rem 0.65rem';
  badge.style.borderRadius = '4px';
  badge.style.fontSize = '0.85rem';
  badge.style.fontWeight = '600';
  if (insp.status === 'acknowledged') {
    badge.style.background = '#d1fae5';
    badge.style.color = '#065f46';
  } else {
    badge.style.background = '#fef3c7';
    badge.style.color = '#92400e';
  }
  badge.textContent = insp.status.toUpperCase();

  header.appendChild(title);
  header.appendChild(badge);
  card.appendChild(header);

  // Group items by room
  const items = insp.items || [];
  const groups = new Map();
  for (const it of items) {
    const room = it.room || 'General';
    if (!groups.has(room)) groups.set(room, []);
    groups.get(room).push(it);
  }

  const itemsContainer = document.createElement('div');
  itemsContainer.style.marginBottom = '1.5rem';

  for (const [room, roomItems] of groups.entries()) {
    const roomHeader = document.createElement('h4');
    roomHeader.style.fontSize = '1.05rem';
    roomHeader.style.margin = '1rem 0 0.5rem';
    roomHeader.style.paddingBottom = '0.25rem';
    roomHeader.style.borderBottom = '1px solid var(--border-color)';
    roomHeader.textContent = `${room} (${roomItems.length})`;
    itemsContainer.appendChild(roomHeader);

    for (const item of roomItems) {
      const itemRow = document.createElement('div');
      itemRow.style.padding = '0.75rem';
      itemRow.style.marginBottom = '0.5rem';
      itemRow.style.background = '#f9fafb';
      itemRow.style.borderRadius = '4px';
      itemRow.style.border = '1px solid #e5e7eb';

      const rowTop = document.createElement('div');
      rowTop.style.display = 'flex';
      rowTop.style.justifyContent = 'space-between';
      rowTop.style.alignItems = 'baseline';
      rowTop.style.flexWrap = 'wrap';
      rowTop.style.gap = '0.5rem';

      const nameEl = document.createElement('strong');
      nameEl.textContent = item.name;

      const cond = getConditionDisplay(item.condition);
      const condBadge = document.createElement('span');
      condBadge.style.color = cond.color;
      condBadge.style.fontWeight = '600';
      condBadge.style.fontSize = '0.875rem';
      condBadge.textContent = `${cond.icon} ${cond.label}`;

      rowTop.appendChild(nameEl);
      rowTop.appendChild(condBadge);
      itemRow.appendChild(rowTop);

      if (item.note) {
        const noteEl = document.createElement('p');
        noteEl.style.margin = '0.35rem 0 0';
        noteEl.style.fontSize = '0.875rem';
        noteEl.style.color = 'var(--text-muted)';
        noteEl.textContent = item.note;
        itemRow.appendChild(noteEl);
      }

      // Photos
      if (item.media && item.media.length > 0) {
        const thumbStrip = document.createElement('div');
        thumbStrip.style.display = 'flex';
        thumbStrip.style.gap = '0.5rem';
        thumbStrip.style.marginTop = '0.5rem';
        thumbStrip.style.flexWrap = 'wrap';

        for (const m of item.media) {
          const a = document.createElement('a');
          a.href = `/api/landlord/${encodeURIComponent(token)}/media/${encodeURIComponent(m.id)}`;
          a.target = '_blank';
          a.rel = 'noreferrer';

          const img = document.createElement('img');
          img.src = `/api/landlord/${encodeURIComponent(token)}/media/${encodeURIComponent(m.id)}`;
          img.alt = item.name;
          img.loading = 'lazy';
          img.style.width = '64px';
          img.style.height = '64px';
          img.style.objectFit = 'cover';
          img.style.borderRadius = '4px';
          img.style.border = '1px solid var(--border-color)';

          a.appendChild(img);
          thumbStrip.appendChild(a);
        }
        itemRow.appendChild(thumbStrip);
      }

      itemsContainer.appendChild(itemRow);
    }
  }

  card.appendChild(itemsContainer);

  // Status & Actions
  const actionsContainer = document.createElement('div');
  actionsContainer.style.borderTop = '1px solid var(--border-color)';
  actionsContainer.style.paddingTop = '1.25rem';

  if (insp.status === 'acknowledged') {
    const ackInfo = document.createElement('p');
    ackInfo.style.margin = '0';
    ackInfo.style.fontWeight = '600';
    ackInfo.style.color = '#065f46';
    const dateStr = insp.acknowledgedAt
      ? new Date(insp.acknowledgedAt).toLocaleString()
      : '';
    ackInfo.textContent = `✓ Acknowledged by ${insp.acknowledgedByName || 'Landlord'} on ${dateStr}`;
    actionsContainer.appendChild(ackInfo);
  } else if (insp.status === 'submitted') {
    // Action forms
    const cachedName = sessionStorage.getItem('landlord_name') || '';

    const nameGroup = document.createElement('div');
    nameGroup.style.marginBottom = '1rem';
    nameGroup.style.maxWidth = '360px';

    const nameLabel = document.createElement('label');
    nameLabel.style.display = 'block';
    nameLabel.style.marginBottom = '0.25rem';
    nameLabel.style.fontWeight = '600';
    nameLabel.style.fontSize = '0.9rem';
    nameLabel.textContent = 'Your Full Name (Signee)';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = cachedName;
    nameInput.placeholder = 'e.g. Jane Doe';
    nameInput.maxLength = 80;
    nameInput.style.width = '100%';

    nameInput.addEventListener('input', () => {
      sessionStorage.setItem('landlord_name', nameInput.value.trim());
    });

    nameGroup.appendChild(nameLabel);
    nameGroup.appendChild(nameInput);
    actionsContainer.appendChild(nameGroup);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '0.75rem';
    btnRow.style.flexWrap = 'wrap';
    btnRow.style.alignItems = 'center';

    // Acknowledge Button
    const ackBtn = document.createElement('button');
    ackBtn.type = 'button';
    ackBtn.className = 'btn';
    ackBtn.style.width = 'auto';
    ackBtn.textContent = 'Acknowledge Record';

    ackBtn.addEventListener('click', async () => {
      const signeeName = nameInput.value.trim();
      if (!signeeName) {
        alert('Please enter your name to acknowledge this inspection.');
        nameInput.focus();
        return;
      }

      if (
        !confirm(
          `Acknowledge this record as ${signeeName}? This locks the record permanently.`
        )
      ) {
        return;
      }

      ackBtn.disabled = true;
      try {
        const res = await fetch(
          `/api/landlord/${encodeURIComponent(token)}/inspections/${encodeURIComponent(insp.id)}/acknowledge`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: signeeName }),
          }
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || 'Failed to acknowledge');
        }
        sessionStorage.setItem('landlord_name', signeeName);
        await loadLandlordView();
      } catch (err) {
        alert(err.message || 'Error acknowledging inspection');
        ackBtn.disabled = false;
      }
    });

    btnRow.appendChild(ackBtn);

    // Request Changes Form (move_in while tenancy active)
    if (insp.type === 'move_in' && tenancyStatus === 'active') {
      const toggleReqBtn = document.createElement('button');
      toggleReqBtn.type = 'button';
      toggleReqBtn.className = 'btn btn-secondary';
      toggleReqBtn.style.width = 'auto';
      toggleReqBtn.textContent = 'Request Changes';

      const changeBox = document.createElement('div');
      changeBox.style.display = 'none';
      changeBox.style.marginTop = '1rem';
      changeBox.style.padding = '1rem';
      changeBox.style.background = '#fef2f2';
      changeBox.style.border = '1px solid #fecaca';
      changeBox.style.borderRadius = '6px';

      const noteLabel = document.createElement('label');
      noteLabel.style.display = 'block';
      noteLabel.style.marginBottom = '0.25rem';
      noteLabel.style.fontWeight = '600';
      noteLabel.style.fontSize = '0.9rem';
      noteLabel.textContent = 'Change Request Note';

      const noteTextarea = document.createElement('textarea');
      noteTextarea.rows = 3;
      noteTextarea.style.width = '100%';
      noteTextarea.style.marginBottom = '0.5rem';
      noteTextarea.placeholder =
        'Specify any items requiring adjustment or additional photos...';
      noteTextarea.maxLength = 1000;

      const submitChangeBtn = document.createElement('button');
      submitChangeBtn.type = 'button';
      submitChangeBtn.className = 'btn';
      submitChangeBtn.style.width = 'auto';
      submitChangeBtn.textContent = 'Send Change Request';

      submitChangeBtn.addEventListener('click', async () => {
        const signeeName = nameInput.value.trim();
        const note = noteTextarea.value.trim();
        if (!signeeName) {
          alert('Please enter your name.');
          nameInput.focus();
          return;
        }
        if (!note) {
          alert('Please provide a note describing the requested changes.');
          noteTextarea.focus();
          return;
        }

        submitChangeBtn.disabled = true;
        try {
          const res = await fetch(
            `/api/landlord/${encodeURIComponent(token)}/inspections/${encodeURIComponent(insp.id)}/request-changes`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: signeeName, note }),
            }
          );
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || 'Failed to request changes');
          }
          sessionStorage.setItem('landlord_name', signeeName);
          await loadLandlordView();
        } catch (err) {
          alert(err.message || 'Error requesting changes');
          submitChangeBtn.disabled = false;
        }
      });

      changeBox.appendChild(noteLabel);
      changeBox.appendChild(noteTextarea);
      changeBox.appendChild(submitChangeBtn);

      toggleReqBtn.addEventListener('click', () => {
        changeBox.style.display =
          changeBox.style.display === 'none' ? 'block' : 'none';
      });

      btnRow.appendChild(toggleReqBtn);
      actionsContainer.appendChild(btnRow);
      actionsContainer.appendChild(changeBox);
    } else {
      actionsContainer.appendChild(btnRow);
    }
  }

  card.appendChild(actionsContainer);
  return card;
}

async function loadLandlordView() {
  if (!token) {
    loadingState.style.display = 'none';
    invalidState.style.display = 'block';
    return;
  }

  loadingState.style.display = 'block';
  content.style.display = 'none';
  invalidState.style.display = 'none';
  expiredState.style.display = 'none';
  emptyState.style.display = 'none';

  try {
    const res = await fetch(
      `/api/landlord/${encodeURIComponent(token)}/tenancy`
    );

    if (res.status === 404) {
      loadingState.style.display = 'none';
      invalidState.style.display = 'block';
      return;
    }

    if (res.status === 410) {
      loadingState.style.display = 'none';
      expiredState.style.display = 'block';
      return;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || 'Failed to load records');
    }

    const data = await res.json();
    loadingState.style.display = 'none';
    content.style.display = 'block';

    const t = data.tenancy || {};
    setElText('property-label', t.propertyLabel);
    setElText('property-address', t.address || '');
    setElText('tenancy-status', (t.status || 'active').toUpperCase());
    setElText('tenant-name', t.tenantName || 'Tenant');
    setElText('deposit-amount', formatPaise(t.depositPaise || 0));

    if (t.refundWindowDays) {
      setElText('refund-window', `${t.refundWindowDays} days`);
      document.getElementById('refund-window-row').style.display = 'block';
    } else {
      document.getElementById('refund-window-row').style.display = 'none';
    }

    // Render inspections
    inspectionsContainer.textContent = '';
    const inspections = data.inspections || [];

    if (inspections.length === 0) {
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
      for (const insp of inspections) {
        inspectionsContainer.appendChild(renderInspection(insp, t.status));
      }
    }
  } catch (err) {
    loadingState.style.display = 'none';
    generalError.style.display = 'block';
    generalError.textContent = err.message || 'An unexpected error occurred.';
  }
}

loadLandlordView();
