import { deriveEventStatus } from '../../src/events/event-status';
import { DeliveryStatus, EventStatus } from '../../src/generated/prisma/client';

const { PENDING, SUCCEEDED, DEAD } = DeliveryStatus;

describe('deriveEventStatus', () => {
  it.each([
    [[], EventStatus.SKIPPED],
    [[SUCCEEDED], EventStatus.DELIVERED],
    [[SUCCEEDED, SUCCEEDED], EventStatus.DELIVERED],
    [[SUCCEEDED, PENDING], EventStatus.PENDING],
    // Even with one destination dead-lettered, the event is not done while another is still retrying.
    [[DEAD, PENDING], EventStatus.PENDING],
    [[DEAD, SUCCEEDED], EventStatus.FAILED],
    [[DEAD], EventStatus.FAILED],
  ])('%j -> %s', (statuses, expected) => {
    expect(deriveEventStatus(statuses)).toBe(expected);
  });
});
