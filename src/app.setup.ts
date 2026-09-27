import {
  ClassSerializerInterceptor,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { requestContextMiddleware } from './common/context/request-context';
import { requestLoggingMiddleware } from './common/interceptors/request-logging.middleware';
import { httpMetricsMiddleware } from './metrics/http-metrics.middleware';
import { cookieParserMiddleware } from './auth/session-cookie';
import { CsrfGuard } from './auth/guards/csrf.guard';

/**
 * Request pipeline shared by the server (main.ts) and the end-to-end tests, so
 * tests exercise exactly what production runs. In particular the request context
 * middleware must be present: branch scoping, audit and approvals read the
 * signed-in user's permissions and branches from it.
 */
export function configureApp(app: INestApplication) {
  // Prometheus request counters / latency (GET /metrics)
  app.use(httpMetricsMiddleware);
  // Request id + one access-log line per request (runs before guards)
  app.use(requestLoggingMiddleware);
  // Must follow the logging middleware, which assigns the request id
  app.use(requestContextMiddleware);
  // req.cookies: the web app's session lives in an HttpOnly cookie (auth/session-cookie.ts)
  app.use(cookieParserMiddleware);

  // Global prefix (the Prometheus scrape endpoint stays at /metrics)
  app.setGlobalPrefix(process.env.API_PREFIX || 'api/v1', {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that don't have decorators
      forbidNonWhitelisted: true, // Throw error if non-whitelisted properties exist
      transform: true, // Automatically transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true, // Automatically convert types
      },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Anti-CSRF: cookie-authenticated (and anonymous) state-changing requests must
  // carry the web app's custom header; bearer-token clients are exempt
  app.useGlobalGuards(new CsrfGuard(app.get(Reflector)));

  // Serializer that applies @Exclude()
  // (keeps password hashes and MFA secrets out of every response)
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
}
