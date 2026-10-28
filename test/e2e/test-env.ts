/**
 * E2E tests need a real Postgres and Redis (docker compose up -d postgres redis).
 * To never wipe development data they use a separate database and a separate Redis DB (1);
 * DATABASE_URL is deliberately not read.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://hookrelay:hookrelay@localhost:5432/hookrelay_test';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

export const TEST_ADMIN_KEY = 'test-admin-key';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  ADMIN_API_KEY: TEST_ADMIN_KEY,
  WORKER_ENABLED: 'true',
  WORKER_CONCURRENCY: '5',
  DELIVERY_MAX_ATTEMPTS: '5',
  // The real table is 1s/5s/30s/5min; tests run the same flow in milliseconds.
  DELIVERY_RETRY_DELAYS_MS: '50,50,50,50',
  DELIVERY_RETRY_JITTER: '0',
  DELIVERY_TIMEOUT_MS: '2000',
  // Tests trigger recovery manually (runOnce).
  RECOVERY_INTERVAL_MS: '3600000',
  RECOVERY_GRACE_MS: '0',
  LOG_LEVEL: 'error',
};
