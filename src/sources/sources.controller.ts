import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/auth/api-key.guard';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { createSourceSchema, SourcesService, type CreateSourceDto } from './sources.service';

@Controller('sources')
@UseGuards(ApiKeyGuard)
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Post()
  create(@Body(new ZodValidationPipe(createSourceSchema)) dto: CreateSourceDto) {
    return this.sources.create(dto);
  }

  @Get()
  list() {
    return this.sources.list();
  }
}
