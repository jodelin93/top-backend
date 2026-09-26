import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { Estimate, EstimateStatus } from '../database/entities/estimate.entity';
import { PricingService } from '../price-lists/pricing.service';
import { TaxResolverService } from '../sales/tax-resolver.service';
import { SettingsService } from '../settings/settings.service';
import { EstimatesService } from './estimates.service';

describe('EstimatesService (selling an estimate)', () => {
  const findOne = jest.fn();
  const manager = {
    findOne,
    update: jest.fn(),
    getRepository: jest.fn(() => ({ findOne })),
  };
  const audit = { record: jest.fn() };
  const service = new EstimatesService(
    {} as Repository<Estimate>,
    { manager } as unknown as DataSource,
    {} as SettingsService,
    {} as PricingService,
    {} as TaxResolverService,
    {} as ApprovalsService,
    audit as unknown as AuditService,
  );
  const m = manager as unknown as EntityManager;
  const estimate = (extra: Partial<Estimate> = {}) => ({
    id: 'est-1',
    tenantId: 't1',
    estimateNumber: 'EST-1',
    branchId: null,
    status: EstimateStatus.SENT,
    validUntil: '2999-01-01',
    convertedSaleId: null,
    items: [],
    ...extra,
  });

  beforeEach(() => jest.clearAllMocks());

  it('sums the quantity quoted for each item across its lines', async () => {
    manager.findOne.mockResolvedValue(
      estimate({
        items: [
          { variantId: 'v1', unitPrice: 8, discountPercent: 0, quantity: 2 },
          { variantId: 'v1', unitPrice: 8, discountPercent: 0, quantity: 1.5 },
        ] as Estimate['items'],
      }),
    );
    const { lines } = await service.quotedLines('t1', 'est-1');
    expect(lines.get('v1')).toEqual({
      unitPrice: 8,
      discountPercent: 0,
      quantity: 3.5,
    });
  });

  it('locks an open estimate for the sale, and refuses one already converted', async () => {
    manager.findOne.mockResolvedValueOnce(estimate());
    await expect(service.lockOpen(m, 't1', 'est-1')).resolves.toMatchObject({
      id: 'est-1',
    });
    expect(manager.findOne).toHaveBeenCalledWith(Estimate, {
      where: { id: 'est-1', tenantId: 't1' },
      lock: { mode: 'pessimistic_write' },
    });
    manager.findOne.mockResolvedValueOnce(
      estimate({ status: EstimateStatus.CONVERTED, convertedSaleId: 's0' }),
    );
    await expect(service.lockOpen(m, 't1', 'est-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('never marks an estimate converted twice', async () => {
    manager.findOne.mockResolvedValue(
      estimate({ status: EstimateStatus.CONVERTED, convertedSaleId: 's0' }),
    );
    await expect(service.markConverted(m, 't1', 'est-1', 's1')).rejects.toThrow(
      'EST-1 is converted',
    );
    // A card sale completing later: recorded, not undone
    await service.markConverted(m, 't1', 'est-1', 's1', { strict: false });
    expect(manager.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'estimate.conversion_skipped' }),
      manager,
    );
  });

  it('marks an open estimate converted by its sale', async () => {
    manager.findOne.mockResolvedValue(estimate());
    await service.markConverted(m, 't1', 'est-1', 's1');
    expect(manager.update).toHaveBeenCalledWith(
      Estimate,
      expect.objectContaining({ id: 'est-1' }),
      expect.objectContaining({
        status: EstimateStatus.CONVERTED,
        convertedSaleId: 's1',
      }),
    );
  });
});
