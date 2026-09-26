import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { dataSourceOptions } from '../data-source';
import { User, UserStatus } from '../entities/user.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { isStrictEnv } from '../../config/environment';

async function createTestUser() {
  // Creates admin@test.com with a well-known password: development/test only
  if (isStrictEnv()) {
    console.error(
      `Refusing to create the test user in ${process.env.NODE_ENV}: it has a well-known password. ` +
        'Use `npm run seed` with ADMIN_EMAIL / ADMIN_PASSWORD instead.',
    );
    process.exit(1);
  }

  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  console.log('Creating test tenant and user...');

  try {
    const userRepository = dataSource.getRepository(User);
    const tenantRepository = dataSource.getRepository(Tenant);

    // Create a test tenant
    let tenant = await tenantRepository.findOne({
      where: { slug: 'test-tenant' },
    });

    if (!tenant) {
      tenant = tenantRepository.create({
        name: 'Test Tenant',
        slug: 'test-tenant',
        status: TenantStatus.ACTIVE,
        settings: {},
      });
      await tenantRepository.save(tenant);
      console.log('✓ Test tenant created');
    } else {
      console.log('✓ Test tenant already exists');
    }

    // Create a test user
    const existingUser = await userRepository.findOne({
      where: { email: 'admin@test.com' },
    });

    if (existingUser) {
      console.log('✓ Test user already exists');
      console.log('\nTest User Credentials:');
      console.log('Email: admin@test.com');
      console.log('Password: Password123!');
      await dataSource.destroy();
      return;
    }

    const passwordHash = await bcrypt.hash('Password123!', 10);

    const user = userRepository.create({
      email: 'admin@test.com',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      phone: '+1234567890',
      locale: 'en',
      timezone: 'UTC',
      mfaEnabled: false,
      status: UserStatus.ACTIVE,
    });

    await userRepository.save(user);

    console.log('✓ Test user created successfully!');
    console.log('\nTest User Credentials:');
    console.log('Email: admin@test.com');
    console.log('Password: Password123!');
    console.log(
      '\nYou can now use these credentials to test the authentication endpoints.',
    );
  } catch (error) {
    console.error('Error creating test user:', error);
  } finally {
    await dataSource.destroy();
  }
}

void createTestUser();
