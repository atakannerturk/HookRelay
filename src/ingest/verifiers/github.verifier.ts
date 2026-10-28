import { hmacSha256Hex, safeEqual } from '../../common/crypto';
import { header, type IncomingWebhook, type WebhookVerifier } from './webhook-verifier';

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256(secret, rawBody).
 * The event id is in `X-GitHub-Delivery`, the type in `X-GitHub-Event`.
 */
export class GithubVerifier implements WebhookVerifier {
  verify(webhook: IncomingWebhook, secret: string): boolean {
    const signature = header(webhook, 'x-hub-signature-256');
    if (!signature?.startsWith('sha256=')) return false;
    return safeEqual(signature.slice('sha256='.length), hmacSha256Hex(secret, webhook.rawBody));
  }

  eventId(webhook: IncomingWebhook): string | undefined {
    return header(webhook, 'x-github-delivery');
  }

  eventType(webhook: IncomingWebhook): string | undefined {
    return header(webhook, 'x-github-event');
  }
}
