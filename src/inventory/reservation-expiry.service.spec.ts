import { DataSource, EntityManager } from 'typeorm';
import {
  EXPIRABLE_RESERVATION,
  ReservationExpiryService,
} from './reservation-expiry.service';

describe('ReservationExpiryService', () => {
  const level = {
    tenantId: 'tenant-1',
    variantId: 'var-1',
    locationId: 'loc-1',
    quantityOnHand: 10,
    quantityReserved: 5,
    quantityAvailable: 5,
  };
  const levelQuery = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    setOnLocked: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };
  const manager = {
    getRepository: jest.fn(() => ({
      createQueryBuilder: () => levelQuery,
    })),
    query: jest.fn(),
    save: jest.fn(),
  };
  const dataSource = {
    query: jest.fn(),
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };
  let service: ReservationExpiryService;

  beforeEach(() => {
    jest.clearAllMocks();
    levelQuery.getOne.mockResolvedValue({ ...level });
    dataSource.query.mockResolvedValue([
      { tenantId: 'tenant-1', variantId: 'var-1', locationId: 'loc-1' },
    ]);
    service = new ReservationExpiryService(dataSource as unknown as DataSource);
  });

  it('keeps held-cart reservations expiring and gives their units back', async () => {
    // Only the held cart's 2 units come back from the filtered UPDATE
    manager.query.mockResolvedValue([[{ quantity: 2 }], 1]);
    await expect(service.sweep()).resolves.toBe(2);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ quantityReserved: 3, quantityAvailable: 7 }),
    );
  });

  it('never picks or expires reservations of sales waiting for their payment', async () => {
    manager.query.mockResolvedValue([[], 0]);
    await service.sweep();
    const [select] = dataSource.query.mock.calls[0] as [string];
    const [update] = manager.query.mock.calls[0] as [string];
    for (const sql of [select, update]) {
      expect(sql).toContain(EXPIRABLE_RESERVATION);
    }
    // Pending sale, or a sale with a payment the provider has not settled
    expect(EXPIRABLE_RESERVATION).toMatch(/^NOT EXISTS/);
    expect(EXPIRABLE_RESERVATION).toContain("s.status = 'payment_pending'");
    expect(EXPIRABLE_RESERVATION).toContain(
      "p.status IN ('initiated', 'pending', 'authorized', 'unknown')",
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('skips a stock level another transaction holds', async () => {
    levelQuery.getOne.mockResolvedValue(null);
    await expect(service.sweep()).resolves.toBe(0);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
