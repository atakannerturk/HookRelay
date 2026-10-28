import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../common/auth/api-key.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { EventsService, listEventsSchema, type ListEventsQuery } from './events.service';

@Controller('events')
@UseGuards(ApiKeyGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** GET /events?status=failed&source=github&limit=20&cursor=<id> */
  @Get()
  list(@Query(new ZodValidationPipe(listEventsSchema)) query: ListEventsQuery) {
    return this.events.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.events.get(id);
  }

  @Post(':id/replay')
  @HttpCode(202)
  replay(@Param('id', ParseUUIDPipe) id: string) {
    return this.events.replay(id);
  }
}
