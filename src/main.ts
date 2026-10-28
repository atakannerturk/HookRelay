import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig, loadDotEnv } from './common/config/config';
import { configureHttp } from './common/http';
import { createLogger } from './common/logger/logger';

/** HTTP API. With WORKER_ENABLED=true the delivery worker runs in the same process. */
async function bootstrap(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config.log);

  // bodyParser: false -> configureHttp sets up the parsers (/hooks gets the raw body).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    bodyParser: false,
  });
  configureHttp(app, config);
  app.enableShutdownHooks();

  await app.listen(config.port);
  logger.log(
    `HookRelay API listening on port ${config.port} (worker: ${config.worker.enabled ? 'on' : 'off'})`,
    'Bootstrap',
  );
}

void bootstrap();
