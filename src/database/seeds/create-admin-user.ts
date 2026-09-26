import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { isStrictEnv } from '../../config/environment';

export async function createAdminUser(dataSource: DataSource) {
  const email = (process.env.ADMIN_EMAIL || 'admin@test.com').toLowerCase();
  // The well-known default password is only acceptable in development/test;
  // production, staging (any strict environment) need an explicit ADMIN_PASSWORD.
  if (isStrictEnv() && !process.env.ADMIN_PASSWORD?.trim()) {
    throw new Error(
      `Set ADMIN_PASSWORD (and ADMIN_EMAIL) to seed the first owner in ${process.env.NODE_ENV}`,
    );
  }
  const password = process.env.ADMIN_PASSWORD || 'Password123!';

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    // Create default tenant
    const tenantId = uuidv4();
    await queryRunner.query(
      `
      INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `,
      [tenantId, 'Default Tenant', 'default-tenant', 'active'],
    );

    // Create admin user (users table is NOT multi-tenant)
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    await queryRunner.query(
      `
      INSERT INTO users (
        id,
        email,
        "passwordHash",
        "firstName",
        "lastName",
        locale,
        timezone,
        "mfaEnabled",
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      ON CONFLICT (email) DO NOTHING
    `,
      [
        userId,
        email,
        hashedPassword,
        'Admin',
        'User',
        'en',
        'UTC',
        false,
        'active',
      ],
    );

    // Resolve actual IDs (rows may already have existed)
    const [tenant] = (await queryRunner.query(
      `SELECT id FROM tenants WHERE slug = $1`,
      ['default-tenant'],
    )) as { id: string }[];
    const [user] = (await queryRunner.query(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    )) as { id: string }[];

    // Link admin user to the default tenant
    await queryRunner.query(
      `
      INSERT INTO tenant_memberships (
        "tenantId", "userId", status, role, "joinedAt", created_at, updated_at
      )
      VALUES ($1, $2, 'active', 'owner', NOW(), NOW(), NOW())
      ON CONFLICT ON CONSTRAINT uq_tenant_user DO NOTHING
    `,
      [tenant.id, user.id],
    );

    await queryRunner.commitTransaction();
    console.log('✅ Admin user created successfully!');
    console.log('📧 Email:', email);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(
        '🔑 Password: Password123! (development default — change it)',
      );
    }
    console.log('🏢 Tenant ID:', tenant.id);
    console.log('👤 User ID:', user.id);
  } catch (error) {
    await queryRunner.rollbackTransaction();
    console.error('❌ Error creating admin user:', error);
    throw error;
  } finally {
    await queryRunner.release();
  }
}
