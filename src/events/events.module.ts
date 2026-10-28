import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [DeliveryModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
