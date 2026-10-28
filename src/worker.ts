import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig, loadDotEnv } from './common/config/config';
import { createLogger } from './common/logger/logger';

/**
 * A process without an HTTP server that runs only the delivery worker and recovery.
 * It scales independently of the API: add worker replicas when load grows.
 */
async function bootstrap(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config.log);

  if (!config.worker.enabled) {
    logger.error('The worker process cannot start with WORKER_ENABLED=false', 'Bootstrap');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger });
  app.enableShutdownHooks();
  logger.log('HookRelay worker running', 'Bootstrap');
}

void bootstrap();
