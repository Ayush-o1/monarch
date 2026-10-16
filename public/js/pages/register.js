import { apiRequest, ApiError } from '../api.js';
import {
  clearFieldErrors,
  setFieldError,
  setButtonLoading,
  showMessage,
  clearMessage,
} from '../ui.js';

const form = document.getElementById('register-form');
const submitBtn = document.getElementById('submit-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessage('general-error');
  clearFieldErrors(form);

  const name = document.getElementById('name').value;
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  setButtonLoading(submitBtn, true, 'Creating account...');

  try {
    await apiRequest('/api/auth/register', {
      method: 'POST',
      body: { name, email, password },
    });
    window.location.href = '/tenancies.html';
  } catch (err) {
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      for (const [field, message] of Object.entries(err.details || {})) {
        setFieldError(field, message);
      }
    } else if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
      setFieldError('email', err.message);
      showMessage('general-error', err.message);
    } else {
      showMessage(
        'general-error',
        err.message || 'Registration failed. Please try again.'
      );
    }
  } finally {
    setButtonLoading(submitBtn, false);
  }
});
