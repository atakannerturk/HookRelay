import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  DeliveryStatus,
  EventStatus,
  type Delivery,
  type DeliveryAttempt,
  type Destination,
  type Event,
  type Prisma,
  type Source,
} from '../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { DeliveryQueue } from '../delivery/delivery.queue';
import { lockEvent } from './event-status';

export const listEventsSchema = z.object({
  status: z.enum(['pending', 'delivered', 'failed', 'skipped']).optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** nextCursor of the previous page. */
  cursor: z.uuid().optional(),
});
export type ListEventsQuery = z.output<typeof listEventsSchema>;

const STATUS_FILTER: Record<NonNullable<ListEventsQuery['status']>, EventStatus> = {
  pending: EventStatus.PENDING,
  delivered: EventStatus.DELIVERED,
  failed: EventStatus.FAILED,
  skipped: EventStatus.SKIPPED,
};

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DeliveryQueue,
  ) {}

  /** `status=failed` is the dead-letter list: events with a delivery that ran out of attempts. */
  async list(query: ListEventsQuery) {
    const where: Prisma.EventWhereInput = {
      status: query.status ? STATUS_FILTER[query.status] : undefined,
      source: query.source ? { name: query.source } : undefined,
    };
    const rows = await this.prisma.event.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        source: true,
        deliveries: { include: { destination: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((event) => presentEvent(event)),
      nextCursor: rows.length > query.limit ? page[page.length - 1].id : null,
    };
  }

  async get(id: string) {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: {
        source: true,
        deliveries: {
          include: { destination: true, attemptLogs: { orderBy: { createdAt: 'asc' } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return {
      ...presentEvent(event),
      contentType: event.contentType,
      headers: event.headers,
      payload: event.payload,
    };
  }

  /**
   * Retries the dead-lettered deliveries in a fresh round: the attempt counter is reset and
   * replayCount goes up (new job id). Deliveries that already succeeded are not re-sent.
   */
  async replay(id: string) {
    const deliveries = await this.prisma.$transaction(async (tx) => {
      if (!(await lockEvent(tx, id))) throw new NotFoundException(`Event ${id} not found`);

      const dead = await tx.delivery.findMany({
        where: { eventId: id, status: DeliveryStatus.DEAD },
        select: { id: true },
      });
      if (dead.length === 0) {
        throw new ConflictException('Only failed events can be replayed');
      }

      const now = new Date();
      const replayed = [];
      for (const { id: deliveryId } of dead) {
        replayed.push(
          await tx.delivery.update({
            where: { id: deliveryId },
            data: {
              status: DeliveryStatus.PENDING,
              attempts: 0,
              replayCount: { increment: 1 },
              nextAttemptAt: now,
              deadAt: null,
            },
            select: { id: true, replayCount: true },
          }),
        );
      }
      await tx.event.update({ where: { id }, data: { status: EventStatus.PENDING } });
      return replayed;
    });

    await this.queue.enqueue(deliveries);
    return { id, status: 'pending', replayedDeliveries: deliveries.length };
  }
}

type EventWithDeliveries = Event & {
  source: Source;
  deliveries: (Delivery & { destination: Destination; attemptLogs?: DeliveryAttempt[] })[];
};

function presentEvent(event: EventWithDeliveries) {
  return {
    id: event.id,
    source: event.source.name,
    externalId: event.externalId,
    eventType: event.eventType,
    status: event.status.toLowerCase(),
    receivedAt: event.receivedAt,
    deliveries: event.deliveries.map((delivery) => ({
      id: delivery.id,
      destinationId: delivery.destinationId,
      url: delivery.destination.url,
      status: delivery.status.toLowerCase(),
      attempts: delivery.attempts,
      replayCount: delivery.replayCount,
      lastStatusCode: delivery.lastStatusCode,
      lastError: delivery.lastError,
      nextAttemptAt: delivery.status === DeliveryStatus.PENDING ? delivery.nextAttemptAt : null,
      deliveredAt: delivery.deliveredAt,
      deadAt: delivery.deadAt,
      ...(delivery.attemptLogs
        ? {
            attemptLog: delivery.attemptLogs.map((a) => ({
              number: a.number,
              replayCount: a.replayCount,
              statusCode: a.statusCode,
              error: a.error,
              durationMs: a.durationMs,
              at: a.createdAt,
            })),
          }
        : {}),
    })),
  };
}
