import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeviceHardware } from './device-hardware.entity';
import { HARDWARE_CAPABILITIES } from './hardware-capabilities';
import type { ReportHardwareDto } from './hardware.dto';

/**
 * Hardware status per till (spec §15). The print bridge answers only the browser
 * on its own PC; the POS forwards what it sees here so the back office can spot a
 * printer out of paper or an unpaired till.
 */
@Injectable()
export class HardwareService {
  constructor(private dataSource: DataSource) {}

  capabilities() {
    return HARDWARE_CAPABILITIES;
  }

  async report(
    tenantId: string,
    deviceId: string | undefined,
    userId: string,
    dto: ReportHardwareDto,
  ) {
    if (!deviceId) {
      throw new BadRequestException(
        'This browser is not a registered till (X-Device-Id)',
      );
    }
    const [device] = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM devices WHERE id = $1 AND "tenantId" = $2 AND "revokedAt" IS NULL`,
      [deviceId, tenantId],
    );
    if (!device) throw new NotFoundException('Device not found');
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(DeviceHardware)
      .values({
        tenantId,
        deviceId,
        bridgePaired: dto.bridgePaired,
        bridgeReachable: dto.bridgeReachable,
        bridgeVersion: dto.bridgeVersion ?? null,
        printers: dto.printers,
        customerDisplay: !!dto.customerDisplay,
        reportedAt: new Date(),
        reportedBy: userId,
      })
      .orUpdate(
        [
          'bridgePaired',
          'bridgeReachable',
          'bridgeVersion',
          'printers',
          'customerDisplay',
          'reportedAt',
          'reportedBy',
        ],
        ['tenantId', 'deviceId'],
      )
      .execute();
    return { ok: true };
  }

  /** Every till's last report, with the device name */
  list(tenantId: string) {
    return this.dataSource.query<Record<string, unknown>[]>(
      `SELECT h."deviceId", d.name AS "deviceName", h."bridgePaired", h."bridgeReachable",
              h."bridgeVersion", h.printers, h."customerDisplay", h."reportedAt"
         FROM device_hardware h
         JOIN devices d ON d.id = h."deviceId"
        WHERE h."tenantId" = $1
        ORDER BY d.name`,
      [tenantId],
    );
  }
}
