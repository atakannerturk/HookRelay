import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { GenericVerifier } from '../../src/ingest/verifiers/generic.verifier';
import { GithubVerifier } from '../../src/ingest/verifiers/github.verifier';
import { StripeVerifier } from '../../src/ingest/verifiers/stripe.verifier';
import type { IncomingWebhook } from '../../src/ingest/verifiers/webhook-verifier';

const SECRET = 'top-secret';
const BODY = JSON.stringify({ id: 'evt_123', type: 'invoice.paid' });
const hmac = (data: string, secret = SECRET) =>
  createHmac('sha256', secret).update(data).digest('hex');

function webhook(headers: IncomingHttpHeaders, body = BODY): IncomingWebhook {
  return { rawBody: Buffer.from(body), headers, json: JSON.parse(body) };
}

describe('GithubVerifier', () => {
  const verifier = new GithubVerifier();
  const headers = {
    'x-hub-signature-256': `sha256=${hmac(BODY)}`,
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'push',
  };

  it('accepts a valid signature', () => {
    expect(verifier.verify(webhook(headers), SECRET)).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    const wrong = { ...headers, 'x-hub-signature-256': `sha256=${hmac(BODY, 'other')}` };
    expect(verifier.verify(webhook(wrong), SECRET)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifier.verify(webhook(headers, BODY.replace('123', '124')), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifier.verify(webhook({}), SECRET)).toBe(false);
    expect(verifier.verify(webhook({ 'x-hub-signature-256': hmac(BODY) }), SECRET)).toBe(false);
  });

  it('reads event id and type from GitHub headers', () => {
    expect(verifier.eventId(webhook(headers))).toBe('delivery-1');
    expect(verifier.eventType(webhook(headers))).toBe('push');
  });
});

describe('StripeVerifier', () => {
  const now = 1_700_000_000;
  const verifier = new StripeVerifier(300, () => now * 1000);
  const sign = (t: number, secret = SECRET) => `t=${t},v1=${hmac(`${t}.${BODY}`, secret)}`;

  it('accepts a valid signature inside the tolerance window', () => {
    expect(verifier.verify(webhook({ 'stripe-signature': sign(now - 60) }), SECRET)).toBe(true);
  });

  it('rejects an old timestamp (replay attack)', () => {
    expect(verifier.verify(webhook({ 'stripe-signature': sign(now - 301) }), SECRET)).toBe(false);
  });

  it('accepts when any of several v1 signatures matches (secret rotation)', () => {
    const header = `t=${now},v1=${hmac(`${now}.${BODY}`, 'old-secret')},v1=${hmac(`${now}.${BODY}`)}`;
    expect(verifier.verify(webhook({ 'stripe-signature': header }), SECRET)).toBe(true);
  });

  it('rejects a wrong secret and malformed headers', () => {
    expect(verifier.verify(webhook({ 'stripe-signature': sign(now, 'x') }), SECRET)).toBe(false);
    expect(verifier.verify(webhook({ 'stripe-signature': 'garbage' }), SECRET)).toBe(false);
    expect(verifier.verify(webhook({}), SECRET)).toBe(false);
  });

  it('reads event id and type from the JSON body', () => {
    expect(verifier.eventId(webhook({}))).toBe('evt_123');
    expect(verifier.eventType(webhook({}))).toBe('invoice.paid');
  });
});

describe('GenericVerifier', () => {
  const verifier = new GenericVerifier();

  it('accepts the signature with or without the sha256= prefix', () => {
    expect(verifier.verify(webhook({ 'x-signature': `sha256=${hmac(BODY)}` }), SECRET)).toBe(true);
    expect(verifier.verify(webhook({ 'x-signature': hmac(BODY) }), SECRET)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifier.verify(webhook({ 'x-signature': hmac(BODY, 'x') }), SECRET)).toBe(false);
  });

  it('prefers the X-Event-Id header, then Idempotency-Key, then body id', () => {
    expect(verifier.eventId(webhook({ 'x-event-id': 'h1', 'idempotency-key': 'h2' }))).toBe('h1');
    expect(verifier.eventId(webhook({ 'idempotency-key': 'h2' }))).toBe('h2');
    expect(verifier.eventId(webhook({}))).toBe('evt_123');
    expect(
      verifier.eventId({ rawBody: Buffer.from('plain'), headers: {}, json: undefined }),
    ).toBeUndefined();
  });
});
