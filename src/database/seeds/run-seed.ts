import { DataSource } from 'typeorm';
import { createAdminUser } from './create-admin-user';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function runSeeds() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('🔌 Connecting to database...');
    await dataSource.initialize();
    console.log('✅ Connected to database');

    console.log('\n📝 Running seeds...\n');
    await createAdminUser(dataSource);

    console.log('\n✅ All seeds completed successfully!');
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await dataSource.destroy();
    console.log('\n👋 Database connection closed');
  }
}

void runSeeds();
