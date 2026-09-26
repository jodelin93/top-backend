import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HARDWARE_CAPABILITIES } from './hardware-capabilities';
import { HardwareService } from './hardware.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

describe('hardware', () => {
  it('flags scales and fiscal printers as unsupported', () => {
    const flag = (key: string) =>
      HARDWARE_CAPABILITIES.find((c) => c.key === key)?.supported;
    expect(flag('scale')).toBe(false);
    expect(flag('fiscal_printer')).toBe(false);
    expect(flag('receipt_printer')).toBe(true);
    expect(flag('cash_drawer')).toBe(true);
  });

  it('stores a status report only for a registered till of the store', async () => {
    const execute = jest.fn().mockResolvedValue(undefined);
    interface Builder {
      insert: () => Builder;
      into: () => Builder;
      values: jest.Mock<Builder>;
      orUpdate: () => Builder;
      execute: jest.Mock;
    }
    const builder: Builder = {
      insert: () => builder,
      into: () => builder,
      values: jest.fn((): Builder => builder),
      orUpdate: () => builder,
      execute,
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: DEVICE }])
      .mockResolvedValueOnce([]);
    const service = new HardwareService({
      query,
      createQueryBuilder: (): Builder => builder,
    } as never);
    const report = {
      bridgePaired: true,
      bridgeReachable: true,
      printers: [],
    };
    await expect(
      service.report(TENANT, undefined, 'u', report),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.report(TENANT, DEVICE, 'u', report);
    expect(builder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        deviceId: DEVICE,
        bridgePaired: true,
      }),
    );
    expect(execute).toHaveBeenCalled();
    await expect(
      service.report(TENANT, DEVICE, 'u', report),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
