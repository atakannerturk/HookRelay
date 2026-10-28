import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG } from '../common/config/config.module';
import type { AppConfig } from '../common/config/config';
import { errorMessage } from '../common/errors';
import { redisOptionsFromUrl } from '../common/redis/redis.module';
import {
  DELIVERY_JOB,
  DELIVERY_QUEUE,
  deliveryJobId,
  type DeliveryJobData,
} from './delivery.constants';

const ENQUEUE_TIMEOUT_MS = 2_000;

export interface QueueableDelivery {
  id: string;
  replayCount: number;
}

/**
 * The queue is only a scheduler; Postgres is the source of truth. If enqueueing fails the
 * delivery stays PENDING in the database and DeliveryRecovery adds it again later.
 */
@Injectable()
export class DeliveryQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryQueue.name);
  readonly queue: Queue<DeliveryJobData>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.queue = new Queue<DeliveryJobData>(DELIVERY_QUEUE, {
      // Without Redis, fail immediately instead of waiting (don't leave the request hanging).
      connection: { ...redisOptionsFromUrl(config.redisUrl), enableOfflineQueue: false },
    });
    this.queue.on('error', (err) =>
      this.logger.warn(`Queue connection error: ${errorMessage(err)}`),
    );
  }

  async onModuleInit(): Promise<void> {
    await withTimeout(this.queue.waitUntilReady(), 5_000).catch((err) =>
      this.logger.warn(
        `Redis not ready, deliveries will be enqueued by recovery: ${errorMessage(err)}`,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /** Never throws: on false the deliveries will be picked up by recovery. */
  async enqueue(deliveries: QueueableDelivery[]): Promise<boolean> {
    if (deliveries.length === 0) return true;
    try {
      await withTimeout(
        this.queue.addBulk(
          deliveries.map((d) => ({
            name: DELIVERY_JOB,
            data: { deliveryId: d.id, replayCount: d.replayCount },
            opts: this.jobOptions(d),
          })),
        ),
        ENQUEUE_TIMEOUT_MS,
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `Could not enqueue ${deliveries.length} deliveries, recovery will take over: ${errorMessage(err)}`,
      );
      return false;
    }
  }

  /** Enqueues the deliveries that have no job in the queue; returns how many were added. */
  async enqueueMissing(deliveries: QueueableDelivery[]): Promise<number> {
    const missing: QueueableDelivery[] = [];
    for (const delivery of deliveries) {
      const job = await this.queue.getJob(deliveryJobId(delivery.id, delivery.replayCount));
      if (!job) missing.push(delivery);
    }
    if (missing.length > 0 && !(await this.enqueue(missing))) return 0;
    return missing.length;
  }

  private jobOptions(delivery: QueueableDelivery) {
    return {
      jobId: deliveryJobId(delivery.id, delivery.replayCount),
      attempts: this.config.delivery.maxAttempts,
      // The delay is computed by the worker's custom backoffStrategy (see DeliveryWorker).
      backoff: { type: 'hookrelay' },
      // Attempt history lives in Postgres; no need to keep finished jobs in Redis.
      removeOnComplete: true,
      removeOnFail: true,
    };
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
