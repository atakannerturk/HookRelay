import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import type { AppConfig } from '../../src/common/config/config';
import type { IdempotencyClaim } from '../../src/common/idempotency/idempotency.service';
import { EventStatus, Prisma, SignatureScheme } from '../../src/generated/prisma/client';
import { IngestService } from '../../src/ingest/ingest.service';
import { VerifierRegistry } from '../../src/ingest/verifiers/verifier-registry';

const SOURCE = { id: 'src-1', name: 'shop', scheme: SignatureScheme.GENERIC, secret: 's3cret!!' };
const BODY = Buffer.from(JSON.stringify({ id: 'order-1', type: 'order.created' }));

function signedHeaders(body = BODY) {
  return {
    'content-type': 'application/json',
    'x-signature': `sha256=${createHmac('sha256', SOURCE.secret).update(body).digest('hex')}`,
  };
}

function setup(claim: IdempotencyClaim = { state: 'acquired' }) {
  const prisma = {
    source: { findUnique: jest.fn().mockResolvedValue(SOURCE) },
    destination: { findMany: jest.fn().mockResolvedValue([{ id: 'dest-1' }, { id: 'dest-2' }]) },
    event: {
      create: jest.fn().mockResolvedValue({
        id: 'event-1',
        status: EventStatus.PENDING,
        deliveries: [
          { id: 'del-1', replayCount: 0 },
          { id: 'del-2', replayCount: 0 },
        ],
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'existing-event' }),
    },
  };
  const idempotency = {
    key: jest.fn((sourceId: string, externalId: string) => `${sourceId}:${externalId}`),
    claim: jest.fn().mockResolvedValue(claim),
    complete: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { enqueue: jest.fn().mockResolvedValue(true) };
  const verifiers = new VerifierRegistry({ stripeToleranceSeconds: 300 } as AppConfig);
  const service = new IngestService(
    prisma as never,
    verifiers,
    idempotency as never,
    queue as never,
  );
  return { service, prisma, idempotency, queue };
}

describe('IngestService', () => {
  it('stores a new event with one delivery per active destination and enqueues them', async () => {
    const { service, prisma, idempotency, queue } = setup();

    const result = await service.ingest('shop', BODY, signedHeaders());

    expect(result).toEqual({
      outcome: 'accepted',
      eventId: 'event-1',
      status: EventStatus.PENDING,
    });
    const data = prisma.event.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      sourceId: 'src-1',
      externalId: 'order-1',
      eventType: 'order.created',
      status: EventStatus.PENDING,
      payload: BODY.toString(),
    });
    expect(data.deliveries.create).toHaveLength(2);
    expect(queue.enqueue).toHaveBeenCalledWith([
      { id: 'del-1', replayCount: 0 },
      { id: 'del-2', replayCount: 0 },
    ]);
    expect(idempotency.complete).toHaveBeenCalledWith('src-1:order-1', 'event-1');
  });

  it('returns 404 for an unknown source', async () => {
    const { service, prisma } = setup();
    prisma.source.findUnique.mockResolvedValue(null);
    await expect(service.ingest('nope', BODY, signedHeaders())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an invalid signature before touching idempotency or the database', async () => {
    const { service, prisma, idempotency } = setup();
    await expect(
      service.ingest('shop', BODY, { 'x-signature': 'sha256=deadbeef' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(idempotency.claim).not.toHaveBeenCalled();
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it('answers a duplicate from Redis without writing to the database', async () => {
    const { service, prisma, queue } = setup({ state: 'completed', eventId: 'event-0' });
    await expect(service.ingest('shop', BODY, signedHeaders())).resolves.toEqual({
      outcome: 'duplicate',
      eventId: 'event-0',
    });
    expect(prisma.event.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('returns 409 while the same event is being processed concurrently', async () => {
    const { service } = setup({ state: 'in_progress' });
    await expect(service.ingest('shop', BODY, signedHeaders())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('still accepts the webhook when Redis is unavailable', async () => {
    const { service, prisma } = setup({ state: 'unavailable' });
    await expect(service.ingest('shop', BODY, signedHeaders())).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(prisma.event.create).toHaveBeenCalled();
  });

  it('falls back to the Postgres unique constraint to detect duplicates', async () => {
    const { service, prisma, idempotency } = setup({ state: 'unavailable' });
    prisma.event.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.ingest('shop', BODY, signedHeaders())).resolves.toEqual({
      outcome: 'duplicate',
      eventId: 'existing-event',
    });
    expect(idempotency.complete).toHaveBeenCalledWith('src-1:order-1', 'existing-event');
  });

  it('releases the idempotency key when storing fails so the provider can retry', async () => {
    const { service, prisma, idempotency } = setup();
    prisma.event.create.mockRejectedValue(new Error('db down'));
    await expect(service.ingest('shop', BODY, signedHeaders())).rejects.toThrow('db down');
    expect(idempotency.release).toHaveBeenCalledWith('src-1:order-1');
    expect(idempotency.complete).not.toHaveBeenCalled();
  });

  it('accepts the webhook even if enqueueing fails (recovery picks it up)', async () => {
    const { service, queue } = setup();
    queue.enqueue.mockResolvedValue(false);
    await expect(service.ingest('shop', BODY, signedHeaders())).resolves.toMatchObject({
      outcome: 'accepted',
    });
  });

  it('marks the event SKIPPED when the source has no active destination', async () => {
    const { service, prisma } = setup();
    prisma.destination.findMany.mockResolvedValue([]);
    await service.ingest('shop', BODY, signedHeaders());
    expect(prisma.event.create.mock.calls[0][0].data).toMatchObject({
      status: EventStatus.SKIPPED,
      deliveries: { create: [] },
    });
  });

  it('uses a hash of the body as event id when the provider sends none', async () => {
    const { service, prisma } = setup();
    const body = Buffer.from('plain text payload');
    await service.ingest('shop', body, signedHeaders(body));
    const expected = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    expect(prisma.event.create.mock.calls[0][0].data.externalId).toBe(expected);
  });
});
