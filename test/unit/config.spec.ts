import { loadConfig } from '../../src/common/config/config';

const required = { DATABASE_URL: 'postgresql://localhost/db', ADMIN_API_KEY: 'a-long-key' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(required);
    expect(config.port).toBe(3000);
    expect(config.worker).toEqual({ enabled: true, concurrency: 10 });
    expect(config.delivery.maxAttempts).toBe(5);
    expect(config.delivery.retryDelaysMs).toEqual([1_000, 5_000, 30_000, 300_000]);
  });

  it('parses booleans and lists from strings', () => {
    const config = loadConfig({
      ...required,
      WORKER_ENABLED: 'false',
      LOG_JSON: '1',
      DELIVERY_RETRY_DELAYS_MS: '10, 20,30',
    });
    expect(config.worker.enabled).toBe(false);
    expect(config.log.json).toBe(true);
    expect(config.delivery.retryDelaysMs).toEqual([10, 20, 30]);
  });

  it('fails fast with every invalid variable listed', () => {
    expect(() => loadConfig({ DELIVERY_RETRY_DELAYS_MS: '1,abc' })).toThrow(
      /DATABASE_URL[\s\S]*ADMIN_API_KEY[\s\S]*DELIVERY_RETRY_DELAYS_MS/,
    );
  });
});
