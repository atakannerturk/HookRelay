import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../common/config/config.module';
import type { AppConfig } from '../common/config/config';
import { DeliveryProcessor } from './delivery.processor';
import { DeliveryQueue } from './delivery.queue';
import { DeliveryRecovery } from './delivery.recovery';
import { DeliveryWorker } from './delivery.worker';
import { HttpSender } from './http-sender';
import { RetryPolicy } from './retry-policy';

@Module({
  providers: [
    {
      provide: RetryPolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new RetryPolicy(
          config.delivery.maxAttempts,
          config.delivery.retryDelaysMs,
          config.delivery.retryJitter,
        ),
    },
    DeliveryQueue,
    HttpSender,
    DeliveryProcessor,
    DeliveryWorker,
    DeliveryRecovery,
  ],
  exports: [DeliveryQueue, DeliveryRecovery],
})
export class DeliveryModule {}
