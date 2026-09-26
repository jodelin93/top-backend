import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** A printer as the till's print bridge reported it */
export interface ReportedPrinter {
  id: string;
  name: string;
  // 'tcp' (network ESC/POS, port 9100) or 'usb' (optional, see print-bridge/README.md)
  connection: string;
  online: boolean;
  // ESC/POS real-time status; null when the printer did not answer
  paper: 'ok' | 'low' | 'out' | null;
  coverOpen: boolean | null;
  widthMm: 58 | 80;
}

/**
 * Last hardware report of a till (spec §15): is its print bridge paired and
 * reachable, which printers it drives and their paper/online state. The bridge
 * itself talks only to the browser on the till PC; the POS forwards what it sees
 * so managers can check every till from the back office.
 */
@Entity('device_hardware')
@Index('UQ_device_hardware_device', ['tenantId', 'deviceId'], { unique: true })
export class DeviceHardware {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_device_hardware',
  })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  deviceId: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  bridgePaired: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  bridgeReachable: boolean;

  @Column({ type: 'varchar', length: 30, nullable: true })
  bridgeVersion: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'` })
  printers: ReportedPrinter[];

  @Column({ type: 'boolean', nullable: false, default: false })
  customerDisplay: boolean;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  reportedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  reportedBy: string | null;
}
