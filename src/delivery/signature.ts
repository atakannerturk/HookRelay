import { hmacSha256Hex, safeEqual } from '../common/crypto';

export const SIGNATURE_HEADER = 'x-hookrelay-signature';

/**
 * Signature of an outgoing request: `t=<unix seconds>,v1=<hex>` where
 * v1 = HMAC-SHA256(destination.secret, `${t}.${body}`).
 * Because the timestamp is part of the signature, a captured request cannot be replayed
 * later (replay attack); the destination can reject old timestamps.
 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

/** Verification a destination can use (also used by the tests and the sample receiver). */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key, rest.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!Number.isInteger(timestamp) || !signature) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  return safeEqual(signature, hmacSha256Hex(secret, `${timestamp}.${body}`));
}
