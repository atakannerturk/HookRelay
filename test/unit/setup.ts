import { Logger } from '@nestjs/common';

// Keep the services' expected warning logs out of the test output.
Logger.overrideLogger(false);
