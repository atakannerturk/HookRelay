import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';

@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  // Workers shut down in onModuleDestroy; the DB connection must be the last thing to close.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
