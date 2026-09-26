import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manager approvals become single-use: each approval token carries a unique id
 * (jti), recorded here when the approved action goes through. A token whose jti
 * is already listed is refused (see ApprovalsService.verify).
 */
export class SingleUseApprovals1790370000000 implements MigrationInterface {
  name = 'SingleUseApprovals1790370000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "approval_uses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "jti" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "approverId" uuid NOT NULL,
        "requesterId" uuid NOT NULL,
        "permission" character varying(100) NOT NULL,
        "action" character varying(300),
        "usedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_approval_uses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_approval_uses_jti" UNIQUE ("jti")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_approval_uses_tenant_used" ON "approval_uses" ("tenantId", "usedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "approval_uses"`);
  }
}
