import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IngestService } from './ingest.service';

@Controller('hooks')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /**
   * 202: stored, delivery happens in the background.
   * 200: this event was received before (duplicate); the provider stops retrying.
   */
  @Post(':source')
  async receive(
    @Param('source') source: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // /hooks is read as a raw body (see common/http.ts); with an empty body it is not a Buffer.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await this.ingest.ingest(source, rawBody, req.headers);

    if (result.outcome === 'duplicate') {
      res.status(200);
      return { id: result.eventId, status: 'duplicate' };
    }
    res.status(202);
    return { id: result.eventId, status: 'accepted' };
  }
}
