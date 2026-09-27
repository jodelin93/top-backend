import './database/pg-types';
import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { REQUEST_ID_HEADER } from './common/interceptors/request-logging.middleware';
import { createAppLogger } from './config/logger.config';
import { isStrictEnv } from './config/environment';

// Load .env before creating the logger (ConfigModule loads it again for validation)
dotenv.config({ quiet: true });

/**
 * Express "trust proxy" so req.ip is the real client IP behind a load balancer
 * (needed for rate limiting and logs). TRUST_PROXY accepts a hop count, true/false,
 * or a comma-separated list of trusted subnets. Defaults: 1 hop in production/staging
 * (Railway, most PaaS), loopback only in development.
 */
function resolveTrustProxy(): boolean | number | string {
  const value = process.env.TRUST_PROXY?.trim();
  if (!value) {
    return ['production', 'staging'].includes(process.env.NODE_ENV ?? '')
      ? 1
      : 'loopback';
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  return /^\d+$/.test(value) ? parseInt(value, 10) : value;
}

/**
 * Swagger is on by default in development/test only. Strict environments
 * (production, staging, ...) need an explicit ENABLE_SWAGGER=true (SWAGGER_ENABLED
 * is accepted as an alias); ENABLE_SWAGGER=false turns it off anywhere.
 */
function isSwaggerEnabled(): boolean {
  const flag = process.env.ENABLE_SWAGGER || process.env.SWAGGER_ENABLED;
  return flag ? flag === 'true' : !isStrictEnv();
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: createAppLogger(),
    // Keep the exact request bytes: payment webhook signatures are computed over them
    rawBody: true,
  });
  const logger = new Logger('Bootstrap');

  app.set('trust proxy', resolveTrustProxy());
  app.disable('x-powered-by');

  // Metrics, request id/logging, request context, prefix, validation, errors,
  // serialization — shared with the e2e tests (app.setup.ts)
  configureApp(app);

  // Security headers. The CSP allows what Swagger UI at /api/docs needs
  // (its own inline styles and data: images); API responses are JSON anyway.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
    }),
  );

  // Graceful shutdown on SIGTERM (container stop / redeploy): closes DB and Redis connections
  app.enableShutdownHooks();

  // CORS configuration (CORS_ORIGINS is required in production)
  const corsOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins?.length ? corsOrigins : ['http://localhost:3001'],
    // Credentials: the web app's session is an HttpOnly, SameSite=Strict cookie
    // (auth/session-cookie.ts). Same-origin setups (NEXT_PUBLIC_API_URL=/api/v1
    // through the Next.js rewrite) don't need CORS at all; a separate API origin
    // (https://api.example.com) must be same-site with the app and listed here
    // exactly. Unsafe requests also need the X-Requested-With header (CsrfGuard),
    // which only the origins above may send cross-origin (preflight).
    credentials: true,
    // Idempotent-Replayed: a retried command got its stored response (common/idempotency)
    exposedHeaders: [REQUEST_ID_HEADER, 'Idempotent-Replayed'],
  });

  // Swagger/OpenAPI documentation
  if (isSwaggerEnabled()) {
    const config = new DocumentBuilder()
      .setTitle('Modern POS API')
      .setDescription('Point of Sale System API Documentation')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'Authorization',
          description: 'Enter JWT token',
          in: 'header',
        },
        'JWT-auth',
      )
      .addTag('Authentication', 'Login, MFA and the current user')
      .addTag('POS', 'Till startup context and sellable catalog')
      .addTag('Sales', 'Quotes, checkout, sale history and voids')
      .addTag('Products', 'Products and variants')
      .addTag('Categories', 'Category tree')
      .addTag('Price lists', 'Price lists and price entries')
      .addTag('Discounts', 'Discount codes')
      .addTag('Inventory', 'Stock levels, receiving, counts and movements')
      .addTag('Customers', 'Customer records')
      .addTag('Reports', 'Sales summary')
      .addTag('Users', 'Store members and roles')
      .addTag(
        'Settings',
        'Store settings, branches, registers, locations, payment methods, tax rates',
      )
      .addTag('Health', 'Liveness and readiness')
      .addTag('Sessions', 'Signed-in sessions and sign-out')
      .addTag('Stores', 'Store sign-up')
      .addTag('Devices', 'Registered tills, offline lease and queue reporting')
      .addTag('Sync', 'Incremental POS data sync')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`Application is running on port ${port}`);
  if (isSwaggerEnabled()) {
    logger.log(`API documentation: http://localhost:${port}/api/docs`);
  }
}
void bootstrap();
