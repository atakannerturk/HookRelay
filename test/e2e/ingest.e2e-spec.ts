import request from 'supertest';
import { verifySignature } from '../../src/delivery/signature';
import {
  admin,
  closeTestContext,
  createTestContext,
  resetState,
  sendWebhook,
  setupSource,
  sign,
  TestReceiver,
  waitForEventStatus,
  type TestContext,
} from './helpers';

describe('Ingest (e2e)', () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await closeTestContext(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('reports database and redis health', async () => {
    const res = await http().get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('protects admin endpoints with x-api-key', async () => {
    await http().get('/events').expect(401);
    await http().get('/events').set('x-api-key', 'wrong-key').expect(401);
    await admin(ctx).get('/events').expect(200);
  });

  it('validates admin payloads', async () => {
    await admin(ctx).post('/sources', { name: 'Bad Name!', secret: 'short' }).expect(400);
    await admin(ctx).post('/destinations', { source: 'x', url: 'ftp://example.com' }).expect(400);
    await admin(ctx).get('/events?status=bogus').expect(400);
  });

  it('accepts a signed GitHub webhook and forwards it byte-for-byte, signed by HookRelay', async () => {
    const { destinationSecret } = await setupSource(ctx, 'github', 'github');
    // Unusual whitespace proves the body is forwarded without being re-serialized.
    const body = '{"action":"opened",   "issue": {"number": 1}}';

    const res = await http()
      .post('/hooks/github')
      .set('content-type', 'application/json')
      .set('x-github-event', 'issues')
      .set('x-github-delivery', 'gh-delivery-1')
      .set('x-hub-signature-256', `sha256=${sign(body)}`)
      .send(body)
      .expect(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'accepted' });

    const event = await waitForEventStatus(ctx, res.body.id, 'delivered');
    expect(event).toMatchObject({
      source: 'github',
      externalId: 'gh-delivery-1',
      eventType: 'issues',
      payload: body,
    });

    expect(ctx.receiver.requests).toHaveLength(1);
    const [forwarded] = ctx.receiver.requests;
    expect(forwarded.body).toBe(body);
    expect(forwarded.headers).toMatchObject({
      'content-type': 'application/json',
      'x-hookrelay-event-id': res.body.id,
      'x-hookrelay-event-type': 'issues',
      'x-hookrelay-source': 'github',
      'x-hookrelay-attempt': '1',
    });
    const signature = String(forwarded.headers['x-hookrelay-signature']);
    expect(verifySignature(destinationSecret, forwarded.body, signature)).toBe(true);
  });

  it('rejects an invalid signature and stores nothing', async () => {
    await setupSource(ctx);
    await http()
      .post('/hooks/shop')
      .set('x-signature', `sha256=${sign('{}', 'wrong-secret')}`)
      .send('{}')
      .expect(401);
    expect(await ctx.prisma.event.count()).toBe(0);
  });

  it('returns 404 for an unknown source', async () => {
    await http().post('/hooks/unknown').send('{}').expect(404);
  });

  it('returns 413 for bodies larger than MAX_BODY_BYTES', async () => {
    await setupSource(ctx);
    const res = await sendWebhook(ctx, { blob: 'x'.repeat(1_100_000) }).expect(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'Payload too large' });
  });

  it('processes the same event only once (Redis idempotency)', async () => {
    await setupSource(ctx);
    const first = await sendWebhook(ctx, { id: 'order-1' }).expect(202);
    const second = await sendWebhook(ctx, { id: 'order-1' }).expect(200);
    expect(second.body).toEqual({ id: first.body.id, status: 'duplicate' });

    await waitForEventStatus(ctx, first.body.id, 'delivered');
    expect(await ctx.prisma.event.count()).toBe(1);
    expect(ctx.receiver.requests).toHaveLength(1);
  });

  it('still detects duplicates when the Redis key is gone (Postgres unique constraint)', async () => {
    await setupSource(ctx);
    const first = await sendWebhook(ctx, { id: 'order-2' }).expect(202);
    await ctx.redis.del(...(await ctx.redis.keys('hookrelay:idem:*')));

    const second = await sendWebhook(ctx, { id: 'order-2' }).expect(200);
    expect(second.body).toEqual({ id: first.body.id, status: 'duplicate' });
    expect(await ctx.prisma.event.count()).toBe(1);
  });

  it('stores exactly one event when the same webhook arrives concurrently', async () => {
    await setupSource(ctx);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => sendWebhook(ctx, { id: 'burst' })),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.every((s) => [200, 202, 409].includes(s))).toBe(true);
    expect(await ctx.prisma.event.count()).toBe(1);
  });

  it('fans out to every active destination and skips inactive ones', async () => {
    await setupSource(ctx);
    const second = new TestReceiver();
    const inactive = new TestReceiver();
    await Promise.all([second.start(), inactive.start()]);
    try {
      await admin(ctx).post('/destinations', { source: 'shop', url: second.url }).expect(201);
      await admin(ctx)
        .post('/destinations', { source: 'shop', url: inactive.url, active: false })
        .expect(201);

      const res = await sendWebhook(ctx, { id: 'fan-out' }).expect(202);
      const event = await waitForEventStatus(ctx, res.body.id, 'delivered');

      expect(event.deliveries).toHaveLength(2);
      expect(ctx.receiver.requests).toHaveLength(1);
      expect(second.requests).toHaveLength(1);
      expect(inactive.requests).toHaveLength(0);
    } finally {
      await Promise.all([second.stop(), inactive.stop()]);
    }
  });

  it('marks events of a source without destinations as skipped', async () => {
    await admin(ctx).post('/sources', { name: 'lonely', secret: 'source-secret-123' }).expect(201);
    const res = await sendWebhook(ctx, { id: 'nobody' }, { source: 'lonely' }).expect(202);
    const event = (await admin(ctx).get(`/events/${res.body.id}`).expect(200)).body;
    expect(event).toMatchObject({ status: 'skipped', deliveries: [] });
  });
});
