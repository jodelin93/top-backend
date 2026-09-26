import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLoyaltyLedger1790330000000 implements MigrationInterface {
  name = 'AddLoyaltyLedger1790330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."loyalty_transactions_type_enum" AS ENUM('earn', 'redeem', 'reversal', 'adjustment')`,
    );
    await queryRunner.query(`
      CREATE TABLE "loyalty_transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "type" "public"."loyalty_transactions_type_enum" NOT NULL,
        "points" integer NOT NULL,
        "balanceAfter" integer NOT NULL,
        "amount" numeric(19,4),
        "saleId" uuid,
        "returnId" uuid,
        "userId" uuid,
        "note" character varying(255),
        CONSTRAINT "PK_loyalty_transactions" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_loyalty_customer_created" ON "loyalty_transactions" ("tenantId", "customerId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_loyalty_sale" ON "loyalty_transactions" ("saleId")`,
    );
    // Balances that existed before the ledger start with an opening entry
    await queryRunner.query(`
      INSERT INTO "loyalty_transactions" ("tenantId", "customerId", "type", "points", "balanceAfter", "note")
      SELECT "tenantId", id, 'adjustment', "loyaltyPoints", "loyaltyPoints", 'Opening balance'
      FROM customers WHERE "loyaltyPoints" > 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "loyalty_transactions"`);
    await queryRunner.query(
      `DROP TYPE "public"."loyalty_transactions_type_enum"`,
    );
  }
}
