import { ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma, SignatureScheme, type Source } from '../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

export const createSourceSchema = z.object({
  /** Used in the URL: POST /hooks/:name */
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'lowercase letters, digits, "-" and "_" only'),
  scheme: z.enum(['github', 'stripe', 'generic']).default('generic'),
  secret: z.string().min(8).max(512),
});
export type CreateSourceDto = z.output<typeof createSourceSchema>;

const SCHEMES: Record<CreateSourceDto['scheme'], SignatureScheme> = {
  github: SignatureScheme.GITHUB,
  stripe: SignatureScheme.STRIPE,
  generic: SignatureScheme.GENERIC,
};

@Injectable()
export class SourcesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSourceDto) {
    try {
      const source = await this.prisma.source.create({
        data: { name: dto.name, scheme: SCHEMES[dto.scheme], secret: dto.secret },
      });
      return present(source);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Source "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  async list() {
    const sources = await this.prisma.source.findMany({ orderBy: { createdAt: 'asc' } });
    return sources.map(present);
  }
}

// The provider secret is never returned by the API; only its last 4 characters are shown.
function present(source: Source) {
  return {
    id: source.id,
    name: source.name,
    scheme: source.scheme.toLowerCase(),
    secretHint: `…${source.secret.slice(-4)}`,
    ingestPath: `/hooks/${source.name}`,
    createdAt: source.createdAt,
  };
}
