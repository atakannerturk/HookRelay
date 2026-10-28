export const DELIVERY_QUEUE = 'deliveries';
export const DELIVERY_JOB = 'deliver';

export interface DeliveryJobData {
  deliveryId: string;
  /** Which replay round the job belongs to; jobs left over from older rounds are ignored. */
  replayCount: number;
}

/**
 * Job ids are deterministic: if the same delivery is enqueued twice for the same round,
 * BullMQ ignores the second add. That is what lets the recovery sweeper re-enqueue safely.
 * (BullMQ does not allow ':' in custom job ids.)
 */
export function deliveryJobId(deliveryId: string, replayCount: number): string {
  return `${deliveryId}_${replayCount}`;
}
