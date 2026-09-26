import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { isStrictEnv } from '../../config/environment';
import {
  getRequestId,
  redactPath,
} from '../interceptors/request-logging.middleware';
import {
  defaultErrorCode,
  defaultRetryable,
  internalErrorCode,
  isStableCode,
} from '../errors/error-codes';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  // Internal error details (SQL errors, stack traces) are only returned to
  // clients in development/test; strict environments (production, staging, ...)
  // get a generic message + request id.
  private readonly exposeInternalErrors = !isStrictEnv();

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = getRequestId(request);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';
    // Extra structured fields of a 4xx (e.g. missingPermissions, approvable)
    let details: Record<string, unknown> = {};
    // Machine-readable code / retry hint (see common/errors/error-codes.ts)
    let code: string | undefined;
    let retryable: boolean | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const body = exceptionResponse as {
          message?: string | string[];
          error?: string;
          code?: unknown;
          retryable?: unknown;
        };
        message = body.message || exception.message;
        error = body.error || error;
        if (isStableCode(body.code)) code = body.code;
        if (typeof body.retryable === 'boolean') retryable = body.retryable;
        if (status < HttpStatus.INTERNAL_SERVER_ERROR) {
          details = Object.fromEntries(
            Object.entries(body).filter(
              ([key]) =>
                ![
                  'message',
                  'error',
                  'statusCode',
                  'code',
                  'retryable',
                ].includes(key),
            ),
          );
        }
      }
      code ??= defaultErrorCode(status, message, details);
    } else {
      code = internalErrorCode(exception);
      if (exception instanceof Error && this.exposeInternalErrors) {
        message = exception.message;
        error = exception.name;
      }
    }
    retryable ??= defaultRetryable(status, code);

    // Unexpected errors are logged with full details; expected 4xx are logged
    // (one line) by the request logging middleware.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        {
          requestId,
          method: request.method,
          path: redactPath(request.originalUrl),
          status,
          error: exception instanceof Error ? exception.name : typeof exception,
          message:
            exception instanceof Error
              ? exception.message
              : JSON.stringify(exception),
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (response.headersSent) {
      return;
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      message,
      error,
      requestId,
      code,
      retryable,
      ...details,
    });
  }
}
