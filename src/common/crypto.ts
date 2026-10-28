import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Constant-time comparison. Both sides are hashed first, so not even a length difference
 * leaks through timing (protects against timing attacks).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function randomSecret(prefix = 'whsec_'): string {
  return prefix + randomBytes(24).toString('base64url');
}
