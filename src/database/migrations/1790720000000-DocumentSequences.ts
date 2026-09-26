import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Counter per document sequence (tenant + table + column + prefix), so taking the
 * next gap-free number is one row update instead of scanning every document of the
 * sequence (verification defect DEF-05). Rows are created on first use, seeded from
 * the documents already stored.
 */
export class DocumentSequences1790720000000 implements MigrationInterface {
  name = 'DocumentSequences1790720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_sequences (
        "tenantId" uuid NOT NULL,
        "sequenceKey" varchar(150) NOT NULL,
        "lastValue" bigint NOT NULL CHECK ("lastValue" >= 0),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "PK_document_sequences" PRIMARY KEY ("tenantId", "sequenceKey"),
        CONSTRAINT "FK_document_sequences_tenant" FOREIGN KEY ("tenantId")
          REFERENCES tenants (id) ON DELETE CASCADE
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE document_sequences`);
  }
}
