import { Injectable } from '@nestjs/common';
import { DeliveryStatus, type Prisma } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { lockEvent, refreshEventStatus } from '../events/event-status';
import type { DeliveryJobData } from './delivery.constants';
import { HttpSender } from './http-sender';
import { RetryPolicy } from './retry-policy';
import { SIGNATURE_HEADER, signPayload } from './signature';

export type DeliveryOutcome =
  | { type: 'succeeded'; attempt: number }
  | { type: 'retry'; attempt: number; delayMs: number; error: string }
  | { type: 'dead'; attempt: number; error: string }
  | { type: 'skipped'; reason: string };

type AttemptLog = Omit<Prisma.DeliveryAttemptUncheckedCreateInput, 'deliveryId'>;

/**
 * Runs a single delivery attempt and writes the outcome to Postgres. It knows nothing about
 * BullMQ; DeliveryWorker decides how the outcome maps onto the queue.
 * The attempt counter lives in the database (not in BullMQ), so a delivery that recovery
 * re-enqueues is still attempted at most maxAttempts times in total.
 */
@Injectable()
export class DeliveryProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: HttpSender,
    private readonly policy: RetryPolicy,
  ) {}

  async handle(job: DeliveryJobData): Promise<DeliveryOutcome> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: job.deliveryId },
      include: { destination: true, event: { include: { source: { select: { name: true } } } } },
    });
    if (!delivery) return { type: 'skipped', reason: 'delivery not found' };
    if (delivery.status !== DeliveryStatus.PENDING) {
      return { type: 'skipped', reason: `delivery is already ${delivery.status}` };
    }
    if (delivery.replayCount !== job.replayCount) {
      return { type: 'skipped', reason: 'stale job from an earlier replay' };
    }

    const { event, destination } = delivery;
    const attempt = delivery.attempts + 1;

    if (!destination.active) {
      const error = 'Destination is disabled';
      await this.save(delivery.id, event.id, true, {
        status: DeliveryStatus.DEAD,
        deadAt: new Date(),
        nextAttemptAt: null,
        lastError: error,
      });
      return { type: 'dead', attempt: delivery.attempts, error };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const result = await this.sender.send({
      url: destination.url,
      body: event.payload,
      headers: {
        'content-type': event.contentType,
        'user-agent': 'HookRelay/1.0',
        'x-hookrelay-event-id': event.id,
        'x-hookrelay-delivery-id': delivery.id,
        'x-hookrelay-attempt': String(attempt),
        'x-hookrelay-source': event.source.name,
        ...(event.eventType ? { 'x-hookrelay-event-type': event.eventType } : {}),
        [SIGNATURE_HEADER]: signPayload(destination.secret, event.payload, timestamp),
      },
    });

    const log: AttemptLog = {
      number: attempt,
      replayCount: delivery.replayCount,
      statusCode: result.statusCode ?? null,
      error: result.error ?? null,
      durationMs: result.durationMs,
    };

    if (result.ok) {
      await this.save(
        delivery.id,
        event.id,
        true,
        {
          status: DeliveryStatus.SUCCEEDED,
          attempts: attempt,
          deliveredAt: new Date(),
          nextAttemptAt: null,
          lastStatusCode: result.statusCode ?? null,
          lastError: null,
        },
        log,
      );
      return { type: 'succeeded', attempt };
    }

    const error = result.error ?? 'Unknown error';
    if (!result.retryable || this.policy.isFinal(attempt)) {
      await this.save(
        delivery.id,
        event.id,
        true,
        {
          status: DeliveryStatus.DEAD,
          attempts: attempt,
          deadAt: new Date(),
          nextAttemptAt: null,
          lastStatusCode: result.statusCode ?? null,
          lastError: error,
        },
        log,
      );
      return { type: 'dead', attempt, error };
    }

    const delayMs = this.policy.delayAfter(attempt);
    await this.save(
      delivery.id,
      event.id,
      false,
      {
        attempts: attempt,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lastStatusCode: result.statusCode ?? null,
        lastError: error,
      },
      log,
    );
    return { type: 'retry', attempt, delayMs, error };
  }

  /** Attempt log + delivery update + (when finished) event status, in one transaction. */
  private async save(
    deliveryId: string,
    eventId: string,
    finished: boolean,
    data: Prisma.DeliveryUpdateInput,
    log?: AttemptLog,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockEvent(tx, eventId);
      if (log) await tx.deliveryAttempt.create({ data: { ...log, deliveryId } });
      await tx.delivery.update({ where: { id: deliveryId }, data });
      if (finished) await refreshEventStatus(tx, eventId);
    });
  }
}
