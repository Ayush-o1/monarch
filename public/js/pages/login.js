import { apiRequest, ApiError } from '../api.js';
import {
  clearFieldErrors,
  setFieldError,
  setButtonLoading,
  showMessage,
  clearMessage,
} from '../ui.js';

const form = document.getElementById('login-form');
const submitBtn = document.getElementById('submit-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMessage('general-error');
  clearFieldErrors(form);

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  setButtonLoading(submitBtn, true, 'Logging in...');

  try {
    await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    window.location.href = '/tenancies.html';
  } catch (err) {
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      for (const [field, message] of Object.entries(err.details || {})) {
        setFieldError(field, message);
      }
    } else {
      showMessage(
        'general-error',
        err.message || 'Login failed. Please check your credentials.'
      );
    }
  } finally {
    setButtonLoading(submitBtn, false);
  }
});
