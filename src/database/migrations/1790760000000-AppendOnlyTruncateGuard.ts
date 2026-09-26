import { MigrationInterface, QueryRunner } from 'typeorm';

// Tables whose rows may never change once written (audit trail and ledgers)
const APPEND_ONLY = [
  'audit_logs',
  'stock_movements',
  'customer_credit_entries',
  'stored_value_entries',
  'customer_consent_events',
] as const;

/**
 * Append-only tables were guarded by row triggers (BEFORE UPDATE OR DELETE),
 * which TRUNCATE doesn't fire: one statement could empty the audit trail or a
 * ledger (security review). A statement-level BEFORE TRUNCATE trigger closes
 * that, with the same maintenance switch as the row triggers (app.audit_purge,
 * used only by tenant deletion in tests / the demo seed).
 *
 * The complete fix is a database role split — the app connecting as a role
 * that doesn't own these tables and can't drop or disable triggers — which is
 * a deployment step (docs/operations.md, "Database roles").
 */
export class AppendOnlyTruncateGuard1790760000000 implements MigrationInterface {
  name = 'AppendOnlyTruncateGuard1790760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION append_only_no_truncate() RETURNS trigger AS $$
      BEGIN
        IF current_setting('app.audit_purge', true) = 'on' THEN
          RETURN NULL;
        END IF;
        RAISE EXCEPTION '% is append-only: it cannot be truncated', TG_TABLE_NAME
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$ LANGUAGE plpgsql`);
    for (const table of APPEND_ONLY) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_no_truncate"
          BEFORE TRUNCATE ON "${table}"
          FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of APPEND_ONLY) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "trg_${table}_no_truncate" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS append_only_no_truncate()`,
    );
  }
}
