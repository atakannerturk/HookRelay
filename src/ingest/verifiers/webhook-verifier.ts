import type { IncomingHttpHeaders } from 'node:http';

export interface IncomingWebhook {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  /** The parsed body if it is JSON, otherwise undefined. */
  json: unknown;
}

/**
 * Every provider sends its signature in a different header and format (Strategy pattern).
 * Adding a provider = adding a class that implements this interface.
 */
export interface WebhookVerifier {
  verify(webhook: IncomingWebhook, secret: string): boolean;
  /** The provider's event id, used for idempotency. Falls back to a hash of the body. */
  eventId(webhook: IncomingWebhook): string | undefined;
  eventType(webhook: IncomingWebhook): string | undefined;
}

export function header(webhook: IncomingWebhook, name: string): string | undefined {
  const value = webhook.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function jsonField(webhook: IncomingWebhook, field: string): string | undefined {
  const json = webhook.json;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const value = (json as Record<string, unknown>)[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}
