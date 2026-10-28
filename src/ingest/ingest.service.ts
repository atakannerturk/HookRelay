import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { EventStatus, Prisma, type Source } from '../generated/prisma/client';
import { sha256Hex } from '../common/crypto';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { DeliveryQueue } from '../delivery/delivery.queue';
import { VerifierRegistry } from './verifiers/verifier-registry';
import type { IncomingWebhook, WebhookVerifier } from './verifiers/webhook-verifier';

export type IngestResult =
  | { outcome: 'accepted'; eventId: string; status: EventStatus }
  | { outcome: 'duplicate'; eventId: string };

/** Headers that are not stored (they may carry credentials). */
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization']);

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifiers: VerifierRegistry,
    private readonly idempotency: IdempotencyService,
    private readonly queue: DeliveryQueue,
  ) {}

  /**
   * Flow: find the source -> verify the signature -> idempotency lock -> store the event and
   * its deliveries in one write -> enqueue. A webhook is only accepted (202) once it is in
   * Postgres; even if enqueueing fails the event is not lost.
   */
  async ingest(
    sourceName: string,
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): Promise<IngestResult> {
    const source = await this.prisma.source.findUnique({ where: { name: sourceName } });
    if (!source) throw new NotFoundException(`Unknown source "${sourceName}"`);

    const webhook: IncomingWebhook = { rawBody, headers, json: parseJson(rawBody) };
    const verifier = this.verifiers.get(source.scheme);
    if (!verifier.verify(webhook, source.secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const externalId = verifier.eventId(webhook) ?? `sha256:${sha256Hex(rawBody)}`;
    const key = this.idempotency.key(source.id, externalId);
    const claim = await this.idempotency.claim(key);
    if (claim.state === 'completed') return { outcome: 'duplicate', eventId: claim.eventId };
    if (claim.state === 'in_progress') {
      throw new ConflictException('This event is already being processed, retry later');
    }

    let event: Awaited<ReturnType<IngestService['store']>>;
    try {
      event = await this.store(source, webhook, verifier, externalId);
    } catch (err) {
      // The Redis key expired or Redis was down: the Postgres unique constraint is the last line of defense.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.event.findUniqueOrThrow({
          where: { sourceId_externalId: { sourceId: source.id, externalId } },
          select: { id: true },
        });
        await this.idempotency.complete(key, existing.id);
        return { outcome: 'duplicate', eventId: existing.id };
      }
      // Not stored: release the lock so the provider's retry can be processed.
      if (claim.state === 'acquired') await this.idempotency.release(key);
      throw err;
    }

    await this.queue.enqueue(event.deliveries);
    await this.idempotency.complete(key, event.id);
    this.logger.log(
      `Event ${event.id} received (${source.name}, ${externalId}, ${event.deliveries.length} destinations)`,
    );
    return { outcome: 'accepted', eventId: event.id, status: event.status };
  }

  private async store(
    source: Source,
    webhook: IncomingWebhook,
    verifier: WebhookVerifier,
    externalId: string,
  ) {
    const destinations = await this.prisma.destination.findMany({
      where: { sourceId: source.id, active: true },
      select: { id: true },
    });
    const now = new Date();
    return this.prisma.event.create({
      data: {
        sourceId: source.id,
        externalId,
        eventType: verifier.eventType(webhook) ?? null,
        status: destinations.length > 0 ? EventStatus.PENDING : EventStatus.SKIPPED,
        contentType: headerValue(webhook.headers['content-type']) ?? 'application/octet-stream',
        headers: sanitizeHeaders(webhook.headers),
        payload: webhook.rawBody.toString('utf8'),
        deliveries: {
          create: destinations.map((d) => ({ destinationId: d.id, nextAttemptAt: now })),
        },
      },
      select: { id: true, status: true, deliveries: { select: { id: true, replayCount: true } } },
    });
  }
}

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const text = headerValue(value);
    if (text !== undefined && !DROPPED_HEADERS.has(name)) result[name] = text;
  }
  return result;
}
