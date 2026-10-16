import { formatPaise } from '../money.js';

const pathSegments = window.location.pathname.split('/').filter(Boolean);
const isLandlord =
  pathSegments[0] === 'l' && pathSegments[2] === 'compare' && !!pathSegments[1];
const landlordToken = isLandlord ? pathSegments[1] : null;

const urlParams = new URLSearchParams(window.location.search);
const tenancyId = isLandlord ? null : urlParams.get('id');

const loadingState = document.getElementById('loading-state');
const generalError = document.getElementById('general-error');
const unavailableState = document.getElementById('unavailable-state');
const content = document.getElementById('comparison-content');
const backLink = document.getElementById('back-link');
const itemsContainer = document.getElementById('comparison-items-container');

// Lightbox elements
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');

if (lightbox) {
  lightbox.addEventListener('click', () => {
    lightbox.classList.remove('active');
    lightboxImg.src = '';
  });
}

function openLightbox(url) {
  if (!lightbox || !lightboxImg) return;
  lightboxImg.src = url;
  lightbox.classList.add('active');
}

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

function getOutcomeBadge(outcome) {
  const badge = document.createElement('span');
  badge.className = 'badge';

  switch (outcome) {
    case 'worse':
      badge.className += ' badge-worse';
      badge.textContent = 'WORSE';
      break;
    case 'same':
      badge.className += ' badge-same';
      badge.textContent = 'SAME';
      break;
    case 'better':
      badge.className += ' badge-better';
      badge.textContent = 'BETTER';
      break;
    case 'new_at_move_out':
      badge.className += ' badge-new';
      badge.textContent = 'ADDED AT MOVE-OUT';
      break;
    case 'not_in_move_out':
      badge.className += ' badge-missing';
      badge.textContent = 'NOT IN MOVE-OUT';
      break;
    default:
      badge.className += ' badge-same';
      badge.textContent = (outcome || '').toUpperCase();
  }

  return badge;
}

function renderInspectionColumn(title, itemData, getMediaUrl) {
  const col = document.createElement('div');
  col.style.flex = '1';
  col.style.minWidth = '240px';
  col.style.padding = '0.75rem';
  col.style.borderRadius = '4px';
  col.style.background = '#f9fafb';
  col.style.border = '1px solid #e5e7eb';

  const colTitle = document.createElement('div');
  colTitle.style.fontSize = '0.8rem';
  colTitle.style.fontWeight = '600';
  colTitle.style.textTransform = 'uppercase';
  colTitle.style.letterSpacing = '0.05em';
  colTitle.style.color = 'var(--text-muted)';
  colTitle.style.marginBottom = '0.5rem';
  colTitle.textContent = title;
  col.appendChild(colTitle);

  if (!itemData) {
    const emptyMsg = document.createElement('p');
    emptyMsg.style.fontSize = '0.875rem';
    emptyMsg.style.color = 'var(--text-muted)';
    emptyMsg.style.fontStyle = 'italic';
    emptyMsg.style.margin = '0';
    emptyMsg.textContent = 'Not present';
    col.appendChild(emptyMsg);
    return col;
  }

  // Condition
  const cond = getConditionDisplay(itemData.condition);
  const condEl = document.createElement('div');
  condEl.style.fontWeight = '600';
  condEl.style.fontSize = '0.95rem';
  condEl.style.color = cond.color;
  condEl.style.marginBottom = '0.25rem';
  condEl.textContent = `${cond.icon} ${cond.label}`;
  col.appendChild(condEl);

  // Note
  if (itemData.note) {
    const noteEl = document.createElement('p');
    noteEl.style.fontSize = '0.875rem';
    noteEl.style.color = 'var(--text-color)';
    noteEl.style.margin = '0 0 0.5rem 0';
    noteEl.textContent = itemData.note;
    col.appendChild(noteEl);
  }

  // Photos
  if (itemData.media && itemData.media.length > 0) {
    const photoStrip = document.createElement('div');
    photoStrip.style.display = 'flex';
    photoStrip.style.gap = '0.5rem';
    photoStrip.style.flexWrap = 'wrap';
    photoStrip.style.marginTop = '0.5rem';

    for (const m of itemData.media) {
      const mediaUrl = getMediaUrl(m.id);

      const thumbBtn = document.createElement('button');
      thumbBtn.type = 'button';
      thumbBtn.style.padding = '0';
      thumbBtn.style.border = '1px solid var(--border-color)';
      thumbBtn.style.borderRadius = '4px';
      thumbBtn.style.width = '56px';
      thumbBtn.style.height = '56px';
      thumbBtn.style.minHeight = '56px';
      thumbBtn.style.overflow = 'hidden';
      thumbBtn.style.background = '#e5e7eb';
      thumbBtn.style.cursor = 'pointer';

      const img = document.createElement('img');
      img.src = mediaUrl;
      img.alt = itemData.name;
      img.loading = 'lazy';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';

      thumbBtn.appendChild(img);
      thumbBtn.addEventListener('click', () => openLightbox(mediaUrl));
      photoStrip.appendChild(thumbBtn);
    }

    col.appendChild(photoStrip);
  }

  return col;
}

