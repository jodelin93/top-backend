import * as Joi from 'joi';

/**
 * Environment variable schema, validated once at startup by ConfigModule.
 * The app refuses to boot (fail fast) when a required variable is missing or invalid.
 *
 * Flags compared as strings elsewhere in the code (DB_SSL, DB_LOGGING, ...) are
 * kept as 'true' | 'false' strings on purpose, so `=== 'true'` checks keep working.
 * Keep this list in sync with .env.example.
 */
// Empty strings (e.g. `FOO=` or an empty Docker build arg) count as unset
const bool = () => Joi.string().valid('true', 'false').empty('');
// Required in every strict environment (production, staging): see config/environment.ts
const isProd = {
  is: Joi.valid('development', 'test'),
  otherwise: Joi.required(),
} as const;

export const envSchema = Joi.object<Record<string, unknown>>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),

  // Server
  PORT: Joi.number().port().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  APP_VERSION: Joi.string().empty('').optional(),
  TRUST_PROXY: Joi.string().empty('').optional(),
  // Swagger UI at /api/docs: on by default in development/test only
  ENABLE_SWAGGER: bool().optional(),
  CORS_ORIGINS: Joi.string().when('NODE_ENV', isProd),

  // Database
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_DATABASE: Joi.string().required(),
  // Schema changes go through migrations only - never let TypeORM sync the schema
  DB_SYNCHRONIZE: Joi.string().valid('false').default('false'),
  DB_LOGGING: bool().default('false'),
  DB_SSL: bool().default('false'),
  DB_POOL_MAX: Joi.number().integer().min(1).default(20),
  DB_IDLE_TIMEOUT: Joi.number().integer().min(0).default(30000),

  // Redis (Bull queues)
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  QUEUE_REDIS_DB: Joi.number().integer().min(0).default(1),

  // Authentication (strength is enforced by getJwtSecret())
  JWT_SECRET: Joi.string().when('NODE_ENV', isProd),
  // Access token lifetime, e.g. 24h, 12h, 30m
  JWT_EXPIRES_IN: Joi.string().empty('').default('24h'),
  BCRYPT_ROUNDS: Joi.number().integer().min(10).max(15).default(10),
  // Signs offline capability leases held by tills (spec §19); required outside development/test
  OFFLINE_LEASE_SECRET: Joi.string().min(32).empty('').when('NODE_ENV', isProd),
  // Key of the gift card code HMAC; required outside development/test. Never
  // change it once cards are sold (they could no longer be found).
  GIFT_CARD_CODE_SECRET: Joi.string()
    .min(32)
    .empty('')
    .when('NODE_ENV', isProd),
  // First owner account created by `npm run seed`
  ADMIN_EMAIL: Joi.string().email().empty('').optional(),
  ADMIN_PASSWORD: Joi.string().min(8).empty('').optional(),

  // Rate limiting
  THROTTLE_ENABLED: bool().optional(),
  THROTTLE_TTL: Joi.number().integer().min(1).default(60), // seconds
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(300),
  AUTH_THROTTLE_TTL: Joi.number().integer().min(1).default(60), // seconds
  AUTH_THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),
  // Per store (authenticated requests, all routes together)
  TENANT_THROTTLE_TTL: Joi.number().integer().min(1).default(60), // seconds
  TENANT_THROTTLE_LIMIT: Joi.number().integer().min(1).default(3000),
  // Per user and route: report runs, export jobs, product imports/exports
  HEAVY_THROTTLE_TTL: Joi.number().integer().min(1).default(60), // seconds
  HEAVY_THROTTLE_LIMIT: Joi.number().integer().min(1).default(20),
  SIGNUP_THROTTLE_TTL: Joi.number().integer().min(1).default(3600), // seconds
  SIGNUP_THROTTLE_LIMIT: Joi.number().integer().min(1).default(5),

  // Self-service store sign-up (POST /tenants/signup); off unless 'true'
  ALLOW_SIGNUP: bool().default('false'),

  // Prometheus scrape endpoint GET /metrics. With a token, scrapers must send
  // "Authorization: Bearer <token>"; without one the endpoint is disabled outside
  // development/test. The same token unlocks the detailed GET /health report.
  METRICS_TOKEN: Joi.string().min(16).empty('').optional(),
  METRICS_ENABLED: bool().optional(),

  // Platform (outbox, notifications e-mail, backup hook): see .env.example
  OUTBOX_PUBLISHER: Joi.string().valid('on', 'off').empty('').optional(),
  OUTBOX_POLL_MS: Joi.number().integer().min(100).optional(),
  OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).optional(),
  OUTBOX_FORWARD_TO_QUEUE: bool().optional(),
  IDEMPOTENCY_TTL_HOURS: Joi.number().min(1).optional(),
  SMTP_HOST: Joi.string().empty('').optional(),
  SMTP_PORT: Joi.number().port().optional(),
  SMTP_SECURE: bool().optional(),
  SMTP_REQUIRE_TLS: bool().optional(),
  SMTP_FROM: Joi.string().email().empty('').optional(),
  BACKUP_REPORT_TOKEN: Joi.string().min(16).empty('').optional(),

  // Logging
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'log', 'info', 'debug', 'verbose')
    .default('log'),
  LOG_FORMAT: Joi.string().valid('json', 'pretty').empty('').optional(),
});

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = envSchema.validate(config, {
    allowUnknown: true,
    abortEarly: false,
  });
  if (result.error) {
    const details = result.error.details
      .map((d) => `  - ${d.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.value;
}
