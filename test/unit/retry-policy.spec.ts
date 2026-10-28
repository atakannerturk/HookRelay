import { classifyStatus, RetryPolicy } from '../../src/delivery/retry-policy';

describe('RetryPolicy', () => {
  const policy = new RetryPolicy(5, [1_000, 5_000, 30_000, 300_000]);

  it('follows the delay table after each failed attempt', () => {
    expect([1, 2, 3, 4].map((attempt) => policy.delayAfter(attempt))).toEqual([
      1_000, 5_000, 30_000, 300_000,
    ]);
  });

  it('keeps using the last delay when attempts exceed the table', () => {
    expect(policy.delayAfter(9)).toBe(300_000);
  });

  it('treats the 5th attempt as the final one', () => {
    expect(policy.isFinal(4)).toBe(false);
    expect(policy.isFinal(5)).toBe(true);
  });

  it('spreads delays by ±jitter', () => {
    const jittered = new RetryPolicy(5, [1_000], 0.2);
    expect(jittered.delayAfter(1, () => 0)).toBe(800);
    expect(jittered.delayAfter(1, () => 0.5)).toBe(1_000);
    expect(jittered.delayAfter(1, () => 1)).toBe(1_200);
  });

  it('rejects an empty delay table', () => {
    expect(() => new RetryPolicy(5, [])).toThrow();
  });
});

describe('classifyStatus', () => {
  it.each([
    [200, 'success'],
    [204, 'success'],
    [301, 'permanent'],
    [400, 'permanent'],
    [401, 'permanent'],
    [404, 'permanent'],
    [408, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
  ])('HTTP %i -> %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});
