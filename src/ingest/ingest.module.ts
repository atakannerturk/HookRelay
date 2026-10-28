import { Module } from '@nestjs/common';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { DeliveryModule } from '../delivery/delivery.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { VerifierRegistry } from './verifiers/verifier-registry';

@Module({
  imports: [DeliveryModule],
  controllers: [IngestController],
  providers: [IngestService, IdempotencyService, VerifierRegistry],
})
export class IngestModule {}
