import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { safeEqual } from '../crypto';

/** Protects the admin endpoints: requires an `x-api-key: <ADMIN_API_KEY>` header. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-api-key');
    if (!provided || !safeEqual(provided, this.config.adminApiKey)) {
      throw new UnauthorizedException('Missing or invalid x-api-key header');
    }
    return true;
  }
}
