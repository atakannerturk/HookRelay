import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { Destination, Source } from '../generated/prisma/client';
import { randomSecret } from '../common/crypto';
import { PrismaService } from '../common/prisma/prisma.service';

const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL');

export const createDestinationSchema = z.object({
  source: z.string().min(1),
  url: httpUrl,
  active: z.boolean().default(true),
});
export type CreateDestinationDto = z.output<typeof createDestinationSchema>;

export const updateDestinationSchema = z
  .object({ url: httpUrl.optional(), active: z.boolean().optional() })
  .refine((dto) => dto.url !== undefined || dto.active !== undefined, 'nothing to update');
export type UpdateDestinationDto = z.output<typeof updateDestinationSchema>;

export const listDestinationsSchema = z.object({ source: z.string().optional() });
export type ListDestinationsQuery = z.output<typeof listDestinationsSchema>;

@Injectable()
export class DestinationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDestinationDto) {
    const source = await this.prisma.source.findUnique({ where: { name: dto.source } });
    if (!source) throw new NotFoundException(`Unknown source "${dto.source}"`);

    const destination = await this.prisma.destination.create({
      data: { sourceId: source.id, url: dto.url, active: dto.active, secret: randomSecret() },
      include: { source: true },
    });
    return present(destination);
  }

  async list(query: ListDestinationsQuery) {
    const destinations = await this.prisma.destination.findMany({
      where: query.source ? { source: { name: query.source } } : undefined,
      include: { source: true },
      orderBy: { createdAt: 'asc' },
    });
    return destinations.map(present);
  }

  async update(id: string, dto: UpdateDestinationDto) {
    const exists = await this.prisma.destination.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`Destination ${id} not found`);

    const destination = await this.prisma.destination.update({
      where: { id },
      data: { url: dto.url, active: dto.active },
      include: { source: true },
    });
    return present(destination);
  }
}

/**
 * The destination needs `secret` to verify the X-HookRelay-Signature header; it is returned
 * in plain text because the admin API is protected by x-api-key.
 */
function present(destination: Destination & { source: Source }) {
  return {
    id: destination.id,
    source: destination.source.name,
    url: destination.url,
    active: destination.active,
    secret: destination.secret,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  };
}
