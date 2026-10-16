export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest(endpoint, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(endpoint, {
    credentials: 'same-origin',
    ...options,
    headers,
    body,
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = data.error || {};
    throw new ApiError(
      response.status,
      err.code || 'UNKNOWN_ERROR',
      err.message || 'An unexpected error occurred',
      err.details || {}
    );
  }

  return data;
}