function renderItemRow(item, getMediaUrl) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '1rem';
  card.style.padding = '1rem';
  card.style.border = '1px solid var(--border-color)';
  card.style.borderRadius = '6px';

  // Item Header
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.flexWrap = 'wrap';
  header.style.gap = '0.5rem';
  header.style.marginBottom = '0.75rem';

  const titleDiv = document.createElement('div');
  const roomSpan = document.createElement('span');
  roomSpan.style.fontSize = '0.85rem';
  roomSpan.style.color = 'var(--text-muted)';
  roomSpan.style.marginRight = '0.5rem';
  roomSpan.textContent = item.room;

  const nameEl = document.createElement('strong');
  nameEl.style.fontSize = '1.05rem';
  nameEl.textContent = item.name;

  titleDiv.appendChild(roomSpan);
  titleDiv.appendChild(nameEl);

  const badge = getOutcomeBadge(item.outcome);

  header.appendChild(titleDiv);
  header.appendChild(badge);
  card.appendChild(header);

  // Two comparison columns side-by-side
  const colsContainer = document.createElement('div');
  colsContainer.style.display = 'flex';
  colsContainer.style.gap = '1rem';
  colsContainer.style.flexWrap = 'wrap';

  const moveInCol = renderInspectionColumn('Move-in', item.moveIn, getMediaUrl);
  const moveOutCol = renderInspectionColumn(
    'Move-out',
    item.moveOut,
    getMediaUrl
  );

  colsContainer.appendChild(moveInCol);
  colsContainer.appendChild(moveOutCol);
  card.appendChild(colsContainer);

  return card;
}

async function loadComparison() {
  let apiUrl;
  let getMediaUrl;

  if (isLandlord) {
    if (backLink) {
      backLink.href = `/l/${encodeURIComponent(landlordToken)}`;
      backLink.textContent = '← Landlord Review';
    }
    apiUrl = `/api/landlord/${encodeURIComponent(landlordToken)}/comparison`;
    getMediaUrl = (mediaId) =>
      `/api/landlord/${encodeURIComponent(landlordToken)}/media/${encodeURIComponent(mediaId)}`;
  } else {
    if (!tenancyId) {
      window.location.href = '/tenancies.html';
      return;
    }
    if (backLink) {
      backLink.href = `/tenancy.html?id=${encodeURIComponent(tenancyId)}`;
      backLink.textContent = '← Tenancy Details';
    }
    apiUrl = `/api/tenancies/${encodeURIComponent(tenancyId)}/comparison`;
    getMediaUrl = (mediaId) => `/api/media/${encodeURIComponent(mediaId)}`;
  }

  try {
    const res = await fetch(apiUrl, {
      credentials: isLandlord ? 'omit' : 'include',
    });

    if (res.status === 409) {
      loadingState.style.display = 'none';
      unavailableState.style.display = 'block';
      const data = await res.json().catch(() => ({}));
      if (data.error?.message) {
        setElText('unavailable-message', data.error.message);
      }
      return;
    }

    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }

    if (res.status === 404) {
      loadingState.style.display = 'none';
      generalError.style.display = 'block';
      generalError.textContent =
        'Tenancy or comparison records could not be found.';
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || 'Failed to load comparison');
    }

    const data = await res.json();
    loadingState.style.display = 'none';
    content.style.display = 'block';

    const t = data.tenancy || {};
    setElText('property-label', t.propertyLabel);
    setElText('property-address', t.address || '');
    setElText('tenancy-status', (t.status || 'settling').toUpperCase());
    setElText('deposit-amount', formatPaise(t.depositPaise || 0));

    if (t.tenantName) {
      setElText('tenant-name', t.tenantName);
      const row = document.getElementById('tenant-row');
      if (row) row.style.display = 'block';
    }

    if (t.landlordName) {
      setElText('landlord-name', t.landlordName);
      const row = document.getElementById('landlord-row');
      if (row) row.style.display = 'block';
    }

    if (t.refundWindowDays) {
      setElText('refund-window', `${t.refundWindowDays} days`);
      const row = document.getElementById('refund-window-row');
      if (row) row.style.display = 'block';
    }

    // Populate summary metrics
    const summary = data.comparison?.summary || {};
    setElText('metric-total', summary.total || summary.totalItems || 0);
    setElText('metric-worse', summary.worse || 0);
    setElText('metric-same', summary.same || 0);
    setElText('metric-better', summary.better || 0);
    setElText('metric-added', summary.added || summary.newAtMoveOut || 0);
    setElText('metric-missing', summary.missing || summary.notInMoveOut || 0);

    // Populate comparison items
    itemsContainer.textContent = '';
    const items = data.comparison?.items || [];

    if (items.length === 0) {
      const p = document.createElement('p');
      p.style.color = 'var(--text-muted)';
      p.textContent = 'No inspection items to compare.';
      itemsContainer.appendChild(p);
    } else {
      for (const item of items) {
        itemsContainer.appendChild(renderItemRow(item, getMediaUrl));
      }
    }
  } catch (err) {
    loadingState.style.display = 'none';
    generalError.style.display = 'block';
    generalError.textContent = err.message || 'An unexpected error occurred.';
  }
}

loadComparison();
