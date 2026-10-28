import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { loadConfig } from '../../src/common/config/config';
import { configureHttp } from '../../src/common/http';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS } from '../../src/common/redis/redis.module';
import { DeliveryQueue } from '../../src/delivery/delivery.queue';
import { DeliveryRecovery } from '../../src/delivery/delivery.recovery';
import { TEST_ADMIN_KEY } from './test-env';

/** Programmable destination server: tests decide the next response codes. */
export class TestReceiver {
  readonly requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  url = '';
  private scripted: number[] = [];
  private fallback = 200;
  private readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      this.requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(this.scripted.shift() ?? this.fallback).end('receiver says hi');
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }

  /** Answer the next requests with these codes in order, then go back to the fallback. */
  respondWith(...statuses: number[]): void {
    this.scripted.push(...statuses);
  }

  /** Code to answer with once the scripted list is used up. */
  alwaysRespond(status: number): void {
    this.fallback = status;
  }

  reset(): void {
    this.requests.length = 0;
    this.scripted = [];
    this.fallback = 200;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  queue: DeliveryQueue;
  recovery: DeliveryRecovery;
  receiver: TestReceiver;
}

export async function createTestContext(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureHttp(app, loadConfig());
  // Given a listening server, supertest does not open a new one for every request.
  await app.listen(0, '127.0.0.1');

  const receiver = new TestReceiver();
  await receiver.start();
  return {
    app,
    prisma: app.get(PrismaService),
    redis: app.get<Redis>(REDIS),
    queue: app.get(DeliveryQueue),
    recovery: app.get(DeliveryRecovery),
    receiver,
  };
}

export async function closeTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.receiver.stop();
}

export async function resetState(ctx: TestContext): Promise<void> {
  await ctx.queue.queue.drain(true);
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE delivery_attempts, deliveries, events, destinations, sources CASCADE',
  );
  const keys = await ctx.redis.keys('hookrelay:idem:*');
  if (keys.length > 0) await ctx.redis.del(...keys);
  ctx.receiver.reset();
}

export const admin = (ctx: TestContext) => ({
  get: (path: string) =>
    request(ctx.app.getHttpServer()).get(path).set('x-api-key', TEST_ADMIN_KEY),
  post: (path: string, body?: object) =>
    request(ctx.app.getHttpServer()).post(path).set('x-api-key', TEST_ADMIN_KEY).send(body),
  patch: (path: string, body: object) =>
    request(ctx.app.getHttpServer()).patch(path).set('x-api-key', TEST_ADMIN_KEY).send(body),
});

export const SOURCE_SECRET = 'source-secret-123';

/** Creates a source plus a destination pointing at the test receiver; returns its signing secret. */
export async function setupSource(
  ctx: TestContext,
  name = 'shop',
  scheme: 'generic' | 'github' | 'stripe' = 'generic',
  url = ctx.receiver.url,
): Promise<{ destinationId: string; destinationSecret: string }> {
  await admin(ctx).post('/sources', { name, scheme, secret: SOURCE_SECRET }).expect(201);
  const { body } = await admin(ctx).post('/destinations', { source: name, url }).expect(201);
  return { destinationId: body.id, destinationSecret: body.secret };
}

export const sign = (body: string, secret = SOURCE_SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

/** Sends a webhook signed with the generic scheme. */
export function sendWebhook(
  ctx: TestContext,
  payload: object,
  options: { source?: string; eventId?: string } = {},
) {
  const body = JSON.stringify(payload);
  const req = request(ctx.app.getHttpServer())
    .post(`/hooks/${options.source ?? 'shop'}`)
    .set('content-type', 'application/json')
    .set('x-signature', `sha256=${sign(body)}`);
  if (options.eventId) req.set('x-event-id', options.eventId);
  return req.send(body);
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Polls GET /events/:id until the event reaches the given status. */
export async function waitForEventStatus(ctx: TestContext, eventId: string, status: string) {
  return waitFor(
    async () => (await admin(ctx).get(`/events/${eventId}`).expect(200)).body,
    (event) => event.status === status,
  );
}
