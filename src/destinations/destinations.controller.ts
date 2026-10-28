import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../common/auth/api-key.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import {
  createDestinationSchema,
  DestinationsService,
  listDestinationsSchema,
  updateDestinationSchema,
  type CreateDestinationDto,
  type ListDestinationsQuery,
  type UpdateDestinationDto,
} from './destinations.service';

@Controller('destinations')
@UseGuards(ApiKeyGuard)
export class DestinationsController {
  constructor(private readonly destinations: DestinationsService) {}

  @Post()
  create(@Body(new ZodValidationPipe(createDestinationSchema)) dto: CreateDestinationDto) {
    return this.destinations.create(dto);
  }

  @Get()
  list(@Query(new ZodValidationPipe(listDestinationsSchema)) query: ListDestinationsQuery) {
    return this.destinations.list(query);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateDestinationSchema)) dto: UpdateDestinationDto,
  ) {
    return this.destinations.update(id, dto);
  }
}
