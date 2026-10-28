import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

const msList = z
  .string()
  .default('1000,5000,30000,300000')
  .transform((value, ctx) => {
    const parts = value.split(',').map((p) => Number(p.trim()));
    if (parts.length === 0 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
      ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of milliseconds' });
      return z.NEVER;
    }
    return parts;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000, 1),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ADMIN_API_KEY: z.string().min(8),

  WORKER_ENABLED: bool(true),
  WORKER_CONCURRENCY: int(10, 1),

  DELIVERY_MAX_ATTEMPTS: int(5, 1),
  DELIVERY_RETRY_DELAYS_MS: msList,
  DELIVERY_RETRY_JITTER: z.coerce.number().min(0).max(1).default(0.1),
  DELIVERY_TIMEOUT_MS: int(10_000, 1),

  IDEMPOTENCY_TTL_SECONDS: int(259_200, 1),
  IDEMPOTENCY_LOCK_TTL_SECONDS: int(30, 1),

  RECOVERY_INTERVAL_MS: int(30_000, 100),
  RECOVERY_GRACE_MS: int(60_000, 0),

  MAX_BODY_BYTES: int(1_048_576, 1),
  STRIPE_TOLERANCE_SECONDS: int(300, 1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  LOG_JSON: bool(false),
});

export type LogLevelName = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string;
  adminApiKey: string;
  worker: { enabled: boolean; concurrency: number };
  delivery: {
    maxAttempts: number;
    retryDelaysMs: number[];
    retryJitter: number;
    timeoutMs: number;
  };
  idempotency: { ttlSeconds: number; lockTtlSeconds: number };
  recovery: { intervalMs: number; graceMs: number };
  maxBodyBytes: number;
  stripeToleranceSeconds: number;
  log: { level: LogLevelName; json: boolean };
}

/** Loads .env from the working directory if present; never overrides variables already set. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: values come from the real environment (Docker, CI).
  }
}

/** Validates the environment; with invalid values the app refuses to start (fail fast). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    adminApiKey: e.ADMIN_API_KEY,
    worker: { enabled: e.WORKER_ENABLED, concurrency: e.WORKER_CONCURRENCY },
    delivery: {
      maxAttempts: e.DELIVERY_MAX_ATTEMPTS,
      retryDelaysMs: e.DELIVERY_RETRY_DELAYS_MS,
      retryJitter: e.DELIVERY_RETRY_JITTER,
      timeoutMs: e.DELIVERY_TIMEOUT_MS,
    },
    idempotency: {
      ttlSeconds: e.IDEMPOTENCY_TTL_SECONDS,
      lockTtlSeconds: e.IDEMPOTENCY_LOCK_TTL_SECONDS,
    },
    recovery: { intervalMs: e.RECOVERY_INTERVAL_MS, graceMs: e.RECOVERY_GRACE_MS },
    maxBodyBytes: e.MAX_BODY_BYTES,
    stripeToleranceSeconds: e.STRIPE_TOLERANCE_SECONDS,
    log: { level: e.LOG_LEVEL, json: e.LOG_JSON },
  };
}
