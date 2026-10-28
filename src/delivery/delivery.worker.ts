import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { APP_CONFIG } from '../common/config/config.module';
import type { AppConfig } from '../common/config/config';
import { errorMessage } from '../common/errors';
import { redisOptionsFromUrl } from '../common/redis/redis.module';
import { DELIVERY_QUEUE, type DeliveryJobData } from './delivery.constants';
import { DeliveryProcessor, type DeliveryOutcome } from './delivery.processor';
import { RetryPolicy } from './retry-policy';

/** Carries the delay computed by the processor over to BullMQ (see backoffStrategy). */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

/**
 * The BullMQ worker. Translates outcomes into queue semantics:
 *  - retry -> RetryLaterError: BullMQ runs the job again after delayMs
 *  - dead  -> UnrecoverableError: BullMQ stops retrying (the delivery is DEAD in the database)
 * If the processor itself throws (e.g. the database is unreachable), BullMQ retries with the
 * regular backoff; if those attempts run out too, the delivery stays PENDING and recovery
 * takes over.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryWorker.name);
  private worker?: Worker<DeliveryJobData, DeliveryOutcome>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processor: DeliveryProcessor,
    private readonly policy: RetryPolicy,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.worker.enabled) {
      this.logger.log('Worker disabled in this process (WORKER_ENABLED=false)');
      return;
    }
    this.worker = new Worker<DeliveryJobData, DeliveryOutcome>(
      DELIVERY_QUEUE,
      (job) => this.process(job),
      {
        connection: { ...redisOptionsFromUrl(this.config.redisUrl), maxRetriesPerRequest: null },
        concurrency: this.config.worker.concurrency,
        settings: {
          backoffStrategy: (attemptsMade, _type, err) =>
            err instanceof RetryLaterError ? err.delayMs : this.policy.delayAfter(attemptsMade),
        },
      },
    );
    this.worker.on('error', (err) => this.logger.warn(`Worker error: ${errorMessage(err)}`));
    this.logger.log(`Worker started (concurrency=${this.config.worker.concurrency})`);
  }

  // Graceful shutdown: stop taking new jobs and wait for the running ones to finish.
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<DeliveryJobData>): Promise<DeliveryOutcome> {
    const outcome = await this.processor.handle(job.data);
    const ref = `Delivery ${job.data.deliveryId}`;
    switch (outcome.type) {
      case 'succeeded':
        this.logger.log(`${ref} delivered (attempt ${outcome.attempt})`);
        return outcome;
      case 'skipped':
        this.logger.debug(`${ref} skipped: ${outcome.reason}`);
        return outcome;
      case 'retry':
        this.logger.warn(
          `${ref} attempt ${outcome.attempt} failed (${outcome.error}); retrying in ${outcome.delayMs}ms`,
        );
        throw new RetryLaterError(outcome.error, outcome.delayMs);
      case 'dead':
        this.logger.error(
          `${ref} moved to dead-letter (attempt ${outcome.attempt}): ${outcome.error}`,
        );
        throw new UnrecoverableError(outcome.error);
    }
  }
}
