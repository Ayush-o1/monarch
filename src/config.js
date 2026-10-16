export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isTest = nodeEnv === 'test';

  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('Config validation error: SESSION_SECRET is required');
  }
  if (sessionSecret.length < 32) {
    throw new Error(
      'Config validation error: SESSION_SECRET must be at least 32 characters long'
    );
  }
  if (
    nodeEnv === 'production' &&
    sessionSecret === 'replace-with-a-random-string-of-at-least-32-characters'
  ) {
    throw new Error(
      'Config validation error: SESSION_SECRET must not use the placeholder value in production'
    );
  }

  const databaseUrl = isTest
    ? env.TEST_DATABASE_URL || env.DATABASE_URL
    : env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      `Config validation error: ${
        isTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'
      } is required`
    );
  }

  const port = parseInt(env.PORT || '3000', 10);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(
      'Config validation error: PORT must be a valid positive integer'
    );
  }

  const cookieSecure = env.COOKIE_SECURE === 'true';
  const uploadDir = env.UPLOAD_DIR || './uploads';
  const maxUploadMb = parseInt(env.MAX_UPLOAD_MB || '5', 10);
  const inviteTtlDaysRaw = env.INVITE_TTL_DAYS || '30';
  const inviteTtlDays = parseInt(inviteTtlDaysRaw, 10);
  if (
    Number.isNaN(inviteTtlDays) ||
    !/^\d+$/.test(String(inviteTtlDaysRaw).trim()) ||
    inviteTtlDays < 1 ||
    inviteTtlDays > 365
  ) {
    throw new Error(
      'Config validation error: INVITE_TTL_DAYS must be an integer between 1 and 365'
    );
  }

  const publicBaseUrl = (
    env.PUBLIC_BASE_URL || 'http://localhost:3000'
  ).replace(/\/+$/, '');
  try {
    new URL(publicBaseUrl);
  } catch {
    throw new Error(
      'Config validation error: PUBLIC_BASE_URL must be a valid URL'
    );
  }

  return {
    nodeEnv,
    isTest,
    port,
    databaseUrl,
    sessionSecret,
    cookieSecure,
    uploadDir,
    maxUploadMb,
    inviteTtlDays,
    publicBaseUrl,
  };
}

const config = loadConfig();
export default config;
