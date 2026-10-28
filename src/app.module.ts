import { Module } from '@nestjs/common';
import { ConfigModule } from './common/config/config.module';
import { HealthController } from './common/health/health.controller';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { DeliveryModule } from './delivery/delivery.module';
import { DestinationsModule } from './destinations/destinations.module';
import { EventsModule } from './events/events.module';
import { IngestModule } from './ingest/ingest.module';
import { SourcesModule } from './sources/sources.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    DeliveryModule,
    IngestModule,
    EventsModule,
    SourcesModule,
    DestinationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
