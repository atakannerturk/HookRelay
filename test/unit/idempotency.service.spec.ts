import type Redis from 'ioredis';
import type { AppConfig } from '../../src/common/config/config';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';

/** In-memory stand-in for the Redis commands the service uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  down = false;

  async set(key: string, value: string, _ex: 'EX', _ttl: number, mode?: 'NX') {
    this.assertUp();
    if (mode === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string) {
    this.assertUp();
    return this.store.get(key) ?? null;
  }

  async del(key: string) {
    this.assertUp();
    return this.store.delete(key) ? 1 : 0;
  }

  private assertUp() {
    if (this.down) throw new Error('ECONNREFUSED');
  }
}

describe('IdempotencyService', () => {
  const config = { idempotency: { ttlSeconds: 3600, lockTtlSeconds: 30 } } as AppConfig;
  let redis: FakeRedis;
  let service: IdempotencyService;
  const key = 'hookrelay:idem:source:evt_1';

  beforeEach(() => {
    redis = new FakeRedis();
    service = new IdempotencyService(redis as unknown as Redis, config);
  });

  it('builds a key per source and external id', () => {
    expect(service.key('src', 'evt_1')).toBe('hookrelay:idem:src:evt_1');
  });

  it('acquires the key for the first request', async () => {
    await expect(service.claim(key)).resolves.toEqual({ state: 'acquired' });
  });

  it('reports in_progress while the first request is still processing', async () => {
    await service.claim(key);
    await expect(service.claim(key)).resolves.toEqual({ state: 'in_progress' });
  });

  it('reports completed with the stored event id afterwards', async () => {
    await service.claim(key);
    await service.complete(key, 'event-42');
    await expect(service.claim(key)).resolves.toEqual({ state: 'completed', eventId: 'event-42' });
  });

  it('lets the provider retry after a released (failed) attempt', async () => {
    await service.claim(key);
    await service.release(key);
    await expect(service.claim(key)).resolves.toEqual({ state: 'acquired' });
  });

  it('degrades to unavailable instead of failing when Redis is down', async () => {
    redis.down = true;
    await expect(service.claim(key)).resolves.toEqual({ state: 'unavailable' });
    await expect(service.complete(key, 'e')).resolves.toBeUndefined();
    await expect(service.release(key)).resolves.toBeUndefined();
  });
});
