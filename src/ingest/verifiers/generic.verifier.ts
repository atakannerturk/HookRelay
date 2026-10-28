import { hmacSha256Hex, safeEqual } from '../../common/crypto';
import { header, jsonField, type IncomingWebhook, type WebhookVerifier } from './webhook-verifier';

/**
 * A simple scheme for our own services: `X-Signature: sha256=<hex>` (prefix optional),
 * HMAC-SHA256(secret, rawBody). The event id comes from the `X-Event-Id` /
 * `Idempotency-Key` header or the `id` field of the body.
 */
export class GenericVerifier implements WebhookVerifier {
  verify(webhook: IncomingWebhook, secret: string): boolean {
    const value = header(webhook, 'x-signature');
    if (!value) return false;
    const signature = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
    return safeEqual(signature, hmacSha256Hex(secret, webhook.rawBody));
  }

  eventId(webhook: IncomingWebhook): string | undefined {
    return (
      header(webhook, 'x-event-id') ??
      header(webhook, 'idempotency-key') ??
      jsonField(webhook, 'id')
    );
  }

  eventType(webhook: IncomingWebhook): string | undefined {
    return header(webhook, 'x-event-type') ?? jsonField(webhook, 'type');
  }
}
