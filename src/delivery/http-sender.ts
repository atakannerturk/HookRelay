import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../common/config/config.module';
import type { AppConfig } from '../common/config/config';
import { classifyStatus } from './retry-policy';

export interface SendRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  /** Whether a failure is transient (should be retried) or permanent. */
  retryable: boolean;
  statusCode?: number;
  error?: string;
  durationMs: number;
}

const MAX_ERROR_BODY = 500;

@Injectable()
export class HttpSender {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(request: SendRequest): Promise<SendResult> {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        // Don't follow redirects: stops a destination from bouncing us into the internal network (SSRF).
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.delivery.timeoutMs),
      });
      // Always consume the body so the connection goes back to the pool.
      const text = await response.text().catch(() => '');
      const kind = classifyStatus(response.status);
      if (kind === 'success') {
        return { ok: true, retryable: false, statusCode: response.status, durationMs: elapsed() };
      }
      const snippet = text.trim().slice(0, MAX_ERROR_BODY);
      return {
        ok: false,
        retryable: kind === 'retryable',
        statusCode: response.status,
        error: `HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
        durationMs: elapsed(),
      };
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: describeError(err, this.config),
        durationMs: elapsed(),
      };
    }
  }
}

function describeError(err: unknown, config: AppConfig): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return `Timed out after ${config.delivery.timeoutMs}ms`;
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    return `Network error: ${cause?.code ?? cause?.message ?? err.message}`;
  }
  return `Network error: ${String(err)}`;
}
