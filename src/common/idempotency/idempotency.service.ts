import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { errorMessage } from '../errors';
import { REDIS } from '../redis/redis.module';

const PROCESSING = 'processing';
const DONE_PREFIX = 'done:';

export type IdempotencyClaim =
  /** We own the key: process the event, then call complete() or release(). */
  | { state: 'acquired' }
  /** This event has already been processed. */
  | { state: 'completed'; eventId: string }
  /** The same event is being processed by another request right now. */
  | { state: 'in_progress' }
  /** Redis is unreachable; the caller must rely on the Postgres unique constraint. */
  | { state: 'unavailable' };

/**
 * Two-phase idempotency lock:
 *  1. SET key "processing" NX EX <short ttl>  -> concurrent copies get 409
 *  2. When done, SET key "done:<eventId>" EX <long ttl> -> later copies get 200 duplicate
 * If processing fails the key is deleted, so the provider's retry is not lost.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  key(sourceId: string, externalId: string): string {
    return `hookrelay:idem:${sourceId}:${externalId}`;
  }

  async claim(key: string): Promise<IdempotencyClaim> {
    try {
      // If GET comes back empty the lock expired in between; try once more.
      for (let i = 0; i < 2; i++) {
        const acquired = await this.redis.set(
          key,
          PROCESSING,
          'EX',
          this.config.idempotency.lockTtlSeconds,
          'NX',
        );
        if (acquired === 'OK') return { state: 'acquired' };

        const value = await this.redis.get(key);
        if (value?.startsWith(DONE_PREFIX)) {
          return { state: 'completed', eventId: value.slice(DONE_PREFIX.length) };
        }
        if (value === PROCESSING) return { state: 'in_progress' };
      }
      return { state: 'in_progress' };
    } catch (err) {
      this.logger.warn(
        `Redis unavailable, idempotency falls back to Postgres: ${errorMessage(err)}`,
      );
      return { state: 'unavailable' };
    }
  }

  async complete(key: string, eventId: string): Promise<void> {
    try {
      await this.redis.set(key, DONE_PREFIX + eventId, 'EX', this.config.idempotency.ttlSeconds);
    } catch (err) {
      this.logger.warn(`Could not complete idempotency key ${key}: ${errorMessage(err)}`);
    }
  }

  async release(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Could not release idempotency key ${key}: ${errorMessage(err)}`);
    }
  }
}
