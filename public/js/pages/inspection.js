import { apiRequest, ApiError } from '../api.js';
import { COMMON_ITEMS_BY_ROOM } from '../commonItems.js';
import {
  setText,
  clearFieldErrors,
  setFieldError,
  setButtonLoading,
  showMessage,
  clearMessage,
} from '../ui.js';

const urlParams = new URLSearchParams(window.location.search);
const inspectionId = urlParams.get('id');

const loadingState = document.getElementById('loading-state');
const content = document.getElementById('inspection-content');
const lockedBanner = document.getElementById('locked-banner');
const quickAddSection = document.getElementById('quick-add-section');
const quickAddButtons = document.getElementById('quick-add-buttons');
const quickAddStatus = document.getElementById('quick-add-status');
const addItemSection = document.getElementById('add-item-section');
const addItemForm = document.getElementById('add-item-form');
const addItemBtn = document.getElementById('add-item-btn');
const roomsContainer = document.getElementById('rooms-container');
const emptyItemsState = document.getElementById('empty-items-state');
const totalItemsCount = document.getElementById('total-items-count');
const backLink = document.getElementById('back-link');

async function autoSaveItem(itemId, patchData, indicatorEl) {
  if (indicatorEl) {
    indicatorEl.style.color = 'var(--text-muted)';
    indicatorEl.textContent = 'Saving...';
  }

  try {
    await apiRequest(`/api/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: patchData,
    });
    if (indicatorEl) {
      indicatorEl.style.color = 'var(--success-color)';
      indicatorEl.textContent = 'Saved';
      setTimeout(() => {
        if (indicatorEl.textContent === 'Saved') {
          indicatorEl.textContent = '';
        }
      }, 2500);
    }
  } catch (err) {
    if (indicatorEl) {
      indicatorEl.style.color = 'var(--danger-color)';
      indicatorEl.textContent = err.message || 'Error saving';
    }
  }
}

function renderItems(inspection) {
  const items = inspection.items || [];
  totalItemsCount.textContent = String(items.length);

  roomsContainer.textContent = '';

  if (items.length === 0) {
    emptyItemsState.style.display = 'block';
    return;
  }

  emptyItemsState.style.display = 'none';

  const isDraft = inspection.status === 'draft';

  // Group items by room
  const groups = new Map();
  for (const item of items) {
    const roomKey = item.room;
    if (!groups.has(roomKey)) {
      groups.set(roomKey, []);
    }
    groups.get(roomKey).push(item);
  }

  for (const [roomName, roomItems] of groups.entries()) {
    const roomSection = document.createElement('div');
    roomSection.className = 'room-group';
    roomSection.style.marginBottom = '2rem';

    const roomHeading = document.createElement('h4');
    roomHeading.style.fontSize = '1.15rem';
    roomHeading.style.marginBottom = '0.75rem';
    roomHeading.style.paddingBottom = '0.35rem';
    roomHeading.style.borderBottom = '1px solid var(--border-color)';
    roomHeading.textContent = `${roomName} (${roomItems.length})`;
    roomSection.appendChild(roomHeading);

    const itemsList = document.createElement('div');
    itemsList.style.display = 'flex';
    itemsList.style.flexDirection = 'column';
    itemsList.style.gap = '0.75rem';

    for (const item of roomItems) {
      const card = document.createElement('div');
      card.className = 'item-card card';
      card.style.border = '1px solid var(--border-color)';
      card.style.borderRadius = '6px';
      card.style.padding = '0.875rem 1rem';
      card.style.background = isDraft ? 'white' : '#f9fafb';

      const topRow = document.createElement('div');
      topRow.style.display = 'flex';
      topRow.style.justifyContent = 'space-between';
      topRow.style.alignItems = 'center';
      topRow.style.flexWrap = 'wrap';
      topRow.style.gap = '0.5rem';
      topRow.style.marginBottom = '0.5rem';

      const itemName = document.createElement('strong');
      itemName.style.fontSize = '1rem';
      itemName.textContent = item.name;

      const rightControls = document.createElement('div');
      rightControls.style.display = 'flex';
      rightControls.style.alignItems = 'center';
      rightControls.style.gap = '0.75rem';

      const indicator = document.createElement('span');
      indicator.className = 'item-indicator';
      indicator.style.fontSize = '0.8rem';
      indicator.style.fontWeight = '500';

      rightControls.appendChild(indicator);

      if (isDraft) {
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.style.width = 'auto';
        deleteBtn.style.padding = '0.2rem 0.5rem';
        deleteBtn.style.minHeight = '32px';
        deleteBtn.style.fontSize = '0.8rem';
        deleteBtn.style.background = 'transparent';
        deleteBtn.style.color = 'var(--danger-color)';
        deleteBtn.style.border = '1px solid var(--danger-border)';
        deleteBtn.style.borderRadius = '4px';

        deleteBtn.addEventListener('click', async () => {
          deleteBtn.disabled = true;
          indicator.textContent = 'Deleting...';
          try {
            await apiRequest(`/api/items/${encodeURIComponent(item.id)}`, {
              method: 'DELETE',
            });
            await loadInspection();
          } catch (err) {
            deleteBtn.disabled = false;
            indicator.style.color = 'var(--danger-color)';
            indicator.textContent = err.message || 'Delete failed';
          }
        });

        rightControls.appendChild(deleteBtn);
      }

      topRow.appendChild(itemName);
      topRow.appendChild(rightControls);
      card.appendChild(topRow);

      const fieldsRow = document.createElement('div');
      fieldsRow.style.display = 'grid';
      fieldsRow.style.gridTemplateColumns =
        'repeat(auto-fit, minmax(200px, 1fr))';
      fieldsRow.style.gap = '0.75rem';

      // Condition select
      const condGroup = document.createElement('div');
      const condLabel = document.createElement('label');
      condLabel.style.fontSize = '0.8rem';
      condLabel.style.marginBottom = '0.2rem';
      condLabel.textContent = 'Condition';

      const condSelect = document.createElement('select');
      condSelect.style.width = '100%';
      condSelect.style.padding = '0.35rem 0.5rem';
      condSelect.style.fontSize = '0.9rem';
      condSelect.style.borderRadius = '4px';
      condSelect.style.border = '1px solid var(--border-color)';
      condSelect.style.minHeight = '36px';

      const options = [
        { value: '', label: '-- Condition --' },
        { value: 'good', label: 'Good' },
        { value: 'minor_wear', label: 'Minor wear' },
        { value: 'damaged', label: 'Damaged' },
        { value: 'missing', label: 'Missing' },
      ];

      for (const opt of options) {
        const optionEl = document.createElement('option');
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        if (item.condition === opt.value) {
          optionEl.selected = true;
        }
        condSelect.appendChild(optionEl);
      }

      if (!isDraft) {
        condSelect.disabled = true;
      } else {
        condSelect.addEventListener('change', () => {
          const val = condSelect.value || null;
          autoSaveItem(item.id, { condition: val }, indicator);
        });
      }

      condGroup.appendChild(condLabel);
      condGroup.appendChild(condSelect);
      fieldsRow.appendChild(condGroup);

      // Note input
      const noteGroup = document.createElement('div');
      const noteLabel = document.createElement('label');
      noteLabel.style.fontSize = '0.8rem';
      noteLabel.style.marginBottom = '0.2rem';
      noteLabel.textContent = 'Notes';

      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.value = item.note || '';
      noteInput.placeholder = 'Optional note...';
      noteInput.style.width = '100%';
      noteInput.style.padding = '0.35rem 0.5rem';
      noteInput.style.fontSize = '0.9rem';
      noteInput.style.borderRadius = '4px';
      noteInput.style.border = '1px solid var(--border-color)';
      noteInput.style.minHeight = '36px';

      if (!isDraft) {
        noteInput.disabled = true;
      } else {
        noteInput.addEventListener('change', () => {
          const val = noteInput.value.trim() || null;
          autoSaveItem(item.id, { note: val }, indicator);
        });
      }

      noteGroup.appendChild(noteLabel);
      noteGroup.appendChild(noteInput);
      fieldsRow.appendChild(noteGroup);

      card.appendChild(fieldsRow);
      itemsList.appendChild(card);
    }

    roomSection.appendChild(itemsList);
    roomsContainer.appendChild(roomSection);
  }
}

async function loadInspection() {
  if (!inspectionId) {
    window.location.href = '/tenancies.html';
    return;
  }

  try {
    const inspection = await apiRequest(
      `/api/inspections/${encodeURIComponent(inspectionId)}`
    );

    loadingState.style.display = 'none';
    content.style.display = 'block';

    const typeTitle =
      inspection.type === 'move_out'
        ? 'Move-out Inspection'
        : 'Move-in Inspection';
    setText('inspection-title', typeTitle);
    setText(
      'inspection-property',
      inspection.property_label || 'Rental Tenancy'
    );
    setText('inspection-status', inspection.status.toUpperCase());

    if (backLink && inspection.tenancy_id) {
      backLink.href = `/tenancy.html?id=${encodeURIComponent(inspection.tenancy_id)}`;
      backLink.textContent = '← Back to Tenancy';
    }

    const isDraft = inspection.status === 'draft';
    if (!isDraft) {
      lockedBanner.style.display = 'block';
      quickAddSection.style.display = 'none';
      addItemSection.style.display = 'none';
    } else {
      lockedBanner.style.display = 'none';
      quickAddSection.style.display = 'block';
      addItemSection.style.display = 'block';
    }

    renderItems(inspection);
  } catch (err) {
    loadingState.style.display = 'none';
    showMessage(
      'general-error',
      err.message || 'Inspection could not be loaded or not found.'
    );
  }
}

function initQuickAdd() {
  quickAddButtons.textContent = '';
  for (const [room, items] of Object.entries(COMMON_ITEMS_BY_ROOM)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.width = 'auto';
    btn.style.padding = '0.35rem 0.75rem';
    btn.style.minHeight = '38px';
    btn.style.fontSize = '0.85rem';
    btn.style.background = '#e0e7ff';
    btn.style.color = '#3730a3';
    btn.style.border = '1px solid #c7d2fe';
    btn.style.borderRadius = '4px';
    btn.textContent = `+ Add ${room} items`;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      quickAddStatus.style.display = 'block';
      quickAddStatus.textContent = `Adding ${room} items...`;

      let added = 0;
      for (const itemName of items) {
        try {
          await apiRequest(
            `/api/inspections/${encodeURIComponent(inspectionId)}/items`,
            {
              method: 'POST',
              body: { room, name: itemName },
            }
          );
          added++;
        } catch (err) {
          if (err instanceof ApiError && err.code === 'DUPLICATE_ITEM') {
            // Silently skip duplicates
          } else {
            quickAddStatus.textContent = `Error: ${err.message}`;
            btn.disabled = false;
            return;
          }
        }
      }

      quickAddStatus.textContent = `Done. Added ${added} new item(s) to ${room}.`;
      setTimeout(() => {
        quickAddStatus.style.display = 'none';
      }, 3000);
      btn.disabled = false;
      await loadInspection();
    });

    quickAddButtons.appendChild(btn);
  }
}

addItemForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessage('general-error');
  clearFieldErrors(addItemForm);

  const room = document.getElementById('room-input').value;
  const name = document.getElementById('name-input').value;
  const condition = document.getElementById('condition-input').value || null;
  const note = document.getElementById('note-input').value.trim() || null;

  setButtonLoading(addItemBtn, true, 'Adding...');

  try {
    await apiRequest(
      `/api/inspections/${encodeURIComponent(inspectionId)}/items`,
      {
        method: 'POST',
        body: { room, name, condition, note },
      }
    );

    document.getElementById('name-input').value = '';
    document.getElementById('condition-input').value = '';
    document.getElementById('note-input').value = '';

    await loadInspection();
  } catch (err) {
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      for (const [field, message] of Object.entries(err.details || {})) {
        setFieldError(`${field}-input`, message);
      }
    } else {
      showMessage('general-error', err.message || 'Failed to add item');
    }
  } finally {
    setButtonLoading(addItemBtn, false);
  }
});

async function init() {
  try {
    await apiRequest('/api/me');
    initQuickAdd();
    await loadInspection();
  } catch {
    window.location.href = '/login.html';
  }
}

init();
