import { randomUUID } from 'node:crypto';
import {
  admin,
  closeTestContext,
  createTestContext,
  resetState,
  sendWebhook,
  setupSource,
  waitForEventStatus,
  type TestContext,
} from './helpers';

describe('Delivery, retry, dead-letter and replay (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await closeTestContext(ctx);
  });
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('retries with backoff until the destination recovers', async () => {
    await setupSource(ctx);
    ctx.receiver.respondWith(500, 503);

    const res = await sendWebhook(ctx, { id: 'retry-me' }).expect(202);
    const event = await waitForEventStatus(ctx, res.body.id, 'delivered');

    const [delivery] = event.deliveries;
    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 3, lastStatusCode: 200 });
    expect(delivery.attemptLog.map((a: { statusCode: number }) => a.statusCode)).toEqual([
      500, 503, 200,
    ]);
    expect(ctx.receiver.requests.map((r) => r.headers['x-hookrelay-attempt'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('moves the event to the dead-letter list after 5 failed attempts', async () => {
    await setupSource(ctx);
    ctx.receiver.alwaysRespond(500);

    const res = await sendWebhook(ctx, { id: 'always-fails' }).expect(202);
    const event = await waitForEventStatus(ctx, res.body.id, 'failed');

    expect(event.deliveries[0]).toMatchObject({
      status: 'dead',
      attempts: 5,
      lastStatusCode: 500,
      lastError: 'HTTP 500: receiver says hi',
      nextAttemptAt: null,
    });
    expect(ctx.receiver.requests).toHaveLength(5);

    const failed = await admin(ctx).get('/events?status=failed').expect(200);
    expect(failed.body.data.map((e: { id: string }) => e.id)).toEqual([res.body.id]);
    const delivered = await admin(ctx).get('/events?status=delivered').expect(200);
    expect(delivered.body.data).toHaveLength(0);
  });

  it('does not retry permanent 4xx errors', async () => {
    await setupSource(ctx);
    ctx.receiver.alwaysRespond(400);

    const res = await sendWebhook(ctx, { id: 'bad-request' }).expect(202);
    const event = await waitForEventStatus(ctx, res.body.id, 'failed');

    expect(event.deliveries[0]).toMatchObject({ status: 'dead', attempts: 1, lastStatusCode: 400 });
    expect(ctx.receiver.requests).toHaveLength(1);
  });

  it('replays a dead-lettered event with a fresh round of attempts', async () => {
    await setupSource(ctx);
    ctx.receiver.alwaysRespond(500);
    const { body } = await sendWebhook(ctx, { id: 'replay-me' }).expect(202);
    await waitForEventStatus(ctx, body.id, 'failed');

    ctx.receiver.alwaysRespond(200);
    const replay = await admin(ctx).post(`/events/${body.id}/replay`).expect(202);
    expect(replay.body).toEqual({ id: body.id, status: 'pending', replayedDeliveries: 1 });

    const event = await waitForEventStatus(ctx, body.id, 'delivered');
    expect(event.deliveries[0]).toMatchObject({ status: 'succeeded', attempts: 1, replayCount: 1 });
    expect(event.deliveries[0].attemptLog).toHaveLength(6);

    // No longer dead-lettered, so it cannot be replayed again.
    await admin(ctx).post(`/events/${body.id}/replay`).expect(409);
  });

  it('answers 404 / 400 for replays of unknown or malformed ids', async () => {
    await admin(ctx).post(`/events/${randomUUID()}/replay`).expect(404);
    await admin(ctx).post('/events/not-a-uuid/replay').expect(400);
  });

  it('recovers deliveries that never reached the queue', async () => {
    await setupSource(ctx);
    // Scenario: the event was written to Postgres but never enqueued (e.g. Redis was down).
    const destination = await ctx.prisma.destination.findFirstOrThrow();
    const event = await ctx.prisma.event.create({
      data: {
        sourceId: destination.sourceId,
        externalId: 'lost-in-transit',
        contentType: 'application/json',
        headers: {},
        payload: '{"id":"lost-in-transit"}',
        deliveries: {
          create: [{ destinationId: destination.id, nextAttemptAt: new Date(Date.now() - 60_000) }],
        },
      },
    });

    expect(await ctx.recovery.runOnce()).toBe(1);
    await waitForEventStatus(ctx, event.id, 'delivered');
    expect(ctx.receiver.requests).toHaveLength(1);
    expect(await ctx.recovery.runOnce()).toBe(0);
  });

  it('dead-letters deliveries whose destination was disabled', async () => {
    const { destinationId } = await setupSource(ctx);
    const destination = await ctx.prisma.destination.findUniqueOrThrow({
      where: { id: destinationId },
    });
    const event = await ctx.prisma.event.create({
      data: {
        sourceId: destination.sourceId,
        externalId: 'too-late',
        contentType: 'application/json',
        headers: {},
        payload: '{}',
        deliveries: { create: [{ destinationId, nextAttemptAt: new Date(0) }] },
      },
    });
    await admin(ctx).patch(`/destinations/${destinationId}`, { active: false }).expect(200);

    await ctx.recovery.runOnce();
    const failed = await waitForEventStatus(ctx, event.id, 'failed');
    expect(failed.deliveries[0]).toMatchObject({
      status: 'dead',
      lastError: 'Destination is disabled',
    });
    expect(ctx.receiver.requests).toHaveLength(0);
  });

  it('paginates the event list with a cursor, newest first', async () => {
    await setupSource(ctx);
    for (const id of ['first', 'second', 'third']) {
      await sendWebhook(ctx, { id }).expect(202);
    }

    const page1 = await admin(ctx).get('/events?limit=2').expect(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBe(page1.body.data[1].id);

    const page2 = await admin(ctx)
      .get(`/events?limit=2&cursor=${page1.body.nextCursor}`)
      .expect(200);
    expect(page2.body.nextCursor).toBeNull();

    const ids = [...page1.body.data, ...page2.body.data].map(
      (e: { externalId: string }) => e.externalId,
    );
    expect(ids).toEqual(['third', 'second', 'first']);
  });
});
