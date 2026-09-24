# Backend Setup Guide

## Prerequisites

- Node.js 18+ installed
- PostgreSQL 15+ installed and running
- Redis 7+ installed and running
- npm or yarn package manager

## Initial Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Database Setup

Create the PostgreSQL database:

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE modern_pos;

# Exit psql
\q
```

### 3. Configure Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and update the following variables to match your local setup:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_postgres_password
DB_DATABASE=modern_pos

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# JWT Secrets (CHANGE THESE IN PRODUCTION!)
JWT_SECRET=your-super-secret-jwt-key
JWT_REFRESH_SECRET=your-super-secret-refresh-key
```

### 4. Run Database Migrations

```bash
# Run all pending migrations
npm run migration:run

# Check migration status
npm run migration:show
```

## Available Scripts

### Development

```bash
# Start in development mode with hot reload
npm run start:dev

# Start in debug mode
npm run start:debug
```

### Database Migrations

```bash
# Generate a new migration based on entity changes
npm run migration:generate src/database/migrations/MigrationName

# Create a blank migration file
npm run migration:create src/database/migrations/MigrationName

# Run pending migrations
npm run migration:run

# Revert the last migration
npm run migration:revert

# Show migration status
npm run migration:show
```

### Testing

```bash
# Run unit tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:cov

# Run e2e tests
npm run test:e2e
```

### Code Quality

```bash
# Format code with Prettier
npm run format

# Lint code with ESLint
npm run lint
```

### Production

```bash
# Build the application
npm run build

# Start in production mode
npm run start:prod
```

## Project Structure

```
src/
├── config/              # Configuration files
│   ├── database.config.ts
│   ├── redis.config.ts
│   └── queue.config.ts
├── database/
│   ├── entities/        # TypeORM entities
│   │   ├── base.entity.ts
│   │   ├── tenant.entity.ts
│   │   ├── user.entity.ts
│   │   ├── branch.entity.ts
│   │   ├── warehouse.entity.ts
│   │   ├── inventory-location.entity.ts
│   │   ├── register.entity.ts
│   │   └── index.ts
│   ├── migrations/      # Database migrations
│   └── data-source.ts   # TypeORM data source configuration
├── modules/             # Feature modules (to be created)
└── main.ts              # Application entry point
```

## Entities Created

The following entities have been implemented:

1. **Tenant** - Multi-tenant root entity
2. **User** - User accounts with authentication
3. **TenantMembership** - Links users to tenants
4. **Branch** - Physical or logical sales locations
5. **Warehouse** - Inventory storage locations
6. **InventoryLocation** - Specific locations within warehouses
7. **Register** - Point-of-sale terminals

## Next Steps

1. ✅ Database migrations created
2. ⏳ Create NestJS modules for each domain
3. ⏳ Implement authentication (JWT + MFA)
4. ⏳ Add permission-based authorization
5. ⏳ Create API controllers and services
6. ⏳ Add validation and error handling
7. ⏳ Write tests

## Troubleshooting

### Database Connection Issues

If you get connection errors:

1. Verify PostgreSQL is running:
   ```bash
   # macOS
   brew services list

   # Linux
   systemctl status postgresql
   ```

2. Check database credentials in `.env`

3. Test connection:
   ```bash
   psql -U postgres -d modern_pos
   ```

### Redis Connection Issues

1. Verify Redis is running:
   ```bash
   # macOS
   brew services list

   # Linux
   systemctl status redis
   ```

2. Test connection:
   ```bash
   redis-cli ping
   # Should return: PONG
   ```

### Migration Errors

If migrations fail:

1. Check database connection
2. Verify migrations haven't been run already:
   ```bash
   npm run migration:show
   ```
3. If needed, revert and retry:
   ```bash
   npm run migration:revert
   npm run migration:run
   ```

## Environment Variables Reference

See `.env.example` for all available configuration options.

Key variables:
- `NODE_ENV` - Environment (development, production, test)
- `PORT` - API server port (default: 3000)
- `DB_*` - Database configuration
- `REDIS_*` - Redis configuration
- `JWT_*` - Authentication configuration

## Support

For issues or questions, refer to the main project documentation or create an issue in the repository.
