import { DeliveryStatus, EventStatus, type Prisma } from '../generated/prisma/client';

/** An event's status is derived from its deliveries. */
export function deriveEventStatus(statuses: DeliveryStatus[]): EventStatus {
  if (statuses.length === 0) return EventStatus.SKIPPED;
  if (statuses.includes(DeliveryStatus.PENDING)) return EventStatus.PENDING;
  if (statuses.includes(DeliveryStatus.DEAD)) return EventStatus.FAILED;
  return EventStatus.DELIVERED;
}

/**
 * Locks the event row until the end of the transaction (SELECT ... FOR UPDATE).
 * If two deliveries of the same event finish at the same time on different workers, both
 * could compute the aggregate status from stale data and overwrite each other; the lock
 * serializes them. Returns false if the row does not exist.
 */
export async function lockEvent(tx: Prisma.TransactionClient, eventId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

/** Must be called inside the same transaction as lockEvent. */
export async function refreshEventStatus(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<EventStatus> {
  const deliveries = await tx.delivery.findMany({ where: { eventId }, select: { status: true } });
  const status = deriveEventStatus(deliveries.map((d) => d.status));
  await tx.event.update({ where: { id: eventId }, data: { status } });
  return status;
}
