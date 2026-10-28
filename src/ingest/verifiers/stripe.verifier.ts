import { hmacSha256Hex, safeEqual } from '../../common/crypto';
import { header, jsonField, type IncomingWebhook, type WebhookVerifier } from './webhook-verifier';

/**
 * Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`,
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). Requests whose timestamp is outside the
 * tolerance (5 min by default) are rejected, so a captured request cannot be replayed.
 * During secret rotation several v1 values may be present; one match is enough.
 */
export class StripeVerifier implements WebhookVerifier {
  constructor(
    private readonly toleranceSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  verify(webhook: IncomingWebhook, secret: string): boolean {
    const value = header(webhook, 'stripe-signature');
    if (!value) return false;

    let timestamp: number | undefined;
    const signatures: string[] = [];
    for (const part of value.split(',')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === 't') timestamp = Number(rest.join('='));
      if (key === 'v1') signatures.push(rest.join('='));
    }
    if (timestamp === undefined || !Number.isInteger(timestamp) || signatures.length === 0) {
      return false;
    }
    if (Math.abs(this.now() / 1000 - timestamp) > this.toleranceSeconds) return false;

    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`), webhook.rawBody]);
    const expected = hmacSha256Hex(secret, signedPayload);
    return signatures.some((signature) => safeEqual(signature, expected));
  }

  eventId(webhook: IncomingWebhook): string | undefined {
    return jsonField(webhook, 'id');
  }

  eventType(webhook: IncomingWebhook): string | undefined {
    return jsonField(webhook, 'type');
  }
}
