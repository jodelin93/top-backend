import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant isolation in the database: a device can only be enrolled on a register of
 * its own store (verification defect DEF-01 — the application check alone let an
 * owner enroll a till on another store's register). Deleting a register keeps the
 * device and clears its register.
 */
export class DeviceRegisterForeignKey1790710000000 implements MigrationInterface {
  name = 'DeviceRegisterForeignKey1790710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rows pointing at a register of another store (none expected) lose the link
    await queryRunner.query(`
      UPDATE devices d SET "registerId" = NULL
      WHERE d."registerId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM registers r
          WHERE r.id = d."registerId" AND r."tenantId" = d."tenantId"
        )`);
    await queryRunner.query(
      `ALTER TABLE registers ADD CONSTRAINT uq_registers_id_tenant UNIQUE (id, "tenantId")`,
    );
    await queryRunner.query(`
      ALTER TABLE devices ADD CONSTRAINT "FK_devices_register_tenant"
        FOREIGN KEY ("registerId", "tenantId") REFERENCES registers (id, "tenantId")
        ON DELETE SET NULL ("registerId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE devices DROP CONSTRAINT "FK_devices_register_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE registers DROP CONSTRAINT uq_registers_id_tenant`,
    );
  }
}
