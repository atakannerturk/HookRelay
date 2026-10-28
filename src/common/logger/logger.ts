import { ConsoleLogger, LogLevel } from '@nestjs/common';
import type { AppConfig } from '../config/config';

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/**
 * Nest's built-in logger. With LOG_JSON=true every line is a single JSON object
 * (for Docker / log collectors); otherwise it prints colored, human-readable output.
 */
export function createLogger(options: AppConfig['log']): ConsoleLogger {
  return new ConsoleLogger({
    json: options.json,
    colors: !options.json,
    logLevels: LEVELS.slice(0, LEVELS.indexOf(options.level) + 1),
  });
}
