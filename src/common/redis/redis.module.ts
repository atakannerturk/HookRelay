import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { errorMessage } from '../errors';

export const REDIS = Symbol('REDIS');

/** Turns REDIS_URL into ioredis options (BullMQ opens its own connections from these). */
export function redisOptionsFromUrl(url: string): RedisOptions {
  const parsed = new URL(url);
  const db = parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}

/**
 * Shared client for idempotency and the health check. If Redis is slow or down, commands
 * fail quickly instead of holding requests; callers then fall back to Postgres.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const client = new Redis({
          ...redisOptionsFromUrl(config.redisUrl),
          maxRetriesPerRequest: 1,
          commandTimeout: 1_000,
        });
        const logger = new Logger('Redis');
        client.on('error', (err) => logger.warn(`Redis connection error: ${errorMessage(err)}`));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
