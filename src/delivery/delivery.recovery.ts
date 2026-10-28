import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DeliveryStatus } from '../generated/prisma/client';
import { APP_CONFIG } from '../common/config/config.module';
import type { AppConfig } from '../common/config/config';
import { errorMessage } from '../common/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { DeliveryQueue } from './delivery.queue';

const BATCH_SIZE = 500;

/**
 * Recovery sweeper. If an event was written to Postgres but never made it into the queue
 * (Redis was briefly down, the process died at exactly that moment...), its delivery stays
 * PENDING in the database with no job in the queue. This service periodically finds such
 * deliveries and enqueues them again. Job ids are deterministic, so a job that is still in
 * the queue is never added twice.
 */
@Injectable()
export class DeliveryRecovery implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryRecovery.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly queue: DeliveryQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.worker.enabled) return;
    this.timer = setInterval(() => void this.runOnce(), this.config.recovery.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Returns the number of deliveries that were enqueued again. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - this.config.recovery.graceMs);
      const stale = await this.prisma.delivery.findMany({
        where: {
          status: DeliveryStatus.PENDING,
          OR: [{ nextAttemptAt: { lt: cutoff } }, { nextAttemptAt: null }],
        },
        select: { id: true, replayCount: true },
        orderBy: { nextAttemptAt: 'asc' },
        take: BATCH_SIZE,
      });
      const recovered = await this.queue.enqueueMissing(stale);
      if (recovered > 0) this.logger.warn(`Re-enqueued ${recovered} lost deliveries`);
      return recovered;
    } catch (err) {
      this.logger.error(`Recovery run failed: ${errorMessage(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
