import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Categories can be tied to branches, like products: a branch-limited user (a
 * cashier of one shop) only sees the categories of their branches. NULL or
 * empty: every branch (all existing categories, until someone ticks branches).
 */
export class CategoryBranches1790850000000 implements MigrationInterface {
  name = 'CategoryBranches1790850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "branchIds" uuid[]`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "categories" DROP COLUMN IF EXISTS "branchIds"`,
    );
  }
}
