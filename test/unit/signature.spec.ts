import { signPayload, verifySignature } from '../../src/delivery/signature';

describe('outgoing signature', () => {
  const secret = 'whsec_test';
  const body = '{"hello":"world"}';
  const now = 1_700_000_000;
  const header = signPayload(secret, body, now);

  it('has the t=<timestamp>,v1=<hex> format', () => {
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('verifies with the same secret and body', () => {
    expect(verifySignature(secret, body, header, 300, now * 1000)).toBe(true);
  });

  it('fails for another secret, a modified body or an expired timestamp', () => {
    expect(verifySignature('other', body, header, 300, now * 1000)).toBe(false);
    expect(verifySignature(secret, body + ' ', header, 300, now * 1000)).toBe(false);
    expect(verifySignature(secret, body, header, 300, (now + 301) * 1000)).toBe(false);
  });

  it('fails for a malformed header', () => {
    expect(verifySignature(secret, body, 'v1=abc', 300, now * 1000)).toBe(false);
    expect(verifySignature(secret, body, '', 300, now * 1000)).toBe(false);
  });
});
