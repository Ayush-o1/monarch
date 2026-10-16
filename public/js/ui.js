export function setText(target, text) {
  const el =
    typeof target === 'string' ? document.getElementById(target) : target;
  if (el) {
    el.textContent = text || '';
  }
}

export function clearFieldErrors(form) {
  const errorElements = form.querySelectorAll('.field-error');
  for (const el of errorElements) {
    el.textContent = '';
    el.style.display = 'none';
  }
}

export function setFieldError(fieldId, message) {
  const errorEl = document.getElementById(`${fieldId}-error`);
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = message ? 'block' : 'none';
  }
}

export function setButtonLoading(
  button,
  isLoading,
  loadingText = 'Submitting...'
) {
  if (!button) return;
  button.disabled = isLoading;
  if (isLoading) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }
    button.textContent = loadingText;
  } else if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
  }
}

export function showMessage(targetId, message, type = 'error') {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.textContent = message || '';
  el.className = `alert ${type}`;
  el.style.display = message ? 'block' : 'none';
}

export function clearMessage(targetId) {
  const el = document.getElementById(targetId);
  if (el) {
    el.textContent = '';
    el.style.display = 'none';
  }
}
