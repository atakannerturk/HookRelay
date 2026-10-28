import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw, type ErrorRequestHandler, type RequestHandler } from 'express';
import type { AppConfig } from './config/config';

/**
 * Body parser setup. Requests under /hooks/* are read as RAW bytes: the HMAC signature is
 * computed over the exact bytes of the body, so parsing and re-serializing the JSON would
 * break it. The other (admin) endpoints get regular JSON parsing.
 */
export function configureHttp(app: NestExpressApplication, config: AppConfig): void {
  const rawBody = raw({ type: () => true, limit: config.maxBodyBytes });
  const jsonBody = json({ limit: '100kb' });
  const jsonExceptHooks: RequestHandler = (req, res, next) =>
    req.path.startsWith('/hooks/') ? next() : jsonBody(req, res, next);

  app.disable('x-powered-by');
  app.use('/hooks', rawBody);
  app.use(jsonExceptHooks);
  app.use(bodyParserErrors);
}

// Body parser errors happen before Nest is involved; answer with JSON instead of HTML.
const bodyParserErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === 'number' ? err.status : 500;
  const message =
    status === 413
      ? 'Payload too large'
      : status < 500
        ? 'Malformed request body'
        : 'Internal error';
  res.status(status).json({ statusCode: status, message });
};
