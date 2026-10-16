import { apiRequest } from '../api.js';
import { setText } from '../ui.js';

async function init() {
  try {
    const user = await apiRequest('/api/me');
    setText('user-greeting', `Signed in as ${user.name} (${user.email})`);
    const loading = document.getElementById('loading-state');
    if (loading) loading.style.display = 'none';
    const content = document.getElementById('content');
    if (content) content.style.display = 'block';

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await apiRequest('/api/auth/logout', { method: 'POST' });
        } finally {
          window.location.href = '/login.html';
        }
      });
    }
  } catch {
    window.location.href = '/login.html';
  }
}

init();
